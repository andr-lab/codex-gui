// Based on reference implementation from
// https://cookbook.openai.com/examples/gpt4-1_prompting_guide#reference-implementation-apply_patchpy

import fs from "fs";
import path from "path";
import {
  ADD_FILE_PREFIX,
  DELETE_FILE_PREFIX,
  END_OF_FILE_PREFIX,
  MOVE_FILE_TO_PREFIX,
  PATCH_SUFFIX,
  UPDATE_FILE_PREFIX,
  HUNK_ADD_LINE_PREFIX,
  PATCH_PREFIX,
} from "src/parse-apply-patch";

// -----------------------------------------------------------------------------
// Types & Models
// -----------------------------------------------------------------------------

export enum ActionType {
  ADD = "add",
  DELETE = "delete",
  UPDATE = "update",
}

export interface FileChange {
  type: ActionType;
  old_content?: string | null;
  new_content?: string | null;
  move_path?: string | null;
}

export interface Commit {
  changes: Record<string, FileChange>;
}

export function assemble_changes(
  orig: Record<string, string | null>,
  updatedFiles: Record<string, string | null>,
): Commit {
  const commit: Commit = { changes: {} };
  for (const [p, newContent] of Object.entries(updatedFiles)) {
    const oldContent = orig[p];
    if (oldContent === newContent) {
      continue;
    }
    if (oldContent !== undefined && newContent !== undefined) {
      commit.changes[p] = {
        type: ActionType.UPDATE,
        old_content: oldContent,
        new_content: newContent,
      };
    } else if (newContent !== undefined) {
      commit.changes[p] = {
        type: ActionType.ADD,
        new_content: newContent,
      };
    } else if (oldContent !== undefined) {
      commit.changes[p] = {
        type: ActionType.DELETE,
        old_content: oldContent,
      };
    } else {
      throw new Error("Unexpected state in assemble_changes");
    }
  }
  return commit;
}

// -----------------------------------------------------------------------------
// Patch‑related structures
// -----------------------------------------------------------------------------

export interface Chunk {
  orig_index: number; // line index of the first line in the original file
  del_lines: Array<string>;
  ins_lines: Array<string>;
}

export interface PatchAction {
  type: ActionType;
  new_file?: string | null;
  chunks: Array<Chunk>;
  move_path?: string | null;
}

export interface Patch {
  actions: Record<string, PatchAction>;
}

export class DiffError extends Error {}

// -----------------------------------------------------------------------------
// Parser (patch text -> Patch)
// -----------------------------------------------------------------------------

class Parser {
  current_files: Record<string, string>;
  lines: Array<string>; // These lines are normalized to not contain \r
  index = 0;
  patch: Patch = { actions: {} };
  fuzz = 0;

  constructor(currentFiles: Record<string, string>, lines: Array<string>) {
    this.current_files = currentFiles;
    this.lines = lines;
  }

  private is_done(prefixes?: Array<string>): boolean {
    if (this.index >= this.lines.length) {
      return true;
    }
    if (
      prefixes &&
      prefixes.some((p) => this.lines[this.index]!.startsWith(p.trim()))
    ) {
      return true;
    }
    return false;
  }

  private startswith(prefix: string | Array<string>): boolean {
    const prefixes = Array.isArray(prefix) ? prefix : [prefix];
    // Ensure this.lines[this.index] exists before calling startsWith on it
    if (this.index >= this.lines.length) {
        return false;
    }
    return prefixes.some((p) => this.lines[this.index]!.startsWith(p));
  }

  private read_str(prefix = "", returnEverything = false): string {
    if (this.index >= this.lines.length) {
      throw new DiffError(`Index: ${this.index} >= ${this.lines.length}`);
    }
    if (this.lines[this.index]!.startsWith(prefix)) {
      const text = returnEverything
        ? this.lines[this.index]
        : this.lines[this.index]!.slice(prefix.length);
      this.index += 1;
      return text ?? "";
    }
    return "";
  }

