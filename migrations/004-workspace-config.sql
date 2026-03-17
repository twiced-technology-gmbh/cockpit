CREATE TABLE IF NOT EXISTS project_repos (
    project TEXT NOT NULL,
    path TEXT NOT NULL,
    repo_url TEXT NOT NULL,
    is_primary INTEGER DEFAULT 0,
    default_branch TEXT DEFAULT 'main',
    PRIMARY KEY (project, path)
);
