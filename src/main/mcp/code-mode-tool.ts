/**
 * Code mode: one `exec` call runs JavaScript that composes this connector's own tools.
 *
 * Ported from upstream totec448-spec/chat-on-steroids src/main/mcp/code-mode-tool.ts, Core
 * surface only. Contract checked upstream against OpenAI Codex 634ebc1865c6ac840ed3ba118f040d527bf4b55d,
 * code-mode-protocol/src/description.rs and core/src/tools/code_mode/execute_spec.rs.
 * MCP requires an object argument; it cannot advertise Codex's freeform grammar/namespace.
 */
import { currentCall, type CallContext } from './call-context.js';
import { fail, guard, type SurfaceRegistrar, type ToolResult } from './kernel.js';
import { codeModeSchema, runCodeMode, type CodeModeTool } from './code-mode-runtime.js';

export const CODE_MODE_DECLARATION = {
  title: 'Run JavaScript',
  description:
    'Run JavaScript to compose this connector’s tools. Argument: {code: "raw JavaScript"}. Inside code, use await tools.<tool_name>(args), await Promise.all([...]), text(value), and image(dataUrlOrMcpImageContent). tools return their normal MCP result objects, including content and isError. Only explicit text/image output reaches the model; intermediate results stay in the runtime and local tool recording. ALL_TOOLS lists {name,description}; use the individual tools’ schemas for arguments. Fresh isolated JavaScript runtime, top-level await, no Node, filesystem, network, console or imports. Limits: 64k source characters, 32 MiB JS memory, 2s active JS time, 60s total, 32 calls, 8 concurrent calls, 40k text bytes, 4 images, 12 MiB emitted payload. Await every call. Termination stops JavaScript/new calls, not actions already dispatched. Individual tools remain available. agents action=finish must be a direct call. No recursive exec, pragma, wait/yield or persistent globals. See the connector instructions for examples.',
  inputSchema: codeModeSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
};

export function codeModeHandler(
  getTools: () => CodeModeTool[],
  invoke: (name: string, args: unknown, parent: CallContext) => Promise<ToolResult>
): (args: { code: string }) => Promise<ToolResult> {
  return ({ code }) =>
    guard('exec', async () => {
      const parent = currentCall();
      if (!parent) return fail('CODE_MODE_RUNTIME_ERROR: no call context. No JavaScript or nested tool ran.');
      return runCodeMode(code, getTools().filter((tool) => tool.name !== 'exec'), (name, args) => invoke(name, args, parent));
    });
}

/** Registers `exec` last, so ALL_TOOLS lists every tool this surface registered. */
export function registerCodeMode(
  reg: SurfaceRegistrar,
  invoke: (name: string, args: unknown, parent: CallContext) => Promise<ToolResult>
): void {
  if (reg.registered().length === 0) return;
  reg.register('exec', CODE_MODE_DECLARATION, codeModeHandler(() => reg.descriptions(), invoke));
}

export const CODE_MODE_INSTRUCTIONS = `Code mode: use exec with JavaScript to compose this connector's tools by their listed names and argument schemas. Inspect content, structuredContent and isError in each MCP result. Only text(...) and image(...) emit output. For a requests array you define:
const results = await Promise.all(requests.map(({name, args}) => tools[name](args)));
text(results.map((result, index) => ({index, isError: result.isError ?? false, content: result.content})));
Keep emitted text within 40,000 UTF-8 bytes total. For large read batches, request smaller max_bytes or line ranges, filter the returned content, or use read directly. Forward images with image(...), not text(result); base64 serialized as text consumes the text limit. An oversized text emission returns an explicitly truncated preview and stops the script; inspect already dispatched calls before retrying.
Run independent calls in parallel only when they cannot conflict; await mutations before dependent work. Forward native images with image(result.content.find(item => item.type === "image")). Children keep the parent's request identity, recheck live permissions and record separately. No text/image means no emitted output. Worker inbox messages arrive with the outer result. Call agents action=finish directly. Prefer direct tools for simple calls or native file arguments. No persistent state or wait tool; long-running tools use their usual continuation IDs.`;
