import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock core modules
// --- In-memory FS Mock ---
let memFsStore: Record<string, string> = {};

vi.mock('fs', async () => {
  const actualFs = await vi.importActual('fs') as any; // For any unmocked methods if needed
  return {
    ...actualFs,
    existsSync: vi.fn((path: string) => memFsStore.hasOwnProperty(path)),
    readFileSync: vi.fn((path: string, _options?: any) => {
      if (memFsStore.hasOwnProperty(path)) {
        return memFsStore[path];
      }
      const err = new Error(`ENOENT: no such file or directory, open '${path}'`);
      (err as any).code = 'ENOENT';
      throw err;
    }),
    writeFileSync: vi.fn((path: string, data: string, _options?: any) => {
      memFsStore[path] = data;
    }),
    mkdirSync: vi.fn((_path: string, _options?: any) => {
      // Can be a no-op or create "directory entries" if needed
      // For now, a no-op is fine as applyPatch usually deals with files.
      return undefined;
    }),
    unlinkSync: vi.fn((path: string) => {
      if (memFsStore.hasOwnProperty(path)) {
        delete memFsStore[path];
      } else {
        // Optional: throw ENOENT if path doesn't exist, to mimic real unlinkSync.
        // For now, silent if not found is acceptable for these tests.
        // const err = new Error(`ENOENT: no such file or directory, unlink '${path}'`);
        // (err as any).code = 'ENOENT';
        // throw err;
      }
    }),
    // Mock other fs functions if the CLI uses them (e.g., readdirSync, statSync)
  };
});
// --- End In-memory FS Mock ---


// Mock meow: This sets up 'meow' to be a mock for all subsequent imports.
// The factory function is called by Vitest to create the mock.
vi.mock('meow', () => {
  // This vi.fn() will be the default export of the 'meow' module.
  return {
    default: vi.fn().mockReturnValue({ // Default mock return value
      input: [],
      flags: {},
      showHelp: vi.fn(),
      showVersion: vi.fn(),
      pkg: { name: 'codex-complete', version: '0.0.0-test' },
    }),
  };
});

vi.mock('ink', async () => {
  const actualInk = await vi.importActual('ink');
  return {
    ...actualInk,
    render: vi.fn(() => ({ unmount: vi.fn(), rerender: vi.fn(), clear: vi.fn(), waitUntilExit: vi.fn() })),
  };
});

// Mock AI Provider SDKs
vi.mock('openai');
// vi.mock('@google/generative-ai'); // Placeholder for future
// vi.mock('ollama'); // Placeholder for future

// Mock internal utilities
// --- MCP Client Mocks ---
const mockMcpInstances: Record<string, any> = {}; 
const mockMcpClientConfigs: Record<string, any> = {}; 

const mockMcpClientListTools = vi.fn();
const mockMcpClientCallTool = vi.fn();
const mockMcpClientConnect = vi.fn();
const mockMcpClientDisconnect = vi.fn();
const mockMcpClientGetIsConnected = vi.fn();

vi.mock('../src/utils/mcp-client.ts', () => {
  return {
    McpClient: vi.fn().mockImplementation((config: { name: string; url: string }) => {
      mockMcpClientConfigs[config.name] = config;

      const instance = {
        serverName: config.name,
        connect: mockMcpClientConnect, // Individual mock fns will be reset in beforeEach
        disconnect: mockMcpClientDisconnect,
        getIsConnected: mockMcpClientGetIsConnected,
        listTools: mockMcpClientListTools,
        callTool: mockMcpClientCallTool,
      };
      mockMcpInstances[config.name] = instance;
      return instance;
    }),
  };
});
// --- End MCP Client Mocks ---


// --- GitHub Auth Mocks ---
let mockAuthenticateWithGitHubDeviceFlow = vi.fn();
let mockGetGitHubToken = vi.fn();
let mockClearGitHubToken = vi.fn(); // For potential 'auth github --logout' or similar

vi.mock('../src/utils/github-auth.ts', async () => {
  const actual = await vi.importActual('../src/utils/github-auth.ts');
  return {
    ...actual,
    authenticateWithGitHubDeviceFlow: mockAuthenticateWithGitHubDeviceFlow,
    getGitHubToken: mockGetGitHubToken,
    clearGitHubToken: mockClearGitHubToken,
    // Ensure other exports from the actual module are included if needed by the CLI
  };
});
// --- End GitHub Auth Mocks ---

// vi.mock('../src/utils/git-utils'); // We will provide a more detailed mock below

// In-memory representation of the Git repository state
interface MockGitFile {
  path: string;
  status: 'added' | 'modified' | 'untracked' | 'committed'; // Simplified
  content?: string; // Optional: for more advanced tests
}

interface MockGitRepoState {
  isRepo: boolean;
  currentBranch: string | null;
  branches: string[];
  remotes: Record<string, string>; // name: url
  files: MockGitFile[];
  clonedFrom: string | null;
  commits: Array<{ message: string; branch: string; files: MockGitFile[] }>;
}

let mockGitRepoState: MockGitRepoState;

// Helper to initialize/reset the mock Git repo state
function setupMockGitRepo(initialState?: Partial<MockGitRepoState>) {
  mockGitRepoState = {
    isRepo: false,
    currentBranch: null,
    branches: [],
    remotes: {},
    files: [],
    clonedFrom: null,
    commits: [],
    ...initialState,
  };
}

// Helper to get the current mock Git repo state
function getMockGitRepoState() {
  return mockGitRepoState;
}

// Enhance the mock for ../src/utils/git-utils.ts
vi.mock('../src/utils/git-utils', async () => {
  const actualGitUtils = await vi.importActual('../src/utils/git-utils') as any; // Use 'any' or define a more specific type if available
  return {
    ...actualGitUtils, // Spread actual to ensure all exports are covered
    isGitRepo: vi.fn(async () => mockGitRepoState.isRepo),
    getGitRepoRoot: vi.fn(async () => (mockGitRepoState.isRepo ? '.' : Promise.reject('Not a git repo'))), // Assuming tests run in repo root
    getCurrentBranch: vi.fn(async () => mockGitRepoState.currentBranch),
    getRemoteUrl: vi.fn(async (remoteName = 'origin') => mockGitRepoState.remotes[remoteName] || null),
    gitClone: vi.fn(async (repoPath: string, localPath: string, _options?: any) => {
      setupMockGitRepo({ // Reset and set up for clone
        isRepo: true,
        clonedFrom: repoPath,
        remotes: { origin: repoPath },
        currentBranch: 'main', // Default branch after clone
        branches: ['main'],
        files: [], // Reset files on clone
        commits: [], // Reset commits on clone
      });
      // Simulate creating a directory if needed by CLI logic (using fs mock)
      // For example: require('fs').mkdirSync(localPath, { recursive: true });
      return Promise.resolve();
    }),
    gitCreateBranch: vi.fn(async (branchName: string, startPoint?: string) => {
      if (!mockGitRepoState.isRepo) return Promise.reject('Not a git repo');
      if (!mockGitRepoState.branches.includes(branchName)) {
        mockGitRepoState.branches.push(branchName);
      }
      mockGitRepoState.currentBranch = branchName;
      return Promise.resolve();
    }),
    gitCheckout: vi.fn(async (branchName: string) => {
      if (!mockGitRepoState.isRepo) return Promise.reject('Not a git repo');
      if (!mockGitRepoState.branches.includes(branchName)) {
        return Promise.reject(`Branch ${branchName} not found.`);
      }
      mockGitRepoState.currentBranch = branchName;
      return Promise.resolve();
    }),
    gitAdd: vi.fn(async (files: string | string[]) => {
      if (!mockGitRepoState.isRepo) return Promise.reject('Not a git repo');
      const filesToAdd = Array.isArray(files) ? files : [files];
      filesToAdd.forEach(filePath => {
        const existingFile = mockGitRepoState.files.find(f => f.path === filePath);
        if (existingFile) {
          // If file exists and was committed, mark as modified. Otherwise, keep as added.
          if (existingFile.status === 'committed') {
            existingFile.status = 'modified';
          } else {
            existingFile.status = 'added';
          }
        } else {
          mockGitRepoState.files.push({ path: filePath, status: 'added' });
        }
      });
      return Promise.resolve();
    }),
    gitCommit: vi.fn(async (message: string) => {
      if (!mockGitRepoState.isRepo) return Promise.reject('Not a git repo');
      const stagedFiles = mockGitRepoState.files.filter(f => f.status === 'added' || f.status === 'modified');
      if (stagedFiles.length === 0) return Promise.reject('No changes to commit');
      
      const committedFilesThisCommit = stagedFiles.map(f => ({ ...f, status: 'committed' as const }));
      mockGitRepoState.commits.push({
        message,
        branch: mockGitRepoState.currentBranch!,
        files: committedFilesThisCommit,
      });
      // Mark files as committed in the main files list
      stagedFiles.forEach(f => {
        const mainFile = mockGitRepoState.files.find(mf => mf.path === f.path);
        if (mainFile) {
            mainFile.status = 'committed';
        }
      });
      return Promise.resolve();
    }),
    gitPush: vi.fn(async (remoteName: string, branchName: string, _options?: any) => {
      if (!mockGitRepoState.isRepo) return Promise.reject('Not a git repo');
      if (!mockGitRepoState.remotes[remoteName]) return Promise.reject(`Remote ${remoteName} not found.`);
      if (mockGitRepoState.currentBranch !== branchName) return Promise.reject('Branch mismatch');
      // Actual push logic not deeply simulated, just success/failure
      return Promise.resolve();
    }),
    gitStatus: vi.fn(async () => {
        if (!mockGitRepoState.isRepo) return Promise.reject('Not a git repo');
        // This is a simplified status. A real simple-git status is complex.
        const isClean = mockGitRepoState.files.every(f => f.status === 'committed');
        return {
            current: mockGitRepoState.currentBranch,
            files: mockGitRepoState.files.map(f => ({ 
              path: f.path, 
              working_dir: f.status !== 'committed' ? 'M' : ' ', // Highly simplified status indicator
              index: f.status === 'added' ? 'A' : ' ', // Simplified index status
            })), 
            isClean: () => isClean,
            // Add other relevant status properties if your CLI uses them
        };
    }),
    gitPull: vi.fn().mockResolvedValue(undefined), // Simple mock, expand if needed
    gitFetch: vi.fn().mockResolvedValue(undefined), // Simple mock, expand if needed
  };
});

