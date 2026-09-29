/**
 * Builds the MCP server for one surface.
 *
 * There is no "the" tool list any more. Each connector is its own server with its own
 * `tools/list`, because that list is the unit ChatGPT discovers: a no-query discovery pull
 * returns everything one server advertises, so the only real way to bound what a
 * conversation can be handed is to publish less per server (`docs/tool-surface.md` §6.4).
 *
 * The invariant this file enforces is that the boundary is *real*. A server registers the
 * tools its surface names and nothing else, so a Core server has no handler for `computer`
 * and answers a call for it with an unknown-tool error from the protocol layer itself.
 * There is no hidden acceptance of names a server did not advertise, and there is no
 * merged list — those would both be ways of claiming a separation the product does not have.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createRegistrar, guard, type ToolContext } from "./kernel.js";
import { registerCoreTools } from "./tools-core.js";
import { registerDesktopTools } from "./tools-desktop.js";
import { registerCodeMode } from "./code-mode-tool.js";
import { surfaceDefinition, type SurfaceId } from "./surfaces.js";
import { serverInstructions } from "./instructions.js";
import { APP_VERSION } from "./../version.js";
import { rawPromises as fs } from "../rawfs.js";
import { SandboxError, resolvePath, toVirtualPath } from "../sandbox.js";
import { logWarn } from "../logger.js";
import {
  WORKSTREAM_LEASE_MS,
  continueWorkstream,
  startWorkstream,
  workstreamWorkspace,
  workstreamIdSchema,
  type WorkstreamSetupResult,
} from "../workstreams.js";

/** Tells a chat that claimed a workstream to read its rules first; rules-gate.ts enforces it. */
function rulesNotice(id: string): string {
  const workspace = workstreamWorkspace(id);
  if (!workspace) return "";
  const rules = `${workspace.replace(/\/+$/, "")}/AGENTS.md`;
  return (
    `\nYour next call, now, in this turn: read with paths=["${rules}"], continuing until every line is read; then follow it and carry on. ` +
    "`read` is a tool of this same connector, beside `workstream`, `exec_command` and `apply_patch`. If it is not " +
    "among the tools you have loaded, look it up in this connector by the name `read` and call it; a tool you have not " +
    "looked up yet is not a missing tool. " +
    "Until this chat has read every line of it, the app refuses every tool except read, find and view_image. " +
    "Reading it is a step to do, not a blocker to report: never end your turn on it."
  );
}

/** What a refused setup call means for the chat that made it, and what it does next. */
function workstreamRefusal(
  refusal: Extract<WorkstreamSetupResult, { ok: false }>,
): string {
  switch (refusal.code) {
    case "WORKSTREAM_ALREADY_EXISTS":
      return 'That workstream is already registered. Call this tool with action="continue" and the same name to claim it.';
    case "WORKSTREAM_PATH_TAKEN":
      return `WORKSTREAM_PATH_TAKEN: workstream "${refusal.holder}" already owns that path. One path has one workstream; claim "${refusal.holder}" with action="continue" instead.`;
    case "WORKSTREAM_HELD": {
      const held =
        "WORKSTREAM_HELD: another chat holds this workstream. Do not work on it here. The lock frees five minutes after its holder's last tool call. ";
      if (refusal.freesAt == null)
        return (
          held +
          `A tool call under it is running now. Call \`sleep\` with seconds=${SLEEP_MAX_SECONDS}, then call this tool with action="continue" again. Do not end your turn.`
        );
      const seconds = Math.min(
        SLEEP_MAX_SECONDS,
        Math.max(1, Math.ceil((refusal.freesAt - Date.now()) / 1000) + 1),
      );
      return (
        held +
        `It frees at ${new Date(refusal.freesAt).toISOString()}. Call \`sleep\` with seconds=${seconds}, then call this tool with action="continue" again. ` +
        "If its holder makes another call first, you get this refusal again with a later time; repeat. Do not end your turn."
      );
    }
    case "WORKSTREAM_NOT_FOUND":
      return 'No workstream has that name. Check the name you were given; to create a new one, call this tool with action="start".';
    case "WORKSTREAM_UNAVAILABLE":
      return (
        "WORKSTREAM_UNAVAILABLE: this workstream is being moved to a fresh chat right now, and that chat carries " +
        "the work on. Stop working on it in this chat and make no further tool calls for it here."
      );
    case "WORKSTREAM_PAUSED":
      return (
        "WORKSTREAM_PAUSED: the owner has paused this workstream to free its resources. Stop working: " +
        "make no further tool calls for it, and end your turn with a short note of where the work stands. " +
        "The owner resumes it when wanted, and the resumed chat is told."
      );
  }
}

export function buildServer(
  ctx: ToolContext,
  surface: SurfaceId,
  liveContext: () => ToolContext = () => ctx,
): McpServer {
  const definition = surfaceDefinition(surface);
  const server = new McpServer(
    { name: definition.serverName, version: APP_VERSION },
    {
      capabilities: { tools: {} },
      instructions: serverInstructions(ctx, surface),
    },
  );

  if (surface === "core") {
    registerWorkstreamSetupTool(server, liveContext);
    registerSleepTool(server);
  }

  const registrar = createRegistrar(server, ctx, surface);
  if (surface === "core") {
    registerCoreTools(registrar);
    registerCodeMode(registrar, (name, args, parent) => {
      // Rebuilt for every child against the live context, so a permission or approved-root
      // change while a script is awaiting takes effect on its next call.
      const nested = createRegistrar(null, liveContext(), surface);
      registerCoreTools(nested);
      return nested.invokeNested(name, args, parent);
    });
  } else {
    registerDesktopTools(registrar);
  }

  // Cheap self-check on a property the tests assert and the design depends on: a surface
  // may register fewer tools than it declares — permissions decide that — but it may never
  // register one it does not declare. Logged rather than thrown, because refusing to serve
  // would turn a naming slip into a dead connector for the user.
  const declared = new Set(definition.tools);
  for (const name of registrar.registered()) {
    if (!declared.has(name)) {
      logWarn(
        `MCP surface ${surface} registered "${name}", which it does not declare — check surfaces.ts`,
      );
    }
  }

  return server;
}

