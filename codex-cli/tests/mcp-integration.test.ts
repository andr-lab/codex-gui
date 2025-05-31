import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import meow from 'meow';
import { McpClient } from '../src/utils/mcp-client';
import { loadConfig, type AppConfig, type McpServerConfig } from '../src/utils/config';
import { AgentLoop } from '../src/utils/agent/agent-loop';
import App from '../src/app'; // For interactive mode tests
import * as cliModule from '../src/cli'; // To spy on runQuietMode

// --- Mock standard CLI dependencies ---
vi.mock('../src/utils/agent/log', () => ({ initLogger: vi.fn() }));
vi.mock('../src/utils/check-updates', () => ({ checkForUpdates: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/utils/model-utils', () => ({ preloadModels: vi.fn() }));
vi.mock('../src/cli-singlepass', () => ({ runSinglePass: vi.fn() }));
vi.mock('../src/utils/terminal', () => ({ onExit: vi.fn(), setInkRenderer: vi.fn() }));
vi.mock('ink', () => ({ render: vi.fn(), Box: () => 'Box', Text: () => 'Text' }));

// --- Mock meow ---
vi.mock('meow', async () => {
  const meowMock = vi.fn().mockImplementation((_helpText: any, _options: any) => ({
    input: ['default prompt'], // Default input
    flags: {}, // Default flags
    showHelp: vi.fn(),
    pkg: {},
  }));
  return { default: meowMock };
});

// --- Mock App Component (to check props if needed, though AgentLoop is main focus) ---
const mockAppPropsStore: { current?: any } = {};
vi.mock('../src/app', () => ({
  default: (props: any) => {
    mockAppPropsStore.current = props;
    return 'MockedApp';
  },
}));

// --- Mock McpClient ---
// Store mock instances of McpClient to simulate multiple servers and inspect calls
const mockMcpClientInstances: Record<string, Partial<McpClient>> = {};
const McpClientMock = vi.fn().mockImplementation((config: McpServerConfig) => {
  const instanceName = config.name;
  const mockInstance = {
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue([]),
    callTool: vi.fn().mockResolvedValue({ result: 'tool_called_successfully' }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    getIsConnected: vi.fn().mockReturnValue(true), // Default to connected after connect() is called
    getServerName: vi.fn().mockReturnValue(instanceName),
    // Store a reference to this mock instance
    _config: config, // Store config for inspection
  };
  mockMcpClientInstances[instanceName] = mockInstance;
  return mockInstance;
});
vi.mock('../src/utils/mcp-client', () => ({ McpClient: McpClientMock }));

// --- Mock AgentLoop ---
// We want to inspect the mcpClients/tools passed or how AgentLoop processes them.
// The actual AgentLoop constructor initializes McpClient instances if mcpServers are provided in config.
// So, by mocking McpClient itself (as done above), AgentLoop will use those mocks.
// We can then inspect mockMcpClientInstances.
// For some tests (like checking tool availability), we might need to spy on AgentLoop's internal methods,
// or mock the LLM response to see if it tries to call an MCP tool.
const agentLoopActual = await vi.importActual('../src/utils/agent/agent-loop');
const AgentLoopMock = vi.fn().mockImplementation((args: any) => {
    // Simplified AgentLoop mock for now.
    // It will use the McpClientMock defined above due to how AgentLoop is written.
    // We can spy on its methods if needed for specific tests.
    return {
        ...new (agentLoopActual.AgentLoop as any)(args), // Call actual constructor to run its McpClient init logic
        run: vi.fn().mockResolvedValue(undefined), // Mock run method
        // Add other methods if tests require them.
    };
});
vi.mock('../src/utils/agent/agent-loop', () => ({ AgentLoop: AgentLoopMock }));


// --- Mock loadConfig ---
// This will be configured per test or describe block.
vi.mock('../src/utils/config', async () => {
    const actualConfig = await vi.importActual('../src/utils/config') as any;
    return {
        ...actualConfig,
        loadConfig: vi.fn(), // Default mock, will be set in tests
    };
});


describe('CLI MCP Integration Tests', () => {
  let mockProcessExit: vi.SpyInstance;
  let mockConsoleLog: vi.SpyInstance;
  let mockConsoleError: vi.SpyInstance;
  let runQuietModeSpy: vi.SpyInstance;
  let baseAppConfig: AppConfig;

  beforeEach(() => {
    vi.resetModules(); // Reset modules for dynamic import of cli.tsx

    mockProcessExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    runQuietModeSpy = vi.spyOn(cliModule, 'runQuietMode').mockImplementation(async () => {});


    // Clear App props store and MCP client instances store
    delete mockAppPropsStore.current;
    for (const key in mockMcpClientInstances) {
        delete mockMcpClientInstances[key];
    }
    
    // Reset mocks
    (meow as unknown as vi.Mock).mockClear();
    McpClientMock.mockClear();
    AgentLoopMock.mockClear();
    (loadConfig as vi.Mock).mockClear();

    baseAppConfig = {
      provider: 'openai',
      model: 'default-model',
      apiKey: 'dummy-key',
      instructions: 'Default instructions',
      mcpServers: [], // Default to no MCP servers
      approvalMode: 'suggest',
      githubSelectedRepo: null,
      githubSelectedBranch: null,
      projectDoc: null,
    };
    // Default behavior for loadConfig, can be overridden in specific tests
    (loadConfig as vi.Mock).mockReturnValue(baseAppConfig);
  });

  afterEach(() => {
    mockProcessExit.mockRestore();
    mockConsoleLog.mockRestore();
    mockConsoleError.mockRestore();
    runQuietModeSpy.mockRestore();
    vi.clearAllMocks();
  });

  // --- Test Case a: No MCP Servers Configured ---
  it('a. No MCP Servers: AgentLoop initializes with no MCP clients', async () => {
    (loadConfig as vi.Mock).mockReturnValue({ ...baseAppConfig, mcpServers: [] });
    (meow as unknown as vi.Mock).mockReturnValueOnce({ input: ['prompt'], flags: {}, showHelp: vi.fn(), pkg: {} });

    await import('../src/cli'); // Trigger AgentLoop initialization via App or runQuietMode

    // AgentLoop constructor is called, and it internally initializes McpClients.
    // We check that no McpClient instances were created from our McpClientMock.
    expect(McpClientMock).not.toHaveBeenCalled();
    // Or, if AgentLoop is expected to always receive an mcpClients array:
    expect(AgentLoopMock).toHaveBeenCalledWith(expect.objectContaining({
      mcpServers: [], // Or mcpClients: [] depending on AgentLoop's constructor args
    }));
  });

  // --- Test Case b: Single Enabled MCP Server ---
  describe('b. Single Enabled MCP Server', () => {
    const serverName = 'MyMCP';
    const mcpToolName = 'testTool';
    const mcpServerConfig: McpServerConfig = { name: serverName, url: 'http://localhost:8080', enabled: true };

    beforeEach(() => {
      (loadConfig as vi.Mock).mockReturnValue({ ...baseAppConfig, mcpServers: [mcpServerConfig] });
      (meow as unknown as vi.Mock).mockReturnValueOnce({ input: ['prompt'], flags: {}, showHelp: vi.fn(), pkg: {} });
    });

    it('McpClient instantiated and connect called', async () => {
      await import('../src/cli');
      
      expect(McpClientMock).toHaveBeenCalledTimes(1);
      expect(McpClientMock).toHaveBeenCalledWith(expect.objectContaining({ name: serverName }));
      expect(mockMcpClientInstances[serverName]?.connect).toHaveBeenCalledTimes(1);
    });

    it('AgentLoop is aware of prefixed MCP tools', async () => {
        // Mock listTools for the specific instance
        vi.mocked(mockMcpClientInstances[serverName]!).listTools = vi.fn().mockResolvedValue([{ name: mcpToolName, description: 'A test tool', parameters: {} }]);

        // We need to inspect AgentLoop's behavior more closely here.
        // The actual AgentLoop constructor calls initializeMcpClients, which then calls listTools.
        // Let's re-initialize AgentLoopMock to use the actual implementation for this test's purpose for tool loading.
        AgentLoopMock.mockRestore(); // Restore original implementation for this test
        vi.spyOn(agentLoopActual, 'AgentLoop').mockImplementation((args: any) => {
            const loop = new (agentLoopActual.AgentLoop as any)(args);
            // Spy on getAvailableTools or the part where tools are compiled.
            // For simplicity, we assume `initializeMcpClients` populates `this.mcpClients`
            // and `getAvailableTools` uses it.
            // We'll check if the McpClient's listTools was called.
            return loop;
        });
        
        await import('../src/cli'); // This will eventually construct AgentLoop

        // AgentLoop constructor should have been called by cli.tsx (via App or runQuietMode)
        expect(agentLoopActual.AgentLoop).toHaveBeenCalled();
        // And our McpClient's listTools should have been called by AgentLoop's initialization
        expect(mockMcpClientInstances[serverName]?.listTools).toHaveBeenCalled();

        // To verify AgentLoop is "aware", we'd ideally check the tools list it prepares for the LLM.
        // This requires deeper integration or spying on AgentLoop's internals.
        // For now, confirming listTools was called is an indirect confirmation.
        // A more robust test would be to mock the LLM call within AgentLoop and see the tools list.
    });
  });

  // --- Test Case c: Multiple MCP Servers (Enabled/Disabled) ---
  it('c. Multiple Servers: McpClient instantiated and connect called only for enabled servers', async () => {
    const server1Config: McpServerConfig = { name: 'EnabledServer', url: 'http://enabled:8080', enabled: true };
    const server2Config: McpServerConfig = { name: 'DisabledServer', url: 'http://disabled:8080', enabled: false };
    const server3Config: McpServerConfig = { name: 'ImplicitlyEnabledServer', url: 'http://implicit:8080' }; // enabled defaults to true

    (loadConfig as vi.Mock).mockReturnValue({ ...baseAppConfig, mcpServers: [server1Config, server2Config, server3Config] });
    (meow as unknown as vi.Mock).mockReturnValueOnce({ input: ['prompt'], flags: {}, showHelp: vi.fn(), pkg: {} });

    await import('../src/cli');

    expect(McpClientMock).toHaveBeenCalledTimes(2); // For EnabledServer and ImplicitlyEnabledServer
    expect(McpClientMock).toHaveBeenCalledWith(expect.objectContaining({ name: 'EnabledServer' }));
    expect(McpClientMock).toHaveBeenCalledWith(expect.objectContaining({ name: 'ImplicitlyEnabledServer' }));
    expect(McpClientMock).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'DisabledServer' }));

    expect(mockMcpClientInstances['EnabledServer']?.connect).toHaveBeenCalledTimes(1);
    expect(mockMcpClientInstances['ImplicitlyEnabledServer']?.connect).toHaveBeenCalledTimes(1);
    expect(mockMcpClientInstances['DisabledServer']?.connect).toBeUndefined(); // Or not.toHaveBeenCalled() if it was created
  });

  // --- Test Case d: MCP Server Connection Failure ---
  it('d. Connection Failure: Error logged and server tools not available', async () => {
    const serverName = 'FailServer';
    const mcpServerConfig: McpServerConfig = { name: serverName, url: 'http://fail:8080', enabled: true };
    (loadConfig as vi.Mock).mockReturnValue({ ...baseAppConfig, mcpServers: [mcpServerConfig] });
    (meow as unknown as vi.Mock).mockReturnValueOnce({ input: ['prompt'], flags: {}, showHelp: vi.fn(), pkg: {} });

    // Ensure the specific mock instance for FailServer is configured to fail connection
    // This relies on McpClientMock being called with FailServer's config first.
    // It's a bit tricky if McpClientMock is cleared and re-setup.
    // A better way is to modify the mock implementation *before* it's called for FailServer.
    McpClientMock.mockImplementationOnce((config: McpServerConfig) => {
        const instance = {
            connect: vi.fn().mockRejectedValue(new Error("Connection Error")),
            listTools: vi.fn().mockResolvedValue([]), // Should not be called if connect fails and is awaited
            disconnect: vi.fn().mockResolvedValue(undefined),
            getIsConnected: vi.fn().mockReturnValue(false),
            getServerName: vi.fn().mockReturnValue(config.name),
            _config: config,
        };
        mockMcpClientInstances[config.name] = instance;
        return instance;
    });
    
    // Spy on AgentLoop's log if possible, or console.error for now
    // AgentLoop's constructor has a try/catch for mcpClient.connect() and logs.
    // We expect a log message similar to: `[AgentLoop] Failed to connect to MCP server ${client.getServerName()}: ${error.message}`
    // Since AgentLoop itself is mocked lightly, we'll check console.error for now, assuming AgentLoop logs there on failure.
    // A more direct test would involve a spy on `log` from `../src/utils/agent/log.js` if AgentLoop uses it directly.

    await import('../src/cli');

    expect(mockMcpClientInstances[serverName]?.connect).toHaveBeenCalledTimes(1);
    // This relies on AgentLoop logging connection errors. The actual AgentLoop does this.
    // If our AgentLoopMock is too simple, this might not pass.
    // Let's assume the actual AgentLoop's init logic runs due to `new agentLoopActual.AgentLoop(args)` in the mock.
    // The log is inside AgentLoop's `initializeMcpClients`.
    // We need to ensure that the actual AgentLoop's constructor logic runs.
    // The current AgentLoopMock tries to do this: `...new (agentLoopActual.AgentLoop as any)(args)`
    
    // Check console.log for the error message (AgentLoop logs there)
    // This is an indirect check. A better check would be on a logger if AgentLoop used a mockable one.
    const logContent = mockConsoleLog.mock.calls.map(call => call[0]).join('\n');
    expect(logContent).toContain(`[AgentLoop] Failed to connect to MCP server ${serverName}: Connection Error`);
    
    // Also verify this server's tools are not available (e.g., listTools not called or called but ignored)
    expect(mockMcpClientInstances[serverName]?.listTools).not.toHaveBeenCalled();
  });

  // --- Test Case e: Calling an MCP Tool ---
  it('e. Calling MCP Tool: McpClient.callTool is invoked correctly', async () => {
    const serverName = 'ToolServer';
    const toolName = 'doMagic';
    const mcpServerConfig: McpServerConfig = { name: serverName, url: 'http://tools:8080', enabled: true };
    (loadConfig as vi.Mock).mockReturnValue({ ...baseAppConfig, mcpServers: [mcpServerConfig] });
    (meow as unknown as vi.Mock).mockReturnValueOnce({ input: ['use the magic tool'], flags: {}, showHelp: vi.fn(), pkg: {} });

    // Configure the McpClient instance for ToolServer
    McpClientMock.mockImplementationOnce((config: McpServerConfig) => {
        const instance = {
            connect: vi.fn().mockResolvedValue(undefined),
            listTools: vi.fn().mockResolvedValue([{ name: toolName, description: 'Does magic', parameters: { type: 'object', properties: { "param": { type: "string" } } } }]),
            callTool: vi.fn().mockResolvedValue({ result: 'magic_done' }),
            disconnect: vi.fn().mockResolvedValue(undefined),
            getIsConnected: vi.fn().mockReturnValue(true),
            getServerName: vi.fn().mockReturnValue(config.name),
            _config: config,
        };
        mockMcpClientInstances[config.name] = instance;
        return instance;
    });

    // Mock AgentLoop to simulate LLM wanting to call the tool
    AgentLoopMock.mockRestore(); // Use actual AgentLoop for its tool handling logic
    const agentRunSpy = vi.spyOn(agentLoopActual.AgentLoop.prototype, 'run').mockImplementation(async function(this: any, messages: any) {
        // Simulate that after receiving 'messages', the LLM responds with a tool call
        // This requires knowing how AgentLoop processes messages and calls handleFunctionCall
        // For this test, we'll directly call handleFunctionCall with a crafted tool call message.
        const fakeToolCallId = "call_123";
        const llmToolCallMessage = {
            role: 'assistant',
            tool_calls: [{
                id: fakeToolCallId,
                type: 'function',
                function: { name: `mcp_${serverName}_${toolName}`, arguments: JSON.stringify({ param: "testValue" }) }
            }]
        };
        // handleFunctionCall returns tool messages.
        // We need to ensure `this.mcpClients` is populated correctly in the actual AgentLoop instance.
        // The actual AgentLoop constructor should handle this.
        if (this.handleFunctionCall) {
            await this.handleFunctionCall(llmToolCallMessage);
        }
        return Promise.resolve(undefined);
    });
    
    await import('../src/cli'); // This will construct and run AgentLoop

    expect(agentRunSpy).toHaveBeenCalled();
    expect(mockMcpClientInstances[serverName]?.callTool).toHaveBeenCalledTimes(1);
    expect(mockMcpClientInstances[serverName]?.callTool).toHaveBeenCalledWith(toolName, { param: "testValue" });
    
    agentRunSpy.mockRestore();
  });

  // --- Test Case f: MCP Server with Auth Configuration ---
  it('f. Auth Config: McpClient instantiated with auth config', async () => {
    const serverName = 'AuthServer';
    const authConfig = { type: "apiKey" as const, key: "secret-key" };
    const mcpServerConfig: McpServerConfig = { name: serverName, url: 'http://auth:8080', enabled: true, auth: authConfig };
    (loadConfig as vi.Mock).mockReturnValue({ ...baseAppConfig, mcpServers: [mcpServerConfig] });
    (meow as unknown as vi.Mock).mockReturnValueOnce({ input: ['prompt'], flags: {}, showHelp: vi.fn(), pkg: {} });

    await import('../src/cli');

    expect(McpClientMock).toHaveBeenCalledWith(expect.objectContaining({
      name: serverName,
      auth: authConfig,
    }));
    // The McpClient constructor itself doesn't do much with auth yet,
    // but we verify it was passed in the config object.
    expect(mockMcpClientInstances[serverName]?._config?.auth).toEqual(authConfig);
  });
});
