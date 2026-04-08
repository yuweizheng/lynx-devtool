# Lynx DevTool Codex Integration Technical Plan

## Background

This document summarizes three Codex integration routes for Lynx DevTool:

1. `Codex CLI`
2. `Codex SDK`
3. `Codex app-server`

The goal is to compare their technical shape, current implementation status in this repo, tradeoffs, and the recommended direction.

This document is based on:

- the current repo state and already implemented prototypes
- the current DevTool architecture
- the previous design discussion around PR `lynx-family/lynx-devtool#128`

## Goals

- Reuse the current DevTool UI and debug context collection
- Reuse the existing `CDP -> renderer -> debugDriver` chain
- Let Codex reason over `Elements`, `Console`, source code, and LynxBase knowledge
- Support streaming responses and tool-based live debugging
- Choose a route that is stable enough for a desktop DevTool product

## Non-goals

- Replace the current DevTool frontend panel architecture
- Replace the existing renderer-side CDP bridge
- Solve all product UX questions in this document

## Existing DevTool Building Blocks

The current repo already has a good foundation for all three routes.

### UI entry points

- `packages/devtools-frontend-lynx/front_end/panels/elements/ElementsPanel.ts`
- `packages/devtools-frontend-lynx/front_end/panels/console/ConsoleViewMessage.ts`
- `plugins/lynx-ai-assistant/renderer/components/AIAssistantView.tsx`

### Main-process AI orchestration

- `plugins/lynx-ai-assistant/main/ai-service.ts`
- `plugins/lynx-ai-assistant/main/index.ts`

### Existing debug bridge

- renderer event listener:
  `plugins/lynx-ai-assistant/renderer/index.tsx`
- main-to-renderer CDP dispatch:
  `EXECUTE_CDP_COMMAND`
- runtime execution:
  `debugDriver.sendCustomMessageAsync(...)`

### MCP-related work already done

- local debug MCP proxy:
  `plugins/lynx-ai-assistant/main/devtool-debug-mcp-proxy.ts`
- local debug MCP runtime:
  `plugins/lynx-ai-assistant/runtime/devtool-debug-mcp-server.ts`
- shared MCP definitions:
  `plugins/lynx-ai-assistant/shared/devtool-debug-mcp.ts`

### Current technical fact learned during prototyping

The current `Codex SDK` path already proves:

- the UI can stream agent progress
- MCP servers can be injected into a Codex turn
- the DevTool local debug MCP can be represented as tools

At the same time, current logs also show a critical limitation:

- `Codex SDK` starts `mcp_tool_call`
- but the tool call is cancelled inside Codex with
  `user cancelled MCP tool call`
- the call does not reach the local debug MCP proxy
- therefore the failure is not in the existing CDP bridge

This is the main reason why `SDK` is not currently the best long-term route for this product.

---

## Route A: Codex CLI

### What this means

The application invokes `codex exec --json` as an external command for each request.

The DevTool host collects context first, then sends a composed prompt to Codex.

### Recommended architecture for this route

```text
Elements / Console / Chat UI
  -> main AI service
  -> collect context in host
     - selected node summary
     - console message summary
     - source directory
     - source entry
     - optional MCP prefetch
  -> spawn codex exec --json
  -> parse JSONL progress / final output
  -> stream back into UI
```

### What we already implemented

The repo already went through this route and proved it can work as a fast integration path.

Main related files:

- `plugins/lynx-ai-assistant/main/ai-service.ts`
- `plugins/lynx-ai-assistant/main/codex-cli-service.ts`
- `plugins/lynx-ai-assistant/main/index.ts`

### Strengths

- Fastest integration path
- Lowest initial engineering cost
- Good for one-shot analysis and early validation
- Easy to reason about in logs because the host controls almost everything

### Weaknesses

- Fundamentally biased toward one-shot execution
- Less natural for multi-turn DevTool workflows
- The host tends to prefetch a lot of context before Codex runs
- Tool calling is possible in principle, but the overall runtime shape is still more script-like than client-like
- Approval, session recovery, and deep interaction are not a great fit

### Best use case

- Prototyping
- CI / automation
- Single-shot debugging suggestions

### Verdict

Good for proving value quickly, not ideal as the final architecture for Lynx DevTool.

---

## Route B: Codex SDK

### What this means

The application embeds Codex programmatically through `@openai/codex-sdk`.

Unlike `codex exec` one-shot mode, SDK gives:

- thread lifecycle
- `runStreamed()`
- resumable sessions
- programmatic control from application code

### Recommended architecture for this route

Preferred shape:

```text
Elements / Console / Chat UI
  -> main AI service
  -> Codex SDK wrapper
  -> external Node sidecar
  -> @openai/codex-sdk
  -> MCP tool call
  -> local debug MCP server
  -> proxy
  -> EXECUTE_CDP_COMMAND
  -> renderer
  -> debugDriver / CDP
```

