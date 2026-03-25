import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as d3 from 'd3'
import { callFiberRpc } from '../lib/rpc'
import { shorten, hexToNumberMaybe } from '../lib/format'
import type { MonitoredNode } from '../lib/storage'
import type { Lang } from '../lib/i18n'
import './NetworkTopology.css'

type JsonObj = Record<string, unknown>

function asObj(value: unknown): JsonObj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as JsonObj
}

function getString(obj: JsonObj, key: string): string | null {
  const v = obj[key]
  return typeof v === 'string' ? v : null
}

type TopoNode = {
  id: string
  alias: string
  addresses: string[]
  isPublic: boolean
  timestamp: number
  chainHash: string
  autoAcceptMinCkbFundingAmount: number
  udtCfgInfos: JsonObj[]
  channels: string[]
  ckbCapacity: number
  udtCapacity: number
  avgFeeRate: number
}

type TopoLink = {
  source: string
  target: string
  channelOutpoint: string
  capacity: number
  feeRate: number
  isUdt: boolean
  udtTypeScript: JsonObj | null
}

type D3Node = d3.SimulationNodeDatum & TopoNode & {
  x: number
  y: number
  fx: number | null
  fy: number | null
}

type D3Link = d3.SimulationLinkDatum<D3Node> & TopoLink

const i18n = {
  zh: {
    title: '网络拓扑',
    loading: '加载网络数据中…',
    loadFailed: '加载失败',
    retry: '重试',
    refresh: '刷新数据',
    totalNodes: '总节点数',
    totalChannels: '总通道数',
    ckbCapacity: 'CKB 总容量',
    udtCapacity: 'UDT 总容量',
    filterAll: '全部通道',
    filterCkb: '仅 CKB',
    filterUdt: '仅 UDT',
    searchPlaceholder: '输入节点公钥搜索…',
    search: '搜索',
    pathSearchPlaceholder1: '起始节点公钥',
    pathSearchPlaceholder2: '目标节点公钥',
    findPath: '查找路径',
    noNodeFound: '未找到该节点',
    noPathFound: '未找到路径',
    nodeDetail: '节点详情',
    pubkey: '公钥',
    isPublic: '公共节点',
    yes: '是',
    no: '否',
    alias: '名称',
    addresses: '地址列表',
    connectedChannels: '连接通道数',
    ckbCap: 'CKB 容量',
    udtCap: 'UDT 容量',
    avgFee: '平均费率 (ppm)',
    lastUpdate: '最后更新',
    minCkbFunding: '最小 CKB Funding',
    udtConfig: 'UDT 配置',
    noUdtConfig: '无 UDT 配置',
    selectNode: '请选择左侧的节点作为数据源',
    close: '关闭',
    shannon: 'shannon',
  },
  en: {
    title: 'Network Topology',
    loading: 'Loading network data…',
    loadFailed: 'Load failed',
    retry: 'Retry',
    refresh: 'Refresh Data',
    totalNodes: 'Total Nodes',
    totalChannels: 'Total Channels',
    ckbCapacity: 'Total CKB Capacity',
    udtCapacity: 'Total UDT Capacity',
    filterAll: 'All Channels',
    filterCkb: 'CKB Only',
    filterUdt: 'UDT Only',
    searchPlaceholder: 'Enter node pubkey to search…',
    search: 'Search',
    pathSearchPlaceholder1: 'Source node pubkey',
    pathSearchPlaceholder2: 'Target node pubkey',
    findPath: 'Find Path',
    noNodeFound: 'Node not found',
    noPathFound: 'No path found',
    nodeDetail: 'Node Detail',
    pubkey: 'Public Key',
    isPublic: 'Public Node',
    yes: 'Yes',
    no: 'No',
    alias: 'Alias',
    addresses: 'Addresses',
    connectedChannels: 'Connected Channels',
    ckbCap: 'CKB Capacity',
    udtCap: 'UDT Capacity',
    avgFee: 'Avg Fee Rate (ppm)',
    lastUpdate: 'Last Update',
    minCkbFunding: 'Min CKB Funding',
    udtConfig: 'UDT Config',
    noUdtConfig: 'No UDT Config',
    selectNode: 'Select a node from the sidebar as data source',
    close: 'Close',
    shannon: 'shannon',
  },
}

