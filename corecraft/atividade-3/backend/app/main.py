from __future__ import annotations

"""
FastAPI da Atividade 3: multi-wallet no Bitcoin Core, envio (sendtoaddress / PSBT +
sendrawtransaction) e consulta de estado de tx com camada de interpretação (mensagens PT).

Enquadramento: mentoria **Aula 03** (wallets, contexto RPC node vs /wallet/<nome>,
GET /wallet/status, GET /tx/<txid> enriquecido). Outras peças (laboratório / testes) na secção
«Extras acrescentados durante o trabalho» do README da atividade.
"""

import threading
import time
from decimal import ROUND_DOWN, Decimal
from enum import Enum
from typing import Any

from fastapi import FastAPI, HTTPException, Query, status
from pydantic import BaseModel, Field, field_validator

from app.config import settings, tx_explorer_tx_url_template
from app.services import BitcoinRpcClient
from app.services.zmq_hashtx_listener import (
    get_feed_length as zmq_feed_length,
    get_listener_status as zmq_hashtx_status,
    get_recent_events as zmq_recent_hashtx,
    start_listener as zmq_start_hashtx,
    stop_listener as zmq_stop_hashtx,
)

app = FastAPI(title="CoreCraft Atividade 3", version="0.1.0")
rpc = BitcoinRpcClient()

# Wallet activa da sessão da API (não confundir com a wallet default do bitcoind).
wallet_state: dict[str, str | None] = {"selected_wallet": None}
wallet_state_lock = threading.Lock()

# Txs criadas por esta API (send-simple / send): idade para warnings e fallback de wallet em GET /tx/{txid}.
tracked_txs: dict[str, dict[str, Any]] = {}
tracked_txs_lock = threading.Lock()

# Filtro opcional do feed ZMQ: evita N chamadas gettransaction repetidas para o mesmo txid.
_zmq_wallet_tx_cache: dict[str, tuple[float, list[str]]] = {}
_zmq_wallet_tx_cache_lock = threading.Lock()
_ZMQ_WALLET_TX_CACHE_TTL = 55.0
_ZMQ_WALLET_TX_CACHE_MAX = 800


def _zmq_wallet_tx_cache_prune_unsafe() -> None:
    """Expira entradas antigas e limita tamanho; invocar apenas com _zmq_wallet_tx_cache_lock."""
    now = time.time()
    for k, (ts, _) in list(_zmq_wallet_tx_cache.items()):
        if now - ts > _ZMQ_WALLET_TX_CACHE_TTL:
            del _zmq_wallet_tx_cache[k]
    if len(_zmq_wallet_tx_cache) > _ZMQ_WALLET_TX_CACHE_MAX:
        _zmq_wallet_tx_cache.clear()


def _wallets_that_know_tx(txid: str, loaded: list[str]) -> list[str]:
    """Wallets carregadas em que `gettransaction` reconhece a tx (relevante para essa carteira)."""
    with _zmq_wallet_tx_cache_lock:
        _zmq_wallet_tx_cache_prune_unsafe()
        cached = _zmq_wallet_tx_cache.get(txid)
        if cached is not None and time.time() - cached[0] < _ZMQ_WALLET_TX_CACHE_TTL:
            return list(cached[1])
    hits: list[str] = []
    for w in loaded:
        result, err = rpc.call_soft("gettransaction", [txid, True], wallet=w)
        if isinstance(result, dict) and result.get("txid"):
            hits.append(w)
            continue
        if err and isinstance(err, dict):
            code = err.get("code")
            msg = str(err.get("message", "")).lower()
            if code == -5 or "invalid or non-wallet" in msg or "non-wallet transaction" in msg:
                continue
    with _zmq_wallet_tx_cache_lock:
        _zmq_wallet_tx_cache_prune_unsafe()
        _zmq_wallet_tx_cache[txid] = (time.time(), hits)
    return hits