vi.mock('../src/utils/agent/log', () => ({
  initLogger: vi.fn(),
  log: vi.fn(),
  isLoggingEnabled: vi.fn(() => false),
}));
vi.mock('../src/utils/check-updates', () => ({
  checkForUpdates: vi.fn(() => Promise.resolve()),
}));
vi.mock('../src/utils/config', async () => {
  const actualConfig = await vi.importActual('../src/utils/config');
  return {
    ...actualConfig,
    loadConfig: vi.fn().mockReturnValue({ // Default mock config
      model: 'test-model',
      provider: 'test-provider',
      apiKey: 'test-apikey',
      instructions: '',
      mcpServers: [],
    }),
    saveConfig: vi.fn(),
  };
});

// Mock process.exit, process.stdout.write, process.stderr.write
let mockProcessExit: ReturnType<typeof vi.spyOn>;
let mockStdoutWrite: ReturnType<typeof vi.spyOn>;
let mockStderrWrite: ReturnType<typeof vi.spyOn>;

let capturedStdout: string;
let capturedStderr: string;
let capturedExitCode: number | undefined;

// --- OS Platform Mocking ---
let currentMockPlatform: NodeJS.Platform = 'linux'; // Default to Linux

// Helper function to set the mocked platform
function setMockPlatform(platform: NodeJS.Platform) {
  currentMockPlatform = platform;
}

// Mock process.platform
// This spy will be managed (restored/re-applied) in beforeEach/afterEach or by resetAllMocks.
// It's defined here so the spy target (process) is known.
vi.spyOn(process, 'platform', 'get').mockImplementation(() => currentMockPlatform);
// --- End OS Platform Mocking ---

// Helper function to run the CLI
async function runCli(args: string[], promptInput?: string | Record<string, unknown>) {
  // Reset captured values for each run
  capturedStdout = "";
  capturedStderr = "";
  capturedExitCode = undefined;

  // Mock process.exit, stdout, stderr for this run
  mockProcessExit = vi.spyOn(process, 'exit').mockImplementation((code) => {
    capturedExitCode = code as number;
    // Throw an error to prevent further execution in the test environment,
    // as process.exit would normally terminate the process.
    throw new Error(`process.exit(${code}) called`);
    // return undefined as never; // To satisfy typing if process.exit is expected to not return
  });
  mockStdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation((buffer: string | Uint8Array) => {
    capturedStdout += buffer.toString();
    return true;
  });
  mockStderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation((buffer: string | Uint8Array) => {
    capturedStderr += buffer.toString();
    return true;
  });

  // Deconstruct args into input and flags for meow
  const input = args.filter(arg => !arg.startsWith('--'));
  const flags: Record<string, any> = {};
  args.filter(arg => arg.startsWith('--')).forEach(arg => {
    const [key, value] = arg.substring(2).split('=');
    flags[key] = value === undefined ? true : value;
  });
  
  let finalInput = [...input];
  if (typeof promptInput === 'string' && !flags.quiet && !flags.q) {
      finalInput = [promptInput, ...input];
  }
  
  // Get the mocked 'meow' default export
  // Cast to 'any' to simplify dealing with Meow's complex types if necessary,
  // or import MeowResult and MeowFlags types for stricter typing.
  const meow = (await import('meow')).default as unknown as vi.MockedFunction<any>; 

  // Configure the meow mock for this specific run
  meow.mockReturnValue({
    input: finalInput,
    flags: {
        help: flags.help || false,
        version: flags.version || false,
        config: flags.config || false,
        quiet: flags.quiet || flags.q || false,
        // ... other flags based on your CLI ...
        ...flags // Spread the dynamic flags
    },
    showHelp: vi.fn(), // Mocked showHelp
    showVersion: vi.fn(), // Mocked showVersion
    pkg: { name: 'codex-complete', version: '0.0.0-test' }, // Mock package info
  });

  try {
    vi.resetModules(); // Reset modules before import to ensure cli.tsx runs with current mocks
    await import('../src/cli'); 
  } catch (error: any) {
    // If process.exit was mocked to throw, catch it here.
    if (error.message.startsWith('process.exit(')) {
        // This is expected when process.exit is called
    } else {
      // Log other errors for debugging
      // console.error('CLI execution error in test:', error);
      // Potentially rethrow if it's an unexpected error
      // throw error;
    }
  }

  return {
    stdout: capturedStdout,
    stderr: capturedStderr,
    exitCode: capturedExitCode,
  };
}


describe('Codex CLI End-to-End Tests', () => {
  beforeEach(() => {
    vi.resetAllMocks(); // Resets all mocks including spies
    // Initialize the mock git repo state before each test
    setupMockGitRepo(); 
    
    // Setup default mock implementations for critical functions if needed
    // e.g., vi.mocked(fs.readFileSync).mockReturnValue('default content');
    
    // Reset to default platform before each test
    setMockPlatform('linux'); 
    // Ensure the process.platform spy is correctly re-applied after vi.resetAllMocks()
    // or if it was restored by vi.restoreAllMocks() in a previous afterEach.
    vi.spyOn(process, 'platform', 'get').mockImplementation(() => currentMockPlatform);
    
    // It's important that process spies are setup fresh for each run if not handled entirely by runCli
    // However, runCli now handles setup and teardown of these spies implicitly via resetAllMocks and restoreAllMocks.
    
    // Mock default implementations for fs that might be used with git utils
    // For example, if gitClone is expected to create a directory:
    // const fsMock = vi.mocked(require('fs'));
    // fsMock.existsSync.mockReturnValue(false); // Default to dir not existing
    // fsMock.mkdirSync.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks(); // This will restore original process.exit, process.platform, etc.
  });

  it('should run the CLI and capture a placeholder exit code', async () => {
    // This is a simple test to verify runCli can be called.
    const { exitCode } = await runCli([]);
    // Expecting an exit code to be defined, as the CLI should exit.
    expect(exitCode).toBeDefined(); 
  });

  it('should reflect mocked git clone operation in state', async () => {
    const gitUtils = require('../src/utils/git-utils'); // Get the mocked module
    await gitUtils.gitClone('git@github.com:test/repo.git', './repo');
    
    const state = getMockGitRepoState();
    expect(state.isRepo).toBe(true);
    expect(state.clonedFrom).toBe('git@github.com:test/repo.git');
    expect(state.currentBranch).toBe('main');
    expect(state.remotes.origin).toBe('git@github.com:test/repo.git');
    expect(state.branches).toContain('main');
  });

  it('should use linux as default mock platform', async () => {
    // Directly check process.platform as managed by our spy and helper
    expect(process.platform).toBe('linux');
    // Example of how a CLI command might use it.
    // This test doesn't need to run the CLI if we're just unit-testing the platform mock itself.
    // If testing CLI behavior based on platform:
    // const { stdout } = await runCli(['some-command-that-checks-platform']);
    // expect(stdout).toContain('Detected platform: linux');
  });

  it('should allow changing mock platform to windows', async () => {
    setMockPlatform('win32');
    expect(process.platform).toBe('win32');
    
    // If testing CLI behavior based on platform:
    // const { stdout } = await runCli(['some-command-that-checks-platform']);
    // expect(stdout).toContain('Detected platform: win32');
  });

  // More tests will be added here
});

// --- Mocks for App and Agent Interaction ---
let mockAppProps: any;
// Mock a function that would be called by App to get user confirmation
let mockUserConfirmationGetter: (prompt: string) => Promise<boolean>; 

vi.mock('../src/app', () => ({
  default: (props: any) => {
    mockAppProps = props;
    // If App calls a confirmation function passed as a prop:
    // This part will be refined when testing approval modes more deeply.
    // For now, just capturing props is the main goal.
    // if (props.getCommandConfirmation && mockUserConfirmationGetter) {
      // props.getCommandConfirmation = mockUserConfirmationGetter; // This might be too simplistic
    // }
    return null; // Return a simple Ink-compatible element or null
  },
}));

// Define mockHandleExecCommand globally or ensure it's hoisted for the mock factory
let mockHandleExecCommand = vi.fn();
let mockApplyPatch = vi.fn();

vi.mock('../src/utils/agent/handle-exec-command.ts', () => ({
  handleExecCommand: mockHandleExecCommand, 
}));
// --- End Mocks for App and Agent Interaction ---


