/**
 * Komari 主题本地 Mock 后端
 * 只依赖 node 内置模块，监听 127.0.0.1:25774，供 vite dev 的 /api 代理使用。
 * 覆盖：REST(/api/public,/api/me,/api/version,/api/nodes,/api/recent,/api/records/*)
 *       + JSON-RPC 2.0 (/api/rpc2)
 */
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import process from 'node:process'

const PORT = Number(process.env.MOCK_PORT || 25774)
const HOST = '127.0.0.1'
const START = Date.now()

// ---------------------------------------------------------------- 节点定义

const NODE_SEEDS = [
  { name: '香港 · 中转 A', region: 'HK', os: 'Debian 12', arch: 'amd64', group: '线路机', tags: '中转;BGP', cores: 4, mem: 8, disk: 80, price: 168, cycle: 30, online: true, weight: 100, cpu: 'AMD EPYC 7763', gpu: '' },
  { name: '东京 · 落地 B', region: 'JP', os: 'Ubuntu 24.04', arch: 'amd64', group: '落地机', tags: '流媒体;落地', cores: 8, mem: 16, disk: 160, price: 320, cycle: 30, online: true, weight: 95, cpu: 'Intel Xeon Platinum 8375C', gpu: '' },
  { name: '洛杉矶 · 高配 C', region: 'US', os: 'AlmaLinux 9', arch: 'amd64', group: '落地机', tags: '大带宽;建站', cores: 16, mem: 32, disk: 480, price: 88, cycle: 30, online: true, weight: 90, cpu: 'AMD Ryzen 9 7950X', gpu: 'NVIDIA RTX 4090' },
  { name: '新加坡 · 轻量 D', region: 'SG', os: 'Debian 11', arch: 'arm64', group: '轻量', tags: '年付;轻量', cores: 2, mem: 2, disk: 40, price: 240, cycle: 365, online: true, weight: 80, cpu: 'Ampere Altra', gpu: '' },
  { name: '法兰克福 · 存储 E', region: 'DE', os: 'Ubuntu 22.04', arch: 'amd64', group: '存储', tags: 'NAS;备份', cores: 4, mem: 8, disk: 2048, price: 45, cycle: 30, online: true, weight: 70, cpu: 'Intel Xeon E5-2680 v4', gpu: '' },
  { name: '台北 · 探针 F', region: 'TW', os: 'Alpine 3.20', arch: 'arm64', group: '探针', tags: '探针;监控', cores: 1, mem: 1, disk: 20, price: 12, cycle: 365, online: true, weight: 60, cpu: 'QEMU Virtual CPU', gpu: '' },
  { name: '伦敦 · 测试 G', region: 'GB', os: 'Rocky Linux 9', arch: 'amd64', group: '测试', tags: '测试;按量', cores: 2, mem: 4, disk: 60, price: 0, cycle: 0, online: false, weight: 50, cpu: 'Intel Xeon Gold 6248', gpu: '' },
  { name: '首尔 · 备用 H', region: 'KR', os: 'Debian 12', arch: 'amd64', group: '线路机', tags: '备用;CN2', cores: 2, mem: 4, disk: 100, price: 99, cycle: 30, online: true, weight: 40, cpu: 'AMD EPYC 7B13', gpu: '' },
]

const DAY = 86400_000
const iso = ms => new Date(ms).toISOString()

