import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AppConfig } from "../src/utils/config.js";
import type { CommandConfirmation } from "../src/utils/agent/agent-loop.js";
import { ReviewDecision } from "../src/utils/agent/review.js";
import * as fsPromises from "node:fs/promises";
import path from "node:path";
import actualProcess from "process";

// Declare handleExecCommand here, will be dynamically imported in beforeEach
let handleExecCommand: typeof import("../src/utils/agent/handle-exec-command.js").handleExecCommand;

// --- START: Define CWD for the test ---
const ACTUAL_PROCESS_CWD = actualProcess.cwd(); 
// --- END: Define CWD for the test ---

const TEST_FILENAME = "test.txt";
const TEST_FILE_PATH = path.join(ACTUAL_PROCESS_CWD, TEST_FILENAME);
const INITIAL_CONTENT = "Hello\nWorld\n";

describe("Agent Patch Reread Test", () => {
  beforeEach(async () => {
    // Create the test file
    await fsPromises.writeFile(TEST_FILE_PATH, INITIAL_CONTENT);

    vi.spyOn(actualProcess, 'cwd').mockReturnValue(ACTUAL_PROCESS_CWD);
    // Reset modules to ensure handleExecCommand picks up the mocked cwd
    vi.resetModules();
    // Dynamically import handleExecCommand after mocks are set up
    const hecModule = await import("../src/utils/agent/handle-exec-command.js");
    handleExecCommand = hecModule.handleExecCommand;
  });

  afterEach(async () => {
    // Clean up the test file
    try {
      await fsPromises.unlink(TEST_FILE_PATH);
    } catch (error) {
      // Ignore errors if the file doesn't exist (e.g., test failed before creating it)
    }
    vi.restoreAllMocks();
  });

  it("should correctly apply a patch, prompt for re-read, and apply a subsequent patch successfully", async () => {
    const config: AppConfig = {
      apiKey: "test-key",
      model: "test-model",
      instructions: "",
      agent: {
        autoApproveAll: true, 
      },
    };

    const mockGetCommandConfirmation = vi.fn(
      async (): Promise<CommandConfirmation> => ({
        review: ReviewDecision.YES,
      }),
    );

    const patch1 = `*** Begin Patch
*** Update File: ${TEST_FILE_PATH}
@@
 Hello
-World
+Universe
*** End Patch`;

    let result = await handleExecCommand(
      { cmd: ["apply_patch", patch1], workdir: ACTUAL_PROCESS_CWD },
      config,
      "full-auto",
      mockGetCommandConfirmation,
    );

    expect(result.outputText).toBe(
      `Patch successfully applied to '${TEST_FILE_PATH}'. The file content has changed. If you need to perform further operations on this file, please re-read it to ensure you have the latest version.`,
    );
    expect(result.metadata.exit_code).toBe(0);
    expect(mockGetCommandConfirmation).toHaveBeenCalledTimes(0); 

    let currentFileContent = await fsPromises.readFile(TEST_FILE_PATH, "utf-8");
    expect(currentFileContent).toBe("Hello\nUniverse\n");

    const patch2 = `*** Begin Patch
*** Update File: ${TEST_FILE_PATH}
@@
 Hello
-Universe
+Multiverse
*** End Patch`;
    
    result = await handleExecCommand(
      { cmd: ["apply_patch", patch2], workdir: ACTUAL_PROCESS_CWD },
      config,
      "full-auto",
      mockGetCommandConfirmation,
    );
    
    expect(result.metadata.exit_code).toBe(0);
    expect(result.outputText).toBe(
      `Patch successfully applied to '${TEST_FILE_PATH}'. The file content has changed. If you need to perform further operations on this file, please re-read it to ensure you have the latest version.`,
    );
    expect(mockGetCommandConfirmation).toHaveBeenCalledTimes(0);

    currentFileContent = await fsPromises.readFile(TEST_FILE_PATH, "utf-8");
    expect(currentFileContent).toBe("Hello\nMultiverse\n");
  });
});
