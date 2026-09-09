/**
 * The logger's fail-loud contract for headless operation.
 *
 * The log is a RAM-only ring buffer read by the Electron diagnostics panel. The headless
 * daemon has no panel, so before this boundary existed every logError "fired" into memory
 * nobody could read: the 2026-09 transport-attribution alarm produced zero journal lines
 * while 113 unattributed calls landed. Headless startup opts failures into an
 * unconditional stderr echo (journald captures stderr); that opt-in must actually reach
 * stderr for error and warn records, must not depend on CLF_DEBUG, and must stay off for
 * the Electron app that never enables it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  enableConsoleFailureEcho,
  logError,
  logInfo,
  logWarn,
  resetConsoleFailureEchoForTests
} from '../src/main/logger.js';

describe('headless failure echo', () => {
  afterEach(() => {
    resetConsoleFailureEchoForTests();
    vi.restoreAllMocks();
  });

  it('echoes error and warn records to stderr once enabled, without CLF_DEBUG', () => {
    expect(process.env['CLF_DEBUG']).not.toBe('1');
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    enableConsoleFailureEcho();
    logError('attribution alarm reaches the journal');
    logWarn('degraded attribution warning reaches the journal');
    logInfo('ordinary chatter stays out of the journal');

    const lines = write.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.startsWith('[error]') && line.includes('attribution alarm'))).toBe(true);
    expect(lines.some((line) => line.startsWith('[warn]') && line.includes('degraded attribution'))).toBe(true);
    expect(lines.some((line) => line.includes('ordinary chatter'))).toBe(false);
  });

  it('stays silent when never enabled, as in the Electron app', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    logError('panel-only error');
    expect(write.mock.calls.map((call) => String(call[0])).some((line) => line.includes('panel-only error'))).toBe(
      false
    );
  });
});
