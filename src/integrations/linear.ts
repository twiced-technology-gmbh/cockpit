import { LinearClient } from "@linear/sdk";
import { config } from "../config.js";

let _client: LinearClient | undefined;

function getClient(): LinearClient {
  if (!_client) {
    _client = new LinearClient({ apiKey: config.linearApiKey });
  }
  return _client;
}

export async function postComment(
  issueId: string,
  body: string,
): Promise<void> {
  const client = getClient();
  await client.createComment({ issueId, body });
}

export async function updateIssueState(
  issueId: string,
  stateId: string,
): Promise<void> {
  const client = getClient();
  await client.updateIssue(issueId, { stateId });
}
