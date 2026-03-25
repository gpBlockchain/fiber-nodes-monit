---
name: fiber-nodes-monits-maintenance
description: Maintenance and evolution guide for the Fiber multi-node monitor (fiber-nodes-monits). Use when updating this app, adding views, changing concurrency or refresh behavior, or debugging Fiber JSON-RPC flows.
license: Complete terms in LICENSE.txt
---

# Fiber Nodes Monitor Maintenance Skill

This skill helps maintain and extend the **fiber-nodes-monits** project: a React + TypeScript + Vite dashboard for monitoring multiple Fiber nodes via JSON-RPC with a Node.js proxy.

Use this skill whenever you:
- Modify the Fiber monitor UI or behavior
- Add or change RPC-backed views（Overview、单节点详情、Payment Hash、网络拓扑、RPC 调试等）
- Adjust polling / auto-refresh / concurrency
- Debug issues in JSON-RPC calls or node data rendering

Keep instructions concise and follow existing code patterns.

## 1. Project Overview & Entry Points

**Project root**
- This repository’s root directory (folder name may be `fiber-nodes-monit` or similar; npm `name` field is `fiber-nodes-monits`).
- Key scripts (from `package.json`):
  - `npm run dev` → local dev server (`server/dev.ts`)
  - `npm run build` → TypeScript build + Vite bundle
  - `npm start` → production server (`server/prod.ts`)
  - `npm run lint` → ESLint over the project

**Key files**
- `src/App.tsx`
  - Main SPA component and all current UI:
    - Node list & management (add / remove / bulk import)
    - View modes: Dashboard、Payment Hash、Channel Outpoint 扫描、RPC 调试、Commitment Lock（CKB 链上追踪）、Node Control、网络拓扑（Topology）等
    - Dashboard:
      - Overview table (multi-node summary)
      - Selected node details (node_info, peers, channels, graph_nodes, graph_channels, Pending TLCs)
    - Payment Hash view:
      - Cross-node scan of `list_channels.pending_tlcs` by Payment Hash
      - Concurrency-limited scanning with progress bar
    - Channel Outpoint view:
      - Cross-node `list_channels` scan; match `channel_outpoint` with case-insensitive partial match (`includes`)
    - RPC 调试 view:
      - Free-form Fiber JSON-RPC method + params caller
    - Commitment Lock (`CommitmentTraceView` in `App.tsx`, logic in `src/lib/ckb.ts`):
      - CKB JSON-RPC via same `/api/rpc` proxy (`url` points to CKB); tx fetch, lock/witness parse, `getLnTxTrace`-style step list
    - Node Control:
      - Tabbed shortcuts for common Fiber RPCs on the selected node (`connect_peer`, `open_channel`, `new_invoice`, `send_payment`, etc.)
    - Network topology (`src/components/NetworkTopology.tsx`):
      - Paginated `graph_nodes` / `graph_channels` from the selected sidebar node, D3 force layout
      - Click node → node detail panel; click edge → channel detail panel (lists `underlying` channels when the edge is merged)
    - i18n: `src/lib/i18n.ts` (`zh` / `en`, persisted under `fiber-nodes-monits:lang`)
  - Contains helpers like:
    - `useInterval` hook
    - `runWithConcurrency` concurrency helper
    - Derived views using `useMemo` (overviewRows, pendingTlcRows, etc.)

- `src/lib/rpc.ts`
  - `callFiberRpc<T>(node, method, params?)`:
    - Single entry point for all RPC calls in the UI
    - Sends POST to `/api/rpc` with node URL and optional token
    - Validates JSON-RPC envelope, throws on `error` or missing `result`

- `src/lib/storage.ts`
  - `loadNodes()` / `saveNodes(nodes)`:
    - Node list persistence via `localStorage`
    - Do not bypass these in components.

- `src/lib/format.ts`
  - All display-only helpers:
    - Compact IDs (`shorten`)
    - Hex amount formatting
    - Time formatting (expiry, updatedAt)
    - Generic JSON formatting (`formatJson`)

- `src/lib/clipboard.ts`
  - `copyToClipboard(text)` used by topology panels and other copy actions

- `src/lib/ckb.ts`
  - CKB RPC client (`callCkbRpc` → `/api/rpc` with CKB `url`), commitment parsing, `getLnTxTrace`, network presets (testnet/mainnet)

- `server/rpcProxy.ts`
  - Node.js JSON-RPC proxy:
    - Exposes `POST /api/rpc`
    - Reads `{ url, token, method, params }` from body
    - Forwards JSON-RPC 2.0 request to the URL in `url` (Fiber node or CKB node)
    - Adds `Authorization: Bearer {token}` when token is present
  - No persistence of credentials; per-request only.

## 2. Core Invariants & Conventions

Respect these invariants when modifying the project:

1. **Single RPC abstraction**
   - All **Fiber** node calls from the UI MUST go through `callFiberRpc` in `src/lib/rpc.ts`.
   - CKB calls used by Commitment Lock MUST go through `callCkbRpc` in `src/lib/ckb.ts` (which also posts to `/api/rpc`).
   - Do not call `fetch` directly to node URLs from components.

2. **No comments policy**
   - Do not add code comments; follow existing style.
   - Express intent via clear naming and small helpers, not comments.

3. **Local-only secrets**
   - Node RPC URLs and tokens are stored only:
     - In browser `localStorage` (via `storage.ts`)
     - In in-memory data structures on the Node proxy side
   - Never log tokens or store them in files.

4. **Concurrency control**
   - When you need to call many nodes, use `runWithConcurrency` in `App.tsx`.
   - Default concurrency is **10** for:
     - Overview refresh (`pollSummaries`)
     - Payment Hash scan (`runPaymentSearch`)
   - If adjusting, keep a reasonable limit to protect nodes and network.

