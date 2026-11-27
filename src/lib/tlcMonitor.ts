import type { CommitmentHtlc, CommitmentSettlementReport, CommitmentUnlockKind } from './ckb'
import { formatJson, hexToNumberMaybe } from './format'

export type TlcSeverity = 'danger' | 'warning' | 'info' | 'ok'

const SEVERITY_RANK: Record<TlcSeverity, number> = { ok: 0, info: 1, warning: 2, danger: 3 }

export function maxSeverity(a: TlcSeverity, b: TlcSeverity): TlcSeverity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b
}

export function isAttention(severity: TlcSeverity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK.warning
}

export const DEFAULT_SAFETY_WINDOW_MINUTES = 160
export const AUTO_RESCAN_OPTIONS = [0, 1, 5, 15]
export const ONCHAIN_RECHECK_MS = 5 * 60 * 1000
export const WARNING_LEAD_MS = 60 * 60 * 1000
export const LONG_PENDING_MS = 30 * 60 * 1000
export const CLAIM_GRACE_MS = 60 * 60 * 1000

export type TlcMonitorSettings = {
  safetyWindowMinutes: number
  autoRescanMinutes: number
}

const SETTINGS_STORAGE_KEY = 'fiber-nodes-monits:tlcMonitor'

export function loadTlcMonitorSettings(): TlcMonitorSettings {
  const fallback: TlcMonitorSettings = { safetyWindowMinutes: DEFAULT_SAFETY_WINDOW_MINUTES, autoRescanMinutes: 0 }
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<TlcMonitorSettings> | null
    if (!parsed || typeof parsed !== 'object') return fallback
    const safetyWindow = parsed.safetyWindowMinutes
    const rescan = parsed.autoRescanMinutes
    return {
      safetyWindowMinutes: typeof safetyWindow === 'number' && safetyWindow > 0 ? safetyWindow : fallback.safetyWindowMinutes,
      autoRescanMinutes: typeof rescan === 'number' && AUTO_RESCAN_OPTIONS.includes(rescan) ? rescan : 0,
    }
  } catch {
    return fallback
  }
}

export function saveTlcMonitorSettings(settings: TlcMonitorSettings) {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings))
}

export type ChannelPhase = 'offchain' | 'closing' | 'forceClosing' | 'settling' | 'settled' | 'closed' | 'stale' | 'other'

export type ForceCloseInitiator = 'local' | 'remote' | null

type ChannelStateInfo = { name: string; flags: string[] }

function normalizeToken(value: string): string {
  return value.replace(/[^a-z0-9]/gi, '').toLowerCase()
}

function splitFlags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((f): f is string => typeof f === 'string')
  if (typeof raw === 'string') return raw.split('|').map((f) => f.trim()).filter(Boolean)
  return []
}

function parseChannelState(raw: unknown): ChannelStateInfo {
  if (typeof raw === 'string') return { name: raw, flags: [] }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { name: '', flags: [] }
  const obj = raw as Record<string, unknown>
  if (typeof obj.state_name === 'string') return { name: obj.state_name, flags: splitFlags(obj.state_flags) }
  const [name] = Object.keys(obj)
  return name ? { name, flags: splitFlags(obj[name]) } : { name: '', flags: [] }
}

function getChannelPhase(state: ChannelStateInfo): ChannelPhase {
  const name = normalizeToken(state.name)
  const flags = new Set(state.flags.map(normalizeToken))
  if (name === 'channelready') return 'offchain'
  if (name === 'stale') return 'stale'
  if (name === 'shuttingdown') return flags.has('waitingcommitmentconfirmation') ? 'forceClosing' : 'closing'
  if (name !== 'closed') return 'other'
  const uncooperative = ['uncooperative', 'uncooperativelocal', 'uncooperativeremote'].some((f) => flags.has(f))
  if (!uncooperative) return 'closed'
  return flags.has('waitingonchainsettlement') ? 'settling' : 'settled'
}

function getForceCloseInitiator(state: ChannelStateInfo, phase: ChannelPhase): ForceCloseInitiator {
  const flags = new Set(state.flags.map(normalizeToken))
  if (flags.has('uncooperativeremote') && flags.has('uncooperativelocal')) return null
  if (flags.has('uncooperativeremote')) return 'remote'
  if (flags.has('uncooperativelocal') || phase === 'forceClosing') return 'local'
  return null
}

export function ourWitnessBalanceKind(initiator: ForceCloseInitiator): 'localBalance' | 'remoteBalance' | null {
  if (initiator === 'remote') return 'localBalance'
  if (initiator === 'local') return 'remoteBalance'
  return null
}

