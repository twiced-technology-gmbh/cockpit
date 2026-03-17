import type Database from "better-sqlite3";

export interface ReviewFinding {
  id: string;
  agentTaskId: string;
  runId: string;
  severity: string;
  filePath: string | null;
  lineNumber: number | null;
  description: string;
  resolved: boolean;
}

export type ReviewDecision = "approved" | "changes_requested";

export function aggregateReviewResults(
  db: Database.Database,
  runId: string,
): { decision: ReviewDecision; findings: ReviewFinding[] } {
  const rows = db
    .prepare("SELECT * FROM review_findings WHERE run_id = ?")
    .all(runId) as Record<string, unknown>[];

  const findings: ReviewFinding[] = rows.map((row) => ({
    id: row.id as string,
    agentTaskId: row.agent_task_id as string,
    runId: row.run_id as string,
    severity: row.severity as string,
    filePath: row.file_path as string | null,
    lineNumber: row.line_number as number | null,
    description: row.description as string,
    resolved: (row.resolved as number) === 1,
  }));

  const unresolvedBlockers = findings.filter(
    (f) => !f.resolved && (f.severity === "critical" || f.severity === "high"),
  );

  const decision: ReviewDecision =
    unresolvedBlockers.length > 0 ? "changes_requested" : "approved";

  return { decision, findings };
}

export function getFailingFocuses(
  db: Database.Database,
  runId: string,
): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT at.focus FROM review_findings rf
       JOIN agent_tasks at ON rf.agent_task_id = at.id
       WHERE rf.run_id = ? AND rf.resolved = 0
         AND rf.severity IN ('critical', 'high')
         AND at.focus IS NOT NULL`,
    )
    .all(runId) as { focus: string }[];

  return rows.map((r) => r.focus);
}

export function formatFindingsMarkdown(findings: ReviewFinding[]): string {
  if (findings.length === 0) return "No findings.";

  const blocking = findings.filter(
    (f) => !f.resolved && (f.severity === "critical" || f.severity === "high"),
  );
  const nonBlocking = findings.filter(
    (f) => f.resolved || (f.severity !== "critical" && f.severity !== "high"),
  );

  const lines: string[] = [];

  if (blocking.length > 0) {
    lines.push("### Blocking findings");
    for (const f of blocking) {
      const location = f.filePath
        ? `\`${f.filePath}${f.lineNumber ? `:${f.lineNumber}` : ""}\``
        : "general";
      lines.push(`- **${f.severity}** (${location}): ${f.description}`);
    }
  }

  if (nonBlocking.length > 0) {
    lines.push("### Other findings");
    for (const f of nonBlocking) {
      const location = f.filePath
        ? `\`${f.filePath}${f.lineNumber ? `:${f.lineNumber}` : ""}\``
        : "general";
      lines.push(`- **${f.severity}** (${location}): ${f.description}`);
    }
  }

  return lines.join("\n");
}
