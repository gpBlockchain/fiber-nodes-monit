export function shorten(value: string, left = 10, right = 6) {
  if (value.length <= left + right + 2) return value
  return `${value.slice(0, left)}…${value.slice(-right)}`
}

export function hexToNumberMaybe(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const v = value.trim().toLowerCase()
  if (!v.startsWith('0x')) return null
  const n = Number.parseInt(v.slice(2), 16)
  if (!Number.isFinite(n)) return null
  return n
}

export function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function safeUrlLabel(url: string): string {
  try {
    const u = new URL(url)
    const port = u.port ? `:${u.port}` : ''
    return `${u.hostname}${port}`
  } catch {
    return url
  }
}

export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

