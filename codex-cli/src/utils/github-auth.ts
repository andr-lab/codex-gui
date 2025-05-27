import { loadConfig, saveConfig } from "./config.js";
// Removed: open, crypto, http as they were for redirect flow or PKCE
// Retain crypto if needed for other things, but not for PKCE verifier/challenge here.

const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_OAUTH_TOKEN_URL = "https://github.com/login/oauth/access_token";

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number; // seconds
  interval: number; // seconds
}

interface DeviceTokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
  error_uri?: string;
  interval?: number; // Can be returned by 'slow_down' error
}

// Main function to orchestrate Device Flow
export async function authenticateWithGitHubDeviceFlow(): Promise<{
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
  device_code: string; // Return device_code for polling
  // The actual polling and token saving will be handled by this function,
  // but UI might want to know these details.
  // This function will resolve when token is obtained or error occurs.
}> {
  const config = loadConfig();
  if (!config.githubClientId) {
    const errorMsg = "GitHub Client ID not configured. Please set `githubClientId` in your config file.";
    console.error(errorMsg);
    throw new Error(errorMsg);
  }

  if (isGitHubAuthenticated()) {
    console.log("Already authenticated with GitHub. Token found in config.");
    // Optionally, add logic to re-authenticate or check token validity if needed.
    // For now, just indicate that it's already authenticated.
    // This function's purpose is to *initiate* auth if not present.
    // Perhaps throw an error or return a specific status.
    // For this refactor, let's assume it means "already done".
    throw new Error("Already authenticated."); 
  }

  console.log("Starting GitHub Device Flow authentication...");

  const deviceCodeData = await requestDeviceCodes(config.githubClientId);
  console.log(`Please go to: ${deviceCodeData.verification_uri}`);
  console.log(`And enter this code: ${deviceCodeData.user_code}`);

  // Start polling for the token
  try {
    const accessToken = await pollForToken(
      deviceCodeData.device_code,
      deviceCodeData.interval,
      config.githubClientId,
      deviceCodeData.expires_in
    );
    
    const newConfig = loadConfig(); // Load fresh config before saving
    newConfig.githubAccessToken = accessToken;
    saveConfig(newConfig);
    console.log("GitHub authentication successful! Access token stored.");

    return { ...deviceCodeData }; // Return all device code data for consistency, though token is now saved.
  } catch (error) {
    console.error("GitHub Device Flow authentication failed:", error);
    throw error; // Re-throw to be handled by the caller UI
  }
}


async function requestDeviceCodes(clientId: string): Promise<DeviceCodeResponse> {
  const response = await fetch(GITHUB_DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      client_id: clientId,
      scope: "repo,user", // Define necessary scopes
    }).toString(),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ message: "Unknown error" }));
    console.error("Error requesting device and user codes:", errorData);
    throw new Error(
      `Failed to request device codes: ${response.status} ${response.statusText} - ${errorData.message || JSON.stringify(errorData)}`,
    );
  }
  return response.json() as Promise<DeviceCodeResponse>;
}

