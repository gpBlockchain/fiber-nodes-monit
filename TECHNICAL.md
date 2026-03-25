# fiber-nodes-monits 技术文档

本文面向开发者，介绍 Fiber 多节点监控面板的整体架构、主要数据流与关键实现点，便于二次开发和排查问题。

## 架构总览

- 前端：React + TypeScript 单页应用
  - 入口：`src/main.tsx`
  - 主界面与逻辑：`src/App.tsx`
  - 工具库：`src/lib/*.ts`
- 后端代理：Node.js + tsx
  - 开发环境入口：`server/dev.ts`
  - 生产环境入口：`server/prod.ts`
  - JSON-RPC 代理：`server/rpcProxy.ts`
- 构建工具：Vite（使用 rolldown-vite 作为打包器）

运行时数据流（简化）：

1. 用户在前端配置多个 Fiber 节点（名称、RPC URL、可选 token）
2. 节点信息持久化在浏览器 `localStorage`
3. 前端通过 `callFiberRpc`（封装在 `src/lib/rpc.ts`）对 `/api/rpc` 发起 HTTP 请求
4. Node 端 `rpcProxy.ts` 接收请求，将其转换为 JSON-RPC 2.0 请求转发到真正的 Fiber 节点
5. Fiber 节点返回 JSON-RPC 响应，经代理透传给前端
6. 前端渲染多节点概览、单节点详情、Payment Hash 视图、RPC 调试结果等

## 主要模块

### src/App.tsx

单页应用的核心组件，包含：

- 节点管理：左侧节点列表、添加 / 删除 / 批量导入
- 顶部导航：Dashboard、Payment Hash、Channel Outpoint、RPC 调试、**Commitment Lock**（链上 commitment）、**Node Control**、网络拓扑（Topology）等视图切换
- Dashboard：
  - 概览（Overview）表格
  - 选中节点详情（Node Details）
- Payment Hash 视图：跨节点扫描 `list_channels.pending_tlcs`
- Channel Outpoint 视图：跨节点扫描 `list_channels`，按 `channel_outpoint` 匹配（可部分匹配）
- RPC 调试视图：手动调用任意 Fiber JSON-RPC 方法
- Commitment Lock：`App.tsx` 内的 `CommitmentTraceView`，依赖 `src/lib/ckb.ts` 调 CKB RPC 与本地解析 / 追踪逻辑
- Node Control：选中节点后的分标签快捷 RPC 表单（`connect_peer`、`open_channel` 等）
- 网络拓扑：`src/components/NetworkTopology.tsx`（见下节）
- 国际化：`src/lib/i18n.ts`（`zh` / `en`，`I18nContext` + `useT`）

关键状态（部分）：

- `nodes: MonitoredNode[]`：当前配置的监控节点
- `summaries: Record<string, NodeSummary>`：每个节点的概览信息
- `details: NodeDetails | null`：当前选中节点的详情（node_info / peers / channels / graph_*）
- `viewMode`：当前界面模式（含 `dashboard`、`paymentSearch`、`channelOutpointSearch`、`rpcDebug`、`commitmentTrace`、`nodeControl`、`networkTopology` 等）
- `autoRefresh`：节点详情自动刷新标志（当前为常量 `true`，无可切换 UI）
- `paymentSearch*` 系列 state：Payment Hash 扫描的查询、进度与结果
- `overviewRefresh*` 系列 state：点击「刷新概览」时的进度与状态
- `channelOutpointSearch*`：Channel Outpoint 跨节点扫描的查询、进度与结果
- Commitment Lock：`ctNetwork` / `ctTxHash` / `ctTraceState` / `ctTraceItems` 等与 CKB 追踪相关的 state
- Node Control：`ncNodeInfo*` 及分标签表单 state（随选中节点拉取 `node_info` 等）

### src/lib/i18n.ts

- `Lang = 'zh' | 'en'`，默认 `zh`；持久化键 `fiber-nodes-monits:lang`
- `translations` 对象、`I18nContext`、`useT()`：组件内取文案
- 侧边栏按钮切换语言并 `saveLang`

### src/lib/rpc.ts

封装前端调用代理 `/api/rpc` 的逻辑：

- 接口：`callFiberRpc<T>(node: MonitoredNode, method: string, params?: unknown): Promise<T>`
- 主要职责：
  - 根据节点配置构造请求体（url / token）
  - 标准 JSON-RPC 2.0 请求包装（`jsonrpc` / `id` / `method` / `params`）
  - 处理 HTTP 错误、JSON 解析错误以及 JSON-RPC `error` 字段
  - 返回强类型 `result` 数据

前端所有与 Fiber 节点的交互，最终都通过此函数完成。

### src/lib/storage.ts

封装节点列表在浏览器 `localStorage` 中的持久化逻辑：

- `loadNodes(): MonitoredNode[]`：应用启动时读取历史配置
- `saveNodes(nodes: MonitoredNode[])`：节点列表变更时写回

