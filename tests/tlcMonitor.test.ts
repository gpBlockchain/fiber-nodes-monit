import assert from 'node:assert/strict'
import test from 'node:test'
import type { CommitmentSettlementReport } from '../src/lib/ckb'
import {
  CLAIM_GRACE_MS, WARNING_LEAD_MS, assessForceClose, assessTlc, autoOnchainChannels, buildMonitoredChannel,
  buildTlcMonitorData, checkKeyOf, type OnchainCheck,
} from '../src/lib/tlcMonitor'

const now = 1_800_000_000_000
const windowMs = 160 * 60_000
const fundingHash = `0x${'11'.repeat(32)}`
const closeHash = `0x${'22'.repeat(32)}`
const closed = (flag: string) => ({ state_name: 'Closed', state_flags: `${flag}|WAITING_ONCHAIN_SETTLEMENT` })

function nodeChannel(state: unknown, tlcs: unknown[] = [], nodeId = 'observer', channelId = 'channel', funding = fundingHash) {
  const channel = buildMonitoredChannel({ nodeId, nodeName: nodeId }, {
    channel_id: channelId, state, channel_outpoint: { tx_hash: funding, index: '0x0' },
    shutdown_transaction_hash: closeHash, pending_tlcs: tlcs,
  }, 'chain', new Map(), now)
  assert.ok(channel)
  return channel
}

function pending(status: unknown, timeLeft: number, forwarded = false) {
  return { id: '0x0', status, amount: '0x63', payment_hash: '0x1234', expiry: `0x${(now + timeLeft).toString(16)}`,
    forwarding_channel_id: forwarded ? 'other-leg' : null }
}

function reportAfterClaim(slot: '0xFF' | '0xFE'): CommitmentSettlementReport {
  const secondClaimed = slot === '0xFF'
  const first = '1700000000', second = '2300000000'
  return {
    status: 'settling', commitmentTxHash: closeHash, commitmentTxStatus: 'committed',
    commitmentTimestamp: now - windowMs - CLAIM_GRACE_MS, delayMs: 0, truncated: false,
    lastActivityAt: now, liveCell: {txHash: 'settlement', index: 0, capacity: '9999999999'},
    remaining: {htlcs: [], remoteAmount: secondClaimed ? first : '0', localAmount: secondClaimed ? '0' : second},
    steps: [{txHash: 'settlement', timestamp: now, parsed: true, revocation: false, htlcs: [],
      remoteAmount: first, localAmount: second, unlocks: [{htlc: null,
        kind: secondClaimed ? 'localBalance' : 'remoteBalance', amount: secondClaimed ? second : first}]}],
  }
}

function check(report: CommitmentSettlementReport): OnchainCheck {
  return { status: 'done', report, error: null, checkedAt: now }
}

test('expiry is relative to the offering side; inbound remains open, not locally dangerous from age alone', () => {
  for (const [left, outbound] of [[-1, 'danger'], [0, 'danger'], [windowMs - 1, 'danger'], [windowMs, 'warning']] as const) {
    const inbound = nodeChannel('ChannelReady', [pending({Inbound: 'Committed'}, left)])
    const peer = nodeChannel('ChannelReady', [pending({Outbound: 'Committed'}, left)], 'peer')
    const data = buildTlcMonitorData({scannedAt: now, nodes: [], channels: [inbound, peer]}, {}, now, windowMs)
    const ours = data.tlcRows.find(r => r.channel === inbound)!.assessment
    assert.equal(ours.severity, 'info')
    assert.equal(ours.resolved, false)
    assert.ok(ours.reasons.includes(left <= 0 ? 'inboundExpired' : 'inboundExpiring'))
    assert.equal(data.tlcRows.find(r => r.channel === peer)!.assessment.severity, outbound)
    assert.equal(data.counts.tlcOpen, 2)
    assert.equal(data.counts.attention, 1)
  }
  const ordinary = nodeChannel('ChannelReady', [pending({Inbound: 'Committed'}, windowMs + WARNING_LEAD_MS)])
  assert.equal(assessTlc(ordinary, ordinary.tlcs[0], null, now, windowMs).severity, 'ok')
})

