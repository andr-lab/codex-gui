import { adaptCommandForPlatform } from '../src/utils/agent/platform-commands';
import { describe, test, expect, beforeEach, afterEach } from 'vitest';

describe('adaptCommandForPlatform', () => {
  let originalPlatform: NodeJS.Platform;

  beforeEach(() => {
    originalPlatform = process.platform;
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      writable: true,
    });
  });

  describe('Non-Windows environment', () => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', {
        value: 'linux',
        writable: true,
      });
    });

    test('should return original command for "ls -l"', () => {
      const command = ['ls', '-l'];
      const result = adaptCommandForPlatform(command);
      expect(result).toEqual({ adaptedCommand: ['ls', '-l'], needsShell: false });
    });

    test('should return original command for "touch file.txt"', () => {
      const command = ['touch', 'file.txt'];
      const result = adaptCommandForPlatform(command);
      expect(result).toEqual({ adaptedCommand: ['touch', 'file.txt'], needsShell: false });
    });
  });

  describe('Windows environment (win32)', () => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        writable: true,
      });
    });

    describe('Known command, no options', () => {
      test('should adapt "ls" to "dir" and need shell', () => {
        const command = ['ls'];
        const result = adaptCommandForPlatform(command);
        expect(result).toEqual({ adaptedCommand: ['dir'], needsShell: true });
      });

      test('should not adapt "pwd" and not need shell', () => {
        const command = ['pwd'];
        const result = adaptCommandForPlatform(command);
        expect(result).toEqual({ adaptedCommand: ['pwd'], needsShell: false });
      });

      test('should not adapt "clear" and not need shell', () => {
        const command = ['clear'];
        const result = adaptCommandForPlatform(command);
        expect(result).toEqual({ adaptedCommand: ['clear'], needsShell: false });
      });
    });

    describe('Known command with options', () => {
      test('should adapt "ls -R" to "dir /s" and need shell', () => {
        const command = ['ls', '-R'];
        const result = adaptCommandForPlatform(command);
        expect(result).toEqual({ adaptedCommand: ['dir', '/s'], needsShell: true });
      });

      test('should adapt "ls -a -R" to "dir /a /s" and need shell', () => {
        const command = ['ls', '-a', '-R'];
        const result = adaptCommandForPlatform(command);
        expect(result).toEqual({ adaptedCommand: ['dir', '/a', '/s'], needsShell: true });
      });

      test('should adapt "grep -i pattern" to "findstr /i pattern"', () => {
        // findstr is an external program, not a shell built-in, so needsShell should remain false
        const command = ['grep', '-i', 'pattern'];
        const result = adaptCommandForPlatform(command);
        expect(result).toEqual({ adaptedCommand: ['findstr', '/i', 'pattern'], needsShell: false });
      });

      // Adding tests for other built-ins as per task description
      test('should adapt "cat file.txt" to "type file.txt" and need shell', () => {
        const command = ['cat', 'file.txt'];
        const result = adaptCommandForPlatform(command);
        expect(result).toEqual({ adaptedCommand: ['type', 'file.txt'], needsShell: true });
      });

      test('should adapt "rm file.txt" to "del file.txt" and need shell', () => {
        const command = ['rm', 'file.txt'];
        const result = adaptCommandForPlatform(command);
        expect(result).toEqual({ adaptedCommand: ['del', 'file.txt'], needsShell: true });
      });

      test('should adapt "mkdir newdir" to "md newdir" and need shell', () => {
        const command = ['mkdir', 'newdir'];
        const result = adaptCommandForPlatform(command);
        expect(result).toEqual({ adaptedCommand: ['md', 'newdir'], needsShell: true });
      });

      test('should not adapt "rrmdir olddir" and not need shell', () => {
        // Note: COMMAND_MAP used 'rrmdir', this test now reflects its removal from the map
        const command = ['rrmdir', 'olddir'];
        const result = adaptCommandForPlatform(command);
        expect(result).toEqual({ adaptedCommand: ['rrmdir', 'olddir'], needsShell: false });
      });

      test('should adapt "cp source dest" to "copy source dest" and need shell', () => {
        const command = ['cp', 'source', 'dest'];
        const result = adaptCommandForPlatform(command);
        expect(result).toEqual({ adaptedCommand: ['copy', 'source', 'dest'], needsShell: true });
      });

      test('should adapt "mv source dest" to "move source dest" and need shell', () => {
        const command = ['mv', 'source', 'dest'];
        const result = adaptCommandForPlatform(command);
        expect(result).toEqual({ adaptedCommand: ['move', 'source', 'dest'], needsShell: true });
      });
    });

    describe('touch command (special shell handling)', () => {
      test('should adapt "touch newfile.txt" to "echo.>newfile.txt" and need shell', () => {
        const command = ['touch', 'newfile.txt'];
        const result = adaptCommandForPlatform(command);
        expect(result).toEqual({ adaptedCommand: ['echo.>newfile.txt'], needsShell: true });
      });

      test('should adapt "touch another file.txt" to "echo.>another file.txt" and need shell', () => {
        const command = ['touch', 'another file.txt'];
        const result = adaptCommandForPlatform(command);
        expect(result).toEqual({ adaptedCommand: ['echo.>another file.txt'], needsShell: true });
      });
    });

    describe('Unknown command', () => {
      test('should return original command for "unknown_command -arg"', () => {
        const command = ['unknown_command', '-arg'];
        const result = adaptCommandForPlatform(command);
        expect(result).toEqual({ adaptedCommand: ['unknown_command', '-arg'], needsShell: false });
      });
    });

    describe('Empty command', () => {
      test('should return empty command', () => {
        const command: string[] = [];
        const result = adaptCommandForPlatform(command);
        expect(result).toEqual({ adaptedCommand: [], needsShell: false });
      });
    });

    describe('Command that is the same on Windows (not in COMMAND_MAP)', () => {
      test('should return original command for "echo hello"', () => {
        // Assuming 'echo' is not in COMMAND_MAP and behaves the same.
        // If 'echo' were in COMMAND_MAP, this test would need adjustment.
        const command = ['echo', 'hello'];
        const result = adaptCommandForPlatform(command);
        expect(result).toEqual({ adaptedCommand: ['echo', 'hello'], needsShell: false });
      });
    });
  });
});