#!/usr/bin/env -S npx tsx
/**
 * Run in the independent verifier's environment, with its private key unavailable
 * to implementation workers. The daemon receives only the public key and receipts.
 */
import { createHash, createPrivateKey, sign } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { createWriteStream, promises as fs } from "node:fs";
import { once } from "node:events";
import path from "node:path";
import { promisify, parseArgs } from "node:util";
import { z } from "zod";
import {
  assignmentDecisionSchema, assignmentSchema, type AssignmentDecision,
} from "../src/main/work-assignment.js";

const exec = promisify(execFile);
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

async function snapshot(candidate: string) {
  const git = async (...args: string[]) =>
    (await exec("git", ["-C", candidate, ...args], { maxBuffer: 64 * 1024 * 1024 })).stdout;
  const revision = (await git("rev-parse", "HEAD")).trim();
  const root = (await git("rev-parse", "--show-toplevel")).trim();
  if (await fs.realpath(root) !== candidate) throw new Error("Candidate must be the repository root");
  const files = (await git("ls-files", "--cached", "--others", "--exclude-standard", "-z"))
    .split("\0").filter(Boolean).sort();
  const hash = createHash("sha256").update(revision);
  for (const name of [...new Set(files)]) {
    const file = path.join(candidate, name);
    const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    hash.update(JSON.stringify([name, stat?.mode ?? null]));
    if (!stat) continue;
    if (stat.isSymbolicLink()) hash.update(await fs.readlink(file));
    else if (stat.isFile()) hash.update(sha256(await fs.readFile(file)));
    else throw new Error(`Candidate includes a non-file entry: ${name}; verify submodules independently`);
  }
  return { revision, tree: hash.digest("hex") };
}

async function writeEnvelope(decision: AssignmentDecision, keyFile: string, output: string) {
  const key = createPrivateKey(await fs.readFile(keyFile));
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Verifier key must be Ed25519");
  const canonical = assignmentDecisionSchema.parse(decision);
  const signature = sign(null, Buffer.from(JSON.stringify(canonical)), key).toString("base64");
  await fs.writeFile(output, JSON.stringify({ decision: canonical, signature }, null, 2), { flag: "wx" });
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      key: { type: "string" }, output: { type: "string" }, decision: { type: "string" },
      assignment: { type: "string" }, workstream: { type: "string" },
      contract: { type: "string" }, candidate: { type: "string" },
      outcome: { type: "string" }, "blocked-on": { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    process.stdout.write(`Independent workstream verifier:
    snapshot --candidate REPOSITORY
    assign --decision APPROVED_ASSIGNMENT_JSON --key PRIVATE_KEY --output ENVELOPE
    verify --assignment ASSIGNMENT_JSON --workstream ID --contract CONTRACT_JSON
           --candidate REPOSITORY --key PRIVATE_KEY --output ENVELOPE
           --outcome accepted|dependency [--blocked-on OBLIGATION]

  CONTRACT_JSON contains argv (nonempty string array) and environment (string map).
  Its bytes must match the contract SHA-256 in the approved assignment.
  Output and key must be outside the candidate. Failed checks produce no signed verdict.
  Configure the daemon with COS_ASSIGNMENT_VERIFIER_PUBLIC_KEY containing the PEM public key.
  POST the envelope to /workstreams/assignment through the existing local controller channel.
  Keep private keys in the independent verifier's environment, outside worker access.
  `);
  } else {
    const required = (name: keyof typeof values): string => {
      const value = values[name];
      if (typeof value !== "string" || !value) throw new Error(`--${name} is required`);
      return value;
    };
    const command = positionals[0];
    if (command === "snapshot") {
      process.stdout.write(JSON.stringify(await snapshot(await fs.realpath(required("candidate")))) + "\n");
    } else if (command === "assign") {
      const decision = assignmentDecisionSchema.parse(JSON.parse(await fs.readFile(required("decision"), "utf8")));
      if (decision.kind !== "assign") throw new Error("assign cannot sign a verdict");
      await writeEnvelope(decision, required("key"), required("output"));
    } else if (command === "verify") {
      const assignment = assignmentSchema.parse(JSON.parse(await fs.readFile(required("assignment"), "utf8")));
      const candidate = await fs.realpath(required("candidate"));
      const output = path.join(await fs.realpath(path.dirname(path.resolve(required("output")))),
        path.basename(required("output")));
      const key = await fs.realpath(required("key"));
      for (const protectedPath of [output, key]) {
        const relative = path.relative(candidate, protectedPath);
        if (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
          throw new Error("Verifier output and private key must be outside the candidate");
      }
      const outcome = z.enum(["accepted", "dependency"]).parse(required("outcome"));
      const contract = outcome === "accepted" ? assignment.acceptance : assignment.dependencyCheck;
      if (!contract) throw new Error("No dependency verification contract was assigned");
      const raw = await fs.readFile(required("contract"));
      if (sha256(raw) !== contract.sha256) throw new Error("Verification contract changed");
      const spec = z.object({
        argv: z.array(z.string()).min(1),
        environment: z.record(z.string(), z.string()),
      }).strict().parse(JSON.parse(raw.toString("utf8")));
      const before = await snapshot(candidate);
      const logPath = `${output}.log`;
      const log = createWriteStream(logPath, { flags: "wx" });
      await once(log, "open");
      const child = spawn(spec.argv[0]!, spec.argv.slice(1), {
        cwd: candidate, env: spec.environment, stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.pipe(log, { end: false });
      child.stderr.pipe(log, { end: false });
      const [exitCode, signal] = await once(child, "close");
      log.end();
      await once(log, "finish");
      const after = await snapshot(candidate);
      if (JSON.stringify(before) !== JSON.stringify(after))
        throw new Error("Candidate changed during verification");
      if (exitCode !== 0 || signal !== null)
        throw new Error(`Verification failed: exit=${exitCode}, signal=${signal}; evidence: ${logPath}`);
      await writeEnvelope({
        kind: "verdict", workstream: required("workstream"), assignmentId: assignment.id,
        outcome, source: after, contractSha256: contract.sha256,
        evidence: { reference: logPath, sha256: sha256(await fs.readFile(logPath)) },
        blockedOn: outcome === "dependency" ? required("blocked-on") : null,
      }, key, output);
    } else {
      throw new Error("Expected snapshot, assign or verify; use --help");
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
