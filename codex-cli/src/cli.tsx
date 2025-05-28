#!/usr/bin/env node
import "dotenv/config";

// Hack to suppress deprecation warnings (punycode)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(process as any).noDeprecation = true;

import type { AppRollout } from "./app";
import type { ApprovalPolicy } from "./approvals";
import type { CommandConfirmation } from "./utils/agent/agent-loop";
import type { AppConfig } from "./utils/config";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions.mjs";

import App from "./app";
import { runSinglePass } from "./cli-singlepass";
import { AgentLoop } from "./utils/agent/agent-loop";
import { initLogger } from "./utils/agent/log";
import { ReviewDecision } from "./utils/agent/review";
import { AutoApprovalMode } from "./utils/auto-approval-mode";
import { authenticateWithGitHubDeviceFlow, getGitHubToken } from "./utils/github-auth.js";
import { checkForUpdates } from "./utils/check-updates";
import {
  loadConfig,
  PRETTY_PRINT,
  INSTRUCTIONS_FILEPATH,
} from "./utils/config";
import { createInputItem } from "./utils/input-utils";
import { preloadModels } from "./utils/model-utils.js";
import {
  parseToolCallOutput,
  parseToolCallChatCompletion,
} from "./utils/parsers";
import { onExit, setInkRenderer } from "./utils/terminal";
import { spawnSync } from "child_process";
import fs from "fs";
import { render } from "ink";
import meow from "meow";
import path from "path";
import React from "react";

// Call this early so `tail -F "$TMPDIR/oai-codex/codex-cli-latest.log"` works
// immediately. This must be run with DEBUG=1 for logging to work.
initLogger();

// TODO: migrate to new versions of quiet mode
//
//     -q, --quiet    Non-interactive quiet mode that only prints final message
//     -j, --json     Non-interactive JSON output mode that prints JSON messages

const cli = meow(
  `
  Usage
    $ codex [options] <prompt>
    $ codex completion <bash|zsh|fish>
    $ codex auth github

  Options
    -h, --help                 Show usage and exit
    -m  --provider <provider>  Provider to use for completions (default: openai, options: openai, gemini, openrouter, ollama, xai)
    -m, --model <model>        Model to use for completions (default: o4-mini)
    -i, --image <path>         Path(s) to image files to include as input
    -v, --view <rollout>       Inspect a previously saved rollout instead of starting a session
    -q, --quiet                Non-interactive mode that only prints the assistant's final output
    -c, --config               Open the instructions file in your editor
    -a, --approval-mode <mode> Override the approval policy: 'suggest', 'auto-edit', or 'full-auto'

    --auto-edit                Automatically approve file edits; still prompt for commands
    --full-auto                Automatically approve edits and commands when executed in the sandbox

    --no-project-doc           Do not automatically include the repository's 'codex.md'
    --project-doc <file>       Include an additional markdown file at <file> as context
    --full-stdout              Do not truncate stdout/stderr from command outputs

  GitHub Integration Options
    --github-repo <owner/repo> Specify the GitHub repository (e.g., "openai/codex")
    --github-branch <branch>   Specify the branch for the GitHub repository

  Dangerous options
    --dangerously-auto-approve-everything
                               Skip all confirmation prompts and execute commands without
                               sandboxing. Intended solely for ephemeral local testing.

  Experimental options
    -f, --full-context         Launch in "full-context" mode which loads the entire repository
                               into context and applies a batch of edits in one go. Incompatible
                               with all other flags, except for --model.

  Examples
    $ codex "Write and run a python program that prints ASCII art"
    $ codex -q "fix build issues"
    $ codex completion bash
    $ codex auth github
    $ codex --github-repo "yourname/yourproject" --github-branch "feature-branch" "Implement feature X"
`,
  {
    importMeta: import.meta,
    autoHelp: true,
    flags: {
      // misc
      help: { type: "boolean", aliases: ["h"] },
      view: { type: "string" },
      model: { type: "string", aliases: ["m"] },
      provider: { type: "string", aliases: ["p"] },
      image: { type: "string", isMultiple: true, aliases: ["i"] },
      quiet: {
        type: "boolean",
        aliases: ["q"],
        description: "Non-interactive quiet mode",
      },
      config: {
        type: "boolean",
        aliases: ["c"],
        description: "Open the instructions file in your editor",
      },
      dangerouslyAutoApproveEverything: {
        type: "boolean",
        description:
          "Automatically approve all commands without prompting. This is EXTREMELY DANGEROUS and should only be used in trusted environments.",
      },
      autoEdit: {
        type: "boolean",
        description: "Automatically approve edits; prompt for commands.",
      },
      fullAuto: {
        type: "boolean",
        description:
          "Automatically run commands in a sandbox; only prompt for failures.",
      },
      approvalMode: {
        type: "string",
        aliases: ["a"],
        description:
          "Determine the approval mode for Codex (default: suggest) Values: suggest, auto-edit, full-auto",
      },
      noProjectDoc: {
        type: "boolean",
        description: "Disable automatic inclusion of project‑level codex.md",
      },
      projectDoc: {
        type: "string",
        description: "Path to a markdown file to include as project doc",
      },
      fullStdout: {
        type: "boolean",
        description:
          "Disable truncation of command stdout/stderr messages (show everything)",
        aliases: ["no-truncate"],
      },

      // Experimental mode where whole directory is loaded in context and model is requested
      // to make code edits in a single pass.
      fullContext: {
        type: "boolean",
        aliases: ["f"],
        description: `Run in full-context editing approach. The model is given the whole code
          directory as context and performs changes in one go without acting.`,
      },
      githubRepo: {
        type: "string",
        description: "Specify the GitHub repository (e.g., \"owner/repo\")",
      },
      githubBranch: {
        type: "string",
        description: "Specify the branch for the GitHub repository",
      },
    },
  },
);