def _enrich_and_filter_zmq_events(
    events: list[dict[str, Any]],
    loaded: list[str],
    target: int,
) -> tuple[list[dict[str, Any]], int]:
    """
    Percorre `events` (mais recentes primeiro) e devolve até `target` entradas cuja tx
    seja reconhecida por `gettransaction` nalguma wallet em `loaded`.
    Segundo valor: quantos eventos ZMQ foram percorridos.
    """
    out: list[dict[str, Any]] = []
    if not loaded:
        return [], 0
    scanned = 0
    for ev in events:
        scanned += 1
        txid = ev.get("txid")
        if not isinstance(txid, str) or not txid.strip():
            continue
        wallets = _wallets_that_know_tx(txid, loaded)
        if not wallets:
            continue
        row = dict(ev)
        row["wallets_on_node"] = wallets
        out.append(row)
        if len(out) >= target:
            break
    return out, scanned


class SelectWalletBody(BaseModel):
    wallet: str = Field(min_length=1)


class CreateWalletBody(BaseModel):
    wallet: str = Field(min_length=1)


MAX_PSBT_EXPLICIT_INPUTS = 50


class UtxoInput(BaseModel):
    txid: str = Field(min_length=10)
    vout: int = Field(ge=0)


class SendTxBody(BaseModel):
    to_address: str = Field(min_length=10)
    amount_btc: float = Field(gt=0)
    fee_rate_sat_vb: float | None = Field(default=None, gt=0)
    change_address: str | None = Field(default=None, min_length=10)
    inputs: list[UtxoInput] | None = None

    @field_validator("change_address", mode="before")
    @classmethod
    def normalize_change_address(cls, value: object) -> str | None:
        if value is None:
            return None
        if isinstance(value, str) and not value.strip():
            return None
        return value  # type: ignore[return-value]

    @field_validator("inputs")
    @classmethod
    def validate_inputs_len(cls, value: list[UtxoInput] | None) -> list[UtxoInput] | None:
        if value is None:
            return value
        if len(value) > MAX_PSBT_EXPLICIT_INPUTS:
            raise ValueError(f"No máximo {MAX_PSBT_EXPLICIT_INPUTS} UTXOs podem ser seleccionados por pedido.")
        return value


def _rpc_btc_decimal_str(amount: float) -> str:
    """
    Montante em BTC como string decimal no JSON-RPC.
    O httpx serializa floats pequenos como 1e-05; o ParseFixedPoint do Core falha → Invalid amount (-3).
    """
    d = Decimal(str(amount)).quantize(Decimal("0.00000001"), rounding=ROUND_DOWN)
    return format(d, "f")


def _fee_rate_sat_vb_str(sat_vb: float) -> str:
    """
    Taxa em sat/vB como string decimal para o campo `fee_rate` do walletcreatefundedpsbt.

    No Bitcoin Core, `fee_rate` é em sat/vB; `feeRate` é que usa BTC/kvB — não confundir.
    """
    d = Decimal(str(sat_vb)).quantize(Decimal("0.00000001"), rounding=ROUND_DOWN)
    return format(d, "f")


def _listunspent_wallet(wallet: str) -> list[Any]:
    """
    listunspent com minconf=0, maxconf alto, todos os endereços e include_unsafe=true.

    - minconf=0: inclui UTXOs na mempool (troco ainda sem mineração).
    - include_unsafe=true: inclui outputs marcados como “unsafe” (ex.: troco ligado a tx
      replaceable na mempool); sem isto o Core pode omitir o troco imediato.
    """
    out = rpc.call("listunspent", [0, 9999999, [], True], wallet=wallet)
    return out if isinstance(out, list) else []


def _funding_context_explicit_inputs(
    wallet: str,
    inputs: list[UtxoInput],
    amount_btc: float,
) -> dict[str, Any]:
    """Para erros em walletcreatefundedpsbt: quanto somam os UTXOs pedidos vs amount_btc."""
    utxos_list = _listunspent_wallet(wallet)
    want = {(i.txid, i.vout) for i in inputs}
    found_amounts: dict[tuple[str, int], float] = {}
    for u in utxos_list:
        if not isinstance(u, dict):
            continue
        txid_u = u.get("txid")
        vout_u = u.get("vout")
        if txid_u is None or vout_u is None:
            continue
        key = (str(txid_u), int(vout_u))
        if key in want:
            found_amounts[key] = float(u.get("amount") or 0)
    missing = [[t, v] for (t, v) in want if (t, v) not in found_amounts]
    total = sum(found_amounts.values())
    per_input: list[dict[str, Any]] = []
    for inp in inputs:
        key = (inp.txid, inp.vout)
        per_input.append(
            {
                "txid": inp.txid,
                "vout": inp.vout,
                "amount_btc_in_wallet": found_amounts.get(key),
            }
        )
    return {
        "amount_requested_btc": amount_btc,
        "per_input": per_input,
        "explicit_inputs_sum_btc": round(total, 8) if not missing else None,
        "partial_sum_btc": round(total, 8) if missing and found_amounts else None,
        "inputs_requested": len(want),
        "inputs_found_in_wallet": len(found_amounts),
        "inputs_missing_in_wallet": missing,
    }


