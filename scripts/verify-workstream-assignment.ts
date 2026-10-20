#!/usr/bin/env -S npx tsx
/**
 * Exercises local controller persistence and the real verifier process in a
 * disposable git repository. Does not contact ChatGPT or the installed daemon.
 */
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { initDurableStore } from "../src/main/durable.js";
import {
  checkpointWorkstreamAssignment, continueWorkstream, decideWorkstreamAssignment,
  reserveWorkstream, restoreWorkstreams, retireWorkstream, startWorkstream,
  workstreamPrompt, workstreamStatus,
} from "../src/main/workstreams.js";
import { assignmentDecisionSchema, type AssignmentDecision } from "../src/main/work-assignment.js";

async function main(): Promise<void> {
  const exec = promisify(execFile);
  const app = path.resolve(__dirname, "..");
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "cos-assignment-check-"));
  const candidate = path.join(scratch, "candidate");
  await fs.mkdir(candidate);
  const git = (...args: string[]) => exec("git", ["-C", candidate, ...args]);
  await git("init", "-q");
  await fs.writeFile(path.join(candidate, "answer"), "42\n");
  await git("add", "answer");
  const tree = (await git("write-tree")).stdout.trim();
  const commit = (await git("-c", "user.name=Verification", "-c", "user.email=verification@example.invalid",
    "commit-tree", tree, "-m", "Independent fixture")).stdout.trim();
  await git("update-ref", "HEAD", commit);

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  process.env.COS_ASSIGNMENT_VERIFIER_PUBLIC_KEY =
    publicKey.export({ type: "spki", format: "pem" }).toString();
  const keyFile = path.join(scratch, "verifier.pem");
  await fs.writeFile(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const run = (...args: string[]) => exec(process.execPath,
    ["--import", "tsx", path.join(app, "scripts/workstream-verifier.ts"), ...args], { cwd: app });
  const snapshot = async () => JSON.parse((await run("snapshot", "--candidate", candidate)).stdout);
  const initial = await snapshot();
  const contractFile = path.join(scratch, "contract.json");
  // An external process checks the actual fixture against its specified answer.
  const oracleFile = path.join(scratch, "expected-answer");
  await fs.writeFile(oracleFile, "42\n");
  const contractBytes = JSON.stringify({
    argv: [process.execPath, "-e",
      "require('node:assert/strict').equal(require('node:fs').readFileSync('answer', 'utf8'), require('node:fs').readFileSync(process.argv[1], 'utf8'))",
      oracleFile],
    environment: {},
    inputs: [{ path: oracleFile, sha256: createHash("sha256").update("42\n").digest("hex") }],
  });
  await fs.writeFile(contractFile, contractBytes);
  const assignment = {
    id: randomUUID(), obligation: "fixture: reproduce the independently specified answer",
    operation: "Run the complete answer contract",
    source: initial,
    acceptance: {
      reference: contractFile, sha256: createHash("sha256").update(contractBytes).digest("hex"),
    },
    dependencyCheck: null,
  };
  const assignmentFile = path.join(scratch, "assignment.json");
  await fs.writeFile(assignmentFile, JSON.stringify(assignment));
  const signed = (input: AssignmentDecision) => {
    const decision = assignmentDecisionSchema.parse(input);
    return { decision, signature: sign(null, Buffer.from(JSON.stringify(decision)), privateKey).toString("base64") };
  };
  const id = "assignment-verification";
  const data = path.join(scratch, "controller");
  initDurableStore(data);
  await restoreWorkstreams();
  assert((await startWorkstream(id, candidate, 0)).ok);
  const decision = { kind: "assign", workstream: id, previousAssignmentId: null, assignment } as const;
  await decideWorkstreamAssignment(id, signed(decision));
  const persisted = async () => JSON.parse(await fs.readFile(path.join(data, "state/workstreams.json"), "utf8")).rows[0];
  assert.deepEqual((await persisted()).assignment.current, assignment);

  // The recorded failure was selecting the same unfinished obligation again.
  // Neither a new assignment nor a fresh controller start may erase it.
  await assert.rejects(decideWorkstreamAssignment(id, signed({
    ...decision, previousAssignmentId: assignment.id,
    assignment: { ...assignment, id: randomUUID(), obligation: "An easier successor" },
  })), /no independent disposition/);
  assert.equal((await reserveWorkstream(id, "Select another issue", "new-chat")).ok, false);
  await assert.rejects(decideWorkstreamAssignment(id, {
    ...signed(decision), signature: Buffer.alloc(64).toString("base64"),
  }), /signature/);
  await assert.rejects(decideWorkstreamAssignment(id, {
    ...signed(decision), decision: { ...decision, assignment: { ...assignment, obligation: "Altered scope" } },
  }), /signature/);

  const checkpoint = {
    assignmentId: assignment.id, operation: "Consume the running contract result", source: initial,
    validation: { process: "verifier-process", log: "/external-verifier/output", source: initial },
  };
  await checkpointWorkstreamAssignment(id, checkpoint);
  assert((await continueWorkstream(id, 1_000_000)).ok);
  assert.deepEqual((await persisted()).assignment.checkpoint, checkpoint);
  const restoredData = path.join(scratch, "restored");
  await fs.mkdir(path.join(restoredData, "state"), { recursive: true });
  await fs.copyFile(path.join(data, "state/workstreams.json"), path.join(restoredData, "state/workstreams.json"));
  initDurableStore(restoredData);
  await restoreWorkstreams();
  const row = workstreamStatus().find((entry) => entry.id === id)!;
  assert.deepEqual(row.assignment?.checkpoint, checkpoint);
  assert(workstreamPrompt(row, "Core").includes(assignment.id));

  const verify = (output: string, contract = contractFile) => run("verify",
    "--assignment", assignmentFile, "--workstream", id, "--contract", contract,
    "--candidate", candidate, "--key", keyFile, "--output", output, "--outcome", "accepted");
  await fs.writeFile(path.join(candidate, "answer"), "wrong\n");
  const failedReceipt = path.join(scratch, "failed.json");
  await assert.rejects(verify(failedReceipt), /Verification failed/);
  await assert.rejects(fs.access(failedReceipt));
  await fs.writeFile(path.join(candidate, "answer"), "42\n");
  const changedContract = path.join(scratch, "changed-contract.json");
  await fs.writeFile(changedContract, JSON.stringify({ argv: [process.execPath, "-e", ""], environment: {} }));
  await assert.rejects(verify(path.join(scratch, "changed.json"), changedContract), /contract changed/);
  const receiptFile = path.join(scratch, "passed.json");
  await verify(receiptFile);
  const receipt = JSON.parse(await fs.readFile(receiptFile, "utf8"));
  const log = await fs.readFile(receipt.decision.evidence.reference);
  assert.equal(receipt.decision.evidence.sha256, createHash("sha256").update(log).digest("hex"));
  await fs.writeFile(oracleFile, "wrong\n");
  await assert.rejects(verify(path.join(scratch, "altered-oracle.json")), /verification input changed/);
  await fs.writeFile(oracleFile, "42\n");

  await checkpointWorkstreamAssignment(id, { ...checkpoint, source: { ...initial, tree: "a".repeat(64) } });
  await assert.rejects(decideWorkstreamAssignment(id, receipt), /snapshot/);
  await checkpointWorkstreamAssignment(id, checkpoint);
  await decideWorkstreamAssignment(id, receipt);
  await assert.rejects(checkpointWorkstreamAssignment(id, checkpoint), /disposed/);
  assert.equal((await retireWorkstream(id)), false);
  assert.equal((await continueWorkstream(id, 2_000_000)).ok, false);
  await decideWorkstreamAssignment(id, signed({
    ...decision, previousAssignmentId: assignment.id,
    assignment: { ...assignment, id: randomUUID(), obligation: "Next independently assigned fixture" },
  }));
  await assert.rejects(decideWorkstreamAssignment(id, receipt), /assigned obligation/);
  const final = JSON.parse(await fs.readFile(path.join(restoredData, "state/workstreams.json"), "utf8")).rows[0];
  assert.equal(final.assignment.history[0].verdict.outcome, "accepted");
  assert.equal(final.assignment.history[0].assignment.id, assignment.id);
  // A real source mutation during a check cannot earn an acceptance receipt.
  const mutationContract = JSON.stringify({
    argv: [process.execPath, "-e", "require('fs').writeFileSync('answer', 'changed during check\\n')"],
    environment: {},
    inputs: [],
  });
  await fs.writeFile(contractFile, mutationContract);
  await fs.writeFile(assignmentFile, JSON.stringify({
    ...assignment, acceptance: {
      reference: contractFile, sha256: createHash("sha256").update(mutationContract).digest("hex"),
    },
  }));
  await assert.rejects(verify(path.join(scratch, "mutated.json")), /Candidate changed/);
  await assert.rejects(fs.access(path.join(scratch, "mutated.json")));
  await fs.writeFile(path.join(candidate, "answer"), "42\n");

  // The dependency check observes an actually absent input, not a worker's label.
  const dependencyContract = JSON.stringify({
    argv: [process.execPath, "-e",
      "require('node:assert/strict').equal(require('node:fs').existsSync('required-input'), false)"],
    environment: {},
    inputs: [],
  });
  await fs.writeFile(contractFile, dependencyContract);
  const dependencyAssignment = {
    ...assignment, id: randomUUID(),
    dependencyCheck: {
      reference: contractFile, sha256: createHash("sha256").update(dependencyContract).digest("hex"),
    },
  };
  const dependencyId = "dependency-verification";
  assert((await startWorkstream(dependencyId, path.join(scratch, "dependent"), 0)).ok);
  await decideWorkstreamAssignment(dependencyId, signed({
    ...decision, workstream: dependencyId, assignment: dependencyAssignment,
  }));
  await fs.writeFile(assignmentFile, JSON.stringify(dependencyAssignment));
  const dependencyReceipt = path.join(scratch, "dependency.json");
  const verifyDependency = (output: string) => run("verify",
    "--assignment", assignmentFile, "--workstream", dependencyId, "--contract", contractFile,
    "--candidate", candidate, "--key", keyFile, "--output", output,
    "--outcome", "dependency", "--blocked-on", "Supply required-input");
  await fs.writeFile(path.join(candidate, "required-input"), "available\n");
  await assert.rejects(verifyDependency(path.join(scratch, "false-dependency.json")), /Verification failed/);
  await fs.rename(path.join(candidate, "required-input"), path.join(scratch, "available-input"));
  await verifyDependency(dependencyReceipt);
  await decideWorkstreamAssignment(dependencyId, JSON.parse(await fs.readFile(dependencyReceipt, "utf8")));
  await assert.rejects(decideWorkstreamAssignment(dependencyId, signed({
    kind: "assign", workstream: dependencyId, previousAssignmentId: dependencyAssignment.id,
    assignment: { ...assignment, id: randomUUID(), obligation: "Unrelated optimization" },
  })), /verified dependency/);
  await decideWorkstreamAssignment(dependencyId, signed({
    kind: "assign", workstream: dependencyId, previousAssignmentId: dependencyAssignment.id,
    assignment: { ...assignment, id: randomUUID(), obligation: "Supply required-input" },
  }));
  const dependent = JSON.parse(await fs.readFile(path.join(restoredData, "state/workstreams.json"), "utf8"))
    .rows.find((entry: { id: string }) => entry.id === dependencyId);
  assert.equal(dependent.assignment.history[0].verdict.outcome, "dependency");
  assert.equal(dependent.assignment.history[0].assignment.id, dependencyAssignment.id);
  process.stdout.write(`PASS: real verifier process, forged/stale/changed-contract rejection, source mutation rejection, durable continuation, accepted and dependency transitions.\nArtifacts: ${scratch}\n`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
