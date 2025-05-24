import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleExecCommand } from "../src/utils/agent/handle-exec-command.js";
import {
  process_patch,
  DiffError,
  identify_files_needed,
  identify_files_added,
} from "../src/utils/agent/apply-patch.js";
import { ApprovalPolicy } from "../src/approvals.js";
import type { AppConfig } from "../src/utils/config.js";
import type { CommandConfirmation } from "../src/utils/agent/agent-loop.js";
import { ReviewDecision } from "../src/utils/agent/review.js";
import * as fsPromises from "node:fs/promises";
import path from "node:path";

// Mock fs/promises
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof fsPromises>();
  return {
    ...original,
    readFile: vi.fn(),
    writeFile: vi.fn(),
    access: vi.fn(), // Mock access as well
  };
});

// Mock process.cwd if needed for workdir resolution, though patches specify full paths
const MOCK_CWD = "/app";
vi.mock("process", () => {
  const originalProcess = vi.importActual("process");
  return {
    ...originalProcess,
    cwd: vi.fn(() => MOCK_CWD),
  };
});

// In-memory file system similar to apply-patch.test.ts
const createInMemoryFS = () => {
  let files: Record<string, string> = {};

  const readFileMock = async (
    filePath: string,
    options?: any,
  ): Promise<string | Buffer> => {
    const normalizedPath = path.resolve(MOCK_CWD, filePath);
    if (files[normalizedPath]) {
      return options === "utf-8" || !options
        ? files[normalizedPath]
        : Buffer.from(files[normalizedPath]);
    }
    throw new Error(`ENOENT: no such file or directory, open '${normalizedPath}'`);
  };

  const writeFileMock = async (
    filePath: string,
    data: string | Uint8Array,
  ): Promise<void> => {
    const normalizedPath = path.resolve(MOCK_CWD, filePath);
    files[normalizedPath] = data.toString();
  };
  
  const accessMock = async (filePath: string): Promise<void> => {
    const normalizedPath = path.resolve(MOCK_CWD, filePath);
    if (files[normalizedPath] !== undefined) {
      return;
    }
    // For directories, if any file starts with this path + path.sep
    if (Object.keys(files).some(p => p.startsWith(normalizedPath + path.sep))) {
        return;
    }
    throw new Error(`ENOENT: no such file or directory, access '${normalizedPath}'`);
  };


  const reset = () => {
    files = {};
    (fsPromises.readFile as vi.Mock).mockImplementation(readFileMock);
    (fsPromises.writeFile as vi.Mock).mockImplementation(writeFileMock);
    (fsPromises.access as vi.Mock).mockImplementation(accessMock);
  };
  
  const getFiles = () => files;

  return { reset, getFiles, readFileMock, writeFileMock, accessMock };
};

const inMemoryFS = createInMemoryFS();

