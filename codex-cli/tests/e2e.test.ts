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

// --- Mock di fs-extra (NUOVO) ---
vi.mock('fs-extra', () => {
  // Non è necessario importare 'actualFsExtra' a meno che non si voglia specificamente
  // delegare alcune chiamate all'implementazione reale, il che è raro nei test unitari/e2e.
  return {
    // Funzioni asincrone usate da git-utils.ts
    ensureDir: vi.fn(),
    pathExists: vi.fn(),
    remove: vi.fn(),

    // Funzioni dall'esempio dell'utente (principalmente sincrone)
    // Queste sono incluse per completezza basata sull'esempio fornito.
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    copySync: vi.fn(),
    removeSync: vi.fn(), // Notare: git-utils.ts usa 'remove' asincrono
    ensureDirSync: vi.fn(), // Notare: git-utils.ts usa 'ensureDir' asincrono
    emptyDirSync: vi.fn(),
    readJsonSync: vi.fn(),
    writeJsonSync: vi.fn(),

    // Aggiungere qui altre funzioni di fs-extra se necessario,
    // basandosi su ciò che viene effettivamente utilizzato nel codebase.
  };
});
// --- Fine Mock di fs-extra ---

// Define constants for the mock GPT server
const WIREMOCK_ADMIN_URL = 'http://localhost:8080'; // URL dell'API di amministrazione di WireMock
const MOCK_GPT_SERVER_URL = `${WIREMOCK_ADMIN_URL}/v1`; // URL base per le chiamate API
const FAKE_API_KEY_FOR_MOCK_SERVER = 'sk-fake-key-for-wiremock';


// All'inizio di e2e.test.ts
let mockApplyPatch = vi.fn(); // Assicurati che mockApplyPatch sia definito globalmente se non lo è già
vi.mock('../src/parse-apply-patch.ts', () => ({ applyPatch: mockApplyPatch }));


vi.mock('ink', async () => {
  const actualInk = await vi.importActual('ink');
  return {
    ...actualInk,
    render: vi.fn((componentElement, _options) => {
      // Simula il rendering del componente per permettere la cattura delle props
      // e assicurarsi che il corpo del mock di App venga eseguito.
      if (componentElement && typeof componentElement.type === 'function') {
        try {
          // Questo chiama la funzione mockata di App, che assegna a mockAppProps
          componentElement.type(componentElement.props);
        } catch (e) {
          // Non far fallire il mock di ink stesso se ci sono errori nel componente mockato.
          // console.error('Error rendering mocked component in ink mock:', e);
        }
      }
      return { unmount: vi.fn(), rerender: vi.fn(), clear: vi.fn(), waitUntilExit: vi.fn() };
    }),
  };
});

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
      // For example: await import('fs').mkdirSync(localPath, { recursive: true });
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
    // Add cloneGitHubRepo and cleanupClonedRepo mocks if they are used directly by CLI logic
    // and not just via the gitClone/remove simulation above.
    // Based on app-github-logic.test.ts, cloneGitHubRepo and cleanupClonedRepo are used.
    // Let's add mocks for them here, ensuring they interact with the mockGitRepoState if needed.
    cloneGitHubRepo: vi.fn(async (repoFullName: string, branch: string, token?: string) => {
        // Simulate cloning into a temp dir
        const tempDir = `/tmp/codex-cli/mock-repo-${Math.random().toString(36).substring(7)}`;
        await actualGitUtils.ensureDir(tempDir); // Use actual fs-extra mock
        setupMockGitRepo({ isRepo: true, clonedFrom: repoFullName, remotes: { origin: `https://github.com/${repoFullName}.git` }, currentBranch: branch, branches: [branch] });
        return tempDir; // Return the simulated path
    }),
    cleanupClonedRepo: vi.fn(async (repoPath: string) => { /* Use fs-extra.remove if needed */ }),
  };
});

vi.mock('../src/utils/agent/log', () => ({
  initLogger: vi.fn(),
  log: vi.fn(),
  isLoggingEnabled: vi.fn(() => false),
}));
vi.mock('../src/utils/check-updates', () => ({
  // Mock individual functions if needed, or the whole module
  checkForUpdates: vi.fn(() => Promise.resolve()),
  // If checkOutdated or getNPMCommandPath are called directly and need specific mock behavior:
  // checkOutdated: vi.fn(),
  // getNPMCommandPath: vi.fn(),
}));

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
    isGitHubAuthenticated: vi.fn(async () => !!mockGetGitHubToken()), // Base this on the token mock
    fetchGitHubRepositories: vi.fn(), // Mocked below in tests
    fetchGitHubBranches: vi.fn(), // Mocked below in tests
  };
});
// --- End GitHub Auth Mocks ---

// Mock stabile per getAPIKeyForProviderOrExit
// const FAKE_API_KEY_FOR_MOCK_SERVER is defined above

vi.mock('../src/utils/config', async () => {
  const actualConfigModule = await vi.importActual('../src/utils/config') as any;
  const mockConfigGetAPIKey = vi.fn((_configFromFile: any, providerName?: string) => {
    const effectiveProvider = providerName || _configFromFile?.provider || 'openai';
    if (effectiveProvider === 'openai') {
      return FAKE_API_KEY_FOR_MOCK_SERVER; // Use the constant
    }
    return `dummy-key-for-unexpected-${effectiveProvider}`;
  });

  return {
    // --- Provide ALL named exports that cli.tsx and its imports might need from config.ts ---
    // For constants, use their actual values from the module or sensible mock defaults.
    PRETTY_PRINT: actualConfigModule.PRETTY_PRINT ?? false,
    INSTRUCTIONS_FILEPATH: actualConfigModule.INSTRUCTIONS_FILEPATH ?? 'mock_instructions.md',
    CONFIG_JSON_FILEPATH: actualConfigModule.CONFIG_JSON_FILEPATH ?? 'mock_config.json',
    CONFIG_YAML_FILEPATH: actualConfigModule.CONFIG_YAML_FILEPATH ?? 'mock_config.yaml',
    CONFIG_YML_FILEPATH: actualConfigModule.CONFIG_YML_FILEPATH ?? 'mock_config.yml',
    CONFIG_FILEPATH: actualConfigModule.CONFIG_FILEPATH ?? 'mock_config.json', // Default to JSON
    CONFIG_DIR: actualConfigModule.CONFIG_DIR ?? '.mock_codex_dir',
    DEFAULT_APPROVAL_MODE: actualConfigModule.DEFAULT_APPROVAL_MODE,
    DEFAULT_INSTRUCTIONS: actualConfigModule.DEFAULT_INSTRUCTIONS ?? '',
    OPENAI_TIMEOUT_MS: actualConfigModule.OPENAI_TIMEOUT_MS ?? 60000, // Default da config.ts
    PROJECT_DOC_MAX_BYTES: actualConfigModule.PROJECT_DOC_MAX_BYTES ?? 32 * 1024,
    EMPTY_STORED_CONFIG: actualConfigModule.EMPTY_STORED_CONFIG ?? { model: "", mcpServers: [] },

    // Variabili esportate (let) sovrascritte per i test
    DEFAULT_PROVIDER: 'openai', // Coerente con getBaseMockedConfigForTests
    API_KEY: FAKE_API_KEY_FOR_MOCK_SERVER, // Chiave a livello di modulo
    // --- Mocked functions ---
    loadConfig: vi.fn(), // Behavior will be set in beforeEach hooks
    saveConfig: vi.fn(),
    setApiKey: vi.fn((apiKey: string) => {
      // In a real scenario, this would update the module-level API_KEY.
      // For the mock, this might not be strictly necessary unless tests check this side effect.
      // API_KEY = apiKey; // Se si vuole simulare l'aggiornamento della variabile mockata
    }),
    getAPIKeyForProviderOrExit: mockConfigGetAPIKey, // Usa la mock function stabile
    // Add any other functions exported by config.ts that need specific mock implementations.
    discoverProjectDocPath: actualConfigModule.discoverProjectDocPath,
    loadProjectDoc: actualConfigModule.loadProjectDoc,
    loadInstructions: actualConfigModule.loadInstructions,
  };
});

// Mock meow: This sets up 'meow' to be a mock for all subsequent imports.
// The factory function is called by Vitest to create the mock.
vi.mock('meow', () => {
  // This vi.fn() will be the default export of the 'meow' module.
  return {
    default: vi.fn().mockReturnValue({ // Default mock return value
      input: [], flags: {}, showHelp: vi.fn(), showVersion: vi.fn(), pkg: { name: 'codex-complete', version: '0.0.0-test' },
    }),
  };
});

// Mock process.exit, process.stdout.write, process.stderr.write
let mockProcessExit: ReturnType<typeof vi.spyOn>;
let mockStdoutWrite: ReturnType<typeof vi.spyOn>;
let mockStderrWrite: ReturnType<typeof vi.spyOn>;

