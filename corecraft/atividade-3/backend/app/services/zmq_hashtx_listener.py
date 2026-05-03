"""
Canal paralelo ao RPC: subscrição ZMQ `hashtx` do Bitcoin Core.

O bitcoind publica hashes de transacções que o **node** vê (mempool e blocos),
sem filtro por wallet. Para correlacionar com a wallet (ex.: troco), use RPC
(`listunspent`, `gettransaction`, `listsinceblock`, …).

Activar: `BITCOIN_ZMQ_SUB_URL` (ex. `tcp://bitcoind:28333`) + `zmqpubhashtx` no `bitcoin.conf`.

O filtro «só txs das wallets carregadas» é feito na API (`main.py` + RPC), não neste módulo.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from typing import Any

from app.config import settings

_FEED: deque[dict[str, Any]] = deque(maxlen=200)
_FEED_LOCK = threading.Lock()

_STATE_LOCK = threading.Lock()
_STATE: dict[str, Any] = {
    "thread_alive": False,
    "connected": False,
    "url": "",
    "last_error": None,
    "events_total": 0,
}

_STOP = threading.Event()
_WORKER: threading.Thread | None = None


def _parse_zmq_seq(raw: bytes | memoryview) -> int | None:
    if len(raw) != 4:
        return None
    return int.from_bytes(raw, "little")


def _worker_loop(url: str) -> None:
    import zmq

    with _STATE_LOCK:
        _STATE["url"] = url
        _STATE["thread_alive"] = True
        _STATE["last_error"] = None

    ctx = zmq.Context()
    try:
        while not _STOP.is_set():
            sock: zmq.Socket | None = None
            try:
                sock = ctx.socket(zmq.SUB)
                sock.setsockopt(zmq.RCVTIMEO, 2000)
                sock.setsockopt(zmq.RECONNECT_IVL, 1500)
                sock.connect(url)
                sock.setsockopt(zmq.SUBSCRIBE, b"hashtx")
                with _STATE_LOCK:
                    _STATE["connected"] = True
                    _STATE["last_error"] = None
                while not _STOP.is_set():
                    try:
                        parts = sock.recv_multipart()
                    except zmq.Again:
                        continue
                    except zmq.ZMQError as exc:
                        with _STATE_LOCK:
                            _STATE["connected"] = False
                            _STATE["last_error"] = f"zmq_recv: {exc}"
                        break
                    if len(parts) < 2 or parts[0] != b"hashtx":
                        continue
                    body = parts[1]
                    if len(body) != 32:
                        continue
                    # Mesmo formato que RPC / exploradores (ver doc/zmq.md do Bitcoin Core).
                    txid = bytes(body).hex()
                    zmq_seq = _parse_zmq_seq(parts[2]) if len(parts) >= 3 else None
                    entry: dict[str, Any] = {
                        "topic": "hashtx",
                        "txid": txid,
                        "received_at": time.time(),
                        "zmq_seq": zmq_seq,
                    }
                    with _FEED_LOCK:
                        _FEED.append(entry)
                    with _STATE_LOCK:
                        _STATE["events_total"] = int(_STATE["events_total"]) + 1
            except Exception as exc:
                with _STATE_LOCK:
                    _STATE["connected"] = False
                    _STATE["last_error"] = repr(exc)
            finally:
                if sock is not None:
                    try:
                        sock.close(linger=0)
                    except Exception:
                        pass
                with _STATE_LOCK:
                    _STATE["connected"] = False
            if _STOP.wait(timeout=3.0):
                break
    finally:
        try:
            ctx.term()
        except Exception:
            pass
        with _STATE_LOCK:
            _STATE["thread_alive"] = False
            _STATE["connected"] = False


def start_listener() -> None:
    """Inicia thread SUB (não bloqueante). Sem URL configurada, não faz nada."""
    global _WORKER

    url = (settings.BITCOIN_ZMQ_SUB_URL or "").strip()
    if not url:
        with _STATE_LOCK:
            _STATE["last_error"] = "BITCOIN_ZMQ_SUB_URL vazio — ZMQ desactivado (só RPC)."
        return

    if _WORKER is not None and _WORKER.is_alive():
        return

    _STOP.clear()
    _WORKER = threading.Thread(
        target=_worker_loop,
        args=(url,),
        name="corecraft-zmq-hashtx",
        daemon=True,
    )
    _WORKER.start()


def stop_listener() -> None:
    """Para a thread na descida do processo."""
    global _WORKER

    _STOP.set()
    if _WORKER is not None:
        _WORKER.join(timeout=6.0)
        _WORKER = None


def get_listener_status() -> dict[str, Any]:
    with _STATE_LOCK:
        return {
            "url_configured": bool((settings.BITCOIN_ZMQ_SUB_URL or "").strip()),
            "url": _STATE.get("url"),
            "thread_alive": bool(_STATE.get("thread_alive")),
            "connected": bool(_STATE.get("connected")),
            "last_error": _STATE.get("last_error"),
            "events_total": int(_STATE.get("events_total") or 0),
        }


def get_recent_events(limit: int) -> list[dict[str, Any]]:
    """Últimos `limit` eventos, do mais recente ao mais antigo (para UI e API)."""
    with _FEED_LOCK:
        items = list(_FEED)
    slice_ = items if limit >= len(items) else items[-limit:]
    return list(reversed(slice_))


def get_feed_length() -> int:
    """Quantos eventos estão actualmente no buffer circular ZMQ."""
    with _FEED_LOCK:
        return len(_FEED)
