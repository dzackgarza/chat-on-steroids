import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";

const text = z.string().trim().min(1).max(8_000);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const sourceSnapshotSchema = z.object({
  revision: z.string().regex(/^[a-f0-9]{40,64}$/),
  tree: digest,
}).strict();
const contractSchema = z.object({ reference: text, sha256: digest }).strict();
export const assignmentSchema = z.object({
  id: z.string().uuid(),
  obligation: text,
  operation: text,
  source: sourceSnapshotSchema,
  acceptance: contractSchema,
  dependencyCheck: contractSchema.nullable(),
}).strict();
export const checkpointSchema = z.object({
  assignmentId: z.string().uuid(),
  operation: text,
  source: sourceSnapshotSchema,
  validation: z.object({
    process: text,
    log: text,
    source: sourceSnapshotSchema,
  }).strict().nullable(),
}).strict();

const verdictSchema = z.object({
  kind: z.literal("verdict"),
  workstream: text,
  assignmentId: z.string().uuid(),
  outcome: z.enum(["accepted", "dependency"]),
  source: sourceSnapshotSchema,
  contractSha256: digest,
  evidence: z.object({ reference: text, sha256: digest }).strict(),
  // A dependency verdict authorizes only this replacement obligation.
  blockedOn: text.nullable(),
}).strict();
export const assignmentDecisionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("assign"),
    workstream: text,
    previousAssignmentId: z.string().uuid().nullable(),
    assignment: assignmentSchema,
  }).strict(),
  verdictSchema,
]);
export const signedAssignmentDecisionSchema = z.object({
  decision: assignmentDecisionSchema,
  signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(256),
}).strict();

export const workAssignmentSchema = z.object({
  current: assignmentSchema,
  checkpoint: checkpointSchema.nullable(),
  verdict: verdictSchema.nullable(),
  // Blocked obligations remain owed after switching to their dependencies.
  history: z.array(z.object({
    assignment: assignmentSchema,
    verdict: verdictSchema,
  }).strict()),
}).strict();
export type WorkAssignment = z.infer<typeof workAssignmentSchema>;
export type AssignmentDecision = z.infer<typeof assignmentDecisionSchema>;
export type AssignmentCheckpoint = z.infer<typeof checkpointSchema>;

export function verifyAssignmentDecision(input: unknown, publicKey: string): AssignmentDecision {
  const envelope = signedAssignmentDecisionSchema.parse(input);
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== "ed25519" ||
      !verify(null, Buffer.from(JSON.stringify(envelope.decision)), key,
        Buffer.from(envelope.signature, "base64"))) {
    throw new Error("Invalid independent verifier signature");
  }
  return envelope.decision;
}

/** These transitions consume verifier decisions, never worker completion claims. */
export function applyAssignmentDecision(
  prior: WorkAssignment | null,
  decision: AssignmentDecision,
): WorkAssignment {
  if (decision.kind === "assign") {
    if (decision.previousAssignmentId !== (prior?.current.id ?? null))
      throw new Error("Stale assignment transition");
    if (prior && !prior.verdict)
      throw new Error("The assigned obligation has no independent disposition");
    if (prior?.verdict?.outcome === "dependency" &&
        decision.assignment.obligation !== prior.verdict.blockedOn)
      throw new Error("Replacement must address the independently verified dependency");
    if (prior && [prior.current.id, ...prior.history.map((entry) => entry.assignment.id)]
      .includes(decision.assignment.id))
      throw new Error("Assignment identifiers cannot be reused");
    return {
      current: decision.assignment,
      checkpoint: null,
      verdict: null,
      history: prior && prior.verdict
        ? [...prior.history, { assignment: prior.current, verdict: prior.verdict }]
        : [],
    };
  }
  if (!prior || prior.current.id !== decision.assignmentId)
    throw new Error("Verdict does not address the assigned obligation");
  if (prior.verdict) throw new Error("Assignment already has a disposition");
  const source = prior.checkpoint?.source ?? prior.current.source;
  if (source.revision !== decision.source.revision || source.tree !== decision.source.tree)
    throw new Error("Verdict does not verify the current candidate snapshot");
  const contract = decision.outcome === "accepted"
    ? prior.current.acceptance : prior.current.dependencyCheck;
  if (!contract || contract.sha256 !== decision.contractSha256)
    throw new Error("Verdict does not use the assigned verification contract");
  if ((decision.outcome === "dependency") !== (decision.blockedOn !== null))
    throw new Error("Dependency verdict must identify the blocking obligation");
  return { ...prior, verdict: decision };
}

export function checkpointAssignment(
  prior: WorkAssignment | null,
  checkpoint: AssignmentCheckpoint,
): WorkAssignment {
  if (!prior || prior.current.id !== checkpoint.assignmentId)
    throw new Error("Checkpoint does not address the assigned obligation");
  if (prior.verdict) throw new Error("A disposed assignment cannot be changed by a worker");
  return { ...prior, checkpoint };
}

export function assignmentPrompt(assignment: WorkAssignment): string {
  const { current, checkpoint, verdict } = assignment;
  return `\nCONTROLLER ASSIGNMENT (persists across turns and conversation replacement):
${JSON.stringify({ assignment: current, checkpoint, verdict })}
Continue this obligation at the recorded operation. Checkpoint fields are worker reports,
not acceptance evidence. Preserve the recorded validation process and its source snapshot.
Do not select another issue or substitute a documentation/diagnostic task.
Only an independently signed disposition permits the controller to replace this assignment.
${verdict ? "The disposition is recorded; await the controller's next assignment." : "A completed chat turn does not complete this obligation."}\n`;
}
