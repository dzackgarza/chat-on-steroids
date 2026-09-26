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
import { surfaceDefinition, type SurfaceId } from "./surfaces.js";
import { serverInstructions } from "./instructions.js";
import { APP_VERSION } from "./../version.js";
import { toVirtualPath } from "../sandbox.js";
import { logWarn } from "../logger.js";
import {
  continueWorkstream,
  startWorkstream,
  workstreamIdSchema,
  type WorkstreamSetupResult,
} from "../workstreams.js";

/** What a refused setup call means for the chat that made it, and what it does next. */
function workstreamRefusal(
  code: Extract<WorkstreamSetupResult, { ok: false }>["code"],
): string {
  switch (code) {
    case "WORKSTREAM_ALREADY_EXISTS":
      return 'That workstream is already registered. Call this tool with action="continue" and the same name to claim it.';
    case "WORKSTREAM_NOT_FOUND":
      return 'No workstream has that name. Check the name you were given; to create a new one, call this tool with action="start".';
    case "WORKSTREAM_UNAVAILABLE":
      return (
        "WORKSTREAM_UNAVAILABLE: this workstream is being moved to a fresh chat right now, and that chat carries " +
        "the work on. Stop working on it in this chat and make no further tool calls for it here."
      );    case "WORKSTREAM_PAUSED":
      return (
        "WORKSTREAM_PAUSED: the owner has paused this workstream to free its resources. Stop working: " +
        "make no further tool calls for it, and end your turn with a short note of where the work stands. " +
        "The owner resumes it when wanted, and the resumed chat is told."
      );
  }
}

export function buildServer(ctx: ToolContext, surface: SurfaceId): McpServer {
  const definition = surfaceDefinition(surface);
  const server = new McpServer(
    { name: definition.serverName, version: APP_VERSION },
    {
      capabilities: { tools: {} },
      instructions: serverInstructions(ctx, surface),
    },
  );

  if (surface === "core") registerWorkstreamSetupTool(server);

  const registrar = createRegistrar(server, ctx, surface);
  if (surface === "core") registerCoreTools(registrar);
  else registerDesktopTools(registrar);

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

/**
 * The one unscoped setup operation. Deliberately registered directly on the Core server
 * rather than through `createRegistrar`, because that wrapper scopes every ordinary tool
 * with a required `workstream_id` — and setup is exactly the operation that must succeed
 * before any workstream_id exists.
 *
 * `action=start` registers and claims a new named logical workstream for this chat;
 * `action=continue` claims an already-registered one. Either returns the opaque
 * `workstream_id` required to unlock ordinary connector calls under that identity.
 */
function registerWorkstreamSetupTool(server: McpServer): void {
  server.registerTool(
    "workstream",
    {
      title: "Register or claim workstream identity",
      description:
        "Identity setup required before ordinary Core/Desktop calls. Use action=start with a new logical " +
        "workstream name to register and claim that repository/task identity for this chat. Use action=continue " +
        "with an already-registered name to claim and continue it. The returned workstream_id is the identity token " +
        "required on every ordinary connector call.",
      inputSchema: z.object({
        action: z
          .enum(["start", "continue"])
          .describe(
            "start: register and claim a new named workstream. continue: claim an already-registered named workstream.",
          ),
        workstream: workstreamIdSchema
          .describe(
            "Logical workstream name identifying the repository/task being claimed, for example research or orchestrator.",
          ),
      }),
    },
    async ({ action, workstream }) =>
      guard("workstream", async () => {
        if (action === "start") {
          const result = await startWorkstream(workstream);
          if (!result.ok)
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    result.code === "WORKSTREAM_ALREADY_EXISTS"
                      ? `Workstream "${workstream}" is already registered. Use action=continue with this name to claim it.`
                      : workstreamRefusal(result.code),
                },
              ],
              isError: true,
            };
          return {
            content: [
              {
                type: "text" as const,
                text: `Registered and claimed workstream "${result.id}" for this chat.\nUse workstream_id="${result.workstreamId}" on every ordinary Core/Desktop call while working under this identity.`,
              },
            ],
          };
        }
        const result = await continueWorkstream(workstream);
        if (!result.ok)
          return {
            content: [
              {
                type: "text" as const,
                text:
                  result.code === "WORKSTREAM_NOT_FOUND"
                    ? `Workstream "${workstream}" is not registered. Use action=start with this name to register and claim it.`
                    : workstreamRefusal(result.code),
              },
            ],
            isError: true,
          };
        return {
          content: [
            {
              type: "text" as const,
              text: `Claimed existing workstream "${result.id}" for this chat.\nUse workstream_id="${result.workstreamId}" on every ordinary Core/Desktop call while working under this identity.`,
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
