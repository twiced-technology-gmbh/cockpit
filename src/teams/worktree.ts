import type { TeamGateway } from "../config.js";
import type { TeamConfig, ProjectRepo } from "../config.js";
import { sshExec } from "./ssh.js";

export async function ensureRepoCloned(
  gateway: TeamGateway,
  project: string,
  repo: ProjectRepo,
): Promise<void> {
  const repoDir = `~/workspaces/${project}/${repo.path}`;
  await sshExec(
    gateway,
    `test -d ${repoDir}/.git || git clone ${repo.repoUrl} ${repoDir}`,
  );
}

export async function createWorktree(
  gateway: TeamGateway,
  teamConfig: TeamConfig,
  issueId: string,
  branch: string,
): Promise<{ branch: string; worktreePath: string }> {
  const repoDir = `~/repos/${teamConfig.project}`;
  const worktreePath = `~/worktrees/${teamConfig.project}/${branch}`;

  const commands = [
    `cd ${repoDir} && git fetch origin`,
    `cd ${repoDir} && git worktree add ${worktreePath} -b ${branch} origin/${teamConfig.defaultBranch}`,
  ].join(" && ");

  await sshExec(gateway, commands);

  return { branch, worktreePath };
}

export async function createRepoWorktree(
  gateway: TeamGateway,
  project: string,
  repo: ProjectRepo,
  branch: string,
): Promise<string> {
  const repoDir = `~/workspaces/${project}/${repo.path}`;
  const worktreePath = `~/worktrees/${project}/${branch}/${repo.path}`;

  const commands = [
    `cd ${repoDir} && git fetch origin`,
    `cd ${repoDir} && git worktree add ${worktreePath} -b ${branch} origin/${repo.defaultBranch}`,
  ].join(" && ");

  await sshExec(gateway, commands);

  return worktreePath;
}

export async function removeWorktree(
  gateway: TeamGateway,
  teamConfig: TeamConfig,
  worktreePath: string,
): Promise<void> {
  const repoDir = `~/repos/${teamConfig.project}`;
  await sshExec(
    gateway,
    `cd ${repoDir} && git worktree remove ${worktreePath} --force`,
  );
}

export async function removeWorktrees(
  gateway: TeamGateway,
  project: string,
  repos: ProjectRepo[],
  branch: string,
): Promise<void> {
  for (const repo of repos) {
    const repoDir = `~/workspaces/${project}/${repo.path}`;
    const worktreePath = `~/worktrees/${project}/${branch}/${repo.path}`;
    await sshExec(
      gateway,
      `cd ${repoDir} && git worktree remove ${worktreePath} --force 2>/dev/null || true`,
    );
  }
}
