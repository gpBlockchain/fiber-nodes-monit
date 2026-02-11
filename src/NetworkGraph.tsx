import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { shorten } from './lib/format'
import type { MonitoredNode } from './lib/storage'

export type GraphNodeData = {
  node: MonitoredNode
  nodeId: string | null
  ok: boolean
  peers: string[]
  channels: { channelId: string; peerId: string; state: string; localBalance: string; remoteBalance: string }[]
}

type DragState =
  | { kind: 'none' }
  | { kind: 'moving'; nodeIdx: number; offsetX: number; offsetY: number }
  | { kind: 'linking'; fromIdx: number; toX: number; toY: number; snapIdx: number | null }

type ActionMenuState = {
  nodeIdx: number
  x: number
  y: number
} | null

type LinkMenuState = {
  fromIdx: number
  toIdx: number
  x: number
  y: number
} | null

type ChannelMenuState = {
  channelId: string
  fromIdx: number
  toIdx: number
  x: number
  y: number
  state: string
} | null

type NodePos = { x: number; y: number }

const SPHERE_RADIUS = 38
const HIT_RADIUS = 44
const COLORS = [
  '#7cffd6', '#8a7dff', '#ffd166', '#ff6b9d', '#6bdfff',
  '#c4b5fd', '#86efac', '#fca5a5', '#fdba74', '#67e8f9',
]

function getNodeColor(index: number): string {
  return COLORS[index % COLORS.length]
}

function circleLayout(count: number, cx: number, cy: number, radius: number): NodePos[] {
  if (count === 0) return []
  if (count === 1) return [{ x: cx, y: cy }]
  return Array.from({ length: count }, (_, i) => {
    const angle = (2 * Math.PI * i) / count - Math.PI / 2
    return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) }
  })
}

function dist(a: NodePos, b: NodePos): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2)
}