def _track_tx(txid: str, wallet: str, to_address: str, amount_btc: float, status_value: str = "broadcast") -> None:
    """Salva tx em memória para histórico e interpretação de estado."""
    now = time.time()
    with tracked_txs_lock:
        tracked_txs[txid] = {
            "wallet": wallet,
            "created_at": now,
            "last_status": status_value,
            "to_address": to_address,
            "amount_btc": amount_btc,
        }


def _sign_psbt_and_broadcast(wallet: str, funded: dict[str, Any]) -> str:
    """Assina na wallet e envia hex no contexto global do node (sendrawtransaction)."""
    signed = rpc.call("walletprocesspsbt", [funded["psbt"]], wallet=wallet)
    finalized = rpc.call("finalizepsbt", [signed["psbt"]], wallet=wallet)
    if not finalized.get("complete") or not finalized.get("hex"):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Não foi possível finalizar a transação (PSBT incompleta).",
        )
    return str(rpc.call("sendrawtransaction", [finalized["hex"]]))


def _list_available_wallets() -> list[str]:
    """Lista wallets existentes no node (inclui não carregadas)."""
    wallet_dir = rpc.call("listwalletdir")
    return [item["name"] for item in wallet_dir.get("wallets", [])]


def _list_loaded_wallets() -> list[str]:
    """Lista wallets atualmente carregadas em memória no bitcoind."""
    loaded = rpc.call("listwallets")
    return [str(name) for name in loaded]


def _get_selected_wallet() -> str | None:
    """Lê wallet selecionada atual em seção crítica."""
    with wallet_state_lock:
        return wallet_state["selected_wallet"]


def _set_selected_wallet(wallet: str) -> None:
    """Define wallet ativa para próximas operações wallet-scoped."""
    with wallet_state_lock:
        wallet_state["selected_wallet"] = wallet


def _ensure_wallet_loaded(wallet: str) -> None:
    """Carrega wallet caso ela exista, mas ainda não esteja loaded."""
    loaded_wallets = _list_loaded_wallets()
    if wallet in loaded_wallets:
        return
    rpc.call("loadwallet", [wallet])


def _wallet_info(wallet: str) -> dict[str, Any]:
    """Retorna resumo básico da wallet selecionada."""
    return rpc.call("getwalletinfo", wallet=wallet)


def _ensure_selected_wallet() -> str:
    """
    Garante uma wallet ativa:
    - usa selecionada se já existir
    - fallback para primeira loaded
    - fallback para primeira disponível (com load automático)
    """
    selected = _get_selected_wallet()
    if selected:
        return selected

    loaded_wallets = _list_loaded_wallets()
    if loaded_wallets:
        selected = loaded_wallets[0]
        _set_selected_wallet(selected)
        return selected

    available_wallets = _list_available_wallets()
    if not available_wallets:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Nenhuma wallet encontrada no node. Crie uma wallet antes de continuar.",
        )

    selected = available_wallets[0]
    _ensure_wallet_loaded(selected)
    _set_selected_wallet(selected)
    return selected


def _interpret_tx_state(status: str, age_seconds: int) -> tuple[str, str | None]:
    """
    Camada de negócio sobre broadcast / mempool / confirmed / unknown.

    `age_seconds` mede desde o registo local da tx (tracked_txs); em mempool, se exceder
    `settings.TX_STUCK_WARNING_SECONDS` (p.ex. 120 s), devolve aviso de demora.
    """
    if status == "broadcast":
        return "Transação enviada ao node, aguardando aceitação na mempool.", None
    if status == "mempool":
        warning = (
            "Transação está na mempool há mais de 2 minutos."
            if age_seconds >= settings.TX_STUCK_WARNING_SECONDS
            else None
        )
        return "Transação aceita na mempool, aguardando inclusão em bloco.", warning
    if status == "confirmed":
        return "Transação confirmada em bloco.", None
    return "Estado desconhecido para esta transação.", "Transação não localizada na wallet selecionada."