### Why external Node sidecar is better than Electron main

Electron `22.0.1` ships with Node `16.x`.

`Codex SDK` officially requires Node `18+`.

To avoid mixing Codex runtime behavior with Electron's older embedded Node runtime, the safer pattern is:

- Electron main process only orchestrates
- external `node` process runs the SDK turn

This repo already contains that sidecar-based shape:

- main wrapper:
  `plugins/lynx-ai-assistant/main/codex-sdk-service.ts`
- sidecar runtime:
  `plugins/lynx-ai-assistant/runtime/codex-sdk-sidecar.ts`
- shared sidecar protocol:
  `plugins/lynx-ai-assistant/shared/codex-sdk-sidecar.ts`

### What we already implemented

Current implementation covers:

- streaming progress from Codex SDK
- thread-based execution through SDK
- MCP server injection into the turn
- local debug MCP tools exposed to Codex
- sidecar execution under external Node
- detailed logging around `mcp_tool_call`

Main related files:

- `plugins/lynx-ai-assistant/main/codex-sdk-service.ts`
- `plugins/lynx-ai-assistant/runtime/codex-sdk-sidecar.ts`
- `plugins/lynx-ai-assistant/shared/codex-sdk-sidecar.ts`
- `plugins/lynx-ai-assistant/main/ai-service.ts`

### Strengths

- Easier than `app-server` to embed into existing application code
- Better than `codex exec` for session continuity
- Good fit when the app already owns the UI and only needs a Codex runtime
- Straightforward event streaming into existing panels
- Lower migration cost than `app-server`

### Weaknesses

- The host still owns more integration logic than in `app-server`
- You still need to manage client/runtime semantics yourself
- Tool-calling behavior is less productized than `app-server`
- In this repo, the most important blocker already observed is:
  `mcp_tool_call` gets cancelled inside Codex before reaching the local debug MCP server

### Important current technical limitation

Based on current repo logs:

- `approvalPolicy: "never"` is definitely passed
- Node `18.20.5` sidecar is definitely used
- `mcp_tool_call` still becomes
  `user cancelled MCP tool call`
- no local debug MCP proxy log is emitted

Therefore the current blocker is not:

- not a target binding issue
- not a CDP bridge issue
- not an Electron Node `16` issue anymore

The blocker is currently in:

```text
Codex SDK / underlying Codex runtime
  -> MCP tool dispatch / approval semantics
```

### Best use case

- Medium-cost integration into an existing app
- Cases where thread control matters
- Internal products where the host wants to own the UI completely

### Verdict

SDK is a strong middle path, but for this specific DevTool product it already shows friction exactly where the product most needs reliability: live MCP/CDP tool-calling.

SDK is still useful as:

- a prototyping route
- a fallback runtime
- a reference implementation for event streaming

But it is not currently the most convincing long-term architecture for Lynx DevTool.

---

## Route C: Codex app-server

### What this means

The application integrates against the Codex app-server protocol instead of directly embedding the SDK in-process.

This route is meant for rich clients.

It is better aligned with:

- streamed agent events
- session lifecycle
- approvals
- conversation history
- stateful client integration

### Recommended architecture for this route

```text
Elements / Console / Chat UI
  -> Codex client layer in DevTool
  -> thread/start
  -> turn/start
  -> streamed events
  -> MCP tool calls
  -> local debug MCP server
  -> proxy
  -> EXECUTE_CDP_COMMAND
  -> renderer
  -> debugDriver / CDP
```

### Why this route fits the product better

Lynx DevTool is not a script runner.

It is a desktop debugging client with:

- multiple entry points
- long-lived debugging sessions
- streaming output
- tool-based live inspection
- potential need for approvals and richer tool status

This is exactly the shape app-server is designed for.

### Reference from prior work

The previously referenced PR `lynx-family/lynx-devtool#128` is important because it demonstrates:

- a Codex-centered client runtime
- MCP-based live tool usage
- a shape closer to a real DevTool companion experience

This is the strongest practical signal that app-server is a good long-term direction for this repo.

### Strengths

- Best fit for rich desktop client integration
- Most natural place for session, approval, and streaming event semantics
- Best long-term support for MCP/CDP live tool use
- Cleaner conceptual alignment with the product shape

### Weaknesses

- Largest migration cost
- Requires more up-front architecture work
- Requires a cleaner split between DevTool client, Codex runtime client, and local tool servers

### Best use case

- Shipping a real Codex-native DevTool experience
- Long-lived debugging workflows
- Stable live tool calling

### Verdict

This is the recommended long-term architecture.

---

