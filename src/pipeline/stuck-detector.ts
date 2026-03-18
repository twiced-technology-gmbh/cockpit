import type Database from "better-sqlite3";
import { config } from "../config.js";
import { PipelineState } from "./states.js";
import { postCommentSafe } from "../integrations/linear.js";

export interface StuckRun {
  runId: string;
  issueId: string;
  issueUuid: string;
  state: string;
  stuckSinceMinutes: number;
  reason: string;
}

const TERMINAL_STATES: Set<string> = new Set([
  PipelineState.DONE,
  PipelineState.FAILED,
]);

export function detectStuckRuns(
  db: Database.Database,
  agentTimeoutMinutes = config.agentTaskTimeoutMinutes,
  fullRunTimeoutMinutes = config.fullRunTimeoutMinutes,
): StuckRun[] {
  const stuck: StuckRun[] = [];

  // Full run timeout: any non-terminal run that hasn't been updated
  const timedOutRuns = db
    .prepare(
      `SELECT id, issue_id, issue_uuid, state,
              CAST((julianday('now') - julianday(updated_at)) * 24 * 60 AS INTEGER) as minutes_since_update
       FROM pipeline_runs
       WHERE state NOT IN ('DONE', 'FAILED')
         AND CAST((julianday('now') - julianday(updated_at)) * 24 * 60 AS INTEGER) >= ?`,
    )
    .all(fullRunTimeoutMinutes) as Array<{
    id: string;
    issue_id: string;
    issue_uuid: string;
    state: string;
    minutes_since_update: number;
  }>;

  const timedOutIds = new Set<string>();
  for (const run of timedOutRuns) {
    timedOutIds.add(run.id);
    stuck.push({
      runId: run.id,
      issueId: run.issue_id,
      issueUuid: run.issue_uuid,
      state: run.state,
      stuckSinceMinutes: run.minutes_since_update,
      reason: `Run stuck in ${run.state} for ${run.minutes_since_update} minutes (full run timeout: ${fullRunTimeoutMinutes}m)`,
    });
  }

  // Agent task timeout: single JOIN query for all agent-state runs with stuck tasks
  const stuckTaskRuns = db
    .prepare(
      `SELECT pr.id, pr.issue_id, pr.issue_uuid, pr.state,
              GROUP_CONCAT(at.stage || '/' || at.model || ' (' ||
                CAST((julianday('now') - julianday(at.started_at)) * 24 * 60 AS INTEGER) || 'm)', ', ') as task_details,
              MIN(CAST((julianday('now') - julianday(at.started_at)) * 24 * 60 AS INTEGER)) as oldest_minutes
       FROM pipeline_runs pr
       JOIN agent_tasks at ON pr.id = at.run_id
       WHERE pr.state IN ('DEVELOPING', 'REVIEWING', 'TESTING', 'DEPLOYING')
         AND pr.state NOT IN ('DONE', 'FAILED')
         AND at.status = 'running'
         AND CAST((julianday('now') - julianday(at.started_at)) * 24 * 60 AS INTEGER) >= ?
       GROUP BY pr.id`,
    )
    .all(agentTimeoutMinutes) as Array<{
    id: string;
    issue_id: string;
    issue_uuid: string;
    state: string;
    task_details: string;
    oldest_minutes: number;
  }>;

  for (const run of stuckTaskRuns) {
    if (timedOutIds.has(run.id)) continue;
    stuck.push({
      runId: run.id,
      issueId: run.issue_id,
      issueUuid: run.issue_uuid,
      state: run.state,
      stuckSinceMinutes: run.oldest_minutes,
      reason: `Agent tasks stuck: ${run.task_details}`,
    });
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

  postCommentSafe(
    run.issue_uuid,
    `Pipeline run stuck and marked as FAILED.\n\n**Reason**: ${reason}`,
  );
}
