import { useMemo } from 'react'
import { formatChannelAmount, type TraceItem } from '../lib/ckb'
import { copyToClipboard } from '../lib/clipboard'
import { shorten } from '../lib/format'
import { useT } from '../lib/i18n'
import type { FundingOutPoint } from '../lib/tlcMonitor'
import { buildTraceEvidence, matchChannelToTrace, type ChannelMatchKind } from '../lib/traceAssociation'

export type RelatedChannel = {
  nodeId: string
  nodeName: string
  record: Record<string, unknown>
  outpoint: FundingOutPoint | null
  knownHashes: (string | null)[]
  matchKind: ChannelMatchKind
  fundingAddress: string | null
}

const balanceFields = new Set(['local_balance', 'remote_balance', 'offered_tlc_balance', 'received_tlc_balance'])
const traceFields = ['channel_id', 'channel_outpoint', 'latest_commitment_transaction_hash', 'shutdown_transaction_hash']
const copyFields = new Set([...traceFields, 'pubkey', 'peer_id'])
const firstFields = [...traceFields, ...balanceFields, 'state', 'pending_tlcs']

function CopyValue({ value, label }: { value: string; label: string }) {
  const t = useT()
  return (
    <button type="button" className="ctFieldCopy" title={t.copy} aria-label={`${t.copy}: ${label}`}
      onClick={() => copyToClipboard(value)}>
      {value}
    </button>
  )
}

function ChannelField({ name, channel }: { name: string; channel: RelatedChannel }) {
  const { record, outpoint } = channel
  const value = record[name]
  const rawValue = typeof value === 'string' ? value || '""' : JSON.stringify(value, null, 2)
  const fundingOutpoint = name === 'channel_outpoint' && outpoint ? `${outpoint.txHash}:${outpoint.index}` : null
  const showAmount = balanceFields.has(name) && typeof value === 'string' && /^(?:0x[0-9a-f]+|\d+)$/i.test(value)
    && Object.hasOwn(record, 'funding_udt_type_script')
  return (
    <div className={name === 'pending_tlcs' ? 'ctChannelTlcs' : undefined}>
      <dt>{name}</dt>
      <dd>
        {showAmount && <strong>{formatChannelAmount(value, record.funding_udt_type_script != null)}</strong>}
        {fundingOutpoint && fundingOutpoint !== value && <CopyValue value={fundingOutpoint} label="Funding Outpoint" />}
        {copyFields.has(name) && typeof value === 'string' && value !== ''
          ? <CopyValue value={value} label={name} />
          : <pre>{rawValue}</pre>}
      </dd>
    </div>
  )
}

export default function RelatedChannelRecords({ channels, traceItems }: { channels: RelatedChannel[]; traceItems: TraceItem[] }) {
  const t = useT()
  const steps = useMemo(() => traceItems.map((item, index) => ({
    number: index + 1,
    hash: item.tx_hash.toLowerCase(),
    evidence: buildTraceEvidence(item.tx_hash, [item]),
  })), [traceItems])
  const reasons = {
    funding: t.relatedFundingMatch,
    commitment: t.relatedCommitmentMatch,
    traceFundingInput: t.relatedTraceFundingInput,
    traceCommitmentInput: t.relatedTraceCommitmentInput,
  }
  return (
    <div className="ctChannelRecords">
      {channels.map((channel, index) => {
        const { record, outpoint, knownHashes, fundingAddress } = channel
        const id = typeof record.channel_id === 'string' ? record.channel_id : null
        const fields = new Set([...firstFields.filter((name) => Object.hasOwn(record, name)), ...Object.keys(record)])
        const matches = steps.filter((step) => matchChannelToTrace(outpoint, knownHashes, step.evidence))
        return (
          <details open className="ctTraceItem ctChannelRecord" key={`${channel.nodeId}:${id ?? index}`}>
            <summary>
              <strong>{channel.nodeName}</strong>{' '}
              {id && <span className="monoSmall" title={id}>{shorten(id, 12, 8)}</span>}{' '}
              <span className="pill">{t.relatedMatch}: {reasons[channel.matchKind]}</span>
            </summary>
            <div className="smallNote">{t.relatedFundingAddress}: {fundingAddress
              ? <CopyValue value={fundingAddress} label={t.relatedFundingAddress} />
              : '—'}</div>
            <div className="ctChannelTools">
              <span className="muted">{t.relatedRecordFields(fields.size)}</span>
              {matches.length > 0 && <span className="ctTraceLinks">
                {t.compareTraceSteps}
                {matches.map((step) => <a key={step.hash} href={`#ct-tx-${step.hash}`} title={step.hash}>#{step.number}</a>)}
              </span>}
              <button type="button" className="btn btnGhost" onClick={() => copyToClipboard(JSON.stringify(record, null, 2))}>
                {t.copyChannelJson}
              </button>
            </div>
            <dl className="ctChannelFields">
              {Array.from(fields, (name) => <ChannelField key={name} name={name} channel={channel} />)}
            </dl>
          </details>
        )
      })}
      <div className="smallNote">{t.relatedAddressCaveat}</div>
    </div>
  )
}