const nodes = NODE_SEEDS.map((seed, index) => {
  const uuid = createHash('sha1').update(`mock-node-${index}`).digest('hex').slice(0, 32)
  const createdAt = new Date(START - (120 + index * 9) * DAY).toISOString()
  return {
    uuid,
    seed,
    client: {
      uuid,
      token: '',
      name: seed.name,
      cpu_name: seed.cpu,
      virtualization: index % 3 === 0 ? 'KVM' : index % 3 === 1 ? 'LXC' : 'Docker',
      arch: seed.arch,
      cpu_cores: seed.cores,
      cpu_physical_cores: Math.max(1, Math.floor(seed.cores / 2)),
      os: seed.os,
      kernel_version: `6.1.${10 + index}`,
      gpu_name: seed.gpu,
      ipv4: `10.0.${index + 1}.10`,
      ipv6: '',
      region: seed.region,
      remark: '',
      public_remark: index === 2 ? 'GPU 机器，跑渲染任务' : '',
      mem_total: seed.mem * 1024 ** 3,
      swap_total: (index % 2 === 0 ? 2 : 0) * 1024 ** 3,
      disk_total: seed.disk * 1024 ** 3,
      version: '0.1.9',
      weight: seed.weight,
      price: seed.price,
      billing_cycle: seed.cycle,
      auto_renewal: seed.cycle !== 365,
      currency: seed.price > 100 ? 'CNY' : 'USD',
      expired_at: index === 5 ? new Date(START + 6 * DAY).toISOString() : new Date(START + (300 - index * 20) * DAY).toISOString(),
      group: seed.group,
      tags: seed.tags,
      hidden: false,
      traffic_limit: index === 3 ? 1000 * 1024 ** 3 : 0,
      traffic_limit_type: index === 3 ? 'sum' : '',
      created_at: createdAt,
      updated_at: new Date(START - 3600_000).toISOString(),
    },
  }
})

// ---------------------------------------------------------------- 实时状态

function round2(value) {
  return Math.round(value * 100) / 100
}

// 主题用「地区+运营商」做归一化后精确比较（taskNameMatch: normalized-exact），
// 所以任务名归一化后必须正好等于「北京电信 / 北京联通 / 北京移动」。
const PING_TASKS = [
  { id: 1, name: '北京电信', interval: 60, loss: 0, type: 'icmp', target: '202.97.0.1', default_on: true },
  { id: 2, name: '北京联通', interval: 60, loss: 0, type: 'icmp', target: '218.105.0.1', default_on: true },
  { id: 3, name: '北京移动', interval: 120, loss: 0, type: 'tcp', target: '223.120.0.1', default_on: false },
]

function pingTasksWithClients() {
  const uuids = nodes.map(node => node.uuid)
  return PING_TASKS.map(task => ({ ...task, clients: uuids, all_clients: true }))
}

function pingSummariesFor(uuid, t) {
  const result = {}
  const base = 20 + (Number.parseInt(uuid.slice(0, 2), 16) % 180)
  for (const task of PING_TASKS) {
    const latest = task.id === 3 && Number.parseInt(uuid.slice(2, 4), 16) % 3 === 0
      ? -1
      : round2(base + Math.sin(t / 30_000 + task.id) * 8)
    result[String(task.id)] = {
      name: task.name,
      latest,
      avg: round2(base + 3),
      tail: round2(base + 12),
      loss: latest < 0 ? 4 : 0,
      min: round2(base - 6),
      max: round2(base + 18),
    }
  }
  return result
}

