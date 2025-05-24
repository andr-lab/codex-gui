// mcp-client.test.ts

import { McpClient } from "../src/utils/mcp-client.js";
import type { McpServerConfig } from "../src/utils/config.js";
import { log } from "../src/utils/agent/log.js";
import { vi, describe, test, expect, beforeEach } from "vitest";

// Mock the logger
vi.mock("../src/utils/agent/log.js", () => ({
  log: vi.fn(),
}));

// Mock the SDK
const mockSdkClient = {
  connect: vi.fn(),
  listTools: vi.fn(),
  callTool: vi.fn(),
  disconnect: vi.fn(),
  on: vi.fn(), // Mock the 'on' event emitter method
};

// Create a mock constructor function for StreamableHTTPClientTransport
// Definisci mockStreamableHTTPClientTransportConstructor PRIMA che venga utilizzato in vi.mock
const mockStreamableHTTPClientTransportConstructor = vi.fn();

// --- INIZIO DELLA CORREZIONE 2 ---
// Mock the SDK module
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
  return {
    Client: vi.fn(() => mockSdkClient),
    // Utilizza un getter per ritardare l'accesso
    get StreamableHTTPClientTransport() { return mockStreamableHTTPClientTransportConstructor; }
  };
});
// --- FINE DELLA CORREZIONE 2 ---


