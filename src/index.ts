import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { nanoid } from "nanoid";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { readFileSync, writeFileSync, unlinkSync, watch as fsWatch } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config, getTeamConfig, getTeamGateway, getProjectRepos } from "./config.js";
import { getDb, closeDb } from "./db.js";
import { linearWebhook } from "./webhook/linear.js";
import { completeAgentTask, advanceRun } from "./pipeline/runner.js";
import { mergePullRequest, parsePrNumber } from "./integrations/github.js";
import { detectStuckRuns, handleStuckRun } from "./pipeline/stuck-detector.js";
import { cleanupCompletedRuns, getCleanupStats } from "./pipeline/cleanup.js";

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));

// --- SSE helpers ---

const encoder = new TextEncoder();

function makeSseResponse(setup: (write: (msg: string) => void, cleanup: () => void, signal: AbortSignal) => void): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const write = (msg: string) => writer.write(encoder.encode(msg)).catch(() => {});
  const cleanup = () => writer.close().catch(() => {});

  const controller = new AbortController();
  setup(write, cleanup, controller.signal);

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

// Broadcast run changes to all connected event clients
const eventClients = new Set<(msg: string) => void>();

function broadcast(event: string, data: unknown = {}) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const send of eventClients) send(msg);
}

const app = new Hono();

app.get("/api/health", (c) => {
  try {
    const db = getDb();
    db.prepare("SELECT 1").get();
    return c.json({ status: "ok", dev: process.env.NODE_ENV !== "production" });
  } catch (err) {
    return c.json({ status: "error", error: String(err) }, 500);
  }
});

// DB backup — streams a consistent SQLite backup (merges WAL)
app.get("/api/db/backup", async (c) => {
  const db = getDb();
  db.pragma("wal_checkpoint(TRUNCATE)");
  const backupPath = `/tmp/cockpit-backup-${process.pid}.db`;
  try {
    await db.backup(backupPath);
    const data = readFileSync(backupPath);
    return new Response(data, {
      headers: { "Content-Type": "application/octet-stream" },
    });
  } finally {
    try { unlinkSync(backupPath); } catch {}
  }
});

// DB restore — replaces the database from an uploaded file
app.post("/api/db/restore", async (c) => {
  const body = await c.req.arrayBuffer();
  if (body.byteLength < 100) return c.json({ error: "Upload too small" }, 400);
  closeDb();
  writeFileSync(config.databasePath, Buffer.from(body));
  // Remove stale WAL/SHM files
  try { unlinkSync(config.databasePath + "-wal"); } catch {}
  try { unlinkSync(config.databasePath + "-shm"); } catch {}
  getDb(); // re-open
  return c.json({ ok: true, size: body.byteLength });
});

// Real-time pipeline events (run state changes)
app.get("/api/events", (c) => {
  return makeSseResponse((write, cleanup, _signal) => {
    write(": connected\n\n");
    const heartbeat = setInterval(() => write("event: ping\ndata: {}\n\n"), config.sseHeartbeatMs);
    eventClients.add(write);
    c.req.raw.signal.addEventListener("abort", () => {
      clearInterval(heartbeat);
      eventClients.delete(write);
      cleanup();
    });
  });
});

// Dev-only: reload browser when public/ files change
if (process.env.NODE_ENV !== "production") {
  const publicDir = join(__dirname, "..", "public");
  app.get("/api/dev-reload", (c) => {
    return makeSseResponse((write, cleanup, _signal) => {
      const watcher = fsWatch(publicDir, { recursive: true }, (_evt, filename) => {
        write(`event: reload\ndata: ${JSON.stringify({ file: filename })}\n\n`);
      });
      c.req.raw.signal.addEventListener("abort", () => {
        watcher.close();
        cleanup();
      });
    });
  });
}

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
  broadcast("run:updated", { runId: c.req.param("id") });
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
  broadcast("run:updated", { runId });
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
  broadcast("run:updated", { runId });

  return c.json({ ok: true, merged: true });
});

app.get("/api/labels", (c) => {
  const db = getDb();
  const rows = db
    .prepare("SELECT DISTINCT labels FROM pipeline_runs WHERE labels != '[]'")
    .all() as { labels: string }[];
  const all = new Set<string>();
  for (const row of rows) {
    for (const l of JSON.parse(row.labels)) all.add(l);
  }
  return c.json([...all].sort());
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
  broadcast("run:updated", { runId });

  return c.json({ ok: true, retried: true });
});

