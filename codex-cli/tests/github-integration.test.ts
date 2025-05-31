import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import meow from 'meow'; // To mock its behavior
import { authenticateWithGitHubDeviceFlow } from '../src/utils/github-auth';
import { loadConfig, saveConfig } from '../src/utils/config';

// Mock standard cli.tsx dependencies
vi.mock('../src/utils/agent/log', () => ({
  initLogger: vi.fn(),
}));
vi.mock('../src/utils/check-updates', () => ({
  checkForUpdates: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/utils/model-utils', () => ({
  preloadModels: vi.fn(),
}));
vi.mock('../src/cli-singlepass', () => ({
  runSinglePass: vi.fn(),
}));
vi.mock('../src/app', () => ({ // Mock App component
  default: () => 'MockedApp',
}));
vi.mock('ink', () => ({ // Mock ink itself
  render: vi.fn(),
  Box: () => 'Box',
  Text: () => 'Text',
}));
vi.mock('../src/utils/terminal', () => ({
    onExit: vi.fn(),
    setInkRenderer: vi.fn(),
}));


import { AgentLoop } from '../src/utils/agent/agent-loop'; // For mocking
import * as cliModule from '../src/cli'; // To spy on runQuietMode

// Mock specific dependencies for the auth command
vi.mock('../src/utils/github-auth', async () => {
    const actual = await vi.importActual('../src/utils/github-auth') as any;
    return {
        ...actual,
        authenticateWithGitHubDeviceFlow: vi.fn(),
        // Mock other functions if they are called during App initialization with GitHub flags
        isGitHubAuthenticated: vi.fn().mockReturnValue(true), // Assume authenticated for repo/branch tests
        fetchGitHubRepositories: vi.fn().mockResolvedValue([]),
        getGitHubAccessToken: vi.fn().mockReturnValue('dummy-token'),
    };
});

vi.mock('../src/utils/config', async () => {
    const actual = await vi.importActual('../src/utils/config') as any;
    return {
        ...actual,
        loadConfig: vi.fn(), // Will be configured per test suite or test
        saveConfig: vi.fn(),
    };
});

// Mock AgentLoop
vi.mock('../src/utils/agent/agent-loop');


// Mock App component to capture props
const mockAppPropsStore: { current?: any } = {};
vi.mock('../src/app', () => ({
  default: (props: any) => {
    mockAppPropsStore.current = props;
    return 'MockedApp';
  },
}));


// Mock meow
vi.mock('meow', async () => {
  // This mock will be configurable per test via mockReturnValueOnce
  const meowMock = vi.fn().mockImplementation((_helpText: any, _options: any) => ({
    input: [],
    flags: {}, // Default flags
    showHelp: vi.fn(),
    pkg: {},
  }));
  return { default: meowMock };
});


describe('CLI GitHub Auth Command (codex auth github)', () => {
  let mockProcessExit: vi.SpyInstance;
  let mockConsoleLog: vi.SpyInstance;
  let mockConsoleError: vi.SpyInstance;

  beforeEach(() => {
    vi.resetModules(); // Reset modules for dynamic import of cli.tsx

    mockProcessExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Reset mocks for specific functions and meow
    (meow as unknown as vi.Mock).mockClear();
    (authenticateWithGitHubDeviceFlow as vi.Mock).mockClear();
    (loadConfig as vi.Mock).mockClear().mockReturnValue({ provider: 'openai', model: 'default-model', apiKey: 'dummy-key', githubSelectedRepo: null, githubSelectedBranch: null });
    (saveConfig as vi.Mock).mockClear();
    
    // Clear App props store
    delete mockAppPropsStore.current;
  });

  afterEach(() => {
    mockProcessExit.mockRestore();
    mockConsoleLog.mockRestore();
    mockConsoleError.mockRestore();
    vi.clearAllMocks();
  });

  it('Successful Authentication', async () => {
    (meow as unknown as vi.Mock).mockReturnValueOnce({
      input: ['auth', 'github'],
      flags: {},
      showHelp: vi.fn(), // meow instance needs showHelp
      pkg: {}, // meow instance needs pkg
    });
    (authenticateWithGitHubDeviceFlow as vi.Mock).mockResolvedValueOnce(undefined);

    await import('../src/cli'); // Dynamically import to run the script's logic

    expect(authenticateWithGitHubDeviceFlow).toHaveBeenCalledTimes(1);
    expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining("✅ Successfully authenticated with GitHub!"));
    expect(mockProcessExit).toHaveBeenCalledWith(0);
  });

  it('Failed Authentication', async () => {
    const authError = new Error("Test Auth Error");
    (meow as unknown as vi.Mock).mockReturnValueOnce({
      input: ['auth', 'github'],
      flags: {},
      showHelp: vi.fn(),
      pkg: {},
    });
    (authenticateWithGitHubDeviceFlow as vi.Mock).mockRejectedValueOnce(authError);

    await import('../src/cli');

    expect(authenticateWithGitHubDeviceFlow).toHaveBeenCalledTimes(1);
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining("❌ GitHub authentication failed: Test Auth Error"));
    expect(mockProcessExit).toHaveBeenCalledWith(1);
  });
});

