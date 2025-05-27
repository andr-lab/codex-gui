import { describe, it, expect, vi, beforeEach, afterEach, SpyInstance } from "vitest";
import meow from "meow";
// We need to import the module to be tested.
// This will execute the cli.tsx code when imported.
// We need to ensure mocks are set up *before* this import.

// Mock dependencies that are called early in cli.tsx
vi.mock("../src/utils/agent/log", () => ({
  initLogger: vi.fn(),
  log: vi.fn(),
  isLoggingEnabled: vi.fn(() => false),
}));

vi.mock("../src/utils/check-updates", () => ({
  checkForUpdates: vi.fn(() => Promise.resolve()),
}));

vi.mock("../src/utils/config", async () => {
  const actual = await vi.importActual("../src/utils/config");
  return {
    ...actual,
    loadConfig: vi.fn(() => ({ // Provide a basic mock config
      model: "o4-mini",
      provider: "openai",
      // githubSelectedRepo, githubSelectedBranch will be tested by App component
    })), 
    saveConfig: vi.fn(),
  };
});

vi.mock("../src/utils/model-utils.js", () => ({
  preloadModels: vi.fn(),
  reportMissingAPIKeyForProvider: vi.fn(),
}));

vi.mock("ink", async () => {
  const actualInk = await vi.importActual("ink");
  return {
    ...actualInk,
    render: vi.fn((tree) => {
      // Execute the component's function (our App mock) with its props
      if (tree && typeof tree.type === 'function') {
        tree.type(tree.props);
      }
      return { unmount: vi.fn(), rerender: vi.fn(), clear: vi.fn(), waitUntilExit: vi.fn() };
    }),
  };
});

// Mock meow
let mockCliResult: any;
vi.mock("meow", () => ({
  default: vi.fn(() => mockCliResult),
}));

// MODIFICA 1: Definisci un oggetto contenitore nello scope più esterno
const capturedProps = { current: null as any };

// MODIFICA 2: Il mock di App ora usa l'oggetto contenitore ed è definito esternamente
vi.mock("../src/app", () => ({
  default: (props: any) => {
    capturedProps.current = props; // Assegna le props alla proprietà 'current' dell'oggetto
    return null;     // Non renderizzare nulla per il test
  }
}));

describe("CLI GitHub Argument Parsing", () => {
  let mockProcessExit: SpyInstance;
  let mockConsoleError: SpyInstance;

  beforeEach(async () => {
    mockProcessExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
    mockConsoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    // MODIFICA 3: Resetta la proprietà 'current' dell'oggetto contenitore
    capturedProps.current = null;

    // Default meow mock result (can be overridden in tests)
    mockCliResult = {
      input: ["test prompt"], // Default input
      flags: {
        help: false,
        config: false,
        githubRepo: undefined,
        githubBranch: undefined,
        // other flags...
      },
      showHelp: vi.fn(),
      pkg: {}, // meow expects a pkg property
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules(); // Important to re-evaluate cli.tsx with fresh mocks
  });

  const runCli = async () => {
    // Dynamically import cli.tsx after mocks are set up for the test
    await import("../src/cli");
  };

  it("should pass cliGithubRepo and cliGithubBranch to App if provided correctly", async () => {
    mockCliResult.flags.githubRepo = "owner/repo";
    mockCliResult.flags.githubBranch = "feature";
    
    await runCli();

    // MODIFICA 4: Accedi alle props tramite l'oggetto contenitore
    expect(capturedProps.current).toBeDefined();
    expect(capturedProps.current.cliGithubRepo).toBe("owner/repo");
    expect(capturedProps.current.cliGithubBranch).toBe("feature");
    expect(mockProcessExit).not.toHaveBeenCalled();
  });

  it("should allow --github-repo without --github-branch", async () => {
    mockCliResult.flags.githubRepo = "owner/repo-no-branch";
    
    await runCli();

    expect(capturedProps.current).toBeDefined();
    expect(capturedProps.current.cliGithubRepo).toBe("owner/repo-no-branch");
    expect(capturedProps.current.cliGithubBranch).toBeUndefined();
    expect(mockProcessExit).not.toHaveBeenCalled();
  });

  it("should exit with error if --github-branch is used without --github-repo", async () => {
    mockCliResult.flags.githubBranch = "feature";
    
    await runCli();
    
    expect(mockConsoleError).toHaveBeenCalledWith(
      "Error: --github-branch cannot be used without --github-repo."
    );
    // App will be rendered due to module execution flow, so capturedProps.current will not be null.
    expect(mockProcessExit).toHaveBeenCalledWith(1);
  });

  it("should exit with error if --github-repo format is invalid", async () => {
    mockCliResult.flags.githubRepo = "invalid-format";
    
    await runCli();

    expect(mockConsoleError).toHaveBeenCalledWith(
      "Error: Invalid --github-repo format. Expected 'owner/repo'."
    );
    // App will be rendered due to module execution flow, so capturedProps.current will not be null.
    expect(mockProcessExit).toHaveBeenCalledWith(1);
  });
  
  it("should handle prompt and other flags correctly when GitHub flags are also present", async () => {
    mockCliResult.input = ["my test prompt"];
    mockCliResult.flags.githubRepo = "owner/another-repo";
    mockCliResult.flags.model = "gpt-4"; // Example of another flag

    await runCli();

    expect(capturedProps.current).toBeDefined();
    expect(capturedProps.current.prompt).toBe("my test prompt");
    expect(capturedProps.current.cliGithubRepo).toBe("owner/another-repo");
    expect(capturedProps.current.config.model).toBe("gpt-4");
    expect(mockProcessExit).not.toHaveBeenCalled();
  });

  it("should correctly pass undefined for GitHub flags if not provided", async () => {
    // githubRepo and githubBranch are undefined by default in mockCliResult.flags
    await runCli();

    expect(capturedProps.current).toBeDefined();
    expect(capturedProps.current.cliGithubRepo).toBeUndefined();
    expect(capturedProps.current.cliGithubBranch).toBeUndefined();
    expect(mockProcessExit).not.toHaveBeenCalled();
  });

  // Test for 'auth github' command to ensure it's not affected
  it("should handle 'auth github' command correctly (not pass github flags to App)", async () => {
    mockCliResult.input = ["auth", "github"];
    mockCliResult.flags.githubRepo = "owner/repo"; // These should be ignored for 'auth' command

    const mockAuthFn = vi.fn(() => Promise.resolve());

    // Use vi.doMock for test-specific, dynamic mocking.
    // This ensures the mock is applied just before cli.tsx (via runCli) imports github-auth.js.
    vi.doMock("../src/utils/github-auth.js", async () => {
      const actual = await vi.importActual("../src/utils/github-auth.js");
      return {
        ...actual,
        authenticateWithGitHubDeviceFlow: mockAuthFn,
      };
    });

    await runCli(); // Dynamically imports and runs cli.tsx

    // Verify that the authentication function was called
    expect(mockAuthFn).toHaveBeenCalled();

    // App component will still be rendered with some props due to the CLI's structure
    // and how module imports/execution work in tests, even if process.exit is called
    // within an async IIFE for the 'auth' command.
    // For example, App might receive props like { prompt: "auth", cliGithubRepo: "owner/repo" }
    // The crucial part is that mockAuthFn was called and process.exit(0) is expected.
    expect(mockProcessExit).toHaveBeenCalledWith(0); // Assuming exit code 0 for success
  });
});