export type CkbNetwork = 'testnet' | 'mainnet' | 'custom'

export const SHANNON_PER_CKB = 100_000_000
const MIN_LOCK_ARGS_HEX_LEN = 72

export const CKB_CHAIN_HASHES: Record<string, 'testnet' | 'mainnet'> = {
  '0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606': 'testnet',
  '0x92b197aa1fba0f63633922c61c92375c9c074a93e85963554f5499fe1450d0e5': 'mainnet',
}

export function detectNetworkByChainHash(chainHash: string): CkbNetwork {
  return CKB_CHAIN_HASHES[chainHash.toLowerCase()] ?? 'custom'
}

export function getCkbRpcUrlForChainHash(chainHash: string, customRpcUrl?: string): string {
  const network = detectNetworkByChainHash(chainHash)
  if (network === 'custom') return customRpcUrl || ''
  return NETWORK_CONFIG[network].rpcUrl
}

export type CkbNetworkConfig = { rpcUrl: string; commitmentCodeHash: string }

const NETWORK_CONFIG: Record<'testnet' | 'mainnet', CkbNetworkConfig> = {
  testnet: {
    rpcUrl: 'https://testnet.ckb.dev/',
    commitmentCodeHash: '0x740dee83f87c6f309824d8fd3fbdd3c8380ee6fc9acc90b1a748438afcdf81d8',
  },
  mainnet: {
    rpcUrl: 'https://mainnet.ckb.dev/',
    commitmentCodeHash: '0x2d45c4d3ed3e942f1945386ee82a5d1b7e4bb16d7fe1ab015421174ab747406c',
  },
}

export function getNetworkConfig(network: 'testnet' | 'mainnet') {
  return NETWORK_CONFIG[network]
}

export function resolveNetworkConfig(
  network: CkbNetwork,
  customRpcUrl?: string,
  customCodeHash?: string,
): CkbNetworkConfig {
  if (network === 'custom') {
    return {
      rpcUrl: customRpcUrl || '',
      commitmentCodeHash: customCodeHash || '',
    }
  }
  return NETWORK_CONFIG[network]
}

async function callCkbRpc<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch('/api/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: rpcUrl, method, params }),
  })
  const text = await res.text()
  let json: unknown
  try {
    json = JSON.parse(text) as unknown
  } catch {
    throw new Error(`CKB RPC response is not JSON (HTTP ${res.status})`)
  }
  const envelope = json as Record<string, unknown>
  if (envelope.error) {
    const err = envelope.error as Record<string, unknown>
    throw new Error((err.message as string) ?? 'CKB RPC error')
  }
  return envelope.result as T
}

type CkbTransaction = {
  transaction: {
    inputs: { previous_output: { tx_hash: string; index: string } }[]
    outputs: { capacity: string; lock: { code_hash: string; hash_type: string; args: string }; type?: { code_hash: string; hash_type: string; args: string } | null }[]
    outputs_data: string[]
    witnesses: string[]
  }
  tx_status: { block_hash?: string; status: string }
}

type CkbBlockHeader = {
  number: string
  timestamp: string
}

async function getTransaction(rpcUrl: string, txHash: string): Promise<CkbTransaction | null> {
  return callCkbRpc<CkbTransaction | null>(rpcUrl, 'get_transaction', [txHash])
}

async function getBlockHeader(rpcUrl: string, blockHash: string): Promise<CkbBlockHeader | null> {
  return callCkbRpc<CkbBlockHeader | null>(rpcUrl, 'get_header', [blockHash])
}

type CkbIndexerResult = {
  objects: { tx_hash: string }[]
}

async function getTransactions(
  rpcUrl: string,
  searchKey: Record<string, unknown>,
  order = 'asc',
  limit = '0xff',
  after: string | null = null,
): Promise<CkbIndexerResult> {
  return callCkbRpc<CkbIndexerResult>(rpcUrl, 'get_transactions', [searchKey, order, limit, after])
}

function littleEndianHexToBigInt(hex: string): bigint {
  if (hex.length % 2 !== 0) hex = '0' + hex
  const bytes: string[] = []
  for (let i = 0; i < hex.length; i += 2) bytes.push(hex.substring(i, i + 2))
  return BigInt('0x' + bytes.reverse().join(''))
}