export function NetworkGraph({
  graphNodes,
  summaries,
  selectedNodeId,
  onSelectNode,
  onConnectPeer,
  onOpenChannel,
  onSendPayment,
  onShutdownChannel,
}: {
  graphNodes: GraphNodeData[]
  summaries: Record<string, { ok: boolean }>
  selectedNodeId: string | null
  onSelectNode: (nodeId: string) => void
  onConnectPeer: (fromNode: MonitoredNode, toNode: MonitoredNode) => void
  onOpenChannel: (fromNode: MonitoredNode, toNode: MonitoredNode, toNodeId: string) => void
  onSendPayment: (fromNode: MonitoredNode, toNode: MonitoredNode, toNodeId: string) => void
  onShutdownChannel: (fromNode: MonitoredNode, channelId: string) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 800, h: 600 })
  const [positions, setPositions] = useState<NodePos[]>([])
  const [drag, setDrag] = useState<DragState>({ kind: 'none' })
  const [actionMenu, setActionMenu] = useState<ActionMenuState>(null)
  const [linkMenu, setLinkMenu] = useState<LinkMenuState>(null)
  const [channelMenu, setChannelMenu] = useState<ChannelMenuState>(null)
  const [hoveredNode, setHoveredNode] = useState<number | null>(null)
  const [animTick, setAnimTick] = useState(0)
  const positionsRef = useRef(positions)
  positionsRef.current = positions

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect()
      setSize({ w: Math.max(400, Math.floor(rect.width)), h: Math.max(300, Math.floor(rect.height)) })
    })
    ro.observe(el)
    const rect = el.getBoundingClientRect()
    setSize({ w: Math.max(400, Math.floor(rect.width)), h: Math.max(300, Math.floor(rect.height)) })
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const id = setInterval(() => setAnimTick((t) => t + 1), 50)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (graphNodes.length === 0) {
      setPositions([])
      return
    }
    const prev = positionsRef.current
    if (prev.length === graphNodes.length) return
    const cx = size.w / 2
    const cy = size.h / 2
    const layoutR = Math.min(size.w, size.h) * 0.32
    const newPos = circleLayout(graphNodes.length, cx, cy, layoutR)
    for (let i = 0; i < Math.min(prev.length, newPos.length); i++) {
      newPos[i] = prev[i]
    }
    setPositions(newPos)
  }, [graphNodes.length, size])

  const peerLinks = useMemo(() => {
    const links: { from: number; to: number }[] = []
    const nodeIdxByRpcPeerId = new Map<string, number>()
    for (let i = 0; i < graphNodes.length; i++) {
      const nid = graphNodes[i].nodeId
      if (nid) nodeIdxByRpcPeerId.set(nid, i)
    }
    for (let i = 0; i < graphNodes.length; i++) {
      for (const pid of graphNodes[i].peers) {
        const j = nodeIdxByRpcPeerId.get(pid)
        if (j != null && j > i) {
          links.push({ from: i, to: j })
        }
      }
    }
    return links
  }, [graphNodes])

  const channelLinks = useMemo(() => {
    const links: { from: number; to: number; channelId: string; state: string; localBalance: string; remoteBalance: string }[] = []
    const nodeIdxByRpcPeerId = new Map<string, number>()
    for (let i = 0; i < graphNodes.length; i++) {
      const nid = graphNodes[i].nodeId
      if (nid) nodeIdxByRpcPeerId.set(nid, i)
    }
    const seen = new Set<string>()
    for (let i = 0; i < graphNodes.length; i++) {
      for (const ch of graphNodes[i].channels) {
        if (seen.has(ch.channelId)) continue
        seen.add(ch.channelId)
        const j = nodeIdxByRpcPeerId.get(ch.peerId)
        if (j != null) {
          links.push({ from: i, to: j, channelId: ch.channelId, state: ch.state, localBalance: ch.localBalance, remoteBalance: ch.remoteBalance })
        }
      }
    }
    return links
  }, [graphNodes])

  const hitTest = useCallback((mx: number, my: number): number | null => {
    const pos = positionsRef.current
    for (let i = pos.length - 1; i >= 0; i--) {
      if (dist(pos[i], { x: mx, y: my }) <= HIT_RADIUS) return i
    }
    return null
  }, [])

  const getCanvasCoords = useCallback((e: React.MouseEvent): { x: number; y: number } => {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }, [])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    setActionMenu(null)
    setLinkMenu(null)
    setChannelMenu(null)
    const { x, y } = getCanvasCoords(e)
    const idx = hitTest(x, y)
    if (idx == null) return
    if (e.button === 2 || e.ctrlKey || e.metaKey) {
      setActionMenu({ nodeIdx: idx, x: e.clientX, y: e.clientY })
      return
    }
    if (e.shiftKey) {
      setDrag({ kind: 'linking', fromIdx: idx, toX: x, toY: y, snapIdx: null })
    } else {
      const pos = positionsRef.current[idx]
      setDrag({ kind: 'moving', nodeIdx: idx, offsetX: x - pos.x, offsetY: y - pos.y })
    }
  }, [hitTest, getCanvasCoords])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const { x, y } = getCanvasCoords(e)
    if (drag.kind === 'moving') {
      setPositions((prev) => {
        const next = [...prev]
        next[drag.nodeIdx] = { x: x - drag.offsetX, y: y - drag.offsetY }
        return next
      })
    } else if (drag.kind === 'linking') {
      const snap = hitTest(x, y)
      setDrag({ ...drag, toX: x, toY: y, snapIdx: snap !== drag.fromIdx ? snap : null })
    } else {
      setHoveredNode(hitTest(x, y))
    }
  }, [drag, hitTest, getCanvasCoords])

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    if (drag.kind === 'linking') {
      const { fromIdx, snapIdx } = drag
      if (snapIdx != null && snapIdx !== fromIdx) {
        setLinkMenu({ fromIdx, toIdx: snapIdx, x: e.clientX, y: e.clientY })
      }
    } else if (drag.kind === 'moving') {
      // nothing
    } else {
      const { x, y } = getCanvasCoords(e)
      const idx = hitTest(x, y)
      if (idx != null) {
        onSelectNode(graphNodes[idx].node.id)
      }
    }
    setDrag({ kind: 'none' })
  }, [drag, hitTest, getCanvasCoords, graphNodes, onSelectNode])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const { x, y } = getCanvasCoords(e)
    const idx = hitTest(x, y)
    if (idx != null) {
      setActionMenu({ nodeIdx: idx, x: e.clientX, y: e.clientY })
      setLinkMenu(null)
      setChannelMenu(null)
    }
  }, [hitTest, getCanvasCoords])

  const handleChannelClick = useCallback((channelId: string, fromIdx: number, toIdx: number, state: string, cx: number, cy: number) => {
    setChannelMenu({ channelId, fromIdx, toIdx, x: cx, y: cy, state })
    setActionMenu(null)
    setLinkMenu(null)
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = size.w * dpr
    canvas.height = size.h * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size.w, size.h)

    if (positions.length === 0) return

    const t = animTick * 0.05

    for (const link of peerLinks) {
      const a = positions[link.from]
      const b = positions[link.to]
      if (!a || !b) continue
      ctx.save()
      ctx.strokeStyle = 'rgba(200, 220, 255, 0.12)'
      ctx.lineWidth = 1
      ctx.setLineDash([4, 6])
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
      ctx.restore()
    }

    for (const link of channelLinks) {
      const a = positions[link.from]
      const b = positions[link.to]
      if (!a || !b) continue
      const isActive = link.state.includes('Normal')
      const color = isActive ? 'rgba(124, 255, 214, 0.55)' : 'rgba(255, 209, 102, 0.4)'
      ctx.save()
      ctx.strokeStyle = color
      ctx.lineWidth = 2.5
      ctx.shadowColor = color
      ctx.shadowBlur = 8
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()

      if (isActive) {
        const d = dist(a, b)
        if (d > 1) {
          const pulse = ((t * 2) % 1)
          const px = a.x + (b.x - a.x) * pulse
          const py = a.y + (b.y - a.y) * pulse
          ctx.beginPath()
          ctx.arc(px, py, 3, 0, Math.PI * 2)
          ctx.fillStyle = 'rgba(124, 255, 214, 0.9)'
          ctx.shadowColor = 'rgba(124, 255, 214, 0.6)'
          ctx.shadowBlur = 12
          ctx.fill()
        }
      }
      ctx.restore()

      const mx = (a.x + b.x) / 2
      const my = (a.y + b.y) / 2
      ctx.save()
      ctx.font = '9px "IBM Plex Mono", monospace'
      ctx.textAlign = 'center'
      ctx.fillStyle = 'rgba(244, 247, 255, 0.45)'
      const stateLabel = link.state.length > 20 ? link.state.slice(0, 18) + '…' : link.state
      ctx.fillText(stateLabel, mx, my - 4)
      ctx.restore()
    }

    if (drag.kind === 'linking') {
      const from = positions[drag.fromIdx]
      if (from) {
        ctx.save()
        ctx.strokeStyle = drag.snapIdx != null ? 'rgba(124, 255, 214, 0.7)' : 'rgba(138, 125, 255, 0.5)'
        ctx.lineWidth = 2
        ctx.setLineDash([6, 4])
        ctx.shadowColor = drag.snapIdx != null ? 'rgba(124, 255, 214, 0.4)' : 'rgba(138, 125, 255, 0.3)'
        ctx.shadowBlur = 10
        ctx.beginPath()
        ctx.moveTo(from.x, from.y)
        const tx = drag.snapIdx != null ? positions[drag.snapIdx].x : drag.toX
        const ty = drag.snapIdx != null ? positions[drag.snapIdx].y : drag.toY
        ctx.lineTo(tx, ty)
        ctx.stroke()

        ctx.beginPath()
        const angle = Math.atan2(ty - from.y, tx - from.x)
        ctx.moveTo(tx, ty)
        ctx.lineTo(tx - 12 * Math.cos(angle - 0.3), ty - 12 * Math.sin(angle - 0.3))
        ctx.moveTo(tx, ty)
        ctx.lineTo(tx - 12 * Math.cos(angle + 0.3), ty - 12 * Math.sin(angle + 0.3))
        ctx.stroke()
        ctx.restore()
      }
    }

    for (let i = 0; i < graphNodes.length; i++) {
      const pos = positions[i]
      if (!pos) continue
      const gd = graphNodes[i]
      const color = getNodeColor(i)
      const isSelected = gd.node.id === selectedNodeId
      const isHovered = hoveredNode === i
      const ok = summaries[gd.node.id]?.ok ?? false
      const r = SPHERE_RADIUS + (isHovered ? 4 : 0) + (isSelected ? 2 : 0)

      ctx.save()

      const grad = ctx.createRadialGradient(pos.x - r * 0.3, pos.y - r * 0.3, r * 0.1, pos.x, pos.y, r)
      if (ok) {
        grad.addColorStop(0, `${color}cc`)
        grad.addColorStop(0.6, `${color}55`)
        grad.addColorStop(1, `${color}11`)
      } else {
        grad.addColorStop(0, 'rgba(255, 77, 109, 0.8)')
        grad.addColorStop(0.6, 'rgba(255, 77, 109, 0.3)')
        grad.addColorStop(1, 'rgba(255, 77, 109, 0.05)')
      }

      if (isSelected || isHovered) {
        ctx.shadowColor = color
        ctx.shadowBlur = isSelected ? 30 : 18
      }

      ctx.beginPath()
      ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2)
      ctx.fillStyle = grad
      ctx.fill()

      ctx.strokeStyle = isSelected ? `${color}aa` : ok ? `${color}44` : 'rgba(255, 77, 109, 0.3)'
      ctx.lineWidth = isSelected ? 2.5 : 1.5
      ctx.stroke()

      const shine = ctx.createRadialGradient(pos.x - r * 0.25, pos.y - r * 0.35, 0, pos.x - r * 0.1, pos.y - r * 0.15, r * 0.7)
      shine.addColorStop(0, 'rgba(255, 255, 255, 0.35)')
      shine.addColorStop(1, 'rgba(255, 255, 255, 0)')
      ctx.beginPath()
      ctx.arc(pos.x, pos.y, r * 0.9, 0, Math.PI * 2)
      ctx.fillStyle = shine
      ctx.fill()

      ctx.restore()

      ctx.save()
      ctx.font = 'bold 11px "IBM Plex Mono", monospace'
      ctx.textAlign = 'center'
      ctx.fillStyle = 'rgba(244, 247, 255, 0.95)'
      ctx.shadowColor = 'rgba(0,0,0,0.8)'
      ctx.shadowBlur = 4
      ctx.fillText(gd.node.name, pos.x, pos.y + r + 16)

      if (gd.channels.length > 0) {
        ctx.font = '9px "IBM Plex Mono", monospace'
        ctx.fillStyle = 'rgba(244, 247, 255, 0.5)'
        ctx.shadowBlur = 2
        ctx.fillText(`${gd.channels.length} ch`, pos.x, pos.y + r + 28)
      }
      ctx.restore()

      if (!ok) {
        ctx.save()
        ctx.font = 'bold 10px sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillStyle = 'rgba(255, 77, 109, 0.9)'
        ctx.shadowColor = 'rgba(0,0,0,0.6)'
        ctx.shadowBlur = 3
        ctx.fillText('✕', pos.x, pos.y)
        ctx.restore()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions, graphNodes, summaries, selectedNodeId, hoveredNode, drag, peerLinks, channelLinks, animTick, size])

  const channelHitAreas = useMemo(() => {
    return channelLinks.map((link) => {
      const a = positions[link.from]
      const b = positions[link.to]
      if (!a || !b) return null
      return { ...link, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }
    }).filter(Boolean) as (typeof channelLinks[0] & { mx: number; my: number })[]
  }, [channelLinks, positions])

  const handleCanvasClick = useCallback((e: React.MouseEvent) => {
    if (drag.kind !== 'none') return
    const { x, y } = getCanvasCoords(e)
    for (const ch of channelHitAreas) {
      if (dist({ x, y }, { x: ch.mx, y: ch.my }) < 16) {
        const rect = canvasRef.current?.getBoundingClientRect()
        if (rect) {
          handleChannelClick(ch.channelId, ch.from, ch.to, ch.state, e.clientX, e.clientY)
        }
        return
      }
    }
  }, [drag, getCanvasCoords, channelHitAreas, handleChannelClick])

  return (
    <div ref={containerRef} className="graphContainer">
      <canvas
        ref={canvasRef}
        width={size.w}
        height={size.h}
        style={{ width: size.w, height: size.h, cursor: drag.kind === 'linking' ? 'crosshair' : hoveredNode != null ? 'grab' : 'default' }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onClick={handleCanvasClick}
        onContextMenu={handleContextMenu}
      />

      <div className="graphHint">
        <span>Click node to select</span>
        <span>·</span>
        <span>Drag to move</span>
        <span>·</span>
        <span>Shift+Drag to link</span>
        <span>·</span>
        <span>Right-click for menu</span>
        <span>·</span>
        <span>Click channel line for options</span>
      </div>

      {actionMenu && graphNodes[actionMenu.nodeIdx] ? (
        <div
          className="graphMenu"
          style={{ left: actionMenu.x, top: actionMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="graphMenuTitle">{graphNodes[actionMenu.nodeIdx].node.name}</div>
          <button className="graphMenuItem" onClick={() => {
            onSelectNode(graphNodes[actionMenu.nodeIdx].node.id)
            setActionMenu(null)
          }}>
            📌 Select Node
          </button>
          {graphNodes[actionMenu.nodeIdx].channels.map((ch) => (
            <button key={ch.channelId} className="graphMenuItem graphMenuDanger" onClick={() => {
              onShutdownChannel(graphNodes[actionMenu.nodeIdx].node, ch.channelId)
              setActionMenu(null)
            }}>
              ⛔ Shutdown {shorten(ch.channelId, 8, 4)}
            </button>
          ))}
          <button className="graphMenuItem graphMenuClose" onClick={() => setActionMenu(null)}>
            ✕ Close
          </button>
        </div>
      ) : null}

      {linkMenu && graphNodes[linkMenu.fromIdx] && graphNodes[linkMenu.toIdx] ? (() => {
        const fromGd = graphNodes[linkMenu.fromIdx]
        const toGd = graphNodes[linkMenu.toIdx]
        const arePeers = fromGd.peers.includes(toGd.nodeId ?? '') || toGd.peers.includes(fromGd.nodeId ?? '')
        const hasChannel = fromGd.channels.some((ch) => ch.peerId === toGd.nodeId) || toGd.channels.some((ch) => ch.peerId === fromGd.nodeId)
        return (
          <div
            className="graphMenu"
            style={{ left: linkMenu.x, top: linkMenu.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="graphMenuTitle">{fromGd.node.name} → {toGd.node.name}</div>
            {!arePeers ? (
              <button className="graphMenuItem" onClick={() => {
                onConnectPeer(fromGd.node, toGd.node)
                setLinkMenu(null)
              }}>
                🔗 Connect Peer
              </button>
            ) : null}
            {arePeers && !hasChannel && toGd.nodeId ? (
              <button className="graphMenuItem" onClick={() => {
                onOpenChannel(fromGd.node, toGd.node, toGd.nodeId!)
                setLinkMenu(null)
              }}>
                📡 Open Channel
              </button>
            ) : null}
            {hasChannel && toGd.nodeId ? (
              <button className="graphMenuItem" onClick={() => {
                onSendPayment(fromGd.node, toGd.node, toGd.nodeId!)
                setLinkMenu(null)
              }}>
                💸 Send Payment
              </button>
            ) : null}
            {!arePeers ? (
              <div className="graphMenuNote">Nodes not yet connected as peers</div>
            ) : !hasChannel ? (
              <div className="graphMenuNote">Connected but no channel yet</div>
            ) : (
              <div className="graphMenuNote">Channel active — ready for payment</div>
            )}
            <button className="graphMenuItem graphMenuClose" onClick={() => setLinkMenu(null)}>
              ✕ Close
            </button>
          </div>
        )
      })() : null}

      {channelMenu ? (() => {
        const fromGd = graphNodes[channelMenu.fromIdx]
        if (!fromGd) return null
        return (
          <div
            className="graphMenu"
            style={{ left: channelMenu.x, top: channelMenu.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="graphMenuTitle">Channel {shorten(channelMenu.channelId, 10, 6)}</div>
            <div className="graphMenuNote">{channelMenu.state}</div>
            <button className="graphMenuItem graphMenuDanger" onClick={() => {
              onShutdownChannel(fromGd.node, channelMenu.channelId)
              setChannelMenu(null)
            }}>
              ⛔ Shutdown Channel
            </button>
            <button className="graphMenuItem graphMenuClose" onClick={() => setChannelMenu(null)}>
              ✕ Close
            </button>
          </div>
        )
      })() : null}
    </div>
  )
}
