from statistics import fmean

from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel

from app.config import settings
from app.services.bitcoin_rpc import BitcoinRpcClient

app = FastAPI(title="CoreCraft Atividade 1", version="0.1.0")
rpc = BitcoinRpcClient()
funding_address: str | None = None


#Request para enviar uma transação de teste
class SendTestTxRequest(BaseModel):
    address: str | None = None
    amount: float | None = None

DEFAULT_THRESHOLD_PERCENT = 70.0


def classify_fee_rate_fixed(rate: float, weighted_center: float, threshold_percent: float) -> str:
    # Converte o limiar percentual em banda absoluta em torno do centro.
    # Ex.: centro=10 e limiar=70% -> banda=7 -> low<3 e high>17.
    band = weighted_center * (threshold_percent / 100)
    low_cut = weighted_center - band
    high_cut = weighted_center + band

    # Classificação final da taxa em relação aos dois cortes.
    if rate < low_cut:
        return "low"
    if rate > high_cut:
        return "high"
    return "medium"


def proximity_weighted_mean(sorted_values: list[float]) -> float:
    """
    Média ponderada por densidade local:
    valores com vizinhos mais próximos recebem mais peso.
    """
    # Sem valores, não há média para calcular.
    if not sorted_values:
        return 0.0
    # Com um valor único, a média ponderada é o próprio valor.
    if len(sorted_values) == 1:
        return sorted_values[0]

    # epsilon evita divisão por zero quando dois pontos são idênticos.
    # max_weight evita peso infinito em clusters muito colados.
    epsilon = 1e-6
    max_weight = 1_000_000.0
    weights: list[float] = []
    for index, value in enumerate(sorted_values):
        # Distância para o vizinho à esquerda (ou à direita se estiver na borda).
        left_gap = abs(value - sorted_values[index - 1]) if index > 0 else abs(sorted_values[index + 1] - value)
        # Distância para o vizinho à direita (ou à esquerda se estiver na borda).
        right_gap = (
            abs(sorted_values[index + 1] - value)
            if index < len(sorted_values) - 1
            else abs(value - sorted_values[index - 1])
        )
        # Usa a menor distância local como sinal de "densidade":
        # quanto menor o gap, mais representativo esse valor é no cluster.
        local_gap = min(left_gap, right_gap)
        # Peso inversamente proporcional ao gap local (com limites de segurança).
        density_weight = min(1.0 / (local_gap + epsilon), max_weight)
        weights.append(density_weight)

    # fmean com weights aplica a média ponderada final.
    return fmean(sorted_values, weights=weights)


#Tentar carregar a wallet de teste, se não existir, criar uma nova
#Bem simples só com loadwallet e createwallet
def ensure_test_wallet() -> None:
    global funding_address
    wallet = settings.BITCOIN_TEST_WALLET
    wallets = rpc.call("listwallets") or []
    if wallet not in wallets:
        try:
            rpc.call("loadwallet", [wallet])
        except HTTPException:
            rpc.call("createwallet", [wallet, False, False, "", False, True, True])
    funding_address = get_or_create_funding_address(wallet)

#obter ou criar o endereço de funding
def get_or_create_funding_address(wallet: str) -> str:
    label = settings.BITCOIN_TEST_FUNDING_LABEL
    index = max(settings.BITCOIN_TEST_FUNDING_INDEX, 0)

    labels = rpc.call_wallet(wallet, "listlabels") or []
    addresses: list[str] = []
    if label in labels:
        by_label = rpc.call_wallet(wallet, "getaddressesbylabel", [label]) or {}
        addresses = sorted(by_label.keys())

    # Garante endereço estável por índice: se faltar, gera até alcançar.
    while len(addresses) <= index:
        new_address = rpc.call_wallet(wallet, "getnewaddress", [label, "bech32"])
        addresses.append(str(new_address))
        addresses = sorted(set(addresses))

    return addresses[index]

