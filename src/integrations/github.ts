import { Octokit } from "@octokit/rest";
import { config } from "../config.js";

let _octokit: Octokit | undefined;

function getOctokit(): Octokit {
  if (!_octokit) {
    _octokit = new Octokit({ auth: config.githubToken });
  }
  return _octokit;
}

function parseRepoUrl(repoUrl: string): { owner: string; repo: string } {
  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/.]+)/);
  if (!match) throw new Error(`Invalid GitHub repo URL: ${repoUrl}`);
  return { owner: match[1], repo: match[2] };
}

export function parsePrNumber(prUrl: string): number {
  const match = prUrl.match(/\/pull\/(\d+)/);
  if (!match) throw new Error(`Cannot parse PR number from: ${prUrl}`);
  return parseInt(match[1], 10);
}

export async function createPullRequest(
  repoUrl: string,
  head: string,
  base: string,
  title: string,
  body: string,
): Promise<{ url: string; number: number }> {
  const octokit = getOctokit();
  const { owner, repo } = parseRepoUrl(repoUrl);
  const { data } = await octokit.pulls.create({
    owner,
    repo,
    head,
    base,
    title,
    body,
  });
  return { url: data.html_url, number: data.number };
}

export async function getPullRequestStatus(
  repoUrl: string,
  prNumber: number,
): Promise<{ mergeable: boolean; ciStatus: string }> {
  const octokit = getOctokit();
  const { owner, repo } = parseRepoUrl(repoUrl);
  const { data } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });
  return {
    mergeable: data.mergeable ?? false,
    ciStatus: data.mergeable_state,
  };
}

export async function mergePullRequest(
  repoUrl: string,
  prNumber: number,
): Promise<void> {
  const octokit = getOctokit();
  const { owner, repo } = parseRepoUrl(repoUrl);
  await octokit.pulls.merge({
    owner,
    repo,
    pull_number: prNumber,
    merge_method: "squash",
  });
}