function toIntFromBigUint128Le(hexStr: string): bigint {
  if (hexStr.startsWith('0x')) hexStr = hexStr.slice(2)
  const bytes: string[] = []
  for (let i = 0; i < hexStr.length; i += 2) bytes.push(hexStr.substring(i, i + 2))
  return BigInt('0x' + bytes.reverse().join(''))
}

export type ParsedEpoch = { number: string; index: string; length: string; value: string }

function parseEpoch(epoch: bigint): ParsedEpoch {
  const number = (epoch >> 0n) & ((1n << 24n) - 1n)
  const index = (epoch >> 24n) & ((1n << 16n) - 1n)
  const length = (epoch >> 40n) & ((1n << 16n) - 1n)
  return { number: number.toString(), index: index.toString(), length: length.toString(), value: epoch.toString() }
}

export type ParsedLockArgs = {
  pubkey_hash: string
  delay_epoch: ParsedEpoch
  version: string
  htlcs?: string
  settlement_hash?: string
  settlement_flag?: number
}

export function parseLockArgs(hex: string): ParsedLockArgs {
  const data = hex.startsWith('0x') ? hex.substring(2) : hex
  let offset = 0
  const pubkeyHash = data.substring(offset, offset + 40); offset += 40
  const delayEpochHex = data.substring(offset, offset + 16)
  const delayEpoch = littleEndianHexToBigInt(delayEpochHex); offset += 16
  const versionHex = data.substring(offset, offset + 16)
  const version = littleEndianHexToBigInt(versionHex); offset += 16
  const htlcs = data.substring(offset)
  return {
    pubkey_hash: `0x${pubkeyHash}`,
    delay_epoch: parseEpoch(delayEpoch),
    version: version.toString(),
    htlcs: htlcs ? `0x${htlcs}` : '',
  }
}

export function parseLockArgsV2(hex: string): ParsedLockArgs {
  const data = hex.startsWith('0x') ? hex.substring(2) : hex
  let offset = 0
  const pubkeyHash = data.substring(offset, offset + 40); offset += 40
  const delayEpochHex = data.substring(offset, offset + 16)
  const delayEpoch = littleEndianHexToBigInt(delayEpochHex); offset += 16
  const versionHex = data.substring(offset, offset + 16)
  const version = BigInt('0x' + versionHex); offset += 16
  const settlementHash = data.substring(offset, offset + 40); offset += 40
  const settlementFlagHex = data.substring(offset, offset + 2)
  const settlementFlag = settlementFlagHex ? parseInt(settlementFlagHex, 16) : undefined
  const result: ParsedLockArgs = {
    pubkey_hash: `0x${pubkeyHash}`,
    delay_epoch: parseEpoch(delayEpoch),
    version: version.toString(),
    settlement_hash: settlementHash ? `0x${settlementHash}` : '',
  }
  if (settlementFlag !== undefined && !isNaN(settlementFlag)) result.settlement_flag = settlementFlag
  return result
}

export type ParsedHtlc = {
  htlc_type: number
  payment_amount: string
  payment_hash: string
  remote_htlc_pubkey_hash: string
  local_htlc_pubkey_hash: string
  htlc_expiry: string
  htlc_expiry_timestamp: string
}

export type ParsedWitness = {
  empty_witness_args: string
  unlock_type?: number
  unlock_count?: number
  revocation?: { version: string; pubkey: string; signature: string }
  non_pending_htlc?: { pubkey: string; signature: string }
  pending_htlc?: { pending_htlc_count: number; htlcs: ParsedHtlc[]; signature: string; preimage: string }
  settlement?: {
    pending_htlc_count: number
    htlcs: ParsedHtlc[]
    settlement_remote_pubkey_hash: string
    settlement_remote_amount: string
    settlement_local_pubkey_hash: string
    settlement_local_amount: string
    unlocks: { unlock_type: number; with_preimage: number; signature: string; preimage: string }[]
  }
  error?: string
}