test('independent risks, unknown directions, and confirmed removals keep their meaning', () => {
  for (const [state, status, forwarded, level, reason] of [
    ['ChannelReady', {Inbound: 'Committed'}, true, 'warning', 'inboundExpired'],
    ['Stale', {Inbound: 'Committed'}, false, 'warning', 'staleChannel'],
    ['ChannelReady', 'Committed', false, 'danger', 'unknownDirection'],
    ['ChannelReady', {Inbound: 'RemoveAckConfirmed'}, true, 'ok', 'removedOffchain'],
  ] as const) {
    const ch = nodeChannel(state, [pending(status, -1, forwarded)])
    const result = assessTlc(ch, ch.tlcs[0], null, now, windowMs)
    assert.equal(result.severity, level)
    assert.ok(result.reasons.includes(reason))
    assert.equal(result.resolved, reason === 'removedOffchain')
  }
  const confirming = nodeChannel({state_name:'ShuttingDown', state_flags:'WAITING_COMMITMENT_CONFIRMATION'}, [pending({Inbound:'Committed'}, -1)])
  assert.equal(assessTlc(confirming, confirming.tlcs[0], null, now, windowMs).severity, 'info')
  const report = reportAfterClaim('0xFF')
  report.steps = []
  assert.equal(assessTlc(confirming, confirming.tlcs[0], { ...report, status:'fundingLive', commitmentTxStatus:'rejected' }, now, windowMs).severity, 'danger')
  const ch = nodeChannel(closed('UNCOOPERATIVE_REMOTE'), [pending({Inbound:'Committed'}, -windowMs - 1)])
  assert.deepEqual(assessTlc(ch, ch.tlcs[0], report, now, windowMs).reasons, ['inboundExpiredOnchain'])
  assert.equal(assessTlc(ch, ch.tlcs[0], report, now, windowMs).severity, 'info')
})

function forwardingPair() {
  const hash = `0x${'ab'.repeat(32)}`
  const inbound = nodeChannel('ChannelReady', [{
    ...pending({Inbound: 'Committed'}, -windowMs), id: '0x01', amount: '0x4950c', payment_hash: hash,
    forwarding_channel_id: 'DOWN', forwarding_tlc_id: '0',
  }])
  const outbound = nodeChannel({state_name: 'Closed', state_flags: 'UNCOOPERATIVE_REMOTE'}, [{
    ...pending({Outbound: 'Committed'}, -windowMs - 1379), amount: '0x493e0', payment_hash: hash,
    forwarding_channel_id: 'channel', forwarding_tlc_id: '1',
  }], 'observer', 'down', closeHash)
  const htlc = {index: 0, offered: true, paymentHash: hash.slice(0, 42), amount: '300000',
    expiryMs: Math.floor(outbound.tlcs[0].expiryMs! / 1000) * 1000}
  const report: CommitmentSettlementReport = {...reportAfterClaim('0xFF'), status: 'settled', liveCell: null, remaining: null}
  report.steps[0] = {...report.steps[0], txHash: 'outbound-receipt', htlcs: [htlc], unlocks: [{kind: 'htlcTimeout', htlc, amount: htlc.amount}]}
  const channels = [inbound, outbound]
  const read = (chainCheck?: OnchainCheck) => buildTlcMonitorData({scannedAt: now, nodes: [], channels},
    chainCheck ? {[checkKeyOf(outbound)!]: chainCheck} : {}, now, windowMs)
  const assessment = (chainCheck?: OnchainCheck) => read(chainCheck).tlcRows.find(r => r.channel === inbound)!.assessment
  return { inbound, outbound, channels, htlc, report, read, assessment }
}

