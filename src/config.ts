import type Database from "better-sqlite3";

export interface ProjectRepo {
  path: string;
  repoUrl: string;
  isPrimary: boolean;
  defaultBranch: string;
}

export interface TeamConfig {
  project: string;
  linearTeamId: string;
  repoUrl: string;
  defaultBranch: string;
  reviewConfig: {
    focuses: string[];
    models?: string[];
    agents?: Record<string, string>;
  };
  repos: ProjectRepo[];
  parentProject: string | null;
  slackChannel: string | null;
}

export interface TeamGateway {
  role: string;
  vmHost: string;
  gatewayPort: number;
  gatewayToken: string;
  sshKeyPath: string;
  ttydPort: number;
}

export const config = {
  port: parseInt(process.env.PORT || "3200", 10),
  databasePath: process.env.DATABASE_PATH || "./data/pipeline.db",
  linearApiKey: process.env.LINEAR_API_KEY || "",
  linearWebhookSecret: process.env.LINEAR_WEBHOOK_SECRET || "",
  linearClientId: process.env.LINEAR_CLIENT_ID || "",
  linearClientSecret: process.env.LINEAR_CLIENT_SECRET || "",
  linearOauthToken: process.env.LINEAR_OAUTH_TOKEN || "",
  linearRefreshToken: process.env.LINEAR_REFRESH_TOKEN || "",
  githubToken: process.env.GITHUB_TOKEN || "",
  sshUser: process.env.SSH_USER || "admin",
  workspaceBaseDir: process.env.WORKSPACE_BASE_DIR || "~/workspaces",
  repoBaseDir: process.env.REPO_BASE_DIR || "~/repos",
  worktreeBaseDir: process.env.WORKTREE_BASE_DIR || "~/worktrees",
  defaultGatewayPort: parseInt(process.env.DEFAULT_GATEWAY_PORT || "18789", 10),
  defaultTtydPort: parseInt(process.env.DEFAULT_TTYD_PORT || "7681", 10),
  agentTaskTimeoutMinutes: parseInt(process.env.AGENT_TASK_TIMEOUT_MINUTES || "30", 10),
  fullRunTimeoutMinutes: parseInt(process.env.FULL_RUN_TIMEOUT_MINUTES || "120", 10),
  cleanupRetentionDays: parseInt(process.env.CLEANUP_RETENTION_DAYS || "7", 10),
  periodicIntervalMs: parseInt(process.env.PERIODIC_INTERVAL_MS || "300000", 10),
  sseHeartbeatMs: parseInt(process.env.SSE_HEARTBEAT_MS || "15000", 10),
};

export function getProjectRepos(
  db: Database.Database,
  project: string,
): ProjectRepo[] {
  const rows = db
    .prepare("SELECT * FROM project_repos WHERE project = ?")
    .all(project) as Record<string, unknown>[];
  return rows.map((row) => ({
    path: row.path as string,
    repoUrl: row.repo_url as string,
    isPrimary: (row.is_primary as number) === 1,
    defaultBranch: (row.default_branch as string) || "main",
  }));
}

export function getTeamConfig(
  db: Database.Database,
  project: string,
): TeamConfig | undefined {
  const row = db
    .prepare("SELECT * FROM team_config WHERE project = ?")
    .get(project) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    project: row.project as string,
    linearTeamId: row.linear_team_id as string,
    repoUrl: row.repo_url as string,
    defaultBranch: (row.default_branch as string) || "main",
    reviewConfig: JSON.parse(
      (row.review_config as string) ||
        '{"focuses":["security","quality","fulfillment"]}',
    ),
    repos: getProjectRepos(db, row.project as string),
    parentProject: (row.parent_project as string | null) ?? null,
    slackChannel: (row.slack_channel as string | null) ?? null,
  };
}

export function getTeamGateway(
  db: Database.Database,
  role: string,
): TeamGateway | undefined {
  const row = db
    .prepare("SELECT * FROM team_gateways WHERE role = ?")
    .get(role) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    role: row.role as string,
    vmHost: row.vm_host as string,
    gatewayPort: row.gateway_port as number,
    gatewayToken: row.gateway_token as string,
    sshKeyPath: row.ssh_key_path as string,
    ttydPort: row.ttyd_port as number,
  };
}
