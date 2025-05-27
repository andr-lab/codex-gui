import { spawn } from "child_process";
import fs from "fs-extra"; // fs-extra is good for recursive ops like rmdir
import os from "os";
import path from "path";

// Simple promise wrapper for child_process.spawn
function runGitCommand(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const git = spawn("git", args, { cwd });
    let stdout = "";
    let stderr = "";

    git.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    git.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    git.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        // Log the stderr for debugging purposes on the server/CLI output
        console.error(`Git command error for "git ${args.join(" ")}":\n${stderr}`);
        reject(new Error(`Git command failed with code ${code}: ${stderr.trim()}`));
      }
    });

    git.on("error", (err) => {
      // e.g., if git command is not found
      console.error(`Failed to start Git command "git ${args.join(" ")}":`, err);
      reject(new Error(`Failed to start Git command: ${err.message}. Is Git installed and in your PATH?`));
    });
  });
}

/**
 * Clones a GitHub repository to a temporary directory and checks out a specific branch.
 * @param repoFullName - The full name of the repository (e.g., "owner/repo").
 * @param branch - The branch to checkout.
 * @param githubToken - Optional GitHub token for cloning private repositories.
 * @returns The path to the temporary directory where the repository is cloned.
 */
export async function cloneGitHubRepo(
  repoFullName: string,
  branch: string,
  githubToken?: string,
): Promise<string> {
  if (!repoFullName || !repoFullName.includes("/")) {
    throw new Error("Invalid repository name format. Expected 'owner/repo'.");
  }
  if (!branch) {
    throw new Error("Branch name must be provided.");
  }

  const repoName = repoFullName.split("/")[1];
  // Create a unique temporary directory for this clone
  // Example: /tmp/codex-cli/yyyy-mm-dd-hhmmss-repoName
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const tempDirParent = path.join(os.tmpdir(), "codex-cli");
  const tempDirPath = path.join(tempDirParent, `${timestamp}-${repoName}`);

  try {
    // Ensure parent temp directory exists
    await fs.ensureDir(tempDirParent);
    
    // Clean up any old directory with the same name (should be rare with timestamp)
    if (await fs.pathExists(tempDirPath)) {
      await fs.remove(tempDirPath);
    }
    await fs.ensureDir(tempDirPath); // Create the specific temp dir for this clone

    const repoUrl = githubToken
      ? `https://oauth2:${githubToken}@github.com/${repoFullName}.git`
      : `https://github.com/${repoFullName}.git`;

    console.log(`Cloning ${repoFullName} (branch: ${branch}) into ${tempDirPath}...`);

    // Clone the specific branch
    // Using --depth 1 and --branch can be faster if only that branch is needed.
    await runGitCommand(["clone", "--branch", branch, "--depth", "1", repoUrl, tempDirPath]);
    
    console.log(`Repository cloned successfully. Checking out branch ${branch}...`);
    // Git clone --branch already checks out the branch, but an explicit checkout
    // can be a way to verify or switch if needed, though --depth 1 might restrict this.
    // For a shallow clone, the branch is already checked out.
    // If not using --depth 1, then `git checkout ${branch}` might be run here.

    console.log(`Successfully cloned ${repoFullName} at branch ${branch} to ${tempDirPath}`);
    return tempDirPath;
  } catch (error) {
    // Cleanup partial clone if error occurs
    if (await fs.pathExists(tempDirPath)) {
      await fs.remove(tempDirPath);
    }
    console.error(`Failed to clone repository ${repoFullName}:`, error);
    throw error; // Re-throw to be handled by the caller
  }
}

/**
 * Removes the cloned repository directory.
 * @param directoryPath - The path to the directory to remove.
 */
export async function cleanupClonedRepo(directoryPath: string): Promise<void> {
  if (!directoryPath || !directoryPath.startsWith(path.join(os.tmpdir(), "codex-cli"))) {
    console.warn(`Skipping cleanup: Path ${directoryPath} does not look like a codex-cli temporary directory.`);
    return;
  }
  try {
    console.log(`Cleaning up temporary directory: ${directoryPath}`);
    await fs.remove(directoryPath);
    console.log(`Successfully removed ${directoryPath}`);
  } catch (error) {
    console.error(`Failed to clean up temporary directory ${directoryPath}:`, error);
    // Don't re-throw, as cleanup failure shouldn't crash the app, but log it.
  }
}

/**
 * Stages, commits, creates a new branch, and pushes changes to GitHub.
 * @param clonedRepoPath - The local path to the cloned repository.
 * @param repoFullName - The full name of the repository (e.g., "owner/repo").
 * @param newBranchName - The name for the new branch.
 * @param commitMessage - The commit message.
 * @param githubToken - The GitHub access token for authentication.
 */