@app.on_event("startup")
def startup() -> None:
    """Na subida da API, tenta selecionar automaticamente uma wallet válida."""
    try:
        _ensure_selected_wallet()
    except HTTPException:
        # Ambiente pode subir sem wallet inicialmente; endpoints de wallet tratam isso.
        pass
    # Canal ZMQ opcional (hashtx), independente das consultas RPC.
    zmq_start_hashtx()


@app.on_event("shutdown")
def shutdown() -> None:
    zmq_stop_hashtx()


@app.get("/health")
def health() -> dict[str, str]:
    """Healthcheck simples da atividade."""
    return {"status": "ok", "activity": "atividade-3"}


@app.get("/zmq/hashtx-feed")
def zmq_hashtx_feed(
    limit: int = Query(50, ge=1, le=200),
    wallet_relevant_only: bool = Query(
        True,
        description=(
            "Se verdadeiro, só devolve eventos cujo txid a alguma wallet **carregada** no node reconhece "
            "(RPC gettransaction). O feed ZMQ continua global; este filtro usa RPC para isolar o que é das suas carteiras."
        ),
    ),
    scan_depth: int = Query(
        500,
        ge=50,
        le=2000,
        description="Com filtro activo: no máximo quantos eventos ZMQ recentes percorrer para compor até `limit` linhas.",
    ),
) -> dict[str, Any]:
    """
    Últimos eventos `hashtx` recebidos via ZMQ do bitcoind (canal paralelo ao RPC).

    Por defeito filtra-se por transacções que **entram ou saem** das wallets carregadas no node
    (cruzamento com `gettransaction`). Use `wallet_relevant_only=false` para ver o feed bruto do node.
    """
    listener = zmq_hashtx_status()
    buffer_len = zmq_feed_length()
    base: dict[str, Any] = {
        "channel": "zmq_hashtx",
        "listener": listener,
        "zmq_buffer_len": buffer_len,
        "nota_pt": (
            "O ZMQ `hashtx` notifica hashes de transacções que este **node** Bitcoin Core vê (mempool ou bloco), "
            "sem distinção de wallet — é tráfego global do relay/mineração."
        ),
    }

    if not wallet_relevant_only:
        base["independent_of_rpc_queries"] = True
        base["wallet_relevant_filter"] = False
        base["recent"] = zmq_recent_hashtx(limit)
        return base

    base["independent_of_rpc_queries"] = False
    base["wallet_relevant_filter"] = True
    base["wallet_filter_scan_depth"] = scan_depth
    loaded = _list_loaded_wallets()
    base["loaded_wallets_checked"] = loaded
    pool = zmq_recent_hashtx(scan_depth)

    if not loaded:
        base["recent"] = []
        base["wallet_filter_scanned_events"] = 0
        base["wallet_filter_matched"] = 0
        base["nota_filtro_wallet_pt"] = (
            "Filtro **activo**: não há wallets carregadas no bitcoind (`listwallets` vazio). "
            "Carregue ou seleccione uma wallet (no painel ou `loadwallet`) para ver aqui só transacções "
            "que essas carteiras reconhecem."
        )
        return base

    recent, scanned = _enrich_and_filter_zmq_events(pool, loaded, limit)
    base["recent"] = recent
    base["wallet_filter_scanned_events"] = scanned
    base["wallet_filter_matched"] = len(recent)
    base["nota_filtro_wallet_pt"] = (
        "Filtro **activo**: a tabela mostra só `hashtx` cujo `txid` a wallet reconhece via RPC "
        "`gettransaction` (tx que **gasta UTXOs seus** ou **paga para endereços seus**, incluindo troco e mempool). "
        f"Wallets carregadas consideradas: {', '.join(loaded)}. "
        f"Percorreram-se até {scanned} eventos ZMQ recentes (até {scan_depth} no buffer) para compor até {limit} linhas; "
        f"o buffer ZMQ tem {buffer_len} entradas. Desactive o filtro na UI para ver **todas** as tx que o node anuncia."
    )
    return base


