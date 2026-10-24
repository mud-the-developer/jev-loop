export const OPERATOR_APPROVAL_TIMEOUT_MS = 60 * 60_000;
export const OPERATOR_EXECUTION_TIMEOUT_MS = 15 * 60_000;

export function operatorExecutionDeadline(hardDeadline: number, approvedAt: number): number {
  return Math.min(hardDeadline, approvedAt + OPERATOR_EXECUTION_TIMEOUT_MS);
}
