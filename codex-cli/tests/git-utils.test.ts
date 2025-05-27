import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  cloneGitHubRepo,
  publishToGitHub,
  cleanupClonedRepo,
} from "../src/utils/git-utils"; // Adjust path as necessary
import { spawn } from "child_process";
import fs from "fs-extra";
import os from "os";
import path from "path";

// Mock child_process
vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

// Mock fs-extra
vi.mock("fs-extra", () => {
  const mockEnsureDir = vi.fn(() => Promise.resolve());
  const mockPathExists = vi.fn(() => Promise.resolve(false));
  const mockRemove = vi.fn(() => Promise.resolve());
  return {
    default: {
      ensureDir: mockEnsureDir,
      pathExists: mockPathExists,
      remove: mockRemove,
    },
    ensureDir: mockEnsureDir,
    pathExists: mockPathExists,
    remove: mockRemove,
  };
});

// Mock os
vi.mock("os", () => ({
  // Provide a 'default' object that contains the mocked 'tmpdir'
  default: {
    tmpdir: vi.fn(() => "/tmp"), // Consistent tmpdir for tests
  },
  // It can also be useful to provide tmpdir directly on the mock object
  // if some code were to import it as `import { tmpdir } from "os";`
  // or if TypeScript resolves `os.tmpdir()` to this level.
  // Given the error, the `default` property is the crucial one.
  tmpdir: vi.fn(() => "/tmp"),
}));

const createMockEmitter = (stdoutData = "", stderrData = "", closeCode = 0) => ({
  stdout: { on: vi.fn((event, cb) => { if (event === 'data') cb(stdoutData); }) },
  stderr: { on: vi.fn((event, cb) => { if (event === 'data') cb(stderrData); }) },
  on: vi.fn((event, cb) => {
    if (event === "close") cb(closeCode);
  }),
  pid: Math.random(), // Unique pid
});

