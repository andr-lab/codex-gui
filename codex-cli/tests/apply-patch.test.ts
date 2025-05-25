import {
  ActionType,
  apply_commit,
  assemble_changes,
  DiffError,
  identify_files_added,
  identify_files_needed,
  load_files,
  patch_to_commit,
  process_patch,
  text_to_patch,
} from "../src/utils/agent/apply-patch.js";
import { test, expect } from "vitest";

function createInMemoryFS(initialFiles: Record<string, string>) {
  const files: Record<string, string> = { ...initialFiles };
  const writes: Record<string, string> = {};
  const removals: Array<string> = [];

  const openFn = (p: string): string => {
    const file = files[p];
    if (typeof file === "string") {
      return file;
    } else {
      throw new Error(`File not found: ${p}`);
    }
  };

  const writeFn = (p: string, content: string): void => {
    files[p] = content;
    writes[p] = content;
  };

  const removeFn = (p: string): void => {
    delete files[p];
    removals.push(p);
  };

  return { openFn, writeFn, removeFn, writes, removals, files };
}

test("process_patch - update file", () => {
  const patch = `*** Begin Patch
*** Update File: a.txt
@@
-hello
+hello world
*** End Patch`;

  const fs = createInMemoryFS({ "a.txt": "hello" });

  const result = process_patch(patch, fs.openFn, fs.writeFn, fs.removeFn);

  expect(result).toBe("Done!");
  expect(fs.writes).toEqual({ "a.txt": "hello world" });
  expect(fs.removals).toEqual([]);
});

test("process_patch - add file", () => {
  const patch = `*** Begin Patch
*** Add File: b.txt
+new content
*** End Patch`;

  const fs = createInMemoryFS({});

  process_patch(patch, fs.openFn, fs.writeFn, fs.removeFn);

  expect(fs.writes).toEqual({ "b.txt": "new content" });
  expect(fs.removals).toEqual([]);
});

test("process_patch - delete file", () => {
  const patch = `*** Begin Patch
*** Delete File: c.txt
*** End Patch`;

  const fs = createInMemoryFS({ "c.txt": "to be removed" });

  process_patch(patch, fs.openFn, fs.writeFn, fs.removeFn);

  expect(fs.writes).toEqual({});
  expect(fs.removals).toEqual(["c.txt"]);
});

test("identify_files_needed & identify_files_added", () => {
  const patch = `*** Begin Patch
*** Update File: a.txt
*** Delete File: b.txt
*** Add File: c.txt
*** End Patch`;

  expect(identify_files_needed(patch).sort()).toEqual(
    ["a.txt", "b.txt"].sort(),
  );
  expect(identify_files_added(patch)).toEqual(["c.txt"]);
});

test("process_patch - update file with multiple chunks", () => {
  const original = "line1\nline2\nline3\nline4";
  const patch = `*** Begin Patch
*** Update File: multi.txt
@@
 line1
-line2
+line2 updated
 line3
+inserted line
 line4
*** End Patch`;

  const fs = createInMemoryFS({ "multi.txt": original });
  process_patch(patch, fs.openFn, fs.writeFn, fs.removeFn);

  const expected = "line1\nline2 updated\nline3\ninserted line\nline4";
  expect(fs.writes).toEqual({ "multi.txt": expected });
  expect(fs.removals).toEqual([]);
});

test("process_patch - move file (rename)", () => {
  const patch = `*** Begin Patch
*** Update File: old.txt
*** Move to: new.txt
@@
-old
+new
*** End Patch`;

  const fs = createInMemoryFS({ "old.txt": "old" });
  process_patch(patch, fs.openFn, fs.writeFn, fs.removeFn);

  expect(fs.writes).toEqual({ "new.txt": "new" });
  expect(fs.removals).toEqual(["old.txt"]);
});

test("process_patch - combined add, update, delete", () => {
  const patch = `*** Begin Patch
*** Add File: added.txt
+added contents
*** Update File: upd.txt
@@
-old value
+new value
*** Delete File: del.txt
*** End Patch`;

  const fs = createInMemoryFS({
    "upd.txt": "old value",
    "del.txt": "delete me",
  });

  process_patch(patch, fs.openFn, fs.writeFn, fs.removeFn);

  expect(fs.writes).toEqual({
    "added.txt": "added contents",
    "upd.txt": "new value",
  });
  expect(fs.removals).toEqual(["del.txt"]);
});

