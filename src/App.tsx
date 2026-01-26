import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { hexToNumberMaybe, formatJson, isHttpUrl, safeUrlLabel, shorten } from './lib/format'
import { loadNodes, saveNodes, type MonitoredNode } from './lib/storage'
import { callFiberRpc } from './lib/rpc'

type JsonObj = Record<string, unknown>

function asObj(value: unknown): JsonObj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as JsonObj
}

function getString(obj: JsonObj, key: string): string | null {
  const v = obj[key]
  return typeof v === 'string' ? v : null
}

function getArray(obj: JsonObj, key: string): unknown[] | null {
  const v = obj[key]
  return Array.isArray(v) ? v : null
}

function formatAmountWithHex(value: unknown): string {
  const hex = typeof value === 'string' ? value : null
  const dec = hexToNumberMaybe(value)
  if (dec != null) {
    return hex ? `${dec} (${hex})` : String(dec)
  }
  if (value == null) return '—'
  return String(value)
}

function hexMillisToLocalTimeLabel(value: unknown): string {
  const ms = hexToNumberMaybe(value)
  if (ms == null) return '—'
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString()
}

function parseTlcStatus(value: unknown): { direction: string; label: string } {
  if (typeof value === 'string') {
    return { direction: '未知', label: value }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { direction: '未知', label: '未知' }
  }
  const obj = value as JsonObj
  const keys = Object.keys(obj)
  if (!keys.length) return { direction: '未知', label: '未知' }
  const dirKey = keys[0]
  const direction =
    dirKey === 'Outbound' ? '出站' : dirKey === 'Inbound' ? '入站' : dirKey
  const inner = obj[dirKey]

  if (typeof inner === 'string') {
    const code = inner
    if (dirKey === 'Outbound') {
      if (code === 'LocalAnnounced') return { direction, label: '已创建，等待对端确认' }
      if (code === 'Committed') return { direction, label: '已提交，等待后续结果' }
      if (code === 'RemoteRemoved') return { direction, label: '已被对端移除' }
      if (code === 'RemoveWaitPrevAck') return { direction, label: '移除中，等待前一个 ACK' }
      if (code === 'RemoveWaitAck') return { direction, label: '移除中，等待 ACK 确认' }
      if (code === 'RemoveAckConfirmed') return { direction, label: '移除已确认' }
    }
    if (dirKey === 'Inbound') {
      if (code === 'RemoteAnnounced') return { direction, label: '对端已创建，等待本地提交' }
      if (code === 'AnnounceWaitPrevAck') return { direction, label: '创建中，等待前一个 ACK' }
      if (code === 'AnnounceWaitAck') return { direction, label: '创建中，等待 ACK 确认' }
      if (code === 'Committed') return { direction, label: '已提交，等待后续结果' }
      if (code === 'LocalRemoved') return { direction, label: '本地已移除，等待 ACK' }
      if (code === 'RemoveAckConfirmed') return { direction, label: '移除已确认' }
    }
    return { direction, label: code }
  }

  if (!inner || typeof inner !== 'object') {
    return { direction, label: direction }
  }
  const innerObj = asObj(inner)
  const state = innerObj.state
  if (typeof state === 'string') {
    return { direction, label: state }
  }
  return { direction, label: direction }
}

type NodeSummary = {
  nodeId: string
  ok: boolean
  updatedAt: number
  latencyMs: number
  nodeInfo?: JsonObj
  peersCount?: number
  channelsCount?: number
  error?: string
}

type NodeDetails = {
  fetchedAt: number
  nodeInfo: JsonObj
  peers: JsonObj[]
  channels: JsonObj[]
  graphNodes: { nodes: JsonObj[]; last_cursor?: unknown }
  graphChannels: { channels: JsonObj[]; last_cursor?: unknown }
}

type PaymentSearchMatch = {
  nodeName: string
  nodeId: string
  rpcUrl: string
  channelIdShort: string
  channelStateLabel: string
  tlcId: string
  amountLabel: string
  expiryLabel: string
  directionLabel: string
  statusLabel: string
  forwardingLabel: string | null
  isExpired: boolean
  expiryVal: number
}

type ChannelOutpointSearchMatch = {
  nodeName: string
  nodeId: string
  rpcUrl: string
  channelIdShort: string
  channelId: string
  channelStateLabel: string
  channelOutpoint: string
  peerId: string
  isPublic: boolean
  localBalance: string
  remoteBalance: string
  enabled: boolean
  createdAt: string
}



function useInterval(callback: () => void, delay: number | null) {
  const callbackRef = useRef(callback)
  useEffect(() => {
    callbackRef.current = callback
  }, [callback])

  useEffect(() => {
    if (delay == null) return
    const id = window.setInterval(() => callbackRef.current(), delay)
    return () => window.clearInterval(id)
  }, [delay])
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0
  let active = 0

  return new Promise((resolve, reject) => {
    if (!items.length) {
      resolve(results)
      return
    }

    const runNext = () => {
      if (nextIndex >= items.length) {
        if (active === 0) {
          resolve(results)
        }
        return
      }

      const currentIndex = nextIndex
      nextIndex += 1
      active += 1

      fn(items[currentIndex], currentIndex)
        .then((res) => {
          results[currentIndex] = res
        })
        .catch((err) => {
          reject(err)
        })
        .finally(() => {
          active -= 1
          runNext()
        })
    }

    const initial = Math.min(concurrency, items.length)
    for (let i = 0; i < initial; i += 1) {
      runNext()
    }
  })
}

async function fetchNodeSummary(node: MonitoredNode): Promise<NodeSummary> {
  const started = performance.now()
  try {
    const nodeInfo = await callFiberRpc<JsonObj>(node, 'node_info')
    const peers = await callFiberRpc<{ peers: unknown[] }>(node, 'list_peers')
    const channels = await callFiberRpc<{ channels: unknown[] }>(node, 'list_channels', {
      include_closed: true,
    })

    const peersCount = peers?.peers?.length ?? 0
    const channelsCount = channels?.channels?.length ?? 0
    const latencyMs = Math.max(0, Math.round(performance.now() - started))

    return {
      nodeId: node.id,
      ok: true,
      updatedAt: Date.now(),
      latencyMs,
      nodeInfo,
      peersCount,
      channelsCount,
    }
  } catch (err) {
    const latencyMs = Math.max(0, Math.round(performance.now() - started))
    return {
      nodeId: node.id,
      ok: false,
      updatedAt: Date.now(),
      latencyMs,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

async function fetchNodeDetails(node: MonitoredNode): Promise<NodeDetails> {
  const [nodeInfo, peersRes, channelsRes, graphNodes, graphChannels] = await Promise.all([
    callFiberRpc<JsonObj>(node, 'node_info'),
    callFiberRpc<{ peers: unknown[] }>(node, 'list_peers'),
    callFiberRpc<{ channels: unknown[] }>(node, 'list_channels', { include_closed: true }),
    callFiberRpc<{ nodes: unknown[]; last_cursor?: unknown }>(node, 'graph_nodes', { limit: "0x14" }),
    callFiberRpc<{ channels: unknown[]; last_cursor?: unknown }>(node, 'graph_channels', { limit: "0x14" }),
  ])

  return {
    fetchedAt: Date.now(),
    nodeInfo,
    peers: (peersRes?.peers ?? []).map(asObj),
    channels: (channelsRes?.channels ?? []).map(asObj),
    graphNodes: {
      nodes: (graphNodes?.nodes ?? []).map(asObj),
      last_cursor: graphNodes?.last_cursor,
    },
    graphChannels: {
      channels: (graphChannels?.channels ?? []).map(asObj),
      last_cursor: graphChannels?.last_cursor,
    },
  }
}

function copyToClipboard(text: string) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch((err) => {
      console.error('Clipboard write failed, trying fallback:', err)
      fallbackCopy(text)
    })
  } else {
    fallbackCopy(text)
  }
}

function fallbackCopy(text: string) {
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    document.body.removeChild(textarea)
  } catch (err) {
    console.error('Fallback copy failed:', err)
    alert('复制失败，请手动复制')
  }
}