export function isForceClosePhase(phase: ChannelPhase): boolean {
  return phase === 'forceClosing' || phase === 'settling' || phase === 'settled'
}

export type FundingOutPoint = { txHash: string; index: number }

export function parseChannelOutpoint(raw: unknown): FundingOutPoint | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>
    const index = typeof obj.index === 'number' ? obj.index : hexToNumberMaybe(obj.index)
    return typeof obj.tx_hash === 'string' && index != null ? { txHash: obj.tx_hash.toLowerCase(), index } : null
  }
  if (typeof raw !== 'string') return null
  const value = raw.trim().toLowerCase()
  const pair = /^(0x[0-9a-f]{64}):(0x[0-9a-f]+|\d+)$/.exec(value)
  if (pair) return { txHash: pair[1], index: Number(pair[2]) }
  const hex = value.startsWith('0x') ? value.slice(2) : value
  if (!/^[0-9a-f]{72}$/.test(hex)) return null
  const indexBytes = hex.slice(64).match(/../g) ?? []
  return { txHash: `0x${hex.slice(0, 64)}`, index: parseInt(indexBytes.reverse().join(''), 16) }
}

export function onchainKeyOf(chainHash: string, outpoint: FundingOutPoint): string {
  return `${chainHash.toLowerCase()}|${outpoint.txHash}:${outpoint.index}`
}

export type TlcDirection = 'outbound' | 'inbound' | 'unknown'

export type TlcProgress = 'active' | 'removing' | 'removed'

const REMOVING_TLC_STATUSES = new Set(['remoteremoved', 'removewaitprevack', 'removewaitack', 'localremoved'])

function parseTlcProgress(status: unknown): { direction: TlcDirection; progress: TlcProgress } {
  let direction: TlcDirection = 'unknown'
  let code = ''
  if (typeof status === 'string') {
    code = status
  } else if (status && typeof status === 'object' && !Array.isArray(status)) {
    const [key] = Object.keys(status)
    const inner = key ? (status as Record<string, unknown>)[key] : null
    direction = key === 'Outbound' ? 'outbound' : key === 'Inbound' ? 'inbound' : 'unknown'
    code = typeof inner === 'string' ? inner : ''
  }
  const token = normalizeToken(code)
  const progress: TlcProgress =
    token === 'removeackconfirmed' ? 'removed' : REMOVING_TLC_STATUSES.has(token) ? 'removing' : 'active'
  return { direction, progress }
}

export type MonitoredTlc = {
  key: string
  id: string
  direction: TlcDirection
  status: unknown
  progress: TlcProgress
  amount: string
  expiryMs: number | null
  paymentHash: string
  forwardingChannelId: string | null
  forwardingTlcId: string | null
  firstSeenAt: number
}

export type MonitoredChannel = {
  key: string
  nodeId: string
  nodeName: string
  channelId: string
  stateName: string
  stateFlags: string[]
  phase: ChannelPhase
  initiator: ForceCloseInitiator
  outpoint: FundingOutPoint | null
  knownCommitmentTxHash: string | null
  isUdt: boolean
  chainHash: string | null
  tlcs: MonitoredTlc[]
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

export function buildMonitoredChannel(
  owner: { nodeId: string; nodeName: string },
  raw: unknown,
  chainHash: string | null,
  firstSeen: Map<string, number>,
  scannedAt: number,
): MonitoredChannel | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const state = parseChannelState(obj.state)
  const phase = getChannelPhase(state)
  const pending = Array.isArray(obj.pending_tlcs) ? obj.pending_tlcs : []
  if (!pending.length && !isForceClosePhase(phase)) return null
  const channelId = stringOrNull(obj.channel_id) ?? formatJson(obj.channel_id ?? '—')
  const key = `${owner.nodeId}|${channelId}`
  const tlcs = pending.map((item): MonitoredTlc => {
    const tlc = item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>) : {}
    const id = typeof tlc.id === 'string' || typeof tlc.id === 'number' ? String(tlc.id) : formatJson(tlc.id ?? '—')
    const { direction, progress } = parseTlcProgress(tlc.status)
    const tlcKey = `${key}|${direction}|${id}`
    const firstSeenAt = firstSeen.get(tlcKey) ?? scannedAt
    firstSeen.set(tlcKey, firstSeenAt)
    const expiry = hexToNumberMaybe(tlc.expiry)
    return {
      key: tlcKey,
      id,
      direction,
      status: tlc.status,
      progress,
      amount: stringOrNull(tlc.amount) ?? '0x0',
      expiryMs: expiry && expiry > 0 ? expiry : null,
      paymentHash: stringOrNull(tlc.payment_hash) ?? '',
      forwardingChannelId: stringOrNull(tlc.forwarding_channel_id),
      forwardingTlcId: tlc.forwarding_tlc_id == null ? null : String(tlc.forwarding_tlc_id),
      firstSeenAt,
    }
  })
  return {
    key,
    nodeId: owner.nodeId,
    nodeName: owner.nodeName,
    channelId,
    stateName: state.name || '—',
    stateFlags: state.flags,
    phase,
    initiator: getForceCloseInitiator(state, phase),
    outpoint: parseChannelOutpoint(obj.channel_outpoint),
    knownCommitmentTxHash: stringOrNull(obj.shutdown_transaction_hash) ?? stringOrNull(obj.latest_commitment_transaction_hash),
    isUdt: obj.funding_udt_type_script != null,
    chainHash,
    tlcs,
  }
}

