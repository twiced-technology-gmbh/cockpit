import { config } from "../config.js";
import type { TeamGateway } from "../config.js";
import type { TeamConfig, ProjectRepo } from "../config.js";
import { sshExec } from "./ssh.js";

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export async function ensureRepoCloned(
  gateway: TeamGateway,
  project: string,
  repo: ProjectRepo,
): Promise<void> {
  const repoDir = `${config.workspaceBaseDir}/${shellEscape(project)}/${shellEscape(repo.path)}`;
  await sshExec(
    gateway,
    `test -d ${repoDir}/.git || git clone ${shellEscape(repo.repoUrl)} ${repoDir}`,
  );
}

export async function createWorktree(
  gateway: TeamGateway,
  teamConfig: TeamConfig,
  issueId: string,
  branch: string,
): Promise<{ branch: string; worktreePath: string }> {
  const repoDir = `${config.repoBaseDir}/${shellEscape(teamConfig.project)}`;
  const worktreePath = `${config.worktreeBaseDir}/${shellEscape(teamConfig.project)}/${shellEscape(branch)}`;

  const commands = [
    `cd ${repoDir} && git fetch origin`,
    `cd ${repoDir} && git worktree add ${worktreePath} -b ${shellEscape(branch)} origin/${shellEscape(teamConfig.defaultBranch)}`,
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
  const repoDir = `${config.workspaceBaseDir}/${shellEscape(project)}/${shellEscape(repo.path)}`;
  const worktreePath = `${config.worktreeBaseDir}/${shellEscape(project)}/${shellEscape(branch)}/${shellEscape(repo.path)}`;

  const commands = [
    `cd ${repoDir} && git fetch origin`,
    `cd ${repoDir} && git worktree add ${worktreePath} -b ${shellEscape(branch)} origin/${shellEscape(repo.defaultBranch)}`,
  ].join(" && ");

  await sshExec(gateway, commands);

  return worktreePath;
}

export async function removeWorktree(
  gateway: TeamGateway,
  teamConfig: TeamConfig,
  worktreePath: string,
): Promise<void> {
  const repoDir = `${config.repoBaseDir}/${shellEscape(teamConfig.project)}`;
  await sshExec(
    gateway,
    `cd ${repoDir} && git worktree remove ${shellEscape(worktreePath)} --force`,
  );
}

export async function removeWorktrees(
  gateway: TeamGateway,
  project: string,
  repos: ProjectRepo[],
  branch: string,
): Promise<void> {
  await Promise.all(repos.map((repo) => {
    const repoDir = `${config.workspaceBaseDir}/${shellEscape(project)}/${shellEscape(repo.path)}`;
    const worktreePath = `${config.worktreeBaseDir}/${shellEscape(project)}/${shellEscape(branch)}/${shellEscape(repo.path)}`;
    return sshExec(
      gateway,
      `cd ${repoDir} && git worktree remove ${worktreePath} --force 2>/dev/null || true`,
    );
  }));
}