describe("git-utils", () => {
  let mockSpawnEmitter: ReturnType<typeof createMockEmitter>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawnEmitter = createMockEmitter();
    // Default successful spawn
    (spawn as any).mockReturnValue(mockSpawnEmitter);
    // Reset fs-extra mocks for each test if necessary
    (fs.ensureDir as any).mockResolvedValue(undefined);
    (fs.pathExists as any).mockResolvedValue(false); // Default to false
    (fs.remove as any).mockResolvedValue(undefined);
  });

  describe("cloneGitHubRepo", () => {
    it("should successfully clone a public repository", async () => {
      const repoFullName = "owner/repo";
      const branch = "main";
      const expectedPathPrefix = path.join("/tmp", "codex-cli");

      const resultPath = await cloneGitHubRepo(repoFullName, branch);

      expect(resultPath).toContain(expectedPathPrefix);
      expect(resultPath).toContain("repo"); // Check if repo name is in the path
      expect(fs.ensureDir).toHaveBeenCalledWith(expectedPathPrefix); // Parent temp dir
      expect(fs.ensureDir).toHaveBeenCalledWith(resultPath);      // Specific clone dir
      expect(spawn).toHaveBeenCalledWith(
        "git",
        [
          "clone",
          "--branch",
          branch,
          "--depth",
          "1",
          `https://github.com/${repoFullName}.git`,
          resultPath,
        ],
        { cwd: undefined } // cwd is undefined for clone command itself
      );
    });

    it("should successfully clone a private repository using a token", async () => {
      const repoFullName = "owner/private-repo";
      const branch = "develop";
      const token = "test-token";
      const expectedPathPrefix = path.join("/tmp", "codex-cli");
      
      const resultPath = await cloneGitHubRepo(repoFullName, branch, token);

      expect(resultPath).toContain(expectedPathPrefix);
      expect(spawn).toHaveBeenCalledWith(
        "git",
        [
          "clone",
          "--branch",
          branch,
          "--depth",
          "1",
          `https://oauth2:${token}@github.com/${repoFullName}.git`,
          resultPath,
        ],
        { cwd: undefined }
      );
    });

    it("should throw an error if repoFullName is invalid", async () => {
      await expect(cloneGitHubRepo("invalid-repo", "main")).rejects.toThrow(
        "Invalid repository name format."
      );
    });

    it("should throw an error if branch is not provided", async () => {
      await expect(cloneGitHubRepo("owner/repo", "")).rejects.toThrow(
        "Branch name must be provided."
      );
    });

    it("should attempt cleanup if git clone fails", async () => {
      (spawn as any).mockImplementationOnce(() => createMockEmitter("", "git clone failed error message", 1));
      (fs.pathExists as any).mockResolvedValue(true); // Simulate path exists for cleanup

      const repoFullName = "owner/repo";
      const branch = "main";
      
      await expect(cloneGitHubRepo(repoFullName, branch)).rejects.toThrow();
      const resultPathPattern = new RegExp(path.join("/tmp", "codex-cli", ".*-repo").replace(/\\/g, '\\\\'));
      expect(fs.remove).toHaveBeenCalledWith(expect.stringMatching(resultPathPattern));
    });
  });

  describe("publishToGitHub", () => {
    const clonedRepoPath = "/tmp/codex-cli/test-clone-path";
    const repoFullName = "test-user/test-repo";
    const newBranchName = "codex-feature-branch";
    const commitMessage = "Test commit";
    const githubToken = "test-gh-token";

    it("should publish changes successfully", async () => {
      (spawn as any).mockImplementation((cmd: string, args: string[]) => {
        if (args.join(" ") === "status --porcelain") {
          return createMockEmitter("M file.txt"); // Has changes
        }
        if (args.includes("config") && args.length === 2 && (args.includes("user.name") || args.includes("user.email"))) {
          // Simulate config not found (git config <key> exits 1 if not found)
          return createMockEmitter("", "", 1);
        }
        return createMockEmitter(); // Default success for other commands
      });
      const result = await publishToGitHub(
        clonedRepoPath,
        repoFullName,
        newBranchName,
        commitMessage,
        githubToken
      );

      expect(result).toContain("Changes published to new branch");
      expect(result).toContain(`https://github.com/${repoFullName}/tree/${newBranchName}`);
      
      expect(spawn).toHaveBeenCalledWith("git", ["status", "--porcelain"], { cwd: clonedRepoPath });
      expect(spawn).toHaveBeenCalledWith("git", ["add", "."], { cwd: clonedRepoPath });
      // Check that config was set (because the checks above returned exit code 1)
      expect(spawn).toHaveBeenCalledWith("git", ["config", "user.name"], { cwd: clonedRepoPath }); // Check for user.name
      expect(spawn).toHaveBeenCalledWith("git", ["config", "user.email"], { cwd: clonedRepoPath });// Check for user.email
      expect(spawn).toHaveBeenCalledWith("git", ["config", "user.name", "Codex CLI"], { cwd: clonedRepoPath });
      expect(spawn).toHaveBeenCalledWith("git", ["config", "user.email", "codex-cli@example.com"], { cwd: clonedRepoPath });

      expect(spawn).toHaveBeenCalledWith("git", ["commit", "-m", commitMessage], { cwd: clonedRepoPath });
      expect(spawn).toHaveBeenCalledWith("git", ["branch", newBranchName], { cwd: clonedRepoPath });
      expect(spawn).toHaveBeenCalledWith("git", ["checkout", newBranchName], { cwd: clonedRepoPath });
      expect(spawn).toHaveBeenCalledWith(
        "git",
        ["push", `https://oauth2:${githubToken}@github.com/${repoFullName}.git`, newBranchName],
        { cwd: clonedRepoPath }
      );
    });

    it("should return 'No changes to publish' if git status is clean", async () => {
      (spawn as any).mockImplementation((cmd: string, args: string[]) => {
        if (args.join(" ") === "status --porcelain") {
          return createMockEmitter(""); // No output = no changes
        }
        return createMockEmitter();
      });
      const result = await publishToGitHub(
        clonedRepoPath,
        repoFullName,
        newBranchName,
        commitMessage,
        githubToken
      );
      expect(result).toBe("No changes to publish.");
      expect(spawn).toHaveBeenCalledWith("git", ["status", "--porcelain"], { cwd: clonedRepoPath });
      expect(spawn).not.toHaveBeenCalledWith("git", ["add", "."], { cwd: clonedRepoPath });
    });

    it("should throw error if push fails", async () => {
       (spawn as any).mockImplementation((cmd: string, args: string[]) => {
        if (args.join(" ") === "status --porcelain") return createMockEmitter("M file.txt");
        if (args.includes("push")) {
          return createMockEmitter("", "push failed", 1); // Simulate push error
        }
        return createMockEmitter();
      });
      await expect(
        publishToGitHub(clonedRepoPath, repoFullName, newBranchName, commitMessage, githubToken)
      ).rejects.toThrow("Git command failed with code 1");
    });
  });

  describe("cleanupClonedRepo", () => {
    it("should call fs.remove for a valid path", async () => {
      const validPath = path.join(os.tmpdir(), "codex-cli", "some-repo");
      await cleanupClonedRepo(validPath);
      expect(fs.remove).toHaveBeenCalledWith(validPath);
    });

    it("should not call fs.remove for an invalid path", async () => {
      const invalidPath = "/some/other/path";
      await cleanupClonedRepo(invalidPath);
      expect(fs.remove).not.toHaveBeenCalled();
    });

    it("should not call fs.remove if path is null or empty", async () => {
      await cleanupClonedRepo("");
      expect(fs.remove).not.toHaveBeenCalled();
      await cleanupClonedRepo(null as any); // Test with null
      expect(fs.remove).not.toHaveBeenCalled();
    });

    it("should catch and log errors from fs.remove but not re-throw", async () => {
      const validPath = path.join(os.tmpdir(), "codex-cli", "some-repo");
      (fs.remove as any).mockRejectedValueOnce(new Error("FS Remove Failed"));
      const consoleErrorSpy = vi.spyOn(console, 'error');


      // Expect no error to be thrown to the caller
      await expect(cleanupClonedRepo(validPath)).resolves.toBeUndefined();
      expect(fs.remove).toHaveBeenCalledWith(validPath);
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to clean up temporary directory"), expect.any(Error));
      
      consoleErrorSpy.mockRestore();
    });
  });
});