test('forwarded inbound: verify the outgoing leg, track even a final channel, and keep the incoming TLC open', () => {
  const { outbound, channels, htlc, report, read, assessment } = forwardingPair()
  assert.deepEqual(autoOnchainChannels(channels), [outbound])
  assert.deepEqual(autoOnchainChannels([outbound]), [])
  assert.equal(assessment().forwarding?.outcome, 'awaitingTrace')
  for (const [kind, outcome, level] of [['htlcTimeout', 'refunded', 'info'], ['htlcPreimage', 'paid', 'warning']] as const) {
    report.steps[0].unlocks = [{kind, htlc, amount: htlc.amount}]
    const a = assessment(check(report))
    assert.deepEqual(a.forwarding, {outcome, txHash: 'outbound-receipt', amount: '0x493e0', isUdt: false})
    assert.deepEqual([a.severity, a.resolved, a.settledTxHash], [level, false, null])
    assert.deepEqual([read(check(report)).counts.tlcOpen, read(check(report)).counts.attention], [1, level === 'warning' ? 1 : 0])
  }
  outbound.initiator = 'local'
  htlc.offered = false
  htlc.paymentHash = outbound.tlcs[0].paymentHash
  assert.equal(assessment(check(report)).forwarding?.outcome, 'paid')
})

test('do not borrow another node, channel, direction, hash or a conflicting backlink', () => {
  for (const change of [
    (p: ReturnType<typeof forwardingPair>) => { p.outbound.nodeId = 'other-node' },
    (p: ReturnType<typeof forwardingPair>) => { p.outbound.chainHash = 'other-chain' },
    (p: ReturnType<typeof forwardingPair>) => { p.outbound.channelId = 'other-channel' },
    (p: ReturnType<typeof forwardingPair>) => { p.outbound.tlcs[0].direction = 'inbound' },
    (p: ReturnType<typeof forwardingPair>) => { p.outbound.tlcs[0].id = '0x2' },
    (p: ReturnType<typeof forwardingPair>) => { p.outbound.tlcs[0].paymentHash += '00' },
    (p: ReturnType<typeof forwardingPair>) => { p.outbound.tlcs[0].forwardingTlcId = '0x3' },
    (p: ReturnType<typeof forwardingPair>) => { p.outbound.tlcs = [] },
  ]) {
    const p = forwardingPair()
    change(p)
    assert.equal(p.assessment(check(p.report)).forwarding?.outcome, 'unmatched')
  }
  const p = forwardingPair()
  p.outbound.tlcs[0].forwardingChannelId = null
  p.outbound.tlcs[0].forwardingTlcId = null
  p.inbound.tlcs.push({...p.inbound.tlcs[0], id: '0x2', key: 'second-inbound'})
  const inboundRows = p.read(check(p.report)).tlcRows.filter(r => r.channel === p.inbound)
  assert.deepEqual(inboundRows.map(r => r.assessment.forwarding?.outcome), ['unmatched', 'unmatched'])
})

test('pending, removal, a final channel flag, ambiguous witnesses and failed lookups are not payment receipts', () => {
  const {outbound, htlc, report, assessment} = forwardingPair()
  outbound.phase = 'offchain'
  assert.equal(assessment().forwarding?.outcome, 'pending')
  for (const progress of ['removing', 'removed'] as const) {
    outbound.tlcs[0].progress = progress
    assert.equal(assessment().forwarding?.outcome, 'removed')
  }
  assert.equal(assessment({...check(report), status:'error', error:'unreachable'}).forwarding?.outcome, 'checkFailed')
  assert.equal(assessment(check({...report, steps:[]})).forwarding?.outcome, 'unproven')
  const step = report.steps[0]
  for (const htlcs of [[htlc, {...htlc, index:1}], [{...htlc, amount:'300300'}], [{...htlc, offered:false}], [{...htlc, expiryMs:htlc.expiryMs+1000}]]) {
    assert.equal(assessment(check({...report, steps:[{...step, htlcs}]})).forwarding?.outcome, 'unproven')
  }
  assert.equal(assessment(check({...report, status:'settling', steps:[{...step, unlocks:[]}],
    remaining:{htlcs:[htlc], localAmount:'0', remoteAmount:'0'}})).forwarding?.outcome, 'locked')
  outbound.tlcs.push({...outbound.tlcs[0], id:'0x7'})
  assert.equal(assessment(check(report)).forwarding?.outcome, 'unproven')
})