export function parseWitness(hex: string): ParsedWitness {
  const data = hex.startsWith('0x') ? hex.substring(2) : hex
  let offset = 0
  const emptyWitnessArgs = data.substring(offset, offset + 32); offset += 32
  const unlockType = parseInt(data.substring(offset, offset + 2), 16); offset += 2
  const witnessData: ParsedWitness = { empty_witness_args: `0x${emptyWitnessArgs}`, unlock_type: unlockType }

  if (unlockType === 0xFF) {
    witnessData.revocation = {
      version: BigInt('0x' + data.substring(offset, offset + 16)).toString(),
      pubkey: `0x${data.substring(offset + 16, offset + 16 + 64)}`,
      signature: `0x${data.substring(offset + 16 + 64)}`,
    }
  } else if (unlockType === 0xFE) {
    witnessData.non_pending_htlc = {
      pubkey: `0x${data.substring(offset, offset + 64)}`,
      signature: `0x${data.substring(offset + 64)}`,
    }
  } else {
    const pendingHtlcCount = parseInt(data.substring(offset, offset + 2), 16); offset += 2
    const htlcs: ParsedHtlc[] = []
    for (let i = 0; i < pendingHtlcCount; i++) {
      const htlc_type = parseInt(data.substring(offset, offset + 2), 16); offset += 2
      const paymentAmountHex = data.substring(offset, offset + 32)
      const payment_amount = littleEndianHexToBigInt(paymentAmountHex); offset += 32
      const payment_hash = `0x${data.substring(offset, offset + 40)}`; offset += 40
      const remote_htlc_pubkey_hash = `0x${data.substring(offset, offset + 40)}`; offset += 40
      const local_htlc_pubkey_hash = `0x${data.substring(offset, offset + 40)}`; offset += 40
      const htlcExpiryHex = data.substring(offset, offset + 16)
      let htlc_expiry_ts = littleEndianHexToBigInt(htlcExpiryHex)
      htlc_expiry_ts = (htlc_expiry_ts & ((1n << 56n) - 1n)) * 1000n; offset += 16
      htlcs.push({
        htlc_type,
        payment_amount: payment_amount.toString(),
        payment_hash,
        remote_htlc_pubkey_hash,
        local_htlc_pubkey_hash,
        htlc_expiry: new Date(Number(htlc_expiry_ts)).toLocaleString('zh-CN'),
        htlc_expiry_timestamp: htlc_expiry_ts.toString(),
      })
    }
    const signature = `0x${data.substring(offset, offset + 130)}`; offset += 130
    const preimage = data.length > offset ? `0x${data.substring(offset, offset + 64)}` : 'N/A'
    witnessData.pending_htlc = { pending_htlc_count: pendingHtlcCount, htlcs, signature, preimage }
  }
  return witnessData
}

export function parseWitnessV2(hex: string): ParsedWitness {
  const data = hex.startsWith('0x') ? hex.substring(2) : hex
  let offset = 0
  const emptyWitnessArgs = data.substring(offset, offset + 32); offset += 32
  const unlockCount = parseInt(data.substring(offset, offset + 2), 16); offset += 2
  const witnessData: ParsedWitness = { empty_witness_args: `0x${emptyWitnessArgs}`, unlock_count: unlockCount }

  if (unlockCount === 0x00) {
    witnessData.revocation = {
      version: BigInt('0x' + data.substring(offset, offset + 16)).toString(),
      pubkey: `0x${data.substring(offset + 16, offset + 16 + 64)}`,
      signature: `0x${data.substring(offset + 16 + 64)}`,
    }
  } else {
    const pendingHtlcCount = parseInt(data.substring(offset, offset + 2), 16); offset += 2
    const htlcs: ParsedHtlc[] = []
    for (let i = 0; i < pendingHtlcCount; i++) {
      const htlc_type = parseInt(data.substring(offset, offset + 2), 16); offset += 2
      const paymentAmountHex = data.substring(offset, offset + 32)
      const payment_amount = littleEndianHexToBigInt(paymentAmountHex); offset += 32
      const payment_hash = `0x${data.substring(offset, offset + 40)}`; offset += 40
      const remote_htlc_pubkey_hash = `0x${data.substring(offset, offset + 40)}`; offset += 40
      const local_htlc_pubkey_hash = `0x${data.substring(offset, offset + 40)}`; offset += 40
      const htlcExpiryHex = data.substring(offset, offset + 16)
      let htlc_expiry_ts = littleEndianHexToBigInt(htlcExpiryHex)
      htlc_expiry_ts = (htlc_expiry_ts & ((1n << 56n) - 1n)) * 1000n; offset += 16
      htlcs.push({
        htlc_type,
        payment_amount: payment_amount.toString(),
        payment_hash,
        remote_htlc_pubkey_hash,
        local_htlc_pubkey_hash,
        htlc_expiry: new Date(Number(htlc_expiry_ts)).toLocaleString('zh-CN'),
        htlc_expiry_timestamp: htlc_expiry_ts.toString(),
      })
    }
    const settlement_remote_pubkey_hash = `0x${data.substring(offset, offset + 40)}`; offset += 40
    const settlement_remote_amount = littleEndianHexToBigInt(data.substring(offset, offset + 32)); offset += 32
    const settlement_local_pubkey_hash = `0x${data.substring(offset, offset + 40)}`; offset += 40
    const settlement_local_amount = littleEndianHexToBigInt(data.substring(offset, offset + 32)); offset += 32
    const unlocks: { unlock_type: number; with_preimage: number; signature: string; preimage: string }[] = []
    for (let i = 0; i < unlockCount; i++) {
      const unlock_type = parseInt(data.substring(offset, offset + 2), 16); offset += 2
      const with_preimage = parseInt(data.substring(offset, offset + 2), 16); offset += 2
      const signature = `0x${data.substring(offset, offset + 130)}`; offset += 130
      let preimage = 'N/A'
      if (with_preimage === 0x01) { preimage = `0x${data.substring(offset, offset + 64)}`; offset += 64 }
      unlocks.push({ unlock_type, with_preimage, signature, preimage })
    }
    witnessData.settlement = {
      pending_htlc_count: pendingHtlcCount,
      htlcs,
      settlement_remote_pubkey_hash,
      settlement_remote_amount: settlement_remote_amount.toString(),
      settlement_local_pubkey_hash,
      settlement_local_amount: settlement_local_amount.toString(),
      unlocks,
    }
  }
  return witnessData
}