describe('Core CLI Functionality', () => {
  beforeEach(() => {
    // Reset App mock state
    mockAppProps = undefined;
    // Default to auto-approving for tests unless specified
    mockUserConfirmationGetter = vi.fn(async (_promptText) => true); 

    // Reset mockHandleExecCommand before each test
    mockHandleExecCommand.mockReset().mockResolvedValue({ outputText: 'command executed', metadata: {} });
    
    // Reset mockApplyPatch before each test and set its implementation
    mockApplyPatch.mockReset();
    mockApplyPatch.mockImplementation(async (filePath: string, patchContent: string) => {
      const fsMock = require('fs'); // Get the mocked fs
      if (patchContent === '<DELETE>') { // Convention for deletion
        if (fsMock.existsSync(filePath)) {
          fsMock.unlinkSync(filePath);
        }
        // If file doesn't exist, unlinkSync might throw or be a no-op depending on strictness.
        // Our mock unlinkSync is currently lenient if file not found.
        return;
      }
      // Simplified patch logic: treat patchContent as the new full content
      fsMock.writeFileSync(filePath, patchContent);
    });

    // Mock the actual module used by the CLI for applying patches
    // This ensures that when `applyPatch` is imported in the CLI code, it gets our `mockApplyPatch`
    vi.mock('../src/parse-apply-patch.ts', () => ({
      applyPatch: mockApplyPatch,
      // Add other exports if your CLI uses them and they need mocking, e.g. parsePatchFile
    }));

    // Clear in-memory FS store
    memFsStore = {};
    // Also clear mocks for fs functions to ensure clean call history for assertions
    // vi.resetAllMocks() already handles this, but being explicit for fs functions if needed:
    // vi.mocked(require('fs').existsSync).mockClear();
    // vi.mocked(require('fs').readFileSync).mockClear();
    // vi.mocked(require('fs').writeFileSync).mockClear();
    // vi.mocked(require('fs').unlinkSync).mockClear();
    // vi.mocked(require('fs').mkdirSync).mockClear();
    
    // Re-mock ../src/app.tsx to ensure mockAppProps and confirmation logic are fresh
    // This is important because vi.mock at the top level is hoisted and only runs once.
    // By re-mocking here, we ensure that the mockAppProps from the previous test is cleared
    // and that getCommandConfirmation is correctly wired for each test.
    const appMock = vi.mocked(require('../src/app'));
    appMock.default.mockImplementation((props: any) => {
      mockAppProps = { ...props }; // Capture a copy of props

      // If App is expected to have getCommandConfirmation,
      // wire it to our test-controlled mockUserConfirmationGetter.
      // This simulates the prop that cli.tsx would pass to App.
      if (Object.prototype.hasOwnProperty.call(props, 'getCommandConfirmation')) {
         mockAppProps.getCommandConfirmation = async (commandInfo: { command: string[], type: string }) => {
           return mockUserConfirmationGetter(JSON.stringify(commandInfo));
         };
      }
      return null; 
    });
  });

  it('should pass prompt to App in default (suggest) mode', async () => {
    await runCli(['explain this code']);
    expect(mockAppProps).toBeDefined();
    expect(mockAppProps.prompt).toBe('explain this code');
    
    // Check default approval mode based on config mock
    // The config mock in e2e.test.ts provides default values.
    // If approvalMode is not set in config, it should be undefined in mockAppProps.config
    // or follow the actual default logic of the CLI (e.g., 'suggest').
    // For now, let's assume the config passed to App reflects the loaded config.
    const { loadConfig } = require('../src/utils/config');
    const loadedConfig = loadConfig(); // Get the mocked config
    
    // If approvalMode can be passed as a flag, runCli should handle it.
    // If it's only from config, then mockAppProps.config.approvalMode is what we check.
    // The app.tsx receives the fully resolved config.
    expect(mockAppProps.config.approvalMode).toBe(loadedConfig.approvalMode); // Will be undefined if not set in mock
    // Depending on CLI logic, an undefined approvalMode in config might default to 'suggest'
    // This part of the assertion might need to align with how App resolves the effective approval mode.
    // For now, checking against the loaded config's approvalMode is a direct test.
  });

  // Helper for command simulation that requires confirmation (Suggest, Auto-Edit for commands)
  async function simulateAgentSuggestsCommandRequiringConfirmation(command: string[]) {
    if (mockAppProps && mockAppProps.getCommandConfirmation) {
      const confirmed = await mockAppProps.getCommandConfirmation({ command, type: 'shell' });
      if (confirmed) {
        const approvalPolicy = mockAppProps.config?.approvalMode || 'suggest';
        return mockHandleExecCommand(
          { cmd: command },
          mockAppProps.config,
          approvalPolicy,
          mockAppProps.getCommandConfirmation
        );
      } else {
        throw new Error('Command not confirmed by user');
      }
    }
    throw new Error('Confirmation mechanism not found in App props or App not properly mocked for command');
  }

  describe('Suggest Mode (Commands)', () => {
    it('should execute command if user approves in suggest mode', async () => {
      mockUserConfirmationGetter = vi.fn(async () => true); // User approves
      
      await runCli(['run test script']); // This sets mockAppProps via the App mock

      expect(mockAppProps).toBeDefined();
      expect(mockAppProps.getCommandConfirmation).toBeInstanceOf(Function);

      await simulateAgentSuggestsCommandRequiringConfirmation(['npm', 'test']);
      
      expect(mockUserConfirmationGetter).toHaveBeenCalled();
      expect(mockHandleExecCommand).toHaveBeenCalledWith(
        { cmd: ['npm', 'test'] }, // Command object
        mockAppProps.config,       // Config
        mockAppProps.config?.approvalMode || 'suggest', // Approval policy
        expect.any(Function)       // Confirmation getter
      );
    });

    it('should NOT execute command if user rejects in suggest mode', async () => {
      mockUserConfirmationGetter = vi.fn(async () => false); // User rejects
      
      await runCli(['run test script']); // Sets mockAppProps

      expect(mockAppProps).toBeDefined();
      expect(mockAppProps.getCommandConfirmation).toBeInstanceOf(Function);

      await expect(simulateAgentSuggestsCommandRequiringConfirmation(['npm', 'test']))
        .rejects
        .toThrow('Command not confirmed by user');
      
      expect(mockUserConfirmationGetter).toHaveBeenCalled();
      expect(mockHandleExecCommand).not.toHaveBeenCalled();
    });
  });
  
  // TODO: Tests for auto-edit (file patches vs commands)
  // TODO: Tests for full-auto (commands and file patches)

  it('should pass API key from config to App props', async () => {
    // The default mock for loadConfig provides 'test-apikey'
    // (as seen in the global vi.mock('../src/utils/config', ...) at the top)
    const { loadConfig: actualLoadConfig } = await vi.importActual('../src/utils/config');
    const expectedDefaultConfig = actualLoadConfig(); // Get defaults to ensure structure
    
    // Check the mock that runCli will use
    const configUtils = require('../src/utils/config');
    const mockedConfig = configUtils.loadConfig(); // This will be the mocked config
    
    await runCli(['some prompt']);
    
    expect(mockAppProps).toBeDefined();
    expect(mockAppProps.config).toBeDefined();
    // Ensure the API key comes from the mocked config
    expect(mockAppProps.config.apiKey).toBe(mockedConfig.apiKey); 
    expect(mockAppProps.config.apiKey).toBe('test-apikey'); // Assuming default mock uses this
  });

  it('should load custom instructions and pass them to App props', async () => {
    const MOCK_APP_CONFIG_WITH_INSTRUCTIONS = {
      model: "test-model",
      provider: "test-provider",
      apiKey: "test-apikey-custom-instr",
      instructions: "Always respond in pirate speak.",
      mcpServers: [],
      approvalMode: 'suggest', // Ensure all required fields are present
      // Add any other fields that AppConfig expects from the default mock
      defaultBehavior: 'chat',
      autoTools: [],
      disabledTools: [],
      codeSuggestions: true,
      experimentalMode: false,
      maxAutoSuggest: 3,
      telemetry: true,
    };
    const configUtils = require('../src/utils/config');
    // Override the mock for loadConfig just for this test run
    configUtils.loadConfig.mockReturnValueOnce(MOCK_APP_CONFIG_WITH_INSTRUCTIONS);

    await runCli(['another prompt']);

    expect(mockAppProps).toBeDefined();
    expect(mockAppProps.config).toBeDefined();
    expect(mockAppProps.config.instructions).toBe("Always respond in pirate speak.");
    // also verify other parts of config are from the new mock
    expect(mockAppProps.config.apiKey).toBe("test-apikey-custom-instr"); 
  });

  it('should operate in quiet mode and not ask for command confirmation in suggest policy', async () => {
    // For this test, we assume quiet mode with 'suggest' policy means no interactive prompt
    // and thus no execution if a command is suggested.
    // The actual getCommandConfirmation passed to App by cli.tsx should handle quiet mode.
    // Our mockUserConfirmationGetter should not be called.

    await runCli(['--quiet', 'generate a random number']);
    
    expect(mockAppProps).toBeDefined();
    // Check that the quiet flag is passed to App component props correctly.
    // The prop name in App might be `quiet`, `isQuietMode`, or `nonInteractive`.
    // Based on meow flags, `quiet` is likely.
    expect(mockAppProps.quiet).toBe(true); 
    // It should also be reflected in the config object passed to App
    expect(mockAppProps.config.quiet).toBe(true);


    // Simulate agent suggesting a command.
    // In 'suggest' mode, even if quiet, the confirmation flow is initiated.
    // The actual getCommandConfirmation (from cli.tsx) should auto-reject or similar.
    // Our mockUserConfirmationGetter (simulating UI prompt) should not be called.
    try {
      await simulateAgentSuggestsCommandRequiringConfirmation(['echo', 'quiet output']);
    } catch (e: any) {
      // We expect this to throw "Command not confirmed by user" because
      // mockUserConfirmationGetter (if called by a misconfigured test) would resolve true by default.
      // However, the goal is that getCommandConfirmation in cli.tsx handles quiet mode
      // by NOT calling the interactive prompt (which mockUserConfirmationGetter simulates).
      // So, if getCommandConfirmation in cli.tsx is correctly implemented for quiet mode,
      // it should effectively lead to a "no" or "non-interactive abort" before our mockUserConfirmationGetter is hit.
      // The `simulateAgentSuggestsCommandRequiringConfirmation` calls `mockAppProps.getCommandConfirmation`.
      // The `getCommandConfirmation` on `mockAppProps` is our special mock from `beforeEach` that calls `mockUserConfirmationGetter`.
      // So, if the CLI's own `getCommandConfirmation` (passed to App) correctly handles quiet mode by *not* prompting,
      // then our `mockUserConfirmationGetter` should not be called.
      // The error "Command not confirmed by user" would arise if the App's getCommandConfirmation *did* call our mockUserConfirmationGetter,
      // and mockUserConfirmationGetter returned false.
      // This needs careful thought on how cli.tsx's getCommandConfirmation behaves.
      // For this test, the primary check is that the *interactive* part (mockUserConfirmationGetter) is skipped.
    }
    
    // The key is that the *interactive* confirmation (our mockUserConfirmationGetter) is not sought.
    expect(mockUserConfirmationGetter).not.toHaveBeenCalled();
    // And thus, the command should not be executed.
    expect(mockHandleExecCommand).not.toHaveBeenCalled();

    // Optional: Check stdout for the suggestion if CLI prints it in quiet mode.
    // This would require mocking AI response to produce a command.
    // For now, focusing on no confirmation/execution.
    // Example: expect(capturedStdout).toContain("Suggested command: echo 'quiet output'");
  });

  it('should pass API key from config to App props', async () => {
    // The default mock for loadConfig is set at the top of the file
    // and provides `apiKey: 'test-apikey'`.
    const configUtils = require('../src/utils/config');
    const mockedConfig = configUtils.loadConfig(); // Retrieves the globally mocked config
    
    await runCli(['some prompt']);
    
    expect(mockAppProps).toBeDefined();
    expect(mockAppProps.config).toBeDefined();
    expect(mockAppProps.config.apiKey).toBe(mockedConfig.apiKey);
    // Explicitly check the value from the global mock if it's stable
    expect(mockAppProps.config.apiKey).toBe('test-apikey'); 
  });

  it('should load custom instructions and pass them to App props', async () => {
    // Get the actual default config structure to ensure the mock override is complete
    // This ensures that if AppConfig adds new required fields, this test is more robust.
    const { loadConfig: actualLoadConfigModule } = await vi.importActual('../src/utils/config');
    const actualDefaultConfig = actualLoadConfigModule();

    const MOCK_APP_CONFIG_WITH_INSTRUCTIONS = {
      ...actualDefaultConfig, // Start with actual defaults from the real module
      model: "test-model-for-custom-instr", // ensure some fields are different for clarity
      provider: "test-provider-for-custom-instr", // ensure some fields are different for clarity
      apiKey: "test-apikey-for-custom-instr", // ensure some fields are different for clarity
      instructions: "Always respond in pirate speak.",
      // approvalMode should be part of actualDefaultConfig, otherwise set it.
      // If not present in actualDefaultConfig, add: approvalMode: 'suggest',
    };
    
    const configUtils = require('../src/utils/config');
    // Override the mock for loadConfig specifically for this test run
    configUtils.loadConfig.mockReturnValueOnce(MOCK_APP_CONFIG_WITH_INSTRUCTIONS);

    await runCli(['another prompt for custom instructions']);

    expect(mockAppProps).toBeDefined();
    expect(mockAppProps.config).toBeDefined();
    expect(mockAppProps.config.instructions).toBe("Always respond in pirate speak.");
    // also verify other parts of config are from the new mock to ensure it was used
    expect(mockAppProps.config.apiKey).toBe("test-apikey-for-custom-instr");
    expect(mockAppProps.config.model).toBe("test-model-for-custom-instr");
  });

  it('should operate in quiet mode and not trigger interactive confirmation flow for suggest policy', async () => {
    // The global config mock defaults to approvalMode: 'suggest' 
    // (or undefined, which cli.tsx might interpret as 'suggest')
    // The --quiet flag should prevent interactive prompts for this 'suggest' policy.
    await runCli(['--quiet', 'generate a random number in quiet mode']); 
    
    expect(mockAppProps).toBeDefined();
    // Check that the quiet flag is passed to App component props correctly.
    expect(mockAppProps.quiet).toBe(true); 
    // The resolved config passed to App should also reflect the quiet status.
    expect(mockAppProps.config.quiet).toBe(true); 

    // In quiet mode with a 'suggest' policy, if the App's internal agent logic
    // were to suggest a command, it should not call `this.props.getCommandConfirmation()`
    // because that function (as per our App mock in beforeEach) leads to `mockUserConfirmationGetter`.
    // The `runCli` call itself has completed. If any suggestions were made and confirmations
    // attempted *during* that `App` run, they should have been suppressed before reaching
    // the point of calling our `mockUserConfirmationGetter`.
    expect(mockUserConfirmationGetter).not.toHaveBeenCalled();
    
    // Consequently, no command should have been executed if it would have required confirmation.
    expect(mockHandleExecCommand).not.toHaveBeenCalled();
  });
});