function formatCapacity(shannon: number): string {
  if (shannon >= 1e8) return `${(shannon / 1e8).toFixed(2)} CKB`
  if (shannon >= 1e4) return `${(shannon / 1e4).toFixed(2)} × 10⁴`
  return `${shannon}`
}

function tsToMs(ts: number): number {
  return ts < 1e12 ? ts * 1000 : ts
}

function linkNodeId(ref: string | D3Node | TopoNode): string {
  return typeof ref === 'string' ? ref : ref.id
}

export default function NetworkTopology({
  selectedNode,
  lang,
}: {
  selectedNode: MonitoredNode | null
  lang: Lang
}) {
  const t = i18n[lang]
  const svgRef = useRef<SVGSVGElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [loadError, setLoadError] = useState('')
  const [graphNodes, setGraphNodes] = useState<JsonObj[]>([])
  const [graphChannels, setGraphChannels] = useState<JsonObj[]>([])
  const [channelFilter, setChannelFilter] = useState<'all' | 'ckb' | 'udt'>('all')
  const [selectedTopoNode, setSelectedTopoNode] = useState<TopoNode | null>(null)
  const [singleSearch, setSingleSearch] = useState('')
  const [pathSearch1, setPathSearch1] = useState('')
  const [pathSearch2, setPathSearch2] = useState('')
  const [searchMsg, setSearchMsg] = useState('')

  const simulationRef = useRef<d3.Simulation<D3Node, D3Link> | null>(null)

  const fetchAllData = useCallback(async () => {
    if (!selectedNode) return
    setLoadState('loading')
    setLoadError('')
    try {
      const allNodes: JsonObj[] = []
      const allChannels: JsonObj[] = []
      let nodesCursor: unknown = undefined
      for (;;) {
        const params: JsonObj = { limit: '0x64' }
        if (nodesCursor) params.after = nodesCursor
        const res = await callFiberRpc<{ nodes: unknown[]; last_cursor?: unknown }>(
          selectedNode, 'graph_nodes', params,
        )
        const batch = (res?.nodes ?? []).map(asObj)
        allNodes.push(...batch)
        if (!res?.last_cursor || batch.length === 0) break
        nodesCursor = res.last_cursor
      }
      let channelsCursor: unknown = undefined
      for (;;) {
        const params: JsonObj = { limit: '0x64' }
        if (channelsCursor) params.after = channelsCursor
        const res = await callFiberRpc<{ channels: unknown[]; last_cursor?: unknown }>(
          selectedNode, 'graph_channels', params,
        )
        const batch = (res?.channels ?? []).map(asObj)
        allChannels.push(...batch)
        if (!res?.last_cursor || batch.length === 0) break
        channelsCursor = res.last_cursor
      }
      setGraphNodes(allNodes)
      setGraphChannels(allChannels)
      setLoadState('ready')
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
      setLoadState('error')
    }
  }, [selectedNode])

  useEffect(() => {
    if (selectedNode) void fetchAllData()
  }, [selectedNode, fetchAllData])

  const { topoNodes, topoLinks, stats } = useMemo(() => {
    const nodeMap = new Map<string, TopoNode>()
    for (const gn of graphNodes) {
      const nodeId = getString(gn, 'node_id') ?? ''
      if (!nodeId) continue
      const alias = getString(gn, 'alias') ?? ''
      const addresses = Array.isArray(gn.addresses) ? (gn.addresses as string[]) : []
      const ts = hexToNumberMaybe(gn.timestamp) ?? 0
      const chainHash = getString(gn, 'chain_hash') ?? ''
      const minFunding = hexToNumberMaybe(gn.auto_accept_min_ckb_funding_amount) ?? 0
      const udtCfgInfos = Array.isArray(gn.udt_cfg_infos) ? (gn.udt_cfg_infos as JsonObj[]) : []
      nodeMap.set(nodeId, {
        id: nodeId,
        alias,
        addresses,
        isPublic: true,
        timestamp: ts,
        chainHash,
        autoAcceptMinCkbFundingAmount: minFunding,
        udtCfgInfos,
        channels: [],
        ckbCapacity: 0,
        udtCapacity: 0,
        avgFeeRate: 0,
      })
    }

    const links: TopoLink[] = []
    let totalCkbCap = 0
    let totalUdtCap = 0
    for (const gc of graphChannels) {
      const outpoint = getString(gc, 'channel_outpoint') ?? ''
      const node1 = getString(gc, 'node1') ?? ''
      const node2 = getString(gc, 'node2') ?? ''
      const capacity = hexToNumberMaybe(gc.capacity) ?? 0
      const udtTypeScript = gc.udt_type_script ? asObj(gc.udt_type_script) : null
      const isUdt = udtTypeScript !== null && Object.keys(udtTypeScript).length > 0
      const feeRate1 = hexToNumberMaybe(gc.fee_rate_of_node1) ?? 0
      const feeRate2 = hexToNumberMaybe(gc.fee_rate_of_node2) ?? 0
      const avgFee = Math.round((feeRate1 + feeRate2) / 2)

      if (!nodeMap.has(node1)) {
        nodeMap.set(node1, {
          id: node1, alias: '', addresses: [], isPublic: false,
          timestamp: 0, chainHash: '', autoAcceptMinCkbFundingAmount: 0,
          udtCfgInfos: [], channels: [], ckbCapacity: 0, udtCapacity: 0, avgFeeRate: 0,
        })
      }
      if (!nodeMap.has(node2)) {
        nodeMap.set(node2, {
          id: node2, alias: '', addresses: [], isPublic: false,
          timestamp: 0, chainHash: '', autoAcceptMinCkbFundingAmount: 0,
          udtCfgInfos: [], channels: [], ckbCapacity: 0, udtCapacity: 0, avgFeeRate: 0,
        })
      }

      const n1 = nodeMap.get(node1)!
      const n2 = nodeMap.get(node2)!
      n1.channels.push(outpoint)
      n2.channels.push(outpoint)
      if (isUdt) {
        n1.udtCapacity += capacity
        n2.udtCapacity += capacity
        totalUdtCap += capacity
      } else {
        n1.ckbCapacity += capacity
        n2.ckbCapacity += capacity
        totalCkbCap += capacity
      }

      links.push({
        source: node1,
        target: node2,
        channelOutpoint: outpoint,
        capacity,
        feeRate: avgFee,
        isUdt,
        udtTypeScript,
      })
    }

    for (const node of nodeMap.values()) {
      const chLinks = links.filter(l => l.source === node.id || l.target === node.id)
      const fees = chLinks.map(l => l.feeRate).filter(f => f > 0)
      node.avgFeeRate = fees.length > 0 ? Math.round(fees.reduce((a, b) => a + b, 0) / fees.length) : 0
    }

    const filteredLinks = links.filter(l => {
      if (channelFilter === 'ckb') return !l.isUdt
      if (channelFilter === 'udt') return l.isUdt
      return true
    })

    const visibleNodeIds = new Set<string>()
    for (const l of filteredLinks) {
      visibleNodeIds.add(linkNodeId(l.source as string | TopoNode))
      visibleNodeIds.add(linkNodeId(l.target as string | TopoNode))
    }
    if (filteredLinks.length === 0) {
      for (const id of nodeMap.keys()) visibleNodeIds.add(id)
    }

    const nodes = Array.from(nodeMap.values()).filter(n => visibleNodeIds.has(n.id))

    return {
      topoNodes: nodes,
      topoLinks: filteredLinks,
      stats: {
        totalNodes: nodeMap.size,
        totalChannels: links.length,
        totalCkbCapacity: totalCkbCap,
        totalUdtCapacity: totalUdtCap,
      },
    }
  }, [graphNodes, graphChannels, channelFilter])

  useEffect(() => {
    if (loadState !== 'ready' || !svgRef.current || !containerRef.current) return

    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()

    const container = containerRef.current
    const width = container.clientWidth
    const height = container.clientHeight || 600

    svg.attr('width', width).attr('height', height)

    const defs = svg.append('defs')
    const glowFilter = defs.append('filter').attr('id', 'glow')
    glowFilter.append('feGaussianBlur').attr('stdDeviation', '3.5').attr('result', 'coloredBlur')
    const feMerge = glowFilter.append('feMerge')
    feMerge.append('feMergeNode').attr('in', 'coloredBlur')
    feMerge.append('feMergeNode').attr('in', 'SourceGraphic')

    const g = svg.append('g')

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 8])
      .on('zoom', (event: d3.D3ZoomEvent<SVGSVGElement, unknown>) => {
        g.attr('transform', event.transform.toString())
      })
    svg.call(zoom)

    const now = Date.now()
    const threeDaysMs = 3 * 24 * 60 * 60 * 1000

    const nodes: D3Node[] = topoNodes.map(n => ({
      ...n,
      x: width / 2 + (Math.random() - 0.5) * 200,
      y: height / 2 + (Math.random() - 0.5) * 200,
      fx: null,
      fy: null,
    }))

    const nodeById = new Map(nodes.map(n => [n.id, n]))
    const links: D3Link[] = topoLinks
      .filter(l => nodeById.has(linkNodeId(l.source as string | D3Node)) &&
        nodeById.has(linkNodeId(l.target as string | D3Node)))
      .map(l => ({ ...l }))

    const simulation = d3.forceSimulation<D3Node>(nodes)
      .force('link', d3.forceLink<D3Node, D3Link>(links).id(d => d.id).distance(80))
      .force('charge', d3.forceManyBody().strength(-200))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collide', d3.forceCollide<D3Node>().radius(d => Math.sqrt(d.channels.length + 1) * 5 + 10))

    simulationRef.current = simulation

    const linkGroup = g.append('g').attr('class', 'topo-links')
    const linkSel = linkGroup.selectAll<SVGLineElement, D3Link>('line')
      .data(links)
      .join('line')
      .attr('stroke', d => {
        if (d.isUdt) return '#ffd700'
        if (d.feeRate < 500) return '#4da6ff'
        if (d.feeRate <= 2000) return '#ff9f43'
        return '#ff4d6d'
      })
      .attr('stroke-width', d => Math.max(1.5, Math.sqrt(d.capacity / 1e8) * 1.5))
      .attr('stroke-opacity', 0.6)

    const nodeGroup = g.append('g').attr('class', 'topo-nodes')
    const nodeSel = nodeGroup.selectAll<SVGGElement, D3Node>('g')
      .data(nodes)
      .join('g')
      .attr('cursor', 'pointer')

    nodeSel.append('circle')
      .attr('r', d => Math.sqrt(d.channels.length + 1) * 4 + 5)
      .attr('fill', d => {
        return (now - tsToMs(d.timestamp)) < threeDaysMs ? '#7cffd6' : '#3a5a4a'
      })
      .attr('stroke', 'rgba(124,255,214,0.3)')
      .attr('stroke-width', 1.5)

    nodeSel.filter(d => d.isPublic)
      .append('text')
      .text('👑')
      .attr('text-anchor', 'middle')
      .attr('dy', d => -(Math.sqrt(d.channels.length + 1) * 4 + 10))
      .attr('font-size', '12px')
      .style('pointer-events', 'none')

    nodeSel.append('title')
      .text(d => d.alias || shorten(d.id, 12, 8))

    const drag = d3.drag<SVGGElement, D3Node>()
      .on('start', (event: d3.D3DragEvent<SVGGElement, D3Node, D3Node>, d: D3Node) => {
        if (!event.active) simulation.alphaTarget(0.3).restart()
        d.fx = d.x
        d.fy = d.y
      })
      .on('drag', (event: d3.D3DragEvent<SVGGElement, D3Node, D3Node>, d: D3Node) => {
        d.fx = event.x
        d.fy = event.y
      })
      .on('end', (event: d3.D3DragEvent<SVGGElement, D3Node, D3Node>, d: D3Node) => {
        if (!event.active) simulation.alphaTarget(0)
        d.fx = null
        d.fy = null
      })

    nodeSel.call(drag)

    nodeSel.on('click', (_event: MouseEvent, d: D3Node) => {
      if (d.fx !== null) {
        d.fx = null
        d.fy = null
      } else {
        d.fx = d.x
        d.fy = d.y
      }
      const tn = topoNodes.find(n => n.id === d.id)
      if (tn) setSelectedTopoNode(tn)
    })

    nodeSel.on('contextmenu', (event: MouseEvent, d: D3Node) => {
      event.preventDefault()
      if (d.fx !== null) {
        d.fx = null
        d.fy = null
      } else {
        d.fx = d.x
        d.fy = d.y
      }
      simulation.alpha(0.3).restart()
    })

    simulation.on('tick', () => {
      linkSel
        .attr('x1', d => (d.source as D3Node).x)
        .attr('y1', d => (d.source as D3Node).y)
        .attr('x2', d => (d.target as D3Node).x)
        .attr('y2', d => (d.target as D3Node).y)

      nodeSel.attr('transform', d => `translate(${d.x},${d.y})`)
    })

    svg.datum({ g, zoom, nodes, links, linkSel, nodeSel, simulation, nodeById })

    return () => {
      simulation.stop()
    }
  }, [loadState, topoNodes, topoLinks])

  const highlightNode = useCallback((pubkey: string) => {
    if (!svgRef.current) return
    const svgEl = d3.select(svgRef.current)
    const datum = svgEl.datum() as {
      g: d3.Selection<SVGGElement, unknown, null, undefined>
      zoom: d3.ZoomBehavior<SVGSVGElement, unknown>
      nodes: D3Node[]
      nodeSel: d3.Selection<SVGGElement, D3Node, SVGGElement, unknown>
    } | undefined
    if (!datum) return

    const target = datum.nodes.find(n => n.id.toLowerCase().includes(pubkey.toLowerCase()))
    if (!target) {
      setSearchMsg(t.noNodeFound)
      return
    }
    setSearchMsg('')

    const tn = topoNodes.find(n => n.id === target.id)
    if (tn) setSelectedTopoNode(tn)

    svgEl.transition().duration(750).call(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      datum.zoom.transform as any,
      d3.zoomIdentity.translate(
        (svgRef.current?.clientWidth ?? 800) / 2 - target.x,
        (svgRef.current?.clientHeight ?? 600) / 2 - target.y,
      ).scale(1.5),
    )

    datum.nodeSel
      .filter(d => d.id === target.id)
      .select('circle')
      .transition().duration(300).attr('stroke', '#ff4d6d').attr('stroke-width', 6)
      .transition().duration(300).attr('stroke', '#7cffd6').attr('stroke-width', 2)
      .transition().duration(300).attr('stroke', '#ff4d6d').attr('stroke-width', 6)
      .transition().duration(300).attr('stroke', '#7cffd6').attr('stroke-width', 2)
      .transition().duration(300).attr('stroke', '#ff4d6d').attr('stroke-width', 6)
      .transition().duration(300).attr('stroke', 'rgba(124,255,214,0.3)').attr('stroke-width', 1.5)
  }, [topoNodes, t])

  const highlightPath = useCallback((pubkey1: string, pubkey2: string) => {
    if (!svgRef.current) return
    const svgEl = d3.select(svgRef.current)
    const datum = svgEl.datum() as {
      g: d3.Selection<SVGGElement, unknown, null, undefined>
      zoom: d3.ZoomBehavior<SVGSVGElement, unknown>
      nodes: D3Node[]
      links: D3Link[]
      linkSel: d3.Selection<SVGLineElement, D3Link, SVGGElement, unknown>
      nodeSel: d3.Selection<SVGGElement, D3Node, SVGGElement, unknown>
    } | undefined
    if (!datum) return

    const start = datum.nodes.find(n => n.id.toLowerCase().includes(pubkey1.toLowerCase()))
    const end = datum.nodes.find(n => n.id.toLowerCase().includes(pubkey2.toLowerCase()))
    if (!start || !end) {
      setSearchMsg(t.noNodeFound)
      return
    }

    const adj = new Map<string, { neighbor: string; linkIdx: number }[]>()
    datum.links.forEach((l, idx) => {
      const s = (l.source as D3Node).id
      const t = (l.target as D3Node).id
      if (!adj.has(s)) adj.set(s, [])
      if (!adj.has(t)) adj.set(t, [])
      adj.get(s)!.push({ neighbor: t, linkIdx: idx })
      adj.get(t)!.push({ neighbor: s, linkIdx: idx })
    })

    const visited = new Set<string>()
    const parent = new Map<string, { from: string; linkIdx: number }>()
    const queue = [start.id]
    visited.add(start.id)
    let found = false
    while (queue.length > 0) {
      const current = queue.shift()!
      if (current === end.id) { found = true; break }
      for (const edge of (adj.get(current) ?? [])) {
        if (!visited.has(edge.neighbor)) {
          visited.add(edge.neighbor)
          parent.set(edge.neighbor, { from: current, linkIdx: edge.linkIdx })
          queue.push(edge.neighbor)
        }
      }
    }

    if (!found) {
      setSearchMsg(t.noPathFound)
      return
    }
    setSearchMsg('')

    const pathNodeIds: string[] = []
    const pathLinkIdxs: number[] = []
    let cur = end.id
    while (cur !== start.id) {
      pathNodeIds.push(cur)
      const p = parent.get(cur)!
      pathLinkIdxs.push(p.linkIdx)
      cur = p.from
    }
    pathNodeIds.push(start.id)
    pathNodeIds.reverse()
    pathLinkIdxs.reverse()

    const pathNodeSet = new Set(pathNodeIds)
    const pathLinkSet = new Set(pathLinkIdxs)

    datum.nodeSel
      .select('circle')
      .transition().duration(500)
      .attr('fill', (d: D3Node) => pathNodeSet.has(d.id) ? '#00ffff' : '#3a5a4a')
      .attr('stroke', (d: D3Node) => pathNodeSet.has(d.id) ? '#00ffff' : 'rgba(124,255,214,0.3)')
      .attr('stroke-width', (d: D3Node) => pathNodeSet.has(d.id) ? 4 : 1.5)

    datum.nodeSel
      .filter((d: D3Node) => pathNodeSet.has(d.id))
      .select('circle')
      .each(function (d: D3Node) {
        const circle = d3.select(this as SVGCircleElement)
        const baseR = Math.sqrt(d.channels.length + 1) * 4 + 5
        const bigR = baseR + 7
        function pulse() {
          circle
            .transition().duration(600).attr('r', bigR)
            .transition().duration(600).attr('r', baseR)
            .on('end', pulse)
        }
        pulse()
      })

    datum.linkSel
      .transition().duration(500)
      .attr('stroke', (_d: D3Link, i: number) => pathLinkSet.has(i) ? '#00ffff' : 'rgba(100,100,100,0.3)')
      .attr('stroke-width', (_d: D3Link, i: number) => pathLinkSet.has(i) ? 4 : 1)
      .attr('stroke-opacity', (_d: D3Link, i: number) => pathLinkSet.has(i) ? 1 : 0.3)
      .style('filter', (_d: D3Link, i: number) => pathLinkSet.has(i) ? 'url(#glow)' : 'none')

    const pathNodes = datum.nodes.filter(n => pathNodeSet.has(n.id))
    const xs = pathNodes.map(n => n.x)
    const ys = pathNodes.map(n => n.y)
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    const svgW = svgRef.current?.clientWidth ?? 800
    const svgH = svgRef.current?.clientHeight ?? 600
    const pw = maxX - minX + 100
    const ph = maxY - minY + 100
    const scale = Math.min(svgW / pw, svgH / ph, 2) * 0.8
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2

    svgEl.transition().duration(750).call(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      datum.zoom.transform as any,
      d3.zoomIdentity.translate(svgW / 2 - cx * scale, svgH / 2 - cy * scale).scale(scale),
    )

    setTimeout(() => {
      datum.nodeSel
        .select('circle')
        .interrupt()
        .transition().duration(800)
        .attr('fill', (d: D3Node) => {
          return (Date.now() - tsToMs(d.timestamp)) < 3 * 24 * 60 * 60 * 1000 ? '#7cffd6' : '#3a5a4a'
        })
        .attr('stroke', 'rgba(124,255,214,0.3)')
        .attr('stroke-width', 1.5)
        .attr('r', (d: D3Node) => Math.sqrt(d.channels.length + 1) * 4 + 5)

      datum.linkSel
        .transition().duration(800)
        .attr('stroke', (d: D3Link) => {
          if (d.isUdt) return '#ffd700'
          if (d.feeRate < 500) return '#4da6ff'
          if (d.feeRate <= 2000) return '#ff9f43'
          return '#ff4d6d'
        })
        .attr('stroke-width', (d: D3Link) => Math.max(1.5, Math.sqrt(d.capacity / 1e8) * 1.5))
        .attr('stroke-opacity', 0.6)
        .style('filter', 'none')
    }, 5000)
  }, [t])

  if (!selectedNode) {
    return (
      <div className="topoContainer">
        <div className="topoEmpty">{t.selectNode}</div>
      </div>
    )
  }

  return (
    <div className="topoContainer">
      <div className="topoToolbar">
        <div className="topoTitle">{t.title}</div>
        <div className="topoControls">
          <div className="topoFilterGroup">
            {(['all', 'ckb', 'udt'] as const).map(f => (
              <button
                key={f}
                className={`topoFilterBtn ${channelFilter === f ? 'topoFilterActive' : ''}`}
                onClick={() => setChannelFilter(f)}
              >
                {f === 'all' ? t.filterAll : f === 'ckb' ? t.filterCkb : t.filterUdt}
              </button>
            ))}
          </div>
          <button
            className="btn btnGhost"
            onClick={() => void fetchAllData()}
            disabled={loadState === 'loading'}
            style={{ fontSize: 12, padding: '4px 12px' }}
          >
            {loadState === 'loading' ? t.loading : t.refresh}
          </button>
        </div>
      </div>

      {loadState === 'ready' && (
        <div className="topoStats">
          <div className="topoStatItem">
            <span className="topoStatValue">{stats.totalNodes}</span>
            <span className="topoStatLabel">{t.totalNodes}</span>
          </div>
          <div className="topoStatItem">
            <span className="topoStatValue">{stats.totalChannels}</span>
            <span className="topoStatLabel">{t.totalChannels}</span>
          </div>
          <div className="topoStatItem">
            <span className="topoStatValue">{formatCapacity(stats.totalCkbCapacity)}</span>
            <span className="topoStatLabel">{t.ckbCapacity}</span>
          </div>
          <div className="topoStatItem">
            <span className="topoStatValue">{formatCapacity(stats.totalUdtCapacity)}</span>
            <span className="topoStatLabel">{t.udtCapacity}</span>
          </div>
        </div>
      )}

      <div className="topoSearchBar">
        <div className="topoSearchGroup">
          <input
            className="topoSearchInput"
            placeholder={t.searchPlaceholder}
            value={singleSearch}
            onChange={e => setSingleSearch(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && singleSearch.trim()) highlightNode(singleSearch.trim()) }}
          />
          <button className="topoSearchBtn" onClick={() => { if (singleSearch.trim()) highlightNode(singleSearch.trim()) }}>
            {t.search}
          </button>
        </div>
        <div className="topoSearchGroup">
          <input
            className="topoSearchInput topoSearchHalf"
            placeholder={t.pathSearchPlaceholder1}
            value={pathSearch1}
            onChange={e => setPathSearch1(e.target.value)}
          />
          <input
            className="topoSearchInput topoSearchHalf"
            placeholder={t.pathSearchPlaceholder2}
            value={pathSearch2}
            onChange={e => setPathSearch2(e.target.value)}
          />
          <button
            className="topoSearchBtn"
            onClick={() => { if (pathSearch1.trim() && pathSearch2.trim()) highlightPath(pathSearch1.trim(), pathSearch2.trim()) }}
          >
            {t.findPath}
          </button>
        </div>
        {searchMsg && <div className="topoSearchMsg">{searchMsg}</div>}
      </div>

      <div className="topoGraphArea" ref={containerRef}>
        {loadState === 'loading' && (
          <div className="topoLoading">{t.loading}</div>
        )}
        {loadState === 'error' && (
          <div className="topoLoading">
            <div>{t.loadFailed}: {loadError}</div>
            <button className="btn" onClick={() => void fetchAllData()} style={{ marginTop: 8 }}>{t.retry}</button>
          </div>
        )}
        <svg ref={svgRef} className="topoSvg" />
      </div>

      {selectedTopoNode && (
        <div className="topoDetailPanel">
          <div className="topoDetailHeader">
            <span>{t.nodeDetail}</span>
            <button className="topoDetailClose" onClick={() => setSelectedTopoNode(null)}>✕</button>
          </div>
          <div className="topoDetailBody">
            <div className="topoDetailRow">
              <span className="topoDetailKey">{t.pubkey}</span>
              <span className="topoDetailVal topoMono">{shorten(selectedTopoNode.id, 16, 10)}</span>
            </div>
            <div className="topoDetailRow">
              <span className="topoDetailKey">{t.isPublic}</span>
              <span className="topoDetailVal">{selectedTopoNode.isPublic ? `✅ ${t.yes}` : `❌ ${t.no}`}</span>
            </div>
            <div className="topoDetailRow">
              <span className="topoDetailKey">{t.alias}</span>
              <span className="topoDetailVal">{selectedTopoNode.alias || '—'}</span>
            </div>
            <div className="topoDetailRow">
              <span className="topoDetailKey">{t.addresses}</span>
              <span className="topoDetailVal">
                {selectedTopoNode.addresses.length > 0
                  ? selectedTopoNode.addresses.map((a, i) => <div key={i} className="topoMono" style={{ fontSize: 11 }}>{a}</div>)
                  : '—'}
              </span>
            </div>
            <div className="topoDetailRow">
              <span className="topoDetailKey">{t.connectedChannels}</span>
              <span className="topoDetailVal">{selectedTopoNode.channels.length}</span>
            </div>
            <div className="topoDetailRow">
              <span className="topoDetailKey">{t.ckbCap}</span>
              <span className="topoDetailVal">{formatCapacity(selectedTopoNode.ckbCapacity)}</span>
            </div>
            <div className="topoDetailRow">
              <span className="topoDetailKey">{t.udtCap}</span>
              <span className="topoDetailVal">{formatCapacity(selectedTopoNode.udtCapacity)}</span>
            </div>
            <div className="topoDetailRow">
              <span className="topoDetailKey">{t.avgFee}</span>
              <span className="topoDetailVal">{selectedTopoNode.avgFeeRate}</span>
            </div>
            <div className="topoDetailRow">
              <span className="topoDetailKey">{t.lastUpdate}</span>
              <span className="topoDetailVal">
                {selectedTopoNode.timestamp > 0
                  ? new Date(tsToMs(selectedTopoNode.timestamp)).toLocaleString()
                  : '—'}
              </span>
            </div>
            <div className="topoDetailRow">
              <span className="topoDetailKey">{t.minCkbFunding}</span>
              <span className="topoDetailVal">
                {selectedTopoNode.autoAcceptMinCkbFundingAmount > 0
                  ? formatCapacity(selectedTopoNode.autoAcceptMinCkbFundingAmount)
                  : '—'}
              </span>
            </div>
            <div className="topoDetailRow">
              <span className="topoDetailKey">{t.udtConfig}</span>
              <span className="topoDetailVal">
                {selectedTopoNode.udtCfgInfos.length > 0
                  ? <pre className="topoMono" style={{ fontSize: 10, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                      {JSON.stringify(selectedTopoNode.udtCfgInfos, null, 2)}
                    </pre>
                  : t.noUdtConfig}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