test("process_patch - readme edit", () => {
  const original = `
#### Fix an issue

\`\`\`sh
# First, copy an error
# Then, start codex with interactive mode
codex

# Or you can pass in via command line argument
codex "Fix this issue: $(pbpaste)"

# Or even as a task (it should use your current repo and branch)
codex -t "Fix this issue: $(pbpaste)"
\`\`\`
`;
  const patch = `*** Begin Patch
*** Update File: README.md
@@
  codex -t "Fix this issue: $(pbpaste)"
  \`\`\`
+
+hello
*** End Patch`;
  const expected = `
#### Fix an issue

\`\`\`sh
# First, copy an error
# Then, start codex with interactive mode
codex

# Or you can pass in via command line argument
codex "Fix this issue: $(pbpaste)"

# Or even as a task (it should use your current repo and branch)
codex -t "Fix this issue: $(pbpaste)"
\`\`\`

hello
`;

  const fs = createInMemoryFS({ "README.md": original });
  process_patch(patch, fs.openFn, fs.writeFn, fs.removeFn);

  expect(fs.writes).toEqual({ "README.md": expected });
});

test("process_patch - invalid patch throws DiffError", () => {
  const patch = `*** Begin Patch
*** Update File: missing.txt
@@
+something
*** End Patch`;

  const fs = createInMemoryFS({});

  expect(() =>
    process_patch(patch, fs.openFn, fs.writeFn, fs.removeFn),
  ).toThrow(DiffError);
});

test("process_patch - tolerates omitted space for keep line", () => {
  const original = "line1\nline2\nline3";
  const patch = `*** Begin Patch\n*** Update File: foo.txt\n@@\n line1\n-line2\n+some new line2\nline3\n*** End Patch`;
  const fs = createInMemoryFS({ "foo.txt": original });
  process_patch(patch, fs.openFn, fs.writeFn, fs.removeFn);
  expect(fs.files["foo.txt"]).toBe("line1\nsome new line2\nline3");
});

test("assemble_changes correctly detects add, update and delete", () => {
  const orig = {
    "a.txt": "old",
    "b.txt": "keep",
    "c.txt": "remove",
  };
  const updated = {
    "a.txt": "new", // update
    "b.txt": "keep", // unchanged – should be ignored
    "c.txt": undefined as unknown as string, // delete
    "d.txt": "created", // add
  };

  const commit = assemble_changes(orig, updated).changes;

  expect(commit["a.txt"]).toEqual({
    type: ActionType.UPDATE,
    old_content: "old",
    new_content: "new",
  });
  expect(commit["c.txt"]).toEqual({
    type: ActionType.DELETE,
    old_content: "remove",
  });
  expect(commit["d.txt"]).toEqual({
    type: ActionType.ADD,
    new_content: "created",
  });

  // unchanged files should not appear in commit
  expect(commit).not.toHaveProperty("b.txt");
});

test("text_to_patch + patch_to_commit handle update and add", () => {
  const originalFiles = {
    "a.txt": "old line",
  };

  const patch = `*** Begin Patch
*** Update File: a.txt
@@
-old line
+new line
*** Add File: b.txt
+content new
*** End Patch`;

  const [parsedPatch] = text_to_patch(patch, originalFiles);
  const commit = patch_to_commit(parsedPatch, originalFiles).changes;

  expect(commit["a.txt"]).toEqual({
    type: ActionType.UPDATE,
    old_content: "old line",
    new_content: "new line",
  });
  expect(commit["b.txt"]).toEqual({
    type: ActionType.ADD,
    new_content: "content new",
  });
});

test("load_files throws DiffError when file is missing", () => {
  const { openFn } = createInMemoryFS({ "exists.txt": "hi" });
  // intentionally include a missing file in the list
  expect(() => load_files(["exists.txt", "missing.txt"], openFn)).toThrow(
    DiffError,
  );
});

test("apply_commit correctly performs move / rename operations", () => {
  const commit = {
    changes: {
      "old.txt": {
        type: ActionType.UPDATE,
        old_content: "old",
        new_content: "new",
        move_path: "new.txt",
      },
    },
  };

  const { writeFn, removeFn, writes, removals } = createInMemoryFS({});

  apply_commit(commit, writeFn, removeFn);

  expect(writes).toEqual({ "new.txt": "new" });
  expect(removals).toEqual(["old.txt"]);
});

// --- Tests for find_context_core enhancements (line endings and whitespace) ---

test("process_patch - CRLF in patch context, LF in file content", () => {
  const originalFileContentLF = "line1\ncontext\nline3";
  const patchWithCRLFContext = `*** Begin Patch
*** Update File: a.txt
@@
 line1
-context
+context updated
 line3
*** End Patch`.replace(/\n/g, "\r\n"); // Patch context uses CRLF

  const fs = createInMemoryFS({ "a.txt": originalFileContentLF });
  process_patch(patchWithCRLFContext, fs.openFn, fs.writeFn, fs.removeFn);
  expect(fs.writes["a.txt"]).toBe("line1\ncontext updated\nline3");
});

