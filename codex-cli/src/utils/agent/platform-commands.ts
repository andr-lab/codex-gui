/**
 * Utility functions for handling platform-specific commands
 */

import { log, isLoggingEnabled } from "./log.js";

/**
 * Map of Unix commands to their Windows equivalents
 */
const COMMAND_MAP: Record<string, string> = {
  ls: "dir",
  grep: "findstr",
  cat: "type",
  rm: "del",
  cp: "copy",
  mv: "move",
  touch: "echo.>",
  mkdir: "md",
};

/**
 * Map of common Unix command options to their Windows equivalents
 */
const OPTION_MAP: Record<string, Record<string, string>> = {
  ls: {
    "-l": "/p",
    "-a": "/a",
    "-R": "/s",
  },
  grep: {
    "-i": "/i",
    "-r": "/s",
  },
};

/**
 * Adapts a command for the current platform.
 * On Windows, this will translate Unix commands to their Windows equivalents.
 * On Unix-like systems, this will return the original command.
 *
 * @param command The command array to adapt
 * @returns An object containing the adapted command array and a boolean indicating if a shell is needed
 */
export function adaptCommandForPlatform(command: Array<string>): { adaptedCommand: string[], needsShell: boolean } {
  // If not on Windows, return the original command
  if (process.platform !== "win32") {
    return { adaptedCommand: command, needsShell: false };
  }

  // Nothing to adapt if the command is empty
  if (command.length === 0) {
    return { adaptedCommand: command, needsShell: false };
  }

  const originalCmd = command[0];
  let needsShellForAdaptedCmd = false;

  // If cmd is undefined or the command doesn't need adaptation, return it as is
  if (!originalCmd || !COMMAND_MAP[originalCmd]) {
    return { adaptedCommand: command, needsShell: false };
  }

  if (isLoggingEnabled()) {
    log(`Adapting command '${originalCmd}' for Windows platform`);
  }

  // Create a new command array with the adapted command
  const adaptedCommand = [...command];
  adaptedCommand[0] = COMMAND_MAP[originalCmd];

  // Logic for built-ins and special handling for 'touch'
  // This block is already within the (process.platform === 'win32') check from the top of the function.
  const windowsShellBuiltins = new Set(['dir', 'type', 'del', 'copy', 'move', 'md', 'rd', 'cd', 'cls']);

  if (originalCmd === 'touch' && adaptedCommand[0] === 'echo.>') {
      needsShellForAdaptedCmd = true;
      if (adaptedCommand.length > 1) {
          // Join arguments for 'echo.>' command, assuming the arguments form the filename
          adaptedCommand[0] = `echo.>${adaptedCommand.slice(1).join(" ")}`;
          adaptedCommand.splice(1); 
      } else {
          // 'touch' without arguments might map to 'echo.>' which is not a valid standalone command.
          // This case is left as is, expecting 'touch' to usually have a filename.
      }
  } else if (windowsShellBuiltins.has(adaptedCommand[0])) {
      needsShellForAdaptedCmd = true;
  }

  // Adapt options if needed
  const optionsForCmd = OPTION_MAP[originalCmd];
  if (optionsForCmd) {
    for (let i = 1; i < adaptedCommand.length; i++) {
      const option = adaptedCommand[i];
      if (option && optionsForCmd[option]) {
        adaptedCommand[i] = optionsForCmd[option];
      }
    }
  }

  if (isLoggingEnabled()) {
    log(`Adapted command: ${adaptedCommand.join(" ")}, needsShell: ${needsShellForAdaptedCmd}`);
  }

  return { adaptedCommand, needsShell: needsShellForAdaptedCmd };
}