@app.get("/wallets")
def wallets() -> dict[str, Any]:
    """Retorna wallets disponíveis, carregadas e a wallet ativa no backend."""
    available_wallets = _list_available_wallets()
    loaded_wallets = _list_loaded_wallets()
    selected_wallet = _get_selected_wallet()
    return {
        "available_wallets": available_wallets,
        "loaded_wallets": loaded_wallets,
        "selected_wallet": selected_wallet,
    }


@app.post("/wallet/select")
def wallet_select(body: SelectWalletBody) -> dict[str, Any]:
    """Seleciona wallet ativa; faz load automático se necessário."""
    wallet = body.wallet
    available_wallets = _list_available_wallets()
    if wallet not in available_wallets:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Wallet '{wallet}' não existe no node.",
        )

    _ensure_wallet_loaded(wallet)
    _set_selected_wallet(wallet)
    info = _wallet_info(wallet)
    return {
        "selected_wallet": wallet,
        "wallet_info": {
            "walletname": info.get("walletname"),
            "balance": info.get("balance"),
            "txcount": info.get("txcount"),
        },
    }


@app.post("/wallet/create")
def wallet_create(body: CreateWalletBody) -> dict[str, Any]:
    """
    Cria nova wallet no Bitcoin Core e já define como wallet ativa.

    Após criar, a wallet já fica carregada no node e pronta para uso.
    """
    wallet = body.wallet.strip()
    if not wallet:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Nome da wallet não pode ser vazio.")

    existing = _list_available_wallets()
    if wallet in existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Wallet '{wallet}' já existe.",
        )

    created = rpc.call("createwallet", [wallet])
    _set_selected_wallet(wallet)
    info = _wallet_info(wallet)
    return {
        "created_wallet": wallet,
        "selected_wallet": wallet,
        "createwallet_result": created,
        "wallet_info": {
            "walletname": info.get("walletname"),
            "balance": info.get("balance"),
            "txcount": info.get("txcount"),
        },
    }


class WalletUtxoFilter(str, Enum):
    all = "all"
    confirmed = "confirmed"
    unconfirmed = "unconfirmed"


def _utxo_counts(utxos: list[Any]) -> dict[str, int]:
    """Contagem por confirmações (0 = mempool; ≥1 = confirmado na chain)."""
    if not isinstance(utxos, list):
        return {"total": 0, "confirmed": 0, "unconfirmed": 0}
    total = len(utxos)
    confirmed = 0
    unconfirmed = 0
    for u in utxos:
        if not isinstance(u, dict):
            continue
        conf = int(u.get("confirmations") or 0)
        if conf >= 1:
            confirmed += 1
        else:
            unconfirmed += 1
    return {"total": total, "confirmed": confirmed, "unconfirmed": unconfirmed}


def _utxo_balance_breakdown(utxos: list[Any]) -> dict[str, float]:
    """Soma valores de listunspent: total, confirmado na chain (≥1 conf), mempool (0 conf)."""
    total = 0.0
    confirmed = 0.0
    unconfirmed = 0.0
    for u in utxos:
        if not isinstance(u, dict):
            continue
        amt = float(u.get("amount") or 0)
        conf = int(u.get("confirmations") or 0)
        total += amt
        if conf == 0:
            unconfirmed += amt
        else:
            confirmed += amt
    return {
        "total_btc": total,
        "confirmed_btc": confirmed,
        "unconfirmed_btc": unconfirmed,
    }


@app.get("/wallet/status")
def wallet_status() -> dict[str, Any]:
    """
    Wallet activa: saldo e contagem de UTXOs (requisito Aula 03).

    Além do mínimo pedido (`getwalletinfo`-like), expõe somatórios derivados de `listunspent`
    (confirmado vs mempool, `include_unsafe`) e `getbalances` para alinhar UI ao que o Core lista.
    """
    wallet = _ensure_selected_wallet()
    utxos_list = _listunspent_wallet(wallet)
    br = _utxo_balance_breakdown(utxos_list)
    counts = _utxo_counts(utxos_list)
    balances = rpc.call("getbalances", wallet=wallet)
    return {
        "wallet": wallet,
        # Mantido para compat (scripts): mesmo valor que utxo_balances.total_btc
        "balance": br["total_btc"],
        "utxo_balances": br,
        "balances": balances,
        "utxo_counts": counts,
        "utxos": len(utxos_list),
    }