describe('CLI GitHub Repo/Branch Arguments', () => {
  let mockProcessExit: vi.SpyInstance;
  let mockConsoleError: vi.SpyInstance;
  let runQuietModeSpy: vi.SpyInstance;

  beforeEach(() => {
    vi.resetModules(); // Reset modules for dynamic import of cli.tsx

    mockProcessExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    
    // Spy on runQuietMode from the actual cliModule
    runQuietModeSpy = vi.spyOn(cliModule, 'runQuietMode').mockImplementation(async () => {});


    (meow as unknown as vi.Mock).mockClear();
    (AgentLoop as unknown as vi.Mock).mockClear();
    (loadConfig as vi.Mock).mockClear().mockReturnValue({ // Default config for these tests
      provider: 'openai',
      model: 'default-model',
      apiKey: 'dummy-key',
      instructions: 'Default instructions',
      githubSelectedRepo: null,
      githubSelectedBranch: null,
    });
    
    // Clear App props store
    delete mockAppPropsStore.current;
  });

  afterEach(() => {
    mockProcessExit.mockRestore();
    mockConsoleError.mockRestore();
    runQuietModeSpy.mockRestore(); // Restore the spy
    vi.clearAllMocks();
  });

  it('Interactive: --github-repo and --github-branch provided', async () => {
    (meow as unknown as vi.Mock).mockReturnValueOnce({
      input: ['a prompt'],
      flags: { githubRepo: 'owner/repo', githubBranch: 'feature' },
      showHelp: vi.fn(),
      pkg: {},
    });

    await import('../src/cli');

    expect(mockAppPropsStore.current).toBeDefined();
    expect(mockAppPropsStore.current.cliGithubRepo).toBe('owner/repo');
    expect(mockAppPropsStore.current.cliGithubBranch).toBe('feature');
    // Also check that these are part of the config passed to App
    expect(mockAppPropsStore.current.config.githubSelectedRepo).toBe('owner/repo');
    expect(mockAppPropsStore.current.config.githubSelectedBranch).toBe('feature');
  });

  it('Interactive: --github-repo only provided', async () => {
    (meow as unknown as vi.Mock).mockReturnValueOnce({
      input: ['a prompt'],
      flags: { githubRepo: 'owner/repo' }, // githubBranch is undefined
      showHelp: vi.fn(),
      pkg: {},
    });

    await import('../src/cli');

    expect(mockAppPropsStore.current).toBeDefined();
    expect(mockAppPropsStore.current.cliGithubRepo).toBe('owner/repo');
    expect(mockAppPropsStore.current.cliGithubBranch).toBeUndefined();
    expect(mockAppPropsStore.current.config.githubSelectedRepo).toBe('owner/repo');
    expect(mockAppPropsStore.current.config.githubSelectedBranch).toBeUndefined(); // Or it might be the default branch from App.tsx logic
  });

  it('Interactive: Flags override config file values', async () => {
    // Configure loadConfig to return existing GitHub settings
    (loadConfig as vi.Mock).mockReturnValueOnce({
      provider: 'openai',
      model: 'default-model',
      apiKey: 'dummy-key',
      instructions: 'Default instructions',
      githubSelectedRepo: 'config/repo',
      githubSelectedBranch: 'config-branch',
    });

    (meow as unknown as vi.Mock).mockReturnValueOnce({
      input: ['a prompt'],
      flags: { githubRepo: 'cli/repo', githubBranch: 'cli-branch' },
      showHelp: vi.fn(),
      pkg: {},
    });

    await import('../src/cli');

    expect(mockAppPropsStore.current).toBeDefined();
    expect(mockAppPropsStore.current.cliGithubRepo).toBe('cli/repo');
    expect(mockAppPropsStore.current.cliGithubBranch).toBe('cli-branch');
    // Verify the config object passed to App also reflects the CLI override
    expect(mockAppPropsStore.current.config.githubSelectedRepo).toBe('cli/repo');
    expect(mockAppPropsStore.current.config.githubSelectedBranch).toBe('cli-branch');
  });

  it('Quiet Mode: --github-repo and --github-branch provided', async () => {
    runQuietModeSpy.mockRestore(); // Use actual implementation for this test
    const actualCliModule = await import('../src/cli');
    runQuietModeSpy = vi.spyOn(actualCliModule, 'runQuietMode');


    (meow as unknown as vi.Mock).mockReturnValueOnce({
      input: ['a prompt'],
      flags: { quiet: true, githubRepo: 'owner/repo', githubBranch: 'feature' },
      showHelp: vi.fn(),
      pkg: {},
    });
    
    // Mock AgentLoop to capture its constructor arguments
    const mockAgentLoopInstance = { run: vi.fn(), on: vi.fn(), terminate: vi.fn() };
    (AgentLoop as unknown as vi.Mock).mockImplementation(() => mockAgentLoopInstance);

    await import('../src/cli'); // This will trigger runQuietMode via the flag

    expect(runQuietModeSpy).toHaveBeenCalled();
    
    // Check the config passed to AgentLoop within runQuietMode
    // runQuietMode calls loadConfig, which we've mocked.
    // The key is that cli.tsx itself should pass the CLI args to loadConfig
    // or merge them into the config for runQuietMode.
    // Let's check what config AgentLoop was called with.
    // The `loadConfig` mock in `cli.tsx` is called with provider and other flags.
    // `cli.tsx` then merges `githubRepo` and `githubBranch` into this config.

    // The actual `runQuietMode` is called with a config object.
    // We need to ensure this config object, when passed to AgentLoop, has the correct GitHub details.
    const runQuietModeCallArgs = runQuietModeSpy.mock.calls[0][0]; // Get the first argument of the first call
    expect(runQuietModeCallArgs.config.githubSelectedRepo).toBe('owner/repo');
    expect(runQuietModeCallArgs.config.githubSelectedBranch).toBe('feature');

    // And verify AgentLoop constructor receives this specific config from runQuietMode
    expect(AgentLoop).toHaveBeenCalledWith(expect.objectContaining({
        config: expect.objectContaining({
            githubSelectedRepo: 'owner/repo',
            githubSelectedBranch: 'feature',
        }),
    }));
  });

  it('Error: --github-branch without --github-repo', async () => {
    (meow as unknown as vi.Mock).mockReturnValueOnce({
      input: ['a prompt'],
      flags: { githubBranch: 'feature' }, // No githubRepo
      showHelp: vi.fn(),
      pkg: {},
    });

    await import('../src/cli');

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Error: --github-branch cannot be used without --github-repo.")
    );
    expect(mockProcessExit).toHaveBeenCalledWith(1);
  });

  it('Error: Invalid --github-repo format', async () => {
    (meow as unknown as vi.Mock).mockReturnValueOnce({
      input: ['a prompt'],
      flags: { githubRepo: 'invalid-format' }, // Invalid format
      showHelp: vi.fn(),
      pkg: {},
    });

    await import('../src/cli');

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Error: Invalid --github-repo format. Expected 'owner/repo'.")
    );
    expect(mockProcessExit).toHaveBeenCalledWith(1);
  });
});
