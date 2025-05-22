import { Client, StreamableHTTPClientTransport, ToolDefinition } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServerConfig } from "./config.js";
import { log } from "./agent/log.js";

export class McpClient {
  private serverConfig: McpServerConfig;
  private transport: StreamableHTTPClientTransport | null = null;
  private client: Client | null = null;
  private isConnected: boolean = false;

  constructor(serverConfig: McpServerConfig) {
    this.serverConfig = serverConfig;
    log(`[McpClient] Initializing for server: ${this.serverConfig.name} at ${this.serverConfig.url}`);

    if (!this.serverConfig.url) {
      const errorMsg = `[McpClient] Server URL is not defined for ${this.serverConfig.name}. Cannot initialize.`;
      log(errorMsg);
      // Throw an error or handle this state appropriately, as client cannot function.
      // For now, we'll let it be, but connect() will fail.
      return;
    }

    // Initialization of transport and client is deferred to an init() method or before connect()
    // to handle potential errors more gracefully, especially if URL is invalid.
  }

  private async ensureClientInitialized(): Promise<void> {
    if (this.client && this.transport) {
      return; // Already initialized
    }

    if (!this.serverConfig.url) {
      const errorMsg = `[McpClient] Server URL is not defined for ${this.serverConfig.name}. Cannot initialize client.`;
      log(errorMsg);
      throw new Error(errorMsg);
    }

    try {
      log(`[McpClient] Lazily initializing transport and client for ${this.serverConfig.name}`);
      this.transport = new StreamableHTTPClientTransport(new URL(this.serverConfig.url));
      // TODO: Use actual CLI version if available dynamically
      this.client = new Client({ name: "codex-cli-mcp-client", version: "1.0.0" }); 
      log(`[McpClient] Client and transport initialized for ${this.serverConfig.name}.`);

      this.client.on('error', (error: Error) => {
        log(`[McpClient] Connection error on ${this.serverConfig.name}: ${error.message}`);
        this.isConnected = false;
        // Potentially attempt to reconnect or notify user
      });

    } catch (error: any) {
      const errorMsg = `[McpClient] Error during lazy initialization for ${this.serverConfig.name}: ${error.message}`;
      log(errorMsg);
      this.client = null; // Ensure client is null if init fails
      this.transport = null;
      throw new Error(errorMsg); // Re-throw to signal failure
    }
  }

  public async connect(): Promise<void> {
    if (this.isConnected) {
      log(`[McpClient] Already connected to ${this.serverConfig.name}.`);
      return;
    }

    try {
      await this.ensureClientInitialized(); // Initialize client and transport if not already done
      
      if (!this.client || !this.transport) { // Check again after initialization attempt
          const errorMsg = `[McpClient] Client or transport failed to initialize for ${this.serverConfig.name}. Cannot connect.`;
          log(errorMsg);
          throw new Error(errorMsg);
      }

      log(`[McpClient] Connecting to ${this.serverConfig.name} at ${this.serverConfig.url}...`);
      await this.client.connect(this.transport);
      this.isConnected = true;
      log(`[McpClient] Successfully connected to ${this.serverConfig.name}.`);
    } catch (error: any) {
      this.isConnected = false;
      // Error already logged by ensureClientInitialized if it failed there
      if (!error.message.includes("lazy initialization")) { // Avoid double logging
          const errorMsg = `[McpClient] Failed to connect to ${this.serverConfig.name}: ${error.message}`;
          log(errorMsg);
      }
      throw error; // Re-throw to signal connection failure
    }
  }

  public async listTools(): Promise<ToolDefinition[]> {
    await this.ensureClientInitialized();
    if (!this.isConnected || !this.client) {
      const errorMsg = `[McpClient] Not connected to ${this.serverConfig.name}. Call connect() first.`;
      log(errorMsg);
      throw new Error(errorMsg);
    }

    try {
      log(`[McpClient] Listing tools from ${this.serverConfig.name}...`);
      const tools = await this.client.listTools();
      log(`[McpClient] Found ${tools.length} tools on ${this.serverConfig.name}.`);
      return tools;
    } catch (error: any) {
      const errorMsg = `[McpClient] Failed to list tools from ${this.serverConfig.name}: ${error.message}`;
      log(errorMsg);
      throw new Error(errorMsg);
    }
  }

  public async callTool(toolName: string, args: any): Promise<any> {
    await this.ensureClientInitialized();
    if (!this.isConnected || !this.client) {
      const errorMsg = `[McpClient] Not connected to ${this.serverConfig.name}. Call connect() first.`;
      log(errorMsg);
      throw new Error(errorMsg);
    }

    try {
      log(`[McpClient] Calling tool "${toolName}" on ${this.serverConfig.name} with args: ${JSON.stringify(args)}`);
      const result = await this.client.callTool({ name: toolName, arguments: args });
      log(`[McpClient] Tool "${toolName}" on ${this.serverConfig.name} executed successfully.`);
      return result;
    } catch (error: any) {
      const errorMsg = `[McpClient] Failed to call tool "${toolName}" on ${this.serverConfig.name}: ${error.message}`;
      log(errorMsg);
      throw new Error(errorMsg);
    }
  }

  public async disconnect(): Promise<void> {
    if (!this.client) { // If client was never initialized (e.g. bad URL from start)
        log(`[McpClient] Client for ${this.serverConfig.name} was not initialized. Nothing to disconnect.`);
        this.isConnected = false; // Ensure state is consistent
        return;
    }
      
    if (!this.isConnected) {
      log(`[McpClient] Already disconnected from ${this.serverConfig.name}.`);
      return;
    }

    try {
      log(`[McpClient] Disconnecting from ${this.serverConfig.name}...`);
      await this.client.disconnect();
      this.isConnected = false;
      log(`[McpClient] Successfully disconnected from ${this.serverConfig.name}.`);
    } catch (error: any) {
      this.isConnected = false; 
      const errorMsg = `[McpClient] Failed to disconnect from ${this.serverConfig.name}: ${error.message}`;
      log(errorMsg);
      throw new Error(errorMsg);
    }
  }

  public getIsConnected(): boolean {
    return this.isConnected;
  }

  // Optional: Method to get server name, useful for managing multiple clients
  public getServerName(): string {
    return this.serverConfig.name;
  }
}