export type OnchainCheck = {
  status: 'checking' | 'done' | 'error'
  report: CommitmentSettlementReport | null
  error: string | null
  checkedAt: number
}

export function isFinalReport(report: CommitmentSettlementReport | null): boolean {
  return report?.status === 'settled' || report?.status === 'revoked' || report?.status === 'cooperative'
}

export type TlcPhase =
  | 'offchain'
  | 'offchainClosing'
  | 'stale'
  | 'onchainConfirming'
  | 'onchainSettling'
  | 'onchainSettled'
  | 'closed'

export function isOnchainTlcPhase(phase: TlcPhase): boolean {
  return phase === 'onchainConfirming' || phase === 'onchainSettling' || phase === 'onchainSettled'
}

export type TlcReason =
  | 'removalHandled'
  | 'removedOffchain'
  | 'settledPreimage'
  | 'settledTimeout'
  | 'settledOnchain'
  | 'closedChannel'
  | 'revoked'
  | 'notInCommitment'
  | 'commitmentMissing'
  | 'expired'
  | 'expiredOnchain'
  | 'inboundExpired'
  | 'inboundExpiredOnchain'
  | 'inboundExpiring'
  | 'outboundFunds'
  | 'unknownDirection'
  | 'awaitingConfirmation'
  | 'awaitingDelay'
  | 'awaitingSettlement'
  | 'pastThreshold'
  | 'nearThreshold'
  | 'staleChannel'
  | 'longPending'
  | 'healthy'

export type TlcAssessment = {
  phase: TlcPhase
  severity: TlcSeverity
  reasons: TlcReason[]
  resolved: boolean
  timeLeftMs: number | null
  claimableAt: number | null
  settledTxHash: string | null
  forwarding: ForwardingEvidence | null
}

type ForwardingEvidence =
  | { outcome: 'paid' | 'refunded'; txHash: string; amount: string; isUdt: boolean }
  | { outcome: 'pending' | 'locked' | 'removed' | 'awaitingTrace' | 'checkFailed' | 'unmatched' | 'unproven' }

type OutboundLeg = { channel: MonitoredChannel; tlc: MonitoredTlc }

function hasForwardingLink(tlc: MonitoredTlc): boolean {
  return tlc.direction === 'inbound' && (tlc.forwardingChannelId != null || tlc.forwardingTlcId != null)
}

function canonicalTlcId(id: string | null): string | null {
  return id != null && /^(0x[\da-f]+|\d+)$/i.test(id) ? BigInt(id).toString() : null
}

function legKey(channel: MonitoredChannel, channelId: string | null, tlcId: string | null): string | null {
  const id = canonicalTlcId(tlcId)
  return channelId && id != null ? JSON.stringify([channel.nodeId, channel.chainHash?.toLowerCase(), channelId.toLowerCase(), id]) : null
}

