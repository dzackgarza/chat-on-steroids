/**
 * Reading a session journal must not freeze the rest of the app.
 *
 * `readEvents()` used to `readFile` the whole `events.jsonl`, `split('\n')` it and parse
 * every line in one synchronous pass. That is fine at the sizes the caps were assumed to
 * hold and ruinous at the sizes they actually reach: two live journals on this machine got
 * to 63 MB and 49 MB, and at 63 MB one call blocked the event loop for **1.5 seconds**
 * (measured 2026-09-10 — 544 ms in `split`, 975 ms parsing 21,482 lines; the async read
 * itself cost 13 ms of loop lag, so the file I/O was never the problem). Everything else in
 * the process queues behind that: `/hello` answering outside a second about one probe in
 * twenty, `just say` reporting a live app as absent, and the fleet seeing a daemon that
 * looks wedged.
 *
 * There is deliberately **no timing assertion here**, and two attempts at one were thrown
 * away rather than shipped. Counting event-loop turns does not discriminate: `readFile`
 * yields once per I/O chunk too, so both implementations score the same. Measuring the
 * longest uninterrupted block does discriminate on the real journal, but not on a synthetic
 * one — 10,000 flat 2 KB rows parse in about 10 ms, roughly twenty times faster per byte
 * than real events, whose nesting and whose 21,482-substring `split` are where the 1.5
 * seconds actually went. A threshold tuned on that fixture would measure the fixture, and on
 * this machine (load routinely above core count) it would be one more load-flaky test in a
 * suite that already has that problem.
 *
 * What is asserted here is the correctness of the streamed reader, including the two hazards
 * a whole-file read never had: a record split across chunk boundaries, and a torn line that
 * must be dropped and resynchronised rather than buffered without bound. The non-blocking
 * property is recorded as the measurement it is, in `readEvents`.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import {
  createSession,
  initSessionStore,
  readEvents,
  resetSessionStoreForTests
} from '../src/main/session/store.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string;

/** Bytes per event, chosen so a few thousand rows cross many stream chunks. */
const PADDING = 'x'.repeat(2_000);

/**
 * Writes `count` valid event lines straight into the session's journal.
 *
 * Deliberately not through `appendEvent`: this is about how a *large existing* journal is
 * read back, and the write path has its own caches that would answer from memory.
 */
async function fillJournal(sessionId: string, count: number): Promise<void> {
  const lines: string[] = [];
  for (let seq = 1; seq <= count; seq += 1) {
    lines.push(
      JSON.stringify({
        seq,
        time: 1_600_000_000_000 + seq,
        source: 'app',
        kind: 'note',
        message: { text: `${seq} ${PADDING}` }
      })
    );
  }
  await fs.writeFile(path.join(dir, 'sessions', sessionId, 'events.jsonl'), `${lines.join('\n')}\n`, 'utf8');
}

beforeAll(async () => {
  dir = await makeTempDir('clf-journal-yield-');
  initConfigPath(dir);
  initSessionStore(dir);
});

afterAll(async () => {
  resetSessionStoreForTests();
  await removeTempDir(dir);
});

beforeEach(async () => {
  resetSessionStoreForTests();
  initSessionStore(dir);
  const base = defaultConfig();
  await saveConfig({ ...base, sessions: { ...base.sessions, record: true } });
});

afterEach(() => {
  resetSessionStoreForTests();
});

describe('reading a large session journal', () => {
  it('reads every row of a journal that spans many chunks', async () => {
    // ~6 MB against a 256 KB chunk, so most rows are reassembled across a boundary rather
    // than falling inside one read.
    const session = await createSession({ title: 'big journal' });
    await fillJournal(session.id, 3_000);
    // Drop the write-side caches so the read genuinely goes to disk, which is the path a
    // restarted app and every non-`from` caller take.
    resetSessionStoreForTests();
    initSessionStore(dir);

    const events = await readEvents(session.id);

    expect(events).toHaveLength(3_000);
    expect(events[0]?.seq).toBe(1);
    expect(events.at(-1)?.seq).toBe(3_000);
    // Nothing was silently truncated at a boundary: every seq is present exactly once.
    expect(new Set(events.map((event) => event.seq)).size).toBe(3_000);
  });

  it('still reads a journal whose final line has no newline', async () => {
    // The append path can be interrupted between the record and its newline. Losing the
    // last event to a missing terminator would be a silent history hole.
    const session = await createSession({ title: 'unterminated' });
    const file = path.join(dir, 'sessions', session.id, 'events.jsonl');
    await fs.writeFile(
      file,
      [
        JSON.stringify({ seq: 1, time: 1, source: 'app', kind: 'note', message: { text: 'first' } }),
        JSON.stringify({ seq: 2, time: 2, source: 'app', kind: 'note', message: { text: 'last' } })
      ].join('\n'),
      'utf8'
    );
    resetSessionStoreForTests();
    initSessionStore(dir);

    expect((await readEvents(session.id)).map((event) => event.seq)).toEqual([1, 2]);
  });

  it('drops a torn line that spans chunks instead of buffering it without bound', async () => {
    // A line longer than the cap is damage, not a pending record. It must cost that one row
    // and neither abort the read nor pull an arbitrary run of bytes into memory — the exact
    // failure mode this whole change is about.
    const session = await createSession({ title: 'torn' });
    const file = path.join(dir, 'sessions', session.id, 'events.jsonl');
    await fs.writeFile(
      file,
      [
        JSON.stringify({ seq: 1, time: 1, source: 'app', kind: 'note', message: { text: 'before' } }),
        `{"seq":2,"kind":"note","junk":"${'y'.repeat(600 * 1024)}`,
        JSON.stringify({ seq: 3, time: 3, source: 'app', kind: 'note', message: { text: 'after' } })
      ].join('\n'),
      'utf8'
    );
    resetSessionStoreForTests();
    initSessionStore(dir);

    // Resynchronised on the next newline: the rows either side of the damage both survive.
    expect((await readEvents(session.id)).map((event) => event.seq)).toEqual([1, 3]);
  });
});