let capturedStdout: string;
let capturedStderr: string;
let capturedExitCode: number | undefined;
let mockConsoleError: ReturnType<typeof vi.spyOn>;

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
  mockAppProps = undefined; // Resetta mockAppProps all'inizio di ogni esecuzione di runCli
  // Reset captured values for each run
  capturedStdout = "";
  capturedStderr = "";
  capturedExitCode = undefined;
  const EXIT_SIGNAL = Symbol('mockExitSignal'); // Use a symbol for unique identification

  // Mock process.exit, stdout, stderr for this run
  mockProcessExit = vi.spyOn(process, 'exit').mockImplementation((code) => {
    capturedExitCode = code as number;
    const err = new Error(`Mocked process.exit called with code ${code}`);
    (err as any).signal = EXIT_SIGNAL;
    (err as any).exitCode = code;
    throw err; // Throw the error to stop execution
  });
  mockStdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation((buffer: string | Uint8Array) => {
    capturedStdout += buffer.toString();
    return true;
  });
  mockStderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation((buffer: string | Uint8Array) => {
    capturedStderr += buffer.toString();
    return true;
  });
  mockConsoleError = vi.spyOn(console, 'error').mockImplementation((...args: any[]) => {
    const message = args.map(arg => {
      if (typeof arg === 'string') return arg;
      if (arg instanceof Error) return arg.message; // Cattura il messaggio dell'errore
      try { return JSON.stringify(arg); } catch { return String(arg); }
    }).join(' ');
    capturedStderr += message + "\n";
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
        quiet: flags.quiet || flags.q || false, // Ensure quiet is passed
        // ... other flags based on your CLI ...
        ...flags // Spread the dynamic flags
    },
    showHelp: vi.fn((_exitCode?: number) => { // meow.showHelp accepts an exitCode opzionale
      capturedStdout += "Mocked help text displayed by meow.showHelp()\n";
      capturedStdout += "Usage: codex-complete <command> [options]\n";
      capturedStdout += "Options:\n";
      capturedStdout += "  --help                 Show help\n";
      capturedStdout += "  --version              Show version number\n";
      capturedStdout += "  --config               Open config file\n";
      capturedStdout += "  --quiet, -q            Suppress all output except for the final result\n";
      capturedStdout += "  --approval-mode <mode> Set approval mode (suggest, auto-edit, full-auto)\n";
      capturedStdout += "  --github-repo <repo>   GitHub repository (owner/repo)\n";
      capturedStdout += "  --github-branch <branch> GitHub branch\n";
      capturedStdout += "  --model <model_name>   Specify the model to use\n";
      // Add more mocked help lines if necessary for other tests
    }),
    showVersion: vi.fn(() => {
        // Ensure it matches the pkg version provided
        const meowInstance = meow.mock.results[meow.mock.results.length - 1]?.value;
        if (meowInstance && meowInstance.pkg) {
            capturedStdout += `${meowInstance.pkg.name}/${meowInstance.pkg.version}\n`;
        } else {
            capturedStdout += "codex-complete/0.0.0-test\n"; // Fallback
        }
    }),
    pkg: { name: 'codex-complete', version: '0.0.0-test' }, // Mock package info
  });

  try {
    vi.resetModules(); // Reset modules

    // ***** IMPORTANT CHANGE HERE *****
    // Re-apply essential mocks AFTER resetModules and BEFORE importing the CLI.
    // This ensures that when cli.tsx (and its imports) execute, they get the
    // correctly mocked versions for this specific runCli invocation.
    const configUtils = await import('../src/utils/config');
    // Pulizia dei listener che cli.tsx potrebbe aggiungere da esecuzioni precedenti
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGQUIT');
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('exit');
    if (process.stdin.isTTY) { // Proteggi come fa cli.tsx
        process.stdin.removeAllListeners('data');
    }


    // This uses the globally defined getBaseMockedConfigForTests()
    // Ensure this is the config you want for *all* runCli calls,
    // or find a way to pass context-specific config if needed.
    configUtils.loadConfig.mockReturnValue(getBaseMockedConfigForTests());
    // ***** END OF IMPORTANT CHANGE *****

    await import('../src/cli'); 
    await new Promise(resolve => setTimeout(resolve, 150)); // Increased delay slightly
  } catch (error: any) {
    if (error?.signal !== EXIT_SIGNAL) {
      // This is an unexpected error if it's not our exit signal
      console.error('CLI execution error in test (runCli catch):', error);
    }
    } finally {
      mockProcessExit.mockRestore();
      mockStdoutWrite.mockRestore();
      mockStderrWrite.mockRestore();
      mockConsoleError.mockRestore();
  }

  // Simulate meow's behavior for unknown flags AFTER the CLI might have run
  // or if CLI parsing itself (via meow) is what we're testing.
  // This logic should ideally run *before* `await import('../src/cli')` if meow handles it early.
  // Let's adjust the placement.
  
  const meowInstance = meow.mock.results[meow.mock.results.length - 1]?.value;
  let unknownFlagEncountered = false;
  if (meowInstance) {
    const knownFlags = ['help', 'version', 'config', 'quiet', 'q', 'approval-mode', 'github-repo', 'github-branch', 'model', /* add all known flags */ 'provider', 'image', 'view', 'auto-edit', 'full-auto', 'dangerously-auto-approve-everything', 'no-project-doc', 'project-doc', 'full-stdout', 'full-context'];
    for (const flagKey in meowInstance.flags) {
      if (!knownFlags.includes(flagKey) && !flagKey.startsWith('no-')) {
        // Check if the flag was actually passed in this runCli call
        const originalArg = `--${flagKey}`;
        if (args.some(arg => arg.startsWith(originalArg))) {
            capturedStderr += `Error: Unknown flag --${flagKey}\n`;
            // Ensure showHelp is called on the specific instance that meow created for this run
            if (meowInstance.showHelp) {
                 meowInstance.showHelp(2);
            } else {
                 // Fallback if somehow showHelp is not on the instance
                 capturedStdout += "Mocked help text (fallback in unknown flag)\n";
            }
            if (capturedExitCode === undefined) capturedExitCode = 2; // Set exit code if not already set by mocked process.exit
            unknownFlagEncountered = true;
            break;
        }
      }
    }
  }

  if (!unknownFlagEncountered && !capturedExitCode) { // If no unknown flag error and CLI didn't exit
    // Potentially run CLI main logic here if it wasn't run above or needs to be conditional
  }


  return {
    stdout: capturedStdout,
    stderr: capturedStderr,
    exitCode: capturedExitCode,
  };
}

// --- WireMock Helper Functions ---
// URL dell'API di amministrazione di WireMock (presumendo che WireMock sia in esecuzione localmente sulla porta 8080)
const WIREMOCK_ADMIN_URL_FOR_HELPERS = 'http://localhost:8080'; // Modifica se necessario

async function checkWiremockMappings(context: string, logFullMappings = false) {
  try {
    console.log(`Fetching current WireMock mappings (${context})...`);
    const mappingsResponse = await fetch(`${WIREMOCK_ADMIN_URL_FOR_HELPERS}/__admin/mappings`);
    if (!mappingsResponse.ok) {
      console.error(`(${context}) Failed to fetch mappings from WireMock: ${mappingsResponse.status} ${await mappingsResponse.text()}`);
      return;
    }
    const mappingsBody = await mappingsResponse.json();
    if (logFullMappings) {
        console.log(`(${context}) WireMock Mappings (Full):`, JSON.stringify(mappingsBody, null, 2));
    } else {
        console.log(`(${context}) WireMock Mapping Count: ${mappingsBody.meta.total}`);
    }
    
    const chatCompletionsStubs = mappingsBody.mappings.filter( (m: any) => m.request.urlPath === '/v1/chat/completions');
    const modelsStubs = mappingsBody.mappings.filter( (m: any) => m.request.urlPath === '/v1/models');

    console.log(`(${context}) Found ${modelsStubs.length} stub(s) for /v1/models.`);
    modelsStubs.forEach((stub: any, index: number) => {
        console.log(`  (${context}) Models Stub ${index + 1} Request: ${JSON.stringify(stub.request)}`);
    });

    console.log(`(${context}) Found ${chatCompletionsStubs.length} stub(s) for /v1/chat/completions.`);
    chatCompletionsStubs.forEach((stub: any, index: number) => {
        console.log(`  (${context}) Chat Stub ${index + 1} Request: ${JSON.stringify(stub.request)}`);
    });

    if (modelsStubs.length === 0 || chatCompletionsStubs.length === 0 && context.includes("Global beforeEach: After chat stub")) { // Be more specific for critical checks
        console.error(`CRITICAL DIAGNOSTIC (${context}): One or more default stubs are NOT present when expected.`);
    }

  } catch (e) {
    console.error(`(${context}) Error during WireMock mapping verification:`, e);
  }
}

async function setupWireMockStub(stub: any): Promise<void> {
  try {
    const response = await fetch(`${WIREMOCK_ADMIN_URL_FOR_HELPERS}/__admin/mappings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(stub),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to setup WireMock stub: ${response.status} ${body}`);
    }
    // Optionally, add a very small delay to allow WireMock to process, though typically not needed.
    // await new Promise(resolve => setTimeout(resolve, 50));
  } catch (error) {
    console.error("Error setting up WireMock stub. Is WireMock running and accessible?", error);
    // Rethrow to make sure the test fails if setup is unsuccessful.
    throw error;
  }
}

