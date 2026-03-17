import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PipelineState,
  canTransition,
  TRANSITIONS,
} from "../src/pipeline/states.js";

describe("PipelineState", () => {
  it("defines all expected states", () => {
    const expected = [
      "RECEIVED",
      "WORKTREE_SETUP",
      "DEVELOPING",
      "DEV_COMPLETE",
      "REVIEWING",
      "REVIEW_DECIDED",
      "TESTING",
      "TEST_DECIDED",
      "DEPLOYING",
      "VERIFYING",
      "AWAITING_MERGE",
      "MERGED",
      "CLEANUP",
      "DONE",
      "FAILED",
    ];
    assert.deepStrictEqual(Object.values(PipelineState), expected);
  });
});

describe("canTransition", () => {
  it("allows RECEIVED → WORKTREE_SETUP", () => {
    assert.ok(canTransition(PipelineState.RECEIVED, PipelineState.WORKTREE_SETUP));
  });

  it("allows WORKTREE_SETUP → DEVELOPING", () => {
    assert.ok(
      canTransition(PipelineState.WORKTREE_SETUP, PipelineState.DEVELOPING),
    );
  });

  it("allows DEVELOPING → DEV_COMPLETE", () => {
    assert.ok(
      canTransition(PipelineState.DEVELOPING, PipelineState.DEV_COMPLETE),
    );
  });

  it("allows REVIEW_DECIDED → TESTING (approved)", () => {
    assert.ok(
      canTransition(PipelineState.REVIEW_DECIDED, PipelineState.TESTING),
    );
  });

  it("allows REVIEW_DECIDED → DEVELOPING (changes requested)", () => {
    assert.ok(
      canTransition(PipelineState.REVIEW_DECIDED, PipelineState.DEVELOPING),
    );
  });

  it("allows TEST_DECIDED → DEPLOYING (passed)", () => {
    assert.ok(
      canTransition(PipelineState.TEST_DECIDED, PipelineState.DEPLOYING),
    );
  });

  it("allows TEST_DECIDED → FAILED", () => {
    assert.ok(
      canTransition(PipelineState.TEST_DECIDED, PipelineState.FAILED),
    );
  });

  it("allows full happy path", () => {
    const happyPath: PipelineState[] = [
      PipelineState.RECEIVED,
      PipelineState.WORKTREE_SETUP,
      PipelineState.DEVELOPING,
      PipelineState.DEV_COMPLETE,
      PipelineState.REVIEWING,
      PipelineState.REVIEW_DECIDED,
      PipelineState.TESTING,
      PipelineState.TEST_DECIDED,
      PipelineState.DEPLOYING,
      PipelineState.VERIFYING,
      PipelineState.AWAITING_MERGE,
      PipelineState.MERGED,
      PipelineState.CLEANUP,
      PipelineState.DONE,
    ];

    for (let i = 0; i < happyPath.length - 1; i++) {
      assert.ok(
        canTransition(happyPath[i], happyPath[i + 1]),
        `Expected ${happyPath[i]} → ${happyPath[i + 1]} to be allowed`,
      );
    }
  });

  it("rejects invalid transitions", () => {
    assert.ok(!canTransition(PipelineState.RECEIVED, PipelineState.DEVELOPING));
    assert.ok(!canTransition(PipelineState.DEVELOPING, PipelineState.TESTING));
    assert.ok(!canTransition(PipelineState.DONE, PipelineState.RECEIVED));
    assert.ok(!canTransition(PipelineState.FAILED, PipelineState.RECEIVED));
  });

  it("has no transitions from terminal states", () => {
    assert.strictEqual(TRANSITIONS[PipelineState.DONE], undefined);
    assert.strictEqual(TRANSITIONS[PipelineState.FAILED], undefined);
  });

  it("allows re-review cycle: REVIEW_DECIDED → DEVELOPING → DEV_COMPLETE → REVIEWING", () => {
    assert.ok(canTransition(PipelineState.REVIEW_DECIDED, PipelineState.DEVELOPING));
    assert.ok(canTransition(PipelineState.DEVELOPING, PipelineState.DEV_COMPLETE));
    assert.ok(canTransition(PipelineState.DEV_COMPLETE, PipelineState.REVIEWING));
    assert.ok(canTransition(PipelineState.REVIEWING, PipelineState.REVIEW_DECIDED));
  });
});