@app.get("/wallet/utxos")
def wallet_utxos(
    utxo_filter: WalletUtxoFilter = Query(default=WalletUtxoFilter.all, alias="filter"),
) -> dict[str, Any]:
    """Lista UTXOs da wallet (listunspent). filter=confirmed | unconfirmed | all."""
    wallet = _ensure_selected_wallet()
    utxos_list: list[Any] = _listunspent_wallet(wallet)
    filtered: list[Any] = utxos_list
    if utxo_filter == WalletUtxoFilter.confirmed:
        filtered = [u for u in utxos_list if isinstance(u, dict) and int(u.get("confirmations") or 0) >= 1]
    elif utxo_filter == WalletUtxoFilter.unconfirmed:
        filtered = [u for u in utxos_list if isinstance(u, dict) and int(u.get("confirmations") or 0) == 0]
    return {"wallet": wallet, "filter": utxo_filter.value, "utxos": filtered}


@app.post("/wallet/address/new")
def wallet_new_address() -> dict[str, Any]:
    """Gera novo endereço de recebimento para a wallet selecionada."""
    wallet = _ensure_selected_wallet()
    address = str(rpc.call("getnewaddress", wallet=wallet))
    return {
        "wallet": wallet,
        "address": address,
    }


@app.post("/tx/send-simple")
def tx_send_simple(body: SendTxBody) -> dict[str, Any]:
    """
    Envia transação no contexto da wallet.

    - Sem change_address: sendtoaddress (o RPC não tem parâmetro de troco; o Core gera troco interno).
    - Com change_address: PSBT com troco explícito (útil para chamadas directas à API; na UI use POST /tx/send).
    """
    wallet = _ensure_selected_wallet()
    if not body.change_address:
        txid = str(
            rpc.call("sendtoaddress", [body.to_address, _rpc_btc_decimal_str(body.amount_btc)], wallet=wallet),
        )
        _track_tx(txid=txid, wallet=wallet, to_address=body.to_address, amount_btc=body.amount_btc)
        return {
            "txid": txid,
            "wallet": wallet,
            "status": "broadcast",
            "message": "Transação enviada via sendtoaddress.",
            "mode": "simple",
            "simple_path": "sendtoaddress",
            "change_address_requested": None,
            "change_address_used": None,
        }

    options: dict[str, Any] = {"changeAddress": body.change_address}
    if body.fee_rate_sat_vb is not None:
        options["fee_rate"] = _fee_rate_sat_vb_str(body.fee_rate_sat_vb)
    amt = _rpc_btc_decimal_str(body.amount_btc)
    funded = rpc.call(
        "walletcreatefundedpsbt",
        [[], [{body.to_address: amt}], 0, options],
        wallet=wallet,
    )
    txid = _sign_psbt_and_broadcast(wallet, funded)
    _track_tx(txid=txid, wallet=wallet, to_address=body.to_address, amount_btc=body.amount_btc)
    return {
        "txid": txid,
        "wallet": wallet,
        "status": "broadcast",
        "message": "Transação enviada (PSBT com endereço de troco explícito).",
        "mode": "simple",
        "simple_path": "psbt",
        "fee_rate_sat_vb": body.fee_rate_sat_vb,
        "change_address_requested": body.change_address,
        "change_address_used": body.change_address,
    }


