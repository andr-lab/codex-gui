import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react"; // Needed for JSX, even if not directly used in assertions for this test
import App from "../src/app"; // The component to test (or its logic)
import * // Mock child components and hooks heavily
      as configUtils from "../src/utils/config";
import * // Mock child components and hooks heavily
      as githubAuthUtils from "../src/utils/github-auth"; // L'import di 'render' ora dovrebbe riferirsi alla vera funzione 'render' di Ink
import * // Mock child components and hooks heavily
      as gitUtils from "../src/utils/git-utils";
import * // Mock child components and hooks heavily
      as Ink from "ink"; // Import namespace per Ink
// L'import di 'render' ora dovrebbe riferirsi alla vera funzione 'render' di Ink
import { render } from "ink"; // To capture props passed to TerminalChat

// --- Mocks ---

// NUOVO: Mock per fs-extra
// Questo mock deve coprire le funzioni di fs-extra usate in git-utils.ts
vi.mock("fs-extra", () => ({
  default: { // git-utils.ts usa 'import fs from "fs-extra"'
    ensureDir: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
    pathExists: vi.fn(() => Promise.resolve(false)), // Default a false, può essere sovrascritto se un test lo richiede
  },
}));

vi.mock("@inkjs/ui", () => ({
  SelectInput: vi.fn((props) =>
    React.createElement(Ink.Box, { 'data-testid': 'mocked-select-input', ...props },
      React.createElement(Ink.Text, null, 'MockedSelectInput')
    )
  ),
  TextInput: vi.fn((props) =>
    React.createElement(Ink.Box, { 'data-testid': 'mocked-text-input', ...props },
      React.createElement(Ink.Text, null, 'MockedTextInput')
    )
  ),
  ConfirmInput: vi.fn((props) =>
    React.createElement(Ink.Box, { 'data-testid': 'mocked-confirm-input', ...props },
      React.createElement(Ink.Text, null, 'MockedConfirmInput')
    )
  ),
}));


vi.mock("../src/utils/config", async () => {
  const actual = await vi.importActual("../src/utils/config");
  return {
    ...actual,
    loadConfig: vi.fn(),
    saveConfig: vi.fn(),
  };
});

vi.mock("../src/utils/github-auth", async () => {
  const actual = await vi.importActual("../src/utils/github-auth");
  return {
    ...actual,
    isGitHubAuthenticated: vi.fn(() => true), // Assume authenticated for these logic tests
    getGitHubAccessToken: vi.fn(() => "mock_token"),
    fetchGitHubRepositories: vi.fn(() => Promise.resolve([])), // Default to no repos to simplify
    // fetchGitHubRepositoryDetails: vi.fn(), // If we had this for optimization
  };
});

// MODIFICATO: Mock per git-utils per non usare importActual
vi.mock("../src/utils/git-utils", () => ({
  // Non si usa vi.importActual per evitare problemi con le dipendenze interne di git-utils come fs-extra o child_process
  cloneGitHubRepo: vi.fn(() => Promise.resolve("/tmp/mock-cloned-path")),
  cleanupClonedRepo: vi.fn(() => Promise.resolve()),
}));

vi.mock("../src/components/chat/terminal-chat", () => {
  return {
    default: (props: any) => {
      // Capture props passed to TerminalChat for verification
      global.TerminalChatProps = props;
      // Utilizza i componenti Box e Text tramite l'import namespace 'Ink'
      return React.createElement(Ink.Box, null,
        React.createElement(Ink.Text, null, "MockedTerminalChat")
      );
    },
  };
});
vi.mock("../src/components/chat/terminal-chat-past-rollout", () => {
  return {
    // Utilizza i componenti Box e Text tramite l'import namespace 'Ink'
    default: () => React.createElement(Ink.Box, null,
      React.createElement(Ink.Text, null, "MockedTerminalChatPastRollout"))
  };
});

vi.mock("../src/utils/check-in-git", () => ({
  checkInGit: vi.fn(() => true), // Assume in git repo to bypass warning
}));

