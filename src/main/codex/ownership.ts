/**
 * Workstream ownership of live `exec_command` sessions.
 *
 * Ordinary connector calls already crossed the authoritative identity boundary before they
 * reach this module: the model supplied the opaque workstream claim id and the kernel admitted
 * it against one logical workstream. Browser conversation ids/request correlation are therefore
 * irrelevant to process authority. The stable logical workstream groups the work; the rotating
 * claim id fences a superseded owner of that same logical workstream.
 */

export interface ExecOwner {
  workstreamId: string;
  claimId: string;
}

/** Owners, keyed by the process id `exec_command` handed back as `session_id`. */
const owners = new Map<number, ExecOwner | null>();

/** Records the workstream claim that opened a still-running exec session. */
export function noteExecOwner(
  processId: number | null,
  workstreamId: string | null,
  claimId: string | null,
): void {
  if (processId === null) return;
  owners.set(
    processId,
    workstreamId && claimId ? { workstreamId, claimId } : null,
  );
}

/** Drops a session's owner once it can no longer be written to. */
export function forgetExecOwner(processId: number | null): void {
  if (processId === null) return;
  owners.delete(processId);
}

/** The admitted workstream claim that opened this session, or null for an unscoped path. */
export function execOwner(processId: number): ExecOwner | null {
  return owners.get(processId) ?? null;
}

/**
 * Whether this admitted workstream claim may write to `processId`.
 */
export function execOwnershipDenied(
  processId: number,
  workstreamId: string | null,
  claimId: string | null,
): boolean {
  if (!owners.has(processId)) return true;
  const owner = owners.get(processId) ?? null;
  if (owner === null) return workstreamId !== null || claimId !== null;
  return (
    owner.workstreamId !== workstreamId ||
    owner.claimId !== claimId
  );
}