#status da wallet de teste
def wallet_status_payload() -> dict[str, str | float | dict[str, object]]:
    wallet = settings.BITCOIN_TEST_WALLET
    if not funding_address:
        ensure_test_wallet()
    balances = rpc.call_wallet(wallet, "getbalances") or {}
    mine = balances.get("mine", {})
    trusted = float(mine.get("trusted", 0.0) or 0.0)
    pending = float(mine.get("untrusted_pending", 0.0) or 0.0)
    return {
        "wallet": wallet,
        "network": settings.BITCOIN_NETWORK,
        "balance_btc": round(trusted + pending, 8),
        "balance_confirmed_btc": round(trusted, 8),
        "balance_pending_btc": round(pending, 8),
        "funding_address": funding_address or "",
        "hint": "Envie fundos signet para funding_address (faucet) para habilitar sendtoaddress.",
        "rpc_raw": {"getbalances": balances},
    }

#inicialização da API
@app.on_event("startup")
def startup_init() -> None:
    # Não bloquear o startup da API; se o node ainda estiver a subir, tentamos depois nos endpoints.
    try:
        ensure_test_wallet()
    except HTTPException:
        return


#health check para verificar se o backend está funcionando
@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "activity": "atividade-1"}

#teste para verificar se o frontend está funcionando
@app.get("/test")
def test_ping() -> dict[str, bool | str]:
    """Resposta simples para o front de teste (proxy Vite: /api/test → aqui)."""
    return {"ok": True, "from": "atividade-1-backend", "hint": "Chamada via /api/test no browser"}

#status da wallet de teste
@app.get("/wallet/test/status")
def wallet_test_status() -> dict[str, str | float | dict[str, object]]:
    return wallet_status_payload()


@app.post("/wallet/test/refresh")
def wallet_test_refresh() -> dict[str, str | float | dict[str, object]]:
    # Força uma rodada RPC quando o usuário clicar em "Atualizar carteira".
    return wallet_status_payload()

#Endpoint para enviar uma transação de teste, vai ser util pra ver tudo atualizando no frontend
@app.post("/mempool/send-test-tx")
def send_test_tx(payload: SendTestTxRequest) -> dict[str, str | float | dict[str, object]]:
    wallet = settings.BITCOIN_TEST_WALLET
    if not funding_address: #Se o endereço de funding não existir, criar uma nova wallet de teste
        ensure_test_wallet()

    target = payload.address or rpc.call_wallet(wallet, "getnewaddress", ["corecraft-test-destination", "bech32"])
    amount = payload.amount if payload.amount is not None else settings.BITCOIN_TEST_AMOUNT_BTC

    try:
        txid = rpc.call_wallet(
            wallet,
            "sendtoaddress",
            {
                "address": target,
                "amount": amount,
                "comment": "corecraft-test-tx",
                "comment_to": "corecraft-test-tx",
                "fee_rate": settings.BITCOIN_TEST_FEE_RATE,
            },
        )
    except HTTPException as exc:
        detail = str(exc.detail)
        if "Insufficient funds" in detail or "insufficient funds" in detail:
            raise HTTPException(
                status_code=400,
                detail={
                    "error": "insufficient_funds",
                    "funding_address": funding_address,
                    "message": "Sem saldo na testwallet. Envie fundos signet para o endereço de funding.",
                },
            ) from exc
        raise

    return {
        "wallet": wallet,
        "txid": str(txid),
        "to": target,
        "amount_btc": amount,
        "rpc_raw": {"sendtoaddress": txid},
    }

