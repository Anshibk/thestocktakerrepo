from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Iterable

from app.models.entry import Entry
from app.schemas.entry import EntryOut


@dataclass(slots=True)
class RealtimeEvent:
    """Payload broadcast to websocket subscribers."""

    type: str
    payload: dict[str, Any]

    def as_json(self) -> dict[str, Any]:
        return {"type": self.type, "payload": self.payload}


class EntryEventBroker:
    """In-memory fan-out broker for entry change events."""

    def __init__(self, queue_size: int = 128) -> None:
        self._subscribers: set[asyncio.Queue[dict[str, Any]]] = set()
        self._lock = asyncio.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._queue_size = max(0, queue_size)

    def configure(self, *, queue_size: int | None = None) -> None:
        if queue_size is not None:
            self._queue_size = max(0, queue_size)

    def set_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    async def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]]
        maxsize = self._queue_size
        if maxsize <= 0:
            queue = asyncio.Queue()
        else:
            queue = asyncio.Queue(maxsize=maxsize)
        async with self._lock:
            self._subscribers.add(queue)
        return queue

    async def unsubscribe(self, queue: asyncio.Queue[dict[str, Any]]) -> None:
        async with self._lock:
            self._subscribers.discard(queue)

    async def publish(self, message: dict[str, Any]) -> None:
        async with self._lock:
            queues: Iterable[asyncio.Queue[dict[str, Any]]] = tuple(self._subscribers)
        stale: list[asyncio.Queue[dict[str, Any]]] = []
        for queue in queues:
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                pushed = False
                while not pushed:
                    try:
                        queue.get_nowait()
                    except asyncio.QueueEmpty:
                        break
                    try:
                        queue.put_nowait(message)
                        pushed = True
                    except asyncio.QueueFull:
                        continue
                if not pushed:
                    stale.append(queue)
            except RuntimeError:
                stale.append(queue)
        if stale:
            async with self._lock:
                for queue in stale:
                    self._subscribers.discard(queue)

    def publish_from_thread(self, message: dict[str, Any]) -> None:
        loop = self._loop
        if loop is None:
            return
        asyncio.run_coroutine_threadsafe(self.publish(message), loop)


entry_event_broker = EntryEventBroker()


def _serialize_entry(entry: Entry) -> dict[str, Any]:
    payload = EntryOut.model_validate(entry).model_dump(mode="json")
    # Align key casing with frontend expectations
    payload["type"] = str(payload.get("type", "")).lower()
    return payload


def notify_entry_created(entry: Entry) -> None:
    entry_event_broker.publish_from_thread(
        RealtimeEvent("entry.created", _serialize_entry(entry)).as_json()
    )


def notify_entry_updated(entry: Entry) -> None:
    entry_event_broker.publish_from_thread(
        RealtimeEvent("entry.updated", _serialize_entry(entry)).as_json()
    )


def notify_entry_deleted(entry_id: str, entry_type: str) -> None:
    entry_event_broker.publish_from_thread(
        RealtimeEvent(
            "entry.deleted",
            {"id": entry_id, "type": entry_type},
        ).as_json()
    )