  parse(): void {
    while (!this.is_done([PATCH_SUFFIX])) { // Checks against PATCH_SUFFIX.trim()
      let path = this.read_str(UPDATE_FILE_PREFIX); // Uses raw UPDATE_FILE_PREFIX
      if (path) {
        if (this.patch.actions[path]) {
          throw new DiffError(`Update File Error: Duplicate Path: ${path}`);
        }
        const moveTo = this.read_str(MOVE_FILE_TO_PREFIX);
        if (!(path in this.current_files)) {
          throw new DiffError(`Update File Error: Missing File: ${path}`);
        }
        const text = this.current_files[path];
        const action = this.parse_update_file(text ?? "");
        action.move_path = moveTo || undefined;
        this.patch.actions[path] = action;
        continue;
      }
      path = this.read_str(DELETE_FILE_PREFIX);
      if (path) {
        if (this.patch.actions[path]) {
          throw new DiffError(`Delete File Error: Duplicate Path: ${path}`);
        }
        if (!(path in this.current_files)) {
          throw new DiffError(`Delete File Error: Missing File: ${path}`);
        }
        this.patch.actions[path] = { type: ActionType.DELETE, chunks: [] };
        continue;
      }
      path = this.read_str(ADD_FILE_PREFIX);
      if (path) {
        if (this.patch.actions[path]) {
          throw new DiffError(`Add File Error: Duplicate Path: ${path}`);
        }
        if (path in this.current_files) {
          throw new DiffError(`Add File Error: File already exists: ${path}`);
        }
        this.patch.actions[path] = this.parse_add_file();
        continue;
      }
      if (this.index < this.lines.length) { // Check to prevent error on empty last line after parsing
        throw new DiffError(`Unknown Line: ${this.lines[this.index]}`);
      } else {
        // Reached end of lines unexpectedly, might be missing PATCH_SUFFIX
        throw new DiffError("Unexpected end of patch input. Missing End Patch?");
      }
    }
    if (!this.startswith(PATCH_SUFFIX.trim())) { // Compares with PATCH_SUFFIX.trim()
      throw new DiffError("Missing End Patch");
    }
    this.index += 1;
  }

  private parse_update_file(text: string): PatchAction {
    const action: PatchAction = { type: ActionType.UPDATE, chunks: [] };
    const fileLines = text.split(/\r\n|\r|\n/); // Robust split for original file content
    let current_file_line_index = 0; // Renamed 'index' to avoid confusion with 'this.index'

    while (
      !this.is_done([
        PATCH_SUFFIX,
        UPDATE_FILE_PREFIX,
        DELETE_FILE_PREFIX,
        ADD_FILE_PREFIX,
        END_OF_FILE_PREFIX,
      ])
    ) {
      const defStr = this.read_str("@@ ");
      let sectionStr = "";
      // Check if this.lines[this.index] is accessible
      if (!defStr && this.index < this.lines.length && this.lines[this.index] === "@@") {
        sectionStr = this.lines[this.index]!;
        this.index += 1;
      }
      if (!(defStr || sectionStr || current_file_line_index === 0)) {
         // Check if this.lines[this.index] is accessible
        if (this.index < this.lines.length) {
            throw new DiffError(`Invalid Line while parsing update file header:\n${this.lines[this.index]}`);
        } else {
            throw new DiffError("Unexpected end of patch while parsing update file header.");
        }
      }
      if (defStr.trim()) { // This is the context line from `@@ context` in unified diff, not used by this patch format
        // This block seems to be for a different diff format, let's ensure it's benign or correctly adapted.
        // For this custom patch format, `@@` lines are just section separators, not context locators.
        // The logic to find context is handled by `find_context` using `peek_next_section`.
        // This block might be a remnant or for a more complex `@@` line.
        // If `defStr` represents a line that should be found literally, the logic below tries to find it.
        let found = false;
        if (!fileLines.slice(0, current_file_line_index).some((s) => s === defStr)) {
          for (let i = current_file_line_index; i < fileLines.length; i++) {
            if (fileLines[i] === defStr) {
              current_file_line_index = i + 1;
              found = true;
              break;
            }
          }
        }
        if (
          !found &&
          !fileLines.slice(0, current_file_line_index).some((s) => s.trim() === defStr.trim())
        ) {
          for (let i = current_file_line_index; i < fileLines.length; i++) {
            if (fileLines[i]!.trim() === defStr.trim()) {
              current_file_line_index = i + 1;
              this.fuzz += 1;
              found = true;
              break;
            }
          }
        }
        // If `defStr` was from `@@ actual_line_content` and not found, it could be an error.
        // However, in this patch format, `@@` is usually alone or `@@ ` is followed by hunk lines.
        // The current `read_str("@@ ")` means `defStr` is what comes *after* "@@ ".
        // If `defStr` is empty, it means the line was just "@@ ".
      }

      const [nextChunkContext, chunks, endPatchIndex, eof] = peek_next_section(
        this.lines, // these lines are already \n normalized
        this.index, // this.index points to the first line of the hunk content
      );
      const [newIndexInFile, fuzz] = find_context(
        fileLines, 
        nextChunkContext, 
        current_file_line_index,
        eof,
      );
      if (newIndexInFile === -1) {
        const ctxText = nextChunkContext.join("\n");
        if (eof) {
          throw new DiffError(`Invalid EOF Context (file line ${current_file_line_index}):\n${ctxText}`);
        } else {
          throw new DiffError(`Invalid Context (file line ${current_file_line_index}):\n${ctxText}`);
        }
      }
      this.fuzz += fuzz;
      for (const ch of chunks) {
        ch.orig_index += newIndexInFile; // ch.orig_index is relative to start of nextChunkContext
        action.chunks.push(ch);
      }
      current_file_line_index = newIndexInFile + nextChunkContext.length;
      this.index = endPatchIndex; // Update patch line parser index
    }
    return action;
  }

