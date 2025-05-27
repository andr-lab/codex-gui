import { describe, it, expect, vi, beforeEach, afterEach, SpyInstance } from "vitest";
import {
  // Functions to be removed:
  // redirectToGitHubAuth,
  // handleGitHubCallback,
  // startLocalCallbackServer,
  // stopLocalCallbackServer,
  // authenticateWithGitHub, 
  // New function for Device Flow:
  authenticateWithGitHubDeviceFlow,
  // Utility functions (remain the same):
  getGitHubAccessToken,
  isGitHubAuthenticated,
  fetchGitHubRepositories,
  fetchGitHubBranches,
  // Internal functions to test if exported, or test via authenticateWithGitHubDeviceFlow
  // For this exercise, we'll assume requestDeviceCodes and pollForToken might not be exported directly
  // but their behavior is tested via the main exported function.
  // If they were exported, we'd import them here.
} from "../src/utils/github-auth"; 
import * as configUtils from "../src/utils/config"; 
// No longer need to mock 'open', 'node:http', 'node:crypto' for Device Flow core logic

// Mock config utilities
vi.mock("../src/utils/config", async () => {
  const actualConfig = await vi.importActual<typeof configUtils>("../src/utils/config");
  return {
    ...actualConfig,
    loadConfig: vi.fn(),
    saveConfig: vi.fn(),
  };
});

// Mock global fetch
global.fetch = vi.fn();

