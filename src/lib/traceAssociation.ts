import type { TraceItem } from './ckb'
import type { FundingOutPoint } from './tlcMonitor'

type LockScript = { code_hash: string; hash_type: string; args: string }

export type ChannelMatchKind = 'funding' | 'commitment' | 'traceFundingInput' | 'traceCommitmentInput'
export type AddressPresence = 'input' | 'output' | 'both'

export type TraceEvidence = {
  transactionHashes: Set<string>
  spentOutpoints: Set<string>
  spentTransactionHashes: Set<string>
  inputLocks: Set<string>
  outputLocks: Set<string>
}

function outpointKey(outpoint: FundingOutPoint): string {
  return `${outpoint.txHash.toLowerCase()}:${outpoint.index}`
}

function lockKey(lock: LockScript): string {
  return `${lock.code_hash.toLowerCase()}|${lock.hash_type.toLowerCase()}|${lock.args.toLowerCase()}`
}

export function buildTraceEvidence(queryHash: string, trace: TraceItem[]): TraceEvidence {
  const evidence: TraceEvidence = {
    transactionHashes: new Set([queryHash.toLowerCase()]),
    spentOutpoints: new Set(),
    spentTransactionHashes: new Set(),
    inputLocks: new Set(),
    outputLocks: new Set(),
  }
  for (const item of trace) {
    evidence.transactionHashes.add(item.tx_hash.toLowerCase())
    for (const cell of item.msg.input_cells) {
      if (cell.outpoint) {
        evidence.spentOutpoints.add(outpointKey(cell.outpoint))
        evidence.spentTransactionHashes.add(cell.outpoint.txHash.toLowerCase())
      }
      if (cell.lock) evidence.inputLocks.add(lockKey(cell.lock))
    }
    for (const cell of item.msg.output_cells) {
      if (cell.lock) evidence.outputLocks.add(lockKey(cell.lock))
    }
  }
  return evidence
}

export function matchChannelToTrace(
  outpoint: FundingOutPoint | null,
  knownCommitmentHashes: Array<string | null>,
  evidence: TraceEvidence,
): ChannelMatchKind | null {
  if (outpoint && evidence.spentOutpoints.has(outpointKey(outpoint))) return 'traceFundingInput'
  if (outpoint && evidence.transactionHashes.has(outpoint.txHash.toLowerCase())
    && !evidence.spentTransactionHashes.has(outpoint.txHash.toLowerCase())) return 'funding'
  if (knownCommitmentHashes.some((hash) => hash && evidence.transactionHashes.has(hash.toLowerCase()))) return 'commitment'
  if (knownCommitmentHashes.some((hash) => hash && evidence.spentTransactionHashes.has(hash.toLowerCase()))) return 'traceCommitmentInput'
  return null
}

export function addressPresenceInTrace(lock: LockScript, evidence: TraceEvidence): AddressPresence | null {
  const key = lockKey(lock)
  const input = evidence.inputLocks.has(key)
  const output = evidence.outputLocks.has(key)
  return input && output ? 'both' : input ? 'input' : output ? 'output' : null
}
