CREATE TABLE IF NOT EXISTS team_config (
    project TEXT PRIMARY KEY,
    linear_team_id TEXT NOT NULL,
    repo_url TEXT NOT NULL,
    default_branch TEXT DEFAULT 'main',
    review_config TEXT DEFAULT '{"focuses":["security","quality","fulfillment"]}'
);

CREATE TABLE IF NOT EXISTS team_gateways (
    role TEXT PRIMARY KEY,
    vm_host TEXT NOT NULL,
    gateway_port INTEGER DEFAULT 18789,
    gateway_token TEXT NOT NULL,
    ssh_key_path TEXT NOT NULL,
    ttyd_port INTEGER DEFAULT 7681
);

CREATE TABLE IF NOT EXISTS pipeline_runs (
    id TEXT PRIMARY KEY,
    issue_id TEXT NOT NULL,
    issue_uuid TEXT NOT NULL,
    project TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'RECEIVED',
    branch TEXT,
    worktree_path TEXT,
    pr_url TEXT,
    parent_run_id TEXT,
    depth INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_tasks (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES pipeline_runs(id),
    team TEXT NOT NULL,
    stage TEXT NOT NULL,
    focus TEXT,
    model TEXT NOT NULL,
    tmux_session TEXT,
    status TEXT DEFAULT 'pending',
    result TEXT,
    output TEXT,
    screenshots TEXT,
    started_at TEXT,
    completed_at TEXT
);

CREATE TABLE IF NOT EXISTS review_findings (
    id TEXT PRIMARY KEY,
    agent_task_id TEXT NOT NULL REFERENCES agent_tasks(id),
    run_id TEXT NOT NULL REFERENCES pipeline_runs(id),
    severity TEXT NOT NULL,
    file_path TEXT,
    line_number INTEGER,
    description TEXT NOT NULL,
    resolved INTEGER DEFAULT 0
);