export async function publishToGitHub(
  clonedRepoPath: string,
  repoFullName: string, // e.g., "username/myrepo"
  newBranchName: string,
  commitMessage: string,
  githubToken: string,
): Promise<string> { // Returns the URL of the new branch on GitHub or a success message
  if (!clonedRepoPath) throw new Error("Cloned repository path is required.");
  if (!repoFullName) throw new Error("Repository full name (owner/repo) is required.");
  if (!newBranchName) throw new Error("New branch name is required.");
  if (!commitMessage) throw new Error("Commit message is required.");
  if (!githubToken) throw new Error("GitHub token is required for publishing.");

  const repoUrlWithToken = `https://oauth2:${githubToken}@github.com/${repoFullName}.git`;

  try {
    console.log(`Publishing changes from ${clonedRepoPath} to new branch ${newBranchName} on ${repoFullName}`);

    // Check for changes
    const statusOutput = await runGitCommand(["status", "--porcelain"], clonedRepoPath);
    if (!statusOutput) {
      console.log("No changes to commit. Publishing aborted.");
      return "No changes to publish.";
    }
    console.log("Changes detected:\n", statusOutput);

    await runGitCommand(["add", "."], clonedRepoPath);
    console.log("Changes staged.");

    // Configure git user for commit, if not already configured globally
    // This might be needed if running in a very clean environment
    try {
      await runGitCommand(["config", "user.name"], clonedRepoPath);
    } catch (e) {
      await runGitCommand(["config", "user.name", "Codex CLI"], clonedRepoPath);
      console.log("Configured git user.name for commit.");
    }
    try {
      await runGitCommand(["config", "user.email"], clonedRepoPath);
    } catch (e) {
      await runGitCommand(["config", "user.email", "codex-cli@example.com"], clonedRepoPath);
      console.log("Configured git user.email for commit.");
    }
    
    await runGitCommand(["commit", "-m", commitMessage], clonedRepoPath);
    console.log(`Changes committed with message: "${commitMessage}"`);

    // Check current branch in case we are already on it (e.g. retry)
    let currentBranch = "";
    try {
      currentBranch = await runGitCommand(["rev-parse", "--abbrev-ref", "HEAD"], clonedRepoPath);
    } catch (e) {
      // Ignore if it fails, we'll try to create the branch anyway
    }

    if (currentBranch !== newBranchName) {
      // Create and switch to the new branch
      // Use `git switch -c <branch>` or `git checkout -b <branch>`
      // `git branch <branchName>` followed by `git checkout <branchName>` is safer if branch might exist
      try {
        await runGitCommand(["branch", newBranchName], clonedRepoPath);
      } catch (e) {
        // If branch already exists, error might be thrown by `git branch <name>` if it's not meant to overwrite.
        // We can choose to ignore or force. For a unique name, this should be rare.
        console.warn(`Warning: Could not create branch '${newBranchName}' (it might already exist). Attempting to switch. Error: ${e}`);
      }
      await runGitCommand(["checkout", newBranchName], clonedRepoPath);
      console.log(`Switched to new local branch: ${newBranchName}`);
    } else {
      console.log(`Already on branch: ${newBranchName}`);
    }

    // Push the new branch to the remote repository
    // Need to set upstream correctly if branch is new: `git push -u origin <branchName>`
    // Or just `git push <repoUrlWithToken> <branchName>`
    await runGitCommand(["push", repoUrlWithToken, newBranchName], clonedRepoPath);
    console.log(`Successfully pushed branch ${newBranchName} to ${repoFullName}.`);

    const branchUrl = `https://github.com/${repoFullName}/tree/${newBranchName}`;
    return `Changes published to new branch: ${newBranchName}\nView at: ${branchUrl}`;

  } catch (error) {
    console.error(`Failed to publish changes to GitHub:`, error);
    // More specific error handling can be added here based on git error messages
    if (error instanceof Error && error.message.includes("protected branch hook declined")) {
        throw new Error(`Failed to push: The branch '${newBranchName}' might be protected or a similar branch protection rule is active. Details: ${error.message}`);
    } else if (error instanceof Error && error.message.includes("GH006")) { // GH006 is often related to branch name restrictions
        throw new Error(`Failed to push: The branch name '${newBranchName}' might be invalid or restricted by GitHub. Details: ${error.message}`);
    } else if (error instanceof Error && error.message.includes("! [remote rejected]")) {
        throw new Error(`Failed to push: Remote repository rejected the push. Check permissions and repository status. Details: ${error.message}`);
    }
    throw error; // Re-throw to be handled by the caller
  }
}