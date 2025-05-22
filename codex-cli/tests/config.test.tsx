import type * as fsType from "fs";
import { loadConfig, saveConfig } from "../src/utils/config.js"; // parent import first
import { AutoApprovalMode } from "../src/utils/auto-approval-mode.js";
import { tmpdir } from "os";
import { join } from "path";
import { test, expect, beforeEach, afterEach, vi } from "vitest";

// In‑memory FS store
let memfs: Record<string, string> = {};

// Mock out the parts of "fs" that our config module uses:
vi.mock("fs", async () => {
  // now `real` is the actual fs module
  const real = (await vi.importActual("fs")) as typeof fsType;
  return {
    ...real,
    existsSync: (path: string) => memfs[path] !== undefined,
    readFileSync: (path: string) => {
      if (memfs[path] === undefined) {
        throw new Error("ENOENT");
      }
      return memfs[path];
    },
    writeFileSync: (path: string, data: string) => {
      memfs[path] = data;
    },
    mkdirSync: () => {
      // no‑op in in‑memory store
    },
    rmSync: (path: string) => {
      // recursively delete any key under this prefix
      const prefix = path.endsWith("/") ? path : path + "/";
      for (const key of Object.keys(memfs)) {
        if (key === path || key.startsWith(prefix)) {
          delete memfs[key];
        }
      }
    },
  };
});

let testDir: string;
let testConfigPath: string;
let testInstructionsPath: string;

beforeEach(() => {
  memfs = {}; // reset in‑memory store
  testDir = tmpdir(); // use the OS temp dir as our "cwd"
  testConfigPath = join(testDir, "config.json");
  testInstructionsPath = join(testDir, "instructions.md");
});

afterEach(() => {
  memfs = {};
});

test("loads default config if files don't exist", () => {
  const config = loadConfig(testConfigPath, testInstructionsPath, {
    disableProjectDoc: true,
    forceApiKeyForTest: "test-api-key",
  });
  expect(config).toEqual({
    model: "o4-mini",
    baseURL: "https://api.openai.com/v1",
    instructions: "",
    provider: "openai",
    apiKey: "test-api-key",
  });
});

test("saves and loads config correctly", () => {
  const testConfig = {
    model: "test-model",
    instructions: "test instructions",
    apiKey: "test-api-key",
    provider: "openai",
    baseURL: "https://api.openai.com/v1",
  };
  saveConfig(testConfig, testConfigPath, testInstructionsPath);

  // Our in‑memory fs should now contain those keys:
  expect(memfs[testConfigPath]).toContain(`"model": "test-model"`);
  expect(memfs[testInstructionsPath]).toBe("test instructions");

  const loadedConfig = loadConfig(testConfigPath, testInstructionsPath, {
    disableProjectDoc: true,
    forceApiKeyForTest: "test-api-key",
  });
  expect(loadedConfig).toEqual(testConfig);
});

test("loads user instructions + project doc when codex.md is present", () => {
  // 1) seed memfs: a config JSON, an instructions.md, and a codex.md in the cwd
  const userInstr = "here are user instructions";
  const projectDoc = "# Project Title\n\nSome project‑specific doc";
  // first, make config so loadConfig will see storedConfig
  memfs[testConfigPath] = JSON.stringify({ model: "mymodel" }, null, 2);
  // then user instructions:
  memfs[testInstructionsPath] = userInstr;
  // and now our fake codex.md in the cwd:
  const codexPath = join(testDir, "codex.md");
  memfs[codexPath] = projectDoc;

  // 2) loadConfig without disabling project‑doc, but with cwd=testDir
  const cfg = loadConfig(testConfigPath, testInstructionsPath, {
    cwd: testDir,
    forceApiKeyForTest: "test-api-key",
  });

  // 3) assert we got both pieces concatenated
  expect(cfg.model).toBe("mymodel");
  expect(cfg.instructions).toBe(
    userInstr + "\n\n--- project-doc ---\n\n" + projectDoc,
  );
});

test("loads and saves approvalMode correctly", () => {
  // Setup config with approvalMode
  memfs[testConfigPath] = JSON.stringify(
    {
      model: "mymodel",
      approvalMode: AutoApprovalMode.AUTO_EDIT,
    },
    null,
    2,
  );
  memfs[testInstructionsPath] = "test instructions";

  // Load config and verify approvalMode
  const loadedConfig = loadConfig(testConfigPath, testInstructionsPath, {
    disableProjectDoc: true,
    forceApiKeyForTest: "test-api-key",
  });

  // Check approvalMode was loaded correctly
  expect(loadedConfig.approvalMode).toBe(AutoApprovalMode.AUTO_EDIT);

  // Modify approvalMode and save
  const updatedConfig = {
    ...loadedConfig,
    approvalMode: AutoApprovalMode.FULL_AUTO,
  };

  saveConfig(updatedConfig, testConfigPath, testInstructionsPath);

  // Verify saved config contains updated approvalMode
  expect(memfs[testConfigPath]).toContain(
    `"approvalMode": "${AutoApprovalMode.FULL_AUTO}"`,
  );

  // Load again and verify updated value
  const reloadedConfig = loadConfig(testConfigPath, testInstructionsPath, {
    disableProjectDoc: true,
    forceApiKeyForTest: "test-api-key",
  });
  expect(reloadedConfig.approvalMode).toBe(AutoApprovalMode.FULL_AUTO);
});