test("process_patch - LF in patch context, CRLF in file content", () => {
  const originalFileContentCRLF = "line1\r\ncontext\r\nline3";
  const patchWithLFContext = `*** Begin Patch
*** Update File: a.txt
@@
 line1
-context
+context updated
 line3
*** End Patch`; // Patch context uses LF

  const fs = createInMemoryFS({ "a.txt": originalFileContentCRLF });
  process_patch(patchWithLFContext, fs.openFn, fs.writeFn, fs.removeFn);
  // Expect the output to retain the original file's line endings
  expect(fs.writes["a.txt"]).toBe("line1\r\ncontext updated\r\nline3");
});

test("process_patch - CRLF in patch and file (baseline for CRLF)", () => {
  const originalFileContentCRLF = "line1\r\ncontext\r\nline3";
  const patchWithCRLFContext = `*** Begin Patch
*** Update File: a.txt
@@
 line1
-context
+context updated
 line3
*** End Patch`.replace(/\n/g, "\r\n");

  const fs = createInMemoryFS({ "a.txt": originalFileContentCRLF });
  process_patch(patchWithCRLFContext, fs.openFn, fs.writeFn, fs.removeFn);
  expect(fs.writes["a.txt"]).toBe("line1\r\ncontext updated\r\nline3");
});

test("process_patch - LF in patch and file (baseline for LF)", () => {
  const originalFileContentLF = "line1\ncontext\nline3";
  const patchWithLFContext = `*** Begin Patch
*** Update File: a.txt
@@
 line1
-context
+context updated
 line3
*** End Patch`;

  const fs = createInMemoryFS({ "a.txt": originalFileContentLF });
  process_patch(patchWithLFContext, fs.openFn, fs.writeFn, fs.removeFn);
  expect(fs.writes["a.txt"]).toBe("line1\ncontext updated\nline3");
});

test("process_patch - patch context with extra trailing whitespace (LF file)", () => {
  const originalFileContentLF = "line1\ncontext line\nline3"; // File context has no trailing whitespace
  const patchWithSpacedContext = `*** Begin Patch
*** Update File: a.txt
@@
 line1
-context line  
+context line updated
 line3
*** End Patch`; // Patch context has trailing whitespace

  const fs = createInMemoryFS({ "a.txt": originalFileContentLF });
  process_patch(patchWithSpacedContext, fs.openFn, fs.writeFn, fs.removeFn);
  expect(fs.writes["a.txt"]).toBe("line1\ncontext line updated\nline3");
});

test("process_patch - patch context with extra leading/trailing whitespace (CRLF file)", () => {
  const originalFileContentCRLF = "line1\r\ncontext line\r\nline3"; // File context has no surrounding whitespace
  const patchWithSpacedContextCRLF = `*** Begin Patch
*** Update File: a.txt
@@
 line1
-  context line  
+context line updated
 line3
*** End Patch`.replace(/\n/g, "\r\n"); // Patch context has surrounding whitespace & CRLF

  const fs = createInMemoryFS({ "a.txt": originalFileContentCRLF });
  process_patch(patchWithSpacedContextCRLF, fs.openFn, fs.writeFn, fs.removeFn);
  expect(fs.writes["a.txt"]).toBe("line1\r\ncontext line updated\r\nline3");
});

test("process_patch - patch context with mixed line endings (CRLF in patch) and extra leading whitespace (LF file)", () => {
  const originalFileContent = "line1\n  start space context\nline3"; // File: LF, context has 2 leading spaces
  const patch = `*** Begin Patch\r\n*** Update File: a.txt\r\n@@\r\n line1\r\n-    start space context\r\n+  start space context updated\r\n line3\r\n*** End Patch`; // Patch: CRLF, context has 4 leading spaces for delete line

  const fs = createInMemoryFS({ "a.txt": originalFileContent });
  process_patch(patch, fs.openFn, fs.writeFn, fs.removeFn);
  expect(fs.writes["a.txt"]).toBe("line1\n  start space context updated\nline3");
});

test("process_patch - patch context with different indentation (trim should handle)", () => {
  const originalFileContent = "line1\n  context\nline3"; // File: 2 spaces indent
  const patch = `*** Begin Patch
*** Update File: a.txt
@@
 line1
-    context
+  context updated
 line3
*** End Patch`; // Patch: 4 spaces indent for delete line. Add line has 2.
  const fs = createInMemoryFS({ "a.txt": originalFileContent });
  process_patch(patch, fs.openFn, fs.writeFn, fs.removeFn);
  expect(fs.writes["a.txt"]).toBe("line1\n  context updated\nline3");
});