/** The longest single sleep: the workstream lease, so one call outlasts any held lock. */
const SLEEP_MAX_SECONDS = WORKSTREAM_LEASE_MS / 1000;

/**
 * A plain wait. Registered directly on the Core server, like setup, because it touches no
 * workspace and needs no workstream_id: a chat refused a held lock must be able to wait for
 * it to free without first holding anything. It admits no workstream call, so it renews no
 * lease — a holder that sleeps past its lease can lose its lock.
 */
function registerSleepTool(server: McpServer): void {
  server.registerTool(
    "sleep",
    {
      title: "Wait",
      description:
        `Wait the given number of seconds, then return. Needs no workstream_id. Use it to wait for a time the app told you, ` +
        `for example a held workstream lock to free, instead of ending your turn. It does not renew your workstream lock. ` +
        `At most ${SLEEP_MAX_SECONDS} seconds per call.`,
      inputSchema: z.object({
        seconds: z
          .number()
          .int()
          .min(1)
          .max(SLEEP_MAX_SECONDS)
          .describe(`Seconds to wait, 1 to ${SLEEP_MAX_SECONDS}.`),
      }),
    },
    async ({ seconds }, ctx) =>
      guard("sleep", async () => {
        const signal = ctx.mcpReq.signal;
        const started = Date.now();
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, seconds * 1000);
          signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
        const slept = Math.round((Date.now() - started) / 1000);
        return {
          content: [
            {
              type: "text" as const,
              text: signal.aborted ? `Cancelled after ${slept} s.` : `Slept ${slept} s. It is now ${new Date().toISOString()}.`,
            },
          ],
        };
      }),
  );
}

/**
 * The one unscoped setup operation. Deliberately registered directly on the Core server
 * rather than through `createRegistrar`, because that wrapper scopes every ordinary tool
 * with a required `workstream_id` — and setup is exactly the operation that must succeed
 * before any workstream_id exists.
 *
 * `action=start` registers a new named workstream on the directory it declares, which is
 * fixed for the life of the workstream; `action=continue` claims an existing one whose lock
 * has expired. Either returns the opaque `workstream_id` required on ordinary calls.
 */
function registerWorkstreamSetupTool(
  server: McpServer,
  liveContext: () => ToolContext,
): void {
  server.registerTool(
    "workstream",
    {
      title: "Register or claim workstream identity",
      description:
        "Identity setup required before ordinary Core/Desktop calls. Use action=start with a new logical " +
        "workstream name and the repository directory it works in, to register and claim it for this chat. Use " +
        "action=continue with an already-registered name to claim it. The returned workstream_id is the identity " +
        "token required on every ordinary connector call.",
      inputSchema: z.object({
        action: z
          .enum(["start", "continue"])
          .describe(
            "start: register and claim a new named workstream. continue: claim an already-registered named workstream.",
          ),
        workstream: workstreamIdSchema.describe(
          "Logical workstream name identifying the repository/task being claimed, for example research or orchestrator.",
        ),
        path: z
          .string()
          .optional()
          .describe(
            "start only, and required there: the absolute virtual path of the directory this workstream works in, " +
              "for example /research/math-notes-app. It is fixed for the life of the workstream.",
          ),
      }),
    },
    async ({ action, workstream, path }) =>
      guard("workstream", async () => {
        const refused = (text: string) => ({
          content: [{ type: "text" as const, text }],
          isError: true,
        });
        if (action === "start") {
          if (!path)
            return refused(
              'action="start" requires `path`: the absolute virtual path of the directory this workstream works in.',
            );
          let workspace: string;
          try {
            const resolved = await resolvePath(liveContext().roots, path);
            if (!(await fs.stat(resolved.real)).isDirectory())
              return refused(`${resolved.virtual} is not a directory.`);
            workspace = resolved.virtual;
          } catch (error) {
            if (error instanceof SandboxError) return refused(error.message);
            throw error;
          }
          const result = await startWorkstream(workstream, workspace);
          if (!result.ok) return refused(workstreamRefusal(result));
          return {
            content: [
              {
                type: "text" as const,
                text: `Registered and claimed workstream "${result.id}" on ${workspace} for this chat.\nUse workstream_id="${result.workstreamId}" on every ordinary Core/Desktop call while working under this identity.` + rulesNotice(result.id),
              },
            ],
          };
        }
        if (path)
          return refused(
            'action="continue" takes no `path`: a workstream keeps the directory it was started on.',
          );
        const result = await continueWorkstream(workstream);
        if (!result.ok) return refused(workstreamRefusal(result));
        return {
          content: [
            {
              type: "text" as const,
              text: `Claimed existing workstream "${result.id}" for this chat.\nUse workstream_id="${result.workstreamId}" on every ordinary Core/Desktop call while working under this identity.` + rulesNotice(result.id),
            },
          ],
        };
      }),
  );
}

export { toVirtualPath };
export type { ToolContext };
export {
  chunkText,
  lastToolCallAt,
  resetToolClock,
  transportIdentityStatus,
} from "./kernel.js";