test('an expired outbound RemoteRemoved is handled even while its force-closed channel is settling', () => {
  const tlc = { ...pending({Outbound: 'RemoteRemoved'}, -89 * 86_400_000, true),
    id: '0x1', amount: '0x5f5e100', forwarding_tlc_id: '0x1' }
  const state = closed('UNCOOPERATIVE_LOCAL')
  const ch = nodeChannel(state, [tlc])
  const scan = { scannedAt: now, nodes: [], channels: [ch] }
  const noWitness = { ...reportAfterClaim('0xFE'), commitmentTimestamp: now, steps: [], remaining: null }
  for (const checks of [{}, { [checkKeyOf(ch)!]: check(noWitness) }]) {
    const { tlcRows, counts, forceCloseRows } = buildTlcMonitorData(scan, checks, now, windowMs)
    assert.equal(tlcRows.length, 1)
    const { assessment } = tlcRows[0]
    assert.deepEqual(assessment.reasons, ['removalHandled'])
    assert.equal(assessment.severity, 'info')
    assert.equal(assessment.resolved, true)
    assert.equal(assessment.settledTxHash, null)
    assert.equal(assessment.phase, 'onchainSettling')
    assert.deepEqual([counts.tlcOpen, counts.tlcOnchain, counts.danger, counts.attention], [0, 0, 0, 0])
    assert.equal(counts.forceCloseOpen, 1)
    assert.ok(!forceCloseRows[0].assessment.notes.includes('tlcDanger'))
  }
  const active = nodeChannel(state, [{...tlc, status: {Outbound: 'Committed'}}])
  const data = buildTlcMonitorData({...scan, channels: [active]}, {}, now, windowMs)
  assert.deepEqual(data.tlcRows[0].assessment.reasons, ['expiredOnchain', 'outboundFunds'])
  assert.deepEqual([data.counts.tlcOpen, data.counts.attention], [1, 1])
})

test('remove updates, final acknowledgements and announcement acknowledgements are distinct', () => {
  for (const status of [{Outbound: 'RemoveWaitPrevAck'}, {Outbound: 'RemoveWaitAck'}, {Inbound: 'LocalRemoved'}]) {
    const ch = nodeChannel('ChannelReady', [pending(status, -1)])
    const a = assessTlc(ch, ch.tlcs[0], null, now, windowMs)
    assert.deepEqual([a.severity, a.reasons, a.resolved], ['info', ['removalHandled'], true])
  }
  for (const [status, reason, resolved] of [
    [{Outbound: 'RemoveAckConfirmed'}, 'removedOffchain', true],
    [{Inbound: 'AnnounceWaitAck'}, 'inboundExpired', false],
    [{Outbound: 'UnknownRemoveState'}, 'expired', false],
  ] as const) {
    const ch = nodeChannel('ChannelReady', [pending(status, -1)])
    const a = assessTlc(ch, ch.tlcs[0], null, now, windowMs)
    assert.equal(a.reasons[0], reason)
    assert.equal(a.resolved, resolved)
  }
})

test('a removal update does not mask a stale channel or a missing commitment', () => {
  const removed = pending({Outbound: 'RemoteRemoved'}, -windowMs)
  const stale = nodeChannel('Stale', [removed])
  const a = assessTlc(stale, stale.tlcs[0], null, now, windowMs)
  assert.deepEqual([a.severity, a.reasons], ['warning', ['removalHandled', 'staleChannel']])
  const closing = nodeChannel({state_name: 'ShuttingDown', state_flags: 'WAITING_COMMITMENT_CONFIRMATION'}, [removed])
  const rejected: CommitmentSettlementReport = {...reportAfterClaim('0xFE'), status: 'fundingLive',
    commitmentTxStatus: 'rejected', steps: [], remaining: null, liveCell: null}
  const b = assessTlc(closing, closing.tlcs[0], rejected, now, windowMs)
  assert.deepEqual([b.severity, b.reasons], ['danger', ['commitmentMissing']])
})

