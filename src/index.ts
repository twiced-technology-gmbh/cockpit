import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { nanoid } from "nanoid";
import { config, getTeamConfig, getTeamGateway, getProjectRepos } from "./config.js";
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

// --- Project CRUD ---

app.get("/api/projects", (c) => {
  const db = getDb();
  const projects = db.prepare("SELECT * FROM team_config ORDER BY project").all() as Record<string, unknown>[];
  return c.json(
    projects.map((row) => ({
      project: row.project,
      linearTeamId: row.linear_team_id,
      repoUrl: row.repo_url,
      defaultBranch: row.default_branch,
      reviewConfig: JSON.parse(
        (row.review_config as string) || '{"focuses":["security","quality","fulfillment"]}',
      ),
      repos: getProjectRepos(db, row.project as string),
    })),
  );
});

app.get("/api/projects/:project", (c) => {
  const db = getDb();
  const teamConfig = getTeamConfig(db, c.req.param("project"));
  if (!teamConfig) return c.json({ error: "Not found" }, 404);
  return c.json(teamConfig);
});

app.post("/api/projects", async (c) => {
  const body = await c.req.json<{
    project: string;
    linearTeamId: string;
    repoUrl?: string;
    defaultBranch?: string;
    reviewConfig?: { focuses: string[]; models?: string[]; agents?: Record<string, string> };
  }>();

  const db = getDb();
  const existing = db.prepare("SELECT project FROM team_config WHERE project = ?").get(body.project);
  if (existing) return c.json({ error: "Project already exists" }, 409);

  db.prepare(
    `INSERT INTO team_config (project, linear_team_id, repo_url, default_branch, review_config)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    body.project,
    body.linearTeamId,
    body.repoUrl ?? "",
    body.defaultBranch ?? "main",
    JSON.stringify(body.reviewConfig ?? { focuses: ["security", "quality", "fulfillment"] }),
  );

  return c.json(getTeamConfig(db, body.project), 201);
});

app.put("/api/projects/:project", async (c) => {
  const project = c.req.param("project");
  const body = await c.req.json<{
    linearTeamId?: string;
    repoUrl?: string;
    defaultBranch?: string;
    reviewConfig?: { focuses: string[]; models?: string[]; agents?: Record<string, string> };
  }>();

  const db = getDb();
  const existing = db.prepare("SELECT project FROM team_config WHERE project = ?").get(project);
  if (!existing) return c.json({ error: "Not found" }, 404);

  const setClauses: string[] = [];
  const params: unknown[] = [];

  if (body.linearTeamId !== undefined) {
    setClauses.push("linear_team_id = ?");
    params.push(body.linearTeamId);
  }
  if (body.repoUrl !== undefined) {
    setClauses.push("repo_url = ?");
    params.push(body.repoUrl);
  }
  if (body.defaultBranch !== undefined) {
    setClauses.push("default_branch = ?");
    params.push(body.defaultBranch);
  }
  if (body.reviewConfig !== undefined) {
    setClauses.push("review_config = ?");
    params.push(JSON.stringify(body.reviewConfig));
  }

  if (setClauses.length > 0) {
    params.push(project);
    db.prepare(`UPDATE team_config SET ${setClauses.join(", ")} WHERE project = ?`).run(...params);
  }

  return c.json(getTeamConfig(db, project));
});

app.delete("/api/projects/:project", (c) => {
  const project = c.req.param("project");
  const db = getDb();
  const result = db.prepare("DELETE FROM team_config WHERE project = ?").run(project);
  if (result.changes === 0) return c.json({ error: "Not found" }, 404);
  db.prepare("DELETE FROM project_repos WHERE project = ?").run(project);
  return c.json({ ok: true });
});

app.post("/api/projects/:project/repos", async (c) => {
  const project = c.req.param("project");
  const body = await c.req.json<{
    path: string;
    repoUrl: string;
    isPrimary?: boolean;
    defaultBranch?: string;
  }>();

  const db = getDb();
  const existing = db.prepare("SELECT project FROM team_config WHERE project = ?").get(project);
  if (!existing) return c.json({ error: "Project not found" }, 404);

  db.prepare(
    `INSERT OR REPLACE INTO project_repos (project, path, repo_url, is_primary, default_branch)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(project, body.path, body.repoUrl, body.isPrimary ? 1 : 0, body.defaultBranch ?? "main");

  return c.json(getProjectRepos(db, project), 201);
});

app.delete("/api/projects/:project/repos", async (c) => {
  const project = c.req.param("project");
  const body = await c.req.json<{ path: string }>();

  const db = getDb();
  const result = db.prepare("DELETE FROM project_repos WHERE project = ? AND path = ?").run(project, body.path);
  if (result.changes === 0) return c.json({ error: "Not found" }, 404);

  return c.json(getProjectRepos(db, project));
});

// --- Gateway management ---

app.get("/api/gateways", (c) => {
  const db = getDb();
  const gateways = db.prepare("SELECT * FROM team_gateways ORDER BY role").all() as Record<string, unknown>[];
  return c.json(
    gateways.map((row) => ({
      role: row.role,
      vmHost: row.vm_host,
      gatewayPort: row.gateway_port,
      gatewayToken: row.gateway_token,
      sshKeyPath: row.ssh_key_path,
      ttydPort: row.ttyd_port,
    })),
  );
});

app.put("/api/gateways/:role", async (c) => {
  const role = c.req.param("role");
  const body = await c.req.json<{
    vmHost: string;
    gatewayPort?: number;
    gatewayToken: string;
    sshKeyPath: string;
    ttydPort?: number;
  }>();

  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO team_gateways (role, vm_host, gateway_port, gateway_token, ssh_key_path, ttyd_port)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(role, body.vmHost, body.gatewayPort ?? 18789, body.gatewayToken, body.sshKeyPath, body.ttydPort ?? 7681);

  return c.json(getTeamGateway(db, role));
});

app.use("/*", serveStatic({ root: "./public" }));

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[cockpit] Listening on port ${info.port}`);
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
  console.log("[cockpit] Shutting down...");
  clearInterval(periodicTimer);
  closeDb();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