function pairForwardingLegs(channels: MonitoredChannel[]): Map<MonitoredTlc, OutboundLeg | null> {
  const outgoing = new Map<string, OutboundLeg | null>()
  for (const channel of channels) {
    for (const tlc of channel.tlcs) {
      if (tlc.direction !== 'outbound') continue
      const key = legKey(channel, channel.channelId, tlc.id)
      if (key) outgoing.set(key, outgoing.has(key) ? null : { channel, tlc })
    }
  }
  const pairs = new Map<MonitoredTlc, OutboundLeg | null>()
  const linkedFrom = new Map<OutboundLeg, MonitoredTlc>()
  for (const channel of channels) {
    for (const tlc of channel.tlcs) {
      if (!hasForwardingLink(tlc)) continue
      const key = legKey(channel, tlc.forwardingChannelId, tlc.forwardingTlcId)
      const leg = key ? outgoing.get(key) : null
      const inboundId = canonicalTlcId(tlc.id)
      if (!leg || !/^0x[\da-f]{64}$/i.test(tlc.paymentHash) || leg.tlc.paymentHash.toLowerCase() !== tlc.paymentHash.toLowerCase() ||
        (leg.tlc.forwardingChannelId != null && leg.tlc.forwardingChannelId.toLowerCase() !== channel.channelId.toLowerCase()) ||
        (leg.tlc.forwardingTlcId != null && (inboundId == null || canonicalTlcId(leg.tlc.forwardingTlcId) !== inboundId))) {
        pairs.set(tlc, null)
        continue
      }
      const previous = linkedFrom.get(leg)
      if (previous) {
        pairs.set(previous, null)
        pairs.set(tlc, null)
      } else {
        linkedFrom.set(leg, tlc)
        pairs.set(tlc, leg)
      }
    }
  }
  return pairs
}

export function autoOnchainChannels(channels: MonitoredChannel[]): MonitoredChannel[] {
  const linked = new Set<MonitoredChannel>()
  for (const leg of pairForwardingLegs(channels).values()) if (leg) linked.add(leg.channel)
  return channels.filter((c) => c.phase === 'forceClosing' || c.phase === 'settling' || (c.phase === 'settled' && linked.has(c)))
}

function checkForwardingLeg(leg: OutboundLeg | null, checks: Record<string, OnchainCheck>): ForwardingEvidence {
  if (!leg) return { outcome: 'unmatched' }
  const { channel, tlc } = leg
  const key = checkKeyOf(channel)
  const check = key ? checks[key] : null
  if (check?.status === 'error') return { outcome: 'checkFailed' }
  const report = check?.report
  if (!report) {
    if (isForceClosePhase(channel.phase)) return { outcome: key ? 'awaitingTrace' : 'unproven' }
    if (tlc.progress !== 'active') return { outcome: 'removed' }
    return { outcome: channel.phase === 'closed' ? 'unproven' : 'pending' }
  }
  const first = report.steps[0]
  if (!first?.parsed || first.revocation || channel.initiator == null) return { outcome: 'unproven' }
  const matches = (h: CommitmentHtlc, t: MonitoredTlc) =>
    (h.paymentHash.length === 42 || h.paymentHash.length === 66) && htlcMatchesTlc(h, t) &&
    h.offered === (channel.initiator === 'remote') && t.expiryMs != null && Math.floor(t.expiryMs / 1000) * 1000 === h.expiryMs
  const candidates = first.htlcs.filter((h) => matches(h, tlc))
  if (candidates.length !== 1 || channel.tlcs.some((t) => t !== tlc && t.direction === 'outbound' && matches(candidates[0], t))) {
    return { outcome: 'unproven' }
  }
  if (report.remaining?.htlcs.some((h) => matches(h, tlc))) return { outcome: 'locked' }
  const receipts = report.steps.filter((s) => s.parsed && !s.revocation).flatMap((s) =>
    s.unlocks.filter((u) => (u.kind === 'htlcPreimage' || u.kind === 'htlcTimeout') && u.htlc && matches(u.htlc, tlc))
      .map((u) => ({ kind: u.kind, txHash: s.txHash })))
  if (receipts.length !== 1) return { outcome: 'unproven' }
  return { outcome: receipts[0].kind === 'htlcPreimage' ? 'paid' : 'refunded', txHash: receipts[0].txHash, amount: tlc.amount, isUdt: channel.isUdt }
}

function claimableAtOf(report: CommitmentSettlementReport | null): number | null {
  if (report?.commitmentTimestamp == null || report.delayMs == null) return null
  return report.commitmentTimestamp + report.delayMs
}

function tlcPhaseOf(channel: MonitoredChannel, report: CommitmentSettlementReport | null): TlcPhase {
  if (report?.status === 'settled' || report?.status === 'revoked') return 'onchainSettled'
  if (report?.status === 'settling') return 'onchainSettling'
  if (report?.status === 'cooperative') return 'closed'
  if (report?.status === 'fundingLive' && isForceClosePhase(channel.phase)) return 'onchainConfirming'
  switch (channel.phase) {
    case 'closing':
      return 'offchainClosing'
    case 'stale':
      return 'stale'
    case 'forceClosing':
      return 'onchainConfirming'
    case 'settling':
      return 'onchainSettling'
    case 'settled':
      return 'onchainSettled'
    case 'closed':
      return 'closed'
    default:
      return 'offchain'
  }
}