async function pollForToken(
  deviceCode: string,
  initialIntervalSeconds: number,
  clientId: string,
  expiresInSeconds: number
): Promise<string> {
  let interval = initialIntervalSeconds * 1000; // Convert to ms
  const startTime = Date.now();
  const timeoutMs = expiresInSeconds * 1000;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (Date.now() - startTime > timeoutMs) {
      throw new Error("Device authentication timed out.");
    }

    await new Promise(resolve => setTimeout(resolve, interval));

    try {
      const response = await fetch(GITHUB_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          client_id: clientId,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }).toString(),
      });

      const tokenResponse = (await response.json()) as DeviceTokenResponse;

      if (response.ok && tokenResponse.access_token) {
        return tokenResponse.access_token;
      } else if (tokenResponse.error) {
        switch (tokenResponse.error) {
          case "authorization_pending":
            // Continue polling, interval unchanged unless server says otherwise
            if (tokenResponse.interval) { // GitHub might suggest a new interval
                interval = tokenResponse.interval * 1000;
            }
            break;
          case "slow_down":
            interval += (tokenResponse.interval || 5) * 1000; // Increase interval
            console.log(`Slowing down polling. New interval: ${interval / 1000}s`);
            break;
          case "expired_token":
            throw new Error("Device code expired. Please try authenticating again.");
          case "access_denied":
            throw new Error("Access denied by user. Authentication cancelled.");
          // Handle other specific errors as needed
          default:
            throw new Error(
              `GitHub token polling error: ${tokenResponse.error} - ${tokenResponse.error_description || "No description."}`,
            );
        }
      } else {
        // Should not happen if response.ok is false and no error field, but handle defensively
        throw new Error("Unknown error during token polling.");
      }
    } catch (error) {
        // If the error is one of the specific terminal OAuth errors, re-throw it to stop polling.
        if (error instanceof Error &&
            (error.message === "Device code expired. Please try authenticating again." ||
             error.message === "Access denied by user. Authentication cancelled." ||
             error.message.startsWith("GitHub token polling error:") ||
             error.message === "Unknown error during token polling.")) {
          throw error; // This will break the loop and reject the pollForToken promise.
        }

        // For other errors (e.g., actual network issues, or "Unknown error during token polling"),
        // log a warning and retry after a delay.
        console.warn("An error occurred during token polling, will retry...", error);
        // Add a small delay before retrying on network error to avoid tight loops
        await new Promise(resolve => setTimeout(resolve, interval + 2000)); 
    }
  }
}


// --- Functions below this line are mostly unchanged as they depend on the token, not how it's obtained ---

export function getGitHubAccessToken(): string | undefined {
  const config = loadConfig();
  return config.githubAccessToken;
}

export function isGitHubAuthenticated(): boolean {
  return !!getGitHubAccessToken();
}

const GITHUB_API_BASE_URL = "https://api.github.com";

interface GitHubRepo {
  full_name: string; // "owner/repo"
  name: string;
  owner: { login: string };
  updated_at: string;
  default_branch: string;
}

interface GitHubBranch {
  name: string;
}

async function fetchGitHubApi<T>(
  endpoint: string,
  token: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${GITHUB_API_BASE_URL}${endpoint}`, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
    },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(
      `GitHub API request failed: ${response.status} ${response.statusText}`,
      errorBody,
    );
    throw new Error(
      `GitHub API request to ${endpoint} failed: ${response.status} ${response.statusText}`,
    );
  }
  return response.json() as Promise<T>;
}

export async function fetchGitHubRepositories(): Promise<GitHubRepo[]> {
  const token = getGitHubAccessToken();
  if (!token) {
    throw new Error(
      "Not authenticated with GitHub. Please run 'codex auth github'.",
    );
  }

  try {
    // Fetch repositories owned by the authenticated user, sorted by updated date, 100 per page
    // We could also add affiliation=owner,collaborator to get more repos
    const repos = await fetchGitHubApi<GitHubRepo[]>(
      "/user/repos?type=owner&sort=updated&per_page=100",
      token,
    );
    return repos;
  } catch (error) {
    console.error("Failed to fetch GitHub repositories:", error);
    throw error; // Re-throw to be handled by the caller
  }
}

export async function fetchGitHubBranches(
  repoFullName: string, // Format: "owner/repo"
): Promise<GitHubBranch[]> {
  const token = getGitHubAccessToken();
  if (!token) {
    throw new Error(
      "Not authenticated with GitHub. Please run 'codex auth github'.",
    );
  }
  if (!repoFullName || !repoFullName.includes("/")) {
    throw new Error(
      "Invalid repository name format. Expected 'owner/repo'.",
    );
  }

  try {
    const branches = await fetchGitHubApi<GitHubBranch[]>(
      `/repos/${repoFullName}/branches?per_page=100`, // Get up to 100 branches
      token,
    );
    return branches;
  } catch (error) {
    console.error(`Failed to fetch branches for repository ${repoFullName}:`, error);
    throw error; // Re-throw to be handled by the caller
  }
}