function statusFor(node, t = Date.now()) {
  const { seed, uuid } = node
  const phase = Number.parseInt(uuid.slice(0, 4), 16) % 100 / 100 * Math.PI * 2
  const wave = Math.sin(t / 40_000 + phase)
  const jitter = () => (Math.random() - 0.5) * 2

  const cpu = seed.online
    ? Math.max(1, Math.min(99, 28 + wave * 18 + jitter() * 6 + (seed.group === '存储' ? -12 : 0)))
    : 0
  const ramTotal = seed.mem * 1024 ** 3
  const ramUsed = ramTotal * (seed.online ? 0.42 + wave * 0.06 + Math.random() * 0.04 : 0)
  const swapTotal = (Number.parseInt(uuid.slice(4, 8), 16) % 2 === 0 ? 2 : 0) * 1024 ** 3
  const diskTotal = seed.disk * 1024 ** 3
  const diskUsed = diskTotal * (seed.group === '存储' ? 0.71 : 0.23 + (Number.parseInt(uuid.slice(8, 10), 16) % 20) / 100)
  const netBase = seed.group === '线路机' ? 900 : seed.group === '落地机' ? 400 : 60

  return {
    client: uuid,
    time: iso(t),
    cpu: round2(cpu),
    gpu: seed.gpu ? round2(Math.max(0, 20 + wave * 15 + jitter() * 5)) : 0,
    gpu_count: seed.gpu ? 1 : 0,
    gpu_average_usage: seed.gpu ? round2(Math.max(0, 20 + wave * 15)) : 0,
    ram: Math.round(ramUsed),
    ram_total: ramTotal,
    swap: Math.round(swapTotal * 0.12),
    swap_total: swapTotal,
    load: round2(seed.online ? Math.max(0, 0.4 + wave * 0.5 + jitter() * 0.2) : 0),
    load5: round2(Math.max(0, 0.5 + wave * 0.4)),
    load15: round2(Math.max(0, 0.45 + wave * 0.3)),
    temp: seed.online ? round2(42 + wave * 6 + jitter()) : 0,
    disk: Math.round(diskUsed),
    disk_total: diskTotal,
    net_in: seed.online ? Math.round(Math.max(0, netBase + wave * netBase * 0.4) * 1024) : 0,
    net_out: seed.online ? Math.round(Math.max(0, netBase * 0.6 + wave * netBase * 0.2) * 1024) : 0,
    net_total_up: Math.round(seed.online ? 1.2e12 + t % 1e10 : 0),
    net_total_down: Math.round(seed.online ? 3.4e12 + t % 2e10 : 0),
    process: seed.online ? 120 + (Number.parseInt(uuid.slice(0, 2), 16) % 80) : 0,
    connections: seed.online ? 320 + (Number.parseInt(uuid.slice(2, 4), 16) % 200) : 0,
    connections_udp: seed.online ? 24 + (Number.parseInt(uuid.slice(4, 6), 16) % 10) : 0,
    online: seed.online,
    uptime: seed.online ? 86400 * (10 + (Number.parseInt(uuid.slice(0, 2), 16) % 90)) + Math.floor((t % 86400_000) / 1000) : 0,
    message: '',
    updated_at: iso(t),
    ping: pingSummariesFor(uuid, t),
  }
}

// ---------------------------------------------------------------- 历史记录

function loadRecords(uuid, hours, maxCount) {
  const span = Math.min(hours || 24, 24 * 7)
  const stepMs = 5 * 60_000
  const count = Math.min(Math.floor((span * 3600_000) / stepMs), maxCount || 400)
  const records = []
  const node = nodes.find(item => item.uuid === uuid)
  if (!node)
    return records
  for (let i = count; i >= 0; i--) {
    const s = statusFor(node, Date.now() - i * stepMs)
    records.push({
      client: s.client,
      time: s.time,
      cpu: s.cpu,
      gpu: s.gpu,
      ram: s.ram,
      ram_total: s.ram_total,
      swap: s.swap,
      swap_total: s.swap_total,
      load: s.load,
      load5: s.load5,
      load15: s.load15,
      temp: s.temp,
      disk: s.disk,
      disk_total: s.disk_total,
      net_in: s.net_in,
      net_out: s.net_out,
      net_total_up: s.net_total_up,
      net_total_down: s.net_total_down,
      process: s.process,
      connections: s.connections,
      connections_udp: s.connections_udp,
    })
  }
  return records
}

function pingRecords(uuid, taskId, hours) {
  const span = Math.min(hours || 6, 24)
  const stepMs = 60_000
  const count = Math.floor((span * 3600_000) / stepMs)
  const records = []
  const node = nodes.find(item => item.uuid === uuid)
  if (!node)
    return records
  const base = 20 + (Number.parseInt(node.uuid.slice(0, 2), 16) % 180)
  const ids = taskId ? [Number(taskId)] : PING_TASKS.map(task => task.id)
  for (let i = count; i >= 0; i--) {
    const t = Date.now() - i * stepMs
    for (const id of ids) {
      const lost = Math.random() < 0.02
      records.push({
        client: uuid,
        task_id: id,
        time: iso(t),
        value: lost ? -1 : round2(base + Math.sin(t / 60_000 + id) * 9 + (Math.random() - 0.5) * 4),
      })
    }
  }
  return records
}

function basicInfo(uuid) {
  const base = 20 + (Number.parseInt(uuid.slice(0, 2), 16) % 180)
  return PING_TASKS.map(task => ({
    client: uuid,
    task_id: task.id,
    loss: 0,
    min: round2(base - 6),
    max: round2(base + 18),
  }))
}