function toBigInt(value: string | null): bigint | null {
  if (!value) return null
  try {
    return BigInt(value)
  } catch {
    return null
  }
}

function htlcMatchesTlc(htlc: CommitmentHtlc, tlc: MonitoredTlc): boolean {
  const hash = htlc.paymentHash.toLowerCase()
  if (hash.length <= 2 || !tlc.paymentHash.toLowerCase().startsWith(hash)) return false
  const a = toBigInt(htlc.amount)
  return a != null && a === toBigInt(tlc.amount)
}

function findTlcUnlock(
  report: CommitmentSettlementReport,
  tlc: MonitoredTlc,
): { kind: CommitmentUnlockKind; txHash: string } | null {
  for (const step of report.steps) {
    const unlock = step.unlocks.find((u) => u.htlc && htlcMatchesTlc(u.htlc, tlc))
    if (unlock) return { kind: unlock.kind, txHash: step.txHash }
  }
  return null
}

function tlcInCommitment(report: CommitmentSettlementReport, tlc: MonitoredTlc): boolean | null {
  const first = report.steps[0]
  if (!first?.parsed || first.revocation) return null
  return first.htlcs.some((h) => htlcMatchesTlc(h, tlc))
}

export function assessTlc(
  channel: MonitoredChannel,
  tlc: MonitoredTlc,
  report: CommitmentSettlementReport | null,
  now: number,
  windowMs: number,
  forwarding: ForwardingEvidence | null = hasForwardingLink(tlc) ? { outcome: 'unmatched' } : null,
): TlcAssessment {
  const phase = tlcPhaseOf(channel, report)
  const timeLeftMs = tlc.expiryMs != null ? tlc.expiryMs - now : null
  const claimableAt = claimableAtOf(report)
  const verdict = (severity: TlcSeverity, reasons: TlcReason[], resolved = false): TlcAssessment => ({
    phase,
    severity,
    reasons,
    resolved,
    timeLeftMs,
    claimableAt,
    settledTxHash: null,
    forwarding,
  })
  const expiryVerdict = (level: 'danger' | 'warning', reason: 'expired' | 'expiredOnchain' | 'pastThreshold' | 'nearThreshold') => {
    if (tlc.direction !== 'inbound') {
      return verdict(level, [reason, tlc.direction === 'outbound' ? 'outboundFunds' : 'unknownDirection'])
    }
    const inboundReason = reason === 'expired' ? 'inboundExpired' : reason === 'expiredOnchain' ? 'inboundExpiredOnchain' : 'inboundExpiring'
    return verdict(forwarding && forwarding.outcome !== 'refunded' ? 'warning' : 'info', [inboundReason])
  }

  const stillLocked = report?.remaining?.htlcs.some((htlc) => htlcMatchesTlc(htlc, tlc))
  const unlock = report && !stillLocked ? findTlcUnlock(report, tlc) : null
  if (unlock) {
    return {
      ...verdict('ok', [unlock.kind === 'htlcPreimage' ? 'settledPreimage' : 'settledTimeout'], true),
      phase: 'onchainSettled',
      settledTxHash: unlock.txHash,
    }
  }
  if (tlc.progress === 'removed' && !stillLocked) return verdict('ok', ['removedOffchain'], true)
  if (phase === 'closed') return verdict('ok', ['closedChannel'], true)
  if (phase === 'onchainSettled') {
    return report?.status === 'revoked' ? verdict('info', ['revoked'], true) : verdict('ok', ['settledOnchain'], true)
  }
  if (phase === 'onchainConfirming' && (report?.commitmentTxStatus === 'unknown' || report?.commitmentTxStatus === 'rejected')) {
    return verdict('danger', ['commitmentMissing'])
  }
  if (phase === 'onchainSettling' && report && !stillLocked && tlcInCommitment(report, tlc) === false) {
    return verdict('info', ['notInCommitment'], true)
  }
  if (tlc.progress === 'removing' && !stillLocked) {
    return phase === 'stale'
      ? verdict('warning', ['removalHandled', 'staleChannel'])
      : verdict('info', ['removalHandled'], true)
  }
  if (phase === 'onchainConfirming') {
    if (timeLeftMs != null && timeLeftMs <= 0) return expiryVerdict('danger', 'expired')
    return verdict('info', ['awaitingConfirmation'])
  }
  if (phase === 'onchainSettling') {
    if (tlc.expiryMs != null && tlc.expiryMs <= now) {
      const overdueMs = now - Math.max(tlc.expiryMs, claimableAt ?? 0)
      if (overdueMs > windowMs) return expiryVerdict('danger', 'expiredOnchain')
      if (overdueMs > 0) return expiryVerdict('warning', 'expiredOnchain')
      return verdict('info', ['awaitingDelay'])
    }
    if (claimableAt != null && now < claimableAt) return verdict('info', ['awaitingDelay'])
    return verdict('info', ['awaitingSettlement'])
  }

  let assessment = verdict('ok', [])
  if (timeLeftMs != null) {
    if (timeLeftMs <= 0) {
      assessment = expiryVerdict('danger', 'expired')
    } else if (timeLeftMs < windowMs) {
      assessment = expiryVerdict('danger', 'pastThreshold')
    } else if (timeLeftMs < windowMs + WARNING_LEAD_MS) {
      assessment = expiryVerdict('warning', 'nearThreshold')
    }
  }
  if (phase === 'stale') {
    assessment.severity = maxSeverity(assessment.severity, 'warning')
    assessment.reasons.push('staleChannel')
  }
  if (now - tlc.firstSeenAt > LONG_PENDING_MS) {
    assessment.severity = maxSeverity(assessment.severity, 'info')
    assessment.reasons.push('longPending')
  }
  if (!assessment.reasons.length) assessment.reasons.push('healthy')
  return assessment
}