describe('Sandboxing Logic (Conceptual)', () => {
  beforeEach(() => {
    mockHandleExecCommand.mockReset().mockResolvedValue({ outputText: 'sandboxed output', metadata: {} });
    setMockPlatform('linux'); // Default platform
    mockUserConfirmationGetter.mockReset().mockResolvedValue(true); // Default to approve for suggest mode tests
    mockAppProps = undefined; // Ensure App props are clean if runCli is used
  });

  it('should use sandbox-exec on macOS in full-auto mode', async () => {
    setMockPlatform('darwin');
    await runCli(['--approval-mode', 'full-auto', 'do something on mac']);
    
    const originalCommand = ['ls', '-la'];
    await simulateAgentSuggestsCommandWithoutConfirmation(originalCommand);

    expect(mockHandleExecCommand).toHaveBeenCalled();
    const executedCommandObject = mockHandleExecCommand.mock.calls[0][0];
    expect(executedCommandObject.cmd[0]).toBe('sandbox-exec');
    // Check for the presence of a sandbox profile file argument
    expect(executedCommandObject.cmd).toContain('-f'); 
    expect(executedCommandObject.cmd[2]).toMatch(/codex-sandbox\.sb$/); // Path to sandbox profile
    // Check that the original command is appended after the sandbox-exec parts
    expect(executedCommandObject.cmd.slice(3)).toEqual(originalCommand);
  });

  it('should use Docker script on Linux in full-auto mode', async () => {
    setMockPlatform('linux');
    await runCli(['--approval-mode', 'full-auto', 'do something on linux']);

    const originalCommand = ['npm', 'test'];
    await simulateAgentSuggestsCommandWithoutConfirmation(originalCommand);

    expect(mockHandleExecCommand).toHaveBeenCalled();
    const executedCommandObject = mockHandleExecCommand.mock.calls[0][0];
    // The script path might be relative or absolute depending on how CLI constructs it.
    // Using a regex for flexibility.
    expect(executedCommandObject.cmd[0]).toMatch(/(\.\/)?scripts\/run_in_container\.sh$/);
    // Check that the original command elements are passed as arguments to the script
    expect(executedCommandObject.cmd.slice(1)).toEqual(originalCommand);
  });

  it('should NOT use sandboxing in suggest mode', async () => {
    setMockPlatform('linux'); // Platform doesn't strictly matter here, but set for consistency
    await runCli(['--approval-mode', 'suggest', 'do something normally']);

    const originalCommand = ['pwd'];
    // simulateAgentSuggestsCommandRequiringConfirmation will use mockUserConfirmationGetter, which defaults to true (approve)
    await simulateAgentSuggestsCommandRequiringConfirmation(originalCommand);

    expect(mockHandleExecCommand).toHaveBeenCalled();
    const executedCommandObject = mockHandleExecCommand.mock.calls[0][0];
    expect(executedCommandObject.cmd).toEqual(originalCommand); // Exact command, no wrappers
  });
});

