import { useEffect, useRef, useState } from "react";
import { DEMO } from "./api";
import { subscribe } from "./demo/server";
import type { Book, Money, Trade } from "./types";

const WS_BASE =
  import.meta.env.VITE_WS_URL ??
  (import.meta.env.VITE_API_URL ?? "http://localhost:8077").replace(/^http/, "ws");

type Message =
  | { type: "snapshot"; book: Book; trades: Trade[] }
  | { type: "update"; book: Book; trades: Trade[]; last: Money | null };

/**
 * One WebSocket per symbol. The server sends a snapshot on connect and an
 * update whenever the book moves, so nothing here ever polls.
 */
export function useMarketSocket(symbol: string, onActivity?: () => void) {
  const [book, setBook] = useState<Book | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [last, setLast] = useState<Money | null>(null);
  const [connected, setConnected] = useState(false);
  const activity = useRef(onActivity);
  activity.current = onActivity;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let closed = false;
    setBook(null);
    setTrades([]);
    setLast(null);

    const handle = (msg: Message) => {
      setBook(msg.book);
      if (msg.type === "snapshot") {
        setTrades(msg.trades);
        if (msg.trades[0]) setLast(msg.trades[0].price);
      } else {
        if (msg.last) setLast(msg.last);
        if (msg.trades.length) {
          setTrades((prev) => [...[...msg.trades].reverse(), ...prev].slice(0, 40));
        }
      }
      activity.current?.();
    };

    if (DEMO) {
      setConnected(true);
      return subscribe(symbol, handle);
    }

    const open = () => {
      if (closed) return;
      ws = new WebSocket(`${WS_BASE}/ws/${symbol}`);
      ws.onopen = () => {
        attempts = 0;
        setConnected(true);
      };
      ws.onmessage = (e) => handle(JSON.parse(e.data));
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        attempts += 1;
        retry = setTimeout(open, Math.min(500 * attempts, 5000));
      };
      ws.onerror = () => ws?.close();
    };

    open();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, [symbol]);

  return { book, trades, last, connected };
}