test('a matching live HTLC or unlock is stronger evidence than an off-chain removal', () => {
  const ch = nodeChannel(closed('UNCOOPERATIVE_LOCAL'), [pending({Outbound: 'RemoteRemoved'}, -windowMs - 1)])
  const tlc = ch.tlcs[0]
  const htlc = { index: 0, offered: false, paymentHash: tlc.paymentHash, amount: '99', expiryMs: tlc.expiryMs! }
  const report = reportAfterClaim('0xFE')
  report.steps[0].htlcs = [htlc]
  report.remaining!.htlcs = [htlc]
  const locked = assessTlc(ch, tlc, report, now, windowMs)
  assert.deepEqual([locked.resolved, locked.severity, locked.reasons], [false, 'danger', ['expiredOnchain', 'outboundFunds']])
  const sibling = {...htlc, index: 1}
  const partial = {...report.steps[0], htlcs: [htlc, sibling], unlocks: [{kind: 'htlcTimeout' as const, htlc, amount: htlc.amount}]}
  const stillLocked = assessTlc(ch, tlc, {...report, steps: [partial], remaining: {...report.remaining!, htlcs: [sibling]}}, now, windowMs)
  assert.deepEqual([stillLocked.resolved, stillLocked.settledTxHash], [false, null])
  for (const [kind, reason] of [['htlcTimeout', 'settledTimeout'], ['htlcPreimage', 'settledPreimage']] as const) {
    const claim = {...report.steps[0], txHash: 'claim-tx', unlocks: [{kind, htlc, amount: htlc.amount}]}
    const paid = {...report, steps: [...report.steps, claim], remaining: {...report.remaining!, htlcs: []}}
    for (const status of ['RemoteRemoved', 'RemoveAckConfirmed']) {
      const ch = nodeChannel(closed('UNCOOPERATIVE_LOCAL'), [pending({Outbound: status}, -windowMs - 1)])
      const a = assessTlc(ch, ch.tlcs[0], paid, now, windowMs)
      assert.deepEqual([a.resolved, a.reasons, a.settledTxHash], [true, [reason], 'claim-tx'])
    }
  }
})

test('one shared settlement, two node perspectives; only the unclaimed owner is counted', () => {
  const observer = nodeChannel(closed('UNCOOPERATIVE_REMOTE'))
  const broadcaster = nodeChannel(closed('UNCOOPERATIVE_LOCAL'), [], 'peer')
  for (const [slot, owner, paid, outstanding] of [
    ['0xFF', broadcaster, observer, '1700000000'], ['0xFE', observer, broadcaster, '2300000000'],
  ] as const) {
    const data = buildTlcMonitorData({scannedAt: now, nodes: [], channels:[observer, broadcaster]},
      { [checkKeyOf(observer)!]: check(reportAfterClaim(slot)) }, now, windowMs)
    const owing = data.forceCloseRows.find(row => row.channel === owner)!.assessment
    const received = data.forceCloseRows.find(row => row.channel === paid)!.assessment
    assert.deepEqual([owing.result, owing.ourAmount, owing.theirAmount, owing.theirBalanceClaimed], ['ownBalanceUnclaimed', outstanding, '0', true])
    assert.deepEqual([received.result, received.ourAmount, received.theirAmount, received.ourBalanceClaimed], ['peerBalanceUnclaimed', '0', outstanding, true])
    assert.equal(received.severity, 'info')
    assert.equal(data.counts.unclaimedChannels, 1)
    assert.equal(data.counts.unclaimedShannons, BigInt(outstanding))
    assert.equal(data.counts.attention, 1)
  }
})

test('zero is not a claim receipt; missing ownership, delay or witness does not identify an overdue owner', () => {
  const ch = nodeChannel(closed('UNCOOPERATIVE_REMOTE'))
  const report = reportAfterClaim('0xFF')
  const beforeGrace = assessForceClose(ch, check(report), [], report.commitmentTimestamp! + CLAIM_GRACE_MS)
  assert.equal(beforeGrace.result, 'awaitingSettlement')
  report.steps[0].unlocks = []
  assert.equal(assessForceClose(ch, check(report), [], now).ourBalanceClaimed, false)
  for (const flag of ['UNCOOPERATIVE', 'UNCOOPERATIVE_LOCAL|UNCOOPERATIVE_REMOTE']) {
    const unknown = assessForceClose(nodeChannel(closed(flag)), check(report), [], now)
    assert.deepEqual([unknown.ourAmount, unknown.theirAmount, unknown.result], [null, null, 'awaitingSettlement'])
  }
  assert.equal(assessForceClose(ch, check({...report, remaining: null}), [], now).ourAmount, null)
  assert.equal(assessForceClose(ch, check({...report, delayMs: null}), [], now).result, 'awaitingSettlement')
})