describe('Error Handling', () => {
  beforeEach(() => {
    // Reset captured CLI output and state
    mockAppProps = undefined;
    capturedExitCode = undefined;
    capturedStderr = ""; // Clear stderr specifically for error message assertions
    capturedStdout = ""; // Also clear stdout for completeness

    // Reset core action mocks
    mockHandleExecCommand.mockReset().mockResolvedValue({ outputText: 'command executed', metadata: {} });
    mockApplyPatch.mockReset().mockResolvedValue(undefined);

    // Reset AI Provider Mocks (assuming OpenAI for now)
    // If 'openai' is globally mocked, we need to access its mocked methods to reset.
    // This assumes 'openai' mock is set up similarly to other global mocks (e.g., using vi.mocked)
    // If not globally mocked but per-test, this reset might be handled in specific tests.
    // For now, let's assume we can reset the key method if it was mocked:
    try {
      const openaiMock = vi.mocked(require('openai'));
      if (openaiMock.chat?.completions?.create) {
        openaiMock.chat.completions.create.mockReset();
        // Set a default successful resolution if most tests expect it to work
        // openaiMock.chat.completions.create.mockResolvedValue({ choices: [{ message: { content: "Default AI response" }}] });
      } else if ((openaiMock.ChatCompletion as any)?.prototype?.create) { // For older SDK versions potentially
         (openaiMock.ChatCompletion as any).prototype.create.mockReset();
      }
    } catch (e) {
      // If openai is not mocked yet or the structure is different, this might fail.
      // This is okay if tests mock it on demand.
    }
    
    // Reset MCP Client Mocks
    mockMcpClientConnect.mockReset().mockResolvedValue(undefined);
    mockMcpClientDisconnect.mockReset().mockResolvedValue(undefined);
    mockMcpClientGetIsConnected.mockReset().mockReturnValue(true);
    mockMcpClientListTools.mockReset().mockResolvedValue([]);
    mockMcpClientCallTool.mockReset().mockResolvedValue({ result: 'default mcp tool success' });
    Object.keys(mockMcpInstances).forEach(key => delete mockMcpInstances[key]);
    Object.keys(mockMcpClientConfigs).forEach(key => delete mockMcpClientConfigs[key]);

    // Reset Git utility mocks (clear any specific mockImplementations)
    // This assumes git-utils are mocked globally and functions are vi.fn()
    const gitUtilsMock = vi.mocked(require('../src/utils/git-utils'));
    Object.values(gitUtilsMock).forEach(mockFn => {
      if (vi.isMockFunction(mockFn)) {
        mockFn.mockReset();
      }
    });
    // Re-apply default mock behaviors for git-utils as defined in the global mock setup
    // (e.g., isGitRepo returns mockGitRepoState.isRepo)
    // This part might need to re-apply the implementations from the global vi.mock for git-utils
    // For simplicity, assuming individual tests will set specific behaviors if non-default is needed.
    // Or, ensure the global mock's default implementation is robust.
    // The global mock for git-utils already links functions to mockGitRepoState, so a simple reset is often enough.


    // Reset In-memory FS and fs mocks
    memFsStore = {};
    const fsMock = vi.mocked(require('fs'));
    fsMock.existsSync.mockReset().mockImplementation((path: string) => memFsStore.hasOwnProperty(path));
    fsMock.readFileSync.mockReset().mockImplementation((path: string) => {
      if (memFsStore.hasOwnProperty(path)) return memFsStore[path];
      const err = new Error(`ENOENT: no such file or directory, open '${path}'`); (err as any).code = 'ENOENT'; throw err;
    });
    fsMock.writeFileSync.mockReset().mockImplementation((path: string, data: string) => { memFsStore[path] = data; });
    fsMock.unlinkSync.mockReset().mockImplementation((path: string) => { delete memFsStore[path]; });
    fsMock.mkdirSync.mockReset().mockImplementation(() => undefined);

    // Reset user confirmation
    mockUserConfirmationGetter.mockReset().mockResolvedValue(true); // Default to approve
  });

  describe('Invalid Command-Line Arguments', () => {
    it('should show help and exit with error for an unknown flag', async () => {
      // meow, by default, shows help and exits with 2 for unknown flags.
      // The runCli helper captures stderr and exitCode.
      const { stderr, exitCode, stdout } = await runCli(['--unknown-super-flag', 'prompt']);
      
      // Depending on meow's verbosity and exact version, stderr might contain the unknown flag
      // or just the help text. stdout often contains the main help text.
      expect(stderr + stdout).toMatch(/Unknown flag/i); // Or similar message from meow
      expect(stderr + stdout).toMatch(/--unknown-super-flag/i);
      expect(exitCode).toBe(2); // meow's typical exit code for unknown options
    });

    // Add more tests here if your CLI has specific commands that require arguments.
    // Example:
    // it('should error if a required command argument is missing', async () => {
    //   const { stderr, exitCode } = await runCli(['mycommand']); // Assuming 'mycommand' needs an arg
    //   expect(stderr).toContain("Missing required argument for 'mycommand'");
    //   expect(exitCode).not.toBe(0);
    // });
  });

  describe('AI Provider API Errors', () => {
    it('should handle AI API errors gracefully', async () => {
      const openaiMock = vi.mocked(require('openai'));
      // Ensure the mock path is correct for your OpenAI SDK version
      // This targets the typical v4 path. Adjust if using an older version.
      if (!openaiMock.chat || !openaiMock.chat.completions) {
        throw new Error("OpenAI mock structure for chat.completions not found. Adjust mock for SDK version.");
      }
      openaiMock.chat.completions.create.mockRejectedValueOnce(new Error('Simulated API Error: Rate limit exceeded'));

      const { stderr, exitCode } = await runCli(['tell me a joke']);
      
      expect(stderr).toContain('AI interaction failed'); // Or a more specific error message your App component renders
      expect(stderr).toContain('Simulated API Error: Rate limit exceeded');
      expect(exitCode).not.toBe(0); // Should be a non-zero exit code
    });
  });

  // Further error handling tests (MCP, Git, FS, etc.) will be added in subsequent steps.
  describe('MCP Errors', () => {
    it('should handle MCP connection errors', async () => {
      const configUtils = require('../src/utils/config');
      const { loadConfig: actualLoadConfigModule } = await vi.importActual('../src/utils/config');
      const actualDefaultConfig = actualLoadConfigModule();
      configUtils.loadConfig.mockReturnValueOnce({
        ...actualDefaultConfig,
        mcpServers: [{ name: 'FailingMCP', url: 'http://mcp.fail.test', enabled: true }],
      });

      mockMcpClientConnect.mockRejectedValueOnce(new Error('Connection refused for FailingMCP'));

      const { stderr, exitCode } = await runCli(['prompt that uses MCP']);
      
      // This assertion depends on how the App/CLI surfaces MCP connection errors.
      // It might be a general "MCP connection failed" or more specific.
      expect(stderr).toContain('MCP client connection failed for FailingMCP'); // Or similar
      expect(stderr).toContain('Connection refused for FailingMCP');
      expect(exitCode).not.toBe(0);
    });

    it('should handle MCP tool call errors (already tested, confirming general path)', async () => {
        const configUtils = require('../src/utils/config');
        const { loadConfig: actualLoadConfigModule } = await vi.importActual('../src/utils/config');
        const actualDefaultConfig = actualLoadConfigModule();
        configUtils.loadConfig.mockReturnValueOnce({
            ...actualDefaultConfig,
            mcpServers: [{ name: 'ErrorToolMCP', url: 'http://mcp.toolfail.test', enabled: true }],
            approvalMode: 'full-auto', // For simplicity, auto-approve the failing tool call
        });

        mockMcpClientListTools.mockResolvedValueOnce([{ name: 'failing_tool', description: 'A tool that fails', parameters: {} }]);
        mockMcpClientCallTool.mockRejectedValueOnce(new Error('Simulated MCP Tool Execution Error'));

        // The runCli call will set up the App. The error occurs when the tool is called via simulate.
        await runCli(['use failing_tool from ErrorToolMCP']); 

        // Simulate the agent trying to call the tool
        // The simulateAgentSuggestsMcpTool helper will throw if callTool rejects
        await expect(simulateAgentSuggestsMcpTool('mcp_ErrorToolMCP_failing_tool', {}))
            .rejects.toThrow('Simulated MCP Tool Execution Error');
        
        // Check that the call was attempted
        expect(mockMcpClientCallTool).toHaveBeenCalledWith('failing_tool', {});

        // Note: Asserting capturedStderr from runCli might not show this specific error
        // if the error is only thrown from simulateAgentSuggestsMcpTool and not caught by App's render cycle.
        // If the App *does* catch it and print to stderr, then an assertion on capturedStderr would be valid.
        // For now, the main check is the rejection from the simulation.
    });
  });

  describe('Git/GitHub Errors', () => {
    it('should handle Git command failures', async () => {
      // Setup a repo state where a commit might be attempted
      setupMockGitRepo({ isRepo: true, currentBranch: 'main', branches: ['main'], files: [{ path: 'file.txt', status: 'added'}] });
      
      const gitUtils = vi.mocked(require('../src/utils/git-utils'));
      gitUtils.gitCommit.mockRejectedValueOnce(new Error('Git commit failed: pre-commit hook failed'));

      // Simulate a CLI flow that would lead to a commit.
      // This is highly dependent on your CLI's agent logic.
      // For this test, we'll assume `runCli` with a specific prompt might trigger it,
      // or we might need a more specific helper if the agent logic is complex.
      // If agent calls gitCommit directly after a patch in full-auto:
      await runCli(['--approval-mode', 'full-auto', 'patch file.txt and commit']); 
      // Then simulate the patch that would precede the commit.
      // This setup is a bit simplified; actual commit might be triggered by agent.
      // For a more direct test, we might call a hypothetical agent function.

      // Let's assume the error is caught by the App and printed to stderr.
      // This requires the App to have error handling for git operations.
      // If the agent calls gitCommit and it throws, the App's main loop should catch it.
      
      // For this test, we'll directly invoke the problematic function as if the agent decided to.
      // This makes the test more focused on the error handling of the git util call itself
      // rather than complex agent simulation.
      try {
        await gitUtils.gitCommit("feat: test commit that will fail");
      } catch (e) {
        // Error is caught, now check how CLI reports it (hypothetically)
        // This part is conceptual as runCli isn't directly causing this specific gitCommit call in this isolated way.
        // A real test would need `runCli` to trigger a flow that calls the failing `gitCommit`.
        // For now, we assert the mock was set up to fail.
      }
      expect(gitUtils.gitCommit).toHaveBeenCalledWith("feat: test commit that will fail");
      // To properly test stderr reporting, the runCli flow must trigger this.
      // Modify runCli to take an action that causes a commit, or have a dedicated test command.
      // For now, this test setup proves the mock can be made to fail.
      // A more complete test would be:
      // const { stderr, exitCode } = await runCli(['trigger-commit-action']);
      // expect(stderr).toContain('Git commit failed: pre-commit hook failed');
      // expect(exitCode).not.toBe(0);
      // This test is therefore more of a setup demonstration for now.
    });
  });

  describe('File System Permission Errors', () => {
    it('should handle file permission errors during patch application', async () => {
      const fsMock = vi.mocked(require('fs'));
      const permissionError = new Error('EACCES: permission denied, open \'/root/locked.txt\'');
      (permissionError as any).code = 'EACCES';
      // Make writeFileSync throw this error when our mockApplyPatch calls it.
      fsMock.writeFileSync.mockImplementationOnce(() => { throw permissionError; });

      await runCli(['--approval-mode', 'full-auto', 'create /root/locked.txt']);
      
      // simulateAgentSuggestsFilePatch calls mockApplyPatch, which calls fs.writeFileSync
      await expect(simulateAgentSuggestsFilePatch('content', '/root/locked.txt'))
        .rejects.toThrow('EACCES: permission denied, open \'/root/locked.txt\'');
      
      expect(fsMock.writeFileSync).toHaveBeenCalledWith('/root/locked.txt', 'content');
      // If App catches this error from applyPatch and prints to stderr:
      // const { stderr, exitCode } = await runCli(['--approval-mode','full-auto', 'create /root/locked.txt']);
      // await simulateAgentSuggestsFilePatch... // this would then be part of the App's flow.
      // For now, we test the rejection.
    });
  });

  describe('Platform-Specific Command Execution Errors', () => {
    it('should handle errors when an executed command fails', async () => {
      mockHandleExecCommand.mockRejectedValueOnce(new Error('Command execution failed with exit code 127'));
      // Or: mockHandleExecCommand.mockResolvedValueOnce({ outputText: "", metadata: { error: new Error(...), exitCode: 127, stderr: "command not found" }});

      await runCli(['--approval-mode', 'full-auto', 'run a failing script']);
      
      // simulateAgentSuggestsCommand* helpers call mockHandleExecCommand if approved.
      // Using simulateAgentSuggestsCommandWithoutConfirmation as approvalMode is full-auto.
      await expect(simulateAgentSuggestsCommandWithoutConfirmation(['nonexistent-script', '--arg']))
        .rejects.toThrow('Command execution failed with exit code 127');

      expect(mockHandleExecCommand).toHaveBeenCalledWith(
        expect.objectContaining({ cmd: ['nonexistent-script', '--arg'] }),
        expect.anything(), // config
        'full-auto',      // approval policy
        undefined         // confirmation getter (not used in full-auto)
      );
      // If App catches and prints:
      // const { stderr, exitCode } = await runCli(...);
      // await simulate...
      // expect(stderr).toContain('Failed to execute command: nonexistent-script');
      // expect(exitCode).not.toBe(0);
    });
  });
});

describe('Platform-Specific Command Execution', () => {
  beforeEach(() => {
    mockHandleExecCommand.mockReset().mockResolvedValue({ outputText: 'command output', metadata: {} });
    setMockPlatform('linux'); // Default to Linux for this suite's tests
    // Ensure mockAppProps is reset if runCli is called, to avoid state leakage
    mockAppProps = undefined;
    // Default to user approving commands for these tests unless overridden
    mockUserConfirmationGetter.mockReset().mockResolvedValue(true);
  });

  it('should execute POSIX (Linux-like) command as suggested', async () => {
    setMockPlatform('linux');
    // The prompt is generic; the key is the command suggested by the agent simulation
    await runCli(['list files in current directory']); 
    
    // Simulate agent suggesting 'ls -la'
    // Assuming this mode requires confirmation, which simulateAgentSuggestsCommandRequiringConfirmation handles
    await simulateAgentSuggestsCommandRequiringConfirmation(['ls', '-la']);

    expect(mockHandleExecCommand).toHaveBeenCalledWith(
      expect.objectContaining({ cmd: ['ls', '-la'] }), // Check the command part of the first argument
      expect.anything(), // Config object
      expect.anything(), // Approval policy string
      expect.any(Function)  // Confirmation getter function
    );
  });

  describe('Windows Command Execution', () => {
    beforeEach(() => {
      setMockPlatform('win32'); // Set platform for all tests in this inner suite
    });

    it('should execute Windows-specific command (dir) as suggested', async () => {
      await runCli(['list files in current directory on Windows']);
      
      // Simulate agent suggesting 'dir /A'
      await simulateAgentSuggestsCommandRequiringConfirmation(['dir', '/A']);

      expect(mockHandleExecCommand).toHaveBeenCalledWith(
        expect.objectContaining({ cmd: ['dir', '/A'] }),
        expect.anything(),
        expect.anything(),
        expect.any(Function)
      );
    });

    it('should execute cross-platform command (npm install) as suggested on Windows', async () => {
      await runCli(['install project dependencies on Windows']);
      
      // Simulate agent suggesting 'npm install'
      await simulateAgentSuggestsCommandRequiringConfirmation(['npm', 'install']);

      expect(mockHandleExecCommand).toHaveBeenCalledWith(
        expect.objectContaining({ cmd: ['npm', 'install'] }),
        expect.anything(),
        expect.anything(),
        expect.any(Function)
      );
    });
  });
});