## Technical Comparison

### 1. Integration cost

- CLI: lowest
- SDK: medium
- app-server: highest

### 2. Session model

- CLI: weak
- SDK: medium to strong
- app-server: strongest

### 3. Streaming events

- CLI: workable but more manual
- SDK: good
- app-server: best

### 4. MCP live tool-calling for this product

- CLI: possible, but awkward for product-scale interaction
- SDK: possible in theory, but currently problematic in this repo
- app-server: best architectural fit

### 5. Fit for Lynx DevTool

- CLI: good for bootstrap
- SDK: good as a bridge route
- app-server: best long-term route

---

## Recommended Strategy

### Short-term

Keep the current local debug MCP work.

These files are still valuable regardless of runtime choice:

- `plugins/lynx-ai-assistant/main/devtool-debug-mcp-proxy.ts`
- `plugins/lynx-ai-assistant/runtime/devtool-debug-mcp-server.ts`
- `plugins/lynx-ai-assistant/shared/devtool-debug-mcp.ts`

They capture the most important capability boundary:

```text
Codex tool
  -> local debug MCP
  -> existing DevTool bridge
  -> renderer CDP execution
```

### Medium-term

Stop investing heavily in debugging the current `SDK + MCP cancellation` path unless there is a strong reason to keep SDK as the final runtime.

The main value of the current SDK work is:

- understanding runtime boundaries
- validating the local debug MCP shape
- validating streaming UI behavior

### Long-term

Migrate to `app-server`.

That route best matches:

- the DevTool product shape
- the MCP/CDP live inspection requirement
- the PR reference that already works better in practice

---

## Proposed Migration Plan

### Phase 0: Keep and stabilize reusable pieces

Keep:

- local debug MCP server
- local debug MCP proxy
- streaming UI in Elements / Console / AI Assistant
- source directory / source entry / target wiring

### Phase 1: Introduce app-server client boundary

Add a dedicated client layer that owns:

- thread lifecycle
- turn lifecycle
- streamed event handling
- session restore

Suggested location:

- `plugins/lynx-ai-assistant/main/codex-app-client.ts`

### Phase 2: Move current SDK event consumers behind a runtime-agnostic interface

Introduce a runtime abstraction in main process:

```ts
interface CodexRuntime {
  runTurn(args): Promise<...>;
  streamTurn(args, callbacks): Promise<...>;
}
```

Backends:

- `cli`
- `sdk`
- `app-server`

This prevents the UI layer from caring which Codex runtime is active.

### Phase 3: Inject MCP servers through app-server session startup

Move current MCP injection logic from:

- `plugins/lynx-ai-assistant/main/ai-service.ts`

into app-server session initialization.

The local debug MCP server remains the same idea, but the runtime that consumes it changes.

### Phase 4: Unify panel flows

Use one agent session model across:

- `Elements`
- `Console`
- `AI Assistant chat`

Panels become different context entry points, not different agent implementations.

### Phase 5: Remove SDK-first logic if no longer needed

If app-server is stable:

- keep SDK only as fallback or dev tool
- or remove SDK path entirely

---

## Concrete Recommendation

If the project needs the fastest possible path to ship something experimental:

- keep `CLI`

If the project needs a medium-effort embedded runtime and is willing to accept integration friction:

- keep `SDK`

If the project is serious about Codex as a core DevTool capability:

- move to `app-server`

For Lynx DevTool specifically, the recommendation is:

1. Preserve the current local debug MCP work
2. Treat the current CLI and SDK work as exploration and temporary bridges
3. Make `app-server` the target architecture

---

## Appendix: Current File Map By Route

### Shared / reusable

- `plugins/lynx-ai-assistant/main/ai-service.ts`
- `plugins/lynx-ai-assistant/main/index.ts`
- `plugins/lynx-ai-assistant/renderer/index.tsx`
- `plugins/lynx-ai-assistant/main/devtool-debug-mcp-proxy.ts`
- `plugins/lynx-ai-assistant/runtime/devtool-debug-mcp-server.ts`
- `plugins/lynx-ai-assistant/shared/devtool-debug-mcp.ts`

### CLI route

- `plugins/lynx-ai-assistant/main/codex-cli-service.ts`

### SDK route

- `plugins/lynx-ai-assistant/main/codex-sdk-service.ts`
- `plugins/lynx-ai-assistant/runtime/codex-sdk-sidecar.ts`
- `plugins/lynx-ai-assistant/shared/codex-sdk-sidecar.ts`

### app-server target

Suggested new files:

- `plugins/lynx-ai-assistant/main/codex-app-client.ts`
- `plugins/lynx-ai-assistant/shared/codex-runtime.ts`
- `plugins/lynx-ai-assistant/main/codex-session-manager.ts`

