from __future__ import annotations

import hashlib
import threading
import time
from collections import deque
from typing import Any

import zmq
from fastapi import FastAPI

from app.config import settings
from app.services import BitcoinRpcClient

app = FastAPI(title="CoreCraft Atividade 2", version="0.1.0")
rpc = BitcoinRpcClient()


def _double_sha256_hex(payload: bytes) -> str:
    return hashlib.sha256(hashlib.sha256(payload).digest()).digest()[::-1].hex()


def _little_endian_hash_to_hex(payload: bytes) -> str:
    return payload[::-1].hex()


class EventStore:
    def __init__(self, maxlen: int) -> None:
        self._maxlen = maxlen
        self._blocks: deque[dict[str, Any]] = deque(maxlen=maxlen)
        self._txs: deque[dict[str, Any]] = deque(maxlen=maxlen)
        self._last_event_time: float | None = None
        self._lock = threading.Lock()

    def add_block(self, block_hash: str, ts: float) -> None:
        with self._lock:
            self._blocks.append({"hash": block_hash, "ts": ts})
            self._last_event_time = ts

    def add_tx(self, txid: str, ts: float) -> None:
        with self._lock:
            self._txs.append({"txid": txid, "ts": ts})
            self._last_event_time = ts

    def latest(self, limit: int) -> dict[str, list[dict[str, Any]]]:
        with self._lock:
            blocks = list(self._blocks)[-limit:]
            txs = list(self._txs)[-limit:]
        return {"blocks": blocks, "txs": txs}

    def summary(self, window_seconds: int) -> dict[str, int | float | None]:
        now = time.time()
        cutoff = now - window_seconds
        with self._lock:
            recent_blocks = [item for item in self._blocks if item["ts"] >= cutoff]
            recent_txs = [item for item in self._txs if item["ts"] >= cutoff]
            last_event_time = self._last_event_time
            last_block_time = self._blocks[-1]["ts"] if self._blocks else None
            blocks_total = len(self._blocks)
            tx_total = len(self._txs)

        tx_per_second = (len(recent_txs) / window_seconds) if window_seconds > 0 else 0.0
        return {
            "blocks_observed": len(recent_blocks),
            "tx_observed": len(recent_txs),
            "blocks_observed_total": blocks_total,
            "tx_observed_total": tx_total,
            "last_event_time": last_event_time,
            "last_block_time": last_block_time,
            "tx_per_second": round(tx_per_second, 3),
        }

    def last_seen_block(self) -> str | None:
        with self._lock:
            if not self._blocks:
                return None
            return str(self._blocks[-1]["hash"])


event_store = EventStore(settings.EVENTS_BUFFER_SIZE)
zmq_stop_event = threading.Event()
zmq_status: dict[str, Any] = {"running": False, "last_error": None}


def zmq_listener() -> None:
    context = zmq.Context.instance()
    socket = context.socket(zmq.SUB)
    socket.setsockopt(zmq.SUBSCRIBE, b"hashblock")
    socket.setsockopt(zmq.SUBSCRIBE, b"rawblock")
    socket.setsockopt(zmq.SUBSCRIBE, b"rawtx")
    socket.connect(settings.BITCOIN_ZMQ_BLOCK)
    socket.connect(settings.BITCOIN_ZMQ_TX)

    poller = zmq.Poller()
    poller.register(socket, zmq.POLLIN)
    zmq_status["running"] = True

    try:
        while not zmq_stop_event.is_set():
            events = dict(poller.poll(timeout=1000))
            if socket not in events:
                continue

            parts = socket.recv_multipart()
            if len(parts) < 2:
                continue

            topic, payload = parts[0], parts[1]
            ts = time.time()
            if topic == b"hashblock" and len(payload) == 32:
                block_hash = _little_endian_hash_to_hex(payload)
                event_store.add_block(block_hash, ts)
            elif topic == b"rawblock" and len(payload) >= 80:
                block_hash = _double_sha256_hex(payload[:80])
                event_store.add_block(block_hash, ts)
            elif topic == b"rawtx":
                txid = _double_sha256_hex(payload)
                event_store.add_tx(txid, ts)
    except Exception as exc:  # noqa: BLE001
        zmq_status["last_error"] = str(exc)
    finally:
        zmq_status["running"] = False
        socket.close(0)


@app.on_event("startup")
def startup() -> None:
    zmq_stop_event.clear()
    thread = threading.Thread(target=zmq_listener, name="a2-zmq-listener", daemon=True)
    thread.start()


@app.on_event("shutdown")
def shutdown() -> None:
    zmq_stop_event.set()


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "activity": "atividade-2",
        "zmq": zmq_status,
    }


@app.get("/events/summary")
def events_summary() -> dict[str, Any]:
    payload = event_store.summary(settings.EVENTS_WINDOW_SECONDS)
    payload["window_seconds"] = settings.EVENTS_WINDOW_SECONDS
    payload["zmq"] = zmq_status
    return payload


@app.get("/events/latest")
def events_latest() -> dict[str, Any]:
    latest = event_store.latest(settings.EVENTS_LATEST_LIMIT)
    latest["limit"] = settings.EVENTS_LATEST_LIMIT
    return latest


@app.get("/events/state-comparison")
def events_state_comparison() -> dict[str, Any]:
    best_block = rpc.call("getbestblockhash")
    last_seen_block = event_store.last_seen_block()
    divergence = bool(last_seen_block and best_block != last_seen_block)
    return {
        "best_block": str(best_block),
        "last_seen_block": last_seen_block,
        "divergence": divergence,
    }


@app.get("/config/bitcoin-stub")
def bitcoin_config_stub() -> dict[str, str | int]:
    return {
        "host": settings.BITCOIN_HOST,
        "rpc_port": settings.BITCOIN_RPC_PORT,
        "network": settings.BITCOIN_NETWORK,
    }
