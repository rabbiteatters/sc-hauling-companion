import type { ShareSnapshot } from './share'

const BROKER = 'wss://broker.hivemq.com:8884/mqtt'
const ROOM_KEY = 'sc-hauling-live-room'
const ORIGIN_KEY = 'sc-hauling-live-origin'
const CLIENT_KEY = 'sc-hauling-live-client'
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/
const TOKEN = '([A-Za-z0-9_-]{8,64})'

export type LiveRole = 'edit' | 'run' | 'view'
export type LiveConnection = 'connecting' | 'live' | 'offline'

export type LiveRoom = {
  roomId: string
  viewId: string
  writeKey: string
  runKey: string
}

export type LiveAccess =
  | { role: 'edit'; roomId: string; writeKey: string }
  | { role: 'run'; roomId: string; runKey: string }
  | { role: 'view'; viewId: string }

export function liveAccessFromHash(hash = typeof location === 'undefined' ? '' : location.hash): LiveAccess | null {
  const edit = new RegExp(`^#(?:e|edit)\\.${TOKEN}\\.${TOKEN}$`).exec(hash)
  if (edit) return { role: 'edit', roomId: edit[1], writeKey: edit[2] }
  const run = new RegExp(`^#(?:s|run)\\.${TOKEN}\\.${TOKEN}$`).exec(hash)
  if (run) return { role: 'run', roomId: run[1], runKey: run[2] }
  const view = new RegExp(`^#(?:v|view)\\.${TOKEN}$`).exec(hash)
  if (view) return { role: 'view', viewId: view[1] }
  return null
}

function pageUrl(hash: string): string {
  const url = new URL(import.meta.env.BASE_URL || '/', location.origin)
  url.hash = hash
  return url.href
}

export function editShareUrl(room: { roomId: string; writeKey: string }): string {
  return pageUrl(`e.${room.roomId}.${room.writeKey}`)
}

export function runShareUrl(room: { roomId: string; runKey: string }): string {
  return pageUrl(`s.${room.roomId}.${room.runKey}`)
}

export function viewShareUrl(viewId: string): string {
  return pageUrl(`v.${viewId}`)
}

export function liveSnapKey(snap: ShareSnapshot): string {
  return JSON.stringify({
    capacityMode: snap.capacityMode,
    shipId: snap.shipId,
    customScu: snap.customScu,
    capacityScu: snap.capacityScu,
    startId: snap.startId,
    missions: snap.missions,
    route: snap.route,
    done: [...snap.done].sort((a, b) => a - b),
    actions: [...(snap.actions ?? [])].sort(),
    step: snap.step,
  })
}

export function liveClientId(): string {
  try {
    const existing = sessionStorage.getItem(CLIENT_KEY)
    if (existing && ID_RE.test(existing)) return existing
    const id = newRoomId()
    sessionStorage.setItem(CLIENT_KEY, id)
    return id
  } catch {
    return newRoomId()
  }
}

