import { Hono } from "hono";
import { nanoid } from "nanoid";
import { createHmac, timingSafeEqual } from "node:crypto";
import { getDb } from "../db.js";
import { config } from "../config.js";
import { advanceRun } from "../pipeline/runner.js";

export const linearWebhook = new Hono();

interface LinearIssuePayload {
  action: string;
  type: "Issue";
  data: {
    id: string;
    identifier: string;
    title: string;
    teamId: string;
    projectId?: string;
    project?: { id: string; name: string };
  };
}

interface LinearAgentSessionPayload {
  action: string;
  type: "AgentSession" | "AgentSessionEvent";
  data: {
    id: string;
    issueId: string;
    issue?: {
      id: string;
      identifier: string;
      title: string;
      teamId: string;
      project?: { id: string; name: string };
    };
  };
}

type LinearWebhookPayload = LinearIssuePayload | LinearAgentSessionPayload;

function verifySignature(body: string, signature: string | undefined): boolean {
  if (!config.linearWebhookSecret) return true;
  if (!signature) return false;
  const hmac = createHmac("sha256", config.linearWebhookSecret);
  hmac.update(body);
  const expected = hmac.digest("hex");
  if (signature.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function createPipelineRun(
  issueIdentifier: string,
  issueUuid: string,
  projectName: string,
): { runId: string; created: boolean } {
  const db = getDb();

  const teamConfig = db
    .prepare("SELECT * FROM team_config WHERE project = ?")
    .get(projectName);
  if (!teamConfig) {
    return { runId: "", created: false };
  }

  const existingRun = db
    .prepare(
      "SELECT id FROM pipeline_runs WHERE issue_id = ? AND state NOT IN ('DONE', 'FAILED')",
    )
    .get(issueIdentifier) as { id: string } | undefined;

  if (existingRun) {
    return { runId: existingRun.id, created: false };
  }

  const runId = nanoid();
  db.prepare(
    `INSERT INTO pipeline_runs (id, issue_id, issue_uuid, project, state)
     VALUES (?, ?, ?, ?, 'RECEIVED')`,
  ).run(runId, issueIdentifier, issueUuid, projectName);

  console.log(
    `[webhook] Created pipeline run ${runId} for issue ${issueIdentifier} (project: ${projectName})`,
  );

  advanceRun(db, runId);

  return { runId, created: true };
}

linearWebhook.post("/", async (c) => {
  const rawBody = await c.req.text();

  const signature = c.req.header("linear-signature");
  if (!verifySignature(rawBody, signature)) {
    return c.json({ error: "Invalid signature" }, 401);
  }

  let payload: LinearWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  console.log(`[webhook] Received ${payload.type}/${payload.action}`, JSON.stringify(payload.data, null, 2).slice(0, 500));

  // Agent delegation — this is the primary trigger
  if (payload.type === "AgentSession" || payload.type === "AgentSessionEvent") {
    const session = payload as LinearAgentSessionPayload;
    const issue = session.data.issue;

    if (!issue) {
      console.log(`[webhook] AgentSession without issue data, skipping`);
      return c.json({ ok: true, skipped: true, reason: "no issue in session" });
    }

    const projectName = issue.project?.name;
    if (!projectName) {
      return c.json({ ok: true, skipped: true, reason: "no project" });
    }

    const { runId, created } = createPipelineRun(
      issue.identifier,
      issue.id,
      projectName,
    );

    if (!runId) {
      return c.json({ ok: true, skipped: true, reason: "unknown project" });
    }

    return c.json({ ok: true, runId, created });
  }

  // Issue events — fallback trigger (e.g., issue assigned to pipeline label)
  if (payload.type === "Issue") {
    const issue = payload as LinearIssuePayload;

    if (issue.action !== "create" && issue.action !== "update") {
      return c.json({ ok: true, skipped: true });
    }

    const projectName = issue.data.project?.name;
    if (!projectName) {
      return c.json({ ok: true, skipped: true, reason: "no project" });
    }

    const { runId, created } = createPipelineRun(
      issue.data.identifier,
      issue.data.id,
      projectName,
    );

    if (!runId) {
      return c.json({ ok: true, skipped: true, reason: "unknown project" });
    }

    if (!created) {
      return c.json({
        ok: true,
        skipped: true,
        reason: "active run exists",
        runId,
      });
    }

    return c.json({ ok: true, runId });
  }

  return c.json({ ok: true, skipped: true, reason: `unhandled type: ${(payload as { type: string }).type}` });
});