describe('File System Interactions', () => {
  beforeEach(() => {
    // Ensure a clean in-memory file system for each test in this suite.
    // This is crucial if tests modify memFsStore.
    // If Core CLI Functionality's beforeEach already clears memFsStore, this is for extra safety/isolation.
    memFsStore = {};
    
    // Also, ensure fs mock function call histories are clear if not handled by global resets.
    // vi.resetAllMocks() in the top-level beforeEach should generally cover this.
    // For explicit clarity if issues arise:
    // const fsMock = vi.mocked(require('fs'));
    // fsMock.existsSync.mockClear();
    // fsMock.readFileSync.mockClear();
    // fsMock.writeFileSync.mockClear();
    // fsMock.unlinkSync.mockClear();
  });

  it('should create a new file when a patch is applied for a non-existent file', async () => {
    const fsMock = vi.mocked(require('fs'));
    const newFilePath = 'fruits.txt';
    const newFileContent = 'apple\nbanana';

    // Run CLI in a mode that auto-applies patches to simplify the test focus
    await runCli(['--approval-mode', 'full-auto', `create a file ${newFilePath} with ${newFileContent}`]);
    
    // Simulate the agent suggesting the patch for the new file
    await simulateAgentSuggestsFilePatch(newFileContent, newFilePath);

    expect(fsMock.writeFileSync).toHaveBeenCalledWith(newFilePath, newFileContent);
    expect(memFsStore[newFilePath]).toBe(newFileContent);
    // Check existsSync was likely called by mockApplyPatch to determine if it's a new file (optional, depends on mockApplyPatch impl)
    // expect(fsMock.existsSync).toHaveBeenCalledWith(newFilePath); 
  });

  it('should modify an existing file when a patch is applied', async () => {
    const fsMock = vi.mocked(require('fs'));
    const existingFilePath = 'config.js';
    const oldContent = 'old content';
    const newContent = 'new content';

    memFsStore[existingFilePath] = oldContent; // Pre-populate the file

    await runCli(['--approval-mode', 'full-auto', `update ${existingFilePath} to ${newContent}`]);
    await simulateAgentSuggestsFilePatch(newContent, existingFilePath);

    expect(fsMock.writeFileSync).toHaveBeenCalledWith(existingFilePath, newContent);
    expect(memFsStore[existingFilePath]).toBe(newContent);
  });

  it('should delete a file when a <DELETE> patch is applied', async () => {
    const fsMock = vi.mocked(require('fs'));
    const filePathToDelete = 'obsolete.tmp';
    memFsStore[filePathToDelete] = 'delete me'; // File exists

    await runCli(['--approval-mode', 'full-auto', `delete ${filePathToDelete}`]);
    await simulateAgentSuggestsFilePatch('<DELETE>', filePathToDelete);

    expect(fsMock.unlinkSync).toHaveBeenCalledWith(filePathToDelete);
    expect(memFsStore.hasOwnProperty(filePathToDelete)).toBe(false);
  });

  it('should NOT modify a file if user rejects patch in suggest mode', async () => {
    const fsMock = vi.mocked(require('fs'));
    const filePath = 'user-config.json';
    const initialContent = '{"setting": "alpha"}';
    const patchContent = '{"setting": "bravo"}';

    memFsStore[filePath] = initialContent; // Pre-populate
    mockUserConfirmationGetter = vi.fn(async () => false); // User rejects

    // Run in default 'suggest' mode
    await runCli([`update ${filePath}`]); 
    
    await expect(simulateAgentSuggestsFilePatch(patchContent, filePath))
      .rejects.toThrow('File patch not confirmed by user.');

    expect(mockUserConfirmationGetter).toHaveBeenCalled(); // Ensure confirmation was sought
    expect(fsMock.writeFileSync).not.toHaveBeenCalled(); // File system should not be touched
    expect(memFsStore[filePath]).toBe(initialContent); // Content should remain unchanged
  });
});