type CellInfo = {
  args: string
  capacity: bigint
  lock?: { code_hash: string; hash_type: string; args: string }
  udt_args?: string
  udt_capacity?: bigint
}

type BalanceChange = { ckb: string; udt: string }

export type TxMessage = {
  input_cells: CellInfo[]
  output_cells: CellInfo[]
  fee: string
  udt_fee: string
  parsed_witness: ParsedWitness | null
  balance_changes: Record<string, BalanceChange>
  block_number: string
  block_timestamp: string
}

export type TraceItem = {
  tx_hash: string
  msg: TxMessage
}

async function getTxMessage(rpcUrl: string, commitmentCodeHash: string, txHash: string): Promise<TxMessage> {
  const txData = await getTransaction(rpcUrl, txHash)
  if (!txData) throw new Error(`Transaction not found: ${txHash}`)
  const tx = txData.transaction
  let parsedWitness: ParsedWitness | null = null

  const inputPromises = tx.inputs.map(async (input, index) => {
    const prevTxHash = input.previous_output.tx_hash
    const outputIndex = parseInt(input.previous_output.index, 16)
    const prevTxData = await getTransaction(rpcUrl, prevTxHash)
    if (!prevTxData) throw new Error(`Previous tx not found: ${prevTxHash}`)
    const prevOutput = prevTxData.transaction.outputs[outputIndex]
    const prevOutputData = prevTxData.transaction.outputs_data[outputIndex]
    const cell: CellInfo = { args: prevOutput.lock.args, capacity: BigInt(prevOutput.capacity), lock: prevOutput.lock }
    if (prevOutput.type) {
      cell.udt_args = prevOutput.type.args
      cell.udt_capacity = toIntFromBigUint128Le(prevOutputData)
    }
    if (prevOutput.lock.code_hash === commitmentCodeHash && !parsedWitness) {
      try {
        const witnessHex = tx.witnesses[index]
        const args = prevOutput.lock.args
        const argsData = args.startsWith('0x') ? args.slice(2) : args
        if (argsData.length >= MIN_LOCK_ARGS_HEX_LEN) {
          const versionHex = argsData.substring(56, 72)
          const v1 = littleEndianHexToBigInt(versionHex)
          if (v1 === 1n) {
            parsedWitness = parseWitness(witnessHex)
          } else {
            parsedWitness = parseWitnessV2(witnessHex)
          }
        }
      } catch (e) {
        parsedWitness = { empty_witness_args: '', error: e instanceof Error ? e.message : String(e) }
      }
    }
    return cell
  })

  const inputCells = await Promise.all(inputPromises)
  const outputCells: CellInfo[] = tx.outputs.map((output, i) => {
    const cell: CellInfo = { args: output.lock.args, capacity: BigInt(output.capacity) }
    if (output.type) {
      cell.udt_args = output.type.args
      cell.udt_capacity = toIntFromBigUint128Le(tx.outputs_data[i])
    }
    return cell
  })

  let inputCap = 0n, outputCap = 0n
  inputCells.forEach(c => (inputCap += c.capacity))
  outputCells.forEach(c => (outputCap += c.capacity))
  const fee = inputCap - outputCap
  let udtFee = 0n
  inputCells.forEach(c => { if (c.udt_capacity) udtFee += c.udt_capacity })
  outputCells.forEach(c => { if (c.udt_capacity) udtFee -= c.udt_capacity })

  const balanceMap: Record<string, { ckb: bigint; udt: bigint }> = {}
  const updateBal = (args: string, ckbDelta: bigint, udtDelta: bigint) => {
    if (!balanceMap[args]) balanceMap[args] = { ckb: 0n, udt: 0n }
    balanceMap[args].ckb += ckbDelta
    balanceMap[args].udt += udtDelta
  }
  inputCells.forEach(c => updateBal(c.args, -c.capacity, -(c.udt_capacity || 0n)))
  outputCells.forEach(c => updateBal(c.args, c.capacity, c.udt_capacity || 0n))

  const balance_changes: Record<string, BalanceChange> = {}
  for (const [args, bal] of Object.entries(balanceMap)) {
    if (bal.ckb !== 0n || bal.udt !== 0n) {
      balance_changes[args] = { ckb: bal.ckb.toString(), udt: bal.udt.toString() }
    }
  }

  let block_number = 'Pending'
  let block_timestamp = ''
  if (txData.tx_status?.block_hash) {
    try {
      const header = await getBlockHeader(rpcUrl, txData.tx_status.block_hash)
      if (header) {
        block_number = parseInt(header.number, 16).toString()
        block_timestamp = new Date(parseInt(header.timestamp, 16)).toLocaleString()
      }
    } catch { /* ignore */ }
  }

  return {
    input_cells: inputCells,
    output_cells: outputCells,
    fee: fee.toString(),
    udt_fee: udtFee.toString(),
    parsed_witness: parsedWitness,
    balance_changes,
    block_number,
    block_timestamp,
  }
}

