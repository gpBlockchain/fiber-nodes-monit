import { useEffect, useRef, useMemo, useState, useCallback } from 'react'
import * as d3 from 'd3'
import { callFiberRpc } from '../lib/rpc'
import type { MonitoredNode } from '../lib/storage'
import './NetworkTopology.css'

type JsonObj = Record<string, unknown>

interface TopologyNode extends d3.SimulationNodeDatum {
  id: string
  name: string
  channelCount: number
  level: number
}

interface TopologyLink extends d3.SimulationLinkDatum<TopologyNode> {
  source: TopologyNode | string
  target: TopologyNode | string
  capacity: number
  pairIndex: number
  pairTotal: number
}

const PAGE_LIMIT = `0x${(100).toString(16)}`

const LINK_DISTANCE = 80
const CHARGE_STRENGTH = -120
const COLLISION_RADIUS = 18
const BASE_NODE_RADIUS = 8
const MAX_CHANNEL_SCALE = 20
const CHANNEL_SCALE_FACTOR = 0.4
const PARALLEL_EDGE_OFFSET = 25

function nodeLevel(channelCount: number): number {
  if (channelCount >= 10) return 3
  if (channelCount >= 5) return 2
  if (channelCount >= 2) return 1
  return 0
}

function levelIcon(level: number): string {
  if (level === 3) return '👑'
  if (level === 2) return '⭐'
  if (level === 1) return '◆'
  return '●'
}

function levelColor(level: number): string {
  if (level === 3) return 'rgba(255, 215, 0, 0.9)'
  if (level === 2) return 'rgba(124, 255, 214, 0.9)'
  if (level === 1) return 'rgba(138, 125, 255, 0.9)'
  return 'rgba(160, 180, 210, 0.7)'
}

function hexToNum(v: unknown): number {
  if (typeof v !== 'string') return 0
  const s = v.trim().toLowerCase()
  if (!s.startsWith('0x')) return 0
  const n = Number.parseInt(s.slice(2), 16)
  return Number.isFinite(n) ? n : 0
}

async function fetchAllPages<T extends JsonObj>(
  node: MonitoredNode,
  method: string,
  resultKey: string,
): Promise<T[]> {
  const all: T[] = []
  let cursor: unknown = undefined
  for (;;) {
    const params: Record<string, unknown> = { limit: PAGE_LIMIT }
    if (cursor !== undefined) params.after = cursor
    const res = await callFiberRpc<{ [key: string]: unknown }>(node, method, params)
    const page = Array.isArray(res?.[resultKey]) ? (res[resultKey] as T[]) : []
    all.push(...page)
    cursor = res?.last_cursor
    if (!cursor || page.length === 0) break
  }
  return all
}

interface Props {
  node: MonitoredNode | null
}

