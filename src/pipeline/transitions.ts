import type Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { PipelineState, canTransition } from "./states.js";
import { getTeamConfig, getTeamGateway, getProjectRepos } from "../config.js";
import { createWorktree, removeWorktree, ensureRepoCloned, createRepoWorktree } from "../teams/worktree.js";
import { createSession } from "../teams/gateway-client.js";
import { getTmuxSessionUrl } from "../teams/tmux.js";
import { postComment } from "../integrations/linear.js";
import {
  createPullRequest,
  getPullRequestStatus,
  mergePullRequest,
  parsePrNumber,
} from "../integrations/github.js";
import {
  aggregateReviewResults,
  getFailingFocuses,
  formatFindingsMarkdown,
} from "../review/aggregator.js";

export interface PipelineRun {
  id: string;
  issueId: string;
  issueUuid: string;
  project: string;
  state: PipelineState;
  branch: string | null;
  worktreePath: string | null;
  prUrl: string | null;
  failingFocuses: string[] | null;
  parentRunId: string | null;
  depth: number;
  createdAt: string;
  updatedAt: string;
}

function getRun(db: Database.Database, runId: string): PipelineRun {
  const row = db
    .prepare("SELECT * FROM pipeline_runs WHERE id = ?")
    .get(runId) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`Pipeline run not found: ${runId}`);
  const rawFocuses = row.failing_focuses as string | null;
  return {
    id: row.id as string,
    issueId: row.issue_id as string,
    issueUuid: row.issue_uuid as string,
    project: row.project as string,
    state: row.state as PipelineState,
    branch: row.branch as string | null,
    worktreePath: row.worktree_path as string | null,
    prUrl: row.pr_url as string | null,
    failingFocuses: rawFocuses ? JSON.parse(rawFocuses) : null,
    parentRunId: row.parent_run_id as string | null,
    depth: row.depth as number,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

const ALLOWED_UPDATE_COLUMNS = new Set([
  "branch",
  "worktree_path",
  "pr_url",
  "failing_focuses",
]);

function setState(
  db: Database.Database,
  runId: string,
  from: PipelineState,
  to: PipelineState,
  updates?: Record<string, unknown>,
): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid transition: ${from} → ${to}`);
  }

  const setClauses = ["state = ?", "updated_at = datetime('now')"];
  const params: unknown[] = [to];

  if (updates) {
    for (const [col, val] of Object.entries(updates)) {
      if (!ALLOWED_UPDATE_COLUMNS.has(col)) {
        throw new Error(`Disallowed column in setState updates: ${col}`);
      }
      setClauses.push(`${col} = ?`);
      params.push(val);
    }
  }

  params.push(runId, from);
  const result = db
    .prepare(
      `UPDATE pipeline_runs SET ${setClauses.join(", ")} WHERE id = ? AND state = ?`,
    )
    .run(...params);

  if (result.changes === 0) {
    throw new Error(
      `State transition failed (concurrent update?): ${runId} ${from} → ${to}`,
    );
  }

  console.log(`[pipeline] ${runId} ${from} → ${to}`);
}

export async function handleReceived(
  db: Database.Database,
  runId: string,
): Promise<void> {
  setState(db, runId, PipelineState.RECEIVED, PipelineState.WORKTREE_SETUP);
  await handleWorktreeSetup(db, runId);
}

export async function handleWorktreeSetup(
  db: Database.Database,
  runId: string,
): Promise<void> {
  const run = getRun(db, runId);
  const teamConfig = getTeamConfig(db, run.project);
  if (!teamConfig) throw new Error(`No team config for project: ${run.project}`);

  const gateway = getTeamGateway(db, "developer");
  if (!gateway) throw new Error("No developer gateway configured");

  const branch = `${run.issueId.toLowerCase()}`;
  const primaryRepos = teamConfig.repos.filter((r) => r.isPrimary);

  let worktreePath: string;

  if (primaryRepos.length > 0) {
    for (const repo of primaryRepos) {
      await ensureRepoCloned(gateway, run.project, repo);
      await createRepoWorktree(gateway, run.project, repo, branch);
    }
    worktreePath = `~/worktrees/${run.project}/${branch}`;
  } else {
    const result = await createWorktree(
      gateway,
      teamConfig,
      run.issueId,
      branch,
    );
    worktreePath = result.worktreePath;
  }

  setState(
    db,
    runId,
    PipelineState.WORKTREE_SETUP,
    PipelineState.DEVELOPING,
    { branch, worktree_path: worktreePath },
  );
  await handleDeveloping(db, runId);
}

export async function handleDeveloping(
  db: Database.Database,
  runId: string,
): Promise<void> {
  const run = getRun(db, runId);
  const gateway = getTeamGateway(db, "developer");
  if (!gateway) throw new Error("No developer gateway configured");

  const taskId = nanoid();
  db.prepare(
    `INSERT INTO agent_tasks (id, run_id, team, stage, model, status, started_at)
     VALUES (?, ?, 'developer', 'develop', 'claude-code', 'running', datetime('now'))`,
  ).run(taskId, runId);

  try {
    const tmuxSession = `${run.issueId}-dev-claude`.toLowerCase();
    const session = await createSession(gateway, {
      agent: "developer",
      workspace: run.project,
      prompt: `Work on issue ${run.issueId}. Branch: ${run.branch}. Worktree: ${run.worktreePath}.`,
      branch: run.branch ?? undefined,
    });

    db.prepare(
      "UPDATE agent_tasks SET tmux_session = ? WHERE id = ?",
    ).run(session.sessionId, taskId);

    const watchUrl = getTmuxSessionUrl(gateway, tmuxSession);
    await postComment(
      run.issueUuid,
      `Development started. Watch: ${watchUrl}`,
    ).catch((err) =>
      console.error(`[pipeline] Failed to post Linear comment: ${err}`),
    );
  } catch (err) {
    db.prepare(
      "UPDATE agent_tasks SET status = 'failed', result = ?, completed_at = datetime('now') WHERE id = ?",
    ).run(String(err), taskId);
    throw err;
  }
}

export async function handleDevComplete(
  db: Database.Database,
  runId: string,
): Promise<void> {
  const run = getRun(db, runId);
  const teamConfig = getTeamConfig(db, run.project);
  if (!teamConfig) throw new Error(`No team config for project: ${run.project}`);

  if (!run.branch) throw new Error(`Run ${runId} has no branch set`);

  let prUrl = run.prUrl;
  if (!prUrl) {
    const pr = await createPullRequest(
      teamConfig.repoUrl,
      run.branch,
      teamConfig.defaultBranch,
      `${run.issueId}: ${run.branch}`,
      `Automated PR for ${run.issueId}`,
    );
    prUrl = pr.url;

    await postComment(
      run.issueUuid,
      `Pull request created: [${run.issueId}](${prUrl})`,
    ).catch((err) =>
      console.error(`[pipeline] Failed to post PR comment: ${err}`),
    );
  }

  setState(db, runId, PipelineState.DEV_COMPLETE, PipelineState.REVIEWING, {
    pr_url: prUrl,
  });
  await handleReviewing(db, runId);
}

export async function handleReviewing(
  db: Database.Database,
  runId: string,
): Promise<void> {
  const run = getRun(db, runId);
  const teamConfig = getTeamConfig(db, run.project);
  if (!teamConfig) throw new Error(`No team config for project: ${run.project}`);

  const reviewerGateway = getTeamGateway(db, "reviewer");
  if (!reviewerGateway) throw new Error("No reviewer gateway configured");

  const reviewConfig = teamConfig.reviewConfig;
  const models = reviewConfig.models ?? ["claude"];
  const agentMap = reviewConfig.agents ?? {};

  const focusesToReview = run.failingFocuses ?? reviewConfig.focuses;

  const reviewerTasks: Array<{
    taskId: string;
    focus: string;
    model: string;
    agentName: string;
    tmuxSession: string;
  }> = [];

  for (const focus of focusesToReview) {
    for (const model of models) {
      const agentKey = `${focus}-${model}`;
      const agentName = agentMap[agentKey] ?? `rev-${focus}-${model}`;
      const tmuxSession = `${run.issueId}-${agentName}`.toLowerCase();
      const taskId = nanoid();

      db.prepare(
        `INSERT INTO agent_tasks (id, run_id, team, stage, focus, model, status, started_at)
         VALUES (?, ?, 'reviewer', 'review', ?, ?, 'running', datetime('now'))`,
      ).run(taskId, runId, focus, model);

      reviewerTasks.push({ taskId, focus, model, agentName, tmuxSession });
    }
  }

  const results = await Promise.allSettled(
    reviewerTasks.map(async ({ taskId, focus, model, agentName, tmuxSession }) => {
      const session = await createSession(reviewerGateway, {
        agent: agentName,
        workspace: run.project,
        prompt: [
          `Review issue ${run.issueId} with focus on ${focus}.`,
          `Branch: ${run.branch}. Worktree: ${run.worktreePath}.`,
          run.prUrl ? `PR: ${run.prUrl}.` : "",
          `Output your findings as JSON: { "findings": [{ "severity": "critical"|"high"|"medium"|"low", "filePath": "...", "lineNumber": N, "description": "..." }] }`,
        ]
          .filter(Boolean)
          .join(" "),
        branch: run.branch ?? undefined,
      });

      db.prepare(
        "UPDATE agent_tasks SET tmux_session = ? WHERE id = ?",
      ).run(session.sessionId, taskId);

      const watchUrl = getTmuxSessionUrl(reviewerGateway, tmuxSession);
      return `- **${focus}** (${model}): [Watch](${watchUrl})`;
    }),
  );

  const spawnedReviewers: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled") {
      spawnedReviewers.push(result.value);
    } else {
      const { taskId, agentName } = reviewerTasks[i];
      db.prepare(
        "UPDATE agent_tasks SET status = 'failed', result = ?, completed_at = datetime('now') WHERE id = ?",
      ).run(String(result.reason), taskId);
      console.error(`[pipeline] Failed to spawn reviewer ${agentName}: ${result.reason}`);
    }
  }

  if (spawnedReviewers.length > 0) {
    await postComment(
      run.issueUuid,
      `Review started (${spawnedReviewers.length} reviewers):\n${spawnedReviewers.join("\n")}`,
    ).catch((err) =>
      console.error(`[pipeline] Failed to post review comment: ${err}`),
    );
  }

  // Do NOT advance — wait for all review tasks to complete via completeAgentTask
}

export async function handleReviewDecided(
  db: Database.Database,
  runId: string,
): Promise<void> {
  const run = getRun(db, runId);
  const { decision, findings } = aggregateReviewResults(db, runId);

  if (decision === "approved") {
    const summary =
      findings.length > 0
        ? `Review approved with ${findings.length} finding(s) (none blocking).`
        : "Review approved — no findings.";

    await postComment(run.issueUuid, summary).catch((err) =>
      console.error(`[pipeline] Failed to post approval comment: ${err}`),
    );

    setState(db, runId, PipelineState.REVIEW_DECIDED, PipelineState.TESTING, {
      failing_focuses: null,
    });
    await handleTesting(db, runId);
  } else {
    const failingFocuses = getFailingFocuses(db, runId);
    const markdown = formatFindingsMarkdown(findings);

    await postComment(
      run.issueUuid,
      `Review requested changes.\n\n**Failing focuses**: ${failingFocuses.join(", ")}\n\n${markdown}`,
    ).catch((err) =>
      console.error(`[pipeline] Failed to post review findings: ${err}`),
    );

    setState(
      db,
      runId,
      PipelineState.REVIEW_DECIDED,
      PipelineState.DEVELOPING,
      { failing_focuses: JSON.stringify(failingFocuses) },
    );
    await handleDeveloping(db, runId);
  }
}

export async function handleTesting(
  db: Database.Database,
  runId: string,
): Promise<void> {
  const run = getRun(db, runId);
  const teamConfig = getTeamConfig(db, run.project);
  if (!teamConfig) throw new Error(`No team config for project: ${run.project}`);

  const testerGateway = getTeamGateway(db, "tester");
  if (!testerGateway) throw new Error("No tester gateway configured");

  const testAgents: Array<{ name: string; model: string }> = [
    { name: "test-pw-claude", model: "claude" },
    { name: "test-gemini", model: "gemini" },
  ];

  const testerTasks: Array<{
    taskId: string;
    name: string;
    model: string;
    tmuxSession: string;
  }> = [];

  for (const agent of testAgents) {
    const tmuxSession = `${run.issueId}-${agent.name}`.toLowerCase();
    const taskId = nanoid();
    db.prepare(
      `INSERT INTO agent_tasks (id, run_id, team, stage, model, status, started_at)
       VALUES (?, ?, 'tester', 'test', ?, 'running', datetime('now'))`,
    ).run(taskId, runId, agent.model);

    testerTasks.push({ taskId, name: agent.name, model: agent.model, tmuxSession });
  }

  const results = await Promise.allSettled(
    testerTasks.map(async ({ taskId, name, model, tmuxSession }) => {
      const session = await createSession(testerGateway, {
        agent: name,
        workspace: run.project,
        prompt: [
          `Test issue ${run.issueId}.`,
          `Branch: ${run.branch}. Worktree: ${run.worktreePath}.`,
          run.prUrl ? `PR: ${run.prUrl}.` : "",
          "Run the test suite and report results.",
        ]
          .filter(Boolean)
          .join(" "),
        branch: run.branch ?? undefined,
      });

      db.prepare(
        "UPDATE agent_tasks SET tmux_session = ? WHERE id = ?",
      ).run(session.sessionId, taskId);

      const watchUrl = getTmuxSessionUrl(testerGateway, tmuxSession);
      return `- **${name}** (${model}): [Watch](${watchUrl})`;
    }),
  );

  const spawnedTesters: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled") {
      spawnedTesters.push(result.value);
    } else {
      const { taskId, name } = testerTasks[i];
      db.prepare(
        "UPDATE agent_tasks SET status = 'failed', result = ?, completed_at = datetime('now') WHERE id = ?",
      ).run(String(result.reason), taskId);
      console.error(`[pipeline] Failed to spawn tester ${name}: ${result.reason}`);
    }
  }

  if (spawnedTesters.length > 0) {
    await postComment(
      run.issueUuid,
      `Testing started (${spawnedTesters.length} testers):\n${spawnedTesters.join("\n")}`,
    ).catch((err) =>
      console.error(`[pipeline] Failed to post test comment: ${err}`),
    );
  }

  // Do NOT advance — wait for all test tasks to complete via completeAgentTask
}

export async function handleTestDecided(
  db: Database.Database,
  runId: string,
): Promise<void> {
  const run = getRun(db, runId);

  const testTasks = db
    .prepare(
      "SELECT id, result, output FROM agent_tasks WHERE run_id = ? AND stage = 'test'",
    )
    .all(runId) as Array<{ id: string; result: string; output: string | null }>;

  const passed = testTasks.filter((t) => t.result === "success");
  const failed = testTasks.filter((t) => t.result !== "success");

  if (failed.length === 0) {
    await postComment(
      run.issueUuid,
      `All tests passed (${passed.length}/${testTasks.length}).`,
    ).catch((err) =>
      console.error(`[pipeline] Failed to post test summary: ${err}`),
    );

    setState(db, runId, PipelineState.TEST_DECIDED, PipelineState.DEPLOYING);
    await handleDeploying(db, runId);
  } else if (run.depth >= 2) {
    const failureDetails = failed
      .map((t) => `- Task ${t.id}: ${t.output ?? "no output"}`)
      .join("\n");

    await postComment(
      run.issueUuid,
      `Test failures at max depth (${run.depth}) — human intervention needed.\n\n${failureDetails}`,
    ).catch((err) =>
      console.error(`[pipeline] Failed to post max-depth comment: ${err}`),
    );

    setState(db, runId, PipelineState.TEST_DECIDED, PipelineState.FAILED);
  } else {
    const failureDetails = failed
      .map((t) => `- Task ${t.id}: ${t.output ?? "no output"}`)
      .join("\n");

    await postComment(
      run.issueUuid,
      `Tests failed (${failed.length}/${testTasks.length}). Creating sub-ticket for fixes (depth ${run.depth + 1}).\n\n${failureDetails}`,
    ).catch((err) =>
      console.error(`[pipeline] Failed to post sub-ticket comment: ${err}`),
    );

    const subRunId = nanoid();
    db.prepare(
      `INSERT INTO pipeline_runs (id, issue_id, issue_uuid, project, state, branch, worktree_path, pr_url, parent_run_id, depth)
       VALUES (?, ?, ?, ?, 'RECEIVED', ?, ?, ?, ?, ?)`,
    ).run(
      subRunId,
      run.issueId,
      run.issueUuid,
      run.project,
      run.branch,
      run.worktreePath,
      run.prUrl,
      runId,
      run.depth + 1,
    );

    setState(db, runId, PipelineState.TEST_DECIDED, PipelineState.FAILED);

    // Dynamic import to break circular dependency (runner → transitions → runner)
    const { advanceRun } = await import("./runner.js");
    advanceRun(db, subRunId);
  }
}

export async function handleDeploying(
  db: Database.Database,
  runId: string,
): Promise<void> {
  const run = getRun(db, runId);

  const devopsGateway = getTeamGateway(db, "devops");
  if (!devopsGateway) throw new Error("No devops gateway configured");

  const tmuxSession = `${run.issueId}-deployer-claude`.toLowerCase();
  const taskId = nanoid();
  db.prepare(
    `INSERT INTO agent_tasks (id, run_id, team, stage, model, status, started_at)
     VALUES (?, ?, 'devops', 'deploy', 'claude', 'running', datetime('now'))`,
  ).run(taskId, runId);

  try {
    const session = await createSession(devopsGateway, {
      agent: "deployer-claude",
      workspace: run.project,
      prompt: [
        `Deploy issue ${run.issueId}.`,
        `Branch: ${run.branch}.`,
        run.prUrl ? `PR: ${run.prUrl}.` : "",
        "Deploy the changes and verify.",
      ]
        .filter(Boolean)
        .join(" "),
      branch: run.branch ?? undefined,
    });

    db.prepare(
      "UPDATE agent_tasks SET tmux_session = ? WHERE id = ?",
    ).run(session.sessionId, taskId);

    const watchUrl = getTmuxSessionUrl(devopsGateway, tmuxSession);
    await postComment(
      run.issueUuid,
      `Deployment started: [Watch](${watchUrl})`,
    ).catch((err) =>
      console.error(`[pipeline] Failed to post deploy comment: ${err}`),
    );
  } catch (err) {
    db.prepare(
      "UPDATE agent_tasks SET status = 'failed', result = ?, completed_at = datetime('now') WHERE id = ?",
    ).run(String(err), taskId);
    throw err;
  }

  // Do NOT advance — wait for deploy task to complete via completeAgentTask
}

export async function handleVerifying(
  db: Database.Database,
  runId: string,
): Promise<void> {
  const run = getRun(db, runId);
  const teamConfig = getTeamConfig(db, run.project);
  if (!teamConfig) throw new Error(`No team config for project: ${run.project}`);

  if (!run.prUrl) throw new Error(`Run ${runId} has no PR URL for verification`);

  const prNumber = parsePrNumber(run.prUrl);
  const status = await getPullRequestStatus(teamConfig.repoUrl, prNumber);

  if (status.ciStatus === "clean" || status.ciStatus === "unstable") {
    await postComment(
      run.issueUuid,
      `CI verification passed (status: ${status.ciStatus}).`,
    ).catch((err) =>
      console.error(`[pipeline] Failed to post verify comment: ${err}`),
    );

    setState(db, runId, PipelineState.VERIFYING, PipelineState.AWAITING_MERGE);
    await handleAwaitingMerge(db, runId);
  } else {
    await postComment(
      run.issueUuid,
      `CI verification failed (status: ${status.ciStatus}, mergeable: ${status.mergeable}).`,
    ).catch((err) =>
      console.error(`[pipeline] Failed to post verify failure: ${err}`),
    );

    setState(db, runId, PipelineState.VERIFYING, PipelineState.FAILED);
  }
}

export async function handleAwaitingMerge(
  db: Database.Database,
  runId: string,
): Promise<void> {
  const run = getRun(db, runId);
  const teamConfig = getTeamConfig(db, run.project);
  if (!teamConfig) throw new Error(`No team config for project: ${run.project}`);

  if (!run.prUrl) throw new Error(`Run ${runId} has no PR URL for merge`);

  const prNumber = parsePrNumber(run.prUrl);
  await mergePullRequest(teamConfig.repoUrl, prNumber);

  await postComment(
    run.issueUuid,
    `PR #${prNumber} merged successfully.`,
  ).catch((err) =>
    console.error(`[pipeline] Failed to post merge comment: ${err}`),
  );

  setState(db, runId, PipelineState.AWAITING_MERGE, PipelineState.MERGED);
  await handleMerged(db, runId);
}

