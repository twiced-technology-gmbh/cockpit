import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TeamGateway } from "../config.js";

const execFileAsync = promisify(execFile);

export async function sshExec(
  gateway: TeamGateway,
  command: string,
): Promise<string> {
  const { stdout } = await execFileAsync("ssh", [
    "-i",
    gateway.sshKeyPath,
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "ConnectTimeout=10",
    `admin@${gateway.vmHost}`,
    command,
  ]);
  return stdout.trim();
}
