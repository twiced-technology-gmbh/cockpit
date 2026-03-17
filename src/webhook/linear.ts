import { Hono } from "hono";
import { nanoid } from "nanoid";
import { createHmac, timingSafeEqual } from "node:crypto";
import { getDb } from "../db.js";
import { config } from "../config.js";
import { advanceRun } from "../pipeline/runner.js";

export const linearWebhook = new Hono();

interface LinearWebhookPayload {
  action: string;
  type: string;
  data: {
    id: string;
    identifier: string;
    title: string;
    teamId: string;
    projectId?: string;
    project?: { id: string; name: string };
  };
  url?: string;
}

function verifySignature(body: string, signature: string | undefined): boolean {
  if (!config.linearWebhookSecret) return true;
  if (!signature) return false;
  const hmac = createHmac("sha256", config.linearWebhookSecret);
  hmac.update(body);
  const expected = hmac.digest("hex");
  if (signature.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
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

  if (payload.type !== "Issue") {
    return c.json({ ok: true, skipped: true });
  }

  if (payload.action !== "create" && payload.action !== "update") {
    return c.json({ ok: true, skipped: true });
  }

  const db = getDb();
  const projectName = payload.data.project?.name;
  if (!projectName) {
    return c.json({ ok: true, skipped: true, reason: "no project" });
  }

  const teamConfig = db
    .prepare("SELECT * FROM team_config WHERE project = ?")
    .get(projectName);
  if (!teamConfig) {
    return c.json({ ok: true, skipped: true, reason: "unknown project" });
  }

  const existingRun = db
    .prepare(
      "SELECT id FROM pipeline_runs WHERE issue_id = ? AND state NOT IN ('DONE', 'FAILED')",
    )
    .get(payload.data.identifier) as { id: string } | undefined;

  if (existingRun) {
    return c.json({
      ok: true,
      skipped: true,
      reason: "active run exists",
      runId: existingRun.id,
    });
  }

  const runId = nanoid();
  db.prepare(
    `INSERT INTO pipeline_runs (id, issue_id, issue_uuid, project, state)
     VALUES (?, ?, ?, ?, 'RECEIVED')`,
  ).run(runId, payload.data.identifier, payload.data.id, projectName);

  console.log(
    `[webhook] Created pipeline run ${runId} for issue ${payload.data.identifier}`,
  );

  advanceRun(db, runId);

  return c.json({ ok: true, runId });
});