// ---------------------------------------------------------------- 响应封装

const ok = data => ({ status: 'success', message: '', data })
const rpcOk = (id, result) => ({ jsonrpc: '2.0', id, result })
const rpcErr = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })

function publicInfo() {
  return {
    allow_cors: false,
    custom_body: '',
    custom_head: '',
    description: '本地 Mock 环境 · 用于主题联调',
    disable_password_login: false,
    oauth_enable: false,
    oauth_provider: null,
    ping_record_preserve_time: 43200,
    private_site: false,
    record_enabled: true,
    record_preserve_time: 43200,
    sitename: 'Transit Mock Lab',
    theme: 'Transit',
    theme_settings: {},
    visitor_audit_enabled: false,
  }
}

function nodesMap() {
  const map = {}
  for (const node of nodes)
    map[node.uuid] = node.client
  return map
}

function statusesMap() {
  const now = Date.now()
  const map = {}
  for (const node of nodes)
    map[node.uuid] = statusFor(node, now)
  return map
}

// ---------------------------------------------------------------- RPC 分发

function handleRpc(method, params, rpcId) {
  const p = params || {}
  switch (method) {
    case 'rpc.ping':
      return rpcOk(rpcId, 'pong')
    case 'rpc.version':
      return rpcOk(rpcId, 'mock-1.4.5')
    case 'rpc.methods':
      return rpcOk(rpcId, ['rpc.ping', 'rpc.version', 'common:getNodes', 'common:getNodesLatestStatus'])
    case 'rpc.help':
      return rpcOk(rpcId, [])
    case 'common:getNodes':
      return rpcOk(rpcId, nodesMap())
    case 'public:getNodesInformation':
      return rpcOk(rpcId, nodes.map(node => node.client))
    case 'common:getNodesLatestStatus':
      return rpcOk(rpcId, statusesMap())
    case 'common:getPublicInfo':
    case 'public:getPublicSettings':
      return rpcOk(rpcId, publicInfo())
    case 'public:getMe':
      return rpcOk(rpcId, { logged_in: false, username: '' })
    case 'common:getVersion':
    case 'public:getVersion':
      return rpcOk(rpcId, { version: '1.4.5', hash: 'mock' })
    case 'common:getNodeRecentStatus':
    case 'public:getClientRecentRecords': {
      const node = nodes.find(item => item.uuid === p.uuid)
      if (!node)
        return rpcErr(rpcId, -32602, 'client not found')
      const limit = Number(p.limit || 60)
      const records = []
      for (let i = limit; i >= 0; i--)
        records.push(statusFor(node, Date.now() - i * 10_000))
      return rpcOk(rpcId, method === 'common:getNodeRecentStatus' ? { count: records.length, records } : records)
    }
    case 'common:getRecords': {
      const uuid = p.uuid || nodes[0].uuid
      if (p.type === 'ping') {
        return rpcOk(rpcId, {
          records: pingRecords(uuid, p.task_id, Number(p.hours)),
          tasks: pingTasksWithClients(),
          basic_info: basicInfo(uuid),
        })
      }
      return rpcOk(rpcId, { count: 0, records: loadRecords(uuid, Number(p.hours), p.max_count || p.maxCount) })
    }
    case 'public:getRecordsByUUID': {
      const node = nodes.find(item => item.uuid === p.uuid)
      if (!node)
        return rpcErr(rpcId, -32602, 'client not found')
      const records = loadRecords(node.uuid, Number(p.hours || 24))
      return rpcOk(rpcId, {
        count: records.length,
        records,
        load_type: p.load_type || 'load',
        has_gpu_data: Boolean(node.seed.gpu),
        gpu_devices: node.seed.gpu ? { 0: { name: node.seed.gpu } } : {},
      })
    }
    case 'public:getPingRecords': {
      const uuid = p.uuid || nodes[0].uuid
      return rpcOk(rpcId, {
        count: 0,
        records: pingRecords(uuid, p.task_id, Number(p.hours || 6)),
        tasks: pingTasksWithClients(),
        basic_info: basicInfo(uuid),
      })
    }
    case 'public:getPublicPingTasks':
      return rpcOk(rpcId, pingTasksWithClients())
    case 'public:listMetricDefinitions':
      return rpcOk(rpcId, [])
    case 'public:queryMetrics':
      return rpcOk(rpcId, { count: 0, records: [], metrics: [] })
    case 'public:getPingMetricStats':
      return rpcOk(rpcId, { count: 0, stats: [] })
    case 'public:recordVisitorEvent':
      return rpcOk(rpcId, { success: true })
    default:
      return rpcErr(rpcId, -32601, `Mock backend has no handler for ${method}`)
  }
}