5. **Overview behavior**
   - Overview refresh is **explicit / manual** via “刷新概览” button.
   - The Overview card supports:
     - Collapse / expand toggle
     - Refresh progress bar showing completed/total nodes
   - Do not reintroduce automatic Overview polling without a strong reason.

6. **Node details refresh**
   - Current selected node:
     - Auto-refresh every 15s (using `useInterval`)
     - Also supports manual “刷新当前节点” button
   - Preserve this pattern when adding new detail sections.

7. **UI style**
   - Use existing CSS classes in `App.css` / `index.css`:
     - `card`, `cardHeader`, `cardBody`, `table`, `pill`, `badge`, `btn`, `btnGhost`, etc.
   - Keep layout and typography consistent with current cards and tables.

## 3. Common Maintenance Tasks

### 3.1 Add a new RPC-backed view or panel

Use this process when adding new analysis or debug views.

1. **Define UI entry**
   - Add a new `viewMode` option if it is a top-level tab (like Payment Hash / RPC 调试).
   - Or add a new section inside Dashboard or Node Details if it is node-specific.

2. **Use `callFiberRpc`**
   - Identify needed methods and params (e.g. `new_method`, `{ limit: "0x10" }`).
   - Implement a typed function wrapping `callFiberRpc<T>` in `App.tsx` or a dedicated lib wrapper.

3. **Respect concurrency**
   - If calling multiple nodes:
     - Use `runWithConcurrency(nodes, 10, fn)` as in `pollSummaries` or `runPaymentSearch`.
     - Track progress via a dedicated `progress` state (completed/total).

4. **Wire into state**
   - Follow patterns used by:
     - `paymentSearchState` / `paymentSearchProgress`
     - `overviewRefreshState` / `overviewRefreshProgress`
   - Keep state machines simple: `idle` | `pending/searching` | `done` | `error`.

5. **Render results**
   - Use `useMemo` for derived row data when appropriate.
   - Use consistent table styling and typography.

6. **Verify**
   - Run `npm run build` to ensure type safety.
   - Optionally run `npm run lint` and manual testing via `npm run dev`.

### 3.2 Adjust Overview / Details refresh behavior

When changing how often or when data is refreshed:

1. **Overview (multi-node)**
   - Editing `pollSummaries`:
     - Keep `runWithConcurrency` for node iteration.
     - Maintain `overviewRefreshState` and `overviewRefreshProgress` updates.
   - Only trigger Overview refresh via explicit user actions unless strictly necessary.

2. **Selected node details**
   - Use `refreshDetails` for the actual data fetch.
   - Auto-refresh is wired via `useInterval` with `selectedNode` dependency.
   - If you alter the interval, keep it in a reasonable range (e.g. 10–60s).

### 3.3 Extend Payment Hash / Pending TLCs behavior

1. **Pending TLCs in Node Details**
   - Derived from `details.channels` using:
     - `channel_id`, `state`, `pending_tlcs`
     - Format amount, expiry, status, direction, forwarding info
   - When adding fields:
     - Extend the row type used by `pendingTlcRows`.
     - Populate from `asObj(channel)` / `asObj(tlc)` with defensive checks.

2. **Payment Hash view (cross-node)**
   - Logic lives in `runPaymentSearch`:
     - Uses `runWithConcurrency(nodes, 10, fn)` and `list_channels`.
     - Scans `pending_tlcs` in each channel.
   - To add fields:
     - Extend `PaymentSearchMatch` type and the row add logic.
     - Update the table columns accordingly.

3. **Performance considerations**
   - Keep the number of per-node RPC calls minimal (ideally 1 per node per scan).
   - Avoid nested RPCs inside tight loops.

### 3.4 Debug JSON-RPC issues

1. Use the **RPC 调试** view first:
   - Select a node in the sidebar.
   - Input method and params JSON.
   - Compare expected vs actual raw responses.

2. If responses look correct but UI is wrong:
   - Inspect corresponding parsing code in `App.tsx` (e.g. `fetchNodeSummary`, `fetchNodeDetails`).
   - Verify `asObj` / `getArray` usage and field names.

3. If responses are broken:
   - Check `server/rpcProxy.ts` for request construction:
     - URL, headers, `Authorization` token.
   - Validate that the node RPC endpoint is reachable outside the app.

## 4. Safe Change & Verification Checklist

For any non-trivial change:

1. **Understand the flow**
   - Identify which state variables and RPC methods are involved.
   - Trace from UI interaction → state changes → `callFiberRpc` → node.

2. **Implement following patterns above**
   - Centralize RPC calls.
   - Use `runWithConcurrency` for multi-node work.
   - Keep state machines simple and explicit.

3. **Run automated checks**
   - `npm run build` must pass.
   - Optionally run `npm run lint` to catch style / unused variable issues.

4. **Manual sanity testing**
   - `npm run dev` then verify:
     - Adding / removing / bulk importing nodes.
     - Overview refresh and progress bar.
     - Selected node details auto刷新 + 手动刷新.
     - Payment Hash 与 Channel Outpoint 扫描、进度条与结果表.
     - RPC 调试视图调用常见方法（`node_info`, `list_peers`, `list_channels` 等）。
     - Commitment Lock：testnet/mainnet 或 custom CKB RPC 下追踪一笔交易（若环境可用）。
     - Node Control：在选中节点上试一项安全只读或测试网操作。
     - 网络拓扑：点击节点与连线，确认节点详情与通道详情面板内容与复制按钮。
     - 语言切换：中文 / EN 与刷新后持久化。

If a future change significantly modifies architecture (e.g., splitting App into multiple components or introducing a state management library), update this skill to reflect the new entry points and invariants.