test("process_patch - genuinely different context, should fail despite normalization attempts", () => {
  const originalFileContent = "line1\nactual context\nline3";
  const patchWithWrongContext = `*** Begin Patch
*** Update File: a.txt
@@
 line1
-completely different context\r\n
+new content
 line3
*** End Patch`; // Added CRLF to ensure it's not a line ending issue causing false pass

  const fs = createInMemoryFS({ "a.txt": originalFileContent });
  expect(() => process_patch(patchWithWrongContext, fs.openFn, fs.writeFn, fs.removeFn)
  ).toThrow(DiffError);
  // Check for the specific error message if possible and if it's stable
  expect(() => process_patch(patchWithWrongContext, fs.openFn, fs.writeFn, fs.removeFn)
  ).toThrow(/Invalid Context/);
});

test("process_patch - CRLF in patch, LF in file, context at EOF", () => {
  const originalFileContentLF = "line1\nlast context line";
  const patchWithCRLFContext = `*** Begin Patch
*** Update File: a.txt
@@
 line1
-last context line
+last context line updated
*** End Of File
*** End Patch`.replace(/\n/g, "\r\n");

  const fs = createInMemoryFS({ "a.txt": originalFileContentLF });
  process_patch(patchWithCRLFContext, fs.openFn, fs.writeFn, fs.removeFn);
  expect(fs.writes["a.txt"]).toBe("line1\nlast context line updated");
});

test("process_patch - LF in patch, CRLF in file, context at EOF", () => {
  const originalFileContentCRLF = "line1\r\nlast context line";
  const patchWithLFContext = `*** Begin Patch
*** Update File: a.txt
@@
 line1
-last context line
+last context line updated
*** End Of File
*** End Patch`;

  const fs = createInMemoryFS({ "a.txt": originalFileContentCRLF });
  process_patch(patchWithLFContext, fs.openFn, fs.writeFn, fs.removeFn);
  expect(fs.writes["a.txt"]).toBe("line1\r\nlast context line updated");
});

test("process_patch - patch context with trailing whitespace (LF patch, CRLF file), context at EOF", () => {
  const originalFileContentCRLF = "line1\r\nlast context line"; // File: CRLF, no trailing whitespace
  const patchWithSpacedContext = `*** Begin Patch
*** Update File: a.txt
@@
 line1
-last context line  
+last context line updated
*** End Of File
*** End Patch`; // Patch: LF, context has trailing spaces

  const fs = createInMemoryFS({ "a.txt": originalFileContentCRLF });
  process_patch(patchWithSpacedContext, fs.openFn, fs.writeFn, fs.removeFn);
  expect(fs.writes["a.txt"]).toBe("line1\r\nlast context line updated");
});

test("process_patch - patch context with leading whitespace (CRLF patch, LF file), context at EOF", () => {
  const originalFileContentLF = "line1\nlast context line"; // File: LF, no leading whitespace
  const patchWithSpacedContext = `*** Begin Patch
*** Update File: a.txt
@@
 line1
-  last context line
+last context line updated
*** End Of File
*** End Patch`.replace(/\n/g, "\r\n"); // Patch: CRLF, context has leading spaces

  const fs = createInMemoryFS({ "a.txt": originalFileContentLF });
  process_patch(patchWithSpacedContext, fs.openFn, fs.writeFn, fs.removeFn);
  expect(fs.writes["a.txt"]).toBe("line1\nlast context line updated");
});

test("process_patch - patch context with only CRLF vs LF difference", () => {
  const fileContent = "first line\nsecond line\nthird line";
  const patchContent =
    "*** Begin Patch\r\n" +
    "*** Update File: test.txt\r\n" +
    "@@\r\n" +
    " first line\r\n" +
    "-second line\r\n" +
    "+second line changed\r\n" +
    " third line\r\n" +
    "*** End Patch";
  const fs = createInMemoryFS({ "test.txt": fileContent });
  process_patch(patchContent, fs.openFn, fs.writeFn, fs.removeFn);
  expect(fs.writes["test.txt"]).toBe("first line\nsecond line changed\nthird line");
});

test("process_patch - patch context with LF vs CRLF and trailing space", () => {
  const fileContent = "first line\r\nsecond line\r\nthird line"; // CRLF
  const patchContent =
    "*** Begin Patch\n" + // LF
    "*** Update File: test.txt\n" +
    "@@\n" +
    " first line\n" +
    "-second line  \n" + // LF and trailing space
    "+second line changed\n" +
    " third line\n" +
    "*** End Patch";
  const fs = createInMemoryFS({ "test.txt": fileContent });
  process_patch(patchContent, fs.openFn, fs.writeFn, fs.removeFn);
  expect(fs.writes["test.txt"]).toBe("first line\r\nsecond line changed\r\nthird line");
});