describe("review aggregation", async () => {
  const Database = (await import("better-sqlite3")).default;
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { nanoid } = await import("nanoid");
  const {
    aggregateReviewResults,
    getFailingFocuses,
    formatFindingsMarkdown,
  } = await import("../src/review/aggregator.js");

  const __dirname = dirname(fileURLToPath(import.meta.url));

  function createTestDb() {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    const schema = readFileSync(
      join(__dirname, "..", "migrations", "001-initial.sql"),
      "utf-8",
    );
    db.exec(schema);
    db.exec("ALTER TABLE pipeline_runs ADD COLUMN failing_focuses TEXT;");
    db.exec("CREATE TABLE IF NOT EXISTS project_repos (project TEXT NOT NULL, path TEXT NOT NULL, repo_url TEXT NOT NULL, is_primary INTEGER DEFAULT 0, default_branch TEXT DEFAULT 'main', PRIMARY KEY (project, path));");
    return db;
  }

  function seedRun(db: ReturnType<typeof createTestDb>, overrides?: Record<string, unknown>) {
    const id = nanoid();
    db.prepare(
      `INSERT INTO pipeline_runs (id, issue_id, issue_uuid, project, state, branch, worktree_path)
       VALUES (?, 'TWI-99', 'uuid-99', 'test-project', 'REVIEWING', 'twi-99', '/worktrees/twi-99')`,
    ).run(id);
    if (overrides) {
      for (const [col, val] of Object.entries(overrides)) {
        db.prepare(`UPDATE pipeline_runs SET ${col} = ? WHERE id = ?`).run(val, id);
      }
    }
    return id;
  }

  function seedTask(db: ReturnType<typeof createTestDb>, runId: string, focus: string, model: string) {
    const id = nanoid();
    db.prepare(
      `INSERT INTO agent_tasks (id, run_id, team, stage, focus, model, status, started_at)
       VALUES (?, ?, 'reviewer', 'review', ?, ?, 'running', datetime('now'))`,
    ).run(id, runId, focus, model);
    return id;
  }

  function seedFinding(
    db: ReturnType<typeof createTestDb>,
    taskId: string,
    runId: string,
    severity: string,
    description: string,
  ) {
    db.prepare(
      `INSERT INTO review_findings (id, agent_task_id, run_id, severity, description)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(nanoid(), taskId, runId, severity, description);
  }

  it("returns approved when no findings", () => {
    const db = createTestDb();
    const runId = seedRun(db);
    const { decision, findings } = aggregateReviewResults(db, runId);
    assert.strictEqual(decision, "approved");
    assert.strictEqual(findings.length, 0);
  });

  it("returns approved when only low/medium findings", () => {
    const db = createTestDb();
    const runId = seedRun(db);
    const taskId = seedTask(db, runId, "security", "claude");
    seedFinding(db, taskId, runId, "low", "minor style issue");
    seedFinding(db, taskId, runId, "medium", "could be improved");

    const { decision, findings } = aggregateReviewResults(db, runId);
    assert.strictEqual(decision, "approved");
    assert.strictEqual(findings.length, 2);
  });

  it("returns changes_requested when high/critical findings exist", () => {
    const db = createTestDb();
    const runId = seedRun(db);
    const taskId = seedTask(db, runId, "security", "claude");
    seedFinding(db, taskId, runId, "critical", "SQL injection vulnerability");
    seedFinding(db, taskId, runId, "low", "minor nit");

    const { decision, findings } = aggregateReviewResults(db, runId);
    assert.strictEqual(decision, "changes_requested");
    assert.strictEqual(findings.length, 2);
  });

  it("getFailingFocuses returns focuses with blocking findings", () => {
    const db = createTestDb();
    const runId = seedRun(db);
    const secTask = seedTask(db, runId, "security", "claude");
    const qualTask = seedTask(db, runId, "quality", "claude");
    const fulTask = seedTask(db, runId, "fulfillment", "claude");

    seedFinding(db, secTask, runId, "critical", "XSS vulnerability");
    seedFinding(db, qualTask, runId, "low", "minor naming issue");
    seedFinding(db, fulTask, runId, "high", "missing required feature");

    const failing = getFailingFocuses(db, runId);
    assert.ok(failing.includes("security"));
    assert.ok(failing.includes("fulfillment"));
    assert.ok(!failing.includes("quality"));
  });

  it("formatFindingsMarkdown formats blocking and non-blocking separately", () => {
    const findings = [
      {
        id: "1",
        agentTaskId: "t1",
        runId: "r1",
        severity: "critical",
        filePath: "src/auth.ts",
        lineNumber: 42,
        description: "SQL injection",
        resolved: false,
      },
      {
        id: "2",
        agentTaskId: "t2",
        runId: "r1",
        severity: "low",
        filePath: null,
        lineNumber: null,
        description: "minor style",
        resolved: false,
      },
    ];

    const md = formatFindingsMarkdown(findings);
    assert.ok(md.includes("### Blocking findings"));
    assert.ok(md.includes("### Other findings"));
    assert.ok(md.includes("`src/auth.ts:42`"));
    assert.ok(md.includes("SQL injection"));
    assert.ok(md.includes("general"));
    assert.ok(md.includes("minor style"));
  });
});

describe("review task completion flow", async () => {
  const Database = (await import("better-sqlite3")).default;
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { nanoid } = await import("nanoid");
  const { completeAgentTask } = await import("../src/pipeline/runner.js");
  const { PipelineState } = await import("../src/pipeline/states.js");

  const __dirname = dirname(fileURLToPath(import.meta.url));

  function createTestDb() {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    const schema = readFileSync(
      join(__dirname, "..", "migrations", "001-initial.sql"),
      "utf-8",
    );
    db.exec(schema);
    db.exec("ALTER TABLE pipeline_runs ADD COLUMN failing_focuses TEXT;");
    db.exec("CREATE TABLE IF NOT EXISTS project_repos (project TEXT NOT NULL, path TEXT NOT NULL, repo_url TEXT NOT NULL, is_primary INTEGER DEFAULT 0, default_branch TEXT DEFAULT 'main', PRIMARY KEY (project, path));");
    // Seed team config and gateways so advanceRun handlers don't fail
    db.prepare(
      `INSERT INTO team_config (project, linear_team_id, repo_url, default_branch, review_config)
       VALUES ('test-project', 'team-1', 'https://github.com/test/repo', 'main',
               '{"focuses":["security","quality","fulfillment"]}')`,
    ).run();
    db.prepare(
      `INSERT INTO team_gateways (role, vm_host, gateway_port, gateway_token, ssh_key_path, ttyd_port)
       VALUES ('reviewer', 'localhost', 18789, 'test-token', '/tmp/key', 7681)`,
    ).run();
    return db;
  }

  it("advances to REVIEW_DECIDED when all review tasks complete", () => {
    const db = createTestDb();
    const runId = nanoid();
    db.prepare(
      `INSERT INTO pipeline_runs (id, issue_id, issue_uuid, project, state, branch, worktree_path)
       VALUES (?, 'TWI-10', 'uuid-10', 'test-project', 'REVIEWING', 'twi-10', '/worktrees/twi-10')`,
    ).run(runId);

    const task1 = nanoid();
    const task2 = nanoid();
    db.prepare(
      `INSERT INTO agent_tasks (id, run_id, team, stage, focus, model, status, started_at)
       VALUES (?, ?, 'reviewer', 'review', 'security', 'claude', 'running', datetime('now'))`,
    ).run(task1, runId);
    db.prepare(
      `INSERT INTO agent_tasks (id, run_id, team, stage, focus, model, status, started_at)
       VALUES (?, ?, 'reviewer', 'review', 'quality', 'claude', 'running', datetime('now'))`,
    ).run(task2, runId);

    // Complete first task — should NOT advance yet
    completeAgentTask(db, task1, "success", '{"findings":[]}');
    const midRun = db
      .prepare("SELECT state FROM pipeline_runs WHERE id = ?")
      .get(runId) as { state: string };
    assert.strictEqual(midRun.state, "REVIEWING");

    // Complete second task — should advance to REVIEW_DECIDED
    completeAgentTask(db, task2, "success", '{"findings":[]}');
    const finalRun = db
      .prepare("SELECT state FROM pipeline_runs WHERE id = ?")
      .get(runId) as { state: string };
    assert.strictEqual(finalRun.state, "REVIEW_DECIDED");
  });

  it("parses review findings from output and inserts them", () => {
    const db = createTestDb();
    const runId = nanoid();
    db.prepare(
      `INSERT INTO pipeline_runs (id, issue_id, issue_uuid, project, state, branch, worktree_path)
       VALUES (?, 'TWI-11', 'uuid-11', 'test-project', 'REVIEWING', 'twi-11', '/worktrees/twi-11')`,
    ).run(runId);

    const taskId = nanoid();
    db.prepare(
      `INSERT INTO agent_tasks (id, run_id, team, stage, focus, model, status, started_at)
       VALUES (?, ?, 'reviewer', 'review', 'security', 'claude', 'running', datetime('now'))`,
    ).run(taskId, runId);

    const output = JSON.stringify({
      findings: [
        { severity: "critical", filePath: "src/auth.ts", lineNumber: 10, description: "SQL injection" },
        { severity: "low", description: "minor style" },
      ],
    });

    completeAgentTask(db, taskId, "success", output);

    const findings = db
      .prepare("SELECT * FROM review_findings WHERE run_id = ?")
      .all(runId) as Record<string, unknown>[];
    assert.strictEqual(findings.length, 2);
    assert.strictEqual(findings[0].severity, "critical");
    assert.strictEqual(findings[0].file_path, "src/auth.ts");
    assert.strictEqual(findings[1].severity, "low");
    assert.strictEqual(findings[1].file_path, null);
  });

  it("does not advance on develop task completion when in REVIEWING state", () => {
    const db = createTestDb();
    const runId = nanoid();
    db.prepare(
      `INSERT INTO pipeline_runs (id, issue_id, issue_uuid, project, state, branch, worktree_path)
       VALUES (?, 'TWI-12', 'uuid-12', 'test-project', 'REVIEWING', 'twi-12', '/worktrees/twi-12')`,
    ).run(runId);

    const taskId = nanoid();
    db.prepare(
      `INSERT INTO agent_tasks (id, run_id, team, stage, focus, model, status, started_at)
       VALUES (?, ?, 'developer', 'develop', NULL, 'claude-code', 'running', datetime('now'))`,
    ).run(taskId, runId);

    completeAgentTask(db, taskId, "success");
    const run = db
      .prepare("SELECT state FROM pipeline_runs WHERE id = ?")
      .get(runId) as { state: string };
    assert.strictEqual(run.state, "REVIEWING");
  });
});

describe("re-review matching", async () => {
  const { PipelineState } = await import("../src/pipeline/states.js");

  it("supports full re-review state cycle", () => {
    // REVIEW_DECIDED → DEVELOPING → DEV_COMPLETE → REVIEWING → REVIEW_DECIDED → TESTING
    const cycle: PipelineState[] = [
      PipelineState.REVIEW_DECIDED,
      PipelineState.DEVELOPING,
      PipelineState.DEV_COMPLETE,
      PipelineState.REVIEWING,
      PipelineState.REVIEW_DECIDED,
      PipelineState.TESTING,
    ];

    for (let i = 0; i < cycle.length - 1; i++) {
      assert.ok(
        canTransition(cycle[i], cycle[i + 1]),
        `Expected ${cycle[i]} → ${cycle[i + 1]} to be allowed`,
      );
    }
  });
});

describe("test task completion flow", async () => {
  const Database = (await import("better-sqlite3")).default;
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { nanoid } = await import("nanoid");
  const { completeAgentTask } = await import("../src/pipeline/runner.js");
  const { PipelineState } = await import("../src/pipeline/states.js");

  const __dirname = dirname(fileURLToPath(import.meta.url));

  function createTestDb() {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    const schema = readFileSync(
      join(__dirname, "..", "migrations", "001-initial.sql"),
      "utf-8",
    );
    db.exec(schema);
    db.exec("ALTER TABLE pipeline_runs ADD COLUMN failing_focuses TEXT;");
    db.exec("CREATE TABLE IF NOT EXISTS project_repos (project TEXT NOT NULL, path TEXT NOT NULL, repo_url TEXT NOT NULL, is_primary INTEGER DEFAULT 0, default_branch TEXT DEFAULT 'main', PRIMARY KEY (project, path));");
    db.prepare(
      `INSERT INTO team_config (project, linear_team_id, repo_url, default_branch, review_config)
       VALUES ('test-project', 'team-1', 'https://github.com/test/repo', 'main',
               '{"focuses":["security","quality","fulfillment"]}')`,
    ).run();
    db.prepare(
      `INSERT INTO team_gateways (role, vm_host, gateway_port, gateway_token, ssh_key_path, ttyd_port)
       VALUES ('tester', 'localhost', 18789, 'test-token', '/tmp/key', 7681)`,
    ).run();
    return db;
  }

  it("advances to TEST_DECIDED when all test tasks complete", () => {
    const db = createTestDb();
    const runId = nanoid();
    db.prepare(
      `INSERT INTO pipeline_runs (id, issue_id, issue_uuid, project, state, branch, worktree_path)
       VALUES (?, 'TWI-20', 'uuid-20', 'test-project', 'TESTING', 'twi-20', '/worktrees/twi-20')`,
    ).run(runId);

    const task1 = nanoid();
    const task2 = nanoid();
    db.prepare(
      `INSERT INTO agent_tasks (id, run_id, team, stage, model, status, started_at)
       VALUES (?, ?, 'tester', 'test', 'claude', 'running', datetime('now'))`,
    ).run(task1, runId);
    db.prepare(
      `INSERT INTO agent_tasks (id, run_id, team, stage, model, status, started_at)
       VALUES (?, ?, 'tester', 'test', 'gemini', 'running', datetime('now'))`,
    ).run(task2, runId);

    // Complete first — should NOT advance yet
    completeAgentTask(db, task1, "success");
    const midRun = db
      .prepare("SELECT state FROM pipeline_runs WHERE id = ?")
      .get(runId) as { state: string };
    assert.strictEqual(midRun.state, "TESTING");

    // Complete second — should advance to TEST_DECIDED
    completeAgentTask(db, task2, "success");
    const finalRun = db
      .prepare("SELECT state FROM pipeline_runs WHERE id = ?")
      .get(runId) as { state: string };
    assert.strictEqual(finalRun.state, "TEST_DECIDED");
  });

  it("does not advance test tasks when in wrong state", () => {
    const db = createTestDb();
    const runId = nanoid();
    db.prepare(
      `INSERT INTO pipeline_runs (id, issue_id, issue_uuid, project, state, branch, worktree_path)
       VALUES (?, 'TWI-21', 'uuid-21', 'test-project', 'REVIEWING', 'twi-21', '/worktrees/twi-21')`,
    ).run(runId);

    const taskId = nanoid();
    db.prepare(
      `INSERT INTO agent_tasks (id, run_id, team, stage, model, status, started_at)
       VALUES (?, ?, 'tester', 'test', 'claude', 'running', datetime('now'))`,
    ).run(taskId, runId);

    completeAgentTask(db, taskId, "success");
    const run = db
      .prepare("SELECT state FROM pipeline_runs WHERE id = ?")
      .get(runId) as { state: string };
    assert.strictEqual(run.state, "REVIEWING");
  });
});

describe("deploy task completion flow", async () => {
  const Database = (await import("better-sqlite3")).default;
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { nanoid } = await import("nanoid");
  const { completeAgentTask } = await import("../src/pipeline/runner.js");

  const __dirname = dirname(fileURLToPath(import.meta.url));

  function createTestDb() {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    const schema = readFileSync(
      join(__dirname, "..", "migrations", "001-initial.sql"),
      "utf-8",
    );
    db.exec(schema);
    db.exec("ALTER TABLE pipeline_runs ADD COLUMN failing_focuses TEXT;");
    db.exec("CREATE TABLE IF NOT EXISTS project_repos (project TEXT NOT NULL, path TEXT NOT NULL, repo_url TEXT NOT NULL, is_primary INTEGER DEFAULT 0, default_branch TEXT DEFAULT 'main', PRIMARY KEY (project, path));");
    db.prepare(
      `INSERT INTO team_config (project, linear_team_id, repo_url, default_branch, review_config)
       VALUES ('test-project', 'team-1', 'https://github.com/test/repo', 'main',
               '{"focuses":["security","quality","fulfillment"]}')`,
    ).run();
    db.prepare(
      `INSERT INTO team_gateways (role, vm_host, gateway_port, gateway_token, ssh_key_path, ttyd_port)
       VALUES ('devops', 'localhost', 18789, 'test-token', '/tmp/key', 7681)`,
    ).run();
    return db;
  }

  it("advances DEPLOYING → VERIFYING on deploy success", () => {
    const db = createTestDb();
    const runId = nanoid();
    db.prepare(
      `INSERT INTO pipeline_runs (id, issue_id, issue_uuid, project, state, branch, worktree_path, pr_url)
       VALUES (?, 'TWI-30', 'uuid-30', 'test-project', 'DEPLOYING', 'twi-30', '/worktrees/twi-30', 'https://github.com/test/repo/pull/1')`,
    ).run(runId);

    const taskId = nanoid();
    db.prepare(
      `INSERT INTO agent_tasks (id, run_id, team, stage, model, status, started_at)
       VALUES (?, ?, 'devops', 'deploy', 'claude', 'running', datetime('now'))`,
    ).run(taskId, runId);

    completeAgentTask(db, taskId, "success");
    const run = db
      .prepare("SELECT state FROM pipeline_runs WHERE id = ?")
      .get(runId) as { state: string };
    assert.strictEqual(run.state, "VERIFYING");
  });

  it("advances DEPLOYING → FAILED on deploy failure", () => {
    const db = createTestDb();
    const runId = nanoid();
    db.prepare(
      `INSERT INTO pipeline_runs (id, issue_id, issue_uuid, project, state, branch, worktree_path, pr_url)
       VALUES (?, 'TWI-31', 'uuid-31', 'test-project', 'DEPLOYING', 'twi-31', '/worktrees/twi-31', 'https://github.com/test/repo/pull/2')`,
    ).run(runId);

    const taskId = nanoid();
    db.prepare(
      `INSERT INTO agent_tasks (id, run_id, team, stage, model, status, started_at)
       VALUES (?, ?, 'devops', 'deploy', 'claude', 'running', datetime('now'))`,
    ).run(taskId, runId);

    completeAgentTask(db, taskId, "failure");
    const run = db
      .prepare("SELECT state FROM pipeline_runs WHERE id = ?")
      .get(runId) as { state: string };
    assert.strictEqual(run.state, "FAILED");
  });
});

describe("test decision logic", async () => {
  const { PipelineState } = await import("../src/pipeline/states.js");

  it("allows DEPLOYING → FAILED", () => {
    assert.ok(
      canTransition(PipelineState.DEPLOYING, PipelineState.FAILED),
    );
  });

  it("allows TEST_DECIDED → DEPLOYING (all pass)", () => {
    assert.ok(
      canTransition(PipelineState.TEST_DECIDED, PipelineState.DEPLOYING),
    );
  });

  it("allows TEST_DECIDED → FAILED (failures at max depth)", () => {
    assert.ok(
      canTransition(PipelineState.TEST_DECIDED, PipelineState.FAILED),
    );
  });
});

describe("multi-project support", async () => {
  const Database = (await import("better-sqlite3")).default;
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { nanoid } = await import("nanoid");
  const { getTeamConfig } = await import("../src/config.js");

  const __dirname = dirname(fileURLToPath(import.meta.url));

  function createTestDb() {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    const schema = readFileSync(
      join(__dirname, "..", "migrations", "001-initial.sql"),
      "utf-8",
    );
    db.exec(schema);
    db.exec("ALTER TABLE pipeline_runs ADD COLUMN failing_focuses TEXT;");
    db.exec("CREATE TABLE IF NOT EXISTS project_repos (project TEXT NOT NULL, path TEXT NOT NULL, repo_url TEXT NOT NULL, is_primary INTEGER DEFAULT 0, default_branch TEXT DEFAULT 'main', PRIMARY KEY (project, path));");
    return db;
  }

  it("supports multiple projects in team_config", () => {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO team_config (project, linear_team_id, repo_url, default_branch, review_config)
       VALUES ('toolr', 'team-1', 'https://github.com/test/toolr', 'main',
               '{"focuses":["security","quality","fulfillment"],"models":["claude","gemini"]}')`,
    ).run();
    db.prepare(
      `INSERT INTO team_config (project, linear_team_id, repo_url, default_branch, review_config)
       VALUES ('twiced-homepage', 'team-2', 'https://github.com/test/homepage', 'main',
               '{"focuses":["security","quality","fulfillment"],"models":["claude"]}')`,
    ).run();

    const toolr = getTeamConfig(db, "toolr");
    const homepage = getTeamConfig(db, "twiced-homepage");

    assert.ok(toolr);
    assert.ok(homepage);
    assert.strictEqual(toolr.project, "toolr");
    assert.strictEqual(homepage.project, "twiced-homepage");
    assert.strictEqual(toolr.repoUrl, "https://github.com/test/toolr");
    assert.strictEqual(homepage.repoUrl, "https://github.com/test/homepage");
    assert.deepStrictEqual(toolr.reviewConfig.models, ["claude", "gemini"]);
    assert.deepStrictEqual(homepage.reviewConfig.models, ["claude"]);
  });

  it("routes pipeline runs by project field", () => {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO team_config (project, linear_team_id, repo_url, default_branch, review_config)
       VALUES ('toolr', 'team-1', 'https://github.com/test/toolr', 'main', '{"focuses":["security"]}')`,
    ).run();
    db.prepare(
      `INSERT INTO team_config (project, linear_team_id, repo_url, default_branch, review_config)
       VALUES ('twiced-homepage', 'team-2', 'https://github.com/test/homepage', 'main', '{"focuses":["security"]}')`,
    ).run();

    const run1 = nanoid();
    const run2 = nanoid();
    db.prepare(
      `INSERT INTO pipeline_runs (id, issue_id, issue_uuid, project, state)
       VALUES (?, 'TOOL-1', 'uuid-1', 'toolr', 'RECEIVED')`,
    ).run(run1);
    db.prepare(
      `INSERT INTO pipeline_runs (id, issue_id, issue_uuid, project, state)
       VALUES (?, 'TWI-1', 'uuid-2', 'twiced-homepage', 'RECEIVED')`,
    ).run(run2);

    const toolrRun = db
      .prepare("SELECT project FROM pipeline_runs WHERE id = ?")
      .get(run1) as { project: string };
    const homepageRun = db
      .prepare("SELECT project FROM pipeline_runs WHERE id = ?")
      .get(run2) as { project: string };

    assert.strictEqual(toolrRun.project, "toolr");
    assert.strictEqual(homepageRun.project, "twiced-homepage");

    const toolrConfig = getTeamConfig(db, toolrRun.project);
    const homepageConfig = getTeamConfig(db, homepageRun.project);
    assert.ok(toolrConfig);
    assert.ok(homepageConfig);
    assert.strictEqual(toolrConfig.repoUrl, "https://github.com/test/toolr");
    assert.strictEqual(homepageConfig.repoUrl, "https://github.com/test/homepage");
  });
});

describe("stuck detection", async () => {
  const Database = (await import("better-sqlite3")).default;
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { nanoid } = await import("nanoid");
  const { detectStuckRuns, handleStuckRun } = await import(
    "../src/pipeline/stuck-detector.js"
  );

  const __dirname = dirname(fileURLToPath(import.meta.url));

  function createTestDb() {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    const schema = readFileSync(
      join(__dirname, "..", "migrations", "001-initial.sql"),
      "utf-8",
    );
    db.exec(schema);
    db.exec("ALTER TABLE pipeline_runs ADD COLUMN failing_focuses TEXT;");
    db.exec("CREATE TABLE IF NOT EXISTS project_repos (project TEXT NOT NULL, path TEXT NOT NULL, repo_url TEXT NOT NULL, is_primary INTEGER DEFAULT 0, default_branch TEXT DEFAULT 'main', PRIMARY KEY (project, path));");
    return db;
  }

  it("does not flag recent runs as stuck", () => {
    const db = createTestDb();
    const runId = nanoid();
    db.prepare(
      `INSERT INTO pipeline_runs (id, issue_id, issue_uuid, project, state, updated_at)
       VALUES (?, 'TWI-50', 'uuid-50', 'test-project', 'DEVELOPING', datetime('now'))`,
    ).run(runId);
    db.prepare(
      `INSERT INTO agent_tasks (id, run_id, team, stage, model, status, started_at)
       VALUES (?, ?, 'developer', 'develop', 'claude', 'running', datetime('now'))`,
    ).run(nanoid(), runId);

    const stuck = detectStuckRuns(db);
    assert.strictEqual(stuck.length, 0);
  });

  it("flags runs with long-running agent tasks", () => {
    const db = createTestDb();
    const runId = nanoid();
    db.prepare(
      `INSERT INTO pipeline_runs (id, issue_id, issue_uuid, project, state, updated_at)
       VALUES (?, 'TWI-51', 'uuid-51', 'test-project', 'DEVELOPING', datetime('now', '-10 minutes'))`,
    ).run(runId);
    db.prepare(
      `INSERT INTO agent_tasks (id, run_id, team, stage, model, status, started_at)
       VALUES (?, ?, 'developer', 'develop', 'claude', 'running', datetime('now', '-45 minutes'))`,
    ).run(nanoid(), runId);

    const stuck = detectStuckRuns(db, 30, 120);
    assert.strictEqual(stuck.length, 1);
    assert.strictEqual(stuck[0].runId, runId);
    assert.ok(stuck[0].reason.includes("Agent tasks stuck"));
  });

  it("flags runs past full run timeout", () => {
    const db = createTestDb();
    const runId = nanoid();
    db.prepare(
      `INSERT INTO pipeline_runs (id, issue_id, issue_uuid, project, state, updated_at)
       VALUES (?, 'TWI-52', 'uuid-52', 'test-project', 'AWAITING_MERGE', datetime('now', '-150 minutes'))`,
    ).run(runId);

    const stuck = detectStuckRuns(db, 30, 120);
    assert.strictEqual(stuck.length, 1);
    assert.strictEqual(stuck[0].runId, runId);
    assert.ok(stuck[0].reason.includes("full run timeout"));
  });

  it("does not flag terminal runs", () => {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO pipeline_runs (id, issue_id, issue_uuid, project, state, updated_at)
       VALUES (?, 'TWI-53', 'uuid-53', 'test-project', 'DONE', datetime('now', '-200 minutes'))`,
    ).run(nanoid());
    db.prepare(
      `INSERT INTO pipeline_runs (id, issue_id, issue_uuid, project, state, updated_at)
       VALUES (?, 'TWI-54', 'uuid-54', 'test-project', 'FAILED', datetime('now', '-200 minutes'))`,
    ).run(nanoid());

    const stuck = detectStuckRuns(db, 30, 120);
    assert.strictEqual(stuck.length, 0);
  });

  it("handleStuckRun marks run as FAILED", async () => {
    const db = createTestDb();
    const runId = nanoid();
    db.prepare(
      `INSERT INTO pipeline_runs (id, issue_id, issue_uuid, project, state)
       VALUES (?, 'TWI-55', 'uuid-55', 'test-project', 'DEVELOPING')`,
    ).run(runId);

    const taskId = nanoid();
    db.prepare(
      `INSERT INTO agent_tasks (id, run_id, team, stage, model, status, started_at)
       VALUES (?, ?, 'developer', 'develop', 'claude', 'running', datetime('now'))`,
    ).run(taskId, runId);

    await handleStuckRun(db, runId, "Test stuck reason");

    const run = db
      .prepare("SELECT state FROM pipeline_runs WHERE id = ?")
      .get(runId) as { state: string };
    assert.strictEqual(run.state, "FAILED");

    const task = db
      .prepare("SELECT status, result FROM agent_tasks WHERE id = ?")
      .get(taskId) as { status: string; result: string };
    assert.strictEqual(task.status, "failed");
    assert.strictEqual(task.result, "timed out");
  });
});

