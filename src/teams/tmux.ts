import type { TeamGateway } from "../config.js";
import { sshExec } from "./ssh.js";

export function getTmuxSessionUrl(
  gateway: TeamGateway,
  sessionName: string,
): string {
  return `http://${gateway.vmHost}:${gateway.ttydPort}/?arg=${sessionName}`;
}

export async function listTmuxSessions(
  gateway: TeamGateway,
): Promise<string[]> {
  const output = await sshExec(
    gateway,
    "tmux list-sessions -F '#{session_name}' 2>/dev/null || true",
  );
  return output ? output.split("\n").filter(Boolean) : [];
}
