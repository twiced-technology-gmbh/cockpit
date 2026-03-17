import type Database from "better-sqlite3";
import { PipelineState } from "./states.js";
import { postComment } from "../integrations/linear.js";

export interface StuckRun {
  runId: string;
  issueId: string;
  issueUuid: string;
  state: string;
  stuckSinceMinutes: number;
  reason: string;
}

const AGENT_TASK_TIMEOUT_MINUTES = 30;
const FULL_RUN_TIMEOUT_MINUTES = 120;

const AGENT_STATES: Set<string> = new Set([
  PipelineState.DEVELOPING,
  PipelineState.REVIEWING,
  PipelineState.TESTING,
  PipelineState.DEPLOYING,
]);

const TERMINAL_STATES: Set<string> = new Set([
  PipelineState.DONE,
  PipelineState.FAILED,
]);

export function detectStuckRuns(
  db: Database.Database,
  agentTimeoutMinutes = AGENT_TASK_TIMEOUT_MINUTES,
  fullRunTimeoutMinutes = FULL_RUN_TIMEOUT_MINUTES,
): StuckRun[] {
  const stuck: StuckRun[] = [];

  const activeRuns = db
    .prepare(
      `SELECT id, issue_id, issue_uuid, state, updated_at,
              CAST((julianday('now') - julianday(updated_at)) * 24 * 60 AS INTEGER) as minutes_since_update
       FROM pipeline_runs
       WHERE state NOT IN ('DONE', 'FAILED')`,
    )
    .all() as Array<{
    id: string;
    issue_id: string;
    issue_uuid: string;
    state: string;
    updated_at: string;
    minutes_since_update: number;
  }>;

  for (const run of activeRuns) {
    if (run.minutes_since_update >= fullRunTimeoutMinutes) {
      stuck.push({
        runId: run.id,
        issueId: run.issue_id,
        issueUuid: run.issue_uuid,
        state: run.state,
        stuckSinceMinutes: run.minutes_since_update,
        reason: `Run stuck in ${run.state} for ${run.minutes_since_update} minutes (full run timeout: ${fullRunTimeoutMinutes}m)`,
      });
      continue;
    }

    if (AGENT_STATES.has(run.state as PipelineState)) {
      const stuckTasks = db
        .prepare(
          `SELECT id, stage, model,
                  CAST((julianday('now') - julianday(started_at)) * 24 * 60 AS INTEGER) as minutes_running
           FROM agent_tasks
           WHERE run_id = ? AND status = 'running'
             AND CAST((julianday('now') - julianday(started_at)) * 24 * 60 AS INTEGER) >= ?`,
        )
        .all(run.id, agentTimeoutMinutes) as Array<{
        id: string;
        stage: string;
        model: string;
        minutes_running: number;
      }>;

      if (stuckTasks.length > 0) {
        const taskDetails = stuckTasks
          .map((t) => `${t.stage}/${t.model} (${t.minutes_running}m)`)
          .join(", ");
        stuck.push({
          runId: run.id,
          issueId: run.issue_id,
          issueUuid: run.issue_uuid,
          state: run.state,
          stuckSinceMinutes: stuckTasks[0].minutes_running,
          reason: `Agent tasks stuck: ${taskDetails}`,
        });
      }
    }
  }

  return stuck;
}

export async function handleStuckRun(
  db: Database.Database,
  runId: string,
  reason: string,
): Promise<void> {
  const run = db
    .prepare("SELECT issue_uuid, state FROM pipeline_runs WHERE id = ?")
    .get(runId) as { issue_uuid: string; state: string } | undefined;

  if (!run || TERMINAL_STATES.has(run.state as PipelineState)) return;

  db.prepare(
    "UPDATE agent_tasks SET status = 'failed', result = 'timed out', completed_at = datetime('now') WHERE run_id = ? AND status = 'running'",
  ).run(runId);

  db.prepare(
    "UPDATE pipeline_runs SET state = 'FAILED', updated_at = datetime('now') WHERE id = ?",
  ).run(runId);

  console.log(`[stuck-detector] Marked run ${runId} as FAILED: ${reason}`);

  await postComment(
    run.issue_uuid,
    `Pipeline run stuck and marked as FAILED.\n\n**Reason**: ${reason}`,
  ).catch((err) =>
    console.error(`[stuck-detector] Failed to post comment: ${err}`),
  );
}