describe("cleanup", async () => {
  const Database = (await import("better-sqlite3")).default;
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { nanoid } = await import("nanoid");
  const { getCleanupStats } = await import("../src/pipeline/cleanup.js");

  const __dirname = dirname(fileURLToPath(import.meta.url));

  function createTestDb() {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    const schema = readFileSync(
      join(__dirname, "..", "migrations", "001-initial.sql"),
      "utf-8",
    );
    db.exec(schema);
    db.exec("ALTER TABLE pipeline_runs ADD COLUMN failing_focuses TEXT;");
    db.exec("CREATE TABLE IF NOT EXISTS project_repos (project TEXT NOT NULL, path TEXT NOT NULL, repo_url TEXT NOT NULL, is_primary INTEGER DEFAULT 0, default_branch TEXT DEFAULT 'main', PRIMARY KEY (project, path));");
    return db;
  }

  it("getCleanupStats returns correct counts", () => {
    const db = createTestDb();

    db.prepare(
      `INSERT INTO pipeline_runs (id, issue_id, issue_uuid, project, state, updated_at)
       VALUES (?, 'TWI-60', 'uuid-60', 'test-project', 'DEVELOPING', datetime('now'))`,
    ).run(nanoid());
    db.prepare(
      `INSERT INTO pipeline_runs (id, issue_id, issue_uuid, project, state, updated_at)
       VALUES (?, 'TWI-61', 'uuid-61', 'test-project', 'REVIEWING', datetime('now'))`,
    ).run(nanoid());
    db.prepare(
      `INSERT INTO pipeline_runs (id, issue_id, issue_uuid, project, state, updated_at)
       VALUES (?, 'TWI-62', 'uuid-62', 'test-project', 'DONE', datetime('now', '-10 days'))`,
    ).run(nanoid());
    db.prepare(
      `INSERT INTO pipeline_runs (id, issue_id, issue_uuid, project, state, updated_at)
       VALUES (?, 'TWI-63', 'uuid-63', 'test-project', 'FAILED', datetime('now', '-10 days'))`,
    ).run(nanoid());
    db.prepare(
      `INSERT INTO pipeline_runs (id, issue_id, issue_uuid, project, state, updated_at)
       VALUES (?, 'TWI-64', 'uuid-64', 'test-project', 'DONE', datetime('now'))`,
    ).run(nanoid());

    const stats = getCleanupStats(db);
    assert.strictEqual(stats.runsByState["DEVELOPING"], 1);
    assert.strictEqual(stats.runsByState["REVIEWING"], 1);
    assert.strictEqual(stats.runsByState["DONE"], 2);
    assert.strictEqual(stats.runsByState["FAILED"], 1);
    assert.strictEqual(stats.oldCompletedRuns, 2);
    assert.strictEqual(stats.activeAgentTasks, 0);
  });

  it("counts active agent tasks", () => {
    const db = createTestDb();
    const runId = nanoid();
    db.prepare(
      `INSERT INTO pipeline_runs (id, issue_id, issue_uuid, project, state)
       VALUES (?, 'TWI-65', 'uuid-65', 'test-project', 'DEVELOPING')`,
    ).run(runId);
    db.prepare(
      `INSERT INTO agent_tasks (id, run_id, team, stage, model, status, started_at)
       VALUES (?, ?, 'developer', 'develop', 'claude', 'running', datetime('now'))`,
    ).run(nanoid(), runId);
    db.prepare(
      `INSERT INTO agent_tasks (id, run_id, team, stage, model, status, started_at)
       VALUES (?, ?, 'developer', 'develop', 'gemini', 'running', datetime('now'))`,
    ).run(nanoid(), runId);

    const stats = getCleanupStats(db);
    assert.strictEqual(stats.activeAgentTasks, 2);
  });
});

