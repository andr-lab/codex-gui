import { AgentLoop } from "../src/utils/agent/agent-loop.js";
import type { AppConfig, McpServerConfig } from "../src/utils/config.js";
import { McpClient } from "../src/utils/mcp-client.js";
import { log } from "../src/utils/agent/log.js";
import { vi, describe, test, expect, beforeEach, afterEach } from "vitest";
import type OpenAI from "openai";

// Mock the logger
vi.mock("../src/utils/agent/log.js", () => ({
  log: vi.fn(),
}));

// Mock OpenAI SDK
const mockCreateChatCompletion = vi.fn();
vi.mock("openai", () => ({
  default: vi.fn(() => ({
    chat: {
      completions: {
        create: mockCreateChatCompletion,
      },
    },
  })),
  APIConnectionTimeoutError: class extends Error { constructor(message?: string) { super(message); this.name = "APIConnectionTimeoutError";}},
}));


// Mock McpClient
const mockMcpClientInstance = {
  connect: vi.fn(),
  listTools: vi.fn(),
  callTool: vi.fn(),
  disconnect: vi.fn(),
  getIsConnected: vi.fn(),
  getServerName: vi.fn(),
};
vi.mock("../src/utils/mcp-client.js", () => ({
  McpClient: vi.fn(() => mockMcpClientInstance),
}));

// Mock handleExecCommand as it's called for shell tools and not the focus here
vi.mock("../src/utils/agent/handle-exec-command.js", () => ({
  handleExecCommand: vi.fn().mockResolvedValue({ outputText: "shell command executed", metadata: {} }),
}));


