export type MonitoredNode = {
  id: string
  name: string
  rpcUrl: string
  token?: string
  createdAt: number
}

const STORAGE_KEY = 'fiber-nodes-monits:nodes:v1'

export function loadNodes(): MonitoredNode[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((x) => x && typeof x === 'object')
      .map((x) => x as Partial<MonitoredNode>)
      .filter((n) => typeof n.id === 'string' && typeof n.rpcUrl === 'string')
      .map((n) => ({
        id: n.id!,
        name: typeof n.name === 'string' && n.name.trim() ? n.name : n.id!.slice(0, 8),
        rpcUrl: n.rpcUrl!,
        token: typeof n.token === 'string' && n.token ? n.token : undefined,
        createdAt: typeof n.createdAt === 'number' ? n.createdAt : Date.now(),
      }))
  } catch {
    return []
  }
}

export function saveNodes(nodes: MonitoredNode[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(nodes))
}