async function getLnCellDeathHash(rpcUrl: string, txHash: string): Promise<{ txHash: string | null; codeHash: string | null }> {
  const txData = await getTransaction(rpcUrl, txHash)
  if (!txData) return { txHash: null, codeHash: null }
  const cellLock = txData.transaction.outputs[0].lock
  const txs = await getTransactions(rpcUrl, { script: cellLock, script_type: 'lock', script_search_mode: 'exact' })
  if (txs?.objects?.length === 2) {
    return { txHash: txs.objects[1].tx_hash, codeHash: cellLock.code_hash }
  }
  return { txHash: null, codeHash: null }
}

export async function getLnTxTrace(
  rpcUrl: string,
  commitmentCodeHash: string,
  openChannelTxHash: string,
  onStep?: (count: number) => void,
): Promise<TraceItem[]> {
  const txTrace: TraceItem[] = []
  const msg = await getTxMessage(rpcUrl, commitmentCodeHash, openChannelTxHash)
  txTrace.push({ tx_hash: openChannelTxHash, msg })
  onStep?.(txTrace.length)

  const { txHash: nextTx } = await getLnCellDeathHash(rpcUrl, openChannelTxHash)
  if (nextTx) {
    const nextMsg = await getTxMessage(rpcUrl, commitmentCodeHash, nextTx)
    txTrace.push({ tx_hash: nextTx, msg: nextMsg })
    onStep?.(txTrace.length)

    let currentTx: string | null = nextTx
    while (currentTx) {
      const result = await getLnCellDeathHash(rpcUrl, currentTx)
      if (!result.txHash) break
      const newMsg = await getTxMessage(rpcUrl, commitmentCodeHash, result.txHash)
      txTrace.push({ tx_hash: result.txHash, msg: newMsg })
      onStep?.(txTrace.length)
      if (result.codeHash !== commitmentCodeHash) break
      currentTx = result.txHash
    }
  }
  return txTrace
}

