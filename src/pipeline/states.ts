export const PipelineState = {
  RECEIVED: "RECEIVED",
  WORKTREE_SETUP: "WORKTREE_SETUP",
  DEVELOPING: "DEVELOPING",
  DEV_COMPLETE: "DEV_COMPLETE",
  REVIEWING: "REVIEWING",
  REVIEW_DECIDED: "REVIEW_DECIDED",
  TESTING: "TESTING",
  TEST_DECIDED: "TEST_DECIDED",
  DEPLOYING: "DEPLOYING",
  VERIFYING: "VERIFYING",
  AWAITING_MERGE: "AWAITING_MERGE",
  MERGED: "MERGED",
  CLEANUP: "CLEANUP",
  DONE: "DONE",
  FAILED: "FAILED",
} as const;

export type PipelineState = (typeof PipelineState)[keyof typeof PipelineState];

export const TRANSITIONS: Record<string, PipelineState[]> = {
  [PipelineState.RECEIVED]: [PipelineState.WORKTREE_SETUP],
  [PipelineState.WORKTREE_SETUP]: [PipelineState.DEVELOPING],
  [PipelineState.DEVELOPING]: [PipelineState.DEV_COMPLETE],
  [PipelineState.DEV_COMPLETE]: [PipelineState.REVIEWING],
  [PipelineState.REVIEWING]: [PipelineState.REVIEW_DECIDED],
  [PipelineState.REVIEW_DECIDED]: [
    PipelineState.TESTING,
    PipelineState.DEVELOPING,
  ],
  [PipelineState.TESTING]: [PipelineState.TEST_DECIDED],
  [PipelineState.TEST_DECIDED]: [
    PipelineState.DEPLOYING,
    PipelineState.FAILED,
  ],
  [PipelineState.DEPLOYING]: [PipelineState.VERIFYING, PipelineState.FAILED],
  [PipelineState.VERIFYING]: [PipelineState.AWAITING_MERGE, PipelineState.FAILED],
  [PipelineState.AWAITING_MERGE]: [PipelineState.MERGED],
  [PipelineState.MERGED]: [PipelineState.CLEANUP],
  [PipelineState.CLEANUP]: [PipelineState.DONE],
};

export const TaskStage = {
  DEVELOP: "develop",
  REVIEW: "review",
  TEST: "test",
  DEPLOY: "deploy",
} as const;

export type TaskStage = (typeof TaskStage)[keyof typeof TaskStage];

export const TeamRole = {
  DEVELOPER: "developer",
  REVIEWER: "reviewer",
  TESTER: "tester",
  DEVOPS: "devops",
} as const;

export type TeamRole = (typeof TeamRole)[keyof typeof TeamRole];

export function canTransition(
  from: PipelineState,
  to: PipelineState,
): boolean {
  const allowed = TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}