describe("MCP Server Configuration", () => {
  test("loads config with mcpServers undefined", () => {
    memfs[testConfigPath] = JSON.stringify({ model: "test-model" }); // mcpServers is undefined
    const config = loadConfig(testConfigPath, testInstructionsPath, {
      disableProjectDoc: true,
      forceApiKeyForTest: "test-api-key",
    });
    expect(config.mcpServers).toBeUndefined();
  });

  test("loads config with mcpServers as empty array", () => {
    memfs[testConfigPath] = JSON.stringify({ model: "test-model", mcpServers: [] });
    const config = loadConfig(testConfigPath, testInstructionsPath, {
      disableProjectDoc: true,
      forceApiKeyForTest: "test-api-key",
    });
    expect(config.mcpServers).toEqual([]);
  });

  test("loads config with one MCP server entry", () => {
    const mcpConfig = {
      model: "test-model",
      mcpServers: [
        {
          name: "TestServer1",
          url: "http://localhost:8080",
          enabled: true,
          auth: { type: "apiKey", key: "test-key" },
        },
      ],
    };
    memfs[testConfigPath] = JSON.stringify(mcpConfig);
    const config = loadConfig(testConfigPath, testInstructionsPath, {
      disableProjectDoc: true,
      forceApiKeyForTest: "test-api-key",
    });
    expect(config.mcpServers).toEqual(mcpConfig.mcpServers);
  });

  test("loads config with multiple MCP server entries", () => {
    const mcpConfig = {
      model: "test-model",
      mcpServers: [
        { name: "ServerA", url: "http://server-a.com" },
        {
          name: "ServerB",
          url: "https://server-b.io",
          enabled: true,
          auth: { type: "oauth", clientId: "client1", clientSecret: "secret1" },
        },
      ],
    };
    memfs[testConfigPath] = JSON.stringify(mcpConfig);
    const config = loadConfig(testConfigPath, testInstructionsPath, {
      disableProjectDoc: true,
      forceApiKeyForTest: "test-api-key",
    });
    // Expect mcpServers to be an array, and then check specific properties if default 'enabled' is applied
    expect(config.mcpServers).toBeDefined();
    expect(config.mcpServers?.length).toBe(2);
    expect(config.mcpServers?.[0]).toEqual({ name: "ServerA", url: "http://server-a.com" }); // enabled defaults during client init, not loadConfig
    expect(config.mcpServers?.[1]).toEqual(mcpConfig.mcpServers[1]);
  });

  test("loads MCP server with enabled: false", () => {
    const mcpConfig = {
      mcpServers: [{ name: "DisabledServer", url: "http://disabled.io", enabled: false }],
    };
    memfs[testConfigPath] = JSON.stringify(mcpConfig);
    const config = loadConfig(testConfigPath, testInstructionsPath, {
      disableProjectDoc: true,
      forceApiKeyForTest: "test-api-key",
    });
    expect(config.mcpServers?.[0]?.enabled).toBe(false);
  });

  test("loads MCP server with enabled omitted (defaults to true client-side, undefined here)", () => {
    const mcpConfig = {
      mcpServers: [{ name: "DefaultEnabledServer", url: "http://default.io" }], // enabled is omitted
    };
    memfs[testConfigPath] = JSON.stringify(mcpConfig);
    const config = loadConfig(testConfigPath, testInstructionsPath, {
      disableProjectDoc: true,
      forceApiKeyForTest: "test-api-key",
    });
    // loadConfig itself doesn't set default for 'enabled'. It's loaded as is (undefined).
    // The McpClient or AgentLoop would handle the default if 'enabled' is undefined.
    expect(config.mcpServers?.[0]?.name).toBe("DefaultEnabledServer");
    expect(config.mcpServers?.[0]?.url).toBe("http://default.io");
    expect(config.mcpServers?.[0]?.enabled).toBeUndefined(); 
  });
  
  test("loads MCP server with auth object (apiKey)", () => {
    const authConfig = { type: "apiKey" as const, key: "secret-api-key" };
    const mcpConfig = {
      mcpServers: [{ name: "AuthServerApiKey", url: "http://auth.key", auth: authConfig }],
    };
    memfs[testConfigPath] = JSON.stringify(mcpConfig);
    const config = loadConfig(testConfigPath, testInstructionsPath, {
      disableProjectDoc: true,
      forceApiKeyForTest: "test-api-key",
    });
    expect(config.mcpServers?.[0]?.auth).toEqual(authConfig);
  });

  test("loads MCP server with auth object (oauth)", () => {
    const authConfig = { type: "oauth" as const, clientId: "myClient", clientSecret: "mySecret" };
    const mcpConfig = {
      mcpServers: [{ name: "AuthServerOAuth", url: "http://auth.oauth", auth: authConfig }],
    };
    memfs[testConfigPath] = JSON.stringify(mcpConfig);
    const config = loadConfig(testConfigPath, testInstructionsPath, {
      disableProjectDoc: true,
      forceApiKeyForTest: "test-api-key",
    });
    expect(config.mcpServers?.[0]?.auth).toEqual(authConfig);
  });
});
