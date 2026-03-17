import type Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { PipelineState } from "./states.js";
import { transitionHandlers, type PipelineRun } from "./transitions.js";

export function advanceRun(
  db: Database.Database,
  runId: string,
): void {
  const row = db
    .prepare("SELECT state FROM pipeline_runs WHERE id = ?")
    .get(runId) as { state: string } | undefined;

  if (!row) {
    console.error(`[runner] Run not found: ${runId}`);
    return;
  }

  const state = row.state as PipelineState;

  if (state === PipelineState.DONE || state === PipelineState.FAILED) {
    console.log(`[runner] Run ${runId} is terminal (${state}), skipping`);
    return;
  }

  const handler = transitionHandlers[state];
  if (!handler) {
    console.error(`[runner] No handler for state: ${state}`);
    return;
  }

  handler(db, runId).catch((err) => {
    console.error(`[runner] Error advancing run ${runId} from ${state}:`, err);
  });
}

function parseReviewFindings(
  output: string,
): Array<{
  severity: string;
  filePath: string | null;
  lineNumber: number | null;
  description: string;
}> {
  try {
    const jsonMatch = output.match(/\{[\s\S]*"findings"[\s\S]*\}/);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed.findings)) return [];
    return parsed.findings.map(
      (f: Record<string, unknown>) => ({
        severity: (f.severity as string) || "medium",
        filePath: (f.filePath as string) || null,
        lineNumber:
          typeof f.lineNumber === "number" ? f.lineNumber : null,
        description: (f.description as string) || "No description",
      }),
    );
  } catch {
    return [];
  }
}

export function completeAgentTask(
  db: Database.Database,
  taskId: string,
  result: "success" | "failure",
  output?: string,
): void {
  const task = db
    .prepare("SELECT run_id, stage, focus FROM agent_tasks WHERE id = ?")
    .get(taskId) as { run_id: string; stage: string; focus: string | null } | undefined;

  if (!task) {
    console.error(`[runner] Agent task not found: ${taskId}`);
    return;
  }

  db.prepare(
    "UPDATE agent_tasks SET status = 'completed', result = ?, output = ?, completed_at = datetime('now') WHERE id = ?",
  ).run(result, output ?? null, taskId);

  const run = db
    .prepare("SELECT * FROM pipeline_runs WHERE id = ?")
    .get(task.run_id) as Record<string, unknown>;

  if (!run) return;

  const state = run.state as PipelineState;

  if (state === PipelineState.DEVELOPING && task.stage === "develop") {
    if (result === "success") {
      db.prepare(
        "UPDATE pipeline_runs SET state = ?, updated_at = datetime('now') WHERE id = ? AND state = ?",
      ).run(PipelineState.DEV_COMPLETE, task.run_id, PipelineState.DEVELOPING);
      console.log(
        `[runner] ${task.run_id} DEVELOPING → DEV_COMPLETE (agent task completed)`,
      );
      advanceRun(db, task.run_id);
    } else {
      db.prepare(
        "UPDATE pipeline_runs SET state = ?, updated_at = datetime('now') WHERE id = ? AND state = ?",
      ).run(PipelineState.FAILED, task.run_id, PipelineState.DEVELOPING);
      console.log(
        `[runner] ${task.run_id} DEVELOPING → FAILED (agent task failed)`,
      );
    }
  } else if (state === PipelineState.REVIEWING && task.stage === "review") {
    if (output) {
      const findings = parseReviewFindings(output);
      for (const finding of findings) {
        db.prepare(
          `INSERT INTO review_findings (id, agent_task_id, run_id, severity, file_path, line_number, description)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          nanoid(),
          taskId,
          task.run_id,
          finding.severity,
          finding.filePath,
          finding.lineNumber,
          finding.description,
        );
      }
    }

    const pending = db
      .prepare(
        "SELECT COUNT(*) as count FROM agent_tasks WHERE run_id = ? AND stage = 'review' AND status = 'running'",
      )
      .get(task.run_id) as { count: number };

    if (pending.count === 0) {
      db.prepare(
        "UPDATE pipeline_runs SET state = ?, updated_at = datetime('now') WHERE id = ? AND state = ?",
      ).run(PipelineState.REVIEW_DECIDED, task.run_id, PipelineState.REVIEWING);
      console.log(
        `[runner] ${task.run_id} REVIEWING → REVIEW_DECIDED (all review tasks completed)`,
      );
      advanceRun(db, task.run_id);
    }
  } else if (state === PipelineState.TESTING && task.stage === "test") {
    const pending = db
      .prepare(
        "SELECT COUNT(*) as count FROM agent_tasks WHERE run_id = ? AND stage = 'test' AND status = 'running'",
      )
      .get(task.run_id) as { count: number };

    if (pending.count === 0) {
      db.prepare(
        "UPDATE pipeline_runs SET state = ?, updated_at = datetime('now') WHERE id = ? AND state = ?",
      ).run(PipelineState.TEST_DECIDED, task.run_id, PipelineState.TESTING);
      console.log(
        `[runner] ${task.run_id} TESTING → TEST_DECIDED (all test tasks completed)`,
      );
      advanceRun(db, task.run_id);
    }
  } else if (state === PipelineState.DEPLOYING && task.stage === "deploy") {
    if (result === "success") {
      db.prepare(
        "UPDATE pipeline_runs SET state = ?, updated_at = datetime('now') WHERE id = ? AND state = ?",
      ).run(PipelineState.VERIFYING, task.run_id, PipelineState.DEPLOYING);
      console.log(
        `[runner] ${task.run_id} DEPLOYING → VERIFYING (deploy task completed)`,
      );
      advanceRun(db, task.run_id);
    } else {
      db.prepare(
        "UPDATE pipeline_runs SET state = ?, updated_at = datetime('now') WHERE id = ? AND state = ?",
      ).run(PipelineState.FAILED, task.run_id, PipelineState.DEPLOYING);
      console.log(
        `[runner] ${task.run_id} DEPLOYING → FAILED (deploy task failed)`,
      );
    }
  }
}
