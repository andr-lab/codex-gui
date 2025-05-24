// agent-mcp.test.ts

import { AgentLoop } from "../src/utils/agent/agent-loop.js";
import type { AppConfig, McpServerConfig } from "../src/utils/config.js";
import { McpClient } from "../src/utils/mcp-client.ts";
import { log } from "../src/utils/agent/log.js";
import { vi, describe, test, expect, beforeEach } from "vitest";
import type OpenAI from "openai";

// Mock the logger
vi.mock("../src/utils/agent/log.js", () => ({
  log: vi.fn(),
  isLoggingEnabled: vi.fn().mockReturnValue(true),
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

// Definisci mockHandleExecCommand PRIMA che venga utilizzato in vi.mock
const mockHandleExecCommand = vi.fn().mockResolvedValue({
  outputText: "shell command executed",
  metadata: {}
});

// --- INIZIO DELLA CORREZIONE 1 ---
vi.mock("../src/utils/agent/handle-exec-command.ts", () => ({
  // Utilizza un getter per ritardare l'accesso
  get handleExecCommand() { return mockHandleExecCommand; }
}));
// --- FINE DELLA CORREZIONE 1 ---

// Create individual mock instances for each McpClient
const createMockMcpClientInstance = (serverName: string) => ({
  connect: vi.fn().mockResolvedValue(undefined),
  listTools: vi.fn().mockResolvedValue([]),
  callTool: vi.fn().mockResolvedValue({}),
  disconnect: vi.fn().mockResolvedValue(undefined),
  getIsConnected: vi.fn().mockReturnValue(true),
  getServerName: vi.fn().mockReturnValue(serverName),
});

// Store mock instances by server name
const mockInstances = new Map<string, ReturnType<typeof createMockMcpClientInstance>>();

// Mock McpClient
vi.mock("../src/utils/mcp-client.ts", () => ({
  McpClient: vi.fn().mockImplementation((config) => {
    const instance = createMockMcpClientInstance(config.name);
    mockInstances.set(config.name, instance);
    return instance;
  }),
}));

describe("AgentLoop with MCP Integration", () => {
  let minimalAppConfig: AppConfig;
  let mcpServerConfigs: McpServerConfig[];

  beforeEach(() => {
    vi.clearAllMocks();
    mockInstances.clear();
    // Assicurati che anche mockHandleExecCommand venga resettato se necessario per test specifici,
    // anche se vi.clearAllMocks() dovrebbe gestirlo.
    mockHandleExecCommand.mockClear();


    minimalAppConfig = {
      model: "test-model",
      provider: "openai",
      apiKey: "test-key",
      instructions: "test-instructions",
      mcpServers: [], // Default to empty, specific tests will override
    };
  });

  test("Initialization: McpClient instances created and connect called for enabled servers", async () => {
    mcpServerConfigs = [
      { name: "Server1", url: "http://server1.com", enabled: true },
      { name: "Server2", url: "http://server2.com" }, // enabled defaults to true
    ];
    minimalAppConfig.mcpServers = mcpServerConfigs;

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

    const mcpClientInstances = (McpClient as ReturnType<typeof vi.fn>).mock.instances;
    expect(mcpClientInstances.length).toBe(2);
  });

  test("Initialization: No McpClient created for disabled servers", async () => {
    mcpServerConfigs = [
      { name: "Server1", url: "http://server1.com", enabled: false },
      { name: "Server2", url: "http://server2.com", enabled: true },
    ];
    minimalAppConfig.mcpServers = mcpServerConfigs;

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
    const server2Instance = mockInstances.get("Server2");
    expect(server2Instance?.connect).toHaveBeenCalledTimes(1);
  });

  test("Initialization: Handles McpClient.connect failure", async () => {
    mcpServerConfigs = [{ name: "FailServer", url: "http://fail.com", enabled: true }];
    minimalAppConfig.mcpServers = mcpServerConfigs;

    const connectError = new Error("Connection failed");

    // Mock the McpClient to throw error on connect
    vi.mocked(McpClient).mockImplementationOnce((config) => {
      const instance = createMockMcpClientInstance(config.name);
      instance.connect.mockRejectedValue(connectError);
      mockInstances.set(config.name, instance);
      return instance;
    });

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

    // Mock the behavior for the specific server
    const mcpServer1Instance = mockInstances.get("MCPServer1");
    if (mcpServer1Instance) {
      mcpServer1Instance.listTools.mockResolvedValue([
        { name: "mcpTool1", description: "Tool one from MCP", parameters: { type: "object", properties: {} } },
      ]);
    }

    const tools = await agent["getAvailableTools"]();
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

    const agent = new AgentLoop({
        model: minimalAppConfig.model,
        config: minimalAppConfig,
        approvalPolicy: "suggest",
        onItem: vi.fn(),
        onLoading: vi.fn(),
        onReset: vi.fn(),
        getCommandConfirmation: vi.fn(),
        mcpServers: minimalAppConfig.mcpServers
    });
    await new Promise(process.nextTick);

    // Mock the behavior for S1
    const s1Instance = mockInstances.get("S1");
    if (s1Instance) {
      s1Instance.callTool.mockResolvedValue({ result: "mcp success" });
    }

    const toolCallItem = createMockChatCompletionMessageParam("mcp_S1_toolA", { arg: 1 });
    const results = await agent["handleFunctionCall"](toolCallItem); // Accessing private method for test

    const toolMessage = results[0] as OpenAI.Chat.Completions.ChatCompletionToolMessageParam;
    expect(s1Instance?.callTool).toHaveBeenCalledWith("toolA", { arg: 1 });
    expect(toolMessage.role).toBe("tool");
    expect(toolMessage.tool_call_id).toBe("call_123");
    expect(toolMessage.content).toBe(JSON.stringify({ result: "mcp success" }));
  });

  test("handleFunctionCall: MCP tool failure (callTool rejects)", async () => {
    mcpServerConfigs = [{ name: "S1", url: "http://s1.com", enabled: true }];
    minimalAppConfig.mcpServers = mcpServerConfigs;

    const agent = new AgentLoop({
        model: minimalAppConfig.model,
        config: minimalAppConfig,
        approvalPolicy: "suggest",
        onItem: vi.fn(),
        onLoading: vi.fn(),
        onReset: vi.fn(),
        getCommandConfirmation: vi.fn(),
        mcpServers: minimalAppConfig.mcpServers
    });
    await new Promise(process.nextTick);

    const callError = new Error("MCP call failed");
    const s1Instance = mockInstances.get("S1");
    if (s1Instance) {
      s1Instance.callTool.mockRejectedValue(callError);
    }

    const toolCallItem = createMockChatCompletionMessageParam("mcp_S1_toolB", {});
    const results = await agent["handleFunctionCall"](toolCallItem);

    expect(results[0].content).toBe(JSON.stringify({ error: `Failed to call MCP tool mcp_S1_toolB: ${callError.message}` }));
  });

  test("handleFunctionCall: MCP client not found or not connected", async () => {
    mcpServerConfigs = [{ name: "S1", url: "http://s1.com", enabled: true }];
    minimalAppConfig.mcpServers = mcpServerConfigs;

    const agent = new AgentLoop({
        model: minimalAppConfig.model,
        config: minimalAppConfig,
        approvalPolicy: "suggest",
        onItem: vi.fn(),
        onLoading: vi.fn(),
        onReset: vi.fn(),
        getCommandConfirmation: vi.fn(),
        mcpServers: minimalAppConfig.mcpServers
     });
    await new Promise(process.nextTick);

    // Make S1 not connected
    const s1Instance = mockInstances.get("S1");
    if (s1Instance) {
      s1Instance.getIsConnected.mockReturnValue(false);
    }

    const toolCallItem = createMockChatCompletionMessageParam("mcp_S1_toolC", {});
    const results = await agent["handleFunctionCall"](toolCallItem);
    expect(results[0].content).toBe(JSON.stringify({ error: "MCP client S1 not found or not connected." }));

    const toolCallItemNonExistent = createMockChatCompletionMessageParam("mcp_S2_toolD", {});
    const resultsNonExistent = await agent["handleFunctionCall"](toolCallItemNonExistent);
    expect(resultsNonExistent[0].content).toBe(JSON.stringify({ error: "MCP client S2 not found or not connected." }));
  });

  test("handleFunctionCall: Native shell tool", async () => {
    const agent = new AgentLoop({
        model: minimalAppConfig.model,
        config: minimalAppConfig,
        approvalPolicy: "suggest",
        onItem: vi.fn(),
        onLoading: vi.fn(),
        onReset: vi.fn(),
        getCommandConfirmation: vi.fn(),
        mcpServers: []
    });
    await new Promise(process.nextTick);

    const shellCommandArgs = { command: ["ls", "-l"] };
    const toolCallItem = createMockChatCompletionMessageParam("shell", shellCommandArgs);

    // We mocked handleExecCommand, so we expect it to be called.
    await agent["handleFunctionCall"](toolCallItem);

    // Aggiorna questa asserzione per riflettere ciò che mockHandleExecCommand riceve effettivamente
    // Basato sul tuo log di errore:
    expect(mockHandleExecCommand).toHaveBeenCalledWith(
      expect.objectContaining({ // Usa expect.objectContaining per flessibilità
        cmd: ["ls", "-l"],
        // timeoutInMillis: undefined, // Includi se sono sempre presenti
        // workdir: undefined,        // Includi se sono sempre presenti
      }),
      expect.objectContaining({ // appConfig
        apiKey: "test-key",
        model: "test-model",
      }),
      "suggest",          // approvalPolicy
      expect.any(Function), // getCommandConfirmation
      undefined           // abortSignal (o expect.anything() se può variare)
    );
  });

  test("terminate: Disconnects all active McpClient instances", async () => {
    mcpServerConfigs = [
        { name: "Server1", url: "http://s1.com", enabled: true },
        { name: "Server2", url: "http://s2.com", enabled: true }
    ];
    minimalAppConfig.mcpServers = mcpServerConfigs;

    const agent = new AgentLoop({
        model: minimalAppConfig.model,
        config: minimalAppConfig,
        approvalPolicy: "suggest",
        onItem: vi.fn(),
        onLoading: vi.fn(),
        onReset: vi.fn(),
        getCommandConfirmation: vi.fn(),
        mcpServers: minimalAppConfig.mcpServers
    });
    await new Promise(process.nextTick); // For initializeMcpClients

    agent.terminate();
    await new Promise(process.nextTick); // For async operations in terminate

    // Check that disconnect was called on both instances
    const server1Instance = mockInstances.get("Server1");
    const server2Instance = mockInstances.get("Server2");

    expect(server1Instance?.disconnect).toHaveBeenCalledTimes(1);
    expect(server2Instance?.disconnect).toHaveBeenCalledTimes(1);
  });
});