"use client"

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import type { WsMessage, WsStatus } from "@/lib/types"
import { getEngine } from "@/lib/mock/engine"

/**
 * WS /ws/live relay client.
 *
 * MOCK MODE: instead of opening a real WebSocket, this connects to the
 * in-memory mock engine which pushes quote/execution/position/session
 * messages every 1–2s. To go live, replace the `connect` implementation with
 * `new WebSocket(WS_URL)` + `{ subscribe: [...] }` handshake and keep the
 * same reconnect/backoff logic — the rest of the app is unchanged.
 */

type Handler = (msg: WsMessage) => void

interface LiveContextValue {
  status: WsStatus
  subscribe: (channels: string[], handler: Handler) => () => void
}

const LiveContext = createContext<LiveContextValue | null>(null)

export function LiveSocketProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<WsStatus>("disconnected")
  const handlersRef = useRef(new Set<{ channels: string[]; handler: Handler }>())
  const reconnectAttempt = useRef(0)

  useEffect(() => {
    let unsubEngine: (() => void) | null = null
    let cancelled = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    const connect = () => {
      if (cancelled) return
      setStatus("reconnecting")
      // simulate connection handshake latency
      const handshake = setTimeout(() => {
        if (cancelled) return
        const engine = getEngine()
        engine.wsStatus = "connected"
        engine.startTicking()
        unsubEngine = engine.subscribe((msg) => {
          for (const entry of handlersRef.current) {
            if (entry.channels.some((c) => c === msg.ch || (c.endsWith("*") && msg.ch.startsWith(c.slice(0, -1))))) {
              entry.handler(msg)
            }
          }
        })
        reconnectAttempt.current = 0
        setStatus("connected")
      }, 700)
      return () => clearTimeout(handshake)
    }

    // exponential backoff reconnect (max 30s) — used when the socket drops
    const scheduleReconnect = () => {
      const backoff = Math.min(30000, 1000 * 2 ** reconnectAttempt.current)
      reconnectAttempt.current += 1
      reconnectTimer = setTimeout(connect, backoff)
    }
    void scheduleReconnect // kept for real-WS swap; mock never drops

    connect()

    return () => {
      cancelled = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      unsubEngine?.()
      getEngine().wsStatus = "disconnected"
      setStatus("disconnected")
    }
  }, [])

  const subscribe = useCallback((channels: string[], handler: Handler) => {
    const entry = { channels, handler }
    handlersRef.current.add(entry)
    return () => {
      handlersRef.current.delete(entry)
    }
  }, [])

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