describe("McpClient", () => {
  let serverConfig: McpServerConfig;

  beforeEach(() => {
    serverConfig = {
      name: "TestServer",
      url: "http://localhost:1234",
      enabled: true,
    };
    // Reset all mocks before each test
    vi.clearAllMocks();
    // Assicurati che anche i mock specifici vengano resettati se necessario
    mockStreamableHTTPClientTransportConstructor.mockClear();


    // Reset the mock implementations
    mockSdkClient.connect.mockResolvedValue(undefined);
    mockSdkClient.listTools.mockResolvedValue([]);
    mockSdkClient.callTool.mockResolvedValue({});
    mockSdkClient.disconnect.mockResolvedValue(undefined);
    mockSdkClient.on.mockClear(); // Resetta anche il mock 'on'
  });

  test("constructor does not initialize SDK client or transport immediately (lazy initialization)", () => {
    new McpClient(serverConfig);
    expect(mockStreamableHTTPClientTransportConstructor).not.toHaveBeenCalled();
    expect(mockSdkClient.connect).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(`[McpClient] Initializing for server: ${serverConfig.name} at ${serverConfig.url}`);
  });

  test("connect successfully initializes and connects the SDK client", async () => {
    const client = new McpClient(serverConfig);
    mockSdkClient.connect.mockResolvedValue(undefined);

    await client.connect();

    expect(mockStreamableHTTPClientTransportConstructor).toHaveBeenCalledWith(new URL(serverConfig.url));
    expect(log).toHaveBeenCalledWith(`[McpClient] Lazily initializing transport and client for ${serverConfig.name}`);
    expect(log).toHaveBeenCalledWith(`[McpClient] Client and transport initialized for ${serverConfig.name}.`);
    expect(mockSdkClient.connect).toHaveBeenCalledWith(mockStreamableHTTPClientTransportConstructor.mock.instances[0]);
    expect(client.getIsConnected()).toBe(true);
    expect(log).toHaveBeenCalledWith(`[McpClient] Successfully connected to ${serverConfig.name}.`);
  });

  test("connect throws if server URL is not defined", async () => {
    const client = new McpClient({ name: "NoUrlServer" } as McpServerConfig); // URL is undefined
    await expect(client.connect()).rejects.toThrow("Server URL is not defined for NoUrlServer. Cannot initialize client.");
    expect(log).toHaveBeenCalledWith("[McpClient] Server URL is not defined for NoUrlServer. Cannot initialize client.");
    expect(client.getIsConnected()).toBe(false);
  });

  test("connect throws if SDK client.connect rejects", async () => {
    const client = new McpClient(serverConfig);
    const connectError = new Error("SDK connection failed");
    mockSdkClient.connect.mockRejectedValue(connectError);

    await expect(client.connect()).rejects.toThrow(connectError);
    expect(client.getIsConnected()).toBe(false);
    expect(log).toHaveBeenCalledWith(`[McpClient] Failed to connect to ${serverConfig.name}: ${connectError.message}`);
  });

  test("connect throws if URL is invalid", async () => {
    const invalidServerConfig = { ...serverConfig, url: "invalid-url" };
    const client = new McpClient(invalidServerConfig);

    await expect(client.connect()).rejects.toThrow(); // Specific error message depends on URL constructor
    expect(client.getIsConnected()).toBe(false);
    // Check that log contains message about lazy initialization failure
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`[McpClient] Error during lazy initialization for ${invalidServerConfig.name}`));
  });
  test("listTools successfully retrieves tools after connection", async () => {
    const client = new McpClient(serverConfig);
    await client.connect(); // Ensure connected

    const mockTools = [{ name: "tool1", description: "A test tool" }];
    mockSdkClient.listTools.mockResolvedValue(mockTools);

    const tools = await client.listTools();

    expect(mockSdkClient.listTools).toHaveBeenCalled();
    expect(tools).toEqual(mockTools);
    expect(log).toHaveBeenCalledWith(`[McpClient] Found ${mockTools.length} tools on ${serverConfig.name}.`);
  });

  test("listTools throws if not connected", async () => {
    const client = new McpClient(serverConfig);
    await expect(client.listTools()).rejects.toThrow("Not connected to TestServer. Call connect() first.");
  });

  test("listTools throws if SDK client.listTools rejects", async () => {
    const client = new McpClient(serverConfig);
    await client.connect();

    const listToolsError = new Error("SDK listTools failed");
    mockSdkClient.listTools.mockRejectedValue(listToolsError);

    await expect(client.listTools()).rejects.toThrow(
      `[McpClient] Failed to list tools from ${serverConfig.name}: ${listToolsError.message}`
    );
    expect(log).toHaveBeenCalledWith(`[McpClient] Failed to list tools from ${serverConfig.name}: ${listToolsError.message}`);
  });

  test("callTool successfully calls a tool after connection", async () => {
    const client = new McpClient(serverConfig);
    await client.connect();

    const toolName = "myTool";
    const toolArgs = { param1: "value1" };
    const mockResult = { success: true, data: "tool output" };
    mockSdkClient.callTool.mockResolvedValue(mockResult);

    const result = await client.callTool(toolName, toolArgs);

    expect(mockSdkClient.callTool).toHaveBeenCalledWith({ name: toolName, arguments: toolArgs });
    expect(result).toEqual(mockResult);
    expect(log).toHaveBeenCalledWith(`[McpClient] Tool "${toolName}" on ${serverConfig.name} executed successfully.`);
  });

  test("callTool throws if not connected", async () => {
    const client = new McpClient(serverConfig);
    await expect(client.callTool("test", {})).rejects.toThrow("Not connected to TestServer. Call connect() first.");
  });

  test("callTool throws if SDK client.callTool rejects", async () => {
    const client = new McpClient(serverConfig);
    await client.connect();

    const callToolError = new Error("SDK callTool failed");
    mockSdkClient.callTool.mockRejectedValue(callToolError);
    const toolName = "errorTool";

    await expect(client.callTool(toolName, {})).rejects.toThrow(
      `[McpClient] Failed to call tool "${toolName}" on ${serverConfig.name}: ${callToolError.message}`
    );
    expect(log).toHaveBeenCalledWith(`[McpClient] Failed to call tool "${toolName}" on ${serverConfig.name}: ${callToolError.message}`);
  });

  test("disconnect successfully disconnects the SDK client", async () => {
    const client = new McpClient(serverConfig);
    await client.connect(); // Connect first

    mockSdkClient.disconnect.mockResolvedValue(undefined);
    await client.disconnect();

    expect(mockSdkClient.disconnect).toHaveBeenCalled();
    expect(client.getIsConnected()).toBe(false);
    expect(log).toHaveBeenCalledWith(`[McpClient] Successfully disconnected from ${serverConfig.name}.`);
  });

  test("disconnect does nothing if already disconnected (and client not initialized)", async () => {
    const client = new McpClient(serverConfig);
    // Ensure client is not initialized by not calling connect
    await client.disconnect(); // Attempt disconnect
    expect(mockSdkClient.disconnect).not.toHaveBeenCalled(); // Should not be called if client was never initialized fully
    expect(client.getIsConnected()).toBe(false);
    expect(log).toHaveBeenCalledWith(`[McpClient] Client for ${serverConfig.name} was not initialized. Nothing to disconnect.`);
  });

  test("disconnect does nothing if called multiple times after successful disconnect", async () => {
    const client = new McpClient(serverConfig);
    await client.connect();
    await client.disconnect(); // First disconnect

    mockSdkClient.disconnect.mockClear(); // Clear previous call count

    await client.disconnect(); // Second disconnect

    expect(mockSdkClient.disconnect).not.toHaveBeenCalled(); // Should not be called again
    expect(client.getIsConnected()).toBe(false);
    expect(log).toHaveBeenCalledWith(`[McpClient] Already disconnected from ${serverConfig.name}.`);
  });
  test("SDK client 'error' event sets isConnected to false", async () => {
    const client = new McpClient(serverConfig);
    await client.connect();
    expect(client.getIsConnected()).toBe(true);

    // Simulate the 'error' event being emitted by the SDK client
    // The mockSdkClient.on.mock.calls[0][1] should be the error handler function
    const errorHandler = mockSdkClient.on.mock.calls.find(call => call[0] === 'error')?.[1];
    expect(errorHandler).toBeDefined();

    if (errorHandler) {
      const testError = new Error("Simulated SDK connection error");
      errorHandler(testError); // Call the error handler
      expect(log).toHaveBeenCalledWith(`[McpClient] Connection error on ${serverConfig.name}: ${testError.message}`);
      expect(client.getIsConnected()).toBe(false);
    }
  });
});