export type ForceCloseResult =
  | 'notChecked'
  | 'checkFailed'
  | 'confirming'
  | 'commitmentMissing'
  | 'awaitingDelay'
  | 'awaitingSettlement'
  | 'ownBalanceUnclaimed'
  | 'peerBalanceUnclaimed'
  | 'settlementNotStarted'
  | 'settled'
  | 'revoked'
  | 'cooperativeOnchain'
  | 'fundingUnknown'
  | 'untraceable'

const FORCE_CLOSE_RESULT_ORDER: ForceCloseResult[] = [
  'commitmentMissing',
  'ownBalanceUnclaimed',
  'settlementNotStarted',
  'revoked',
  'cooperativeOnchain',
  'untraceable',
  'fundingUnknown',
  'checkFailed',
  'confirming',
  'awaitingDelay',
  'peerBalanceUnclaimed',
  'awaitingSettlement',
  'notChecked',
  'settled',
]

export type ForceCloseNote = 'flagMismatch' | 'flagLagging' | 'htlcPending' | 'truncated' | 'tlcDanger' | 'tlcWarning'

export type ForceCloseAssessment = {
  result: ForceCloseResult
  ownSeverity: TlcSeverity
  severity: TlcSeverity
  notes: ForceCloseNote[]
  claimableAt: number | null
  ourAmount: string | null
  theirAmount: string | null
  ourBalanceClaimed: boolean
  theirBalanceClaimed: boolean
  pendingHtlcs: number
}