  private parse_add_file(): PatchAction {
    const lines: Array<string> = [];
    while (
      !this.is_done([ // these prefixes are .trim()'d by is_done
        PATCH_SUFFIX,
        UPDATE_FILE_PREFIX,
        DELETE_FILE_PREFIX,
        ADD_FILE_PREFIX,
      ])
    ) {
      // this.index points to a line we expect to be part of the added file's content
      // Need to ensure this.lines[this.index] is valid before `read_str` or `startsWith`
      if (this.index >= this.lines.length) {
          throw new DiffError("Unexpected end of patch while parsing added file content.");
      }
      // The line itself, not what's after a prefix. So, use read_str("", true) or this.lines[this.index]
      const s = this.lines[this.index]!; 
      this.index++; // Consume the line

      if (!s.startsWith(HUNK_ADD_LINE_PREFIX)) {
        throw new DiffError(`Invalid Add File Line: Expected '+' prefix. Got: ${s}`);
      }
      lines.push(s.slice(1));
    }
    return {
      type: ActionType.ADD,
      new_file: lines.join("\n"), // New files use \n
      chunks: [],
    };
  }
}

function normalizeLineEndings(line: string): string {
  return line.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function find_context_core(
  lines: Array<string>, // From original file, may have mixed line endings
  context: Array<string>, // From patch, \n normalized
  start: number,
): [number, number] {
  if (context.length === 0) {
    return [start, 0];
  }

  const normalizedFileLines = lines.map(normalizeLineEndings);

  for (let i = start; i < normalizedFileLines.length; i++) {
    if (i + context.length > normalizedFileLines.length) break; // Avoid slicing beyond array bounds
    if (
      normalizedFileLines.slice(i, i + context.length).join("\n") ===
      context.join("\n")
    ) {
      return [i, 0];
    }
  }
  
  for (let i = start; i < normalizedFileLines.length; i++) {
    if (i + context.length > normalizedFileLines.length) break;
    if (
      normalizedFileLines
        .slice(i, i + context.length)
        .map((s) => s.trimEnd())
        .join("\n") === context.map((s) => s.trimEnd()).join("\n")
    ) {
      return [i, 1];
    }
  }

  for (let i = start; i < normalizedFileLines.length; i++) {
    if (i + context.length > normalizedFileLines.length) break;
    if (
      normalizedFileLines
        .slice(i, i + context.length)
        .map((s) => s.trim())
        .join("\n") === context.map((s) => s.trim()).join("\n")
    ) {
      return [i, 100];
    }
  }
  return [-1, 0];
}

function find_context(
  lines: Array<string>,
  context: Array<string>,
  start: number,
  eof: boolean,
): [number, number] {
  if (eof) {
    // For EOF, we expect the context to be at the very end of the file.
    // Or, if context is empty, it means adding to the very end.
    if (context.length === 0) {
        return [lines.length, 0]; // Match at the end of the file
    }
    // Try to match the context exactly at the end of the file lines.
    // searchStart should be lines.length - context.length
    const searchStartForEof = Math.max(0, lines.length - context.length);
    let [newIndex, fuzz] = find_context_core(lines, context, searchStartForEof);

    // Ensure the match is indeed at the end
    if (newIndex !== -1 && newIndex + context.length === lines.length) {
        return [newIndex, fuzz]; // Perfect EOF match
    }

    // Fallback: try from the original `start` position, but heavily penalize if it's not an EOF match
    // This part might be problematic if `start` is far from EOF.
    // The original python code did:
    //   new_idx, fuzz = find_context_core(lines, context, max(0, len(lines) - len(context)))
    //   if new_idx != -1: return new_idx, fuzz
    //   new_idx, fuzz = find_context_core(lines, context, start_index)
    //   return new_idx, fuzz + 10000

    // Let's stick to the Python logic more closely for EOF
    [newIndex, fuzz] = find_context_core(lines, context, Math.max(0, lines.length - context.length));
    if (newIndex !== -1) { // Found it at/near EOF
        return [newIndex, fuzz];
    }
    // If not found near EOF, try from the original start index and penalize
    [newIndex, fuzz] = find_context_core(lines, context, start);
    return [newIndex, newIndex !== -1 ? fuzz + 10000 : 0];
  }
  return find_context_core(lines, context, start);
}

function peek_next_section(
  lines: Array<string>, // These are from patch, \n normalized
  initialIndex: number,
): [Array<string>, Array<Chunk>, number, boolean] {
  let index = initialIndex;
  const old: Array<string> = [];
  let delLines: Array<string> = [];
  let insLines: Array<string> = [];
  const chunks: Array<Chunk> = [];
  let mode: "keep" | "add" | "delete" = "keep";
  let eofMarkerFound = false;

  while (index < lines.length) {
    const s = lines[index]!;
    // Check for terminators of a hunk's content section
    if (
      s === "@@" || s.startsWith("@@ ") ||
      s === PATCH_SUFFIX.trim() ||
      s.startsWith(UPDATE_FILE_PREFIX.trim()) ||
      s.startsWith(DELETE_FILE_PREFIX.trim()) ||
      s.startsWith(ADD_FILE_PREFIX.trim())
    ) {
      break; // Break before processing 's' as a content line or EOF marker
    }

    // Explicitly check for END_OF_FILE_PREFIX before treating it as content
    // The patch format, as evidenced by the test cases, uses the literal string
    // "*** End Of File" as the EOF marker.
    // We compare against this literal string directly to ensure correct parsing.
    if (s === "*** End Of File") {
        eofMarkerFound = true;
        // index will be incremented after the loop to consume this marker
        break; // Do not process this line as content, stop collecting hunk lines
    }
    
    // Line is part of the hunk content
    const lastMode: "keep" | "add" | "delete" = mode;
    let line = s;
    if (line[0] === HUNK_ADD_LINE_PREFIX) {
      mode = "add";
    } else if (line[0] === "-") {
      mode = "delete";
    } else if (line[0] === " ") {
      mode = "keep";
    } else {
      // Tolerate invalid lines where the leading whitespace is missing.
      mode = "keep";
      line = " " + line;
    }

    line = line.slice(1); // Remove the prefix character
    if (mode === "keep" && lastMode !== mode) {
      // If mode changed to 'keep', and there were pending del/ins lines, push a chunk
      if (insLines.length || delLines.length) {
        chunks.push({
          orig_index: old.length - delLines.length, // Index in `old` where deletion started
          del_lines: delLines,
          ins_lines: insLines,
        });
      }
      delLines = [];
      insLines = [];
    }

    if (mode === "delete") {
      delLines.push(line);
      old.push(line); // `old` accumulates context lines and deleted lines
    } else if (mode === "add") {
      insLines.push(line);
      // Added lines don't go into `old` because `old` represents context from the original file
    } else { // mode === "keep"
      old.push(line); // Context lines go into `old`
    }
    index += 1; // Consume the content line from the patch
  } // End of while loop

  // After the loop, push any remaining chunk
  if (insLines.length || delLines.length) {
    chunks.push({
      orig_index: old.length - delLines.length,
      del_lines: delLines,
      ins_lines: insLines,
    });
  }
  
  // If loop was broken by END_OF_FILE_PREFIX marker
  if (eofMarkerFound) {
    index += 1; // Consume the END_OF_FILE_PREFIX line itself
  }
  // `eofMarkerFound` is the definitive eof status for this section
  return [old, chunks, index, eofMarkerFound];
}

// -----------------------------------------------------------------------------
// High‑level helpers
// -----------------------------------------------------------------------------

export function text_to_patch(
  text: string,
  orig: Record<string, string>,
): [Patch, number] {
  const normalizedText = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  const lines = normalizedText.split("\n"); 

  if (
    lines.length < 2 ||
    lines[0] !== PATCH_PREFIX.trim() || 
    lines[lines.length - 1] !== PATCH_SUFFIX.trim() 
  ) {
    throw new DiffError(
      `Invalid patch text structure. Expected start: '${PATCH_PREFIX.trim()}', end: '${PATCH_SUFFIX.trim()}'. Got start: '${lines[0]}', end: '${lines[lines.length -1]}'`,
    );
  }
  const parser = new Parser(orig, lines);
  parser.index = 1; 
  parser.parse();
  return [parser.patch, parser.fuzz];
}

export function identify_files_needed(text: string): Array<string> {
  const normalizedText = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalizedText.split("\n");
  const result = new Set<string>();
  for (const line of lines) {
    if (line.startsWith(UPDATE_FILE_PREFIX)) { 
      result.add(line.slice(UPDATE_FILE_PREFIX.length));
    }
    if (line.startsWith(DELETE_FILE_PREFIX)) { 
      result.add(line.slice(DELETE_FILE_PREFIX.length));
    }
  }
  return [...result];
}

export function identify_files_added(text: string): Array<string> {
  const normalizedText = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalizedText.split("\n");
  const result = new Set<string>();
  for (const line of lines) {
    if (line.startsWith(ADD_FILE_PREFIX)) { 
      result.add(line.slice(ADD_FILE_PREFIX.length));
    }
  }
  return [...result];
}

function _get_updated_file(
  text: string, 
  action: PatchAction,
  path: string,
): string {
  if (action.type !== ActionType.UPDATE) {
    throw new Error("Expected UPDATE action");
  }
  const hasCrLf = text.includes("\r\n");
  const lineEnding = hasCrLf ? "\r\n" : "\n";

  const origLines = text.split(/\r\n|\r|\n/); 
  
  const destLines: Array<string> = [];
  let origIndex = 0;
  for (const chunk of action.chunks) {
    if (chunk.orig_index > origLines.length) {
      throw new DiffError(
        `${path}: chunk.orig_index ${chunk.orig_index} > len(lines) ${origLines.length}`,
      );
    }
    if (origIndex > chunk.orig_index) {
      // This can happen if chunks are not ordered or if orig_index is miscalculated.
      // orig_index in chunk should be relative to the start of the *file*, not previous chunk.
      // The current logic in parse_update_file sets ch.orig_index += newIndexInFile,
      // where newIndexInFile is the start of the context in the file.
      // And ch.orig_index was relative to the start of the context. This seems correct.
      throw new DiffError(
        `${path}: current file index ${origIndex} > chunk.orig_index ${chunk.orig_index}. Chunks might be misordered or orig_index incorrect.`,
      );
    }
    // Add lines from original file before the current chunk's starting point
    destLines.push(...origLines.slice(origIndex, chunk.orig_index));
    // origIndex now points to the start of where the chunk's changes apply in the original file
    
    if (chunk.ins_lines.length) {
      for (const l of chunk.ins_lines) {
        destLines.push(l);
      }
    }
    // Advance origIndex past the lines that were deleted or replaced from original
    origIndex = chunk.orig_index + chunk.del_lines.length; 
  }
  destLines.push(...origLines.slice(origIndex)); 
  return destLines.join(lineEnding); 
}

export function patch_to_commit(
  patch: Patch,
  orig: Record<string, string>,
): Commit {
  const commit: Commit = { changes: {} };
  for (const [pathKey, action] of Object.entries(patch.actions)) {
    if (action.type === ActionType.DELETE) {
      commit.changes[pathKey] = {
        type: ActionType.DELETE,
        old_content: orig[pathKey],
      };
    } else if (action.type === ActionType.ADD) {
      commit.changes[pathKey] = {
        type: ActionType.ADD,
        new_content: action.new_file ?? "", 
      };
    } else if (action.type === ActionType.UPDATE) {
      const newContent = _get_updated_file(orig[pathKey]!, action, pathKey);
      commit.changes[pathKey] = {
        type: ActionType.UPDATE,
        old_content: orig[pathKey],
        new_content: newContent,
        move_path: action.move_path ?? undefined,
      };
    }
  }
  return commit;
}

// -----------------------------------------------------------------------------
// Filesystem helpers for Node environment
// -----------------------------------------------------------------------------

export function load_files(
  paths: Array<string>,
  openFn: (p: string) => string,
): Record<string, string> {
  const orig: Record<string, string> = {};
  for (const p of paths) {
    try {
      orig[p] = openFn(p);
    } catch (e) {
      throw new DiffError(`File not found or unreadable: ${p}. Original error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return orig;
}

export function apply_commit(
  commit: Commit,
  writeFn: (p: string, c: string) => void,
  removeFn: (p: string) => void,
): void {
  for (const [p, change] of Object.entries(commit.changes)) {
    if (change.type === ActionType.DELETE) {
      removeFn(p);
    } else if (change.type === ActionType.ADD) {
      writeFn(p, change.new_content ?? "");
    } else if (change.type === ActionType.UPDATE) {
      if (change.move_path) {
        writeFn(change.move_path, change.new_content ?? "");
        removeFn(p);
      } else {
        writeFn(p, change.new_content ?? "");
      }
    }
  }
}

export function process_patch(
  text: string,
  openFn: (p: string) => string,
  writeFn: (p: string, c: string) => void,
  removeFn: (p: string) => void,
): string {
  const normalizedTextForPrefixCheck = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalizedTextForPrefixCheck.startsWith(PATCH_PREFIX)) {
    throw new DiffError(`Patch must start with ${PATCH_PREFIX.replace("\n", "\\n")}`);
  }
  const paths = identify_files_needed(text); 
  const orig = load_files(paths, openFn);
  const [patch, _fuzz] = text_to_patch(text, orig); 
  const commit = patch_to_commit(patch, orig);
  apply_commit(commit, writeFn, removeFn);
  return "Done!";
}

// -----------------------------------------------------------------------------
// Default filesystem implementations
// -----------------------------------------------------------------------------

function open_file(p: string): string {
  return fs.readFileSync(p, "utf8");
}

function write_file(p: string, content: string): void {
  if (path.isAbsolute(p)) {
    throw new DiffError("We do not support absolute paths.");
  }
  const parent = path.dirname(p);
  if (parent !== "." && parent !== "") { 
    fs.mkdirSync(parent, { recursive: true });
  }
  fs.writeFileSync(p, content, "utf8");
}

function remove_file(p: string): void {
  fs.unlinkSync(p);
}

// -----------------------------------------------------------------------------
// CLI mode. Not exported, executed only if run directly.
// -----------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  let patchText = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (patchText += chunk));
  process.stdin.on("end", () => {
    if (!patchText) {
      // eslint-disable-next-line no-console
      console.error("Please pass patch text through stdin");
      process.exit(1);
    }
    try {
      const result = process_patch(
        patchText,
        open_file,
        write_file,
        remove_file,
      );
      // eslint-disable-next-line no-console
      console.log(result);
    } catch (err: unknown) {
      // eslint-disable-next-line no-console
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
}
