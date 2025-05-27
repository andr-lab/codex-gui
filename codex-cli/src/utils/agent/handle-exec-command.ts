import type { CommandConfirmation } from "./agent-loop.js";
import type { AppConfig } from "../config.js";
import type { ExecInput } from "./sandbox/interface.js";
import type { ApplyPatchCommand, ApprovalPolicy } from "../../approvals.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.mjs";

import { exec, execApplyPatch } from "./exec.ts";
import {
  identify_files_added,
  identify_files_needed,
} from "./apply-patch.js";
import { isLoggingEnabled, log } from "./log.js";
import { ReviewDecision } from "./review.js";
import { FullAutoErrorMode } from "../auto-approval-mode.js";
import { SandboxType } from "./sandbox/interface.js";
import { canAutoApprove } from "../../approvals.js";
import { formatCommandForDisplay } from "../../format-command.js";
import { access } from "fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Session‑level cache of commands that the user has chosen to always approve.
//
// The values are derived via `deriveCommandKey()` which intentionally ignores
// volatile arguments (for example the patch text passed to `apply_patch`).
// Storing *generalised* keys means that once a user selects "always approve"
// for a given class of command we will genuinely stop prompting them for
// subsequent, equivalent invocations during the same CLI session.
// ---------------------------------------------------------------------------
const alwaysApprovedCommands = new Set<string>();

// ---------------------------------------------------------------------------
// Helper: Given the argv-style representation of a command, return a stable
// string key that can be used for equality checks.
//
// The key space purposefully abstracts away parts of the command line that
// are expected to change between invocations while still retaining enough
// information to differentiate *meaningfully distinct* operations.  See the
// extensive inline documentation for details.
// ---------------------------------------------------------------------------

function deriveCommandKey(cmd: Array<string>): string {
  // pull off only the bits you care about
  const [
    maybeShell,
    maybeFlag,
    coreInvocation,
    /* …ignore the rest… */
  ] = cmd;

  if (coreInvocation?.startsWith("apply_patch")) {
    return "apply_patch";
  }

  if (maybeShell === "bash" && maybeFlag === "-lc") {
    // If the command was invoked through `bash -lc "<script>"` we extract the
    // base program name from the script string.
    const script = coreInvocation ?? "";
    return script.split(/\s+/)[0] || "bash";
  }

  // For every other command we fall back to using only the program name (the
  // first argv element).  This guarantees we always return a *string* even if
  // `coreInvocation` is undefined.
  if (coreInvocation) {
    return coreInvocation.split(/\s+/)[0]!;
  }

  return JSON.stringify(cmd);
}

type HandleExecCommandResult = {
  outputText: string;
  metadata: Record<string, unknown>;
  additionalItems?: Array<ChatCompletionMessageParam>;
};

