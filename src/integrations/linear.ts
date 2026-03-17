import { LinearClient } from "@linear/sdk";
import { config } from "../config.js";

let _oauthToken = config.linearOauthToken;
let _refreshToken = config.linearRefreshToken;
let _tokenExpiresAt = Date.now() + 80_000_000; // ~22 hours from startup (conservative)
let _client: LinearClient | undefined;

function getClient(): LinearClient {
  if (!_client || !_oauthToken) {
    const token = _oauthToken || config.linearApiKey;
    _client = new LinearClient({ accessToken: token });
  }
  return _client;
}

async function refreshTokenIfNeeded(): Promise<void> {
  if (!_refreshToken || !config.linearClientId || !config.linearClientSecret) {
    return; // No refresh token or client credentials — use personal API key fallback
  }

  if (Date.now() < _tokenExpiresAt - 300_000) {
    return; // Token still valid (5 min buffer)
  }

  console.log("[linear] Refreshing OAuth token...");
  const response = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: config.linearClientId,
      client_secret: config.linearClientSecret,
      refresh_token: _refreshToken,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    console.error(`[linear] Token refresh failed (${response.status}): ${body}`);
    return;
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  _oauthToken = data.access_token;
  if (data.refresh_token) {
    _refreshToken = data.refresh_token;
  }
  _tokenExpiresAt = Date.now() + data.expires_in * 1000;
  _client = new LinearClient({ accessToken: _oauthToken });

  console.log(
    `[linear] Token refreshed, expires in ${Math.round(data.expires_in / 3600)}h`,
  );
}

export async function postComment(
  issueId: string,
  body: string,
): Promise<void> {
  await refreshTokenIfNeeded();
  const client = getClient();
  await client.createComment({ issueId, body });
}

export async function updateIssueState(
  issueId: string,
  stateId: string,
): Promise<void> {
  await refreshTokenIfNeeded();
  const client = getClient();
  await client.updateIssue(issueId, { stateId });
}
