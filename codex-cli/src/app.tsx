import type { ApprovalPolicy } from "./approvals";
import type { AppConfig } from "./utils/config";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.mjs";

import TerminalChat from "./components/chat/terminal-chat";
import TerminalChatPastRollout from "./components/chat/terminal-chat-past-rollout";
import { checkInGit } from "./utils/check-in-git";
import {
  isGitHubAuthenticated,
  fetchGitHubRepositories,
  getGitHubAccessToken, // For cloning private repos
  // fetchGitHubBranches, // Will be used later
} from "./utils/github-auth.js";
import { loadConfig, saveConfig } from "./utils/config.js";
import { cloneGitHubRepo, cleanupClonedRepo } from "./utils/git-utils.js";
import { CLI_VERSION, type TerminalChatSession } from "./utils/session.js";
import { onExit } from "./utils/terminal";
import { ConfirmInput, SelectInput, TextInput } from "@inkjs/ui";
import { Box, Text, useApp, useStdin } from "ink";
import React, { useEffect, useMemo, useState } from "react";

export type AppRollout = {
  session: TerminalChatSession;
  items: Array<ChatCompletionMessageParam>;
};

type Props = {
  prompt?: string;
  config: AppConfig;
  cliGithubRepo?: string; // New prop from CLI
  cliGithubBranch?: string; // New prop from CLI
  imagePaths?: Array<string>;
  rollout?: AppRollout;
  approvalPolicy: ApprovalPolicy;
  fullStdout: boolean;
};

