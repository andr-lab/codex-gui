import type { ExecInput, ExecResult } from "./sandbox/interface.js";
import type { SpawnOptions } from "child_process";
import type { ParseEntry } from "shell-quote";

import { process_patch } from "./apply-patch.ts";
import { SandboxType } from "./sandbox/interface.js";
import { execWithSeatbelt } from "./sandbox/macos-seatbelt.js";
import { exec as rawExec } from "./sandbox/raw-exec.js";
import { adaptCommandForPlatform } from "./platform-commands.js"; // Add this import
import { formatCommandForDisplay } from "../../format-command.js";
import fs from "fs";
import os from "os";
import path from 'node:path';
import { parse } from "shell-quote";

const DEFAULT_TIMEOUT_MS = 10_000; // 10 seconds

function requiresShell(cmd: Array<string>): boolean {
  // If the command is a single string that contains shell operators,
  // it needs to be run with shell: true
  if (cmd.length === 1 && cmd[0] !== undefined) {
    const tokens = parse(cmd[0]) as Array<ParseEntry>;
    return tokens.some((token) => typeof token === "object" && "op" in token);
  }

  // If the command is split into multiple arguments, we don't need shell: true
  // even if one of the arguments is a shell operator like '|'
  return false;
}

/**
 * This function should never return a rejected promise: errors should be
 * mapped to a non-zero exit code and the error message should be in stderr.
 */
export function exec(
  { cmd: originalCommand, workdir, timeoutInMillis }: ExecInput,
  sandbox: SandboxType,
  abortSignal?: AbortSignal,
): Promise<ExecResult> {
  const { adaptedCommand, needsShell: adaptedCommandNeedsShell } = adaptCommandForPlatform(originalCommand);

  const execForSandbox =
    sandbox === SandboxType.MACOS_SEATBELT ? execWithSeatbelt : rawExec;

  // Determine if shell is needed based on original command structure OR if adapted command requires it
  const useShell = requiresShell(originalCommand) || adaptedCommandNeedsShell;

  const opts: SpawnOptions = {
    timeout: timeoutInMillis || DEFAULT_TIMEOUT_MS,
    ...(useShell ? { shell: true } : {}),
    ...(workdir ? { cwd: workdir } : {}),
  };
  const writableRoots = [process.cwd(), os.tmpdir()];
  // Pass the adaptedCommand to the execution function
  return execForSandbox(adaptedCommand, opts, writableRoots, abortSignal);
}

export function execApplyPatch(patchText: string, cwd: string): ExecResult {
  // This is a temporary measure to understand what are the common base commands
  // until we start persisting and uploading rollouts

  try {
    // process_patch will now need to handle paths relative to cwd
    const result = process_patch(
      patchText,
      (p) => fs.readFileSync(path.resolve(cwd, p), "utf8"),
      (p, c) => fs.writeFileSync(path.resolve(cwd, p), c, "utf8"),
      (p) => fs.unlinkSync(path.resolve(cwd, p)),
      // cwd parameter removed from process_patch call as it's not used by process_patch
      // when file operation functions are already CWD-aware.
    );
    return {
      stdout: result,
      stderr: "",
      exitCode: 0,
    };
  } catch (error: unknown) {
    // @ts-expect-error error might not be an object or have a message property.
    const stderr = String(error.message ?? error);
    return {
      stdout: "",
      stderr: stderr,
      exitCode: 1,
    };
  }
}

export function getBaseCmd(cmd: Array<string>): string {
  const formattedCommand = formatCommandForDisplay(cmd);
  return formattedCommand.split(" ")[0] || cmd[0] || "<unknown>";
}