describe("GitHub Device Flow Authentication", () => {
  let mockConfig: Partial<configUtils.AppConfig>;
  let consoleLogSpy: SpyInstance;
  let consoleErrorSpy: SpyInstance;

  beforeEach(() => {
    vi.useFakeTimers(); // Use fake timers for polling tests
    vi.clearAllMocks();
    
    mockConfig = {
      githubClientId: "test_client_id_device_flow",
      githubAccessToken: undefined,
    };
    (configUtils.loadConfig as SpyInstance).mockReturnValue(mockConfig);
    (configUtils.saveConfig as SpyInstance).mockImplementation((newConfig) => {
      mockConfig = { ...mockConfig, ...newConfig };
    });

    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers(); // Restore real timers
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  describe("authenticateWithGitHubDeviceFlow", () => {
    it("should throw error if githubClientId is not configured", async () => {
      (configUtils.loadConfig as SpyInstance).mockReturnValueOnce({ ...mockConfig, githubClientId: undefined });
      await expect(authenticateWithGitHubDeviceFlow()).rejects.toThrow(
        "GitHub Client ID not configured"
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("GitHub Client ID not configured"));
    });

    it("should throw error if already authenticated", async () => {
      mockConfig.githubAccessToken = "existing_token";
      (configUtils.loadConfig as SpyInstance).mockReturnValue(mockConfig); // Ensure this is the one used by isGitHubAuthenticated
      await expect(authenticateWithGitHubDeviceFlow()).rejects.toThrow("Already authenticated.");
      expect(consoleLogSpy).toHaveBeenCalledWith("Already authenticated with GitHub. Token found in config.");
    });

    it("should successfully complete device flow and save token", async () => {
      const deviceCodeResponse = {
        device_code: "mock_device_code",
        user_code: "MOCK-CODE",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      };
      const tokenResponse = {
        access_token: "mock_access_token_device_flow",
        token_type: "bearer",
        scope: "repo,user",
      };

      (fetch as SpyInstance)
        .mockResolvedValueOnce({ // For requestDeviceCodes
          ok: true,
          json: async () => deviceCodeResponse,
        })
        .mockResolvedValueOnce({ // For pollForToken (successful)
          ok: true,
          json: async () => tokenResponse,
        });

      const resultPromise = authenticateWithGitHubDeviceFlow();
      await vi.advanceTimersByTimeAsync(deviceCodeResponse.interval * 1000); // Advance time for the first poll
      const result = await resultPromise;


      expect(fetch).toHaveBeenCalledWith("https://github.com/login/device/code", expect.objectContaining({
        method: "POST",
        body: new URLSearchParams({ client_id: "test_client_id_device_flow", scope: "repo,user" }).toString()
      }));
      expect(consoleLogSpy).toHaveBeenCalledWith(`Please go to: ${deviceCodeResponse.verification_uri}`);
      expect(consoleLogSpy).toHaveBeenCalledWith(`And enter this code: ${deviceCodeResponse.user_code}`);
      
      expect(fetch).toHaveBeenCalledWith("https://github.com/login/oauth/access_token", expect.objectContaining({
        method: "POST",
        body: new URLSearchParams({
          client_id: "test_client_id_device_flow",
          device_code: "mock_device_code",
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }).toString()
      }));
      
      expect(configUtils.saveConfig).toHaveBeenCalled();
      expect(getGitHubAccessToken()).toBe("mock_access_token_device_flow");
      expect(result).toEqual(deviceCodeResponse); // Returns initial device code data
      expect(consoleLogSpy).toHaveBeenCalledWith("GitHub authentication successful! Access token stored.");
    });

    it("should handle 'authorization_pending' and 'slow_down' during polling", async () => {
      const deviceCodeResponse = { device_code: "mock_device_code", user_code: "MOCK-CODE", verification_uri: "uri", expires_in: 900, interval: 1 }; // Fast interval for test
      const pendingResponse = { error: "authorization_pending", interval: 1 };
      const slowDownResponse = { error: "slow_down", interval: 2 }; // Server suggests new interval
      const successTokenResponse = { access_token: "final_token" };

      (fetch as SpyInstance)
        .mockResolvedValueOnce({ ok: true, json: async () => deviceCodeResponse }) // requestDeviceCodes
        .mockResolvedValueOnce({ ok: false, json: async () => pendingResponse })  // poll 1: pending
        .mockResolvedValueOnce({ ok: false, json: async () => slowDownResponse }) // poll 2: slow_down
        .mockResolvedValueOnce({ ok: true, json: async () => successTokenResponse }); // poll 3: success

      const authPromise = authenticateWithGitHubDeviceFlow();

      await vi.advanceTimersByTimeAsync(1000); // Initial interval
      expect(fetch).toHaveBeenCalledTimes(2); // device_code + 1st poll

      await vi.advanceTimersByTimeAsync(1000); // Still using interval from pending (1s)
      expect(fetch).toHaveBeenCalledTimes(3); // device_code + 1st poll + 2nd poll
      expect(consoleLogSpy).toHaveBeenCalledWith("Slowing down polling. New interval: 3s");


      await vi.advanceTimersByTimeAsync(3000); // Using new interval from slow_down (3s)
      expect(fetch).toHaveBeenCalledTimes(4); // device_code + 1st poll + 2nd poll + 3rd poll

      await expect(authPromise).resolves.toEqual(deviceCodeResponse);
      expect(getGitHubAccessToken()).toBe("final_token");
    });

    it("should timeout if user does not authorize in time", async () => {
      const deviceCodeResponse = { device_code: "mock_device_code", user_code: "MOCK-CODE", verification_uri: "uri", expires_in: 1, interval: 1 }; // Short expiry
      const pendingResponse = { error: "authorization_pending" };

      (fetch as SpyInstance)
        .mockResolvedValueOnce({ ok: true, json: async () => deviceCodeResponse }) // requestDeviceCodes
        .mockResolvedValue({ ok: false, json: async () => pendingResponse });   // All polls are pending

      const authPromise = authenticateWithGitHubDeviceFlow();
      
      // Advance time past expiry. Polling happens *after* waiting for an interval.
      await vi.advanceTimersByTimeAsync(1000); // First interval
      // Poll happens here
      await vi.advanceTimersByTimeAsync(1000); // Second interval, now past expiry
      // Poll would happen here, but timeout check should prevent it or happen before

      await expect(authPromise).rejects.toThrow("Device authentication timed out.");
    }, 10000); // Timeout aumentato

     it("should throw error if device code expires during polling", async () => {
      const deviceCodeResponse = { device_code: "mock_device_code", user_code: "MOCK-CODE", verification_uri: "uri", expires_in: 900, interval: 1 };
      const expiredResponse = { error: "expired_token" };

      (fetch as SpyInstance)
        .mockResolvedValueOnce({ ok: true, json: async () => deviceCodeResponse })
        .mockResolvedValueOnce({ ok: false, json: async () => expiredResponse });

      const authPromise = authenticateWithGitHubDeviceFlow();
      await vi.advanceTimersByTimeAsync(1000); // Advance for first poll
      
      await expect(authPromise).rejects.toThrow("Device code expired. Please try authenticating again.");
    }, 10000); // Timeout aumentato

    it("should throw error if access is denied by user", async () => {
      const deviceCodeResponse = { device_code: "mock_device_code", user_code: "MOCK-CODE", verification_uri: "uri", expires_in: 900, interval: 1 };
      const accessDeniedResponse = { error: "access_denied" };

      (fetch as SpyInstance)
        .mockResolvedValueOnce({ ok: true, json: async () => deviceCodeResponse })
        .mockResolvedValueOnce({ ok: false, json: async () => accessDeniedResponse });
        
      const authPromise = authenticateWithGitHubDeviceFlow();
      await vi.advanceTimersByTimeAsync(1000); 

      await expect(authPromise).rejects.toThrow("Access denied by user. Authentication cancelled.");
    }, 10000); // Timeout aumentato
  });

  // Tests for getGitHubAccessToken, isGitHubAuthenticated, fetchGitHubRepositories, fetchGitHubBranches
  // can remain largely the same as they depend on the token being present in config,
  // not how it was obtained.
  describe("Utility Functions (Post-Authentication)", () => {
    it("should fetch repositories successfully", async () => {
      mockConfig.githubAccessToken = "fake_token";
      const mockRepos = [{ full_name: "owner/repo1", default_branch: "main" }];
      (fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => mockRepos,
      });
      const repos = await fetchGitHubRepositories();
      expect(fetch).toHaveBeenCalledWith("https://api.github.com/user/repos?type=owner&sort=updated&per_page=100", expect.anything());
      expect(repos).toEqual(mockRepos);
    });

    it("should throw if not authenticated when fetching repositories", async () => {
      mockConfig.githubAccessToken = undefined; // Ensure no token
      (configUtils.loadConfig as SpyInstance).mockReturnValue(mockConfig);
      await expect(fetchGitHubRepositories()).rejects.toThrow("Not authenticated with GitHub");
    });

    it("should fetch branches for a repo successfully", async () => {
      mockConfig.githubAccessToken = "fake_token";
      (configUtils.loadConfig as SpyInstance).mockReturnValue(mockConfig);
      const mockBranches = [{ name: "main" }, { name: "dev" }];
      (fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => mockBranches,
      });
      const branches = await fetchGitHubBranches("owner/repo");
      expect(fetch).toHaveBeenCalledWith("https://api.github.com/repos/owner/repo/branches?per_page=100", expect.anything());
      expect(branches).toEqual(mockBranches);
    });
    
    it("should throw if repoFullName is invalid when fetching branches", async () => {
        mockConfig.githubAccessToken = "fake_token";
        (configUtils.loadConfig as SpyInstance).mockReturnValue(mockConfig);
        await expect(fetchGitHubBranches("invalidRepoName")).rejects.toThrow("Invalid repository name format.");
    });

    it("should throw if not authenticated when fetching branches", async () => {
      mockConfig.githubAccessToken = undefined; // Ensure no token
      (configUtils.loadConfig as SpyInstance).mockReturnValue(mockConfig);
      await expect(fetchGitHubBranches("owner/repo")).rejects.toThrow("Not authenticated with GitHub");
    });

    it("should reflect authentication status based on token", () => {
      mockConfig.githubAccessToken = undefined;
      expect(isGitHubAuthenticated()).toBe(false);
      expect(getGitHubAccessToken()).toBeUndefined();

      mockConfig.githubAccessToken = "a_valid_token";
      expect(isGitHubAuthenticated()).toBe(true);
      expect(getGitHubAccessToken()).toBe("a_valid_token");
    });
  });
});

// No specific crypto mocks needed for Device Flow beyond what's standard.
// No open or http server mocks needed for Device Flow.