// Handle 'auth github' command: This should be checked early.
if (cli.input[0] === "auth" && cli.input[1] === "github") {
  (async () => {
    let existingToken: string | null = null;
    try {
      existingToken = await getGitHubToken();
    } catch (error: any) {
      // Handle errors from trying to read the token (e.g., fs errors if stored in a file)
      console.error(`\n❌ Error checking existing GitHub token: ${error.message || "Unknown error."}`);
      console.error("Please ensure you have correctly set up your GitHub OAuth App Client ID in the config,");
      console.error("and that you complete the authorization process in your browser within the time limit.");
      process.exit(1);
      return; // Stop further execution in IIFE
    }

    if (existingToken) {
      console.log("\n🔑 Already authenticated with GitHub. Token found.");
      // To re-authenticate or logout, the user would typically clear the stored token.
      // console.log("To re-authenticate, clear the stored token first (e.g., via config or a logout command).");
      process.exit(0); // Exit successfully, test mock will throw here.
      return; // Stop further execution in IIFE
    }

    // No token, proceed with device flow
    try {
      console.log("\n⏳ No existing GitHub token found. Starting device authentication flow...");
      // authenticateWithGitHubDeviceFlow logs instructions (user_code, verification_uri)
      // It will resolve if token is obtained and saved, or reject on error/timeout.
      await authenticateWithGitHubDeviceFlow();
      // If it resolves, authentication was successful.
      console.log("\n✅ Successfully authenticated with GitHub!");
      process.exit(0); // Exit successfully, test mock will throw here.
    } catch (authError: any) {
      // This catch is specifically for errors from authenticateWithGitHubDeviceFlow
      console.error(`\n❌ GitHub authentication failed: ${authError.message || "Unknown error."}`);
      console.error("Please ensure you have correctly set up your GitHub OAuth App Client ID in the config,");
      console.error("and that you complete the authorization process in your browser within the time limit.");
      process.exit(1); // Exit with failure, test mock will throw here.
    }
  })();
} else if (cli.input[0] === "completion") {
  // Handle 'completion' subcommand before any prompting or API calls
  const shell = cli.input[1] || "bash";
  const scripts: Record<string, string> = {
    bash: `# bash completion for codex
_codex_completion() {
  local cur
  cur="\${COMP_WORDS[COMP_CWORD]}"
  COMPREPLY=( $(compgen -o default -o filenames -- "\${cur}") )
}
complete -F _codex_completion codex`,
    zsh: `# zsh completion for codex
#compdef codex

_codex() {
  _arguments '*:filename:_files'
}
_codex`,
    fish: `# fish completion for codex
complete -c codex -a '(_fish_complete_path)' -d 'file path'`,
  };
  const script = scripts[shell];
  if (!script) {
    // eslint-disable-next-line no-console
    console.error(`Unsupported shell: ${shell}`);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log(script);
  process.exit(0);
} else if (cli.flags.help) {
  // Show help if requested
  cli.showHelp();
  process.exit(0);
} else if (cli.flags.config) {
  // Handle config flag: open instructions file in editor and exit
  // Ensure configuration and instructions file exist
  try {
    loadConfig();
  } catch {
    // ignore errors
  }
  const filePath = INSTRUCTIONS_FILEPATH;
  const editor =
    process.env["EDITOR"] || (process.platform === "win32" ? "notepad" : "vi");
  spawnSync(editor, [filePath], { stdio: "inherit" });
  process.exit(0);
}

// ---------------------------------------------------------------------------
// API key handling
// ---------------------------------------------------------------------------
const fullContextMode = Boolean(cli.flags.fullContext);
const provider = cli.flags.provider;

let config = loadConfig(undefined, undefined, {
  cwd: process.cwd(),
  provider: provider,
  disableProjectDoc: Boolean(cli.flags.noProjectDoc),
  projectDocPath: cli.flags.projectDoc as string | undefined,
  isFullContext: fullContextMode,
});

const prompt = cli.input[0]; // This will be undefined if 'auth github' was handled, which is fine.
const model = cli.flags.model;
const imagePaths = cli.flags.image as Array<string> | undefined;
  const cliGithubRepo = cli.flags.githubRepo as string | undefined;
  const cliGithubBranch = cli.flags.githubBranch as string | undefined;

  // Validate GitHub flags
  if (cliGithubBranch && !cliGithubRepo) {
    console.error(
      "Error: --github-branch cannot be used without --github-repo.",
    );
    process.exit(1);
  }
  if (cliGithubRepo && !/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(cliGithubRepo)) {
    console.error(
      "Error: Invalid --github-repo format. Expected 'owner/repo'.",
    );
    process.exit(1);
  }

config = {
  ...config,
  model: model ?? config.model,
  provider: provider ?? config.provider,
    // If CLI flags are provided, they override config for githubSelectedRepo/Branch for this session
    // These won't be saved back to the config file by default.
    // app.tsx will need to prioritize these CLI-provided values.
};

// Check for updates after loading config
// This is important because we write state file in the config dir
await checkForUpdates().catch();

let rollout: AppRollout | undefined;

if (cli.flags.view) {
  const viewPath = cli.flags.view;
  const absolutePath = path.isAbsolute(viewPath)
    ? viewPath
    : path.join(process.cwd(), viewPath);
  try {
    const content = fs.readFileSync(absolutePath, "utf-8");
    rollout = JSON.parse(content) as AppRollout;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("Error reading rollout file:", error);
    process.exit(1);
  }
}

// If we are running in --fullcontext mode, do that and exit.
if (fullContextMode) {
  if (!prompt) {
    console.error("Error: Full context mode requires a prompt.");
    process.exit(1);
  }
  await runSinglePass({
    originalPrompt: prompt,
    config,
    rootPath: process.cwd(),
  });
  onExit();
  process.exit(0);
}

// If we are running in --quiet mode, do that and exit.
const quietMode = Boolean(cli.flags.quiet);
const fullStdout = Boolean(cli.flags.fullStdout);

if (quietMode) {
  process.env["CODEX_QUIET_MODE"] = "1";
  if (!prompt || prompt.trim() === "") {
    // eslint-disable-next-line no-console
    console.error(
      'Quiet mode requires a prompt string, e.g.,: codex -q "Fix bug #123 in the foobar project"',
    );
    process.exit(1);
  }

  // Determine approval policy for quiet mode based on flags
  const quietApprovalPolicy: ApprovalPolicy =
    cli.flags.fullAuto || cli.flags.approvalMode === "full-auto"
      ? AutoApprovalMode.FULL_AUTO
      : cli.flags.autoEdit || cli.flags.approvalMode === "auto-edit"
      ? AutoApprovalMode.AUTO_EDIT
      : config.approvalMode || AutoApprovalMode.SUGGEST;

  await runQuietMode({
    prompt: prompt as string,
    imagePaths: imagePaths || [],
    approvalPolicy: quietApprovalPolicy,
    config,
  });
  onExit();
  process.exit(0);
}

// If we reach here, it means we are not in 'auth github', 'completion', 'help', 'config', 
// 'fullContext', or 'quiet' mode. So a prompt is expected for the interactive app.
if (!prompt && !rollout) {
  cli.showHelp(); // Show help if no prompt is provided and not viewing a rollout
  process.exit(1);
}


// Default to the "suggest" policy.
// Determine the approval policy to use in interactive mode.
//
// Priority (highest → lowest):
// 1. --fullAuto – run everything automatically in a sandbox.
// 2. --dangerouslyAutoApproveEverything – run everything **without** a sandbox
//    or prompts.  This is intended for completely trusted environments.  Since
//    it is more dangerous than --fullAuto we deliberately give it lower
//    priority so a user specifying both flags still gets the safer behaviour.
// 3. --autoEdit – automatically approve edits, but prompt for commands.
// 4. config.approvalMode - use the approvalMode setting from ~/.codex/config.json.
// 5. Default – suggest mode (prompt for everything).

const approvalPolicy: ApprovalPolicy =
  cli.flags.fullAuto || cli.flags.approvalMode === "full-auto"
    ? AutoApprovalMode.FULL_AUTO
    : cli.flags.autoEdit || cli.flags.approvalMode === "auto-edit"
    ? AutoApprovalMode.AUTO_EDIT
    : config.approvalMode || AutoApprovalMode.SUGGEST;

preloadModels(config);

const instance = render(
  <App
    prompt={prompt} // prompt can be undefined here if it's a rollout view
    config={config}
    rollout={rollout}
    imagePaths={imagePaths}
    approvalPolicy={approvalPolicy}
    fullStdout={fullStdout}
    cliGithubRepo={cliGithubRepo}
    cliGithubBranch={cliGithubBranch}
  />,
  {
    patchConsole: process.env["DEBUG"] ? false : true,
  },
);
setInkRenderer(instance);

function formatChatCompletionMessageParamForQuietMode(
  item: ChatCompletionMessageParam,
): string {
  if (!PRETTY_PRINT) {
    return JSON.stringify(item);
  }
  const parts: Array<string> = [];
  const content =
    typeof item.content === "string"
      ? item.content
      : Array.isArray(item.content)
      ? item.content
          .map((c) => {
            if (c.type === "text") {
              return c.text;
            }
            if (c.type === "image_url") {
              return "<Image>";
            }
            if (c.type === "file") {
              return "File";
            }
            if (c.type === "refusal") {
              return c.refusal;
            }
            return "?";
          })
          .join(" ")
      : "";

  if (content) {
    if (item.role === "tool" && !("tool_calls" in item)) {
      const prefix: Array<string> = [];
      const { output, metadata } = parseToolCallOutput(content);
      if (typeof metadata?.exit_code === "number") {
        prefix.push(`code: ${metadata.exit_code}`);
      }
      if (typeof metadata?.duration_seconds === "number") {
        prefix.push(`duration: ${metadata.duration_seconds}s`);
      }
      parts.push(
        `command.stdout${
          prefix.length > 0 ? ` (${prefix.join(", ")})` : ""
        }\n${output}`,
      );
    } else {
      parts.push(`${item.role}: ${content}`);
    }
  }
  if ("tool_calls" in item && item.tool_calls) {
    for (const toolCall of item.tool_calls) {
      const details = parseToolCallChatCompletion(toolCall);
      if (details) {
        parts.push(`$ ${details.cmdReadableText}`);
      } else {
        parts.push(`$ ${toolCall.function.name}`);
      }
    }
  }
  if (parts.length > 0) {
    return parts.join("\n");
  }
  return JSON.stringify(item);
}

async function runQuietMode({
  prompt,
  imagePaths,
  approvalPolicy,
  config,
}: {
  prompt: string;
  imagePaths: Array<string>;
  approvalPolicy: ApprovalPolicy;
  config: AppConfig;
}): Promise<void> {
  const agent = new AgentLoop({
    model: config.model,
    config: config,
    instructions: config.instructions,
    approvalPolicy,
    onItem: (item: ChatCompletionMessageParam) => {
      // eslint-disable-next-line no-console
      console.log(formatChatCompletionMessageParamForQuietMode(item));
    },
    onLoading: () => {
      /* intentionally ignored in quiet mode */
    },
    getCommandConfirmation: (
      _command: Array<string>,
    ): Promise<CommandConfirmation> => {
      // In quiet mode, default to NO_CONTINUE, except when in full-auto mode
      const reviewDecision =
        approvalPolicy === AutoApprovalMode.FULL_AUTO
          ? ReviewDecision.YES
          : ReviewDecision.NO_CONTINUE;
      return Promise.resolve({ review: reviewDecision });
    },
    onReset: () => {
      /* intentionally ignored in quiet mode */
    },
    mcpServers: config.mcpServers, // Added MCP servers
  });

  const inputItem = await createInputItem(prompt, imagePaths);
  await agent.run([inputItem]);
}

const exit = () => {
  onExit();
  process.exit(0);
};

process.on("SIGINT", exit);
process.on("SIGQUIT", exit);
process.on("SIGTERM", exit);

// ---------------------------------------------------------------------------
// Fallback for Ctrl‑C when stdin is in raw‑mode
// ---------------------------------------------------------------------------

if (process.stdin.isTTY) {
  // Ensure we do not leave the terminal in raw mode if the user presses
  // Ctrl‑C while some other component has focus and Ink is intercepting
  // input. Node does *not* emit a SIGINT in raw‑mode, so we listen for the
  // corresponding byte (0x03) ourselves and trigger a graceful shutdown.
  const onRawData = (data: Buffer | string): void => {
    const str = Buffer.isBuffer(data) ? data.toString("utf8") : data;
    if (str === "\u0003") {
      exit();
    }
  };
  process.stdin.on("data", onRawData);
}

// Ensure terminal clean‑up always runs, even when other code calls
// `process.exit()` directly.
process.once("exit", onExit);