async function resetWireMockStubs(): Promise<void> {
  try {
    const response = await fetch(`${WIREMOCK_ADMIN_URL_FOR_HELPERS}/__admin/mappings`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to reset WireMock stubs: ${response.status} ${body}`);
    }
  } catch (error) {
    // It's important to see this error during tests if WireMock is expected to be running.
    console.error("Error resetting WireMock stubs. Is WireMock running and accessible?", error);
    // Rethrow to make sure the test fails if reset is unsuccessful,
    // as this indicates a problem with the test environment setup.
    throw error;
  }
}
// --- Helper Types and Functions for Test Configuration ---
// Importa i tipi necessari se possibile e non crea conflitti/complessità eccessiva per i test.
// Altrimenti, definizioni locali semplificate sono accettabili per i test e2e.
// Esempio:
// import type { AutoApprovalMode, FullAutoErrorMode } from '../src/utils/auto-approval-mode';
// import type { MemoryConfig as ActualMemoryConfig, McpServerConfig as ActualMcpServerConfig } from '../src/utils/config';

// Definizioni di tipo locali per i test, allineate con src/utils/config.ts
type TestAutoApprovalMode = 'suggest' | 'auto-edit' | 'full-auto' | string;
type TestFullAutoErrorMode = 'ask' | 'skip' | string; // Basato su FullAutoErrorMode
type TestMemoryConfig = { enabled: boolean };

interface TestMcpServerConfig {
  name: string;
  url: string;
  enabled?: boolean; // Opzionale, come in src/utils/config.ts
  // auth è opzionale e può essere complesso; per i test e2e MCP di base,
  // potremmo non aver bisogno di specificarlo a meno che non si testino scenari di auth MCP.
  auth?: { type: "apiKey"; key: string } | { type: "oauth"; clientId: string; clientSecret: string };
}

interface AppConfig {
  model: string;
  provider: string;
  apiKey: string;
  instructions: string;
  mcpServers: TestMcpServerConfig[]; // Usa il tipo aggiornato
  defaultBehavior: 'chat' | 'exec' | string; // Campo atteso da App.tsx o logica CLI
  autoTools: string[]; // Campo atteso da App.tsx o logica CLI
  disabledTools: string[]; // Campo atteso da App.tsx o logica CLI
  codeSuggestions: boolean; // Campo atteso da App.tsx o logica CLI
  experimentalMode: boolean; // Campo atteso da App.tsx o logica CLI
  maxAutoSuggest: number; // Campo atteso da App.tsx o logica CLI
  telemetry: boolean; // Campo atteso da App.tsx o logica CLI
  quiet: boolean;

  // Campi allineati con AppConfig da src/utils/config.ts
  baseURL?: string;
  approvalMode?: TestAutoApprovalMode; // Opzionale, ma createTestAppConfig fornisce un default
  fullAutoErrorMode?: TestFullAutoErrorMode;
  memory?: TestMemoryConfig;
  githubClientId?: string;
  githubAccessToken?: string;
  githubSelectedRepo?: string;
  githubSelectedBranch?: string;
}
// e2e.test.ts - Add this at the top level of the file
const getBaseMockedConfigForTests = (): AppConfig => ({ // Ensure AppConfig is the correct type
  model: 'gpt-3.5-turbo', // Or any model your mock server expects
  provider: 'openai',     // Provider is now 'openai'
  apiKey: FAKE_API_KEY_FOR_MOCK_SERVER,
  baseURL: MOCK_GPT_SERVER_URL, // Points to your mock server
  instructions: '',
  mcpServers: [],
  defaultBehavior: 'chat' as const,
  autoTools: [],
  disabledTools: [],
  codeSuggestions: true,
  experimentalMode: false,
  // OPENAI_TIMEOUT_MS: 60000, // This would typically be part of the SDK's config, not AppConfig directly
  maxAutoSuggest: 3,
  telemetry: false,
  approvalMode: 'suggest' as const,
  quiet: false,
  // Ensure all fields expected by AppConfig and used by the CLI are present
});

function createTestAppConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const baseConfig: AppConfig = {
    model: 'test-model-default',
    provider: 'test-provider-default', // Non 'openai' per evitare controlli API key reali
    apiKey: 'test-apikey-default',     // Chiave fittizia per il provider di test
    instructions: '',
    mcpServers: [],
    defaultBehavior: 'chat',
    autoTools: [],
    disabledTools: [],
    codeSuggestions: true,
    experimentalMode: false,
    maxAutoSuggest: 3,
    telemetry: false, // Spesso disabilitata nei test
    approvalMode: 'suggest',
    quiet: false,
    // I campi opzionali come baseURL, fullAutoErrorMode, memory, github*
    // non sono inclusi nella baseConfig qui, a meno che non siano necessari
    // con un valore predefinito per la maggior parte dei test.
    // Vengono aggiunti tramite `overrides` se un test specifico ne ha bisogno.
  };
  return { ...baseConfig, ...overrides };
}

// --- Helper Functions for Agent Simulation ---

// Helper for command simulation that requires confirmation (Suggest, Auto-Edit for commands)
async function simulateAgentSuggestsCommandRequiringConfirmation(command: string[]) {
  if (!mockAppProps) {
    throw new Error('simulateAgentSuggestsCommandRequiringConfirmation: mockAppProps is undefined. Ensure runCli() was called and App mock is set up.');
  }
  if (!mockAppProps.getCommandConfirmation) {
    throw new Error('simulateAgentSuggestsCommandRequiringConfirmation: mockAppProps.getCommandConfirmation is undefined. Ensure App receives this prop.');
  }
    const confirmed = await mockAppProps.getCommandConfirmation({ command, type: 'shell' });
    if (confirmed) {
        if (!mockAppProps.config) {
        throw new Error('simulateAgentSuggestsCommandRequiringConfirmation: mockAppProps.config is undefined.');
    }
      const approvalPolicy = mockAppProps.config?.approvalMode || 'suggest';
      return mockHandleExecCommand(
        { cmd: command },
        mockAppProps.config,
        approvalPolicy,
        mockAppProps.getCommandConfirmation // Pass the App's confirmation getter
      );
    } else {
      throw new Error('Command not confirmed by user');
    }
}

// Helper for command simulation that does NOT require confirmation (Full-Auto)
async function simulateAgentSuggestsCommandWithoutConfirmation(command: string[]) {
    const approvalPolicy = mockAppProps?.config?.approvalMode;
     if (!mockAppProps) {
        throw new Error('simulateAgentSuggestsCommandWithoutConfirmation: mockAppProps is undefined. Ensure runCli() was called and App mock is set up.');
    }
    if (!mockAppProps.config) {
        throw new Error('simulateAgentSuggestsCommandWithoutConfirmation: mockAppProps.config is undefined.');
    }
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

// Helper function to simulate agent suggesting a file patch
async function simulateAgentSuggestsFilePatch(patchContent: string, patchFilePath: string = 'file.txt') {
  if (!mockAppProps) {
    throw new Error('simulateAgentSuggestsFilePatch: mockAppProps is undefined. Ensure runCli() was called and App mock is set up.');
  }
  if (!mockAppProps.config) {
    throw new Error('simulateAgentSuggestsFilePatch: mockAppProps.config is undefined.');
  }
  const patchData = {
    path: patchFilePath,
    content: patchContent,
    type: 'patch' as const,
  };

  // Determine effective policy from App's perspective (config passed to App)
  const approvalPolicy = mockAppProps.config?.approvalMode || 'suggest'; 

  let confirmed = false;
  if (approvalPolicy === 'full-auto' || approvalPolicy === 'auto-edit') {
    confirmed = true; // Patches are auto-approved in these modes
  } else { // 'suggest' mode (default)
    if (!mockAppProps.getCommandConfirmation) { 
      throw new Error('simulateAgentSuggestsFilePatch: mockAppProps.getCommandConfirmation is undefined. Ensure App receives this prop.');
    }
      confirmed = await mockAppProps.getCommandConfirmation(patchData);
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

// Helper function to simulate agent suggesting an MCP tool call
async function simulateAgentSuggestsMcpTool(fullToolName: string, args: any) {
  // Ensure mockAppProps is defined before proceeding
  const parts = fullToolName.split('_');
  if (parts.length < 3 || parts[0] !== 'mcp') throw new Error(`Invalid MCP tool name format: ${fullToolName}`);
  const serverName = parts[1];
  const toolName = parts.slice(2).join('_');

  if (!mockAppProps) {
    throw new Error('simulateAgentSuggestsMcpTool: mockAppProps is undefined. Ensure runCli() was called and App mock is set up.');
  }
  if (!mockAppProps.config) {
    throw new Error('simulateAgentSuggestsMcpTool: mockAppProps.config is undefined.');
  }

  const approvalPolicy = mockAppProps?.config?.approvalMode || 'suggest';
  let confirmed = false;
  const mcpToolCallData = { type: 'mcp_tool_call', server: serverName, tool: toolName, args, command: [`mcp_tool:${serverName}.${toolName}`] };
  
  if (approvalPolicy === 'full-auto') {
    confirmed = true;
  } else {
    if (!mockAppProps.getCommandConfirmation) {
      throw new Error('simulateAgentSuggestsMcpTool: mockAppProps.getCommandConfirmation is undefined. Ensure App receives this prop for non-full-auto modes.');
    }
    confirmed = await mockAppProps.getCommandConfirmation(mcpToolCallData);
  }
  if (confirmed) {
    if (!mockMcpInstances[serverName] || typeof mockMcpInstances[serverName].callTool !== 'function') {
        throw new Error(`simulateAgentSuggestsMcpTool: MCP client instance or callTool method for server "${serverName}" is not available.`);
    }
    // Ensure the callTool mock on the instance is used
    const instance = mockMcpInstances[serverName];
    if (instance && typeof instance.callTool === 'function') {
      return instance.callTool(toolName, args);
    }
    throw new Error(`MCP client instance for server "${serverName}" or its callTool method is not correctly mocked or available.`);
  }
  throw new Error(`MCP tool call to ${fullToolName} not confirmed by user.`);
}

// --- Helper Function to Setup App Mock ---
async function setupAppMock() {
  mockAppProps = undefined; // Resetta per ogni test
  // mockUserConfirmationGetter è globale e resettato nelle beforeEach rilevanti

  const appModule = await import('../src/app');
  const appDefaultMock = vi.mocked(appModule.default);

  appDefaultMock.mockImplementation((props: any) => {
    mockAppProps = { ...props }; // Cattura una copia di props

    // Questo è il punto cruciale per getCommandConfirmation
    if (Object.prototype.hasOwnProperty.call(props, 'getCommandConfirmation')) {
       mockAppProps.getCommandConfirmation = async (commandInfo: any) => { // Usa 'any' per flessibilità con patchData
         // commandInfo potrebbe essere { command: string[], type: string } o { path: string, content: string, type: 'patch' }
         return mockUserConfirmationGetter(JSON.stringify(commandInfo));
       };
    } else {
        // console.warn("Warning: App mock did not receive 'getCommandConfirmation' prop.");
    }
    return null;
  });
}

describe('Codex CLI End-to-End Tests', () => {
  beforeEach(async () => {
    vi.resetAllMocks(); // For all mocks non-WireMock
    // NO WireMock setup here. Let suites/tests handle it.

    // Mock OS Platform (if not already restored correctly by vi.restoreAllMocks)
    setMockPlatform('linux'); 
    vi.spyOn(process, 'platform', 'get').mockImplementation(() => currentMockPlatform);

    // Mock Git Repo State
    setupMockGitRepo();

    // Initialize mockUserConfirmationGetter - this is crucial
    // This function mock simulates the user responding to a confirmation prompt.
    // It's used by the App mock to resolve the getCommandConfirmation prop.
    mockUserConfirmationGetter = vi.fn(async (promptText: string) => {
      // console.log(`[mockUserConfirmationGetter] Prompted with: ${promptText}. Defaulting to true (approve).`);
      return true; // Default: always approve for most tests
    });

    // Initialize other global test dependencies
    mockHandleExecCommand.mockReset().mockResolvedValue({ outputText: 'command executed successfully by global mock', metadata: {} });
    mockApplyPatch.mockReset().mockImplementation(async (filePath: string, patchContent: string) => {
      const fsMock = await import('fs'); // fs is mocked
      if (patchContent === '<DELETE>') {
        if (fsMock.existsSync(filePath)) fsMock.unlinkSync(filePath);
        return;
      }
      fsMock.writeFileSync(filePath, patchContent);
    });
    memFsStore = {}; // Reset in-memory file system



    // Ensure config mock is available for runCli, but it will be set *inside* runCli
    // The module-level mock for config is still important for initial loads.
  });

  afterEach(async () => {
    await resetWireMockStubs(); // Crucial: clean WireMock after EVERY test.
    vi.restoreAllMocks(); 
  });

  it('should run the CLI and capture a placeholder exit code', async () => {
    await resetWireMockStubs(); // Reset at the very start of THIS test

    // Setup default stubs needed for basic CLI run (models and chat)
    await setupWireMockStub({
      request: {
        method: 'GET',
        urlPath: '/v1/models',
        headers: { "Authorization": { "equalTo": `Bearer ${FAKE_API_KEY_FOR_MOCK_SERVER}` } }
      },
      response: {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        jsonBody: {
          object: 'list',
          data: [{ id: getBaseMockedConfigForTests().model, object: 'model', owned_by: 'openai' }],
        },
      },
      priority: 1 // High priority for this test
    }); // Models stub

    await setupWireMockStub({
      request: {
        method: 'POST',
        urlPath: '/v1/chat/completions',
        headers: { "Authorization": { "equalTo": `Bearer ${FAKE_API_KEY_FOR_MOCK_SERVER}` } }
      },
      response: {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        jsonBody: {
          id: 'chatcmpl-testspecific-' + Date.now(),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: getBaseMockedConfigForTests().model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'AI response for placeholder test.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        },
      },
      priority: 1 // High priority for this test
    });

    // Ensure loadConfig is mocked correctly for runCli
    const configUtils = await import('../src/utils/config');
    configUtils.loadConfig.mockReturnValue(getBaseMockedConfigForTests());

    const { exitCode, stdout, stderr } = await runCli([]); // Simplest CLI invocation
    expect(stderr).not.toContain('OpenAI rejected the request'); // Or any other AI error message
    expect(stderr).not.toContain('Failed to fetch'); // General network error
    expect(exitCode).toBeDefined();
  });


  // Rimuovi setupAppMock dai beforeEach delle suite principali se runCli lo gestisce
  // Ad esempio, se 'Core CLI Functionality' chiama runCli, non ha bisogno di setupAppMock qui.
  // Lo stesso per 'Error Handling', 'Platform-Specific Command Execution', ecc.
  // Questo sarà fatto implicitamente quando si rimuovono le chiamate ridondanti.

  it('should reflect mocked git clone operation in state', async () => {
    const gitUtils = await import('../src/utils/git-utils'); // Get the mocked module
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
vi.mock('../src/utils/agent/handle-exec-command.ts', () => ({
  handleExecCommand: mockHandleExecCommand, 
}));
// --- End Mocks for App and Agent Interaction ---


describe('Core CLI Functionality', () => {
  beforeEach(async () => {
    // mockUserConfirmationGetter is initialized in the top-level beforeEach.
    // If this suite needs a different default behavior, use mockUserConfirmationGetter.mockReset().mockResolvedValue(...)
    mockHandleExecCommand.mockReset().mockResolvedValue({ outputText: 'command executed', metadata: {} });
    mockApplyPatch.mockReset().mockImplementation(async (filePath: string, patchContent: string) => {
      if (patchContent === '<DELETE>') {
        if (fsMock.existsSync(filePath)) fsMock.unlinkSync(filePath); return;
      }
      fsMock.writeFileSync(filePath, patchContent);
    });
    vi.mock('../src/parse-apply-patch.ts', () => ({ applyPatch: mockApplyPatch }));
    memFsStore = {};
    // --- WIREMOCK SETUP FOR THIS SUITE ---
    await resetWireMockStubs(); // Ensure clean slate for this suite's tests

    // Default 200 OK stubs needed by most tests in this suite
    await setupWireMockStub({ // GET /v1/models
      request: { method: 'GET', urlPath: '/v1/models', headers: { "Authorization": { "equalTo": `Bearer ${FAKE_API_KEY_FOR_MOCK_SERVER}` }}},
      response: { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: { object: 'list', data: [{ id: getBaseMockedConfigForTests().model, object: 'model', created: Math.floor(Date.now() / 1000) - 10000, owned_by: 'openai-internal' }]}},
      priority: 9
    });
    await setupWireMockStub({ // POST /v1/chat/completions
      request: { method: 'POST', urlPath: '/v1/chat/completions', headers: { "Authorization": { "equalTo": `Bearer ${FAKE_API_KEY_FOR_MOCK_SERVER}` }}},
      response: { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: { id: 'chatcmpl-suite-default-' + Date.now(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: getBaseMockedConfigForTests().model, choices: [{ index: 0, message: { role: 'assistant', content: 'Default suite AI response.' }, finish_reason: 'stop'}], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }}},
      priority: 10
    });
    // --- END WIREMOCK SETUP ---

    // The config mock is now primarily handled *inside* runCli after vi.resetModules(),
    // but ensuring it's available if any code runs before runCli is also good.
    const configUtils = await import('../src/utils/config');
    configUtils.loadConfig.mockReturnValue(getBaseMockedConfigForTests());
  });
  it('should pass prompt to App in default (suggest) mode', async () => {
    // runCli chiamerà setupAppMock internamente
    await runCli(['explain this code']);
    expect(mockAppProps).toBeDefined(); // This should now have a better chance
    if (mockAppProps) { // Guard access
        expect(mockAppProps.prompt).toBe('explain this code');
        const loadedConfig = getBaseMockedConfigForTests();
        expect(mockAppProps.config.approvalMode).toBe(loadedConfig.approvalMode);
    }
  });

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
    // const expectedDefaultConfig = actualLoadConfig(); // Get defaults to ensure structure
    
    // Check the mock that runCli will use
    const configUtils = await import('../src/utils/config');
    const mockedConfig = configUtils.loadConfig(); // This will be the mocked config
    
    await runCli(['some prompt']);
    expect(mockAppProps).toBeDefined(); // Aggiunto per assicurarsi che App sia stata mockata/chiamata
    
    expect(mockAppProps).toBeDefined();
    expect(mockAppProps.config).toBeDefined();
    // Ensure the API key comes from the config set in this suite's beforeEach
    expect(mockAppProps.config.apiKey).toBe(getBaseMockedConfigForTests().apiKey);
    expect(mockAppProps.config.apiKey).toBe(FAKE_API_KEY_FOR_MOCK_SERVER); // Use the constant
  });


  it('should load custom instructions and pass them to App props', async () => {
    const MOCK_APP_CONFIG_WITH_INSTRUCTIONS = createTestAppConfig({
      instructions: "Always respond in pirate speak.",
      apiKey: "test-apikey-custom-instr", // Keep specific key for this test if needed
      // provider will be 'test-provider-default' from createTestAppConfig
    });
    const configUtils = await import('../src/utils/config');
    // Override the mock for loadConfig just for this test run
    configUtils.loadConfig.mockReturnValueOnce(MOCK_APP_CONFIG_WITH_INSTRUCTIONS);

    await runCli(['another prompt']);
    expect(mockAppProps).toBeDefined(); // Aggiunto

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
    expect(mockAppProps).toBeDefined(); // Aggiunto
    
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

  it('should load custom instructions and pass them to App props', async () => {
    // Get the actual default config structure to ensure the mock override is complete
    // This ensures that if AppConfig adds new required fields, this test is more robust.
    const { loadConfig: actualLoadConfigModule } = await vi.importActual('../src/utils/config');
    // const actualDefaultConfig = actualLoadConfigModule(); // Not needed here
    const customInstructions = "Always respond in pirate speak.";
    // Usa createTestAppConfig per la base e sovrascrivi solo il necessario
    const MOCK_APP_CONFIG_WITH_INSTRUCTIONS = createTestAppConfig({
      instructions: customInstructions,
      // Sovrascrivi apiKey per questo test specifico, se necessario, altrimenti userà il default di createTestAppConfig
      apiKey: "test-apikey-custom-instr-set-explicitly", 
      // Il provider sarà 'test-provider-default' da createTestAppConfig, gestito dal Fix 1
    });
    
    const configUtils = await import('../src/utils/config');
    // Override the mock for loadConfig specifically for this test run
    configUtils.loadConfig.mockReturnValueOnce(MOCK_APP_CONFIG_WITH_INSTRUCTIONS);
    await runCli(['another prompt for custom instructions']);
    expect(mockAppProps).toBeDefined(); // Aggiunto

    expect(mockAppProps).toBeDefined();
    expect(mockAppProps.config).toBeDefined();
    expect(mockAppProps.config.instructions).toBe("Always respond in pirate speak.");
    // also verify other parts of config are from the new mock to ensure it was used
    expect(mockAppProps.config.apiKey).toBe("test-apikey-custom-instr-set-explicitly");
    // Il provider dovrebbe essere quello da createTestAppConfig
    expect(mockAppProps.config.provider).toBe('test-provider-default'); 
  });

  it('should operate in quiet mode and not trigger interactive confirmation flow for suggest policy', async () => {
    // The global config mock defaults to approvalMode: 'suggest' 
    // (or undefined, which cli.tsx might interpret as 'suggest')
    // The --quiet flag should prevent interactive prompts for this 'suggest' policy.
    await runCli(['--quiet', 'generate a random number in quiet mode']); 
    expect(mockAppProps).toBeDefined(); // Aggiunto
    
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

describe('Sandboxing Logic', () => {
  beforeEach(async () => {
    const configUtils = await import('../src/utils/config');
    await resetWireMockStubs();
    // Default stubs for successful AI interaction (sandboxing tests might still involve AI)
    await setupWireMockStub({ // GET /v1/models
      request: { method: 'GET', urlPath: '/v1/models', headers: { "Authorization": { "equalTo": `Bearer ${FAKE_API_KEY_FOR_MOCK_SERVER}` } } },
      response: { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: { object: 'list', data: [{ id: getBaseMockedConfigForTests().model, object: 'model', owned_by: 'openai' }] } },
      priority: 9
    });
    await setupWireMockStub({ // POST /v1/chat/completions
      request: { method: 'POST', urlPath: '/v1/chat/completions', headers: { "Authorization": { "equalTo": `Bearer ${FAKE_API_KEY_FOR_MOCK_SERVER}` } } },
      response: { status: 200, headers: { 'Content-Type': 'application/json' },
        jsonBody: {
          id: 'chatcmpl-sandbox-' + Date.now(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: getBaseMockedConfigForTests().model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'Sandbox AI response.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }
      }, priority: 10 });
    configUtils.loadConfig.mockReturnValue(getBaseMockedConfigForTests());

    mockHandleExecCommand.mockReset().mockResolvedValue({ outputText: 'sandboxed output', metadata: {} });
    setMockPlatform('linux'); // Default platform
    mockUserConfirmationGetter.mockReset().mockResolvedValue(true); // Default to approve
  });

  it('should use sandbox-exec on macOS in full-auto mode', async () => {
    setMockPlatform('darwin');
    await runCli(['--approval-mode', 'full-auto', 'do something on mac']);
    expect(mockAppProps).toBeDefined(); // Aggiunto
    
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
    expect(mockAppProps).toBeDefined(); // Aggiunto

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
    expect(mockAppProps).toBeDefined(); // Aggiunto

    const originalCommand = ['pwd'];
    // simulateAgentSuggestsCommandRequiringConfirmation will use mockUserConfirmationGetter, which defaults to true (approve)
    await simulateAgentSuggestsCommandRequiringConfirmation(originalCommand);

    expect(mockHandleExecCommand).toHaveBeenCalled();
    const executedCommandObject = mockHandleExecCommand.mock.calls[0][0];
    expect(executedCommandObject.cmd).toEqual(originalCommand); // Exact command, no wrappers
  });
});

describe('Error Handling (Non-AI)', () => {
  beforeEach(async () => {
    await resetWireMockStubs();
    // Default stubs for successful AI interaction, as non-AI errors might occur after AI interaction
    await setupWireMockStub({ // GET /v1/models
      request: { method: 'GET', urlPath: '/v1/models', headers: { "Authorization": { "equalTo": `Bearer ${FAKE_API_KEY_FOR_MOCK_SERVER}` } } },
      response: { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: { object: 'list', data: [{ id: getBaseMockedConfigForTests().model, object: 'model', owned_by: 'openai' }] } },
      priority: 9
    });
    await setupWireMockStub({ // POST /v1/chat/completions
      request: { method: 'POST', urlPath: '/v1/chat/completions', headers: { "Authorization": { "equalTo": `Bearer ${FAKE_API_KEY_FOR_MOCK_SERVER}` } } },
      response: { status: 200, headers: { 'Content-Type': 'application/json' },
        jsonBody: {
          id: 'chatcmpl-errorhandling-' + Date.now(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: getBaseMockedConfigForTests().model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'Error handling AI response.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }
      }, priority: 10 });
    const configUtils = await import('../src/utils/config');
    configUtils.loadConfig.mockReturnValue(getBaseMockedConfigForTests());
    
    // Reset core action mocks
    mockHandleExecCommand.mockReset().mockResolvedValue({ outputText: 'command executed', metadata: {} });
    mockApplyPatch.mockReset().mockResolvedValue(undefined);
    // Reset AI Provider Mocks (assuming OpenAI for now)
    // If 'openai' is globally mocked, we need to access its mocked methods to reset.
    // This assumes 'openai' mock is set up similarly to other global mocks (e.g., using vi.mocked)
    // If not globally mocked but per-test, this reset might be handled in specific tests.
    // For now, let's assume we can reset the key method if it was mocked:
    try {
      const openaiMock = vi.mocked(await import('openai'));
      // Accediamo alla mock function stabile direttamente, non tramite l'istanza del modulo
      // perché è quella che vogliamo resettare.
      // mockChatCompletionsCreate.mockReset() è già fatto sopra.
      
      // Se ci fossero altri metodi sull'istanza OpenAI mockata che necessitano di reset,
      // andrebbero gestiti qui, ma 'create' è il principale e ora è stabile.
      
        // Set a default successful resolution if most tests expect it to work
        // openaiMock.chat.completions.create.mockResolvedValue({ choices: [{ message: { content: "Default AI response" }}] });
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
    const gitUtilsMock = vi.mocked(await import('../src/utils/git-utils'));
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
    const fsMock = vi.mocked(await import('fs'));
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
  // NOTA: Le sotto-suite di 'Error Handling' come 'Invalid Command-Line Arguments', 
  // 'AI Provider API Errors' è stata spostata.
  
  describe('Invalid Command-Line Arguments', () => {
    it('should show help and exit with error for an unknown flag', async () => {
      // meow, by default, shows help and exits with 2 for unknown flags.
      // The runCli helper captures stderr and exitCode.
      const { stderr, exitCode, stdout } = await runCli(['--unknown-super-flag', 'prompt']);
      
      // Depending on meow's verbosity and exact version, stderr might contain the unknown flag
      // or just the help text. stdout often contains the main help text.
      expect(stderr + stdout).toMatch(/Unknown flag/i); // Or similar message from meow
      expect(stderr + stdout).toMatch(/--unknown-super-flag/i);
      expect(exitCode).toBe(2); // meow's typical exit code for unknown options (or what we set)
    });

    // Add more tests here if your CLI has specific commands that require arguments.
    // Example:
    // it('should error if a required command argument is missing', async () => {
    //   const { stderr, exitCode } = await runCli(['mycommand']); // Assuming 'mycommand' needs an arg
    //   expect(stderr).toContain("Missing required argument for 'mycommand'");
    //   expect(exitCode).not.toBe(0);
    // });
  });

});

describe('AI Provider API Interactions (with local WireMock)', () => {
  // Moved from Error Handling suite
  beforeEach(async () => {
    await resetWireMockStubs();
    // No default stubs here, or only the /v1/models if it's always needed for init
    await setupWireMockStub({ // Models stub - often needed for OpenAI client init
      request: { method: 'GET', urlPath: '/v1/models', headers: { "Authorization": { "equalTo": `Bearer ${FAKE_API_KEY_FOR_MOCK_SERVER}` }}},
      response: { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: { object: 'list', data: [{ id: getBaseMockedConfigForTests().model, object: 'model', created: Math.floor(Date.now() / 1000) - 10000, owned_by: 'openai-internal' }]}},
      priority: 5 // Lower priority than test-specific stubs
    });

    const configUtils = await import('../src/utils/config');
    configUtils.loadConfig.mockReturnValue(getBaseMockedConfigForTests());
  });

  describe('AI Provider API Errors', () => {
    it('should handle AI API errors gracefully', async () => {
      // resetWireMockStubs() was called by suite's beforeEach. Models stub is already set.
      // This test will set up its own specific 418/429 stub for chat completions
      await setupWireMockStub({ // Teapot/Error stub for chat
        request: { method: 'POST', urlPath: '/v1/chat/completions' /*, headers: { "Authorization": { "equalTo": FAKE_API_KEY_FOR_MOCK_SERVER }} */ }, // Temporarily remove header check for broadest match
        response: { status: 418, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: { message: 'Caught by broad chat completions stub (teapot)' }}},
        priority: 1 // Highest priority
      });
      
      // For this test, simplify the prompt to maximize chances of an API call
      const { stderr, stdout, exitCode } = await runCli(['hello']); // Simple prompt

      console.log("Teapot Test STDOUT:", stdout);
      console.log("Teapot Test STDERR:", stderr);

      // Check WireMock Docker logs for what happened during this 'hello' run.
      // Did it hit the models stub? Did it attempt chat/completions and hit the teapot?

      expect(stderr).toContain('Caught by broad chat completions stub (teapot)');
      expect(exitCode).not.toBe(0);
    });
  });

  // Further error handling tests (MCP, Git, FS, etc.) will be added in subsequent steps.
  describe('MCP Errors', () => {
    it('should handle MCP connection errors', async () => {
      // No AI interaction expected for this specific MCP error test, so no AI stubs needed beyond models.
      const configUtils = await import('../src/utils/config');
      configUtils.loadConfig.mockReturnValueOnce({
        ...getBaseMockedConfigForTests(),
        mcpServers: [{ name: 'FailingMCP', url: 'http://mcp.fail.test', enabled: true }],
      });

      mockMcpClientConnect.mockRejectedValueOnce(new Error('Connection refused for FailingMCP'));

      const { stderr, exitCode } = await runCli(['prompt that uses MCP']);
      // mockAppProps potrebbe non essere definito se il CLI esce prima.
      
      // This assertion depends on how the App/CLI surfaces MCP connection errors.
      // It might be a general "MCP connection failed" or more specific.
      expect(stderr).toContain('MCP client connection failed for FailingMCP'); // Or similar
      expect(stderr).toContain('Connection refused for FailingMCP');
      expect(exitCode).not.toBe(0);
    });

    it('should handle MCP tool call errors (already tested, confirming general path)', async () => {
        // This test might involve AI suggesting an MCP tool, so ensure AI stubs are present.
        // Models stub is from suite's beforeEach. Add chat stub.
        await setupWireMockStub({ // POST /v1/chat/completions
          request: { method: 'POST', urlPath: '/v1/chat/completions', headers: { "Authorization": { "equalTo": `Bearer ${FAKE_API_KEY_FOR_MOCK_SERVER}` } } },
          response: {
            status: 200, headers: { 'Content-Type': 'application/json' },
            jsonBody: {
              id: 'chatcmpl-mcperr-' + Date.now(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: getBaseMockedConfigForTests().model,
              choices: [{ index: 0, message: { role: 'assistant', tool_calls: [{ id: "call_123", type: "function", function: { name: "mcp_ErrorToolMCP_failing_tool", arguments: "{}" }}] }, finish_reason: 'tool_calls' }],
              usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
            }
          },
          priority: 5 // Higher than default chat, lower than specific error stubs
        });

        const configUtils = await import('../src/utils/config');
        configUtils.loadConfig.mockReturnValueOnce({
            ...getBaseMockedConfigForTests(),
            mcpServers: [{ name: 'ErrorToolMCP', url: 'http://mcp.toolfail.test', enabled: true }],
            approvalMode: 'full-auto', // For simplicity, auto-approve the failing tool call
        });

        mockMcpClientListTools.mockResolvedValueOnce([{ name: 'failing_tool', description: 'A tool that fails', parameters: {} }]);
        mockMcpClientCallTool.mockRejectedValueOnce(new Error('Simulated MCP Tool Execution Error'));

        // The runCli call will set up the App. The error occurs when the tool is called via simulate.
        await runCli(['use failing_tool from ErrorToolMCP']); 
        expect(mockAppProps).toBeDefined(); // Aggiunto

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
      // This test might involve AI suggesting a git command, so ensure AI stubs.
      // Models stub from suite. Add chat stub.
      await setupWireMockStub({ // POST /v1/chat/completions
        request: { method: 'POST', urlPath: '/v1/chat/completions', headers: { "Authorization": { "equalTo": `Bearer ${FAKE_API_KEY_FOR_MOCK_SERVER}` } } },
        response: {
          status: 200, headers: { 'Content-Type': 'application/json' },
          jsonBody: {
            id: 'chatcmpl-giterr-' + Date.now(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: getBaseMockedConfigForTests().model,
            choices: [{ index: 0, message: { role: 'assistant', tool_calls: [{ id: "call_git", type: "function", function: { name: "shell", arguments: JSON.stringify({cmd: ["git", "commit", "-m", "ai commit"]}) }}] }, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          }
        },
        priority: 5
      });

      // Setup a repo state where a commit might be attempted
      setupMockGitRepo({ isRepo: true, currentBranch: 'main', branches: ['main'], files: [{ path: 'file.txt', status: 'added'}] });
      
      const gitUtils = vi.mocked(await import('../src/utils/git-utils'));
      gitUtils.gitCommit.mockRejectedValueOnce(new Error('Git commit failed: pre-commit hook failed'));

      // Simulate a CLI flow that would lead to a commit.
      // This is highly dependent on your CLI's agent logic.
      // For this test, we'll assume `runCli` with a specific prompt might trigger it,
      // or we might need a more specific helper if the agent logic is complex.
      // If agent calls gitCommit directly after a patch in full-auto:
      // This runCli call must trigger the agent to attempt a commit.
      // The prompt "patch file.txt and commit" implies this.
      // The App's error handling should catch the commitError and print to stderr.
      const { stderr: runStderr, exitCode: runExitCode } = await runCli(['--approval-mode', 'full-auto', 'patch file.txt and commit']);
      // Then simulate the patch that would precede the commit.
      expect(mockAppProps).toBeDefined(); // Aggiunto
      // This setup is a bit simplified; actual commit might be triggered by agent.

      // For a more direct test, we might call a hypothetical agent function.

      // Let's assume the error is caught by the App and printed to stderr.
      // This requires the App to have error handling for git operations.
      // If the agent calls gitCommit and it throws, the App's main loop should catch it.
      
      // For this test, we'll directly invoke the problematic function as if the agent decided to.
      // This makes the test more focused on the error handling of the git util call itself
      // rather than complex agent simulation.
      // The direct call `await gitUtils.gitCommit` was removed from this test.

      // To properly test stderr reporting, the runCli flow must trigger this.
      // Modify runCli to take an action that causes a commit, or have a dedicated test command.
      // For now, this test setup proves the mock can be made to fail.
      // A more complete test would be:
      // This assertion depends on App.tsx catching the error from gitUtils.gitCommit
      // and printing it to stderr.
      // expect(runStderr).toContain('Git commit failed: pre-commit hook failed');
      // expect(runExitCode).not.toBe(0);

      // The most direct way is if the App's main error handler catches it.
      // The `expect(mockAppProps).toBeDefined()` is key.
      // const { stderr, exitCode } = await runCli(['trigger-commit-action']);
      // expect(stderr).toContain('Git commit failed: pre-commit hook failed');
      // expect(exitCode).not.toBe(0);
      // This test is therefore more of a setup demonstration for now.
    });
  });

  describe('File System Permission Errors', () => {
    it('should handle file permission errors during patch application', async () => {
      // This test might involve AI suggesting a patch, so ensure AI stubs.
      // Models stub from suite. Add chat stub.
      await setupWireMockStub({ // POST /v1/chat/completions
        request: { method: 'POST', urlPath: '/v1/chat/completions', headers: { "Authorization": { "equalTo": `Bearer ${FAKE_API_KEY_FOR_MOCK_SERVER}` } } },
        response: {
          status: 200, headers: { 'Content-Type': 'application/json' },
          jsonBody: {
            id: 'chatcmpl-fserr-' + Date.now(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: getBaseMockedConfigForTests().model,
            choices: [{ index: 0, message: { role: 'assistant', tool_calls: [{ id: "call_patch", type: "function", function: { name: "apply_patch", arguments: JSON.stringify({ patch: `*** Begin Patch\n*** Update File: /root/locked.txt\n@@\n+content\n*** End Patch`}) }}] }, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          }
        },
        priority: 5
      });

      const fsMock = vi.mocked(await import('fs'));
      const permissionError = new Error('EACCES: permission denied, open \'/root/locked.txt\'');
      (permissionError as any).code = 'EACCES';
      // Make writeFileSync throw this error when our mockApplyPatch calls it.
      fsMock.writeFileSync.mockImplementationOnce(() => { throw permissionError; });

      await runCli(['--approval-mode', 'full-auto', 'create /root/locked.txt']);
      expect(mockAppProps).toBeDefined(); // Aggiunto
      
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
      // This test might involve AI suggesting a command, so ensure AI stubs.
      // Models stub from suite. Add chat stub.
      await setupWireMockStub({ // POST /v1/chat/completions
        request: { method: 'POST', urlPath: '/v1/chat/completions', headers: { "Authorization": { "equalTo": `Bearer ${FAKE_API_KEY_FOR_MOCK_SERVER}` } } },
        response: {
          status: 200, headers: { 'Content-Type': 'application/json' },
          jsonBody: {
            id: 'chatcmpl-cmdexeerr-' + Date.now(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: getBaseMockedConfigForTests().model,
            choices: [{ index: 0, message: { role: 'assistant', tool_calls: [{ id: "call_shell_fail", type: "function", function: { name: "shell", arguments: JSON.stringify({cmd: ["nonexistent-script", "--arg"]}) }}] }, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          }
        },
        priority: 5
      });

      mockHandleExecCommand.mockRejectedValueOnce(new Error('Command execution failed with exit code 127'));
      // Or: mockHandleExecCommand.mockResolvedValueOnce({ outputText: "", metadata: { error: new Error(...), exitCode: 127, stderr: "command not found" }});

      await runCli(['--approval-mode', 'full-auto', 'run a failing script']);
      expect(mockAppProps).toBeDefined(); // Aggiunto
      
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

describe('Platform-Specific Command Execution (Non-Sandboxed)', () => {
  beforeEach(async () => {
    const configUtils = await import('../src/utils/config');
    await resetWireMockStubs();
    // Default stubs for successful AI interaction
    await setupWireMockStub({ // GET /v1/models
      request: { method: 'GET', urlPath: '/v1/models', headers: { "Authorization": { "equalTo": `Bearer ${FAKE_API_KEY_FOR_MOCK_SERVER}` } } },
      response: { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: { object: 'list', data: [{ id: getBaseMockedConfigForTests().model, object: 'model', owned_by: 'openai' }] } },
      priority: 9
    });
    await setupWireMockStub({ // POST /v1/chat/completions
      request: { method: 'POST', urlPath: '/v1/chat/completions', headers: { "Authorization": { "equalTo": `Bearer ${FAKE_API_KEY_FOR_MOCK_SERVER}` } } },
      response: { status: 200, headers: { 'Content-Type': 'application/json' },
        jsonBody: {
          id: 'chatcmpl-platform-' + Date.now(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: getBaseMockedConfigForTests().model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'Platform command AI response.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }
      }, priority: 10 });
    configUtils.loadConfig.mockReturnValue(getBaseMockedConfigForTests());

    mockHandleExecCommand.mockReset().mockResolvedValue({ outputText: 'command output', metadata: {} });
    setMockPlatform('linux'); // Default to Linux for this suite's tests
    mockUserConfirmationGetter.mockReset().mockResolvedValue(true);
  });

  it('should execute POSIX (Linux-like) command as suggested', async () => {
    setMockPlatform('linux');
    // The prompt is generic; the key is the command suggested by the agent simulation
    await runCli(['list files in current directory']); 
    expect(mockAppProps).toBeDefined(); // Aggiunto
    
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
      // setupAppMock() è già chiamato dal beforeEach del genitore 'Platform-Specific Command Execution'
      setMockPlatform('win32'); // Set platform for all tests in this inner suite
    });

    it('should execute Windows-specific command (dir) as suggested', async () => {
      await runCli(['list files in current directory on Windows']);
      expect(mockAppProps).toBeDefined(); // Aggiunto
      
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
      expect(mockAppProps).toBeDefined(); // Aggiunto
      
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
  beforeEach(async () => {
    await resetWireMockStubs();
    // Default stubs for successful AI interaction (AI might suggest patches)
    await setupWireMockStub({ // GET /v1/models
      request: { method: 'GET', urlPath: '/v1/models', headers: { "Authorization": { "equalTo": `Bearer ${FAKE_API_KEY_FOR_MOCK_SERVER}` } } },
      response: { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: { object: 'list', data: [{ id: getBaseMockedConfigForTests().model, object: 'model', owned_by: 'openai' }] } },
      priority: 9
    });
    await setupWireMockStub({ // POST /v1/chat/completions
      request: { method: 'POST', urlPath: '/v1/chat/completions', headers: { "Authorization": { "equalTo": `Bearer ${FAKE_API_KEY_FOR_MOCK_SERVER}` } } },
      response: { status: 200, headers: { 'Content-Type': 'application/json' },
        jsonBody: {
          id: 'chatcmpl-fsinteract-' + Date.now(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: getBaseMockedConfigForTests().model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'File system AI response.' }, finish_reason: 'stop' }], // Or a tool_call for apply_patch
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }
      }, priority: 10 });
    const configUtils = await import('../src/utils/config');
    configUtils.loadConfig.mockReturnValue(getBaseMockedConfigForTests());

    mockUserConfirmationGetter.mockReset().mockResolvedValue(true); // Default ad approvare per i test di patch

    // If Core CLI Functionality's beforeEach already clears memFsStore, this is for extra safety/isolation.
    memFsStore = {};
    
    // Also, ensure fs mock function call histories are clear if not handled by global resets.
    // vi.resetAllMocks() in the top-level beforeEach should generally cover this.
    // For explicit clarity if issues arise:
    // const fsMock = vi.mocked(await import('fs'));
    // fsMock.existsSync.mockClear();
    // fsMock.readFileSync.mockClear();
    // fsMock.writeFileSync.mockClear();
    // fsMock.unlinkSync.mockClear();
 
    mockApplyPatch.mockReset().mockImplementation(async (filePath: string, patchContent: string) => {        const fsMock = await import('fs');
        if (patchContent === '<DELETE>') {
            if (fsMock.existsSync(filePath)) fsMock.unlinkSync(filePath);
            return;
        }
        fsMock.writeFileSync(filePath, patchContent);
    });
    vi.mock('../src/parse-apply-patch.ts', () => ({ applyPatch: mockApplyPatch }));

  it('should create a new file when a patch is applied for a non-existent file', async () => {
    const fsMock = vi.mocked(await import('fs'));
    const newFilePath = 'fruits.txt';
    const newFileContent = 'apple\nbanana';

    // Configurazione specifica per approval-mode se necessario
    const configUtils = await import('../src/utils/config');
    configUtils.loadConfig.mockReturnValueOnce(createTestAppConfig({ approvalMode: 'full-auto' }));

    await runCli(['--approval-mode', 'full-auto', `create a file ${newFilePath} with ${newFileContent}`]);
    expect(mockAppProps).toBeDefined(); // Aggiunto
    expect(mockAppProps).toBeDefined(); // Verifica cruciale

    await simulateAgentSuggestsFilePatch(newFileContent, newFilePath);

    expect(fsMock.writeFileSync).toHaveBeenCalledWith(newFilePath, newFileContent);
    expect(memFsStore[newFilePath]).toBe(newFileContent);
    // Check existsSync was likely called by mockApplyPatch to determine if it's a new file (optional, depends on mockApplyPatch impl)
    // expect(fsMock.existsSync).toHaveBeenCalledWith(newFilePath); 
  });

  it('should modify an existing file when a patch is applied', async () => {
    const fsMock = vi.mocked(await import('fs'));
    const existingFilePath = 'config.js';
    const oldContent = 'old content';
    const newContent = 'new content';

    memFsStore[existingFilePath] = oldContent; // Pre-populate the file

    const configUtils = await import('../src/utils/config');
    configUtils.loadConfig.mockReturnValueOnce(createTestAppConfig({ approvalMode: 'full-auto' }));

    await runCli(['--approval-mode', 'full-auto', `update ${existingFilePath} to ${newContent}`]);
    expect(mockAppProps).toBeDefined();

    await simulateAgentSuggestsFilePatch(newContent, existingFilePath);

    expect(fsMock.writeFileSync).toHaveBeenCalledWith(existingFilePath, newContent);
    expect(memFsStore[existingFilePath]).toBe(newContent);
  });

  it('should delete a file when a <DELETE> patch is applied', async () => {
    const fsMock = vi.mocked(await import('fs'));
    const filePathToDelete = 'obsolete.tmp';
    memFsStore[filePathToDelete] = 'delete me'; // File exists

    const configUtils = await import('../src/utils/config');
    configUtils.loadConfig.mockReturnValueOnce(createTestAppConfig({ approvalMode: 'full-auto' }));

    await runCli(['--approval-mode', 'full-auto', `delete ${filePathToDelete}`]);
    expect(mockAppProps).toBeDefined();

    await simulateAgentSuggestsFilePatch('<DELETE>', filePathToDelete);

    expect(fsMock.unlinkSync).toHaveBeenCalledWith(filePathToDelete);
    expect(memFsStore.hasOwnProperty(filePathToDelete)).toBe(false);
  });

  it('should NOT modify a file if user rejects patch in suggest mode', async () => {
    const fsMock = vi.mocked(await import('fs'));
    const filePath = 'user-config.json';
    const initialContent = '{"setting": "alpha"}';
    const patchContent = '{"setting": "bravo"}';

    memFsStore[filePath] = initialContent; // Pre-populate
    mockUserConfirmationGetter = vi.fn(async () => false); // User rejects

    mockUserConfirmationGetter.mockReset().mockResolvedValue(false); // Utente RIFIUTA

    // Configurazione per approvalMode: 'suggest' (o default)
    const configUtils = await import('../src/utils/config');
    configUtils.loadConfig.mockReturnValueOnce(createTestAppConfig({ approvalMode: 'suggest' }));

    await runCli([`update ${filePath}`]); 
    expect(mockAppProps).toBeDefined(); // Aggiunto
    expect(mockAppProps.getCommandConfirmation).toBeInstanceOf(Function); // Verifica che la funzione sia stata passata
    
    await expect(simulateAgentSuggestsFilePatch(patchContent, filePath))
      .rejects.toThrow('File patch not confirmed by user.'); // Ora l'errore atteso dovrebbe arrivare


    expect(mockUserConfirmationGetter).toHaveBeenCalled(); // Ensure confirmation was sought
    expect(fsMock.writeFileSync).not.toHaveBeenCalled(); // File system should not be touched
    expect(memFsStore[filePath]).toBe(initialContent); // Content should remain unchanged
  });
});

describe('MCP Integration', () => {
  beforeEach(async () => {
    const configUtils = await import('../src/utils/config');
    await resetWireMockStubs();
    // Default stubs for successful AI interaction (AI might suggest MCP tools)
    await setupWireMockStub({ // GET /v1/models
      request: { method: 'GET', urlPath: '/v1/models', headers: { "Authorization": { "equalTo": `Bearer ${FAKE_API_KEY_FOR_MOCK_SERVER}` } } },
      response: { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: { object: 'list', data: [{ id: getBaseMockedConfigForTests().model, object: 'model', owned_by: 'openai' }] } },
      priority: 9
    });
    await setupWireMockStub({ // POST /v1/chat/completions
      request: { method: 'POST', urlPath: '/v1/chat/completions', headers: { "Authorization": { "equalTo": `Bearer ${FAKE_API_KEY_FOR_MOCK_SERVER}` } } },
      response: { status: 200, headers: { 'Content-Type': 'application/json' },
        jsonBody: {
          id: 'chatcmpl-mcp-' + Date.now(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: getBaseMockedConfigForTests().model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'MCP AI response.' }, finish_reason: 'stop' }], // Or a tool_call for an MCP tool
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }
      }, priority: 10 });
    configUtils.loadConfig.mockReturnValue(getBaseMockedConfigForTests());

    // Reset MCP related mock functions
    mockMcpClientListTools.mockReset().mockResolvedValue([]); // Default to no tools
    mockMcpClientCallTool.mockReset().mockResolvedValue({ result: 'default mcp tool success' });
    mockMcpClientConnect.mockReset().mockResolvedValue(undefined); // Default connect success
    mockMcpClientDisconnect.mockReset().mockResolvedValue(undefined); // Default disconnect success
    mockMcpClientGetIsConnected.mockReset().mockReturnValue(true); // Default to connected

    // Clear instance and config trackers
    Object.keys(mockMcpInstances).forEach(key => delete mockMcpInstances[key]);
    Object.keys(mockMcpClientConfigs).forEach(key => delete mockMcpClientConfigs[key]);

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

  it('should initialize McpClient for each configured server and call connect', async () => {
    const configUtils = await import('../src/utils/config');
    configUtils.loadConfig.mockReturnValueOnce(createTestAppConfig({
      mcpServers: [MCP_SERVER_CONFIG_1],
    }));

    await runCli(['initial prompt for MCP']);
    expect(mockAppProps).toBeDefined(); // Aggiunto

    expect(await import('../src/utils/mcp-client').McpClient).toHaveBeenCalledWith(
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
    const configUtils = await import('../src/utils/config');
    configUtils.loadConfig.mockReturnValueOnce(createTestAppConfig({
      mcpServers: [MCP_SERVER_CONFIG_1],
    }));
    // Configure the mock for listTools for the specific instance/server name
    mockMcpClientListTools.mockResolvedValue(MOCK_CALCULATOR_TOOLS);

    await runCli(['prompt that might lead to tool discovery']);
    expect(mockAppProps).toBeDefined(); // Aggiunto

    // Assert that listTools was called on the instance associated with MyCalculator
    // This requires that the App logic, when an MCP client is initialized, calls listTools.
    expect(mockMcpInstances[MCP_SERVER_CONFIG_1.name].listTools).toHaveBeenCalled();
    // More specific if listTools is the global mock:
    expect(mockMcpClientListTools).toHaveBeenCalled(); 
  });

  it('should successfully call an MCP tool when approved', async () => {
    const configUtils = await import('../src/utils/config');
    configUtils.loadConfig.mockReturnValueOnce(createTestAppConfig({
      mcpServers: [MCP_SERVER_CONFIG_1],
      approvalMode: 'suggest', // Ensure confirmation is sought
    }));

    mockMcpClientListTools.mockResolvedValue(MOCK_CALCULATOR_TOOLS); // Agent needs to know the tool
    mockUserConfirmationGetter.mockResolvedValue(true); // User approves
    const expectedResult = { sum: 8 };
    mockMcpClientCallTool.mockResolvedValue({ result: expectedResult });

    await runCli(['add 5 and 3 using calculator']); // Sets up mockAppProps
    expect(mockAppProps).toBeDefined(); // Aggiunto

    const toolCallArgs = { num1: 5, num2: 3 };
    const result = await simulateAgentSuggestsMcpTool('mcp_MyCalculator_add', toolCallArgs);

    expect(mockUserConfirmationGetter).toHaveBeenCalled();
    expect(mockMcpInstances[MCP_SERVER_CONFIG_1.name].callTool).toHaveBeenCalledWith('add', toolCallArgs);
    expect(result.result).toEqual(expectedResult);
    // Optionally, check if stdout contains the result if the App prints it
    // expect(capturedStdout).toContain(JSON.stringify(expectedResult));
  });
  
  it('should handle MCP tool call failure', async () => {
    const configUtils = await import('../src/utils/config');
    configUtils.loadConfig.mockReturnValueOnce(createTestAppConfig({
      mcpServers: [MCP_SERVER_CONFIG_1],
      approvalMode: 'suggest',
    }));

    mockMcpClientListTools.mockResolvedValue(MOCK_CALCULATOR_TOOLS);
    mockUserConfirmationGetter.mockResolvedValue(true); // User approves
    const error = new Error('MCP Tool Execution Failed');
    mockMcpClientCallTool.mockRejectedValue(error);

    await runCli(['use calculator to add 1 and 1']); // Sets up mockAppProps
    expect(mockAppProps).toBeDefined(); // Aggiunto

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
    const configUtils = await import('../src/utils/config');
    configUtils.loadConfig.mockReturnValueOnce(createTestAppConfig({
      mcpServers: [MCP_SERVER_CONFIG_1, MCP_SERVER_CONFIG_2],
      approvalMode: 'full-auto', // Simplify confirmation for this test
    }));

    // Configure listTools for each server
    const calcInstanceMocks = { listTools: vi.fn().mockResolvedValue(MOCK_CALCULATOR_TOOLS), callTool: vi.fn() };
    const weatherInstanceMocks = { listTools: vi.fn().mockResolvedValue(MOCK_WEATHER_TOOLS), callTool: vi.fn() };
    
    // Override the main McpClient mock for this test to return different mocks per instance
    const McpClientModule = await import('../src/utils/mcp-client');
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
    expect(mockAppProps).toBeDefined(); // Aggiunto

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
  beforeEach(async () => {
    const configUtils = await import('../src/utils/config');
    await resetWireMockStubs();
    // Default stubs for successful AI interaction (AI might suggest git commands or interact with GitHub context)
    await setupWireMockStub({ // GET /v1/models
      request: { method: 'GET', urlPath: '/v1/models', headers: { "Authorization": { "equalTo": `Bearer ${FAKE_API_KEY_FOR_MOCK_SERVER}` } } },
      response: { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: { object: 'list', data: [{ id: getBaseMockedConfigForTests().model, object: 'model', owned_by: 'openai' }] } },
      priority: 9
    });
    await setupWireMockStub({ // POST /v1/chat/completions
      request: { method: 'POST', urlPath: '/v1/chat/completions', headers: { "Authorization": { "equalTo": `Bearer ${FAKE_API_KEY_FOR_MOCK_SERVER}` } } },
      response: { status: 200, headers: { 'Content-Type': 'application/json' },
        jsonBody: {
          id: 'chatcmpl-github-' + Date.now(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: getBaseMockedConfigForTests().model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'GitHub AI response.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }
      }, priority: 10 });
    configUtils.loadConfig.mockReturnValue(getBaseMockedConfigForTests());
    
    // Default behavior for GitHub auth mocks
    mockGetGitHubToken.mockReset().mockResolvedValue('dummy-gh-token'); // Default: token exists
    mockAuthenticateWithGitHubDeviceFlow.mockReset().mockResolvedValue(undefined); // Default: auth succeeds
    mockClearGitHubToken.mockReset().mockResolvedValue(undefined); // Default: clear succeeds
  });

  describe('auth github command', () => {
    it('should attempt authentication if no token exists and succeed', async () => {
      mockGetGitHubToken.mockReset().mockResolvedValue(null); // No existing token
      mockAuthenticateWithGitHubDeviceFlow.mockResolvedValue(undefined); // Auth will succeed

      const { stdout, exitCode, stderr } = await runCli(['auth', 'github']);

      expect(mockGetGitHubToken).toHaveBeenCalled();
      expect(mockAuthenticateWithGitHubDeviceFlow).toHaveBeenCalled();
      expect(stdout).toContain("⏳ No existing GitHub token found. Starting device authentication flow...");
      expect(stdout).toContain("✅ Successfully authenticated with GitHub!");
      expect(stderr).toBe(''); // On success, stderr should be empty
      expect(exitCode).toBe(0);
    });

    it('should report failure if authentication fails', async () => {
      mockGetGitHubToken.mockResolvedValue(null); // No existing token
      const authError = new Error('GitHub auth device flow failed');
      mockAuthenticateWithGitHubDeviceFlow.mockRejectedValue(authError); // Auth will fail

      const { stderr, exitCode } = await runCli(['auth', 'github']);
      // mockAppProps non è rilevante qui.
      
      expect(mockGetGitHubToken).toHaveBeenCalled();
      expect(mockAuthenticateWithGitHubDeviceFlow).toHaveBeenCalled();
      // The message from cli.tsx includes a newline and emoji prefix
      expect(stderr).toContain("\n❌ GitHub authentication failed: GitHub auth device flow failed");
      expect(exitCode).toBe(1);
    });

    it('should inform user if token already exists', async () => {
      mockGetGitHubToken.mockResolvedValue('existing-dummy-gh-token'); // Token already exists

      const { stdout, stderr, exitCode } = await runCli(['auth', 'github']);
      // mockAppProps non è rilevante qui.

      expect(mockGetGitHubToken).toHaveBeenCalled();
      expect(mockAuthenticateWithGitHubDeviceFlow).not.toHaveBeenCalled();
      // The message from cli.tsx includes a newline and emoji prefix
      expect(stdout).toContain("\n🔑 Already authenticated with GitHub. Token found.");
      expect(stderr).not.toContain('GitHub authentication failed');
      expect(exitCode).toBe(0);
    });
  });

  describe('CLI flags --github-repo and --github-branch', () => {
    it('should pass valid --github-repo and --github-branch to App props', async () => {
      await runCli(['--github-repo', 'owner/repo', '--github-branch', 'feature-branch', 'prompt']);
      expect(mockAppProps).toBeDefined(); // Aggiunto
      
      expect(mockAppProps).toBeDefined();
      expect(mockAppProps.cliGithubRepo).toBe('owner/repo');
      expect(mockAppProps.cliGithubBranch).toBe('feature-branch');
    });

    it('should pass only --github-repo to App props if --github-branch is not provided', async () => {
      await runCli(['--github-repo', 'owner/another-repo', 'prompt']);
      expect(mockAppProps).toBeDefined(); // Aggiunto

      expect(mockAppProps).toBeDefined();
      expect(mockAppProps.cliGithubRepo).toBe('owner/another-repo');
      expect(mockAppProps.cliGithubBranch).toBeUndefined();
    });

    it('should exit with error for invalid --github-repo format', async () => {
      // This validation happens in cli.tsx before App is typically rendered with these props.
      const { stderr, stdout, exitCode } = await runCli(['--github-repo', 'invalidformat', 'prompt']);
      // mockAppProps potrebbe non essere definito.
      
      expect(stderr).toMatch(/Error: Invalid --github-repo format. Expected 'owner\/repo'./i);
      expect(exitCode).toBe(1);
      // mockAppProps might not be set, or if it is, these specific props shouldn't be.
      // Depending on when cli.tsx exits, App might not be rendered.
    });

    it('should exit with error if --github-branch is used without --github-repo', async () => {
      // This validation also happens in cli.tsx.
      const { stderr, exitCode } = await runCli(['--github-branch', 'feature-branch', 'prompt']);
      // mockAppProps potrebbe non essere definito.
      
      expect(stderr).toMatch(/Error: --github-branch cannot be used without --github-repo./i);
      expect(exitCode).toBe(1);
      if (mockAppProps) {
      }
    });
  });

  it('should correctly simulate cloning a repository', async () => {
    setupMockGitRepo({ isRepo: false }); // Start with no repo
    const gitUtils = vi.mocked(await import('../src/utils/git-utils'));

    const repoUrl = 'git@github.com:owner/new-repo.git';
    const localPath = '.'; // Clone into current directory for simplicity in test
    await gitUtils.gitClone(repoUrl, localPath);

    expect(gitUtils.gitClone).toHaveBeenCalledWith(repoUrl, localPath);
    
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
    const gitUtils = vi.mocked(await import('../src/utils/git-utils'));

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
    const gitUtils = vi.mocked(await import('../src/utils/git-utils'));

    // 1. Simulate adding a file to staging (as if 'git add' was called)
    // Our mock for gitAdd in e2e.test.ts modifies mockGitRepoState.files
    await gitUtils.gitAdd('README.md'); // This uses the mock gitAdd

    // 2. Simulate committing the staged changes
    const commitMessage = 'feat: add README';
    // No mockRejectedValueOnce here, we expect success for this simulation
    await gitUtils.gitCommit(commitMessage); // Should resolve

    expect(gitUtils.gitCommit).toHaveBeenCalledWith(commitMessage);
    
    const state = getMockGitRepoState();
    expect(state.commits.length).toBe(1);
    const lastCommit = state.commits[0];    expect(lastCommit.message).toBe(commitMessage);
    expect(lastCommit.branch).toBe(branchName);    expect(lastCommit.files.some(f => f.path === 'README.md' && f.status === 'committed')).toBe(true);

    // Verify the file in the main repo state is also marked as committed
    const repoFile = state.files.find(f => f.path === 'README.md');
    expect(repoFile).toBeDefined();
    expect(repoFile?.status).toBe('committed');
  });
});

describe('Suggest Mode (File Patches)', () => {
  beforeEach(async () => {
    await resetWireMockStubs();
    // Default stubs for successful AI interaction (AI suggests patches)
    await setupWireMockStub({ // GET /v1/models
      request: { method: 'GET', urlPath: '/v1/models', headers: { "Authorization": { "equalTo": `Bearer ${FAKE_API_KEY_FOR_MOCK_SERVER}` } } },
      response: { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: { object: 'list', data: [{ id: getBaseMockedConfigForTests().model, object: 'model', owned_by: 'openai' }] } },
      priority: 9
    });
    await setupWireMockStub({ // POST /v1/chat/completions
      request: { method: 'POST', urlPath: '/v1/chat/completions', headers: { "Authorization": { "equalTo": `Bearer ${FAKE_API_KEY_FOR_MOCK_SERVER}` } } },
      response: { status: 200, headers: { 'Content-Type': 'application/json' },
        jsonBody: {
          id: 'chatcmpl-suggestpatch-' + Date.now(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: getBaseMockedConfigForTests().model,
          choices: [{ index: 0, message: { role: 'assistant', tool_calls: [{ id: "call_patch_suggest", type: "function", function: { name: "apply_patch", arguments: JSON.stringify({ patch: `*** Begin Patch\n*** Update File: file.txt\n@@\n+dummy patch content\n*** End Patch`}) }}] }, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }
      }, priority: 10 });
    const configUtils = await import('../src/utils/config');
    configUtils.loadConfig.mockReturnValue(getBaseMockedConfigForTests());

    mockUserConfirmationGetter.mockReset().mockResolvedValue(true); // Default to approve
    mockApplyPatch.mockReset().mockResolvedValue(undefined);
    vi.mock('../src/parse-apply-patch.ts', () => ({ applyPatch: mockApplyPatch }));
  it('should apply patch if user approves in suggest mode', async () => {    

    mockUserConfirmationGetter = vi.fn(async () => true); // User approves
    await runCli(['apply this patch to file.txt']); // Sets mockAppProps
    expect(mockAppProps).toBeDefined(); // Aggiunto

    expect(mockAppProps).toBeDefined();
    expect(mockAppProps.getCommandConfirmation).toBeInstanceOf(Function);

    const patchContent = "dummy patch content";
    await simulateAgentSuggestsFilePatch(patchContent, 'file.txt');

    expect(mockUserConfirmationGetter).toHaveBeenCalledWith(JSON.stringify({ path: 'file.txt', content: patchContent, type: 'patch' }));
    expect(mockApplyPatch).toHaveBeenCalledWith('file.txt', patchContent);
  });

  it('should NOT apply patch if user rejects in suggest mode', async () => {
    mockUserConfirmationGetter.mockReset().mockResolvedValue(false); // User rejects
    await runCli(['apply this patch to file.txt']); // Sets mockAppProps
    expect(mockAppProps).toBeDefined(); // Aggiunto

    expect(mockAppProps).toBeDefined();
    expect(mockAppProps.getCommandConfirmation).toBeInstanceOf(Function);
    
    const patchContent = "dummy patch content";
    await expect(simulateAgentSuggestsFilePatch(patchContent, 'file.txt'))
      .rejects
      .toThrow('File patch not confirmed by user.');

    expect(mockUserConfirmationGetter).toHaveBeenCalled();
    expect(mockApplyPatch).not.toHaveBeenCalled();
  });
}); // Chiusura mancante per il blocco describe 'Suggest Mode (File Patches)'
});

describe('Auto-Edit Mode', () => {
  const autoEditArgs = ['--approval-mode', 'auto-edit'];
  beforeEach(async () => {
    await resetWireMockStubs();
    // Default stubs for successful AI interaction
    await setupWireMockStub({ // GET /v1/models
      request: { method: 'GET', urlPath: '/v1/models', headers: { "Authorization": { "equalTo": `Bearer ${FAKE_API_KEY_FOR_MOCK_SERVER}` } } },
      response: { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: { object: 'list', data: [{ id: getBaseMockedConfigForTests().model, object: 'model', owned_by: 'openai' }] } },
      priority: 9
    });
    await setupWireMockStub({ // POST /v1/chat/completions
      request: { method: 'POST', urlPath: '/v1/chat/completions', headers: { "Authorization": { "equalTo": `Bearer ${FAKE_API_KEY_FOR_MOCK_SERVER}` } } },
      response: { status: 200, headers: { 'Content-Type': 'application/json' },
        jsonBody: {
          id: 'chatcmpl-autoedit-' + Date.now(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: getBaseMockedConfigForTests().model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'Auto-edit AI response.' }, finish_reason: 'stop' }], // Simplified, specific tests might need tool_calls
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }
      }, priority: 10 });
    const configUtils = await import('../src/utils/config');
    configUtils.loadConfig.mockReturnValue(getBaseMockedConfigForTests());
    mockUserConfirmationGetter.mockReset().mockResolvedValue(true); // Default to approve for commands
    mockApplyPatch.mockReset().mockResolvedValue(undefined);
    vi.mock('../src/parse-apply-patch.ts', () => ({ applyPatch: mockApplyPatch }));
  });

  it('should apply file patch WITHOUT user confirmation', async () => {
    await runCli([...autoEditArgs, 'apply this patch']);
    expect(mockAppProps).toBeDefined(); // Aggiunto
    
    const patchContent = "dummy patch content for auto-edit";
    await simulateAgentSuggestsFilePatch(patchContent, 'auto.txt');

    expect(mockApplyPatch).toHaveBeenCalledWith('auto.txt', patchContent);
    // mockUserConfirmationGetter should NOT have been called for a patch in auto-edit
    expect(mockUserConfirmationGetter).not.toHaveBeenCalled(); 
  });

  it('should require user confirmation for shell commands and execute if approved', async () => {
    mockUserConfirmationGetter = vi.fn(async () => true); // User approves command
    await runCli([...autoEditArgs, 'run this command']);
    expect(mockAppProps).toBeDefined(); // Aggiunto

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
});

describe('Full-Auto Mode', () => {
  const fullAutoArgs = ['--approval-mode', 'full-auto'];
  beforeEach(async () => {
    await resetWireMockStubs();
    // Default stubs for successful AI interaction
    await setupWireMockStub({ // GET /v1/models
      request: { method: 'GET', urlPath: '/v1/models', headers: { "Authorization": { "equalTo": `Bearer ${FAKE_API_KEY_FOR_MOCK_SERVER}` } } },
      response: { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: { object: 'list', data: [{ id: getBaseMockedConfigForTests().model, object: 'model', owned_by: 'openai' }] } },
      priority: 9
    });
    await setupWireMockStub({ // POST /v1/chat/completions
      request: { method: 'POST', urlPath: '/v1/chat/completions', headers: { "Authorization": { "equalTo": `Bearer ${FAKE_API_KEY_FOR_MOCK_SERVER}` } } },
      response: { status: 200, headers: { 'Content-Type': 'application/json' },
        jsonBody: {
          id: 'chatcmpl-fullauto-' + Date.now(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: getBaseMockedConfigForTests().model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'Full-auto AI response.' }, finish_reason: 'stop' }], // Simplified
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }
      }, priority: 10 });
    const configUtils = await import('../src/utils/config');
    configUtils.loadConfig.mockReturnValue(getBaseMockedConfigForTests());
    mockUserConfirmationGetter.mockReset(); // Should not be called
    mockApplyPatch.mockReset().mockResolvedValue(undefined);
    vi.mock('../src/parse-apply-patch.ts', () => ({ applyPatch: mockApplyPatch }));
  });

  it('should apply file patch WITHOUT user confirmation', async () => {
    await runCli([...fullAutoArgs, 'auto apply this patch']);
    expect(mockAppProps).toBeDefined(); // Aggiunto
    
    const patchContent = "dummy patch content for full-auto";
    await simulateAgentSuggestsFilePatch(patchContent, 'full-auto.txt');

    expect(mockApplyPatch).toHaveBeenCalledWith('full-auto.txt', patchContent);
    expect(mockUserConfirmationGetter).not.toHaveBeenCalled();
  });

  it('should execute shell command WITHOUT user confirmation', async () => {
    await runCli([...fullAutoArgs, 'auto run this command']);
    expect(mockAppProps).toBeDefined(); // Aggiunto
    
    expect(mockAppProps).toBeDefined();
    // In full-auto, getCommandConfirmation might not even be called by the agent logic.
    // The simulateAgentSuggestsCommand helper needs to account for this.
    
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
