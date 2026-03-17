# Pipeline Controller

Pipeline controller for autonomous AI development. Receives issue webhooks, coordinates coding agents through the full development lifecycle — from implementation through code review, testing, deployment, and merge — across distributed VMs running different AI coding tools.

## Architecture

```
Linear (issue tracker)
  → webhook
Pipeline Controller (this service)
  → dispatches to role-based VMs via OpenClaw gateway API
    → Developer VM (implementation)
    → Reviewer VM (parallel code review with multiple AI models)
    → Tester VM (Playwright + screenshot verification)
    → DevOps VM (deployment + verification)
  → reports results back to Linear
```

### Pipeline States

Each issue goes through a state machine:

```
RECEIVED → WORKTREE_SETUP → DEVELOPING → DEV_COMPLETE → REVIEWING → REVIEW_DECIDED
                                ↑                                        ↓
                                └──── (changes requested) ───────────────┘
                                                                         ↓
                                                                      TESTING → TEST_DECIDED → DEPLOYING → VERIFYING → AWAITING_MERGE → MERGED → CLEANUP → DONE
```

If review requests changes, the run loops back to development with only the failing review focuses. Test failures at depth < 2 create sub-runs; at max depth they fail for human intervention.

### Key Design Decisions

- **Role-based VMs**: Each role (developer, reviewer, tester, devops) runs on a dedicated VM with specialized agents, serving all projects
- **Multi-model review**: Code review spawns multiple agents in parallel (e.g., Claude + Gemini) across different focuses (security, quality, fulfillment)
- **Git worktrees**: Each pipeline run gets its own worktree on the developer VM via SSH, enabling parallel work on multiple issues
- **Stuck detection**: Periodic check marks runs as failed if agent tasks exceed timeout (30 min per task, 2 hours per run)
- **Sub-runs**: Test failures can spawn child runs that retry the fix cycle, up to a configurable depth

## Stack

- **Runtime**: Node.js 22+, TypeScript
- **Framework**: [Hono](https://hono.dev)
- **Database**: SQLite via [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (WAL mode)
- **Issue tracking**: [Linear](https://linear.app) (webhook + SDK)
- **Source control**: GitHub (Octokit)
- **Agent runtime**: [OpenClaw](https://github.com/builderz-labs/openclaw) gateways on each VM
- **VM management**: [Tart](https://github.com/cirruslabs/tart) + [Orchard](https://github.com/cirruslabs/orchard)
- **Networking**: [Tailscale](https://tailscale.com) mesh between all machines

## Setup

```bash
pnpm install
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: `3200`) |
| `DATABASE_PATH` | No | SQLite database path (default: `./pipeline.db`) |
| `LINEAR_API_KEY` | Yes | Linear API key for posting comments |
| `LINEAR_WEBHOOK_SECRET` | No | HMAC secret for verifying Linear webhooks |
| `GITHUB_TOKEN` | Yes | GitHub token for creating PRs and merging |

### Database

The database is auto-created and migrated on first start. Configuration is stored in two tables:

**`team_config`** — per-project settings:
```sql
INSERT INTO team_config (project, linear_team_id, repo_url, default_branch, review_config)
VALUES ('my-project', 'linear-team-uuid', 'https://github.com/org/repo', 'main',
        '{"focuses":["security","quality","fulfillment"],"models":["claude","gemini"]}');
```

**`team_gateways`** — per-role VM endpoints:
```sql
INSERT INTO team_gateways (role, vm_host, gateway_port, gateway_token, ssh_key_path, ttyd_port)
VALUES ('developer', '100.x.x.x', 18789, 'gateway-auth-token', '~/.ssh/dev-key', 7681);
```

## Usage

```bash
# Development
pnpm dev

# Production
pnpm build
pnpm start

# Tests
pnpm test

# Type check
pnpm typecheck
```

## API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/webhook/linear` | Linear webhook endpoint (creates pipeline runs) |
| `GET` | `/api/health` | Health check |
| `GET` | `/api/runs` | List recent pipeline runs |
| `GET` | `/api/runs/:id` | Get run details with agent tasks |
| `POST` | `/api/runs/:id/agent-complete` | Agent reports task completion |
| `POST` | `/api/runs/:id/review-complete` | Agent reports review findings |
| `POST` | `/api/runs/:id/approve-merge` | Manually trigger PR merge |
| `POST` | `/api/runs/:id/retry` | Retry a failed run |
| `GET` | `/api/stats` | Pipeline statistics |
| `GET` | `/api/stuck` | List stuck runs |

## Project Structure

```
src/
  index.ts              # Hono server, API routes, periodic timer
  config.ts             # Environment config, team config/gateway lookups
  db.ts                 # SQLite initialization and migrations
  pipeline/
    states.ts           # State enum and transition rules
    transitions.ts      # State machine handlers (one per state)
    runner.ts           # Run advancement and agent task completion
    stuck-detector.ts   # Stuck run detection and timeout handling
    cleanup.ts          # Worktree and session cleanup
  webhook/
    linear.ts           # Linear webhook handler with HMAC verification
  integrations/
    linear.ts           # Linear SDK wrapper
    github.ts           # GitHub/Octokit wrapper (PRs, merge)
  teams/
    ssh.ts              # Shared SSH execution utility
    gateway-client.ts   # OpenClaw gateway HTTP client
    worktree.ts         # Git worktree management via SSH
    tmux.ts             # tmux session management via SSH
  review/
    aggregator.ts       # Review findings aggregation and decision logic
migrations/
  001-initial.sql       # Core schema
  002-review-support.sql # Review findings support
  003-indexes.sql       # Performance indexes
test/
  state-machine.test.ts # State machine, review, and integration tests
```

## License

[MIT](LICENSE)