// ---------------------------------------------------------------- HTTP 服务

const ADMIN_PREFIX = /^admin:/

function send(res, status, payload, headers = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': typeof payload === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw)
        return resolve(null)
      try {
        resolve(JSON.parse(raw))
      }
      catch {
        resolve(raw)
      }
    })
  })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`)
  const path = url.pathname
  const method = req.method || 'GET'

  if (path === '/health')
    return send(res, 200, { ok: true, nodes: nodes.length, uptime: Math.round((Date.now() - START) / 1000) })

  if (path === '/api/public')
    return send(res, 200, ok(publicInfo()))
  if (path === '/api/version')
    return send(res, 200, ok({ version: '1.4.5', hash: 'mock' }))
  if (path === '/api/me')
    return send(res, 200, { logged_in: false, username: '' })
  if (path === '/api/nodes')
    return send(res, 200, ok(nodes.map(node => node.client)))

  const recentMatch = /^\/api\/recent\/(.+)$/.exec(path)
  if (recentMatch) {
    const node = nodes.find(item => item.uuid === recentMatch[1])
    if (!node)
      return send(res, 404, { status: 'error', message: 'not found', data: null })
    const records = []
    for (let i = 60; i >= 0; i--)
      records.push(statusFor(node, Date.now() - i * 1000))
    return send(res, 200, ok(records))
  }

  if (path === '/api/records/load') {
    const uuid = url.searchParams.get('uuid') || nodes[0].uuid
    const hours = Number(url.searchParams.get('hours') || 24)
    const maxCount = Number(url.searchParams.get('max_count') || 0) || undefined
    const records = loadRecords(uuid, hours, maxCount)
    return send(res, 200, ok({ count: records.length, records }))
  }

  if (path === '/api/records/ping') {
    const uuid = url.searchParams.get('uuid') || nodes[0].uuid
    const hours = Number(url.searchParams.get('hours') || 6)
    return send(res, 200, ok({
      count: 0,
      records: pingRecords(uuid, undefined, hours),
      tasks: pingTasksWithClients(),
      basic_info: basicInfo(uuid),
    }))
  }

  if (path === '/api/rpc2' && method === 'POST') {
    const body = await readBody(req)
    if (!body || typeof body !== 'object')
      return send(res, 400, rpcErr(null, -32700, 'Parse error'))
    const { method: rpcMethod, params, id } = body
    if (typeof rpcMethod !== 'string')
      return send(res, 400, rpcErr(id ?? null, -32600, 'Invalid Request'))
    if (ADMIN_PREFIX.test(rpcMethod))
      return send(res, 200, rpcErr(id ?? null, -32040, 'Unauthorized: mock has no admin session'))
    if (process.env.MOCK_LOG !== '0')
      process.stdout.write(`[komari-mock] ${rpcMethod} ${JSON.stringify(params ?? {}).slice(0, 160)}\n`)
    return send(res, 200, handleRpc(rpcMethod, params, id ?? null))
  }

  if (path.startsWith('/api/'))
    return send(res, 404, { status: 'error', message: `mock: unhandled ${method} ${path}`, data: null })

  return send(res, 404, 'not found')
})

server.listen(PORT, HOST, () => {
  process.stdout.write(`[komari-mock] listening http://${HOST}:${PORT} with ${nodes.length} mock nodes\n`)
})

process.on('SIGTERM', () => server.close(() => process.exit(0)))
process.on('SIGINT', () => server.close(() => process.exit(0)))
