import type { TeamGateway } from "../config.js";

export interface SessionRequest {
  agent: string;
  workspace: string;
  prompt: string;
  branch?: string;
}

export interface SessionResponse {
  sessionId: string;
  status: string;
}

export async function createSession(
  gateway: TeamGateway,
  request: SessionRequest,
): Promise<SessionResponse> {
  const url = `http://${gateway.vmHost}:${gateway.gatewayPort}/api/sessions`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${gateway.gatewayToken}`,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Gateway session creation failed (${response.status}): ${body}`,
    );
  }

  return (await response.json()) as SessionResponse;
}

export async function getSessionStatus(
  gateway: TeamGateway,
  sessionId: string,
): Promise<{ status: string; result?: string }> {
  const url = `http://${gateway.vmHost}:${gateway.gatewayPort}/api/sessions/${sessionId}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${gateway.gatewayToken}`,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Gateway session status failed (${response.status}): ${body}`,
    );
  }

  return (await response.json()) as { status: string; result?: string };
}