export async function handleMerged(
  db: Database.Database,
  runId: string,
): Promise<void> {
  const run = getRun(db, runId);

  await postComment(
    run.issueUuid,
    "PR merged successfully.",
  ).catch((err) =>
    console.error(`[pipeline] Failed to post merged comment: ${err}`),
  );

  setState(db, runId, PipelineState.MERGED, PipelineState.CLEANUP);
  await handleCleanup(db, runId);
}

export async function handleCleanup(
  db: Database.Database,
  runId: string,
): Promise<void> {
  const run = getRun(db, runId);
  const teamConfig = getTeamConfig(db, run.project);
  if (!teamConfig) throw new Error(`No team config for project: ${run.project}`);

  if (run.worktreePath) {
    const devGateway = getTeamGateway(db, "developer");
    if (devGateway) {
      try {
        await removeWorktree(devGateway, teamConfig, run.worktreePath);
      } catch (err) {
        console.error(`[pipeline] Failed to remove worktree: ${err}`);
      }
    }
  }

  await postComment(
    run.issueUuid,
    "Pipeline complete — issue resolved.",
  ).catch((err) =>
    console.error(`[pipeline] Failed to post completion comment: ${err}`),
  );

  setState(db, runId, PipelineState.CLEANUP, PipelineState.DONE);
  console.log(`[pipeline] Run ${runId} completed (DONE)`);
}

export const transitionHandlers: Record<
  string,
  (db: Database.Database, runId: string) => Promise<void>
> = {
  [PipelineState.RECEIVED]: handleReceived,
  [PipelineState.WORKTREE_SETUP]: handleWorktreeSetup,
  [PipelineState.DEVELOPING]: handleDeveloping,
  [PipelineState.DEV_COMPLETE]: handleDevComplete,
  [PipelineState.REVIEWING]: handleReviewing,
  [PipelineState.REVIEW_DECIDED]: handleReviewDecided,
  [PipelineState.TESTING]: handleTesting,
  [PipelineState.TEST_DECIDED]: handleTestDecided,
  [PipelineState.DEPLOYING]: handleDeploying,
  [PipelineState.VERIFYING]: handleVerifying,
  [PipelineState.AWAITING_MERGE]: handleAwaitingMerge,
  [PipelineState.MERGED]: handleMerged,
  [PipelineState.CLEANUP]: handleCleanup,
};