export default function NetworkTopology({ node }: Props) {
  const svgRef = useRef<SVGSVGElement>(null)
  const simulationRef = useRef<d3.Simulation<TopologyNode, TopologyLink> | null>(null)
  const [graphNodes, setGraphNodes] = useState<JsonObj[]>([])
  const [graphChannels, setGraphChannels] = useState<JsonObj[]>([])
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [loadError, setLoadError] = useState('')

  const loadTopology = useCallback(async () => {
    if (!node) return
    setLoadState('loading')
    setLoadError('')
    try {
      const [nodes, channels] = await Promise.all([
        fetchAllPages<JsonObj>(node, 'graph_nodes', 'nodes'),
        fetchAllPages<JsonObj>(node, 'graph_channels', 'channels'),
      ])
      setGraphNodes(nodes)
      setGraphChannels(channels)
      setLoadState('ready')
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
      setLoadState('error')
    }
  }, [node])

  const { nodes, links } = useMemo(() => {
    const channelCountMap = new Map<string, number>()
    for (const ch of graphChannels) {
      const n1 = typeof ch.node1 === 'string' ? ch.node1 : null
      const n2 = typeof ch.node2 === 'string' ? ch.node2 : null
      if (n1) channelCountMap.set(n1, (channelCountMap.get(n1) ?? 0) + 1)
      if (n2) channelCountMap.set(n2, (channelCountMap.get(n2) ?? 0) + 1)
    }

    const nodeIds = new Set<string>()
    const nodes: TopologyNode[] = graphNodes.map((n) => {
      const id = typeof n.node_id === 'string' ? n.node_id : String(n.node_id ?? '')
      const name = typeof n.node_name === 'string' ? n.node_name : ''
      nodeIds.add(id)
      const count = channelCountMap.get(id) ?? 0
      return { id, name, channelCount: count, level: nodeLevel(count) }
    })

    for (const ch of graphChannels) {
      const n1 = typeof ch.node1 === 'string' ? ch.node1 : null
      const n2 = typeof ch.node2 === 'string' ? ch.node2 : null
      if (n1 && !nodeIds.has(n1)) {
        nodeIds.add(n1)
        const count = channelCountMap.get(n1) ?? 0
        nodes.push({ id: n1, name: '', channelCount: count, level: nodeLevel(count) })
      }
      if (n2 && !nodeIds.has(n2)) {
        nodeIds.add(n2)
        const count = channelCountMap.get(n2) ?? 0
        nodes.push({ id: n2, name: '', channelCount: count, level: nodeLevel(count) })
      }
    }

    const pairMap = new Map<string, number>()
    const rawLinks: Array<{ node1: string; node2: string; capacity: number }> = []
    for (const ch of graphChannels) {
      const n1 = typeof ch.node1 === 'string' ? ch.node1 : null
      const n2 = typeof ch.node2 === 'string' ? ch.node2 : null
      if (!n1 || !n2) continue
      const pairKey = n1 < n2 ? `${n1}|${n2}` : `${n2}|${n1}`
      const idx = pairMap.get(pairKey) ?? 0
      pairMap.set(pairKey, idx + 1)
      rawLinks.push({ node1: n1, node2: n2, capacity: hexToNum(ch.capacity) })
    }

    const pairCount = new Map<string, number>()
    for (const [k, v] of pairMap) pairCount.set(k, v)

    const pairIndexTracker = new Map<string, number>()
    const links: TopologyLink[] = rawLinks.map(({ node1, node2, capacity }) => {
      const pairKey = node1 < node2 ? `${node1}|${node2}` : `${node2}|${node1}`
      const total = pairCount.get(pairKey) ?? 1
      const idx = pairIndexTracker.get(pairKey) ?? 0
      pairIndexTracker.set(pairKey, idx + 1)
      return { source: node1, target: node2, capacity, pairIndex: idx, pairTotal: total }
    })

    return { nodes, links }
  }, [graphNodes, graphChannels])

  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return

    const width = svg.clientWidth || 800
    const height = svg.clientHeight || 560

    d3.select(svg).selectAll('*').remove()

    if (nodes.length === 0) return

    const root = d3.select(svg)
    const container = root.append('g')

    root.call(
      d3.zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.1, 8])
        .on('zoom', (event: d3.D3ZoomEvent<SVGSVGElement, unknown>) => {
          container.attr('transform', event.transform.toString())
        }),
    )

    const nodesCopy: TopologyNode[] = nodes.map((n) => ({ ...n }))
    const nodeById = new Map(nodesCopy.map((n) => [n.id, n]))

    const linksCopy: TopologyLink[] = links
      .map((l) => {
        const srcId = typeof l.source === 'string' ? l.source : (l.source as TopologyNode).id
        const tgtId = typeof l.target === 'string' ? l.target : (l.target as TopologyNode).id
        const src = nodeById.get(srcId)
        const tgt = nodeById.get(tgtId)
        if (!src || !tgt) return null
        return { ...l, source: src as TopologyNode | string, target: tgt as TopologyNode | string } as TopologyLink
      })
      .filter((l): l is TopologyLink => l !== null)

    const simulation = d3.forceSimulation<TopologyNode>(nodesCopy)
      .force('link', d3.forceLink<TopologyNode, TopologyLink>(linksCopy).id((d) => d.id).distance(LINK_DISTANCE))
      .force('charge', d3.forceManyBody().strength(CHARGE_STRENGTH))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide(COLLISION_RADIUS))

    simulationRef.current = simulation

    const linkSel = container.append('g')
      .selectAll<SVGPathElement, TopologyLink>('path')
      .data(linksCopy)
      .join('path')
      .attr('class', 'ntLink')
      .attr('stroke-width', (d) => Math.max(0.5, Math.sqrt(d.capacity / 1e8) * 0.5))

    const nodeSel = container.append('g')
      .selectAll<SVGGElement, TopologyNode>('g')
      .data(nodesCopy)
      .join('g')
      .call(
        d3.drag<SVGGElement, TopologyNode>()
          .on('start', (event, d) => {
            if (!event.active) simulation.alphaTarget(0.3).restart()
            d.fx = d.x
            d.fy = d.y
          })
          .on('drag', (event, d) => {
            d.fx = event.x
            d.fy = event.y
          })
          .on('end', (event, d) => {
            if (!event.active) simulation.alphaTarget(0)
            d.fx = null
            d.fy = null
          }),
      )

    nodeSel.append('circle')
      .attr('class', 'ntNodeCircle')
      .attr('r', (d) => BASE_NODE_RADIUS + Math.min(d.channelCount, MAX_CHANNEL_SCALE) * CHANNEL_SCALE_FACTOR)
      .attr('stroke', (d) => levelColor(d.level))

    nodeSel.append('text')
      .attr('class', 'ntNodeIcon')
      .text((d) => levelIcon(d.level))

    nodeSel.append('text')
      .attr('class', 'ntNodeLabel')
      .attr('dy', (d) => BASE_NODE_RADIUS + Math.min(d.channelCount, MAX_CHANNEL_SCALE) * CHANNEL_SCALE_FACTOR + 4)
      .text((d) => d.name || (d.id.length > 12 ? `${d.id.slice(0, 8)}…` : d.id))

    simulation.on('tick', () => {
      linkSel.attr('d', (d) => {
        const src = d.source as TopologyNode
        const tgt = d.target as TopologyNode
        const x1 = src.x ?? 0
        const y1 = src.y ?? 0
        const x2 = tgt.x ?? 0
        const y2 = tgt.y ?? 0

        if (d.pairTotal === 1) {
          return `M${x1},${y1}L${x2},${y2}`
        }

        const midX = (x1 + x2) / 2
        const midY = (y1 + y2) / 2
        const dx = x2 - x1
        const dy = y2 - y1
        const len = Math.sqrt(dx * dx + dy * dy) || 1
        const offset = (d.pairIndex - (d.pairTotal - 1) / 2) * PARALLEL_EDGE_OFFSET
        const cx = midX + (-dy / len) * offset
        const cy = midY + (dx / len) * offset
        return `M${x1},${y1}Q${cx},${cy},${x2},${y2}`
      })

      nodeSel.attr('transform', (d) => `translate(${d.x ?? 0},${d.y ?? 0})`)
    })

    return () => {
      simulation.stop()
    }
  }, [nodes, links])

  return (
    <div className="networkTopologyWrap">
      <div className="ntToolbar">
        <button
          className="btn"
          onClick={() => void loadTopology()}
          disabled={!node || loadState === 'loading'}
        >
          {loadState === 'loading' ? 'Loading…' : 'Load Topology'}
        </button>
        {loadState === 'ready' && (
          <span className="muted" style={{ fontSize: 12 }}>
            {nodes.length} nodes · {links.length} channels
          </span>
        )}
        {loadState === 'error' && (
          <span style={{ fontSize: 12, color: 'var(--bad)' }}>{loadError}</span>
        )}
        {!node && (
          <span className="muted" style={{ fontSize: 12 }}>Select a node to load topology</span>
        )}
      </div>
      <svg ref={svgRef} className="networkTopologySvg" />
      {loadState === 'idle' && nodes.length === 0 && (
        <div className="ntEmpty">
          <div style={{ fontSize: 40, marginBottom: 12 }}>🕸️</div>
          <div>Click &ldquo;Load Topology&rdquo; to visualize the network graph</div>
        </div>
      )}
      <div className="ntLegend">
        <span className="ntLegendItem">👑 Tier 1 (≥10 ch)</span>
        <span className="ntLegendItem">⭐ Tier 2 (≥5 ch)</span>
        <span className="ntLegendItem">◆ Tier 3 (≥2 ch)</span>
        <span className="ntLegendItem">● Others</span>
        <span className="ntLegendItem" style={{ marginLeft: 'auto' }}>
          Scroll to zoom · Drag to pan · Drag nodes to reposition
        </span>
      </div>
    </div>
  )
}
