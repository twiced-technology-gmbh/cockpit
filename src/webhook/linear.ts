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
    labels?: Array<{ id: string; name: string }>;
    labelIds?: string[];
  };
}

interface LinearAgentSessionPayload {
  action: string;
  type: "AgentSession" | "AgentSessionEvent";
  agentSession: {
    id: string;
    issueId: string;
    status: string;
    issue?: {
      id: string;
      identifier: string;
      title: string;
      teamId: string;
      team?: { id: string; key: string; name: string };
      project?: { id: string; name: string };
      labels?: Array<{ id: string; name: string }>;
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
  projectOrTeamId: string,
  lookupBy: "project" | "team_id" = "project",
  labels: string[] = [],
): { runId: string; created: boolean } {
  const db = getDb();

  let teamConfig: Record<string, unknown> | undefined;
  if (lookupBy === "team_id") {
    teamConfig = db
      .prepare("SELECT * FROM team_config WHERE linear_team_id = ?")
      .get(projectOrTeamId) as Record<string, unknown> | undefined;
  } else {
    teamConfig = db
      .prepare("SELECT * FROM team_config WHERE project = ?")
      .get(projectOrTeamId) as Record<string, unknown> | undefined;
  }
  if (!teamConfig) {
    return { runId: "", created: false };
  }

  const projectName = teamConfig.project as string;

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
    `INSERT INTO pipeline_runs (id, issue_id, issue_uuid, project, state, labels)
     VALUES (?, ?, ?, ?, 'RECEIVED', ?)`,
  ).run(runId, issueIdentifier, issueUuid, projectName, JSON.stringify(labels));

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

  const raw = payload as unknown as Record<string, unknown>;
  const debugData = raw.data || raw.agentSession || "no data";
  console.log(`[webhook] Received ${payload.type}/${payload.action}:`, JSON.stringify(debugData).slice(0, 500));

  // Agent delegation — this is the primary trigger
  if (payload.type === "AgentSession" || payload.type === "AgentSessionEvent") {
    const session = payload as LinearAgentSessionPayload;
    const issue = session.agentSession?.issue;

    if (!issue) {
      console.log(`[webhook] AgentSession without issue data, skipping`);
      return c.json({ ok: true, skipped: true, reason: "no issue in session" });
    }

    const teamId = issue.teamId || issue.team?.id;
    if (!teamId) {
      return c.json({ ok: true, skipped: true, reason: "no team" });
    }

    const labelNames = (issue.labels || []).map((l) => l.name);
    console.log(`[webhook] AgentSession for ${issue.identifier} (team: ${issue.team?.name || teamId})`);

    const { runId, created } = createPipelineRun(
      issue.identifier,
      issue.id,
      teamId,
      "team_id",
      labelNames,
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

    const teamId = issue.data.teamId;
    if (!teamId) {
      return c.json({ ok: true, skipped: true, reason: "no team" });
    }

    const labelNames = (issue.data.labels || []).map((l) => l.name);
    const { runId, created } = createPipelineRun(
      issue.data.identifier,
      issue.data.id,
      teamId,
      "team_id",
      labelNames,
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
