"use client"

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import type { WsMessage, WsStatus } from "@/lib/types"

/**
 * WS /ws/live 릴레이 클라이언트 — 백엔드의 실제 WebSocket에 붙는다.
 * 브로드캐스트 전용 채널이라 토큰이 없다 (백엔드 wsRelay 참고).
 * 연결이 없으면 status="disconnected"로 두고 아무것도 흘리지 않는다 —
 * 가짜 틱으로 대체하지 않는다. 페이지들은 SWR 폴링으로도 동작한다.
 */

const WS_URL = process.env.NEXT_PUBLIC_BACKEND_WS_URL ?? "wss://us-trading-production.up.railway.app/ws/live"

type Handler = (msg: WsMessage) => void

interface LiveContextValue {
  status: WsStatus
  subscribe: (channels: string[], handler: Handler) => () => void
}

const LiveContext = createContext<LiveContextValue | null>(null)

export function LiveSocketProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<WsStatus>("disconnected")
  const handlersRef = useRef(new Set<{ channels: string[]; handler: Handler }>())
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectAttempt = useRef(0)

  // 현재 구독 채널 합집합을 서버에 알린다
  const syncSubscriptions = useCallback(() => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const chs = new Set<string>()
    for (const e of handlersRef.current) for (const c of e.channels) chs.add(c)
    if (chs.size) ws.send(JSON.stringify({ subscribe: [...chs] }))
  }, [])

  useEffect(() => {
    let cancelled = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    const connect = () => {
      if (cancelled) return
      setStatus("reconnecting")
      let ws: WebSocket
      try {
        ws = new WebSocket(WS_URL)
      } catch {
        scheduleReconnect()
        return
      }
      wsRef.current = ws
      ws.onopen = () => {
        reconnectAttempt.current = 0
        setStatus("connected")
        syncSubscriptions()
      }
      ws.onmessage = (ev) => {
        let msg: WsMessage
        try {
          msg = JSON.parse(String(ev.data)) as WsMessage
        } catch {
          return
        }
        for (const entry of handlersRef.current) {
          if (entry.channels.some((c) => c === msg.ch || (c.endsWith("*") && msg.ch.startsWith(c.slice(0, -1))))) entry.handler(msg)
        }
      }
      ws.onclose = () => {
        wsRef.current = null
        if (cancelled) return
        setStatus("disconnected")
        scheduleReconnect()
      }
      ws.onerror = () => ws.close()
    }

    const scheduleReconnect = () => {
      const backoff = Math.min(30000, 1000 * 2 ** reconnectAttempt.current)
      reconnectAttempt.current += 1
      reconnectTimer = setTimeout(connect, backoff)
    }

    connect()
    return () => {
      cancelled = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      wsRef.current?.close()
      wsRef.current = null
      setStatus("disconnected")
    }
  }, [syncSubscriptions])

  const subscribe = useCallback(
    (channels: string[], handler: Handler) => {
      const entry = { channels, handler }
      handlersRef.current.add(entry)
      syncSubscriptions()
      return () => {
        handlersRef.current.delete(entry)
      }
    },
    [syncSubscriptions],
  )

  return <LiveContext.Provider value={{ status, subscribe }}>{children}</LiveContext.Provider>
}

export function useLiveSocket() {
  const ctx = useContext(LiveContext)
  if (!ctx) throw new Error("useLiveSocket must be used within LiveSocketProvider")
  return ctx
}

export function useLiveStatus(): WsStatus {
  return useLiveSocket().status
}

/** Subscribe to one or more channels; handler must be stable-safe (stored in ref). */
export function useLiveChannel(channels: string[], handler: Handler) {
  const { subscribe } = useLiveSocket()
  const handlerRef = useRef(handler)
  handlerRef.current = handler
  const key = channels.join(",")
  useEffect(() => {
    const chs = key ? key.split(",") : []
    if (chs.length === 0) return
    return subscribe(chs, (msg) => handlerRef.current(msg))
  }, [key, subscribe])
}

export interface LiveTick {
  last: number
  change: number
  changePct: number
  bid: number
  ask: number
  volume: number
  ts: string
}

/** Live streaming quote for a single symbol. */
export function useLiveQuote(symbol: string | null): LiveTick | null {
  const [tick, setTick] = useState<LiveTick | null>(null)
  useLiveChannel(symbol ? [`quote:${symbol}`] : [], (msg) => {
    if (msg.ch.startsWith("quote:")) setTick(msg.data as LiveTick)
  })
  useEffect(() => {
    setTick(null)
  }, [symbol])
  return tick
}
