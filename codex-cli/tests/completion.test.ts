import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import meow from 'meow'; // Import meow to mock its behavior

// Mock dependencies from cli.tsx that are not relevant to completion logic
vi.mock('../src/utils/agent/log', () => ({
  initLogger: vi.fn(),
}));
vi.mock('../src/utils/check-updates', () => ({
  checkForUpdates: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/utils/config', () => ({
  loadConfig: vi.fn().mockReturnValue({
    provider: 'openai',
    model: 'default-model',
    apiKey: 'dummy-key',
  }), // Provide a minimal mock config
  PRETTY_PRINT: true,
  INSTRUCTIONS_FILEPATH: 'dummy/path/instructions.md',
}));
vi.mock('../src/utils/github-auth', () => ({
  authenticateWithGitHubDeviceFlow: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/utils/model-utils', () => ({
  preloadModels: vi.fn(),
}));
vi.mock('../src/cli-singlepass', () => ({
  runSinglePass: vi.fn(),
}));
vi.mock('../src/app', () => ({
  default: () => 'MockedApp', // Mock the App component
}));
vi.mock('ink', () => ({
  render: vi.fn(), // Mock ink's render
  Box: () => 'Box', // Mock ink components if cli.tsx tries to render them outside of App
  Text: () => 'Text',
}));
vi.mock('../src/utils/terminal', () => ({
    onExit: vi.fn(),
    setInkRenderer: vi.fn(),
}));


// Mock meow itself
vi.mock('meow', async () => {
  // Create a flexible mock function for meow
  const actualMeow = await vi.importActual('meow') as any;
  const meowMock = vi.fn().mockImplementation((helpText, options) => {
    // Default mock instance, can be overridden per test
    return {
      input: [],
      flags: {},
      showHelp: vi.fn(),
      showVersion: vi.fn(),
      help: helpText,
      ...options,
      pkg: {}, // Add a default pkg property
    };
  });
  return { default: meowMock };
});


describe('CLI Completion Command', () => {
  let mockProcessExit: vi.SpyInstance;
  let mockConsoleLog: vi.SpyInstance;
  let mockConsoleError: vi.SpyInstance;

  beforeEach(() => {
    vi.resetModules(); // Important to reset modules for dynamic import of cli.tsx

    mockProcessExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Ensure the meow mock is reset for each test to allow specific `mockReturnValueOnce`
    (meow as unknown as vi.Mock).mockClear();
  });

  afterEach(() => {
    mockProcessExit.mockRestore();
    mockConsoleLog.mockRestore();
    mockConsoleError.mockRestore();
    vi.clearAllMocks(); // Clear all other mocks
  });

  const BASH_SCRIPT_CONTENT = `# bash completion for codex`; // Partial content
  const ZSH_SCRIPT_CONTENT = `# zsh completion for codex`; // Partial content
  const FISH_SCRIPT_CONTENT = `# fish completion for codex`; // Partial content

  it('should output bash completion script and exit 0', async () => {
    (meow as unknown as vi.Mock).mockReturnValueOnce({
      input: ['completion', 'bash'],
      flags: {},
      showHelp: vi.fn(),
      pkg: {},
    });

    await import('../src/cli'); // Dynamically import to run the script

    expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining(BASH_SCRIPT_CONTENT));
    expect(mockProcessExit).toHaveBeenCalledWith(0);
  });

  it('should output zsh completion script and exit 0', async () => {
    (meow as unknown as vi.Mock).mockReturnValueOnce({
      input: ['completion', 'zsh'],
      flags: {},
      showHelp: vi.fn(),
      pkg: {},
    });

    await import('../src/cli');

    expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining(ZSH_SCRIPT_CONTENT));
    expect(mockProcessExit).toHaveBeenCalledWith(0);
  });

  it('should output fish completion script and exit 0', async () => {
    (meow as unknown as vi.Mock).mockReturnValueOnce({
      input: ['completion', 'fish'],
      flags: {},
      showHelp: vi.fn(),
      pkg: {},
    });

    await import('../src/cli');

    expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining(FISH_SCRIPT_CONTENT));
    expect(mockProcessExit).toHaveBeenCalledWith(0);
  });

  it('should default to bash completion script and exit 0 if no shell specified', async () => {
    (meow as unknown as vi.Mock).mockReturnValueOnce({
      input: ['completion'],
      flags: {},
      showHelp: vi.fn(),
      pkg: {},
    });

    await import('../src/cli');

    expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining(BASH_SCRIPT_CONTENT));
    expect(mockProcessExit).toHaveBeenCalledWith(0);
  });

  it('should output error for unsupported shell and exit 1', async () => {
    const unsupportedShell = 'unknownshell';
    (meow as unknown as vi.Mock).mockReturnValueOnce({
      input: ['completion', unsupportedShell],
      flags: {},
      showHelp: vi.fn(),
      pkg: {},
    });

    await import('../src/cli');

    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining(`Unsupported shell: ${unsupportedShell}`));
    expect(mockProcessExit).toHaveBeenCalledWith(1);
  });
});