export function loadLiveRoom(): LiveRoom | null {
  try {
    const raw = localStorage.getItem(ROOM_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as LiveRoom
    if (
      !parsed ||
      !ID_RE.test(parsed.roomId) ||
      !ID_RE.test(parsed.viewId) ||
      !ID_RE.test(parsed.writeKey)
    ) {
      return null
    }
    if (!ID_RE.test(parsed.runKey)) {
      parsed.runKey = newRoomId()
      try {
        localStorage.setItem(ROOM_KEY, JSON.stringify(parsed))
      } catch {
        // Keep the new key for this page even if it cannot be stored.
      }
    }
    return parsed
  } catch {
    return null
  }
}

export function markLiveOrigin(roomId: string) {
  try {
    sessionStorage.setItem(ORIGIN_KEY, roomId)
  } catch {
    // Private mode can block storage; this tab still publishes until it closes.
  }
}

export function isLiveOrigin(roomId: string): boolean {
  try {
    return sessionStorage.getItem(ORIGIN_KEY) === roomId
  } catch {
    return false
  }
}

/** Reuse this browser's room so the same links keep working. */
export function claimLiveRoom(): LiveRoom {
  const existing = loadLiveRoom()
  if (existing) return existing
  const room = {
    roomId: newRoomId(),
    viewId: newRoomId(),
    writeKey: newRoomId(),
    runKey: newRoomId(),
  }
  try {
    localStorage.setItem(ROOM_KEY, JSON.stringify(room))
  } catch {
    // Private mode can block storage; this tab can still publish until it closes.
  }
  return room
}

function newRoomId(): string {
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

type Envelope = {
  v: 1
  updated: number
  from?: string
  view?: string
  run?: string
  snap: ShareSnapshot
}

export function startLiveLink(options: {
  role: LiveRole
  topicId: string
  clientId: string
  /** Origin tab publishes immediately. Other links wait for the current status first. */
  eager?: boolean
  getViewId?: () => string | null
  getRunKey?: () => string | null
  getStatus: () => ShareSnapshot
  onStatus: (snap: ShareSnapshot, viewId?: string, runKey?: string) => void
  onConnection?: (state: LiveConnection) => void
}): { publish: () => void; close: () => void } {
  const topic =
    options.role === 'view'
      ? `sc-hauling/v1/v/${options.topicId}`
      : `sc-hauling/v1/${options.topicId}`
  let closed = false
  let socket: WebSocket | null = null
  let connack = false
  let attempt = 0
  let ping: ReturnType<typeof setInterval> | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  let chain = Promise.resolve()
  let lastUpdated = 0
  const parser = new FrameParser()

  const publish = () => {
    if (options.role === 'view' || !socket || socket.readyState !== WebSocket.OPEN || !connack) return
    const viewId = options.getViewId?.() || ''
    const runKey = options.getRunKey?.() || ''
    const shared: Envelope = {
      v: 1,
      updated: Date.now(),
      from: options.clientId,
      ...(viewId ? { view: viewId } : {}),
      snap: options.getStatus(),
    }
    const editBody = new TextEncoder().encode(
      JSON.stringify(runKey ? { ...shared, run: runKey } : shared),
    )
    socket.send(wire(publishPacket(topic, editBody, true)))
    if (viewId) {
      const viewBody = new TextEncoder().encode(JSON.stringify(shared))
      socket.send(wire(publishPacket(`sc-hauling/v1/v/${viewId}`, viewBody, true)))
    }
  }

  const connect = () => {
    if (closed) return
    options.onConnection?.('connecting')
    connack = false
    const ws = new WebSocket(BROKER, ['mqtt'])
    ws.binaryType = 'arraybuffer'
    socket = ws
    ws.onopen = () => {
      if (socket !== ws) return
      ws.send(wire(connectPacket(`sch${Math.random().toString(36).slice(2, 12)}`)))
    }
    ws.onmessage = (ev) => {
      chain = chain.then(async () => {
        if (socket !== ws) return
        parser.push(await toBytes(ev.data))
        for (const frame of parser.drain()) {
          if (frame.type === 0x20) {
            const code = frame.body[1] ?? 0xff
            if (code !== 0) {
              ws.close()
              return
            }
            connack = true
            attempt = 0
            options.onConnection?.('live')
            ws.send(wire(subscribePacket(topic)))
            if (options.role === 'edit' && options.eager) publish()
          } else if ((frame.type & 0xf0) === 0x30) {
            deliver(frame.body)
          }
        }
      }).catch(() => {})
    }
    ws.onclose = () => {
      if (socket !== ws || closed) return
      connack = false
      socket = null
      options.onConnection?.('offline')
      const wait = Math.min(15000, 1000 * 2 ** attempt)
      attempt += 1
      retry = setTimeout(connect, wait)
    }
    ws.onerror = () => {
      ws.close()
    }
  }

  function deliver(body: Uint8Array) {
    if (body.length < 2) return
    const topicLen = (body[0] << 8) | body[1]
    const payload = body.subarray(2 + topicLen)
    if (!payload.length) return
    let envelope: Envelope
    try {
      envelope = JSON.parse(new TextDecoder().decode(payload)) as Envelope
    } catch {
      return
    }
    if (!envelope || envelope.v !== 1 || !envelope.snap || envelope.updated < lastUpdated) return
    if (envelope.from && envelope.from === options.clientId) return
    lastUpdated = envelope.updated
    options.onStatus(envelope.snap, envelope.view, envelope.run)
  }

  ping = setInterval(() => {
    if (socket && socket.readyState === WebSocket.OPEN && connack) {
      socket.send(wire(new Uint8Array([0xc0, 0x00])))
    }
  }, 25000)
  connect()

  return {
    publish,
    close: () => {
      closed = true
      if (ping) clearInterval(ping)
      if (retry) clearTimeout(retry)
      socket?.close()
      socket = null
    },
  }
}

function wire(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}

function toBytes(data: unknown): Promise<Uint8Array> {
  if (data instanceof ArrayBuffer) return Promise.resolve(new Uint8Array(data))
  if (ArrayBuffer.isView(data)) {
    return Promise.resolve(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
  }
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return data.arrayBuffer().then((buf) => new Uint8Array(buf))
  }
  return Promise.resolve(new Uint8Array())
}

class FrameParser {
  private buf = new Uint8Array()

  push(chunk: Uint8Array) {
    if (!chunk.length) return
    const next = new Uint8Array(this.buf.length + chunk.length)
    next.set(this.buf)
    next.set(chunk, this.buf.length)
    this.buf = next
  }

  drain(): { type: number; body: Uint8Array }[] {
    const frames: { type: number; body: Uint8Array }[] = []
    while (this.buf.length >= 2) {
      let multiplier = 1
      let value = 0
      let i = 1
      let digit = 0
      do {
        if (i >= this.buf.length) return frames
        digit = this.buf[i++]
        value += (digit & 127) * multiplier
        multiplier *= 128
        if (multiplier > 128 * 128 * 128 * 128) return frames
      } while (digit & 128)
      if (this.buf.length < i + value) return frames
      frames.push({ type: this.buf[0], body: this.buf.slice(i, i + value) })
      this.buf = this.buf.slice(i + value)
    }
    return frames
  }
}

function remaining(len: number): number[] {
  const out: number[] = []
  do {
    let digit = len % 128
    len = Math.floor(len / 128)
    if (len > 0) digit |= 128
    out.push(digit)
  } while (len > 0)
  return out
}

function utf8(text: string): Uint8Array {
  const body = new TextEncoder().encode(text)
  const out = new Uint8Array(2 + body.length)
  out[0] = body.length >> 8
  out[1] = body.length & 255
  out.set(body, 2)
  return out
}

function packet(type: number, body: Uint8Array): Uint8Array {
  const head = remaining(body.length)
  const out = new Uint8Array(1 + head.length + body.length)
  out[0] = type
  out.set(head, 1)
  out.set(body, 1 + head.length)
  return out
}

function connectPacket(clientId: string): Uint8Array {
  const id = utf8(clientId)
  const body = new Uint8Array(utf8('MQTT').length + 4 + id.length)
  const proto = utf8('MQTT')
  body.set(proto)
  let i = proto.length
  body[i++] = 4
  body[i++] = 0x02
  body[i++] = 0
  body[i++] = 60
  body.set(id, i)
  return packet(0x10, body)
}

function subscribePacket(topic: string): Uint8Array {
  const name = utf8(topic)
  const body = new Uint8Array(2 + name.length + 1)
  body[0] = 0
  body[1] = 1
  body.set(name, 2)
  return packet(0x82, body)
}

function publishPacket(topic: string, payload: Uint8Array, retain: boolean): Uint8Array {
  const name = utf8(topic)
  const body = new Uint8Array(name.length + payload.length)
  body.set(name)
  body.set(payload, name.length)
  return packet(retain ? 0x31 : 0x30, body)
}