describe("Agent Patch Reread Test", () => {
  beforeEach(() => {
    inMemoryFS.reset();
    // Ensure process.cwd is consistently mocked if tests rely on it for workdir
    vi.spyOn(process, "cwd").mockReturnValue(MOCK_CWD); 
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should correctly apply a patch, prompt for re-read, and apply a subsequent patch successfully", async () => {
    const initialContent = "Hello\nWorld\n";
    const filePath = path.resolve(MOCK_CWD, "test.txt");
    await fsPromises.writeFile(filePath, initialContent);

    const config: AppConfig = {
      apiKey: "test-key",
      model: "test-model",
      instructions: "",
      agent: {
        autoApproveAll: true, // For ApprovalPolicy.AUTO_APPROVE_ALL
      },
    };

    const mockGetCommandConfirmation = vi.fn(
      async (): Promise<CommandConfirmation> => ({
        review: ReviewDecision.YES,
      }),
    );

    // 1. First Patch Application
    const patch1 = `*** Begin Patch
*** Update File: ${filePath}
@@
 Hello
-World
+Universe
*** End Patch`;

    let result = await handleExecCommand(
      { cmd: ["apply_patch", patch1], workdir: MOCK_CWD },
      config,
      ApprovalPolicy.AUTO_APPROVE_ALL,
      mockGetCommandConfirmation,
    );

    expect(result.outputText).toBe(
      `Patch successfully applied to '${filePath}'. The file content has changed. If you need to perform further operations on this file, please re-read it to ensure you have the latest version.`,
    );
    expect(result.metadata.exit_code).toBe(0);
    expect(mockGetCommandConfirmation).toHaveBeenCalledTimes(1); // Should be auto-approved by policy

    // Verify file content after first patch
    let currentFileContent = await fsPromises.readFile(filePath, "utf-8");
    expect(currentFileContent).toBe("Hello\nUniverse\n");

    // 2. Simulate File Re-read (already done by reading currentFileContent)
    // The agent would use this re-read content to base its next patch on.

    // 3. Second Patch Application
    // This patch is based on the content "Hello\nUniverse\n"
    const patch2 = `*** Begin Patch
*** Update File: ${filePath}
@@
 Hello
-Universe
+Multiverse
*** End Patch`;
    
    // Reset mock for the second call if necessary for ApprovalPolicy.AUTO_APPROVE_ALL
    // or ensure policy correctly handles it.
    // For AUTO_APPROVE_ALL, getCommandConfirmation might not be called if canAutoApprove short-circuits.
    // Let's verify the behavior of canAutoApprove with AUTO_APPROVE_ALL for apply_patch.
    // Based on current handleExecCommand, if alwaysApprovedCommands doesn't have 'apply_patch'
    // and canAutoApprove returns 'auto-approve', getCommandConfirmation is NOT called.
    // Let's assume it's not called for the second time with AUTO_APPROVE_ALL for now.
    // If it is, the mockGetCommandConfirmation.mockClear() and re-assertion would be needed.

    result = await handleExecCommand(
      { cmd: ["apply_patch", patch2], workdir: MOCK_CWD },
      config,
      ApprovalPolicy.AUTO_APPROVE_ALL,
      mockGetCommandConfirmation, // This might not be called again due to auto-approval
    );
    
    expect(result.metadata.exit_code).toBe(0);
    // The outputText should again be the success message, this time for the second patch.
     expect(result.outputText).toBe(
      `Patch successfully applied to '${filePath}'. The file content has changed. If you need to perform further operations on this file, please re-read it to ensure you have the latest version.`,
    );
    // If AUTO_APPROVE_ALL truly means no more calls to getCommandConfirmation for `apply_patch`
    // after the first approval (or if it's keyed by command type and auto-approved),
    // then it would still be 1. If it's called per exec, it'd be 2.
    // Given `alwaysApprovedCommands` is session-level and `deriveCommandKey` for apply_patch is just "apply_patch",
    // and `handleExecCommand` checks `alwaysApprovedCommands` *before* `canAutoApprove`,
    // `getCommandConfirmation` will NOT be called a second time if the first review was `ReviewDecision.ALWAYS`.
    // If it was `ReviewDecision.YES`, then `canAutoApprove` path is taken again.
    // Our mock returns YES, so `canAutoApprove` will be hit again.
    // `canAutoApprove` with AUTO_APPROVE_ALL for `apply_patch` should return `auto-approve` without asking user.
    // So, `askUserPermission` and thus `getCommandConfirmation` should NOT be called again.
    // Thus, `mockGetCommandConfirmation` should still be called only once if the policy handles it.
    // Re-checking `handleExecCommand`: `alwaysApprovedCommands` is only populated if review is `ALWAYS`.
    // Our mock returns `YES`. So `alwaysApprovedCommands` is not populated.
    // `canAutoApprove` is called. For `apply_patch` and `AUTO_APPROVE_ALL`, it returns `{ type: "auto-approve", runInSandbox: false, applyPatch }`.
    // This means `askUserPermission` is NOT called. So `getCommandConfirmation` is NOT called for the second patch.
    expect(mockGetCommandConfirmation).toHaveBeenCalledTimes(1);


    // 4. Final State Verification
    currentFileContent = await fsPromises.readFile(filePath, "utf-8");
    expect(currentFileContent).toBe("Hello\nMultiverse\n");

    // Additionally, ensure process_patch itself wouldn't throw DiffError
    // This is implicitly tested by handleExecCommand not failing, but we can be more direct
    // if we want to test process_patch in isolation with the state.
    // However, the task is to test handleExecCommand's interaction.
    // The successful application (exitCode 0) from handleExecCommand for patch2 implies process_patch worked.
  });
});
