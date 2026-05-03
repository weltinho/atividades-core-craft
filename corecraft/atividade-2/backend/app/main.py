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
    """Converte payload binário em hash hex (formato Bitcoin, little-endian)."""
    return hashlib.sha256(hashlib.sha256(payload).digest()).digest()[::-1].hex()


def _little_endian_hash_to_hex(payload: bytes) -> str:
    """Converte hash binário little-endian para representação hex legível."""
    return payload[::-1].hex()


class EventBuffer:
    """
    Camada de estado derivado da Aula 02:
    - Entrada: eventos ZMQ (rawtx, hashblock/rawblock)
    - Interpretação: extração de txid/hash + timestamp local
    - Saída: buffers de últimos eventos e resumos consultáveis por API
    """

    def __init__(self, maxlen: int) -> None:
        """Inicializa buffers limitados para armazenar últimos eventos observados."""
        # Buffers limitados em memória (deque) para blocos e transações.
        self._blocks: deque[dict[str, Any]] = deque(maxlen=maxlen)
        self._txs: deque[dict[str, Any]] = deque(maxlen=maxlen)
        self._last_event_time: float | None = None
        self._lock = threading.Lock()

    def append_block_event(self, block_hash: str, ts: float) -> None:
        """Registra um novo evento de bloco com hash e timestamp."""
        with self._lock:
            self._blocks.append({"hash": block_hash, "ts": ts})
            self._last_event_time = ts

    def append_tx_event(self, txid: str, ts: float) -> None:
        """Registra um novo evento de transação com txid e timestamp."""
        with self._lock:
            self._txs.append({"txid": txid, "ts": ts})
            self._last_event_time = ts

    def get_latest_events(self, limit: int) -> dict[str, list[dict[str, Any]]]:
        """Retorna os últimos N blocos e N transações do buffer."""
        with self._lock:
            blocks = list(self._blocks)[-limit:]
            txs = list(self._txs)[-limit:]
        return {"blocks": blocks, "txs": txs}

    def get_recent_activity_summary(self, window_seconds: int) -> dict[str, int | float | None]:
        """
        Resumo da atividade recente (item 2 da tarefa):
        - blocos e tx observados na janela
        - timestamp do último evento
        - taxa de tx por segundo
        """
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

    def get_last_seen_block_hash(self) -> str | None:
        """Retorna o hash do último bloco visto via ZMQ (ou None se vazio)."""
        with self._lock:
            if not self._blocks:
                return None
            return str(self._blocks[-1]["hash"])


event_buffer = EventBuffer(settings.EVENTS_BUFFER_SIZE)
zmq_listener_stop = threading.Event()
zmq_runtime_state: dict[str, Any] = {"running": False, "last_error": None}


def zmq_listener() -> None:
    """
    Worker de consumo ZMQ:
    assina tópicos de bloco/tx e alimenta a camada de estado derivado.
    """
    context = zmq.Context.instance()
    socket = context.socket(zmq.SUB)
    socket.setsockopt(zmq.SUBSCRIBE, b"hashblock")
    socket.setsockopt(zmq.SUBSCRIBE, b"rawblock")
    socket.setsockopt(zmq.SUBSCRIBE, b"rawtx")
    socket.connect(settings.BITCOIN_ZMQ_BLOCK)
    socket.connect(settings.BITCOIN_ZMQ_TX)

    poller = zmq.Poller()
    poller.register(socket, zmq.POLLIN)
    zmq_runtime_state["running"] = True

    try:
        while not zmq_listener_stop.is_set():
            polled_events = dict(poller.poll(timeout=1000))
            if socket not in polled_events:
                continue

            message_parts = socket.recv_multipart()
            if len(message_parts) < 2:
                continue

            topic, payload = message_parts[0], message_parts[1]
            ts = time.time()
            if topic == b"hashblock" and len(payload) == 32:
                block_hash = _little_endian_hash_to_hex(payload)
                event_buffer.append_block_event(block_hash, ts)
            elif topic == b"rawblock" and len(payload) >= 80:
                block_hash = _double_sha256_hex(payload[:80])
                event_buffer.append_block_event(block_hash, ts)
            elif topic == b"rawtx":
                txid = _double_sha256_hex(payload)
                event_buffer.append_tx_event(txid, ts)
    except Exception as exc:  # noqa: BLE001
        zmq_runtime_state["last_error"] = str(exc)
    finally:
        zmq_runtime_state["running"] = False
        socket.close(0)


@app.on_event("startup")
def startup() -> None:
    """Sobe a thread de consumo ZMQ quando a API inicia."""
    # Inicializa o fluxo de eventos em background.
    zmq_listener_stop.clear()
    thread = threading.Thread(target=zmq_listener, name="a2-zmq-listener", daemon=True)
    thread.start()


@app.on_event("shutdown")
def shutdown() -> None:
    """Solicita parada do worker ZMQ no encerramento da API."""
    zmq_listener_stop.set()


@app.get("/health")
def health() -> dict[str, Any]:
    """Healthcheck simples da API com estado do listener ZMQ."""
    return {
        "status": "ok",
        "activity": "atividade-2",
        "zmq": zmq_runtime_state,
    }


@app.get("/events/summary")
def events_summary() -> dict[str, Any]:
    """Resumo de atividade recente: contagem por janela + taxa de eventos."""
    payload = event_buffer.get_recent_activity_summary(settings.EVENTS_WINDOW_SECONDS)
    payload["window_seconds"] = settings.EVENTS_WINDOW_SECONDS
    payload["zmq"] = zmq_runtime_state
    return payload


@app.get("/events/latest")
def events_latest() -> dict[str, Any]:
    """Lista os eventos mais recentes (blocos e transações) do buffer."""
    latest = event_buffer.get_latest_events(settings.EVENTS_LATEST_LIMIT)
    latest["limit"] = settings.EVENTS_LATEST_LIMIT
    return latest


@app.get("/events/state-comparison")
def events_state_comparison() -> dict[str, Any]:
    """
    Compara fluxo observado (ZMQ) com estado atual (RPC).

    divergence=True indica que o último bloco visto em eventos
    ainda não coincide com o best block retornado pelo RPC.
    """
    # Item 4 da tarefa: comparação explícita entre estado RPC e fluxo ZMQ.
    best_block = rpc.call("getbestblockhash")
    last_seen_block = event_buffer.get_last_seen_block_hash()
    divergence = bool(last_seen_block and best_block != last_seen_block)
    return {
        "best_block": str(best_block),
        "last_seen_block": last_seen_block,
        "divergence": divergence,
    }


@app.get("/config/bitcoin-stub")
def bitcoin_config_stub() -> dict[str, str | int]:
    """Expõe configuração básica do nó para depuração/inspeção rápida."""
    return {
        "host": settings.BITCOIN_HOST,
        "rpc_port": settings.BITCOIN_RPC_PORT,
        "network": settings.BITCOIN_NETWORK,
    }