@app.post("/tx/send")
def tx_send(body: SendTxBody) -> dict[str, Any]:
    """
    Cria, assina e transmite transação no contexto da wallet selecionada.

    Troco: com change_address no body, usa esse endereço; vazio → getrawchangeaddress
    na mesma wallet para o campo changeAddress do funding.

    Fluxo:
    1) walletcreatefundedpsbt (wallet)
    2) walletprocesspsbt (wallet)
    3) finalizepsbt (wallet)
    4) sendrawtransaction (node)
    """
    wallet = _ensure_selected_wallet()
    destinations = [{body.to_address: _rpc_btc_decimal_str(body.amount_btc)}]
    options: dict[str, Any] = {}
    if body.fee_rate_sat_vb is not None:
        # Bitcoin Core: opção `fee_rate` em sat/vB (string decimal; evita 1e-05 no JSON).
        options["fee_rate"] = _fee_rate_sat_vb_str(body.fee_rate_sat_vb)
    if body.change_address:
        change_used = body.change_address
        change_requested: str | None = body.change_address
    else:
        change_used = str(rpc.call("getrawchangeaddress", [], wallet=wallet))
        change_requested = None
    options["changeAddress"] = change_used

    explicit_inputs = body.inputs or []
    if explicit_inputs:
        # Seleção manual: não deixa o coin selector adicionar inputs extras.
        options["add_inputs"] = False

    funded_params: list[Any]
    if explicit_inputs:
        inputs_payload = [{"txid": item.txid, "vout": item.vout} for item in explicit_inputs]
        if options:
            funded_params = [inputs_payload, destinations, 0, options]
        else:
            funded_params = [inputs_payload, destinations]
    elif options:
        funded_params = [[], destinations, 0, options]
    else:
        funded_params = [[], destinations]

    try:
        funded = rpc.call("walletcreatefundedpsbt", funded_params, wallet=wallet)
    except HTTPException as exc:
        detail_any = exc.detail
        if isinstance(detail_any, dict) and explicit_inputs and detail_any.get("method") == "walletcreatefundedpsbt":
            detail = dict(detail_any)
            ctx = _funding_context_explicit_inputs(wallet, explicit_inputs, body.amount_btc)
            detail["funding_context"] = ctx
            if ctx.get("inputs_missing_in_wallet"):
                miss = ctx["inputs_missing_in_wallet"]
                detail["explicacao_pt"] = (
                    str(detail.get("explicacao_pt") or "")
                    + f" Estes UTXOs não aparecem na wallet ativa em listunspent: {miss}."
                ).strip()
            s = ctx.get("explicit_inputs_sum_btc")
            if s is not None and s + 1e-12 < body.amount_btc:
                detail["explicacao_pt"] = (
                    str(detail.get("explicacao_pt") or "")
                    + f" Soma dos inputs escolhidos (~{s} BTC) é menor que amount_btc ({body.amount_btc} BTC) "
                    "(sem contar taxa; a taxa exige saldo extra)."
                ).strip()
            raise HTTPException(status_code=exc.status_code, detail=detail) from exc
        raise

    txid = _sign_psbt_and_broadcast(wallet, funded)
    _track_tx(txid=txid, wallet=wallet, to_address=body.to_address, amount_btc=body.amount_btc)
    return {
        "txid": txid,
        "wallet": wallet,
        "status": "broadcast",
        "message": "Transação enviada ao node, aguardando aceitação na mempool.",
        "mode": "raw",
        "fee_rate_sat_vb": body.fee_rate_sat_vb,
        "inputs": [{"txid": item.txid, "vout": item.vout} for item in explicit_inputs],
        "change_address_requested": change_requested,
        "change_address_used": change_used,
    }


def _summarize_raw_transaction(tx: dict[str, Any]) -> dict[str, Any]:
    """Extrai de getrawtransaction (verbose) um resumo útil para UI (taxa, tamanho, vouts)."""
    vin = tx.get("vin") if isinstance(tx.get("vin"), list) else []
    vout = tx.get("vout") if isinstance(tx.get("vout"), list) else []
    vout_total = 0.0
    for out in vout:
        if isinstance(out, dict):
            vout_total += float(out.get("value") or 0)
    fee_raw = tx.get("fee")
    fee_btc: float | None = None
    if fee_raw is not None:
        # No mempool o Core devolve fee negativa em BTC.
        fee_btc = abs(float(fee_raw))
    vsize = int(tx.get("vsize") or 0)
    fee_rate: float | None = None
    if fee_btc is not None and vsize > 0:
        fee_rate = (fee_btc * 1e8) / vsize
    return {
        "txid": tx.get("txid"),
        "hash": tx.get("hash"),
        "size": tx.get("size"),
        "vsize": tx.get("vsize"),
        "weight": tx.get("weight"),
        "version": tx.get("version"),
        "locktime": tx.get("locktime"),
        "vin_count": len(vin),
        "vout_count": len(vout),
        "vout_total_btc": round(vout_total, 8),
        "fee_btc": fee_btc,
        "fee_rate_sat_vb": round(fee_rate, 4) if fee_rate is not None else None,
        "confirmations": tx.get("confirmations"),
        "blockhash": tx.get("blockhash"),
        "blocktime": tx.get("blocktime"),
        "time": tx.get("time"),
    }