export default function App({
  prompt,
  config,
  rollout,
  imagePaths,
  approvalPolicy,
  fullStdout,
  cliGithubRepo, // Destructure new props
  cliGithubBranch,
}: Props): JSX.Element {
  const app = useApp();
  const [acceptedGitWarning, setAcceptedGitWarning] = useState(() => false);
  const [cwd, inGitRepo] = useMemo(
    () => [process.cwd(), checkInGit(process.cwd())],
    [],
  );
  const { internal_eventEmitter } = useStdin();
  internal_eventEmitter.setMaxListeners(20); // Increased listener limit

  // GitHub repo/branch selection state
  const [isLoadingGitHub, setIsLoadingGitHub] = useState(false);
  const [githubError, setGitHubError] = useState<string | null>(null);
  // Store more repository info, including default_branch
  const [repositories, setRepositories] = useState<
    { label: string; value: string; defaultBranch: string }[]
  >([]);
  const [showRepoSelect, setShowRepoSelect] = useState(false);
  const [selectedRepoFullName, setSelectedRepoFullName] = useState<
    string | null
  >(cliGithubRepo || config.githubSelectedRepo || null); // Prioritize CLI prop
  // Store the default branch of the selected repo to prefill input
  const [selectedRepoDefaultBranch, setSelectedRepoDefaultBranch] = useState<string>("main");
  const [showBranchInput, setShowBranchInput] = useState(false); // Will be skipped if CLI props are set
  const [currentBranch, setCurrentBranch] = useState<string | null>(
    cliGithubBranch || config.githubSelectedBranch || null, // Prioritize CLI prop
  );
  const [branchInputValue, setBranchInputValue] = useState(cliGithubBranch || ""); // Pre-fill if CLI branch provided

  // State for cloning
  const [isCloning, setIsCloning] = useState(false);
  const [cloningError, setCloningError] = useState<string | null>(null);
  const [clonedRepoPath, setClonedRepoPath] = useState<string | null>(null);


  // Function to initiate cloning
  const performClone = async (repoFullName: string, branchName: string) => {
    if (!repoFullName || !branchName) return;

    setIsCloning(true);
    setCloningError(null);
    // Clean up any previous clone path before starting a new one
    if (clonedRepoPath) {
      await cleanupClonedRepo(clonedRepoPath);
      setClonedRepoPath(null);
    }

    try {
      const token = getGitHubAccessToken(); // Get token for private repos
      const newClonedPath = await cloneGitHubRepo(repoFullName, branchName, token);
      setClonedRepoPath(newClonedPath);
    } catch (error) {
      setCloningError(error instanceof Error ? error.message : "Unknown cloning error");
      // If cloning fails, unset the selected repo/branch in memory so user can re-select or app can proceed without it
      setSelectedRepoFullName(null);
      setCurrentBranch(null);
      // Optionally, also clear from config if desired, or let user retry
    } finally {
      setIsCloning(false);
    }
  };


  // Effect to handle initial GitHub auth check, repo loading, and auto-cloning
  useEffect(() => {
    const initialLoad = async () => {
      if (cliGithubRepo) { // If repo is provided via CLI
        if (!isGitHubAuthenticated()) {
          setCloningError("GitHub repository specified via CLI, but not authenticated. Please run `codex auth github`.");
          setIsLoadingGitHub(false); // Ensure loading state is off
          return;
        }
        // Use CLI provided repo and branch (branch can be undefined, performClone will handle fetching default)
        setSelectedRepoFullName(cliGithubRepo);
        const branchToUse = cliGithubBranch || ""; // Pass empty if not set, performClone should fetch default
        setCurrentBranch(cliGithubBranch); // Set current branch if provided
        setBranchInputValue(cliGithubBranch || ""); // Ensure input value is also set

        // We need to fetch the default branch if cliGithubBranch is not provided
        if (!cliGithubBranch) {
          setIsLoadingGitHub(true);
          try {
            const repos = await fetchGitHubRepositories(); // This is inefficient, ideally fetch just one repo's details
            const repoData = repos.find(r => r.full_name === cliGithubRepo);
            if (repoData) {
              setSelectedRepoDefaultBranch(repoData.default_branch);
              setCurrentBranch(repoData.default_branch); // Set currentBranch to default
              setBranchInputValue(repoData.default_branch); // Set input value for consistency
              await performClone(cliGithubRepo, repoData.default_branch);
            } else {
              setCloningError(`Repository ${cliGithubRepo} not found or not accessible.`);
            }
          } catch (error) {
             setCloningError(error instanceof Error ? error.message : "Failed to fetch repository details for default branch.");
          } finally {
            setIsLoadingGitHub(false);
          }
        } else {
          // Both repo and branch provided via CLI
          await performClone(cliGithubRepo, cliGithubBranch);
        }
        setShowRepoSelect(false); // Ensure interactive selection is skipped
        setShowBranchInput(false); // Ensure interactive selection is skipped
      } else if (isGitHubAuthenticated()) { // No CLI repo, proceed with config or interactive selection
        if (config.githubSelectedRepo && config.githubSelectedBranch) {
          setSelectedRepoFullName(config.githubSelectedRepo);
          setCurrentBranch(config.githubSelectedBranch);
          setBranchInputValue(config.githubSelectedBranch); // Pre-fill from config
          await performClone(config.githubSelectedRepo, config.githubSelectedBranch);
        } else if (!config.githubSelectedRepo) {
          setIsLoadingGitHub(true);
          setGitHubError(null);
          try {
            const repos = await fetchGitHubRepositories();
            if (repos.length === 0) {
              setGitHubError(
                "No repositories found for your GitHub account.",
              );
            } else {
              setRepositories(
                repos.map((repo) => ({
                  label: repo.full_name, // Display full name
                  value: repo.full_name, // Use full name as value for selection
                  defaultBranch: repo.default_branch,
                })),
              );
              setShowRepoSelect(true);
            }
          } catch (error) {
            setGitHubError(
              error instanceof Error ? error.message : "Unknown GitHub API error",
            );
          } finally {
            setIsLoadingGitHub(false);
          }
        }
        // If repo is already selected in config, it's already in selectedRepoFullName & currentBranch
      }
      // If not authenticated and no CLI repo, do nothing, proceed to normal flow or git warning
    };

    if (!rollout) { // Don't do this if viewing a past rollout
      initialLoad();
    }
  }, [cliGithubRepo, cliGithubBranch, config.githubSelectedRepo, config.githubSelectedBranch, rollout]); // Add CLI props to dependency array


  if (rollout) {
    return (
      <TerminalChatPastRollout
        session={rollout.session}
        items={rollout.items}
      />
    );
  }

  // --- App Exit Cleanup ---
  useEffect(() => {
    const handleAppExit = async () => {
      if (clonedRepoPath) {
        await cleanupClonedRepo(clonedRepoPath);
      }
    };
    app.onExit(handleAppExit);
    return () => {
      app.offExit(handleAppExit);
    };
  }, [app, clonedRepoPath]);


  // --- GitHub Loading / Error State ---
  if (isLoadingGitHub) {
    return (
      <Box>
        <Text>Loading GitHub repositories...</Text>
      </Box>
    );
  }

  if (githubError) {
    return (
      <Box flexDirection="column">
        <Text color="red">GitHub Error: {githubError}</Text>
        <Text>
          Please ensure you have authenticated with `codex auth github` and have
          internet connectivity.
        </Text>
        <Text>You can also set `githubSelectedRepo` and `githubSelectedBranch` in your config.</Text>
        {/* TODO: Add a retry button or instructions to proceed without GitHub integration */}
      </Box>
    );
  }

  // --- GitHub Repository Selection (only if not specified by CLI and not yet cloned/errored) ---
  if (showRepoSelect && !cliGithubRepo && repositories.length > 0 && !clonedRepoPath && !cloningError && !githubError) {
    return (
      <Box flexDirection="column">
        <Text>Select a GitHub repository:</Text>
        <SelectInput
          items={repositories}
          onSelect={(selectedItem) => {
            const repoData = repositories.find(r => r.value === selectedItem.value);
            if (repoData) {
              setSelectedRepoFullName(repoData.value);
              setSelectedRepoDefaultBranch(repoData.defaultBranch);
              setBranchInputValue(repoData.defaultBranch); // Pre-fill with default branch
            }
            setShowRepoSelect(false);
            setShowBranchInput(true);
          }}
        />
      </Box>
    );
  }

  // --- GitHub Branch Input (only if not specified by CLI and repo selected interactively) ---
  if (showBranchInput && selectedRepoFullName && !cliGithubRepo && !clonedRepoPath && !cloningError) {
    return (
      <Box flexDirection="column">
        <Text>
          Enter branch name for repository <Text bold>{selectedRepoFullName}</Text> (or press Enter for default):
        </Text>
        <TextInput
          placeholder="e.g., main, develop, feature/new-thing"
          value={branchInputValue}
          onChange={setBranchInputValue}
          onSubmit={async () => {
            // TODO: Validate branch name (e.g., fetch branches and check if it exists)
            // If input is empty after pre-filling, use the pre-filled default branch.
            const branchToSave = branchInputValue.trim() || selectedRepoDefaultBranch;
            setCurrentBranch(branchToSave);

            const newConfig = { ...loadConfig(), githubSelectedRepo: selectedRepoFullName, githubSelectedBranch: branchToSave };
            saveConfig(newConfig);
            
            setShowBranchInput(false);
            // Proceed to clone the repository
            await performClone(selectedRepoFullName, branchToSave);
            setShowBranchInput(false);
          }}
        />
         <Text dimColor>Default branch is '{selectedRepoDefaultBranch}'. Submit empty to use it.</Text>
      </Box>
    );
  }


  // --- Original Git Warning (if applicable and repo/branch selection is done) ---
  const gitWarningCondition = !inGitRepo && !acceptedGitWarning && !selectedRepoFullName && !currentBranch;
  // Or, if repo/branch is now selected, but still not in a git repo locally for other reasons:
  // const gitWarningCondition = !inGitRepo && !acceptedGitWarning && (selectedRepoFullName && currentBranch);
  // Show warning if not in a git repo, regardless of GitHub repo selection,
  // unless the warning has already been accepted for the session.
  const showGitWarning = !inGitRepo && !acceptedGitWarning;

  if (showGitWarning) {
    return (
      <Box flexDirection="column">
        <Box borderStyle="round" paddingX={1} width={64}>
          <Text>
            ● OpenAI <Text bold>Codex</Text>{" "}
            <Text dimColor>
              (research preview) <Text color="blueBright">v{CLI_VERSION}</Text>
            </Text>
          </Text>
        </Box>
        <Box
          borderStyle="round"
          borderColor="redBright"
          flexDirection="column"
          gap={1}
        >
          <Text>
            <Text color="yellow">Warning!</Text> It can be dangerous to run a
            coding agent outside of a git repo in case there are changes that
            you want to revert. Do you want to continue?
          </Text>
          <Text>{cwd}</Text>
          <ConfirmInput
            defaultChoice="cancel"
            onCancel={() => {
              app.exit();
              onExit();
              // eslint-disable-next-line
              console.error(
                "Quitting! Run again to accept or from inside a git repo",
              );
            }}
            onConfirm={() => setAcceptedGitWarning(true)}
          />
        </Box>
      </Box>
    );
  }

  // --- Proceed to TerminalChat if everything is set ---
  // Ensure config reflects the selections if made during this session
  // Update currentConfig to reflect the true source of repo/branch for this session
  const sessionGithubRepo = cliGithubRepo || selectedRepoFullName || config.githubSelectedRepo;
  const sessionGithubBranch = cliGithubBranch || currentBranch || config.githubSelectedBranch;

  const currentConfig: AppConfig = {
    ...config, // Base config
    githubSelectedRepo: sessionGithubRepo, // Override with session-specific value
    githubSelectedBranch: sessionGithubBranch, // Override with session-specific value
  };

  // --- Cloning State ---
  if (isCloning) {
    return (
      <Box>
        <Text>Cloning repository {selectedRepoFullName} (branch: {currentBranch})...</Text>
      </Box>
    );
  }

  if (cloningError) {
    return (
      <Box flexDirection="column">
        <Text color="red">Cloning Error: {cloningError}</Text>
        <Text>Please check repository URL, branch name, permissions, and network connection.</Text>
        {/* TODO: Add a retry button or option to select a different repo/branch */}
      </Box>
    );
  }

  // --- Proceed to TerminalChat if everything is set ---
  // If a repo was cloned, TerminalChat should operate in that context.
  return (
    <TerminalChat
      config={currentConfig} // Pass potentially updated config
      prompt={prompt}
      imagePaths={imagePaths}
      effectiveCwd={clonedRepoPath || undefined} // Pass cloned path as effective CWD
      approvalPolicy={approvalPolicy}
      fullStdout={fullStdout}
    />
  );
}