export async function fetchAndParseTx(
  rpcUrl: string,
  txHash: string,
): Promise<{ lockArgs: string; witness: string; version: string }> {
  const tx = await getTransaction(rpcUrl, txHash)
  if (!tx) throw new Error('Transaction not found.')
  const witness = tx.transaction.witnesses[0]
  const previousTxHash = tx.transaction.inputs[0].previous_output.tx_hash
  const prevTx = await getTransaction(rpcUrl, previousTxHash)
  if (!prevTx) throw new Error('Previous transaction not found.')
  const lockArgs = prevTx.transaction.outputs[0].lock.args
  const argsData = lockArgs.startsWith('0x') ? lockArgs.slice(2) : lockArgs
  let version = '2'
  if (argsData.length >= MIN_LOCK_ARGS_HEX_LEN) {
    const versionHex = argsData.substring(56, 72)
    const v1 = littleEndianHexToBigInt(versionHex)
    if (v1 === 1n) version = '1'
  }
  return { lockArgs, witness, version }
}

export type LiveCell = {
  capacity: string
  lock: { code_hash: string; hash_type: string; args: string }
  type: { code_hash: string; hash_type: string; args: string } | null
  data: string
  out_point: { tx_hash: string; index: string }
}

type GetCellsResult = {
  objects: {
    output: {
      capacity: string
      lock: { code_hash: string; hash_type: string; args: string }
      type?: { code_hash: string; hash_type: string; args: string } | null
    }
    output_data: string
    out_point: { tx_hash: string; index: string }
  }[]
  last_cursor: string
}

export async function getCells(
  rpcUrl: string,
  lockScript: { code_hash: string; hash_type: string; args: string },
  limit = '0x64',
  cursor: string | null = null,
): Promise<{ cells: LiveCell[]; lastCursor: string }> {
  const searchKey = {
    script: lockScript,
    script_type: 'lock',
    script_search_mode: 'exact',
    with_data: true,
  }
  const params: unknown[] = [searchKey, 'asc', limit]
  if (cursor) params.push(cursor)
  const result = await callCkbRpc<GetCellsResult>(rpcUrl, 'get_cells', params)
  const cells: LiveCell[] = (result?.objects ?? []).map((obj) => ({
    capacity: obj.output.capacity,
    lock: obj.output.lock,
    type: obj.output.type ?? null,
    data: obj.output_data ?? '0x',
    out_point: obj.out_point,
  }))
  return { cells, lastCursor: result?.last_cursor ?? '' }
}

export type UdtBalance = {
  name: string
  typeScript: { code_hash: string; hash_type: string; args: string }
  balance: bigint
  cellCount: number
}

export type AccountBalance = {
  ckbBalance: bigint
  ckbCellCount: number
  udtBalances: UdtBalance[]
  cells: LiveCell[]
  network: CkbNetwork
}

function scriptEquals(
  a: { code_hash: string; hash_type: string; args: string },
  b: { code_hash: string; hash_type: string; args: string },
): boolean {
  return (
    a.code_hash.toLowerCase() === b.code_hash.toLowerCase() &&
    a.hash_type === b.hash_type &&
    a.args.toLowerCase() === b.args.toLowerCase()
  )
}

export function computeAccountBalance(
  cells: LiveCell[],
  udtCfgInfos: { name: string; script: { code_hash: string; hash_type: string; args: string } }[],
  network: CkbNetwork,
): AccountBalance {
  let ckbBalance = 0n
  let ckbCellCount = 0
  const udtMap = new Map<string, UdtBalance>()

  for (const cell of cells) {
    if (!cell.type) {
      ckbBalance += BigInt(cell.capacity)
      ckbCellCount++
    } else {
      const matchedUdt = udtCfgInfos.find((u) => scriptEquals(u.script, cell.type!))
      if (matchedUdt) {
        const key = `${matchedUdt.script.code_hash}:${matchedUdt.script.args}`
        const existing = udtMap.get(key)
        const dataHex = cell.data.startsWith('0x') ? cell.data.slice(2) : cell.data
        let amount = 0n
        if (dataHex.length >= 32) {
          amount = toIntFromBigUint128Le('0x' + dataHex.substring(0, 32))
        }
        if (existing) {
          existing.balance += amount
          existing.cellCount++
        } else {
          udtMap.set(key, {
            name: matchedUdt.name,
            typeScript: matchedUdt.script,
            balance: amount,
            cellCount: 1,
          })
        }
      } else {
        ckbBalance += BigInt(cell.capacity)
        ckbCellCount++
      }
    }
  }

  return {
    ckbBalance,
    ckbCellCount,
    udtBalances: Array.from(udtMap.values()),
    cells,
    network,
  }
}