#Endpoint para obter o resumo do mempool
@app.get("/mempool/summary")
def mempool_summary(
    threshold_percent: float = Query(DEFAULT_THRESHOLD_PERCENT, ge=0.0),
) -> dict[str, int | float | dict[str, int] | dict[str, object] | dict[str, float | str]]:
    mempool_info = rpc.call("getmempoolinfo") #Utilizando a função getmempoolinfo para obter informações do mempool
    raw_mempool = rpc.call("getrawmempool", [True]) #Utilizando a função getrawmempool para obter as transações do mempool

    fee_rates: list[float] = []
    total_fee_sats = 0.0
    total_vsize = 0 #Inicializando o tamanho total do mempool
    distribution = {"low": 0, "medium": 0, "high": 0} #Inicializando a distribuição das taxas de fee

    for tx in raw_mempool.values(): #Iterando sobre as transações do mempool
        vsize = int(tx.get("vsize", 0) or 0)
        fee_btc = float(tx.get("fees", {}).get("base", 0) or 0) #Obtendo a taxa de fee da transação
        fee_sats = fee_btc * 100_000_000
        if vsize <= 0:
            continue
        total_vsize += vsize
        total_fee_sats += fee_sats
        fee_rate = fee_sats / vsize #Calculando a taxa de fee
        fee_rates.append(fee_rate) #Adicionando a taxa de fee à lista

    tx_count = int(mempool_info.get("size", len(raw_mempool)))
    if not fee_rates:
        return { #Retornando o resumo do mempool
            "tx_count": tx_count,
            "total_vsize": total_vsize,
            "total_fee_sats": 0.0,
            "avg_fee_rate": 0.0,
            "min_fee_rate": 0.0, #Retornando a taxa de fee mínima
            "max_fee_rate": 0.0, #Retornando a taxa de fee máxima
            "fee_distribution": distribution, #Retornando a distribuição das taxas de fee
            "fee_distribution_rule": {
                "strategy": "media_ponderada_por_proximidade",
                "threshold_percent": threshold_percent,
                "weighted_center": 0.0,
                "low_cut": 0.0,
                "high_cut": 0.0,
            },
            "rpc_raw": {
                "getmempoolinfo": mempool_info, #Retornando as informações do mempool
                "getrawmempool_true": raw_mempool, #Retornando as transações do mempool
            },
        }

    sorted_fee_rates = sorted(fee_rates)
    avg_fee_rate = proximity_weighted_mean(sorted_fee_rates)
    band = avg_fee_rate * (threshold_percent / 100)
    low_cut = avg_fee_rate - band
    high_cut = avg_fee_rate + band
    for fee_rate in fee_rates:
        distribution[classify_fee_rate_fixed(fee_rate, avg_fee_rate, threshold_percent)] += 1

    return {
        "tx_count": tx_count, #Retornando o número de transações do mempool
        "total_vsize": total_vsize,
        "total_fee_sats": round(total_fee_sats, 2),
        "avg_fee_rate": round(avg_fee_rate, 2), #Retornando a taxa de fee média
        "min_fee_rate": round(min(fee_rates), 2), #Retornando a taxa de fee mínima
        "max_fee_rate": round(max(fee_rates), 2), #Retornando a taxa de fee máxima
        "fee_distribution": distribution, #Retornando a distribuição das taxas de fee
        "fee_distribution_rule": {
            "strategy": "media_ponderada_por_proximidade",
            "threshold_percent": threshold_percent,
            "weighted_center": round(avg_fee_rate, 2),
            "low_cut": round(low_cut, 2),
            "high_cut": round(high_cut, 2),
        },
        "rpc_raw": {
            "getmempoolinfo": mempool_info, #Retornando as informações do mempool
            "getrawmempool_true": raw_mempool, #Retornando as transações do mempool
        },
    }


#Endpoint para verificar a lag da blockchain
@app.get("/blockchain/lag")
def blockchain_lag() -> dict[str, int | dict[str, object]]:
    info = rpc.call("getblockchaininfo") #Utilizando a função getblockchaininfo para obter informações da blockchain
    blocks = int(info.get("blocks", 0)) #Obtendo o número de blocos
    headers = int(info.get("headers", 0)) #Obtendo o número de headers
    return {
        "blocks": blocks, #Retornando o número de blocos
        "headers": headers, #Retornando o número de headers
        "lag": max(headers - blocks, 0), #Retornando a lag da blockchain(headers - blocks)
        "rpc_raw": {"getblockchaininfo": info},
    }


#Endpoint para obter a configuração do Bitcoin(host, rpc_port, network)
@app.get("/config/bitcoin-stub")
def bitcoin_config_stub() -> dict[str, str | int]: #Retornando a configuração do Bitcoin
    return {
        "host": settings.BITCOIN_HOST, #Retornando o host do Bitcoin
        "rpc_port": settings.BITCOIN_RPC_PORT, #Retornando a porta do RPC do Bitcoin
        "network": settings.BITCOIN_NETWORK, #Retornando a rede do Bitcoin
    }
