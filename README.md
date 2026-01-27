# fiber-nodes-monits

基于 React + TypeScript + Vite 的 Fiber 多节点监控面板，用于同时观察多个 Fiber 节点的 JSON-RPC
状态。通过本地 Node.js 代理统一转发到各个节点的 RPC 接口，并展示关键指标与拓扑信息。

## 功能概览

- 节点管理：
  - 单个添加 / 删除监控节点：为每个节点配置 RPC URL 与可选 Bearer token
  - 支持批量导入节点列表（适配约 300 个节点场景）
- 多节点概览（Overview）：
  - 手动点击「刷新概览」按节点发起并发 RPC 请求（默认并发数 10）
  - 展示节点在线状态（UP/DOWN）、peers 数量、channels 数量、chain_hash、延迟、最后刷新时间
  - 刷新时在卡片顶部展示总体进度条（已完成 / 总节点数）
  - 支持折叠 / 展开 Overview 区域，避免占用过多空间
- 单节点详情：
  - node_info：核心字段（version、node_id、node_name、chain_hash 等）
  - list_peers：按表格列出 peer_id / pubkey / address
  - list_channels：按表格展示 channel_id / peer_id / 状态 / 余额 / enabled
  - Pending TLCs 视图：按 channel 分组展示 pending_tlcs，包含方向、状态、金额、过期时间、转发信息等，并支持直接复制 Payment Hash
  - graph_nodes：统计节点数量、last_cursor、示例节点数据
  - graph_channels：统计通道数量、last_cursor、示例通道数据
- Payment Hash 视图：
  - 输入 Payment Hash 后，自动对所有节点的 list_channels.pending_tlcs 进行扫描
  - 使用并发（默认 10）逐节点拉取 channels，展示扫描进度条
  - 表格中展示匹配 TLC 所在节点、channel、方向、金额、过期时间、TLC 状态、转发信息等
- RPC 调试视图：
  - 选择一个节点后，可手动输入任意 Fiber JSON-RPC 方法名与 JSON 形式的 params，通过统一代理直接发起调用
  - **快捷调用**：提供常用方法的一键模板填充，包括：
    - `send_payment`（按 invoice 支付）、`send_payment (keysend)`（按目标公钥 + 金额 keysend 支付）
    - `new_invoice`、`parse_invoice`（解析编码后的 invoice 字符串）
    - `get_payment`、`open_channel`、`shutdown_channel`
  - 点击快捷按钮会填充对应 Method 与 Params 模板，用户可在 Params 中补全或修改字段后点击「调用」
  - RPC 响应区域对长 JSON 做高度与横向溢出控制：在卡片内滚动、长行自动换行，避免撑破页面
- 自动刷新与手动刷新：
  - 当前选中节点详情每 15 秒自动刷新
  - 顶部工具栏提供「刷新当前节点」按钮，随时强制拉取最新详情

所有节点配置（名称 / RPC URL / token）保存在浏览器 localStorage 中，刷新页面后依旧生效。

## 技术栈

- React 19 + TypeScript
- Vite（使用 rolldown-vite 作为打包器）
- Node.js + tsx 自定义开发 / 生产服务器
  - `server/dev.ts`：本地开发服务器，整合静态资源与 `/api/rpc` 代理
  - `server/prod.ts`：生产环境静态文件与代理服务

## 目录结构

```text
fiber-nodes-monits/
├─ server/
│  ├─ dev.ts          # 开发环境入口（npm run dev）
│  ├─ prod.ts         # 生产环境入口（npm start）
│  └─ rpcProxy.ts     # JSON-RPC 代理：/api/rpc → 节点 RPC
├─ src/
│  ├─ App.tsx         # 主页面和 UI 逻辑
│  ├─ App.css         # 页面样式
│  ├─ lib/
│  │  ├─ rpc.ts       # 前端调用 /api/rpc 的封装
│  │  ├─ storage.ts   # 节点列表的本地存储
│  │  └─ format.ts    # 展示相关的格式化工具
│  └─ main.tsx        # React 入口
└─ package.json
```

## 本地开发

前置要求：

- Node.js ≥ 18（保证原生 fetch 支持）
- 已安装 npm

克隆好主仓库后，在项目根目录执行：

```bash
cd fiber/fiber-nodes-monits
npm install
npm run dev
```

默认会在本地启动开发服务，并监听 HTTP 端口（例如 `http://127.0.0.1:5173`）。如果需要从局域网访问，
可以自行添加 `--host 0.0.0.0 --port 5173` 等参数。

## 生产构建与启动

构建静态资源和 TypeScript：

```bash
npm run build
```

使用内置的生产服务器启动：

```bash
npm start
```

如需仅预览构建后的静态资源（使用 Vite 内置 preview）：

```bash
npm run preview
```

## 如何添加监控节点

1. 打开应用页面，左侧点击「添加监控节点」
2. 在弹窗中填写：
   - **Node Name**：节点名称，可不填，留空时会根据 URL 自动生成一个短标签
   - **RPC URL**：节点 JSON-RPC 地址，例如 `http://127.0.0.1:8227`
   - **Authorization (Optional)**：可选的 Bearer token，仅填写 token 本体
3. 点击「添加并开始监控」，节点会出现在左侧列表，并自动开始拉取数据。

节点信息会保存在浏览器 localStorage 中，关闭 / 打开浏览器后仍会保留，可随时在侧边栏删除。

## 与 Fiber 节点的交互

前端通过 `/api/rpc` 调用后端代理，代理再以 JSON-RPC 2.0 请求转发到具体的 Fiber 节点 RPC 地址。
当前使用到的 RPC 方法包括：

- `node_info`
- `list_peers`
- `list_channels`（参数：`{ include_closed: true }`，用于概览统计、单节点 Channels 视图以及 Payment Hash 扫描）
- `graph_nodes`（参数：`{ limit: 0x14 }`，即 20 条）
- `graph_channels`（参数：`{ limit: 0x14 }`，即 20 条）

代理会根据前端传入的配置构造请求：

- HTTP Header 中自动加上 `Authorization: Bearer {token}`（如果配置了 token）
- 请求体为标准 JSON-RPC 包装（`jsonrpc: "2.0"`, `id`, `method`, `params`）

## 安全注意事项

- 节点 RPC URL 与 token 仅保存在本地浏览器和本地 Node.js 代理中，请避免在不可信机器上保存生产环境密钥
- 如需在公网使用该面板，建议：
  - 将代理服务放置在内网或受保护的环境中
  - 使用反向代理 / API 网关增加额外的认证层
  - 为不同环境使用不同的 token，方便随时吊销

## 常见问题

- 看不到任何数据：
  - 确认 RPC URL 可在本机 curl 访问
  - 如节点有鉴权，确认已正确配置 token
  - 打开浏览器控制台，查看是否有 `RPC响应不是JSON` 或其他错误信息
- 某个节点一直处于 DOWN 状态：
  - 检查节点本身是否存活
  - 检查网络连通性（本机到节点端口是否可达）
  - 检查是否有防火墙 / 安全组阻断请求