function App() {
  const [nodes, setNodes] = useState<MonitoredNode[]>(() => loadNodes())
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(
    nodes[0]?.id ?? null,
  )
  const [summaries, setSummaries] = useState<Record<string, NodeSummary>>({})
  const [details, setDetails] = useState<NodeDetails | null>(null)
  const [detailsState, setDetailsState] = useState<
    { status: 'idle' | 'loading' | 'ready' | 'error'; error?: string }
  >({ status: 'idle' })
  const [modalOpen, setModalOpen] = useState(false)
  const [autoRefresh] = useState(true)
  const [overviewRefreshState, setOverviewRefreshState] = useState<{
    status: 'idle' | 'refreshing' | 'error'
    error?: string
  }>({ status: 'idle' })
  const [overviewRefreshProgress, setOverviewRefreshProgress] = useState<{
    completed: number
    total: number
  }>({
    completed: 0,
    total: 0,
  })
  const [expandedChannels, setExpandedChannels] = useState<Set<string>>(new Set())
  const [viewMode, setViewMode] = useState<'dashboard' | 'paymentSearch' | 'rpcDebug' | 'channelOutpointSearch'>('dashboard')
  const [isOverviewCollapsed, setIsOverviewCollapsed] = useState(false)
  const [channelStateFilter, setChannelStateFilter] = useState<string>('ALL')
  const [paymentHashQuery, setPaymentHashQuery] = useState('')
  const [paymentSearchState, setPaymentSearchState] = useState<{
    status: 'idle' | 'searching' | 'done' | 'error';
    error?: string
  }>({ status: 'idle' })
  const [paymentSearchProgress, setPaymentSearchProgress] = useState<{
    completed: number;
    total: number
  }>({
    completed: 0,
    total: 0,
  })
  const [paymentSearchResults, setPaymentSearchResults] = useState<PaymentSearchMatch[]>([])
  const [channelOutpointQuery, setChannelOutpointQuery] = useState('')
  const [channelOutpointSearchState, setChannelOutpointSearchState] = useState<{
    status: 'idle' | 'searching' | 'done' | 'error';
    error?: string
  }>({ status: 'idle' })
  const [channelOutpointSearchProgress, setChannelOutpointSearchProgress] = useState<{
    completed: number;
    total: number
  }>({
    completed: 0,
    total: 0,
  })
  const [channelOutpointSearchResults, setChannelOutpointSearchResults] = useState<ChannelOutpointSearchMatch[]>([])
  const [rpcMethod, setRpcMethod] = useState('node_info')
  const [rpcParams, setRpcParams] = useState('{}')
  const [rpcState, setRpcState] = useState<'idle' | 'pending' | 'success' | 'error'>('idle')
  const [rpcResponse, setRpcResponse] = useState('')

  const toggleChannel = (id: string) => {
    setExpandedChannels((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  useEffect(() => {
    saveNodes(nodes)
  }, [nodes])

  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId],
  )

  const selectedSummary = selectedNode ? summaries[selectedNode.id] : undefined

  const onlinePeerIds = useMemo(() => {
    const ids = new Set<string>()
    if (details?.peers) {
      for (const p of details.peers) {
        const id = getString(p, 'peer_id')
        if (id) ids.add(id)
      }
    }
    return ids
  }, [details?.peers])

  const pollSummaries = useCallback(async () => {
    if (!nodes.length) return
    setOverviewRefreshState({ status: 'refreshing' })
    setOverviewRefreshProgress({
      completed: 0,
      total: nodes.length,
    })
    try {
      const results = await runWithConcurrency(
        nodes,
        10,
        async (n: MonitoredNode) => {
          const res = await fetchNodeSummary(n)
          setOverviewRefreshProgress((prev) => ({
            completed: Math.min(prev.completed + 1, prev.total),
            total: prev.total,
          }))
          return res
        },
      )
      setSummaries((prev) => {
        const next = { ...prev }
        for (const r of results) next[r.nodeId] = r
        return next
      })
      setOverviewRefreshState({ status: 'idle' })
    } catch (err) {
      setOverviewRefreshState({
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }, [nodes])

  const refreshDetails = useCallback(async () => {
    if (!selectedNode) return
    setDetailsState({ status: 'loading' })
    try {
      const next = await fetchNodeDetails(selectedNode)
      setDetails(next)
      setDetailsState({ status: 'ready' })
    } catch (err) {
      setDetails(null)
      setDetailsState({
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }, [selectedNode])

  useEffect(() => {
    const t = window.setTimeout(() => {
      void refreshDetails()
    }, 0)
    return () => window.clearTimeout(t)
  }, [refreshDetails])

  useInterval(
    () => {
      if (!autoRefresh) return
      void refreshDetails()
    },
    selectedNode ? 15_000 : null,
  )

  const removeNode = (nodeId: string) => {
    setNodes((prev) => {
      const next = prev.filter((n) => n.id !== nodeId)
      if (selectedNodeId === nodeId) {
        setSelectedNodeId(next[0]?.id ?? null)
      }
      return next
    })
  }

  const addNode = (node: Omit<MonitoredNode, 'id' | 'createdAt'>) => {
    const newNode: MonitoredNode = {
      id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
      name: node.name.trim(),
      rpcUrl: node.rpcUrl.trim(),
      token: node.token?.trim() ? node.token.trim() : undefined,
      createdAt: Date.now(),
    }
    setNodes((prev) => [newNode, ...prev])
    setSelectedNodeId(newNode.id)
  }

  const addNodesBulk = (nodesToAdd: Omit<MonitoredNode, 'id' | 'createdAt'>[]) => {
    if (!nodesToAdd.length) return
    const now = Date.now()
    const newNodes: MonitoredNode[] = nodesToAdd.map((node) => ({
      id: globalThis.crypto?.randomUUID?.() ?? `${now}-${Math.random()}`,
      name: node.name.trim(),
      rpcUrl: node.rpcUrl.trim(),
      token: node.token?.trim() ? node.token.trim() : undefined,
      createdAt: now,
    }))
    setNodes((prev) => [...newNodes, ...prev])
    setSelectedNodeId(newNodes[0]?.id ?? null)
  }

  const overviewRows = useMemo(() => {
    return nodes.map((n) => {
      const s = summaries[n.id]
      const info = asObj(s?.nodeInfo)
      const peersCount =
        s?.peersCount ??
        (hexToNumberMaybe(info['peers_count']) ?? (getArray(info, 'peers')?.length ?? 0))
      const channelsCount =
        s?.channelsCount ??
        (hexToNumberMaybe(info['channel_count']) ?? (getArray(info, 'channels')?.length ?? 0))
      return {
        node: n,
        summary: s,
        peersCount,
        channelsCount,
      }
    })
  }, [nodes, summaries])

  const overviewRefreshPercent =
    overviewRefreshProgress.total > 0
      ? Math.round((overviewRefreshProgress.completed / overviewRefreshProgress.total) * 100)
      : 0

  const channelStateOptions = useMemo(() => {
    if (!details?.channels?.length) return []
    const set = new Set<string>()
    for (const c of details.channels) {
      const info = asObj(c)
      const label = formatJson(info.state ?? '—')
      if (label !== '—') set.add(label)
    }
    return Array.from(set).sort()
  }, [details])

  const pendingTlcRows = useMemo(() => {
    if (!details?.channels?.length) return []
    const now = Date.now()
    const rows: {
      channelIdShort: string
      channelStateLabel: string
      tlcId: string
      amountLabel: string
      expiryLabel: string
      directionLabel: string
      statusLabel: string
      paymentHashLabel: string
      paymentHashRaw: string | null
      forwardingLabel: string | null
      expiryVal: number
      isExpired: boolean
    }[] = []
    for (const channel of details.channels) {
      const chObj = asObj(channel)
      const channelIdRaw = chObj.channel_id
      const channelIdShort =
        typeof channelIdRaw === 'string' ? shorten(channelIdRaw, 10, 8) : '—'
      const channelStateLabel = formatJson(chObj.state ?? '—')
      const pending = getArray(chObj, 'pending_tlcs') ?? []
      for (const item of pending) {
        const tlc = asObj(item)
        const tlcIdRaw = tlc.id
        const tlcId =
          typeof tlcIdRaw === 'string' || typeof tlcIdRaw === 'number'
            ? String(tlcIdRaw)
            : formatJson(tlcIdRaw ?? '—')
        const amountLabel = formatAmountWithHex(tlc.amount)
        const expiryLabel = hexMillisToLocalTimeLabel(tlc.expiry)
        const expiryVal = hexToNumberMaybe(tlc.expiry) ?? 0
        const isExpired = expiryVal > 0 && expiryVal < now
        const paymentHashRaw = tlc.payment_hash
        const paymentHashLabel =
          typeof paymentHashRaw === 'string'
            ? shorten(paymentHashRaw, 12, 10)
            : formatJson(paymentHashRaw ?? '—')
        const forwardingChannelRaw = tlc.forwarding_channel_id
        const forwardingTlcIdRaw = tlc.forwarding_tlc_id
        const forwardingParts: string[] = []
        if (forwardingChannelRaw) {
          const label =
            typeof forwardingChannelRaw === 'string'
              ? shorten(forwardingChannelRaw, 10, 8)
              : String(forwardingChannelRaw)
          forwardingParts.push(label)
        }
        if (forwardingTlcIdRaw != null) {
          forwardingParts.push(`#${String(forwardingTlcIdRaw)}`)
        }
        const forwardingLabel = forwardingParts.length ? forwardingParts.join(' · ') : null
        const statusInfo = parseTlcStatus(tlc.status)
        rows.push({
          channelIdShort,
          channelStateLabel,
          tlcId,
          amountLabel,
          expiryLabel,
          directionLabel: statusInfo.direction,
          statusLabel: statusInfo.label,
          paymentHashLabel,
          paymentHashRaw: typeof paymentHashRaw === 'string' ? paymentHashRaw : null,
          forwardingLabel,
          expiryVal,
          isExpired,
        })
      }
    }
    // Sort: expiry (desc), then direction (Inbound first)
    rows.sort((a, b) => {
      if (a.expiryVal !== b.expiryVal) {
        return b.expiryVal - a.expiryVal
      }
      // '入站' (Inbound) should come before '出站' (Outbound)
      const dirA = a.directionLabel === '入站' ? 0 : 1
      const dirB = b.directionLabel === '入站' ? 0 : 1
      return dirA - dirB
    })
    return rows
  }, [details])

  const groupedPendingTlcs = useMemo(() => {
    const groups: Record<string, typeof pendingTlcRows> = {}
    for (const row of pendingTlcRows) {
      const key = row.paymentHashRaw ?? 'unknown'
      if (!groups[key]) {
        groups[key] = []
      }
      groups[key].push(row)
    }
    return groups
  }, [pendingTlcRows])

  const totalPendingTlcs = pendingTlcRows.length

  const progressPercent = paymentSearchProgress.total
    ? Math.round((paymentSearchProgress.completed / paymentSearchProgress.total) * 100)
    : 0

  const runPaymentSearch = useCallback(async () => {
    const query = paymentHashQuery.trim()
    if (!query || !nodes.length) return

    setPaymentSearchState({ status: 'searching' })
    setPaymentSearchProgress({
      completed: 0,
      total: nodes.length,
    })
    setPaymentSearchResults([])

    try {
      const perNode = await runWithConcurrency(
        nodes,
        10,
        async (node: MonitoredNode) => {
        const res = await callFiberRpc<{ channels: unknown[] }>(node, 'list_channels', {
          include_closed: true,
        })
        const channels = Array.isArray(res?.channels) ? res.channels : []
        const matches: PaymentSearchMatch[] = []

        for (const channel of channels) {
          const chObj = asObj(channel)
          const channelIdRaw = chObj.channel_id
          const channelIdShort =
            typeof channelIdRaw === 'string' ? shorten(channelIdRaw, 10, 8) : '—'
          const channelStateLabel = formatJson(chObj.state ?? '—')
          const pending = getArray(chObj, 'pending_tlcs') ?? []
          for (const item of pending) {
            const tlc = asObj(item)
            const paymentHashRaw = tlc.payment_hash
            if (typeof paymentHashRaw !== 'string') continue
            if (paymentHashRaw.toLowerCase() !== query.toLowerCase()) continue

            const tlcIdRaw = tlc.id
            const tlcId =
              typeof tlcIdRaw === 'string' || typeof tlcIdRaw === 'number'
                ? String(tlcIdRaw)
                : formatJson(tlcIdRaw ?? '—')
            const amountLabel = formatAmountWithHex(tlc.amount)
            const expiryLabel = hexMillisToLocalTimeLabel(tlc.expiry)
            const expiryVal = hexToNumberMaybe(tlc.expiry) ?? 0
            const isExpired = expiryVal > 0 && expiryVal < Date.now()
            const statusInfo = parseTlcStatus(tlc.status)

            const forwardingChannelRaw = tlc.forwarding_channel_id
            const forwardingTlcIdRaw = tlc.forwarding_tlc_id
            const forwardingParts: string[] = []
            if (forwardingChannelRaw) {
              const label =
                typeof forwardingChannelRaw === 'string'
                  ? shorten(forwardingChannelRaw, 10, 8)
                  : String(forwardingChannelRaw)
              forwardingParts.push(label)
            }
            if (forwardingTlcIdRaw != null) {
              forwardingParts.push(`#${String(forwardingTlcIdRaw)}`)
            }
            const forwardingLabel = forwardingParts.length ? forwardingParts.join(' · ') : null

            matches.push({
              nodeName: node.name,
              nodeId: node.id,
              rpcUrl: node.rpcUrl,
              channelIdShort,
              channelStateLabel,
              tlcId,
              amountLabel,
              expiryLabel,
              directionLabel: statusInfo.direction,
              statusLabel: statusInfo.label,
              forwardingLabel,
              isExpired,
              expiryVal,
            })
          }
        }

        setPaymentSearchProgress((prev) => ({
          completed: prev.completed + 1,
          total: nodes.length,
        }))

          return matches
        },
      )

      const flat = perNode.flat()
      
      // Sort: expiry (desc), then direction (Outbound first)
      flat.sort((a, b) => {
        if (a.expiryVal !== b.expiryVal) {
          return b.expiryVal - a.expiryVal
        }
        const dirA = a.directionLabel === '出站' ? 0 : 1
        const dirB = b.directionLabel === '出站' ? 0 : 1
        return dirA - dirB
      })

      setPaymentSearchResults(flat)
      setPaymentSearchState({ status: 'done' })
    } catch (err) {
      setPaymentSearchState({
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }, [nodes, paymentHashQuery])

  const runChannelOutpointSearch = useCallback(async () => {
    const query = channelOutpointQuery.trim()
    if (!query || !nodes.length) return

    setChannelOutpointSearchState({ status: 'searching' })
    setChannelOutpointSearchProgress({
      completed: 0,
      total: nodes.length,
    })
    setChannelOutpointSearchResults([])

    try {
      const perNode = await runWithConcurrency(
        nodes,
        10,
        async (node: MonitoredNode) => {
          const res = await callFiberRpc<{ channels: unknown[] }>(node, 'list_channels', {
            include_closed: true,
          })
          const channels = Array.isArray(res?.channels) ? res.channels : []
          const matches: ChannelOutpointSearchMatch[] = []

          for (const channel of channels) {
            const chObj = asObj(channel)
            const channelOutpointRaw = chObj.channel_outpoint
            if (!channelOutpointRaw) continue
            
            // 支持完整匹配或部分匹配（不区分大小写）
            const outpointStr = typeof channelOutpointRaw === 'string' 
              ? channelOutpointRaw 
              : formatJson(channelOutpointRaw)
            
            if (!outpointStr.toLowerCase().includes(query.toLowerCase())) continue

            const channelIdRaw = chObj.channel_id
            const channelId = typeof channelIdRaw === 'string' ? channelIdRaw : formatJson(channelIdRaw ?? '—')
            const channelIdShort =
              typeof channelIdRaw === 'string' ? shorten(channelIdRaw, 10, 8) : '—'
            const channelStateLabel = formatJson(chObj.state ?? '—')
            const peerId = String(chObj.peer_id ?? '—')
            const isPublic = chObj.is_public === true
            const localBalance = formatAmountWithHex(chObj.local_balance)
            const remoteBalance = formatAmountWithHex(chObj.remote_balance)
            const enabled = typeof chObj.enabled === 'boolean' ? chObj.enabled : false
            const createdAt = hexMillisToLocalTimeLabel(chObj.created_at)

            matches.push({
              nodeName: node.name,
              nodeId: node.id,
              rpcUrl: node.rpcUrl,
              channelIdShort,
              channelId,
              channelStateLabel,
              channelOutpoint: outpointStr,
              peerId,
              isPublic,
              localBalance,
              remoteBalance,
              enabled,
              createdAt,
            })
          }

          setChannelOutpointSearchProgress((prev) => ({
            completed: prev.completed + 1,
            total: nodes.length,
          }))

          return matches
        },
      )

      const flat = perNode.flat()
      
      // Sort by node name, then by channel ID
      flat.sort((a, b) => {
        if (a.nodeName !== b.nodeName) {
          return a.nodeName.localeCompare(b.nodeName)
        }
        return a.channelId.localeCompare(b.channelId)
      })

      setChannelOutpointSearchResults(flat)
      setChannelOutpointSearchState({ status: 'done' })
    } catch (err) {
      setChannelOutpointSearchState({
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }, [nodes, channelOutpointQuery])

  const runRpcCall = useCallback(async () => {
    if (!selectedNode) return
    const method = rpcMethod.trim()
    if (!method) return

    let parsedParams: unknown
    const raw = rpcParams.trim()
    if (raw) {
      try {
        parsedParams = JSON.parse(raw) as unknown
      } catch (err) {
        setRpcState('error')
        setRpcResponse(
          `参数 JSON 解析失败: ${err instanceof Error ? err.message : String(err)}`,
        )
        return
      }
    }

    setRpcState('pending')
    setRpcResponse('')

    try {
      const result = await callFiberRpc<unknown>(selectedNode, method, parsedParams)
      setRpcState('success')
      setRpcResponse(formatJson(result))
    } catch (err) {
      setRpcState('error')
      setRpcResponse(err instanceof Error ? err.message : String(err))
    }
  }, [selectedNode, rpcMethod, rpcParams])

  return (
    <div className="appShell">
      <aside className="side">
        <div className="brand">
          <div className="brandTitle">FIBER MONITOR</div>
          <div className="brandSubtitle">多节点监控 · JSON-RPC 观测台</div>
        </div>

        <div className="sideActions">
          <button className="btn" onClick={() => setModalOpen(true)}>
            <span>＋</span>
            <span>添加监控节点</span>
          </button>
          <button
            className="btn btnGhost"
            onClick={() => void pollSummaries()}
            disabled={!nodes.length || overviewRefreshState.status === 'refreshing'}
          >
            刷新概览
          </button>
        </div>

        <div className="nodeList">
          {nodes.length === 0 ? (
            <div className="dangerRow">
              <div>
                <div style={{ fontWeight: 600, fontSize: 12 }}>未添加任何节点</div>
                <div className="smallNote">先添加 RPC 地址，然后系统会拉取 node_info / list_channels / list_peers / graph_*。</div>
              </div>
              <button className="btn" onClick={() => setModalOpen(true)}>
                添加
              </button>
            </div>
          ) : null}

          {nodes.map((n) => {
            const s = summaries[n.id]
            const active = n.id === selectedNodeId
            return (
              <div
                key={n.id}
                className={`nodeCard ${active ? 'nodeCardActive' : ''}`}
                onClick={() => setSelectedNodeId(n.id)}
                role="button"
                tabIndex={0}
              >
                <div className={`dot ${s?.ok ? 'dotOk' : s ? 'dotBad' : ''}`} />
                <div className="nodeMeta">
                  <div className="nodeNameRow">
                    <div className="nodeName">{n.name}</div>
                    {s ? (
                      <span className={`pill ${s.ok ? 'pillOk' : 'pillBad'}`}>
                        {s.ok ? 'UP' : 'DOWN'}
                      </span>
                    ) : (
                      <span className="pill">…</span>
                    )}
                  </div>
                  <div className="nodeUrl">{n.rpcUrl}</div>
                </div>
                <div style={{ display: 'grid', gap: 8, justifyItems: 'end' }}>
                  <span className="badge">{safeUrlLabel(n.rpcUrl)}</span>
                  <button
                    className="btn btnGhost"
                    onClick={(e) => {
                      e.stopPropagation()
                      removeNode(n.id)
                    }}
                    style={{ padding: '6px 10px', borderRadius: 12 }}
                  >
                    删除
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <div className="titleBlock">
            <div className="title">NODES DASHBOARD</div>
            <div className="subtitle">
              通过代理接口调用 Fiber JSON-RPC：node_info · list_peers · list_channels · graph_nodes · graph_channels
            </div>
          </div>
          <div className="mainActions">
            <div style={{ display: 'flex', gap: 8, marginRight: 12 }}>
              <button
                className={viewMode === 'dashboard' ? 'btn' : 'btn btnGhost'}
                onClick={() => setViewMode('dashboard')}
              >
                Dashboard
              </button>
              <button
                className={viewMode === 'paymentSearch' ? 'btn' : 'btn btnGhost'}
                onClick={() => setViewMode('paymentSearch')}
              >
                Payment Hash
              </button>
              <button
                className={viewMode === 'channelOutpointSearch' ? 'btn' : 'btn btnGhost'}
                onClick={() => setViewMode('channelOutpointSearch')}
              >
                Channel Outpoint
              </button>
              <button
                className={viewMode === 'rpcDebug' ? 'btn' : 'btn btnGhost'}
                onClick={() => setViewMode('rpcDebug')}
              >
                RPC 调试
              </button>
            </div>
            {viewMode === 'dashboard' ? (
              <button
                className="btn"
                onClick={() => void refreshDetails()}
                disabled={!selectedNode}
              >
                刷新当前节点
              </button>
            ) : null}
          </div>
        </div>

        {viewMode === 'dashboard' ? (
          <div className="layout">
          <section className="card">
            <div className="cardHeader">
              <div className="cardTitle">Overview</div>
              <div className="muted">{overviewRows.length} nodes</div>
              <button
                className="btn btnGhost"
                onClick={() => setIsOverviewCollapsed((v) => !v)}
                style={{ padding: '6px 10px', borderRadius: 12 }}
              >
                {isOverviewCollapsed ? '展开' : '收起'}
              </button>
            </div>
            <div className="cardBody" style={{ padding: 0 }}>
              {overviewRefreshState.status === 'refreshing' ||
              overviewRefreshProgress.completed > 0 ? (
                <div style={{ padding: 12, paddingBottom: 0 }}>
                  <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
                    概览刷新进度：{overviewRefreshProgress.completed}/
                    {overviewRefreshProgress.total} ({overviewRefreshPercent}%)
                  </div>
                  <div
                    style={{
                      width: '100%',
                      height: 6,
                      borderRadius: 999,
                      background: 'rgba(255,255,255,0.06)',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        width: `${overviewRefreshPercent}%`,
                        height: '100%',
                        background:
                          'linear-gradient(90deg, rgba(124,255,214,0.9), rgba(138,125,255,0.9))',
                        transition: 'width 160ms ease',
                      }}
                    />
                  </div>
                </div>
              ) : null}
              {isOverviewCollapsed ? (
                <div className="muted" style={{ padding: 12 }}>
                  概览已折叠，点击「{isOverviewCollapsed ? '展开' : '收起'}」按钮查看。
                </div>
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Node</th>
                      <th>Status</th>
                      <th>Node ID</th>
                      <th>RPC</th>
                      <th>Peers</th>
                      <th>Channels</th>
                      <th>Addresses</th>
                      <th>Chain Hash</th>
                      <th>Latency</th>
                      <th>Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overviewRows.map(({ node, summary, peersCount, channelsCount }) => {
                      const chainHash = getString(asObj(summary?.nodeInfo), 'chain_hash')
                      const nodeId = getString(asObj(summary?.nodeInfo), 'node_id')
                      return (
                        <tr key={node.id}>
                          <td>
                            <div style={{ display: 'grid', gap: 4 }}>
                              <span style={{ fontWeight: 600 }}>{node.name}</span>
                              <span className="dim">{shorten(node.id, 8, 6)}</span>
                            </div>
                          </td>
                          <td>
                            {summary ? (
                              <span className={`pill ${summary.ok ? 'pillOk' : 'pillBad'}`}>
                                {summary.ok ? 'UP' : 'DOWN'}
                              </span>
                            ) : (
                              <span className="pill">…</span>
                            )}
                          </td>
                          <td className="monoSmall">
                            {nodeId ? shorten(nodeId, 16, 12) : '—'}
                          </td>
                          <td className="monoSmall">{shorten(node.rpcUrl, 18, 10)}</td>
                          <td>{peersCount ?? '—'}</td>
                          <td>{channelsCount ?? '—'}</td>
                          <td className="monoSmall">
                            {(() => {
                              const addrs = getArray(asObj(summary?.nodeInfo), 'addresses')
                              if (!addrs || !addrs.length) return '—'
                              return (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                  {addrs.map((a, idx) => {
                                    const val = typeof a === 'string' ? a : (asObj(a).address as string) ?? formatJson(a)
                                    return <div key={idx}>{val}</div>
                                  })}
                                </div>
                              )
                            })()}
                          </td>
                          <td className="monoSmall">
                            {typeof chainHash === 'string' ? shorten(chainHash, 14, 10) : '—'}
                          </td>
                          <td>{summary ? `${summary.latencyMs}ms` : '—'}</td>
                          <td className="dim">
                            {summary ? new Date(summary.updatedAt).toLocaleTimeString() : '—'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </section>

          <section className="grid2">
            <div className="card">
              <div className="cardHeader">
                <div className="cardTitle">Selected Node</div>
                <div className="muted">
                  {selectedNode ? selectedNode.name : 'None'}
                </div>
              </div>
              <div className="cardBody">
                {!selectedNode ? (
                  <div className="muted">选择一个节点以查看详细信息。</div>
                ) : (
                  <div className="kvGrid">
                    <div className="k">RPC URL</div>
                    <div className="v">{selectedNode.rpcUrl}</div>
                    <div className="k">Auth</div>
                    <div className="v">
                      {selectedNode.token ? <span className="pill">Bearer token</span> : <span className="dim">None</span>}
                    </div>
                    <div className="k">状态</div>
                    <div className="v">
                      {selectedSummary ? (
                        <span className={`pill ${selectedSummary.ok ? 'pillOk' : 'pillBad'}`}>
                          {selectedSummary.ok ? 'UP' : 'DOWN'}
                        </span>
                      ) : (
                        <span className="pill">…</span>
                      )}
                      {selectedSummary?.error ? (
                        <span className="dim" style={{ marginLeft: 10 }}>
                          {selectedSummary.error}
                        </span>
                      ) : null}
                    </div>
                    <div className="k">最后更新</div>
                    <div className="v">
                      {selectedSummary ? new Date(selectedSummary.updatedAt).toLocaleString() : '—'}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="card">
              <div className="cardHeader">
                <div className="cardTitle">Node Info (node_info)</div>
                <div className="muted">
                  {details?.fetchedAt ? new Date(details.fetchedAt).toLocaleTimeString() : '—'}
                </div>
              </div>
              <div className="cardBody">
                {detailsState.status === 'loading' ? (
                  <div className="muted">拉取中…</div>
                ) : detailsState.status === 'error' ? (
                  <div className="dangerRow">
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 12 }}>RPC 拉取失败</div>
                      <div className="smallNote">{detailsState.error}</div>
                    </div>
                    <button className="btn" onClick={() => void refreshDetails()}>
                      重试
                    </button>
                  </div>
                ) : details ? (
                  <div className="kvGrid">
                    <div className="k">version</div>
                    <div className="v">{getString(details.nodeInfo, 'version') ?? '—'}</div>
                    <div className="k">commit_hash</div>
                    <div className="v">{getString(details.nodeInfo, 'commit_hash') ? shorten(getString(details.nodeInfo, 'commit_hash')!, 16, 10) : '—'}</div>
                    <div className="k">node_id</div>
                    <div className="v">{getString(details.nodeInfo, 'node_id') ? shorten(getString(details.nodeInfo, 'node_id')!, 16, 12) : formatJson(details.nodeInfo['node_id'] ?? '—')}</div>
                    <div className="k">node_name</div>
                    <div className="v">{getString(details.nodeInfo, 'node_name') ?? '—'}</div>
                    <div className="k">chain_hash</div>
                    <div className="v">{getString(details.nodeInfo, 'chain_hash') ? shorten(getString(details.nodeInfo, 'chain_hash')!, 18, 12) : '—'}</div>
                    <div className="k">peers_count</div>
                    <div className="v">{hexToNumberMaybe(details.nodeInfo['peers_count']) ?? '—'}</div>
                    <div className="k">channel_count</div>
                    <div className="v">{hexToNumberMaybe(details.nodeInfo['channel_count']) ?? '—'}</div>
                    <div className="k">addresses</div>
                    <div className="v">
                      {getArray(details.nodeInfo, 'addresses')
                        ? `${getArray(details.nodeInfo, 'addresses')!.length} addrs`
                        : '—'}
                    </div>
                  </div>
                ) : (
                  <div className="muted">—</div>
                )}
              </div>
            </div>
          </section>

          <section className="grid2">
            <div className="card">
              <div className="cardHeader">
                <div className="cardTitle">Peers (list_peers)</div>
                <div className="muted">{details ? `${details.peers.length} peers` : '—'}</div>
              </div>
              <div className="cardBody" style={{ padding: 0, maxHeight: 360, overflow: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>peer_id</th>
                      <th>pubkey</th>
                      <th>address</th>
                    </tr>
                  </thead>
                  <tbody>
                    {details?.peers?.length ? (
                      details.peers.map((p, idx) => (
                        <tr key={`${p?.peer_id ?? idx}-${idx}`}>
                          <td className="monoSmall">{String(p?.peer_id ?? '—')}</td>
                          <td className="monoSmall">{typeof p?.pubkey === 'string' ? shorten(p.pubkey, 14, 10) : formatJson(p?.pubkey ?? '—')}</td>
                          <td className="monoSmall">{String(p?.address ?? '—')}</td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={3} className="muted" style={{ padding: 14 }}>
                          {selectedNode ? '暂无 peers 或节点不可达。' : '—'}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="card">
              <div className="cardHeader">
                <div className="cardTitle">Graph Nodes (graph_nodes)</div>
                <div className="muted">
                  {details ? `${details.graphNodes?.nodes?.length ?? 0} nodes` : '—'}
                </div>
              </div>
              <div className="cardBody">
                {details ? (
                  <div className="kvGrid">
                    <div className="k">limit</div>
                    <div className="v">200</div>
                    <div className="k">last_cursor</div>
                    <div className="v">{details.graphNodes?.last_cursor ? shorten(String(details.graphNodes.last_cursor), 18, 10) : '—'}</div>
                    <div className="k">sample</div>
                    <div className="v">
                      {details.graphNodes?.nodes?.[0]
                        ? shorten(formatJson(details.graphNodes.nodes[0]), 48, 0)
                        : '—'}
                    </div>
                  </div>
                ) : (
                  <div className="muted">—</div>
                )}
              </div>
            </div>
          </section>

          <section className="card">
            <div className="cardHeader">
              <div className="cardTitle">Channels (list_channels)</div>
              <div className="muted">
                {details
                  ? `${details.channels.length} channels · ${totalPendingTlcs} pending TLCs`
                  : '—'}
              </div>
            </div>
            <div className="cardBody" style={{ padding: 0, maxHeight: 600, overflow: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 20 }}></th>
                    <th>channel_id</th>
                    <th>public</th>
                    <th>peer_id</th>
                    <th>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <span>state</span>
                        <select
                          className="input"
                          value={channelStateFilter}
                          onChange={(e) => setChannelStateFilter(e.target.value)}
                          style={{ padding: '2px 6px', fontSize: 11, height: 'auto' }}
                        >
                          <option value="ALL">ALL</option>
                          {channelStateOptions.map((opt) => (
                            <option key={opt} value={opt}>
                              {opt}
                            </option>
                          ))}
                        </select>
                      </div>
                    </th>
                    <th>local</th>
                    <th>remote</th>
                    <th>pending</th>
                    <th>created</th>
                    <th>enabled</th>
                  </tr>
                </thead>
                <tbody>
                  {details?.channels?.length ? (
                    details.channels.map((c, idx) => {
                      const info = asObj(c)
                      const cid = String(info.channel_id ?? `idx-${idx}`)
                      const pending = getArray(info, 'pending_tlcs') ?? []
                      const expanded = expandedChannels.has(cid)
                      const isPublic = info.is_public === true
                      const stateLabel = formatJson(info.state ?? '—')
                      if (channelStateFilter !== 'ALL' && stateLabel !== channelStateFilter) {
                        return null
                      }
                      return (
                        <Fragment key={cid}>
                          <tr
                            onClick={() => toggleChannel(cid)}
                            style={{ cursor: 'pointer', background: expanded ? 'var(--bg-sub)' : undefined }}
                          >
                            <td className="muted" style={{ fontSize: 10 }}>{expanded ? '▼' : '▶'}</td>
                            <td className="monoSmall">
                              {typeof info.channel_id === 'string'
                                ? shorten(info.channel_id, 14, 10)
                                : formatJson(info.channel_id ?? '—')}
                            </td>
                            <td className="monoSmall">{isPublic ? 'yes' : 'no'}</td>
                            <td className="monoSmall">
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <span>{String(info.peer_id ?? '—')}</span>
                                {typeof info.peer_id === 'string' && (
                                  <span
                                    className={`pill ${onlinePeerIds.has(info.peer_id) ? 'pillOk' : 'dim'}`}
                                    style={{ fontSize: 9, padding: '1px 4px', height: 'auto' }}
                                  >
                                    {onlinePeerIds.has(info.peer_id) ? 'Online' : 'Offline'}
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="monoSmall">{stateLabel}</td>
                            <td className="monoSmall">{formatAmountWithHex(info.local_balance)}</td>
                            <td className="monoSmall">{formatAmountWithHex(info.remote_balance)}</td>
                            <td>{pending.length ? `${pending.length}` : '0'}</td>
                            <td className="monoSmall">{hexMillisToLocalTimeLabel(info.created_at)}</td>
                            <td>
                              {typeof info.enabled === 'boolean'
                                ? info.enabled
                                  ? 'yes'
                                  : 'no'
                                : '—'}
                            </td>
                          </tr>
                          {expanded && (
                            <tr>
                              <td colSpan={10} style={{ padding: 0, background: 'var(--bg-sub)' }}>
                                <div className="kvGrid" style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
                                  <div className="k">Channel Outpoint</div>
                                  <div className="v monoSmall">{formatJson(info.channel_outpoint ?? '—')}</div>

                                  <div className="k">Funding UDT</div>
                                  <div className="v monoSmall">{formatJson(info.funding_udt_type_script ?? '—')}</div>

                                  <div className="k">Offered TLC Balance</div>
                                  <div className="v monoSmall">{formatAmountWithHex(info.offered_tlc_balance)}</div>

                                  <div className="k">Received TLC Balance</div>
                                  <div className="v monoSmall">{formatAmountWithHex(info.received_tlc_balance)}</div>

                                  <div className="k">Latest Commit Tx</div>
                                  <div className="v monoSmall">{typeof info.latest_commitment_transaction_hash === 'string' ? info.latest_commitment_transaction_hash : '—'}</div>

                                  <div className="k">Shutdown Tx</div>
                                  <div className="v monoSmall">{typeof info.shutdown_transaction_hash === 'string' ? info.shutdown_transaction_hash : '—'}</div>

                                  <div className="k">TLC Expiry Delta</div>
                                  <div className="v monoSmall">{hexToNumberMaybe(info.tlc_expiry_delta) ?? '—'}</div>

                                  <div className="k">Fee Proportional</div>
                                  <div className="v monoSmall">{hexToNumberMaybe(info.tlc_fee_proportional_millionths) ?? '—'} (millionths)</div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      )
                    })
                  ) : (
                    <tr>
                      <td colSpan={10} className="muted" style={{ padding: 14 }}>
                        {selectedNode ? '暂无 channels 或节点不可达。' : '—'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {pendingTlcRows.length ? (
              <div
                className="cardBody"
                style={{
                  borderTop: '1px solid var(--line)',
                  maxHeight: '60vh',
                  minHeight: 260,
                  overflow: 'auto',
                  padding: '12px 16px',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: 10,
                  }}
                >
                  <div className="muted" style={{ fontSize: 11 }}>
                    Pending TLCs（来自 list_channels.pending_tlcs）
                  </div>
                  <span className="badge">
                    {pendingTlcRows.length} pending
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  {Object.entries(groupedPendingTlcs)
                    .sort(([, rowsA], [, rowsB]) => {
                      const expA = rowsA[0]?.expiryVal ?? 0
                      const expB = rowsB[0]?.expiryVal ?? 0
                      return expB - expA
                    })
                    .map(([hash, rows]) => (
                      <div key={hash} style={{ border: '1px solid var(--line)', borderRadius: 6, overflow: 'hidden' }}>
                        <div
                          style={{
                          padding: '8px 12px',
                          background: 'var(--bg-sub)',
                          borderBottom: '1px solid var(--line)',
                          fontSize: 12,
                          fontWeight: 600,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                        }}
                      >
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <span className="dim">Payment Hash:</span>
                          <span className="monoSmall" title={hash}>
                            {hash === 'unknown' ? 'Unknown' : shorten(hash, 16, 16)}
                          </span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span className="badge">{rows.length} TLCs</span>
                          {hash !== 'unknown' ? (
                            <button
                              className="btn btnGhost"
                              onClick={() => {
                                copyToClipboard(hash)
                              }}
                              style={{ padding: '4px 8px', borderRadius: 12, fontSize: 11 }}
                            >
                              复制
                            </button>
                          ) : null}
                        </div>
                      </div>
                      <table className="table" style={{ margin: 0 }}>
                        <thead>
                          <tr>
                            <th>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                <span>channel</span>
                                <span className="dim" style={{ fontSize: 10 }}>
                                  state
                                </span>
                              </div>
                            </th>
                            <th>tlc_id</th>
                            <th>dir</th>
                            <th>amount</th>
                            <th>expiry</th>
                            <th>TLC 状态</th>
                            <th>forwarding</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((row, idx) => (
                            <tr key={`${row.channelIdShort}-${row.tlcId}-${idx}`}>
                              <td className="monoSmall">
                                <div style={{ display: 'grid', gap: 2 }}>
                                  <span>{row.channelIdShort}</span>
                                  <span className="dim" style={{ fontSize: 10 }}>
                                    {row.channelStateLabel}
                                  </span>
                                </div>
                              </td>
                              <td className="monoSmall">{row.tlcId}</td>
                              <td>{row.directionLabel}</td>
                              <td className="monoSmall">{row.amountLabel}</td>
                              <td className="monoSmall">
                                {row.expiryLabel}
                                {row.isExpired ? (
                                  <span style={{ color: 'var(--color-danger)', marginLeft: 4, fontSize: 10 }}>
                                    (已过期)
                                  </span>
                                ) : null}
                              </td>
                              <td className="monoSmall">{row.statusLabel}</td>
                              <td className="monoSmall">
                                {row.forwardingLabel ?? <span className="dim">—</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </section>

          <section className="card">
            <div className="cardHeader">
              <div className="cardTitle">Graph Channels (graph_channels)</div>
              <div className="muted">
                {details ? `${details.graphChannels?.channels?.length ?? 0} channels` : '—'}
              </div>
            </div>
            <div className="cardBody">
              {details ? (
                <div className="kvGrid">
                  <div className="k">limit</div>
                  <div className="v">200</div>
                  <div className="k">last_cursor</div>
                  <div className="v">{details.graphChannels?.last_cursor ? shorten(String(details.graphChannels.last_cursor), 18, 10) : '—'}</div>
                  <div className="k">sample</div>
                  <div className="v">
                    {details.graphChannels?.channels?.[0]
                      ? shorten(formatJson(details.graphChannels.channels[0]), 48, 0)
                      : '—'}
                  </div>
                </div>
              ) : (
                <div className="muted">—</div>
              )}
            </div>
          </section>
          </div>
        ) : null}

        {viewMode === 'paymentSearch' ? (
          <div className="layout">
            <section className="card">
              <div className="cardHeader">
                <div className="cardTitle">Payment Hash 视图</div>
                <div className="muted">
                  {paymentSearchState.status === 'searching'
                    ? `扫描中 ${paymentSearchProgress.completed}/${paymentSearchProgress.total}`
                    : paymentSearchState.status === 'done'
                    ? `找到 ${paymentSearchResults.length} 条匹配`
                    : '输入 Payment Hash 并开始扫描 pending_tlcs'}
                </div>
              </div>
              <div className="cardBody">
                <div className="field" style={{ marginBottom: 12 }}>
                  <div className="label">Payment Hash</div>
                  <input
                    className="input"
                    value={paymentHashQuery}
                    onChange={(e) => setPaymentHashQuery(e.target.value)}
                    placeholder="例如：0x1234..."
                  />
                  <div className="smallNote">
                    将使用 list_channels 扫描所有节点的 pending_tlcs，并按照 Payment Hash 匹配。
                  </div>
                </div>
                <div className="modalActions" style={{ padding: 0, marginBottom: 12 }}>
                  <div className="spacer" />
                  <button
                    className="btn"
                    onClick={() => void runPaymentSearch()}
                    disabled={
                      paymentSearchState.status === 'searching' ||
                      !paymentHashQuery.trim() ||
                      !nodes.length
                    }
                  >
                    扫描 pending_tlcs
                  </button>
                </div>
                {paymentSearchState.status === 'searching' ||
                paymentSearchProgress.completed > 0 ? (
                  <div style={{ marginBottom: 12 }}>
                    <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
                      扫描进度：{paymentSearchProgress.completed}/{paymentSearchProgress.total} (
                      {progressPercent}%)
                    </div>
                    <div
                      style={{
                        width: '100%',
                        height: 8,
                        borderRadius: 999,
                        background: 'rgba(255,255,255,0.06)',
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          width: `${progressPercent}%`,
                          height: '100%',
                          background:
                            'linear-gradient(90deg, rgba(124,255,214,0.9), rgba(138,125,255,0.9))',
                          transition: 'width 160ms ease',
                        }}
                      />
                    </div>
                  </div>
                ) : null}
                {paymentSearchState.status === 'error' ? (
                  <div className="dangerRow" style={{ marginBottom: 12 }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 12 }}>扫描失败</div>
                      <div className="smallNote">{paymentSearchState.error}</div>
                    </div>
                  </div>
                ) : null}
                {paymentSearchResults.length ? (
                  <div style={{ maxHeight: 480, overflow: 'auto' }}>
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Node</th>
                          <th>channel</th>
                          <th>tlc_id</th>
                          <th>dir</th>
                          <th>amount</th>
                          <th>expiry</th>
                          <th>TLC 状态</th>
                          <th>forwarding</th>
                          <th>RPC</th>
                        </tr>
                      </thead>
                      <tbody>
                        {paymentSearchResults.map((row, idx) => (
                          <tr key={`${row.nodeId}-${row.tlcId}-${idx}`}>
                            <td>
                              <div style={{ display: 'grid', gap: 4 }}>
                                <span style={{ fontWeight: 600 }}>{row.nodeName}</span>
                                <span className="monoSmall">{shorten(row.nodeId, 8, 6)}</span>
                              </div>
                            </td>
                            <td className="monoSmall">
                              <div style={{ display: 'grid', gap: 2 }}>
                                <span>{row.channelIdShort}</span>
                                <span className="dim" style={{ fontSize: 10 }}>
                                  {row.channelStateLabel}
                                </span>
                              </div>
                            </td>
                            <td className="monoSmall">{row.tlcId}</td>
                            <td>{row.directionLabel}</td>
                            <td className="monoSmall">{row.amountLabel}</td>
                            <td className="monoSmall">
                              {row.expiryLabel}
                              {row.isExpired ? (
                                <span style={{ color: 'var(--color-danger)', marginLeft: 4, fontSize: 10 }}>
                                  (已过期)
                                </span>
                              ) : null}
                            </td>
                            <td className="monoSmall">{row.statusLabel}</td>
                            <td className="monoSmall">
                              {row.forwardingLabel ?? <span className="dim">—</span>}
                            </td>
                            <td className="monoSmall">{shorten(row.rpcUrl, 18, 10)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : paymentSearchState.status === 'done' ? (
                  <div className="muted" style={{ marginTop: 12 }}>
                    未在任何节点的 pending_tlcs 中找到匹配的 Payment Hash。
                  </div>
                ) : null}
              </div>
            </section>
          </div>
        ) : null}

        {viewMode === 'channelOutpointSearch' ? (
          <div className="layout">
            <section className="card">
              <div className="cardHeader">
                <div className="cardTitle">Channel Outpoint 视图</div>
                <div className="muted">
                  {channelOutpointSearchState.status === 'searching'
                    ? `扫描中 ${channelOutpointSearchProgress.completed}/${channelOutpointSearchProgress.total}`
                    : channelOutpointSearchState.status === 'done'
                    ? `找到 ${channelOutpointSearchResults.length} 条匹配`
                    : '输入 Channel Outpoint 并开始扫描所有节点的 channels'}
                </div>
              </div>
              <div className="cardBody">
                <div className="field" style={{ marginBottom: 12 }}>
                  <div className="label">Channel Outpoint</div>
                  <input
                    className="input"
                    value={channelOutpointQuery}
                    onChange={(e) => setChannelOutpointQuery(e.target.value)}
                    placeholder="例如：0x9bb2a8a4bebaf793..."
                  />
                  <div className="smallNote">
                    将使用 list_channels 扫描所有节点的 channels，并按照 Channel Outpoint 匹配（支持部分匹配）。
                  </div>
                </div>
                <div className="modalActions" style={{ padding: 0, marginBottom: 12 }}>
                  <div className="spacer" />
                  <button
                    className="btn"
                    onClick={() => void runChannelOutpointSearch()}
                    disabled={
                      channelOutpointSearchState.status === 'searching' ||
                      !channelOutpointQuery.trim() ||
                      !nodes.length
                    }
                  >
                    扫描 channels
                  </button>
                </div>
                {channelOutpointSearchState.status === 'searching' ||
                channelOutpointSearchProgress.completed > 0 ? (
                  <div style={{ marginBottom: 12 }}>
                    <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
                      扫描进度：{channelOutpointSearchProgress.completed}/{channelOutpointSearchProgress.total} (
                      {channelOutpointSearchProgress.total > 0
                        ? Math.round((channelOutpointSearchProgress.completed / channelOutpointSearchProgress.total) * 100)
                        : 0}%)
                    </div>
                    <div
                      style={{
                        width: '100%',
                        height: 8,
                        borderRadius: 999,
                        background: 'rgba(255,255,255,0.06)',
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          width: `${channelOutpointSearchProgress.total > 0
                            ? Math.round((channelOutpointSearchProgress.completed / channelOutpointSearchProgress.total) * 100)
                            : 0}%`,
                          height: '100%',
                          background:
                            'linear-gradient(90deg, rgba(124,255,214,0.9), rgba(138,125,255,0.9))',
                          transition: 'width 160ms ease',
                        }}
                      />
                    </div>
                  </div>
                ) : null}
                {channelOutpointSearchState.status === 'error' ? (
                  <div className="dangerRow" style={{ marginBottom: 12 }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 12 }}>扫描失败</div>
                      <div className="smallNote">{channelOutpointSearchState.error}</div>
                    </div>
                  </div>
                ) : null}
                {channelOutpointSearchResults.length ? (
                  <div style={{ maxHeight: 480, overflow: 'auto' }}>
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Node</th>
                          <th>Channel ID</th>
                          <th>Channel Outpoint</th>
                          <th>State</th>
                          <th>Peer ID</th>
                          <th>Public</th>
                          <th>Local Balance</th>
                          <th>Remote Balance</th>
                          <th>Enabled</th>
                          <th>Created</th>
                          <th>RPC</th>
                        </tr>
                      </thead>
                      <tbody>
                        {channelOutpointSearchResults.map((row, idx) => (
                          <tr key={`${row.nodeId}-${row.channelId}-${idx}`}>
                            <td>
                              <div style={{ display: 'grid', gap: 4 }}>
                                <span style={{ fontWeight: 600 }}>{row.nodeName}</span>
                                <span className="monoSmall">{shorten(row.nodeId, 8, 6)}</span>
                              </div>
                            </td>
                            <td className="monoSmall">{row.channelIdShort}</td>
                            <td className="monoSmall" title={row.channelOutpoint}>
                              {shorten(row.channelOutpoint, 20, 16)}
                            </td>
                            <td className="monoSmall">{row.channelStateLabel}</td>
                            <td className="monoSmall">{shorten(row.peerId, 14, 10)}</td>
                            <td>{row.isPublic ? 'yes' : 'no'}</td>
                            <td className="monoSmall">{row.localBalance}</td>
                            <td className="monoSmall">{row.remoteBalance}</td>
                            <td>{row.enabled ? 'yes' : 'no'}</td>
                            <td className="monoSmall">{row.createdAt}</td>
                            <td className="monoSmall">{shorten(row.rpcUrl, 18, 10)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : channelOutpointSearchState.status === 'done' ? (
                  <div className="muted" style={{ marginTop: 12 }}>
                    未在任何节点的 channels 中找到匹配的 Channel Outpoint。
                  </div>
                ) : null}
              </div>
            </section>
          </div>
        ) : null}

        {viewMode === 'rpcDebug' ? (
          <div className="layout">
            <section className="card">
              <div className="cardHeader">
                <div className="cardTitle">RPC 调试</div>
                <div className="muted">
                  {selectedNode ? selectedNode.name : '请选择左侧的节点'}
                </div>
              </div>
              <div className="cardBody">
                {!selectedNode ? (
                  <div className="muted">需要先在左侧选择一个节点。</div>
                ) : (
                  <>
                    <div className="field">
                      <div className="label">Method</div>
                      <input
                        className="input"
                        value={rpcMethod}
                        onChange={(e) => setRpcMethod(e.target.value)}
                        placeholder="例如：node_info"
                      />
                    </div>
                    <div className="field" style={{ marginTop: 10 }}>
                      <div className="label">Params (JSON)</div>
                      <textarea
                        className="input"
                        style={{
                          minHeight: 120,
                          fontFamily: 'var(--font-mono, monospace)',
                          fontSize: 12,
                        }}
                        value={rpcParams}
                        onChange={(e) => setRpcParams(e.target.value)}
                        placeholder="例如：{ &quot;include_closed&quot;: true }"
                      />
                    </div>
                    <div className="modalActions" style={{ padding: 0, marginTop: 12 }}>
                      <div className="spacer" />
                      <button
                        className="btn"
                        onClick={() => void runRpcCall()}
                        disabled={rpcState === 'pending'}
                      >
                        调用
                      </button>
                    </div>
                    {rpcState === 'pending' ? (
                      <div className="muted" style={{ marginTop: 8 }}>
                        调用中…
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            </section>
            <section className="card">
              <div className="cardHeader">
                <div className="cardTitle">RPC 响应</div>
              </div>
              <div className="cardBody">
                {rpcState === 'idle' ? (
                  <div className="muted">尚未调用。</div>
                ) : (
                  <pre
                    style={{
                      whiteSpace: 'pre-wrap',
                      fontFamily: 'var(--font-mono, monospace)',
                      fontSize: 12,
                      margin: 0,
                    }}
                  >
                    {rpcResponse}
                  </pre>
                )}
              </div>
            </section>
          </div>
        ) : null}

        {modalOpen ? (
          <AddNodeModal
            onClose={() => setModalOpen(false)}
            onAdd={(n) => {
              addNode(n)
              setModalOpen(false)
            }}
            onAddBulk={(list) => {
              addNodesBulk(list)
              setModalOpen(false)
            }}
          />
        ) : null}
      </main>
    </div>
  )
}

function AddNodeModal({
  onClose,
  onAdd,
  onAddBulk,
}: {
  onClose: () => void
  onAdd: (node: Omit<MonitoredNode, 'id' | 'createdAt'>) => void
  onAddBulk: (nodes: Omit<MonitoredNode, 'id' | 'createdAt'>[]) => void
}) {
  const [name, setName] = useState('')
  const [rpcUrl, setRpcUrl] = useState('')
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<'single' | 'bulk'>('single')
  const [bulkText, setBulkText] = useState('')

  const submitSingle = () => {
    const n = name.trim()
    const u = rpcUrl.trim()
    if (!u) {
      setError('RPC URL 不能为空')
      return
    }
    if (!isHttpUrl(u)) {
      setError('RPC URL 必须是 http(s) 地址')
      return
    }
    const finalName = n || safeUrlLabel(u)
    onAdd({
      name: finalName,
      rpcUrl: u,
      token: token.trim() || undefined,
    })
  }

  const submitBulk = () => {
    const raw = bulkText.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)
    if (!raw.length) {
      setError('请输入至少一行节点配置')
      return
    }
    const nodes: Omit<MonitoredNode, 'id' | 'createdAt'>[] = []
    for (const line of raw) {
      const parts = line.split(',').map((p) => p.trim()).filter((p) => p.length > 0)
      let namePart: string | undefined
      let urlPart: string | undefined
      let tokenPart: string | undefined
      if (parts.length === 1) {
        urlPart = parts[0]
      } else if (parts.length === 2) {
        namePart = parts[0]
        urlPart = parts[1]
      } else if (parts.length >= 3) {
        namePart = parts[0]
        urlPart = parts[1]
        tokenPart = parts.slice(2).join(',').trim()
      }
      const u = (urlPart ?? '').trim()
      if (!u) {
        setError(`存在空的 RPC URL 行: "${line}"`)
        return
      }
      if (!isHttpUrl(u)) {
        setError(`RPC URL 必须是 http(s) 地址: "${u}"`)
        return
      }
      const finalName = (namePart ?? '').trim() || safeUrlLabel(u)
      nodes.push({
        name: finalName,
        rpcUrl: u,
        token: tokenPart?.trim() || undefined,
      })
    }
    if (!nodes.length) {
      setError('未解析到有效的节点配置')
      return
    }
    onAddBulk(nodes)
  }

  return (
    <div className="modalOverlay" onMouseDown={onClose} role="presentation">
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modalHeader">
          <div className="modalTitle">ADD NODE</div>
          <button className="btn btnGhost" onClick={onClose} style={{ padding: '8px 10px', borderRadius: 14 }}>
            关闭
          </button>
        </div>
        <div className="modalBody">
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <button
              className={mode === 'single' ? 'btn' : 'btn btnGhost'}
              onClick={() => {
                setMode('single')
                setError(null)
              }}
              style={{ padding: '6px 10px', borderRadius: 12 }}
            >
              单个添加
            </button>
            <button
              className={mode === 'bulk' ? 'btn' : 'btn btnGhost'}
              onClick={() => {
                setMode('bulk')
                setError(null)
              }}
              style={{ padding: '6px 10px', borderRadius: 12 }}
            >
              批量添加
            </button>
          </div>

          {mode === 'single' ? (
            <>
              <div className="field">
                <div className="label">Node Name</div>
                <input
                  className="input"
                  value={name}
                  placeholder="例如: testnet-01"
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="field">
                <div className="label">RPC URL</div>
                <input
                  className="input"
                  value={rpcUrl}
                  placeholder="例如: http://127.0.0.1:8227"
                  onChange={(e) => setRpcUrl(e.target.value)}
                />
              </div>
              <div className="field">
                <div className="label">Authorization (Optional)</div>
                <input
                  className="input"
                  value={token}
                  placeholder="Bearer token（仅填写 token 本体）"
                  onChange={(e) => setToken(e.target.value)}
                />
                <div className="smallNote">
                  代理会以 Authorization: Bearer {'{token}'} 转发到节点 RPC。
                  请避免在不可信环境暴露 RPC 地址与 token。
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="field">
                <div className="label">批量节点列表</div>
                <textarea
                  className="input"
                  value={bulkText}
                  onChange={(e) => setBulkText(e.target.value)}
                  placeholder={[
                    '每行一个节点，支持以下格式：',
                    '1) http://127.0.0.1:8227',
                    '2) my-node,http://127.0.0.1:8227',
                    '3) my-node,http://127.0.0.1:8227,my-token',
                  ].join('\n')}
                  style={{ minHeight: 200, fontSize: 12, fontFamily: 'var(--font-mono, monospace)' }}
                />
              </div>
              <div className="smallNote">
                将为每一行创建一个节点。若未填写名称，将自动使用 RPC URL 生成名称。
              </div>
            </>
          )}
          {error ? <div className="dangerRow">{error}</div> : null}
        </div>
        <div className="modalActions">
          <button className="btn btnGhost" onClick={onClose}>
            取消
          </button>
          <div className="spacer" />
          <button
            className="btn"
            onClick={mode === 'single' ? submitSingle : submitBulk}
          >
            {mode === 'single' ? '添加并开始监控' : '批量添加节点'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default App