通过统一封装，避免在组件内直接操作 `localStorage`。

### src/components/NetworkTopology.tsx

基于 **当前侧边栏选中的监控节点** 作为 RPC 数据源，分页调用 `graph_nodes` / `graph_channels`（`limit` 如 `0x64`，用 `after`/`last_cursor` 翻页直至结束），在 SVG 上用 D3 力导向布局绘制拓扑。

要点：

- 同一对节点间的多条通道在图上可**合并为一条边**（虚线表示多条）；内部结构体 `MergedLink` 保留 `underlying: TopoLink[]`，用于详情展示
- **可见边**使用较细描边且 `pointer-events: none`；在**节点图层下方**增加透明宽线作为点击命中区，避免遮挡节点拖拽与点击
- **点击节点**：设置 `selectedTopoNode`，右侧展示节点详情面板
- **点击边**：清空节点选中，设置 `selectedChannelEdge`（含两端 `node_id` 与 `underlying` 通道列表）；右侧面板按条展示 `channel_outpoint`、容量、CKB/UDT、费率，并从原始 `graph_channels` 映射中补充 `fee_rate_of_node1` / `fee_rate_of_node2`、UDT type script 等
- 节点详情与通道详情互斥；切换 CKB/UDT 筛选时会清空通道选中状态

样式见 `NetworkTopology.css`（含 `.topoChannelBlock` 等）。

### src/lib/format.ts

展示层相关的格式化工具函数，例如：

- 将十六进制数量转换为可读金额
- 将毫秒时间戳转换为本地时间字符串
- 将长字符串（node_id / channel_id / hash 等）压缩为短标签

这些函数仅负责“如何展示”，不修改业务数据。

### src/lib/ckb.ts

CKB 链交互与 **LN commitment** 解析 / 追踪：

- `callCkbRpc`：通过 **`POST /api/rpc`** 将请求转到 body 中的 CKB `url`（与 Fiber 共用同一代理，不依赖 Fiber token）
- `fetchAndParseTx`、`getLnTxTrace`、`parseLockArgs` / `parseWitness`（含 v2）等：供 Commitment Lock 视图使用
- `resolveNetworkConfig`：内置 testnet / mainnet 默认 RPC 与默认 commitment code hash；支持 custom RPC + 自定义 code hash

### server/rpcProxy.ts

Node 端的 Fiber JSON-RPC 代理：

- 暴露 HTTP 接口：`POST /api/rpc`
- 从请求体中读取：
  - `url`：目标 Fiber 节点 RPC 地址
  - `token`：可选 Bearer token
  - `method`：JSON-RPC 方法名
  - `params`：参数
- 构造并转发 JSON-RPC 2.0 请求到目标节点
- 将远端 JSON-RPC 返回的响应作为 HTTP 响应体透传给前端（不区分 Fiber 与 CKB，由 `url` 决定目标）

安全要点：

- 不在服务器端持久化任何节点配置
- token 只在当前请求的 `Authorization` 头中使用

## 关键数据流

### 1. 节点管理

1. 应用初始化时：
   - `nodes` 初始值来自 `loadNodes()`（localStorage）
2. 用户通过「添加监控节点」弹窗新增节点：
   - 生成带 `id` / `createdAt` 的 `MonitoredNode`
   - 插入到 `nodes` state 的头部
   - 同步更新 `selectedNodeId`
3. 批量导入：
   - 将待导入节点映射为 `MonitoredNode`，一次性写入 `nodes`
   - 默认选中新添加的第一个节点
4. `useEffect` 监听 `nodes` 变化：
   - 调用 `saveNodes(nodes)` 写入 localStorage

### 2. 概览刷新（Overview）

入口：左侧侧边栏的「刷新概览」按钮。

1. 点击按钮调用 `pollSummaries`
2. `pollSummaries` 使用 `runWithConcurrency(nodes, 10, fetchNodeSummary)`：
   - 控制同时对最多 10 个节点发起 `node_info` / `list_peers` / `list_channels` 调用
   - 每完成一个节点，更新 `overviewRefreshProgress.completed`
3. 所有节点完成后：
   - 将结果合并进 `summaries`，键为节点 id
   - 将 `overviewRefreshState` 置为 `idle`
4. UI 层：
   - 概览卡片顶部展示进度条（completed / total + 百分比）
   - 表格中按节点展示状态、peers / channels 数量、chain_hash、延迟、更新时间

并发控制目的：

- 避免一次性对所有节点同时发起请求造成网络 / 节点压力
- 在节点数量较多（数百）时保持前端可用性

### 3. 单节点详情刷新

入口：

- 选中左侧某个节点（点击节点卡片）
- 顶部「刷新当前节点」按钮
- 定时器（每 15 秒自动刷新）

流程：