describe("retry endpoint logic", async () => {
  const Database = (await import("better-sqlite3")).default;
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { nanoid } = await import("nanoid");

  const __dirname = dirname(fileURLToPath(import.meta.url));

  function createTestDb() {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    const schema = readFileSync(
      join(__dirname, "..", "migrations", "001-initial.sql"),
      "utf-8",
    );
    db.exec(schema);
    db.exec("ALTER TABLE pipeline_runs ADD COLUMN failing_focuses TEXT;");
    db.exec("CREATE TABLE IF NOT EXISTS project_repos (project TEXT NOT NULL, path TEXT NOT NULL, repo_url TEXT NOT NULL, is_primary INTEGER DEFAULT 0, default_branch TEXT DEFAULT 'main', PRIMARY KEY (project, path));");
    return db;
  }

  it("can reset FAILED run to RECEIVED", () => {
    const db = createTestDb();
    const runId = nanoid();
    db.prepare(
      `INSERT INTO pipeline_runs (id, issue_id, issue_uuid, project, state)
       VALUES (?, 'TWI-70', 'uuid-70', 'test-project', 'FAILED')`,
    ).run(runId);

    db.prepare(
      "UPDATE pipeline_runs SET state = 'RECEIVED', updated_at = datetime('now') WHERE id = ? AND state = 'FAILED'",
    ).run(runId);

    const run = db
      .prepare("SELECT state FROM pipeline_runs WHERE id = ?")
      .get(runId) as { state: string };
    assert.strictEqual(run.state, "RECEIVED");
  });

  it("does not reset non-FAILED run", () => {
    const db = createTestDb();
    const runId = nanoid();
    db.prepare(
      `INSERT INTO pipeline_runs (id, issue_id, issue_uuid, project, state)
       VALUES (?, 'TWI-71', 'uuid-71', 'test-project', 'DEVELOPING')`,
    ).run(runId);

    const result = db.prepare(
      "UPDATE pipeline_runs SET state = 'RECEIVED', updated_at = datetime('now') WHERE id = ? AND state = 'FAILED'",
    ).run(runId);

    assert.strictEqual(result.changes, 0);

    const run = db
      .prepare("SELECT state FROM pipeline_runs WHERE id = ?")
      .get(runId) as { state: string };
    assert.strictEqual(run.state, "DEVELOPING");
  });
});