@app.get("/tx/history")
def tx_history() -> dict[str, list[dict[str, Any]]]:
    """Lista transações acompanhadas pelo backend com wallet de origem."""
    with tracked_txs_lock:
        items = [
            {
                "txid": txid,
                "wallet": data.get("wallet"),
                "created_at": data.get("created_at"),
                "last_status": data.get("last_status"),
                "to_address": data.get("to_address"),
                "amount_btc": data.get("amount_btc"),
            }
            for txid, data in tracked_txs.items()
        ]
    items.sort(key=lambda item: float(item.get("created_at") or 0), reverse=True)
    return {"items": items}


@app.get("/tx/{txid}/inspect")
def tx_inspect(txid: str, include_raw: bool = False) -> dict[str, Any]:
    """
    Detalhe técnico via getrawtransaction (verbose): tamanhos, vouts, taxa (mempool), feerate.
    Requer txindex no node para txs confirmados fora da wallet.
    """
    tx = rpc.call("getrawtransaction", [txid, True])
    if not isinstance(tx, dict):
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Resposta inesperada do getrawtransaction.",
        )
    out: dict[str, Any] = {"summary": _summarize_raw_transaction(tx)}
    if include_raw:
        out["raw"] = tx
    return out


@app.get("/tx/{txid}")
def tx_status(txid: str) -> dict[str, Any]:
    """
    Estado enriquecido: campos técnicos + `message` / `warning` (Aula 03).

    Ordem: tenta `gettransaction` na wallet da tx (tracked ou activa); se falhar,
    `getmempoolentry` no node para tx ainda só na mempool global.
    """
    wallet = _ensure_selected_wallet()
    with tracked_txs_lock:
        tracked = tracked_txs.get(txid)

    created_at = float(tracked["created_at"]) if tracked else time.time()
    age_seconds = int(max(0, time.time() - created_at))
    tx_wallet = str(tracked.get("wallet")) if tracked and tracked.get("wallet") else wallet
    tx_status_value = "unknown"
    confirmations = 0
    block_hash = None
    confirmed = False

    try:
        tx_data = rpc.call("gettransaction", [txid], wallet=tx_wallet)
        confirmations = int(tx_data.get("confirmations", 0) or 0)
        block_hash = tx_data.get("blockhash")
        if confirmations > 0:
            tx_status_value = "confirmed"
            confirmed = True
        else:
            # Se está na wallet e sem confirmação, consideramos mempool.
            tx_status_value = "mempool"
    except HTTPException:
        # Pode não estar no histórico da wallet; tentamos no mempool global.
        try:
            rpc.call("getmempoolentry", [txid])
            tx_status_value = "mempool"
        except HTTPException:
            tx_status_value = "unknown"

    if tracked and tracked.get("last_status") == "broadcast" and tx_status_value in {"mempool", "confirmed"}:
        with tracked_txs_lock:
            if txid in tracked_txs:
                tracked_txs[txid]["last_status"] = tx_status_value

    message, warning = _interpret_tx_state(tx_status_value, age_seconds)
    return {
        "txid": txid,
        "wallet": tx_wallet,
        "status": tx_status_value,
        "confirmed": confirmed,
        "confirmations": confirmations,
        "block_hash": block_hash,
        "age_seconds": age_seconds,
        "message": message,
        "warning": warning,
    }


@app.get("/config/bitcoin-stub")
def bitcoin_config_stub() -> dict[str, str | int | None]:
    """Expõe leitura de env (sem chamar o RPC). Útil para validar .env."""
    return {
        "host": settings.BITCOIN_HOST,
        "rpc_port": settings.BITCOIN_RPC_PORT,
        "network": settings.BITCOIN_NETWORK,
        "tx_explorer_tx_url_template": tx_explorer_tx_url_template(),
    }
