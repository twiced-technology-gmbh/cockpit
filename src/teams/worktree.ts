import type { TeamGateway } from "../config.js";
import type { TeamConfig } from "../config.js";
import { sshExec } from "./ssh.js";

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