// --- Scan Projects ---

app.get("/api/scan-projects", async (c) => {
  const home = homedir();
  const pruneNames = [
    "node_modules", ".cache", ".npm", ".nvm", "Library", "Applications",
    ".Trash", "Pictures", "Music", "Downloads", "Movies", "Documents",
    "target", "dist", "build", "vendor", "__pycache__",
    ".cargo", ".rustup", ".local", ".pyenv", ".docker",
    ".gradle", ".m2", ".android", ".cocoapods", "venv",
    ".pub-cache", ".toolr", ".Spotlight-V100", ".fseventsd",
    ".vol", "System", "Volumes", ".orbstack",
  ];

  const pruneExpr = pruneNames.map((n) => `-name "${n}"`).join(" -o ");
  const cmd = `find "${home}" -maxdepth 8 \\( ${pruneExpr} \\) -prune -o -name ".git" -type d -print 2>/dev/null`;

  try {
    const { stdout } = await execAsync(cmd, { timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
    const gitDirs = stdout.trim().split("\n").filter(Boolean);

    const projects = gitDirs.map((gitDir) => {
      const projectPath = gitDir.replace(/\/\.git$/, "");
      const name = projectPath.split("/").pop() || projectPath;
      let remoteUrl = "";

      try {
        const gitConfig = readFileSync(`${gitDir}/config`, "utf-8");
        const match = gitConfig.match(/url\s*=\s*(.+)/);
        if (match) remoteUrl = match[1].trim();
      } catch {}

      return { path: projectPath, name, remoteUrl };
    });

    return c.json(projects);
  } catch {
    return c.json({ error: "Scan failed" }, 500);
  }
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
      parentProject: (row.parent_project as string | null) ?? null,
      slackChannel: (row.slack_channel as string | null) ?? null,
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
    parentProject?: string;
    slackChannel?: string;
  }>();

  const db = getDb();
  const existing = db.prepare("SELECT project FROM team_config WHERE project = ?").get(body.project);
  if (existing) return c.json({ error: "Project already exists" }, 409);

  db.prepare(
    `INSERT INTO team_config (project, linear_team_id, repo_url, default_branch, review_config, parent_project, slack_channel)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    body.project,
    body.linearTeamId,
    body.repoUrl ?? "",
    body.defaultBranch ?? "main",
    JSON.stringify(body.reviewConfig ?? { focuses: ["security", "quality", "fulfillment"] }),
    body.parentProject ?? null,
    body.slackChannel ?? null,
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
    parentProject?: string | null;
    slackChannel?: string | null;
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
  if (body.parentProject !== undefined) {
    setClauses.push("parent_project = ?");
    params.push(body.parentProject ?? null);
  }
  if (body.slackChannel !== undefined) {
    setClauses.push("slack_channel = ?");
    params.push(body.slackChannel ?? null);
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
  ).run(role, body.vmHost, body.gatewayPort ?? config.defaultGatewayPort, body.gatewayToken, body.sshKeyPath, body.ttydPort ?? config.defaultTtydPort);

  return c.json(getTeamGateway(db, role));
});

app.use("/*", serveStatic({ root: "./public" }));

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[cockpit] Listening on port ${info.port}`);
});

const periodicTimer = setInterval(async () => {
  try {
    const db = getDb();

    const stuckRuns = detectStuckRuns(db);
    if (stuckRuns.length > 0) {
      console.log(`[periodic] Found ${stuckRuns.length} stuck run(s)`);
      for (const stuck of stuckRuns) {
        await handleStuckRun(db, stuck.runId, stuck.reason);
      }
      broadcast("run:updated");
    }

    const cleaned = await cleanupCompletedRuns(db, config.cleanupRetentionDays);
    if (cleaned > 0) {
      console.log(`[periodic] Cleaned up ${cleaned} old worktree(s)`);
      broadcast("run:updated");
    }
  } catch (err) {
    console.error(`[periodic] Error in periodic check:`, err);
  }
}, config.periodicIntervalMs);

function shutdown() {
  console.log("[cockpit] Shutting down...");
  clearInterval(periodicTimer);
  closeDb();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