1. 根据 `selectedNodeId` 找到当前选中节点
2. 调用 `fetchNodeDetails(node)`：
   - 并行发起：
     - `node_info`
     - `list_peers`
     - `list_channels`（`include_closed: true`）
     - `graph_nodes`（`limit: 0x14`）
     - `graph_channels`（`limit: 0x14`）
   - 将返回值规范化为 `NodeDetails`：
     - `peers` / `channels` 统一映射为对象数组
3. 将结果写入 `details`，并更新 `detailsState`
4. `useMemo` 基于 `details` 计算各种派生视图：
   - Channels 表格
   - Pending TLCs 视图
   - 可选的 channel 状态过滤项等

自动刷新：

- 使用自定义 Hook `useInterval`，当存在 `selectedNode` 时每 15 秒调用一次 `refreshDetails`

### 4. Pending TLCs 视图

依赖：`details.channels`

1. 从 `details.channels` 中取出每个 channel
2. 解析：
   - `channel_id` → 短 ID
   - `state` → 文本标签
   - `pending_tlcs` → 遍历每个 TLC
3. 对每个 TLC 提取：
   - `id` / amount / expiry / status / direction
   - `payment_hash`
   - `forwarding_channel_id` / `forwarding_tlc_id`
4. 生成行数据，用于表格展示：
   - 每行包含 channel 信息 + TLC 信息
   - Payment Hash 字段可一键复制

### 5. Payment Hash 视图（跨节点扫描）

入口：顶部导航切换到「Payment Hash」视图。

1. 用户输入 Payment Hash 并点击「扫描 pending_tlcs」
2. 前端调用 `runPaymentSearch`：
   - 使用 `runWithConcurrency(nodes, 10, fn)` 控制并发
   - `fn` 对每个节点执行：
     - 调用 `list_channels`（`include_closed: true`）
     - 遍历所有 channel 的 `pending_tlcs`
     - 按 `payment_hash` 精确匹配
     - 生成 `PaymentSearchMatch` 结果
   - 每完成一个节点，更新 `paymentSearchProgress.completed`
3. 将所有节点结果合并为一个扁平数组，写入 `paymentSearchResults`
4. UI 层：
   - 顶部展示扫描进度条（已完成节点 / 总节点数）
   - 表格展示匹配结果，按节点、channel、方向、金额、过期时间等字段排列

### 6. Channel Outpoint 视图（跨节点扫描）

与 Payment Hash 模式相同：

1. 用户输入 outpoint 字符串并触发扫描
2. `runChannelOutpointSearch`（逻辑在 `App.tsx`）使用 `runWithConcurrency(nodes, 10, fn)`
3. 每个节点调用 `list_channels`（`include_closed: true`），将 `channel_outpoint` 规范为字符串后与查询做**子串 / 部分匹配**
4. 进度条与结果表结构与 Payment Hash 扫描对称

### 7. RPC 调试视图

入口：顶部导航切换到「RPC 调试」，并在左侧选中一个节点。

1. 用户输入：
   - `Method`：JSON-RPC 方法名（例如 `node_info`）
   - `Params (JSON)`：JSON 字符串，解析为 `params`
2. 点击「调用」后：
   - 验证 params 是否为合法 JSON
   - 调用 `callFiberRpc(selectedNode, method, parsedParams)`
3. 使用统一的 `rpcState` / `rpcResponse` 控制加载中、成功、失败状态
4. 将结果以格式化 JSON 字符串展示在文本区域中，方便复制 / 调试

### 8. Commitment Lock 视图

1. 用户选择 CKB 网络（testnet / mainnet / custom）并可选自定义 RPC、commitment code hash
2. 输入链上交易哈希后触发 `onFetchTrace`：
   - 通过 `ckb.ts` 的 `callCkbRpc` 拉取交易，解析 lock args 与 witness
   - 调用 `getLnTxTrace` 生成逐步追踪列表，更新 `ctTraceItems` / `ctTraceState`
3. 支持在未拉取交易的情况下，手动粘贴 lock args + witness 做本地解析（v1 / v2）

### 9. Node Control 视图

1. 依赖 `selectedNode`；进入视图或切换节点时拉取 `node_info` 展示概要
2. 各标签页组装参数并调用 `callFiberRpc(selectedNode, method, params)`
3. 操作结果在面板内展示（成功 / 错误信息），具体字段与各 RPC 方法一致

## 扩展与修改建议

1. 新增 RPC 视图或统计指标时：
   - 优先在现有 `callFiberRpc` 基础上扩展
   - 将纯展示逻辑放在 `App.tsx` 或拆分出的组件中
2. 调整并发策略：
   - 如需提高 / 降低并发，只需修改 `runWithConcurrency` 的第二个参数
   - 也可以引入配置项，从 UI 或环境变量中读取
3. 安全强化：
   - 如需接入生产环境，可在 `rpcProxy.ts` 之前增加反向代理层做额外认证
   - 建议在代理层限制可调用的 JSON-RPC 方法名单

如需针对某一处逻辑进行更细粒度的说明，可以在本文件中根据模块继续拆分小节。

