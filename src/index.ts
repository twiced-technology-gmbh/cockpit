import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { nanoid } from "nanoid";
import { config, getTeamConfig } from "./config.js";
import { getDb, closeDb } from "./db.js";
import { linearWebhook } from "./webhook/linear.js";
import { completeAgentTask, advanceRun } from "./pipeline/runner.js";
import { mergePullRequest, parsePrNumber } from "./integrations/github.js";
import { detectStuckRuns, handleStuckRun } from "./pipeline/stuck-detector.js";
import { cleanupCompletedRuns, getCleanupStats } from "./pipeline/cleanup.js";

const app = new Hono();

app.get("/api/health", (c) => {
  try {
    const db = getDb();
    db.prepare("SELECT 1").get();
    return c.json({ status: "ok" });
  } catch (err) {
    return c.json({ status: "error", error: String(err) }, 500);
  }
});

app.route("/webhook/linear", linearWebhook);

app.get("/api/runs", (c) => {
  const db = getDb();
  const runs = db
    .prepare(
      "SELECT * FROM pipeline_runs ORDER BY created_at DESC LIMIT 50",
    )
    .all();
  return c.json(runs);
});

app.get("/api/runs/:id", (c) => {
  const db = getDb();
  const run = db
    .prepare("SELECT * FROM pipeline_runs WHERE id = ?")
    .get(c.req.param("id"));
  if (!run) return c.json({ error: "Not found" }, 404);

  const tasks = db
    .prepare("SELECT * FROM agent_tasks WHERE run_id = ? ORDER BY started_at")
    .all(c.req.param("id"));

  return c.json({ ...run, tasks });
});

app.post("/api/runs/:id/agent-complete", async (c) => {
  const body = await c.req.json<{
    taskId: string;
    result: "success" | "failure";
    output?: string;
  }>();

  const db = getDb();
  completeAgentTask(db, body.taskId, body.result, body.output);
  return c.json({ ok: true });
});

app.post("/api/runs/:id/review-complete", async (c) => {
  const runId = c.req.param("id");
  const body = await c.req.json<{
    taskId: string;
    findings: Array<{
      severity: string;
      filePath?: string;
      lineNumber?: number;
      description: string;
    }>;
  }>();

  const db = getDb();

  const task = db
    .prepare("SELECT id, run_id, stage FROM agent_tasks WHERE id = ? AND run_id = ?")
    .get(body.taskId, runId) as { id: string; run_id: string; stage: string } | undefined;

  if (!task || task.stage !== "review") {
    return c.json({ error: "Review task not found" }, 404);
  }

  for (const finding of body.findings) {
    db.prepare(
      `INSERT INTO review_findings (id, agent_task_id, run_id, severity, file_path, line_number, description)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      nanoid(),
      body.taskId,
      runId,
      finding.severity,
      finding.filePath ?? null,
      finding.lineNumber ?? null,
      finding.description,
    );
  }

  completeAgentTask(db, body.taskId, "success");
  return c.json({ ok: true });
});

app.post("/api/runs/:id/approve-merge", async (c) => {
  const runId = c.req.param("id");
  const db = getDb();

  const run = db
    .prepare("SELECT * FROM pipeline_runs WHERE id = ?")
    .get(runId) as Record<string, unknown> | undefined;

  if (!run) return c.json({ error: "Run not found" }, 404);
  if (run.state !== "AWAITING_MERGE") {
    return c.json({ error: `Run is in state ${run.state}, not AWAITING_MERGE` }, 400);
  }

  const teamConfig = getTeamConfig(db, run.project as string);
  if (!teamConfig) return c.json({ error: "No team config" }, 500);

  const prUrl = run.pr_url as string | null;
  if (!prUrl) return c.json({ error: "No PR URL" }, 400);

  let prNumber: number;
  try {
    prNumber = parsePrNumber(prUrl);
  } catch {
    return c.json({ error: "Cannot parse PR number" }, 400);
  }

  await mergePullRequest(teamConfig.repoUrl, prNumber);

  db.prepare(
    "UPDATE pipeline_runs SET state = 'MERGED', updated_at = datetime('now') WHERE id = ? AND state = 'AWAITING_MERGE'",
  ).run(runId);

  advanceRun(db, runId);

  return c.json({ ok: true, merged: true });
});

app.get("/api/stats", (c) => {
  const db = getDb();
  const stats = getCleanupStats(db);

  const recentCompleted = db
    .prepare(
      `SELECT id, issue_id, project, state, updated_at FROM pipeline_runs
       WHERE state IN ('DONE', 'FAILED')
       ORDER BY updated_at DESC LIMIT 10`,
    )
    .all();

  return c.json({ ...stats, recentCompleted });
});

app.get("/api/stuck", (c) => {
  const db = getDb();
  const stuck = detectStuckRuns(db);
  return c.json({ stuck, count: stuck.length });
});

app.post("/api/runs/:id/retry", async (c) => {
  const runId = c.req.param("id");
  const db = getDb();

  const run = db
    .prepare("SELECT * FROM pipeline_runs WHERE id = ?")
    .get(runId) as Record<string, unknown> | undefined;

  if (!run) return c.json({ error: "Run not found" }, 404);
  if (run.state !== "FAILED") {
    return c.json({ error: `Run is in state ${run.state}, not FAILED` }, 400);
  }

  db.prepare(
    "UPDATE pipeline_runs SET state = 'RECEIVED', updated_at = datetime('now') WHERE id = ?",
  ).run(runId);

  console.log(`[pipeline] Retrying run ${runId}`);
  advanceRun(db, runId);

  return c.json({ ok: true, retried: true });
});

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[pipeline-controller] Listening on port ${info.port}`);
});

const PERIODIC_INTERVAL_MS = 5 * 60 * 1000;

const periodicTimer = setInterval(async () => {
  try {
    const db = getDb();

    const stuckRuns = detectStuckRuns(db);
    if (stuckRuns.length > 0) {
      console.log(`[periodic] Found ${stuckRuns.length} stuck run(s)`);
      for (const stuck of stuckRuns) {
        await handleStuckRun(db, stuck.runId, stuck.reason);
      }
    }

    const cleaned = await cleanupCompletedRuns(db, 7);
    if (cleaned > 0) {
      console.log(`[periodic] Cleaned up ${cleaned} old worktree(s)`);
    }
  } catch (err) {
    console.error(`[periodic] Error in periodic check:`, err);
  }
}, PERIODIC_INTERVAL_MS);

function shutdown() {
  console.log("[pipeline-controller] Shutting down...");
  clearInterval(periodicTimer);
  closeDb();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
