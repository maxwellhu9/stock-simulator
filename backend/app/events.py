"""Push updates to connected browsers instead of making them ask.

Polling -- what the frontend does today -- asks "anything new?" every two
seconds whether or not anything happened. It wastes requests when the market is
quiet and still shows stale data for up to two seconds when it is busy.

A WebSocket inverts that: the browser opens one long-lived connection and the
server writes to it the moment something changes.

The awkward part is that the exchange is synchronous (it runs in FastAPI's
worker threadpool) while WebSockets are asynchronous (they live on the event
loop). Publishing therefore has to hop threads, which is what `publish` does --
it hands the coroutine to the loop rather than trying to await from a thread
that has no loop running.
"""

from __future__ import annotations

import asyncio
import json
from collections import defaultdict
from typing import Any

from starlette.websockets import WebSocket, WebSocketState


class EventBus:
    """Fan-out of exchange events to whoever is watching each symbol."""

    def __init__(self) -> None:
        self._loop: asyncio.AbstractEventLoop | None = None
        self._subs: dict[str, set[WebSocket]] = defaultdict(set)

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """Remember the event loop, so sync code knows where to send work."""
        self._loop = loop

    def reset(self) -> None:
        """Forget everything. The bus is a module-level singleton, so tests must
        clear it between cases or a later one inherits a closed event loop."""
        self._loop = None
        self._subs.clear()

    async def connect(self, symbol: str, ws: WebSocket) -> None:
        # Bind here as well as at startup: this runs on the event loop by
        # definition, so a bus that never saw the lifespan hook (tests, or an
        # embedded app) still works instead of silently dropping every publish.
        if self._loop is None:
            self._loop = asyncio.get_running_loop()
        await ws.accept()
        self._subs[symbol].add(ws)

    def disconnect(self, symbol: str, ws: WebSocket) -> None:
        self._subs[symbol].discard(ws)

    def subscriber_count(self, symbol: str) -> int:
        return len(self._subs[symbol])

    def publish(self, symbol: str, message: dict[str, Any]) -> None:
        """Broadcast from synchronous code. Safe to call from a worker thread.

        Deliberately fire-and-forget: an order must not fail because some
        browser's socket was slow or already dead.
        """
        if self._loop is None:
            return
        asyncio.run_coroutine_threadsafe(self._broadcast(symbol, message), self._loop)

    async def _broadcast(self, symbol: str, message: dict[str, Any]) -> None:
        payload = json.dumps(message, default=str)
        dead: list[WebSocket] = []

        for ws in list(self._subs[symbol]):
            if ws.client_state is not WebSocketState.CONNECTED:
                dead.append(ws)
                continue
            try:
                await ws.send_text(payload)
            except Exception:
                # A browser that closed its tab mid-send. Drop it quietly.
                dead.append(ws)

        for ws in dead:
            self._subs[symbol].discard(ws)


bus = EventBus()