export async function handleExecCommand(
  args: ExecInput,
  config: AppConfig,
  policy: ApprovalPolicy,
  getCommandConfirmation: (
    command: Array<string>,
    applyPatch: ApplyPatchCommand | undefined,
  ) => Promise<CommandConfirmation>,
  abortSignal?: AbortSignal,
  effectiveCwd?: string, // New parameter
): Promise<HandleExecCommandResult> {
  const { cmd: command } = args;

  const key = deriveCommandKey(command);

  // 1) If the user has already said "always approve", skip
  //    any policy & never sandbox.
  if (alwaysApprovedCommands.has(key)) {
    return execCommand(
      args,
      /* applyPatch */ undefined,
      /* runInSandbox */ false,
      abortSignal,
      effectiveCwd,
    ).then(convertSummaryToResult);
  }

  // 2) Otherwise fall back to the normal policy
  // `canAutoApprove` now requires the list of writable roots that the command
  // is allowed to modify.
  // If an effectiveCwd (cloned repo) is active, that should be the writable root.
  // Otherwise, fallback to the original process.cwd().
  const writableRoot = effectiveCwd || process.cwd();
  const safety = canAutoApprove(command, policy, [writableRoot]);

  let runInSandbox: boolean;
  switch (safety.type) {
    case "ask-user": {
      const review = await askUserPermission(
        args,
        safety.applyPatch,
        getCommandConfirmation,
      );
      if (review != null) {
        return review;
      }

      runInSandbox = false;
      break;
    }
    case "auto-approve": {
      runInSandbox = safety.runInSandbox;
      break;
    }
    case "reject": {
      return {
        outputText: "aborted",
        metadata: {
          error: "command rejected",
          reason: "Command rejected by auto-approval system.",
        },
      };
    }
  }

  const { applyPatch } = safety;
  const summary = await execCommand(
    args,
    applyPatch,
    runInSandbox,
    abortSignal,
      effectiveCwd,
  );
  // If the operation was aborted in the meantime, propagate the cancellation
  // upward by returning an empty (no‑op) result so that the agent loop will
  // exit cleanly without emitting spurious output.
  if (abortSignal?.aborted) {
    return {
      outputText: "",
      metadata: {},
    };
  }
  if (
    summary.exitCode !== 0 &&
    runInSandbox &&
    // Default: If the user has configured to ignore and continue,
    // skip re-running the command.
    //
    // Otherwise, if they selected "ask-user", then we should ask the user
    // for permission to re-run the command outside of the sandbox.
    config.fullAutoErrorMode &&
    config.fullAutoErrorMode === FullAutoErrorMode.ASK_USER
  ) {
    const review = await askUserPermission(
      args,
      safety.applyPatch,
      getCommandConfirmation,
    );
    if (review != null) {
      return review;
    } else {
      // The user has approved the command, so we will run it outside of the
      // sandbox.
      const summary = await execCommand(args, applyPatch, false, abortSignal, effectiveCwd);
      return convertSummaryToResult(summary);
    }
  } else {
    return convertSummaryToResult(summary);
  }
}

function convertSummaryToResult(
  summary: ExecCommandSummary,
): HandleExecCommandResult {
  const { stdout, stderr, exitCode, durationMs } = summary;
  return {
    outputText: stdout || stderr,
    metadata: {
      exit_code: exitCode,
      duration_seconds: Math.round(durationMs / 100) / 10,
    },
  };
}

type ExecCommandSummary = {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
};

async function execCommand(
  execInput: ExecInput,
  applyPatchCommand: ApplyPatchCommand | undefined,
  runInSandbox: boolean,
  abortSignal?: AbortSignal,
  effectiveCwd?: string,
): Promise<ExecCommandSummary> {
  let { workdir } = execInput; // workdir from the LLM's command

  // Determine the actual CWD for the command
  // If effectiveCwd (cloned repo path) is set, it takes precedence.
  // If workdir is also provided by LLM, it should be relative to effectiveCwd.
  const actualCwd = effectiveCwd 
    ? (workdir ? path.resolve(effectiveCwd, workdir) : effectiveCwd)
    : (workdir || process.cwd());

  // Validate the actualCwd exists, otherwise default to process.cwd() or effectiveCwd if that fails
  try {
    await access(actualCwd);
  } catch (e) {
    log(`EXEC actualCwd=${actualCwd} not found, defaulting to process.cwd() or effectiveCwd if set.`);
    // Fallback logic: if actualCwd derived from effectiveCwd fails, maybe just use effectiveCwd or process.cwd()
    // For simplicity, if the resolved path doesn't exist, this might indicate an issue.
    // However, commands like 'mkdir' might expect workdir to not exist yet.
    // For now, let's trust 'actualCwd' but be mindful of this.
    // A safer bet if access fails might be to fallback to 'effectiveCwd' if set, else 'process.cwd()'
    // For now, we let 'exec' handle potential errors from a bad CWD.
  }
  
  // Update execInput.workdir to be the fully resolved path for clarity if needed by `exec`
  // or ensure `exec` uses `actualCwd` directly.
  const execInputForExec = { ...execInput, workdir: actualCwd };

  if (isLoggingEnabled()) {
    if (applyPatchCommand != null) {
      log("EXEC running apply_patch command");
    } else {
      const { cmd, timeoutInMillis } = execInputForExec; // Use updated execInput
      // Seconds are a bit easier to read in log messages and most timeouts
      // are specified as multiples of 1000, anyway.
      const timeout =
        timeoutInMillis != null
          ? Math.round(timeoutInMillis / 1000).toString()
          : "undefined";
      log(
        `EXEC running \`${formatCommandForDisplay(
          cmd,
        )}\` in workdir=${actualCwd} with timeout=${timeout}s`, // Log actualCwd
      );
    }
  }

  // Note execApplyPatch() and exec() are coded defensively and should not
  // throw. Any internal errors should be mapped to a non-zero value for the
  // exitCode field.
  const start = Date.now();
  const execResult =
    applyPatchCommand != null
      ? execApplyPatch(applyPatchCommand.patch, actualCwd) // Pass actualCwd to execApplyPatch
      : await exec(execInputForExec, await getSandbox(runInSandbox), abortSignal); // Pass updated execInput
  const duration = Date.now() - start;
  let { stdout, stderr, exitCode } = execResult;

  if (applyPatchCommand != null && exitCode === 0) {
    const patch = applyPatchCommand.patch;
    // These functions identify files based on patch content, paths are relative to repo root
    const filesNeeded = identify_files_needed(patch); 
    const filesAdded = identify_files_added(patch);
    const updatedFiles = patch
      .split("\n")
      .filter((line) => line.startsWith("*** Update File: "))
      .map((line) => line.replace("*** Update File: ", "").trim());

    const allAffectedFiles = Array.from(
      new Set([...filesNeeded, ...filesAdded, ...updatedFiles]),
    );

    if (allAffectedFiles.length > 0) {
      if (allAffectedFiles.length === 1) {
        stdout = `Patch successfully applied to '${allAffectedFiles[0]}'. The file content has changed. If you need to perform further operations on this file, please re-read it to ensure you have the latest version.`;
      } else {
        stdout = `Patch successfully applied. The following files have changed: [${allAffectedFiles.join(", ")}]. Please re-read them if you need to perform further operations.`;
      }
    } else {
      // This case should ideally not happen if a patch was applied successfully
      // and indicated changes, but as a fallback:
      stdout =
        "Patch successfully applied. Please re-read any affected files if necessary.";
    }
  }

  if (isLoggingEnabled()) {
    log(
      `EXEC exit=${exitCode} time=${duration}ms:\n\tSTDOUT: ${stdout}\n\tSTDERR: ${stderr}`,
    );
  }

  return {
    stdout,
    stderr,
    exitCode,
    durationMs: duration,
  };
}