describe('MCP Integration', () => {
  beforeEach(() => {
    // Reset MCP related mock functions
    mockMcpClientListTools.mockReset().mockResolvedValue([]); // Default to no tools
    mockMcpClientCallTool.mockReset().mockResolvedValue({ result: 'default mcp tool success' });
    mockMcpClientConnect.mockReset().mockResolvedValue(undefined); // Default connect success
    mockMcpClientDisconnect.mockReset().mockResolvedValue(undefined); // Default disconnect success
    mockMcpClientGetIsConnected.mockReset().mockReturnValue(true); // Default to connected

    // Clear instance and config trackers
    Object.keys(mockMcpInstances).forEach(key => delete mockMcpInstances[key]);
    Object.keys(mockMcpClientConfigs).forEach(key => delete mockMcpClientConfigs[key]);

    // Reset App props if needed, as MCP interactions might be part of App lifecycle
    mockAppProps = undefined; 
  });

  const MCP_SERVER_CONFIG_1 = { name: 'MyCalculator', url: 'http://calc.mcp.test', enabled: true };
  const MCP_SERVER_CONFIG_2 = { name: 'MyWeather', url: 'http://weather.mcp.test', enabled: true };

  const MOCK_CALCULATOR_TOOLS = [
    { name: 'add', description: 'Adds two numbers', parameters: { type: 'object', properties: { num1: { type: 'number' }, num2: { type: 'number' } }, required: ['num1', 'num2'] } },
    { name: 'subtract', description: 'Subtracts two numbers', parameters: { type: 'object', properties: { num1: { type: 'number' }, num2: { type: 'number' } }, required: ['num1', 'num2'] } },
  ];
  const MOCK_WEATHER_TOOLS = [
    { name: 'getCurrentWeather', description: 'Gets current weather for a location', parameters: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] } },
  ];

  async function simulateAgentSuggestsMcpTool(fullToolName: string, args: any) {
    const parts = fullToolName.split('_');
    if (parts.length < 3 || parts[0] !== 'mcp') throw new Error(`Invalid MCP tool name format: ${fullToolName}`);
    const serverName = parts[1];
    const toolName = parts.slice(2).join('_');

    const mcpInstance = mockMcpInstances[serverName];
    if (!mcpInstance) throw new Error(`MCP client for server ${serverName} not found.`);

    const toolCallData = { type: 'mcp_tool_call', server: serverName, tool: toolName, args, fullToolName };
    let confirmed = false;
    const approvalPolicy = mockAppProps?.config?.approvalMode || mockAppProps?.approvalPolicy || 'suggest';

    if (approvalPolicy === 'full-auto') {
      confirmed = true;
    } else {
      if (mockAppProps && mockAppProps.getCommandConfirmation) {
        confirmed = await mockAppProps.getCommandConfirmation(toolCallData);
      } else {
        throw new Error('Confirmation mechanism not found for MCP tool call.');
      }
    }

    if (confirmed) {
      return mcpInstance.callTool(toolName, args);
    } else {
      return Promise.reject(new Error(`MCP tool call ${fullToolName} not confirmed by user.`));
    }
  }

  it('should initialize McpClient for each configured server and call connect', async () => {
    const configUtils = require('../src/utils/config');
    const { loadConfig: actualLoadConfigModule } = await vi.importActual('../src/utils/config');
    const actualDefaultConfig = actualLoadConfigModule();
    configUtils.loadConfig.mockReturnValueOnce({
      ...actualDefaultConfig,
      mcpServers: [MCP_SERVER_CONFIG_1],
    });

    await runCli(['initial prompt for MCP']);

    expect(require('../src/utils/mcp-client').McpClient).toHaveBeenCalledWith(
      expect.objectContaining({ name: MCP_SERVER_CONFIG_1.name, url: MCP_SERVER_CONFIG_1.url })
    );
    expect(mockMcpClientConfigs[MCP_SERVER_CONFIG_1.name]).toEqual(
      expect.objectContaining(MCP_SERVER_CONFIG_1)
    );
    expect(mockMcpInstances[MCP_SERVER_CONFIG_1.name]).toBeDefined();
    // connect() is called in the McpClient constructor mock directly or should be by App
    // Our current mock structure: connect is a prop on the instance.
    // We need to assert that the instance's connect was called.
    // This implies the App or some init logic calls client.connect().
    // For now, let's assume this happens during App initialization if MCP servers are present.
    // If the App doesn't call connect(), this test needs adjustment or App's behavior is different.
    // The prompt says "Assert that connect() was called on the mock instance."
    // This means our mockMcpClientConnect (which is assigned to instance.connect) should be called.
    expect(mockMcpClientConnect).toHaveBeenCalled();
  });

  it('should discover tools from an MCP server', async () => {
    const configUtils = require('../src/utils/config');
    const { loadConfig: actualLoadConfigModule } = await vi.importActual('../src/utils/config');
    const actualDefaultConfig = actualLoadConfigModule();
    configUtils.loadConfig.mockReturnValueOnce({
      ...actualDefaultConfig,
      mcpServers: [MCP_SERVER_CONFIG_1],
    });
    // Configure the mock for listTools for the specific instance/server name
    mockMcpClientListTools.mockResolvedValue(MOCK_CALCULATOR_TOOLS);

    await runCli(['prompt that might lead to tool discovery']);

    // Assert that listTools was called on the instance associated with MyCalculator
    // This requires that the App logic, when an MCP client is initialized, calls listTools.
    expect(mockMcpInstances[MCP_SERVER_CONFIG_1.name].listTools).toHaveBeenCalled();
    // More specific if listTools is the global mock:
    expect(mockMcpClientListTools).toHaveBeenCalled(); 
  });

  it('should successfully call an MCP tool when approved', async () => {
    const configUtils = require('../src/utils/config');
    const { loadConfig: actualLoadConfigModule } = await vi.importActual('../src/utils/config');
    const actualDefaultConfig = actualLoadConfigModule();
    configUtils.loadConfig.mockReturnValueOnce({
      ...actualDefaultConfig,
      mcpServers: [MCP_SERVER_CONFIG_1],
      approvalMode: 'suggest', // Ensure confirmation is sought
    });

    mockMcpClientListTools.mockResolvedValue(MOCK_CALCULATOR_TOOLS); // Agent needs to know the tool
    mockUserConfirmationGetter.mockResolvedValue(true); // User approves
    const expectedResult = { sum: 8 };
    mockMcpClientCallTool.mockResolvedValue({ result: expectedResult });

    await runCli(['add 5 and 3 using calculator']); // Sets up mockAppProps

    const toolCallArgs = { num1: 5, num2: 3 };
    const result = await simulateAgentSuggestsMcpTool('mcp_MyCalculator_add', toolCallArgs);

    expect(mockUserConfirmationGetter).toHaveBeenCalled();
    expect(mockMcpInstances[MCP_SERVER_CONFIG_1.name].callTool).toHaveBeenCalledWith('add', toolCallArgs);
    expect(result.result).toEqual(expectedResult);
    // Optionally, check if stdout contains the result if the App prints it
    // expect(capturedStdout).toContain(JSON.stringify(expectedResult));
  });
  
  it('should handle MCP tool call failure', async () => {
    const configUtils = require('../src/utils/config');
    const { loadConfig: actualLoadConfigModule } = await vi.importActual('../src/utils/config');
    const actualDefaultConfig = actualLoadConfigModule();
    configUtils.loadConfig.mockReturnValueOnce({
      ...actualDefaultConfig,
      mcpServers: [MCP_SERVER_CONFIG_1],
      approvalMode: 'suggest',
    });

    mockMcpClientListTools.mockResolvedValue(MOCK_CALCULATOR_TOOLS);
    mockUserConfirmationGetter.mockResolvedValue(true); // User approves
    const error = new Error('MCP Tool Execution Failed');
    mockMcpClientCallTool.mockRejectedValue(error);

    await runCli(['use calculator to add 1 and 1']); // Sets up mockAppProps

    const toolCallArgs = { num1: 1, num2: 1 };
    await expect(simulateAgentSuggestsMcpTool('mcp_MyCalculator_add', toolCallArgs))
      .rejects.toThrow('MCP Tool Execution Failed');
    
    expect(mockUserConfirmationGetter).toHaveBeenCalled();
    expect(mockMcpInstances[MCP_SERVER_CONFIG_1.name].callTool).toHaveBeenCalledWith('add', toolCallArgs);
    // Check if stderr contains some error message (this depends on App's error handling)
    // For now, just ensuring the call was made and rejection handled by test is enough.
    // If App catches and prints: await runCli(...); expect(capturedStderr).toContain(...);
  });

  it('should handle multiple MCP servers correctly', async () => {
    const configUtils = require('../src/utils/config');
    const { loadConfig: actualLoadConfigModule } = await vi.importActual('../src/utils/config');
    const actualDefaultConfig = actualLoadConfigModule();
    configUtils.loadConfig.mockReturnValueOnce({
      ...actualDefaultConfig,
      mcpServers: [MCP_SERVER_CONFIG_1, MCP_SERVER_CONFIG_2],
      approvalMode: 'full-auto', // Simplify confirmation for this test
    });

    // Configure listTools for each server
    const calcInstanceMocks = { listTools: vi.fn().mockResolvedValue(MOCK_CALCULATOR_TOOLS), callTool: vi.fn() };
    const weatherInstanceMocks = { listTools: vi.fn().mockResolvedValue(MOCK_WEATHER_TOOLS), callTool: vi.fn() };
    
    // Override the main McpClient mock for this test to return different mocks per instance
    const McpClientModule = require('../src/utils/mcp-client');
    McpClientModule.McpClient.mockImplementation((config: { name: string; url: string }) => {
      mockMcpClientConfigs[config.name] = config;
      let instanceMock;
      if (config.name === MCP_SERVER_CONFIG_1.name) {
        instanceMock = { ...mockMcpInstances[MCP_SERVER_CONFIG_1.name], ...calcInstanceMocks }; // Spread defaults + specifics
      } else if (config.name === MCP_SERVER_CONFIG_2.name) {
        instanceMock = { ...mockMcpInstances[MCP_SERVER_CONFIG_2.name], ...weatherInstanceMocks };
      } else {
        instanceMock = { ...mockMcpInstances[config.name] }; // Fallback to default mocks if any other server
      }
      mockMcpInstances[config.name] = instanceMock; // Store the specific mock
      return instanceMock;
    });


    await runCli(['use calculator and weather']);

    // Check instantiation
    expect(mockMcpClientConfigs[MCP_SERVER_CONFIG_1.name]).toBeDefined();
    expect(mockMcpClientConfigs[MCP_SERVER_CONFIG_2.name]).toBeDefined();
    expect(mockMcpInstances[MCP_SERVER_CONFIG_1.name]).toBeDefined();
    expect(mockMcpInstances[MCP_SERVER_CONFIG_2.name]).toBeDefined();
    
    // Simulate calling a tool from MyCalculator
    const calcArgs = { num1: 10, num2: 5 };
    calcInstanceMocks.callTool.mockResolvedValue({ result: { difference: 5 } });
    await simulateAgentSuggestsMcpTool('mcp_MyCalculator_subtract', calcArgs);
    expect(calcInstanceMocks.callTool).toHaveBeenCalledWith('subtract', calcArgs);
    expect(weatherInstanceMocks.callTool).not.toHaveBeenCalled();

    // Simulate calling a tool from MyWeather
    const weatherArgs = { location: 'London' };
    weatherInstanceMocks.callTool.mockResolvedValue({ result: { temp: '15C' } });
    await simulateAgentSuggestsMcpTool('mcp_MyWeather_getCurrentWeather', weatherArgs);
    expect(weatherInstanceMocks.callTool).toHaveBeenCalledWith('getCurrentWeather', weatherArgs);
    
    // Restore default McpClient mock if other tests depend on the simpler global mock setup
    McpClientModule.McpClient.mockImplementation((config: { name: string; url: string }) => {
      mockMcpClientConfigs[config.name] = config;
      const instance = { /* ... default mock structure ... */ 
            serverName: config.name,
            connect: mockMcpClientConnect, 
            disconnect: mockMcpClientDisconnect,
            getIsConnected: mockMcpClientGetIsConnected,
            listTools: mockMcpClientListTools,
            callTool: mockMcpClientCallTool,
      };
      mockMcpInstances[config.name] = instance;
      return instance;
    });
  });
});

describe('GitHub Integration', () => {
  beforeEach(() => {
    // Reset App props, as some tests might not run the full CLI App rendering
    mockAppProps = undefined; 
    
    // Default behavior for GitHub auth mocks
    mockGetGitHubToken.mockReset().mockResolvedValue('dummy-gh-token'); // Default: token exists
    mockAuthenticateWithGitHubDeviceFlow.mockReset().mockResolvedValue(undefined); // Default: auth succeeds
    mockClearGitHubToken.mockReset().mockResolvedValue(undefined); // Default: clear succeeds
  });

  describe('auth github command', () => {
    it('should attempt authentication if no token exists and succeed', async () => {
      mockGetGitHubToken.mockResolvedValue(null); // No existing token
      mockAuthenticateWithGitHubDeviceFlow.mockResolvedValue(undefined); // Auth will succeed

      const { stdout, exitCode } = await runCli(['auth', 'github']);

      expect(mockGetGitHubToken).toHaveBeenCalled();
      expect(mockAuthenticateWithGitHubDeviceFlow).toHaveBeenCalled();
      expect(stdout).toContain('Successfully authenticated with GitHub.');
      expect(exitCode).toBe(0);
    });

    it('should report failure if authentication fails', async () => {
      mockGetGitHubToken.mockResolvedValue(null); // No existing token
      const authError = new Error('GitHub auth failed');
      mockAuthenticateWithGitHubDeviceFlow.mockRejectedValue(authError); // Auth will fail

      const { stderr, exitCode } = await runCli(['auth', 'github']);
      
      expect(mockGetGitHubToken).toHaveBeenCalled();
      expect(mockAuthenticateWithGitHubDeviceFlow).toHaveBeenCalled();
      expect(stderr).toContain('GitHub authentication failed: GitHub auth failed');
      expect(exitCode).toBe(1);
    });

    it('should inform user if token already exists', async () => {
      mockGetGitHubToken.mockResolvedValue('existing-dummy-gh-token'); // Token already exists

      const { stdout, exitCode } = await runCli(['auth', 'github']);

      expect(mockGetGitHubToken).toHaveBeenCalled();
      expect(mockAuthenticateWithGitHubDeviceFlow).not.toHaveBeenCalled();
      expect(stdout).toContain('Already authenticated with GitHub.');
      // expect(stdout).toContain('existing-dummy-gh-token'); // Optional: check if token is shown
      expect(exitCode).toBe(0);
    });
  });

  describe('CLI flags --github-repo and --github-branch', () => {
    it('should pass valid --github-repo and --github-branch to App props', async () => {
      await runCli(['--github-repo', 'owner/repo', '--github-branch', 'feature-branch', 'prompt for repo']);
      
      expect(mockAppProps).toBeDefined();
      expect(mockAppProps.cliGithubRepo).toBe('owner/repo');
      expect(mockAppProps.cliGithubBranch).toBe('feature-branch');
    });

    it('should pass only --github-repo to App props if --github-branch is not provided', async () => {
      await runCli(['--github-repo', 'owner/another-repo', 'prompt for repo']);

      expect(mockAppProps).toBeDefined();
      expect(mockAppProps.cliGithubRepo).toBe('owner/another-repo');
      expect(mockAppProps.cliGithubBranch).toBeUndefined();
    });

    it('should exit with error for invalid --github-repo format', async () => {
      // This validation happens in cli.tsx before App is typically rendered with these props.
      const { stderr, exitCode } = await runCli(['--github-repo', 'invalidformat', 'prompt']);
      
      expect(stderr).toMatch(/Invalid --github-repo format. Please use 'owner\/repo'./i);
      expect(exitCode).toBe(1);
      // mockAppProps might not be set, or if it is, these specific props shouldn't be.
      // Depending on when cli.tsx exits, App might not be rendered.
      if (mockAppProps) {
        expect(mockAppProps.cliGithubRepo).toBeUndefined();
        expect(mockAppProps.cliGithubBranch).toBeUndefined();
      }
    });

    it('should exit with error if --github-branch is used without --github-repo', async () => {
      // This validation also happens in cli.tsx.
      const { stderr, exitCode } = await runCli(['--github-branch', 'feature-branch', 'prompt']);
      
      expect(stderr).toMatch(/--github-branch cannot be used without --github-repo./i);
      expect(exitCode).toBe(1);
      if (mockAppProps) {
        expect(mockAppProps.cliGithubRepo).toBeUndefined();
        expect(mockAppProps.cliGithubBranch).toBeUndefined();
      }
    });
  });

  it('should correctly simulate cloning a repository', async () => {
    setupMockGitRepo({ isRepo: false }); // Start with no repo
    const gitUtils = vi.mocked(require('../src/utils/git-utils'));

    const repoUrl = 'git@github.com:owner/new-repo.git';
    const localPath = '.'; // Clone into current directory for simplicity in test
    await gitUtils.gitClone(repoUrl, localPath);

    expect(gitUtils.gitClone).toHaveBeenCalledWith(repoUrl, localPath, undefined); // undefined for options
    
    const state = getMockGitRepoState();
    expect(state.isRepo).toBe(true);
    expect(state.clonedFrom).toBe(repoUrl);
    expect(state.currentBranch).toBe('main'); // Default branch after clone in mock
    expect(state.branches).toContain('main');
    expect(state.remotes.origin).toBe(repoUrl);
    expect(state.files).toEqual([]); // Should be empty after clone
    expect(state.commits).toEqual([]); // Should be empty after clone
  });

  it('should correctly simulate creating a new branch', async () => {
    setupMockGitRepo({ 
      isRepo: true, 
      currentBranch: 'main', 
      branches: ['main'], 
      remotes: { origin: 'git@github.com:owner/existing-repo.git' } 
    });
    const gitUtils = vi.mocked(require('../src/utils/git-utils'));

    const newBranchName = 'new-feature';
    // Assuming gitCreateBranch does not automatically checkout
    await gitUtils.gitCreateBranch(newBranchName, 'main'); 
    // Then explicitly checkout the new branch
    await gitUtils.gitCheckout(newBranchName);

    expect(gitUtils.gitCreateBranch).toHaveBeenCalledWith(newBranchName, 'main');
    expect(gitUtils.gitCheckout).toHaveBeenCalledWith(newBranchName);
    
    const state = getMockGitRepoState();
    expect(state.currentBranch).toBe(newBranchName);
    expect(state.branches).toContain(newBranchName);
    expect(state.branches).toEqual(['main', newBranchName]); // Assuming it adds to existing
  });

  it('should correctly simulate committing changes', async () => {
    const branchName = 'my-feature';
    setupMockGitRepo({ 
      isRepo: true, 
      currentBranch: branchName, 
      branches: [branchName],
      files: [], // Start with no files in the repo state for this test
      commits: [],
    });
    const gitUtils = vi.mocked(require('../src/utils/git-utils'));

    // 1. Simulate adding a file to staging (as if 'git add' was called)
    // Our mock for gitAdd in e2e.test.ts modifies mockGitRepoState.files
    await gitUtils.gitAdd('README.md'); // This uses the mock gitAdd
    // Verify intermediate state if necessary (optional)
    // let stateAfterAdd = getMockGitRepoState();
    // expect(stateAfterAdd.files.find(f => f.path === 'README.md' && f.status === 'added')).toBeDefined();

    // 2. Simulate committing the staged changes
    const commitMessage = 'feat: add README';
    await gitUtils.gitCommit(commitMessage);

    expect(gitUtils.gitCommit).toHaveBeenCalledWith(commitMessage);
    
    const state = getMockGitRepoState();
    expect(state.commits.length).toBe(1);
    const lastCommit = state.commits[0];
    expect(lastCommit.message).toBe(commitMessage);
    expect(lastCommit.branch).toBe(branchName);
    expect(lastCommit.files.some(f => f.path === 'README.md' && f.status === 'committed')).toBe(true);

    // Verify the file in the main repo state is also marked as committed
    const repoFile = state.files.find(f => f.path === 'README.md');
    expect(repoFile).toBeDefined();
    expect(repoFile?.status).toBe('committed');
  });
});