export function assessForceClose(
  channel: MonitoredChannel,
  check: OnchainCheck | null,
  tlcAssessments: TlcAssessment[],
  now: number,
): ForceCloseAssessment {
  const report = check?.report ?? null
  const claimableAt = claimableAtOf(report)
  const notes: ForceCloseNote[] = []
  let result: ForceCloseResult
  let ownSeverity: TlcSeverity
  let ourAmount: string | null = null
  let theirAmount: string | null = null
  let ourBalanceClaimed = false
  let theirBalanceClaimed = false
  let pendingHtlcs = 0

  if (!report) {
    result = check?.status === 'error' ? 'checkFailed' : 'notChecked'
    ownSeverity = result === 'checkFailed' ? 'warning' : channel.phase === 'settled' ? 'ok' : 'info'
  } else if (report.status === 'fundingLive') {
    const missing = report.commitmentTxStatus === 'unknown' || report.commitmentTxStatus === 'rejected'
    result = missing ? 'commitmentMissing' : 'confirming'
    ownSeverity = missing ? 'warning' : 'info'
    if (channel.phase !== 'forceClosing') {
      notes.push('flagMismatch')
      ownSeverity = 'warning'
    }
  } else if (report.status === 'settling') {
    const remaining = report.remaining
    if (remaining) {
      pendingHtlcs = remaining.htlcs.length
      const ourKind = ourWitnessBalanceKind(channel.initiator)
      if (ourKind) {
        ourAmount = ourKind === 'localBalance' ? remaining.localAmount : remaining.remoteAmount
        theirAmount = ourKind === 'localBalance' ? remaining.remoteAmount : remaining.localAmount
        const hasClaim = (kind: 'localBalance' | 'remoteBalance') => report.steps.some((step) =>
          step.parsed && step.unlocks.some((u) => u.kind === kind && (toBigInt(u.amount) ?? 0n) > 0n))
        ourBalanceClaimed = toBigInt(ourAmount) === 0n && hasClaim(ourKind)
        theirBalanceClaimed = toBigInt(theirAmount) === 0n && hasClaim(ourKind === 'localBalance' ? 'remoteBalance' : 'localBalance')
      }
    }
    const graceOver = claimableAt != null && now > claimableAt + CLAIM_GRACE_MS
    if (graceOver && (toBigInt(ourAmount) ?? 0n) > 0n) {
      result = 'ownBalanceUnclaimed'
      ownSeverity = 'warning'
    } else if (graceOver && toBigInt(ourAmount) === 0n && (toBigInt(theirAmount) ?? 0n) > 0n) {
      result = 'peerBalanceUnclaimed'
      ownSeverity = 'info'
    } else if (graceOver && !report.steps.length) {
      result = 'settlementNotStarted'
      ownSeverity = 'warning'
    } else if (claimableAt != null && now < claimableAt) {
      result = 'awaitingDelay'
      ownSeverity = 'info'
    } else {
      result = 'awaitingSettlement'
      ownSeverity = 'info'
    }
    if (pendingHtlcs > 0) notes.push('htlcPending')
    if (report.truncated) notes.push('truncated')
    if (channel.phase === 'settled') {
      notes.push('flagMismatch')
      ownSeverity = maxSeverity(ownSeverity, 'warning')
    }
  } else if (report.status === 'settled') {
    result = 'settled'
    ownSeverity = 'ok'
    if (channel.phase !== 'settled') {
      notes.push('flagLagging')
      ownSeverity = 'info'
    }
  } else if (report.status === 'cooperative') {
    result = 'cooperativeOnchain'
    ownSeverity = 'warning'
    notes.push('flagMismatch')
  } else {
    result = report.status
    ownSeverity = 'warning'
  }

  const worstTlc = tlcAssessments.reduce<TlcSeverity>((acc, a) => maxSeverity(acc, a.severity), 'ok')
  if (worstTlc === 'danger') notes.push('tlcDanger')
  else if (worstTlc === 'warning') notes.push('tlcWarning')
  return {
    result,
    ownSeverity,
    severity: maxSeverity(ownSeverity, worstTlc),
    notes,
    claimableAt,
    ourAmount,
    theirAmount,
    ourBalanceClaimed,
    theirBalanceClaimed,
    pendingHtlcs,
  }
}

export type TlcMonitorNodeResult = {
  nodeId: string
  nodeName: string
  ok: boolean
  error: string | null
  chainHash: string | null
  channelCount: number
}

export type TlcMonitorScan = {
  scannedAt: number
  nodes: TlcMonitorNodeResult[]
  channels: MonitoredChannel[]
}

export function pruneTlcFirstSeen(firstSeen: Map<string, number>, scan: TlcMonitorScan) {
  const scannedNodes = new Set(scan.nodes.filter((n) => n.ok).map((n) => n.nodeId))
  const currentKeys = new Set(scan.channels.flatMap((c) => c.tlcs.map((tlc) => tlc.key)))
  for (const key of firstSeen.keys()) {
    if (scannedNodes.has(key.split('|')[0]) && !currentKeys.has(key)) firstSeen.delete(key)
  }
}

export type TlcRow = { channel: MonitoredChannel; tlc: MonitoredTlc; assessment: TlcAssessment }

export type ForceCloseRow = {
  channel: MonitoredChannel
  check: OnchainCheck | null
  assessment: ForceCloseAssessment
}

export type TlcMonitorCounts = {
  nodesFailed: number
  tlcOpen: number
  tlcOffchain: number
  tlcOnchain: number
  tlcDanger: number
  tlcWarning: number
  forceCloseTotal: number
  forceCloseOpen: number
  forceCloseAttention: number
  unclaimedChannels: number
  unclaimedShannons: bigint
  danger: number
  attention: number
}

export type TlcMonitorData = {
  tlcRows: TlcRow[]
  forceCloseRows: ForceCloseRow[]
  counts: TlcMonitorCounts
}

