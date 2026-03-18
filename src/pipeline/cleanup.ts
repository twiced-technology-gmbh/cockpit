import type Database from "better-sqlite3";
import { config, getTeamConfig, getTeamGateway } from "../config.js";
import { removeWorktree } from "../teams/worktree.js";
import { listTmuxSessions } from "../teams/tmux.js";

export interface CleanupStats {
  runsByState: Record<string, number>;
  oldCompletedRuns: number;
  activeAgentTasks: number;
}

export function getCleanupStats(db: Database.Database): CleanupStats {
  const stateCounts = db
    .prepare(
      "SELECT state, COUNT(*) as count FROM pipeline_runs GROUP BY state",
    )
    .all() as Array<{ state: string; count: number }>;

  const runsByState: Record<string, number> = {};
  for (const row of stateCounts) {
    runsByState[row.state] = row.count;
  }

  const oldCompleted = db
    .prepare(
      `SELECT COUNT(*) as count FROM pipeline_runs
       WHERE state IN ('DONE', 'FAILED')
         AND updated_at < datetime('now', ? || ' days')`,
    )
    .get(`-${config.cleanupRetentionDays}`) as { count: number };

  const activeTasks = db
    .prepare(
      "SELECT COUNT(*) as count FROM agent_tasks WHERE status = 'running'",
    )
    .get() as { count: number };

  return {
    runsByState,
    oldCompletedRuns: oldCompleted.count,
    activeAgentTasks: activeTasks.count,
  };
}

export async function cleanupCompletedRuns(
  db: Database.Database,
  olderThanDays: number,
): Promise<number> {
  const runsToClean = db
    .prepare(
      `SELECT id, project, worktree_path FROM pipeline_runs
       WHERE state IN ('DONE', 'FAILED')
         AND worktree_path IS NOT NULL
         AND updated_at < datetime('now', ? || ' days')`,
    )
    .all(`-${olderThanDays}`) as Array<{
    id: string;
    project: string;
    worktree_path: string;
  }>;

  const devGateway = getTeamGateway(db, "developer");
  let cleaned = 0;
  const configCache = new Map<string, ReturnType<typeof getTeamConfig>>();
  for (const run of runsToClean) {
    let teamConfig = configCache.get(run.project);
    if (teamConfig === undefined) {
      teamConfig = getTeamConfig(db, run.project);
      configCache.set(run.project, teamConfig);
    }

    if (teamConfig && devGateway) {
      try {
        await removeWorktree(devGateway, teamConfig, run.worktree_path);
        db.prepare(
          "UPDATE pipeline_runs SET worktree_path = NULL WHERE id = ?",
        ).run(run.id);
        cleaned++;
        console.log(
          `[cleanup] Removed worktree for run ${run.id}: ${run.worktree_path}`,
        );
      } catch (err) {
        console.error(
          `[cleanup] Failed to remove worktree for run ${run.id}: ${err}`,
        );
      }
    }
  }

  return cleaned;
}

export async function cleanupStaleTmuxSessions(
  db: Database.Database,
): Promise<number> {
  const roles = ["developer", "reviewer", "tester", "devops"];
  let cleaned = 0;

  const activeSessions = db
    .prepare(
      "SELECT tmux_session FROM agent_tasks WHERE status = 'running' AND tmux_session IS NOT NULL",
    )
    .all() as Array<{ tmux_session: string }>;
  const activeSet = new Set(activeSessions.map((s) => s.tmux_session));

  for (const role of roles) {
    const gateway = getTeamGateway(db, role);
    if (!gateway) continue;

    try {
      const sessions = await listTmuxSessions(gateway);

      for (const session of sessions) {
        if (!activeSet.has(session)) {
          console.log(
            `[cleanup] Stale tmux session on ${gateway.vmHost}: ${session}`,
          );
          cleaned++;
        }
      }
    } catch (err) {
      console.error(
        `[cleanup] Failed to list tmux sessions on ${gateway.vmHost}: ${err}`,
      );
    }
  }

  return cleaned;
}