describe("AgentLoop with MCP Integration", () => {
  let minimalAppConfig: AppConfig;
  let mcpServerConfigs: McpServerConfig[];

  beforeEach(() => {
    vi.clearAllMocks();

    minimalAppConfig = {
      model: "test-model",
      provider: "openai",
      apiKey: "test-key",
      instructions: "test-instructions",
      mcpServers: [], // Default to empty, specific tests will override
    };
    
    // Reset shared mock instance state for McpClient methods
    mockMcpClientInstance.connect.mockReset();
    mockMcpClientInstance.listTools.mockReset();
    mockMcpClientInstance.callTool.mockReset();
    mockMcpClientInstance.disconnect.mockReset();
    mockMcpClientInstance.getIsConnected.mockReset();
    mockMcpClientInstance.getServerName.mockReset();
  });

  test("Initialization: McpClient instances created and connect called for enabled servers", async () => {
    mcpServerConfigs = [
      { name: "Server1", url: "http://server1.com", enabled: true },
      { name: "Server2", url: "http://server2.com" }, // enabled defaults to true
    ];
    minimalAppConfig.mcpServers = mcpServerConfigs;
    
    mockMcpClientInstance.connect.mockResolvedValue(undefined); // Mock connect to succeed

    new AgentLoop({
      model: minimalAppConfig.model,
      config: minimalAppConfig,
      approvalPolicy: "suggest",
      onItem: vi.fn(),
      onLoading: vi.fn(),
      onReset: vi.fn(),
      getCommandConfirmation: vi.fn(),
      mcpServers: minimalAppConfig.mcpServers,
    });

    // Wait for async operations in constructor (initializeMcpClients)
    await new Promise(process.nextTick);


    expect(McpClient).toHaveBeenCalledTimes(2);
    expect(McpClient).toHaveBeenCalledWith(mcpServerConfigs[0]);
    expect(McpClient).toHaveBeenCalledWith(mcpServerConfigs[1]);
    expect(mockMcpClientInstance.connect).toHaveBeenCalledTimes(2);
  });

  test("Initialization: No McpClient created for disabled servers", async () => {
    mcpServerConfigs = [
      { name: "Server1", url: "http://server1.com", enabled: false },
      { name: "Server2", url: "http://server2.com", enabled: true },
    ];
    minimalAppConfig.mcpServers = mcpServerConfigs;
    mockMcpClientInstance.connect.mockResolvedValue(undefined);


    new AgentLoop({
      model: minimalAppConfig.model,
      config: minimalAppConfig,
      approvalPolicy: "suggest",
      onItem: vi.fn(),
      onLoading: vi.fn(),
      onReset: vi.fn(),
      getCommandConfirmation: vi.fn(),
      mcpServers: minimalAppConfig.mcpServers,
    });
    await new Promise(process.nextTick);


    expect(McpClient).toHaveBeenCalledTimes(1);
    expect(McpClient).toHaveBeenCalledWith(mcpServerConfigs[1]); // Only Server2
    expect(mockMcpClientInstance.connect).toHaveBeenCalledTimes(1);
  });

  test("Initialization: Handles McpClient.connect failure", async () => {
    mcpServerConfigs = [{ name: "FailServer", url: "http://fail.com", enabled: true }];
    minimalAppConfig.mcpServers = mcpServerConfigs;
    
    const connectError = new Error("Connection failed");
    // Ensure the mock is reset and then set to reject for this specific test
    mockMcpClientInstance.connect.mockRejectedValueOnce(connectError);

    new AgentLoop({
      model: minimalAppConfig.model,
      config: minimalAppConfig,
      approvalPolicy: "suggest",
      onItem: vi.fn(),
      onLoading: vi.fn(),
      onReset: vi.fn(),
      getCommandConfirmation: vi.fn(),
      mcpServers: minimalAppConfig.mcpServers,
    });
    await new Promise(process.nextTick);


    expect(log).toHaveBeenCalledWith(`[AgentLoop] Failed to connect to MCP server FailServer: ${connectError.message}`);
  });

  test("getAvailableTools: Returns native and prefixed MCP tools", async () => {
    mcpServerConfigs = [{ name: "MCPServer1", url: "http://mcp.com", enabled: true }];
    minimalAppConfig.mcpServers = mcpServerConfigs;

    // Mock behavior for the McpClient instance that will be created
    mockMcpClientInstance.connect.mockResolvedValue(undefined);
    mockMcpClientInstance.getIsConnected.mockReturnValue(true);
    mockMcpClientInstance.listTools.mockResolvedValue([
      { name: "mcpTool1", description: "Tool one from MCP", parameters: { type: "object", properties: {} } },
    ]);

    const agent = new AgentLoop({
      model: minimalAppConfig.model,
      config: minimalAppConfig,
      approvalPolicy: "suggest",
      onItem: vi.fn(),
      onLoading: vi.fn(),
      onReset: vi.fn(),
      getCommandConfirmation: vi.fn(),
      mcpServers: minimalAppConfig.mcpServers,
    });
    await new Promise(process.nextTick); // allow initializeMcpClients to complete


    const tools = await agent.getAvailableTools();
    expect(tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ function: expect.objectContaining({ name: "shell" }) }),
        expect.objectContaining({
          function: expect.objectContaining({ name: "mcp_MCPServer1_mcpTool1", description: "[MCP Tool@MCPServer1] Tool one from MCP" }),
        }),
      ])
    );
    expect(tools.length).toBe(2);
  });
  
  const createMockChatCompletionMessageParam = (toolName: string, args: any, toolCallId: string = "call_123"): OpenAI.Chat.Completions.ChatCompletionMessageParam => {
    return {
      role: 'assistant',
      tool_calls: [
        {
          id: toolCallId,
          type: 'function',
          function: {
            name: toolName,
            arguments: JSON.stringify(args),
          },
        },
      ],
    };
  };

  test("handleFunctionCall: MCP tool success", async () => {
    mcpServerConfigs = [{ name: "S1", url: "http://s1.com", enabled: true }];
    minimalAppConfig.mcpServers = mcpServerConfigs;

    mockMcpClientInstance.connect.mockResolvedValue(undefined);
    mockMcpClientInstance.getIsConnected.mockReturnValue(true);
    mockMcpClientInstance.callTool.mockResolvedValue({ result: "mcp success" });

    const agent = new AgentLoop({ /* params */ 
        model: minimalAppConfig.model, config: minimalAppConfig, approvalPolicy: "suggest", 
        onItem: vi.fn(), onLoading: vi.fn(), onReset: vi.fn(), getCommandConfirmation: vi.fn(),
        mcpServers: minimalAppConfig.mcpServers
    });
    await new Promise(process.nextTick);

    const toolCallItem = createMockChatCompletionMessageParam("mcp_S1_toolA", { arg: 1 });
    const results = await agent["handleFunctionCall"](toolCallItem); // Accessing private method for test

    expect(mockMcpClientInstance.callTool).toHaveBeenCalledWith("toolA", { arg: 1 });
    expect(results[0].role).toBe("tool");
    expect(results[0].tool_call_id).toBe("call_123");
    expect(results[0].content).toBe(JSON.stringify({ result: "mcp success" }));
  });

  test("handleFunctionCall: MCP tool failure (callTool rejects)", async () => {
    mcpServerConfigs = [{ name: "S1", url: "http://s1.com", enabled: true }];
    minimalAppConfig.mcpServers = mcpServerConfigs;

    mockMcpClientInstance.connect.mockResolvedValue(undefined);
    mockMcpClientInstance.getIsConnected.mockReturnValue(true);
    const callError = new Error("MCP call failed");
    mockMcpClientInstance.callTool.mockRejectedValue(callError);

    const agent = new AgentLoop({ /* params */
        model: minimalAppConfig.model, config: minimalAppConfig, approvalPolicy: "suggest",
        onItem: vi.fn(), onLoading: vi.fn(), onReset: vi.fn(), getCommandConfirmation: vi.fn(),
        mcpServers: minimalAppConfig.mcpServers
    });
    await new Promise(process.nextTick);

    const toolCallItem = createMockChatCompletionMessageParam("mcp_S1_toolB", {});
    const results = await agent["handleFunctionCall"](toolCallItem);

    expect(results[0].content).toBe(JSON.stringify({ error: `Failed to call MCP tool mcp_S1_toolB: ${callError.message}` }));
  });

  test("handleFunctionCall: MCP client not found or not connected", async () => {
    mcpServerConfigs = [{ name: "S1", url: "http://s1.com", enabled: true }];
    minimalAppConfig.mcpServers = mcpServerConfigs;

    mockMcpClientInstance.connect.mockResolvedValue(undefined);
    mockMcpClientInstance.getIsConnected.mockReturnValue(false); // Simulate not connected

    const agent = new AgentLoop({ /* params */
        model: minimalAppConfig.model, config: minimalAppConfig, approvalPolicy: "suggest",
        onItem: vi.fn(), onLoading: vi.fn(), onReset: vi.fn(), getCommandConfirmation: vi.fn(),
        mcpServers: minimalAppConfig.mcpServers
     });
    await new Promise(process.nextTick);

    const toolCallItem = createMockChatCompletionMessageParam("mcp_S1_toolC", {});
    const results = await agent["handleFunctionCall"](toolCallItem);
    expect(results[0].content).toBe(JSON.stringify({ error: "MCP client S1 not found or not connected." }));

    const toolCallItemNonExistent = createMockChatCompletionMessageParam("mcp_S2_toolD", {});
    const resultsNonExistent = await agent["handleFunctionCall"](toolCallItemNonExistent);
    expect(resultsNonExistent[0].content).toBe(JSON.stringify({ error: "MCP client S2 not found or not connected." }));
  });
  
  test("handleFunctionCall: Native shell tool", async () => {
    const agent = new AgentLoop({ /* params - no mcpServers needed for this test */
        model: minimalAppConfig.model, config: minimalAppConfig, approvalPolicy: "suggest",
        onItem: vi.fn(), onLoading: vi.fn(), onReset: vi.fn(), getCommandConfirmation: vi.fn(),
        mcpServers: []
    });
    await new Promise(process.nextTick);

    const shellCommandArgs = { command: ["ls", "-l"] };
    const toolCallItem = createMockChatCompletionMessageParam("shell", shellCommandArgs);
    
    // We mocked handleExecCommand, so we expect it to be called.
    await agent["handleFunctionCall"](toolCallItem);

    expect(require("../src/utils/agent/handle-exec-command.js").handleExecCommand).toHaveBeenCalledWith(
      shellCommandArgs,
      expect.any(Object), // appConfig
      "suggest",          // approvalPolicy
      expect.any(Function), // getCommandConfirmation
      expect.anything()   // abortSignal
    );
    expect(mockMcpClientInstance.callTool).not.toHaveBeenCalled();
  });

  test("terminate: Disconnects all active McpClient instances", async () => {
    mcpServerConfigs = [
        { name: "Server1", url: "http://s1.com", enabled: true },
        { name: "Server2", url: "http://s2.com", enabled: true }
    ];
    minimalAppConfig.mcpServers = mcpServerConfigs;

    // For this test, we need McpClient constructor to be called multiple times
    // and each instance's disconnect to be tracked.
    // This requires a more sophisticated mock for McpClient itself.
    // However, with the current shared mockMcpClientInstance, we can only check if disconnect was called.
    // To properly test multiple instances, the mock setup for McpClient would need to change.
    // For now, we'll assert disconnect is called (implicitly, on the shared mock).
    
    mockMcpClientInstance.connect.mockResolvedValue(undefined);
    mockMcpClientInstance.getIsConnected.mockReturnValue(true); // Assume they all connected
    mockMcpClientInstance.getServerName.mockImplementation(() => "mockedServerName"); // Provide implementation

    const agent = new AgentLoop({ /* params */
        model: minimalAppConfig.model, config: minimalAppConfig, approvalPolicy: "suggest",
        onItem: vi.fn(), onLoading: vi.fn(), onReset: vi.fn(), getCommandConfirmation: vi.fn(),
        mcpServers: minimalAppConfig.mcpServers
    });
    await new Promise(process.nextTick); // For initializeMcpClients

    agent.terminate();
    await new Promise(process.nextTick); // For async operations in terminate

    // Since McpClient is mocked to return a single shared instance (mockMcpClientInstance),
    // we expect disconnect to have been called on that instance.
    // In a real scenario with multiple instances, you'd check disconnect on each.
    // Number of calls to McpClient constructor indicates how many "instances" were notionally created.
    const numClientsInitialized = (McpClient as ReturnType<typeof vi.fn>).mock.calls.length;
    if (numClientsInitialized > 0) {
        expect(mockMcpClientInstance.disconnect).toHaveBeenCalledTimes(numClientsInitialized);
    } else {
        // if no clients were initialized (e.g. all disabled), disconnect shouldn't be called.
        expect(mockMcpClientInstance.disconnect).not.toHaveBeenCalled();
    }
  });
});
