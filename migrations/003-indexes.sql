CREATE INDEX IF NOT EXISTS idx_pipeline_runs_state ON pipeline_runs(state);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_issue_id ON pipeline_runs(issue_id);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_run_id_status ON agent_tasks(run_id, status);
CREATE INDEX IF NOT EXISTS idx_review_findings_run_id ON review_findings(run_id);
