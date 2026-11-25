import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initDurableStore } from '../src/main/durable';
import { initSessionStore } from '../src/main/session/store';
import { emptyEvidence, type CallContext } from '../src/main/mcp/call-context';
import { createRegistrar, type ToolResult } from '../src/main/mcp/kernel';
import { registerCoreTools } from '../src/main/mcp/tools-core';
import {
  bindWorkstreamConversation,
  continueWorkstream,
  restoreWorkstreams,
  scheduleWorkstreamAfterTurn,
  startWorkstream,
} from '../src/main/workstreams';
import { CAPABILITIES, type Capabilities, type Root } from '../src/shared/types';

const repository = path.resolve(__dirname, '..');

function text(result: ToolResult): string {
  return result.content.map((part) => ('text' in part ? part.text : '')).join('\n');
}

void (async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'rules-gate-steward-'));
  try {
    initDurableStore(path.join(temp, 'state'));
    initSessionStore(temp);
    await restoreWorkstreams();
    const repositoryWithRules = async (name: string): Promise<Root> => {
      const workspace = path.join(temp, name);
      await mkdir(workspace);
      await writeFile(path.join(workspace, 'AGENTS.md'), 'rule one\nrule two\nrule three\n');
      const git = (...args: string[]) =>
        execFileSync('git', ['-C', workspace, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=test', '-c', 'user.email=test@invalid', ...args]);
      git('init', '-q');
      git('add', 'AGENTS.md');
      git('commit', '-q', '-m', 'rules');
      return { name, path: workspace };
    };
    const roots: Root[] = [
      await repositoryWithRules('fleet'),
      await repositoryWithRules('work'),
      { name: 'app', path: repository },
    ];
    const caps = Object.fromEntries(CAPABILITIES.map((name) => [name, true])) as Capabilities;
    const reg = createRegistrar(null, { roots, caps, readOnly: false }, 'core');
    registerCoreTools(reg);

    const claim = async (id: string, workspace: string, conversation: string, now: number): Promise<CallContext> => {
      const started = await startWorkstream(id, workspace, now);
      assert.equal(started.ok, true, `workstream ${id} could not be started`);
      if (!started.ok) throw new Error('unreachable');
      await bindWorkstreamConversation(started.workstreamId, conversation);
      return {
        startedAt: now,
        tool: 'exec',
        workstreamId: id,
        workstreamClaimId: started.workstreamId,
        workstreamSessionId: null,
        transportKey: null,
        agent: null,
        caller: { transportKey: null, requestId: null, conversationId: conversation },
        outcome: null,
        evidence: emptyEvidence(),
        cancellation: new AbortController(),
      };
    };
    const act = async (call: CallContext) =>
      text(await reg.invokeNested('exec_command', { cmd: 'printf acted' }, call));
    const readAll = async (call: CallContext, file: string) => {
      const reply = text(await reg.invokeNested('read', { paths: [file] }, call));
      assert.match(reply, /lines 1-3 of 3/, `read of ${file} did not return the whole file`);
    };

    const orchestrator = await claim('orchestrator', '/fleet', 'conversation-orchestrator', Date.now());
    await readAll(orchestrator, '/fleet/AGENTS.md');

    const refused = await act(orchestrator);
    assert.match(
      refused,
      /^RULES_UNREAD: .*\/docs\/agents\/steward\.md/,
      `expected: the orchestrator, having read only AGENTS.md, is refused with RULES_UNREAD naming ` +
        `docs/agents/steward.md\nobserved: ${refused}`,
    );

    let reply = refused;
    for (let reads = 0; reply.startsWith('RULES_UNREAD'); reads++) {
      assert.ok(reads < 200, 'the steward file never counted as read');
      const next = /paths=\["([^"]+)"\] and start_line=(\d+)/.exec(reply);
      assert.ok(next, `refusal names no next read: ${reply}`);
      await reg.invokeNested('read', { paths: [next[1]], start_line: Number(next[2]) }, orchestrator);
      reply = await act(orchestrator);
    }
    assert.match(reply, /acted/, `expected: the orchestrator acts once it has read steward.md\nobserved: ${reply}`);

    const turnEnd = Date.now();
    assert.equal(
      await scheduleWorkstreamAfterTurn('conversation-orchestrator', 'tick-1', 'completed', turnEnd, turnEnd),
      true,
      'the completed orchestrator tick did not release its claim',
    );
    const nextTick = await continueWorkstream('orchestrator', turnEnd + 1);
    assert.equal(nextTick.ok, true, 'the next orchestrator tick could not claim');
    if (!nextTick.ok) throw new Error('unreachable');
    assert.notEqual(nextTick.workstreamId, orchestrator.workstreamClaimId, 'the next tick reused the old claim');
    const sameConversation = { ...orchestrator, workstreamClaimId: nextTick.workstreamId };
    const again = await act(sameConversation);
    assert.match(again, /acted/, `expected: a new claim in the same conversation acts without rereading\nobserved: ${again}`);

    const worker = await claim('worker-stream', '/work', 'conversation-worker', Date.now());
    await readAll(worker, '/work/AGENTS.md');
    const workerReply = await act(worker);
    assert.match(workerReply, /acted/, `expected: a non-orchestrator workstream needs only AGENTS.md\nobserved: ${workerReply}`);

    console.log('PASS: the orchestrator reads AGENTS.md and steward.md before acting; coverage survives a reclaim');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
})().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