const isInLinux = async (): Promise<boolean> => {
  try {
    await access("/proc/1/cgroup");
    return true;
  } catch {
    return false;
  }
};

async function getSandbox(runInSandbox: boolean): Promise<SandboxType> {
  if (runInSandbox) {
    if (process.platform === "darwin") {
      return SandboxType.MACOS_SEATBELT;
    } else if (await isInLinux()) {
      return SandboxType.NONE;
    } else if (process.platform === "win32") {
      // On Windows, we don't have a sandbox implementation yet, so we fall back to NONE
      // instead of throwing an error, which would crash the application
      log(
        "WARNING: Sandbox was requested but is not available on Windows. Continuing without sandbox.",
      );
      return SandboxType.NONE;
    }
    // For other platforms, still throw an error as before
    throw new Error("Sandbox was mandated, but no sandbox is available!");
  } else {
    return SandboxType.NONE;
  }
}

/**
 * If return value is non-null, then the command was rejected by the user.
 */
async function askUserPermission(
  args: ExecInput,
  applyPatchCommand: ApplyPatchCommand | undefined,
  getCommandConfirmation: (
    command: Array<string>,
    applyPatch: ApplyPatchCommand | undefined,
  ) => Promise<CommandConfirmation>,
): Promise<HandleExecCommandResult | null> {
  const { review: decision, customDenyMessage } = await getCommandConfirmation(
    args.cmd,
    applyPatchCommand,
  );

  if (decision === ReviewDecision.ALWAYS) {
    // Persist this command so we won't ask again during this session.
    const key = deriveCommandKey(args.cmd);
    alwaysApprovedCommands.add(key);
  }

  // Any decision other than an affirmative (YES / ALWAYS) aborts execution.
  if (decision !== ReviewDecision.YES && decision !== ReviewDecision.ALWAYS) {
    const note =
      decision === ReviewDecision.NO_CONTINUE
        ? customDenyMessage?.trim() || "No, don't do that — keep going though."
        : "No, don't do that — stop for now.";
    return {
      outputText: "aborted",
      metadata: {},
      additionalItems: [
        {
          role: "user",
          content: [{ type: "text", text: note }],
        },
      ],
    };
  } else {
    return null;
  }
}
