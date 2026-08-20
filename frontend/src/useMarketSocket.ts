import { useEffect, useRef, useState } from "react";
import type { Book, Trade } from "./types";

const WS_BASE =
  import.meta.env.VITE_WS_URL ??
  (import.meta.env.VITE_API_URL ?? "http://localhost:8077").replace(
    /^http/,
    "ws",
  );

type Message =
  | { type: "snapshot"; book: Book; trades: Trade[] }
  | { type: "update"; book: Book; trades: Trade[] };

/**
 * One WebSocket per symbol. The server pushes a full snapshot on connect and an
 * update whenever the book moves, so the client never has to ask.
 *
 * `onActivity` fires on every push, which the page uses to refresh the things
 * the socket does not carry (your own cash and orders).
 */
export function useMarketSocket(symbol: string, onActivity?: () => void) {
  const [book, setBook] = useState<Book | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [connected, setConnected] = useState(false);
  const activityRef = useRef(onActivity);
  activityRef.current = onActivity;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let closed = false;

    const open = () => {
      if (closed) return;
      ws = new WebSocket(`${WS_BASE}/ws/${symbol}`);

      ws.onopen = () => {
        attempts = 0;
        setConnected(true);
      };

      ws.onmessage = (e) => {
        const msg: Message = JSON.parse(e.data);
        setBook(msg.book);
        if (msg.type === "snapshot") {
          setTrades(msg.trades);
        } else if (msg.trades.length) {
          // Newest first, and bounded so a busy session cannot grow forever.
          setTrades((prev) => [...msg.trades.reverse(), ...prev].slice(0, 30));
        }
        activityRef.current?.();
      };

      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        // Back off so a dead server is not hammered, capped at 5s.
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

  return { book, trades, connected };
}