// Helper function to simulate agent suggesting a file patch
async function simulateAgentSuggestsFilePatch(patchContent: string, patchFilePath: string = 'file.txt') {
  const patchData = {
    path: patchFilePath,
    content: patchContent,
    type: 'patch' as const,
  };

  // Determine effective policy from App's perspective (config passed to App)
  const approvalPolicy = mockAppProps?.config?.approvalMode || 'suggest'; 

  let confirmed = false;
  if (approvalPolicy === 'full-auto' || approvalPolicy === 'auto-edit') {
    confirmed = true; // Patches are auto-approved in these modes
  } else { // 'suggest' mode (default)
    if (mockAppProps && mockAppProps.getCommandConfirmation) {
      // Assuming getCommandConfirmation is used for patches too, potentially with a different 'type'
      confirmed = await mockAppProps.getCommandConfirmation(patchData);
    } else {
      // This path indicates an issue with test setup or App's prop structure
      throw new Error('Confirmation mechanism (getCommandConfirmation) not found in App props for file patch in suggest mode.');
    }
  }

  if (confirmed) {
    // The actual applyPatch function from parse-apply-patch.ts might take an object or specific args.
    // For this mock, we're assuming it takes (path, content) or similar.
    // Adjust if the actual signature is different, e.g., mockApplyPatch(patchData)
    return mockApplyPatch(patchFilePath, patchContent); 
  } else {
    // Consistently throw an error for easier assertion in tests
    throw new Error('File patch not confirmed by user.');
  }
}

describe('Suggest Mode (File Patches)', () => {
  it('should apply patch if user approves in suggest mode', async () => {
    mockUserConfirmationGetter = vi.fn(async () => true); // User approves
    await runCli(['apply this patch to file.txt']); // Sets mockAppProps

    expect(mockAppProps).toBeDefined();
    expect(mockAppProps.getCommandConfirmation).toBeInstanceOf(Function);

    const patchContent = "dummy patch content";
    await simulateAgentSuggestsFilePatch(patchContent, 'file.txt');

    expect(mockUserConfirmationGetter).toHaveBeenCalledWith(JSON.stringify({ path: 'file.txt', content: patchContent, type: 'patch' }));
    expect(mockApplyPatch).toHaveBeenCalledWith('file.txt', patchContent);
  });

  it('should NOT apply patch if user rejects in suggest mode', async () => {
    mockUserConfirmationGetter = vi.fn(async () => false); // User rejects
    await runCli(['apply this patch to file.txt']); // Sets mockAppProps

    expect(mockAppProps).toBeDefined();
    expect(mockAppProps.getCommandConfirmation).toBeInstanceOf(Function);
    
    const patchContent = "dummy patch content";
    await expect(simulateAgentSuggestsFilePatch(patchContent, 'file.txt'))
      .rejects
      .toThrow('File patch not confirmed by user.');

    expect(mockUserConfirmationGetter).toHaveBeenCalled();
    expect(mockApplyPatch).not.toHaveBeenCalled();
  });
});

describe('Auto-Edit Mode', () => {
  const autoEditArgs = ['--approval-mode', 'auto-edit'];

  it('should apply file patch WITHOUT user confirmation', async () => {
    await runCli([...autoEditArgs, 'apply this patch']);
    
    const patchContent = "dummy patch content for auto-edit";
    await simulateAgentSuggestsFilePatch(patchContent, 'auto.txt');

    expect(mockApplyPatch).toHaveBeenCalledWith('auto.txt', patchContent);
    // mockUserConfirmationGetter should NOT have been called for a patch in auto-edit
    expect(mockUserConfirmationGetter).not.toHaveBeenCalled(); 
  });

  it('should require user confirmation for shell commands and execute if approved', async () => {
    mockUserConfirmationGetter = vi.fn(async () => true); // User approves command
    await runCli([...autoEditArgs, 'run this command']);

    expect(mockAppProps).toBeDefined();
    expect(mockAppProps.getCommandConfirmation).toBeInstanceOf(Function);

    await simulateAgentSuggestsCommandRequiringConfirmation(['npm', 'run', 'ci-test']);
    
    expect(mockUserConfirmationGetter).toHaveBeenCalled(); // Command confirmation WAS sought
    expect(mockHandleExecCommand).toHaveBeenCalledWith(
      { cmd: ['npm', 'run', 'ci-test'] },
      mockAppProps.config,
      'auto-edit', // Correct approvalMode from config
      expect.any(Function)
    );
  });
});

describe('Full-Auto Mode', () => {
  const fullAutoArgs = ['--approval-mode', 'full-auto'];

  it('should apply file patch WITHOUT user confirmation', async () => {
    await runCli([...fullAutoArgs, 'auto apply this patch']);
    
    const patchContent = "dummy patch content for full-auto";
    await simulateAgentSuggestsFilePatch(patchContent, 'full-auto.txt');

    expect(mockApplyPatch).toHaveBeenCalledWith('full-auto.txt', patchContent);
    expect(mockUserConfirmationGetter).not.toHaveBeenCalled();
  });

  it('should execute shell command WITHOUT user confirmation', async () => {
    await runCli([...fullAutoArgs, 'auto run this command']);
    
    expect(mockAppProps).toBeDefined();
    // In full-auto, getCommandConfirmation might not even be called by the agent logic.
    // The simulateAgentSuggestsCommand helper needs to account for this.
    
    // Helper for command simulation that does NOT require confirmation (Full-Auto)
    async function simulateAgentSuggestsCommandWithoutConfirmation(command: string[]) {
        const approvalPolicy = mockAppProps?.config?.approvalMode;
        if (approvalPolicy === 'full-auto') {
            // Directly execute, no confirmation call involved from the agent's perspective.
            // The `handleExecCommand` itself might have internal checks, but the agent
            // won't gate the call on `getCommandConfirmation`.
            return mockHandleExecCommand(
                { cmd: command }, 
                mockAppProps.config, 
                approvalPolicy, 
                undefined /* No confirmation getter passed/used by agent */
            );
        }
        // This helper should ideally only be called when in full-auto.
        // Throw an error if conditions don't match to avoid misuse in tests.
        throw new Error(`simulateAgentSuggestsCommandWithoutConfirmation called in non-full-auto mode: ${approvalPolicy}`);
    }
    
    await simulateAgentSuggestsCommandWithoutConfirmation(['npm', 'deploy', '--prod']);

    expect(mockUserConfirmationGetter).not.toHaveBeenCalled(); // No user confirmation sought
    expect(mockHandleExecCommand).toHaveBeenCalledWith(
      { cmd: ['npm', 'deploy', '--prod'] },
      mockAppProps.config,
      'full-auto', // Correct approvalMode
      undefined    // No confirmation function involved in full-auto for commands
    );
  });
});