export function checkKeyOf(channel: MonitoredChannel): string | null {
  return channel.chainHash && channel.outpoint ? onchainKeyOf(channel.chainHash, channel.outpoint) : null
}

function compareTlcRows(a: TlcRow, b: TlcRow): number {
  const bySeverity = SEVERITY_RANK[b.assessment.severity] - SEVERITY_RANK[a.assessment.severity]
  if (bySeverity) return bySeverity
  if (a.assessment.resolved !== b.assessment.resolved) return a.assessment.resolved ? 1 : -1
  const byExpiry = (a.tlc.expiryMs ?? Number.MAX_SAFE_INTEGER) - (b.tlc.expiryMs ?? Number.MAX_SAFE_INTEGER)
  if (byExpiry) return byExpiry
  return a.channel.nodeName.localeCompare(b.channel.nodeName)
}

function compareForceCloseRows(a: ForceCloseRow, b: ForceCloseRow): number {
  const bySeverity = SEVERITY_RANK[b.assessment.severity] - SEVERITY_RANK[a.assessment.severity]
  if (bySeverity) return bySeverity
  const byResult =
    FORCE_CLOSE_RESULT_ORDER.indexOf(a.assessment.result) - FORCE_CLOSE_RESULT_ORDER.indexOf(b.assessment.result)
  if (byResult) return byResult
  return (b.check?.report?.lastActivityAt ?? 0) - (a.check?.report?.lastActivityAt ?? 0)
}

export function buildTlcMonitorData(
  scan: TlcMonitorScan,
  checks: Record<string, OnchainCheck>,
  now: number,
  windowMs: number,
): TlcMonitorData {
  const tlcRows: TlcRow[] = []
  const forceCloseRows: ForceCloseRow[] = []
  const pairs = pairForwardingLegs(scan.channels)
  for (const channel of scan.channels) {
    const key = checkKeyOf(channel)
    const check = key ? checks[key] ?? null : null
    const rows = channel.tlcs.map((tlc) => {
      const leg = pairs.get(tlc)
      const forwarding = leg === undefined ? null : checkForwardingLeg(leg, checks)
      return { channel, tlc, assessment: assessTlc(channel, tlc, check?.report ?? null, now, windowMs, forwarding) }
    })
    tlcRows.push(...rows)
    if (isForceClosePhase(channel.phase)) {
      forceCloseRows.push({
        channel,
        check,
        assessment: assessForceClose(channel, check, rows.map((r) => r.assessment), now),
      })
    }
  }
  tlcRows.sort(compareTlcRows)
  forceCloseRows.sort(compareForceCloseRows)

  const openTlcs = tlcRows.filter((r) => !r.assessment.resolved)
  const tlcOnchain = openTlcs.filter((r) => isOnchainTlcPhase(r.assessment.phase)).length
  const tlcDanger = tlcRows.filter((r) => r.assessment.severity === 'danger').length
  const tlcWarning = tlcRows.filter((r) => r.assessment.severity === 'warning').length
  const forceCloseDanger = forceCloseRows.filter((r) => r.assessment.ownSeverity === 'danger').length
  const forceCloseAttention = forceCloseRows.filter((r) => isAttention(r.assessment.ownSeverity)).length
  const unclaimed = forceCloseRows.filter((r) => r.assessment.result === 'ownBalanceUnclaimed')
  const unclaimedShannons = unclaimed
    .filter((r) => !r.channel.isUdt)
    .reduce((sum, r) => sum + (toBigInt(r.assessment.ourAmount) ?? 0n), 0n)
  const nodesFailed = scan.nodes.filter((n) => !n.ok).length

  return {
    tlcRows,
    forceCloseRows,
    counts: {
      nodesFailed,
      tlcOpen: openTlcs.length,
      tlcOffchain: openTlcs.length - tlcOnchain,
      tlcOnchain,
      tlcDanger,
      tlcWarning,
      forceCloseTotal: forceCloseRows.length,
      forceCloseOpen: forceCloseRows.filter((r) => r.assessment.severity !== 'ok').length,
      forceCloseAttention,
      unclaimedChannels: unclaimed.length,
      unclaimedShannons,
      danger: tlcDanger + forceCloseDanger,
      attention: tlcDanger + tlcWarning + forceCloseAttention + nodesFailed,
    },
  }
}

export function formatDurationShort(ms: number): string {
  const minutes = Math.floor(Math.abs(ms) / 60000)
  if (minutes < 1) return '<1m'
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  if (days > 0) return hours ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return mins ? `${hours}h ${mins}m` : `${hours}h`
  return `${mins}m`
}