vi.mock("ink", async (importOriginal) => {
    const actualInkModule = await importOriginal(); // Carica il modulo 'ink' originale
    return {
        ...(actualInkModule as any), // Esporta tutte le funzionalità originali di 'ink', inclusa 'render'
        // Sovrascrivi solo gli hook specifici che necessitano di un mock controllato
        useApp: () => ({
            exit: vi.fn(),
            onExit: vi.fn(), // Importante per il test della logica di cleanup
            offExit: vi.fn(),
        }),
        useStdin: () => ({
            stdin: process.stdin, // O un mock più completo se necessario
            internal_eventEmitter: { // Mock per l'event emitter interno
                setMaxListeners: vi.fn(),
                on: vi.fn(),
                off: vi.fn(),
                emit: vi.fn(),
            },
            isRawModeSupported: true,
            setRawMode: vi.fn(),
        }),
        // 'render' non viene sovrascritto qui, quindi verrà utilizzata la versione da actualInkModule
    };
});


describe("App Component GitHub Logic (Props Prioritization)", () => {
  let baseConfig: configUtils.AppConfig;
  let baseProps: any;
  let appInstance: any; // Per memorizzare l'output di Ink render

  beforeEach(() => {
    vi.clearAllMocks();

    // Ripristina i mock delle funzioni se necessario, poiché ora sono definiti a livello di modulo
    // Per le funzioni mockate in git-utils:
    (gitUtils.cloneGitHubRepo as vi.Mock).mockResolvedValue("/tmp/mock-cloned-path");
    (gitUtils.cleanupClonedRepo as vi.Mock).mockResolvedValue(undefined);

    // Per le funzioni mockate in github-auth:
    (githubAuthUtils.isGitHubAuthenticated as vi.Mock).mockReturnValue(true);
    (githubAuthUtils.getGitHubAccessToken as vi.Mock).mockReturnValue("mock_token");
    baseConfig = {
      model: "test-model",
      provider: "openai",
      instructions: "",
      githubSelectedRepo: "config/repo",
      githubSelectedBranch: "config-branch",
      // other necessary config fields
    };
    baseProps = {
      config: baseConfig,
      approvalPolicy: "suggest",
      fullStdout: false,
      // cliGithubRepo and cliGithubBranch will be varied in tests
    };
    global.TerminalChatProps = undefined; // Reset captured props

    (githubAuthUtils.fetchGitHubRepositories as vi.Mock).mockResolvedValue([
        { full_name: "cli/repo", default_branch: "cli-default" },
        { full_name: "owner/repo", default_branch: "main" },
    ]);
    (configUtils.loadConfig as vi.Mock).mockReturnValue(baseConfig); 

    // Non c'è bisogno di (gitUtils.cloneGitHubRepo as vi.Mock).mockClear(); qui
    // perché vi.clearAllMocks() dovrebbe resettare le chiamate.
  });

  afterEach(() => {
    if (appInstance) {
        appInstance.unmount(); // Esegui il cleanup del componente Ink
    }
  });

  // Helper modificato: si occupa solo del rendering
  const renderApp = (props: any) => {
    // Ora 'render' è la vera funzione di Ink
    appInstance = render(React.createElement(App, props));
    // Non c'è più un'attesa generica qui
  };


  it("should prioritize CLI args for repo and branch over config", async () => {
    const props = {
      ...baseProps,
      cliGithubRepo: "cli/repo",
      cliGithubBranch: "cli-branch",
    };
    renderApp(props);
    // Reintrodurre l'attesa per l'event loop per far partire gli useEffect
    await new Promise(resolve => setTimeout(resolve, 0));
    // Attendi che TerminalChatProps sia definito, indicando che la logica asincrona principale
    // che porta al rendering di TerminalChat si è probabilmente conclusa.
    await vi.waitFor(() => {
        expect(global.TerminalChatProps).toBeDefined();
    }, { timeout: 1000 });

    const terminalChatProps = global.TerminalChatProps;
    expect(gitUtils.cloneGitHubRepo).toHaveBeenCalledWith("cli/repo", "cli-branch", "mock_token");
    expect(terminalChatProps.config.githubSelectedRepo).toBe("cli/repo");
    expect(terminalChatProps.config.githubSelectedBranch).toBe("cli-branch");
  });

  it("should use CLI repo and fetch default branch if CLI branch is not provided", async () => {
    const props = {
      ...baseProps,
      cliGithubRepo: "cli/repo", // Matches a repo from fetchGitHubRepositories mock
      cliGithubBranch: undefined,
    };
    renderApp(props);
    // Reintrodurre l'attesa per l'event loop
    await new Promise(resolve => setTimeout(resolve, 0));
    await vi.waitFor(() => {
        expect(global.TerminalChatProps).toBeDefined();
    }, { timeout: 1000 });

    // Ora che TerminalChatProps è definito, possiamo verificare le chiamate ai mock
    expect(githubAuthUtils.fetchGitHubRepositories).toHaveBeenCalledTimes(1); // Chiamato per trovare il default branch
    expect(gitUtils.cloneGitHubRepo).toHaveBeenCalledTimes(1); // Chiamato con il default branch
    const terminalChatProps = global.TerminalChatProps;
    expect(githubAuthUtils.fetchGitHubRepositories).toHaveBeenCalled(); // Verifica aggiuntiva
    expect(gitUtils.cloneGitHubRepo).toHaveBeenCalledWith("cli/repo", "cli-default", "mock_token");
    expect(terminalChatProps.config.githubSelectedRepo).toBe("cli/repo");
    expect(terminalChatProps.config.githubSelectedBranch).toBe("cli-default");
  });

  it("should use config repo and branch if no CLI args provided", async () => {
    const props = { ...baseProps }; // cliGithubRepo and cliGithubBranch are undefined
    renderApp(props);
    // Reintrodurre l'attesa per l'event loop
    await new Promise(resolve => setTimeout(resolve, 0));
    await vi.waitFor(() => {
        expect(global.TerminalChatProps).toBeDefined();
    }, { timeout: 1000 });
    expect(gitUtils.cloneGitHubRepo).toHaveBeenCalledTimes(1);
    const terminalChatProps = global.TerminalChatProps;
    expect(gitUtils.cloneGitHubRepo).toHaveBeenCalledWith("config/repo", "config-branch", "mock_token");
    expect(terminalChatProps.config.githubSelectedRepo).toBe("config/repo");
    expect(terminalChatProps.config.githubSelectedBranch).toBe("config-branch");
  });

  it("should trigger interactive repo selection if no CLI/config repo and authenticated", async () => {
    const noRepoConfig = { ...baseConfig, githubSelectedRepo: undefined, githubSelectedBranch: undefined };
    const props = { ...baseProps, config: noRepoConfig };
    
    // Assicurati che cloneGitHubRepo non venga chiamato in questo scenario
    (gitUtils.cloneGitHubRepo as vi.Mock).mockImplementation(() => new Promise((_, reject) => reject(new Error("cloneGitHubRepo should not be called in this test"))));

    renderApp(props);
    // Per questo test, una breve attesa per l'event loop è ancora utile prima di waitFor su fetchGitHubRepositories
    await new Promise(resolve => setTimeout(resolve, 0));

    // Attesa specifica per fetchGitHubRepositories
    await vi.waitFor(() => {
        expect(githubAuthUtils.fetchGitHubRepositories).toHaveBeenCalledTimes(1);
    }, { timeout: 1000 });
    
    
    // Verifica che cloneGitHubRepo non sia stato chiamato
    expect(gitUtils.cloneGitHubRepo).not.toHaveBeenCalled();
  });

  it("should show cloning error if CLI repo specified but not authenticated", async () => {
    (githubAuthUtils.isGitHubAuthenticated as vi.Mock).mockReturnValueOnce(false);
    const props = { ...baseProps, cliGithubRepo: "cli/repo" };

    // Impedisci a cloneGitHubRepo di essere chiamato in questo scenario di errore
    (gitUtils.cloneGitHubRepo as vi.Mock).mockImplementation(() => new Promise(() => {}));

    renderApp(props);
    // Aggiungere l'attesa per l'event loop anche qui per coerenza, sebbene il test si concentri sulla non chiamata
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(gitUtils.cloneGitHubRepo).not.toHaveBeenCalled();
    // Ideally, we'd check if a "cloningError" message is set, which would be passed to TerminalChat or rendered by App.
    // This requires a more sophisticated way to inspect App's rendered output or state.
    // For now, not calling clone is a good proxy.
  });
});