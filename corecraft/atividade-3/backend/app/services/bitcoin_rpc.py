from __future__ import annotations

from typing import Any

import httpx
from fastapi import HTTPException, status

from app.config import settings


def _explain_bitcoin_rpc_error(method: str, rpc_error: Any) -> tuple[str, str]:
    """
    Retorna (explicacao_pt, sugestao_pt) para o operador do lab entender o erro do Core.
    """
    msg = ""
    rpc_code: int | None = None
    if isinstance(rpc_error, dict):
        msg = str(rpc_error.get("message") or "")
        c = rpc_error.get("code")
        if isinstance(c, int):
            rpc_code = c
    m = msg.lower()

    # Antes de "insufficient funds": "insufficient fee" contém "insufficient" mas é regra de mempool/RBF (-26).
    if (
        "insufficient fee" in m
        or "rejecting replacement" in m
        or ("replacement" in m and "fee" in m)
        or ("additional fee" in m and "relay" in m)
    ):
        return (
            f'O método RPC "{method}" recusou aceitar a transação na mempool: '
            "conflito com uma transação já presente (substituição BIP125 / RBF) ou taxa demasiado baixa face à política do node. "
            f'Detalhe do Core: {msg}',
            "Se repetiu o mesmo envio: o UTXO pode já estar gasto numa tx anterior (mempool ou bloco). "
            "Aumente `fee_rate_sat_vb` para um *bump* válido, aguarde confirmação da tx anterior, ou escolha outros UTXOs em listunspent.",
        )

    if "insufficient funds" in m or "not enough funds" in m or "insufficient money" in m:
        return (
            f'O método RPC "{method}" falhou: fundos insuficientes nos UTXOs disponíveis '
            "para cobrir o valor de saída e a taxa (com seleção manual de inputs, nenhuma moeda extra é adicionada).",
            "Some o valor dos txid:vout escolhidos (listunspent) e compare com amount_btc + taxa; "
            "aumente os inputs, reduza o montante ou a taxa, ou remova `inputs` para a wallet escolher moedas.",
        )

    if "invalid amount" in m:
        if rpc_code == -3:
            return (
                f'O método RPC "{method}" devolveu Invalid amount com código -3 (RPC_TYPE_ERROR): '
                "no Core isso costuma ser falha ao **interpretar o número** (ParseFixedPoint), não falta de saldo. "
                "Ex.: JSON com montante em **notação científica** (`1e-05`), ou `fee_rate` na **unidade errada** "
                "(em `walletcreatefundedpsbt`, `fee_rate` é sat/vB; `feeRate` é BTC/kvB).",
                "O backend envia montantes em BTC e fee_rate em sat/vB como strings decimais. Se o erro persistir, "
                "verifique dust/troco e soma dos inputs.",
            )
        return (
            f'O método RPC "{method}" recusou um montante: pode ser incompatível com os inputs '
            "(soma menor que envio+taxa), troco abaixo do dust, ou valor inválido para o tipo de saída.",
            "Confira o amount de cada input em listunspent; envie menos BTC ou use inputs maiores / mais UTXOs.",
        )

    if "fee" in m and ("high" in m or "exceed" in m or "maximum" in m):
        return (
            f'O método RPC "{method}" falhou por limite de taxa ou taxa incompatível.',
            "Reduza fee_rate_sat_vb ou ajuste fallbackfee/minrelaytxfee no node, conforme o caso.",
        )

    if "dust" in m or "amount too small" in m:
        return (
            f'O método RPC "{method}" falhou: valor de saída abaixo do limite de dust (ou troco seria dust).',
            "Aumente o montante enviado (tipicamente ≥ ~546 sats para P2PKH ou ~294 sats para witness), "
            "ou ajuste inputs/taxa para permitir troco gastável.",
        )

    if "missing" in m and "input" in m:
        return (
            f'O método RPC "{method}" não encontrou ou não pôde usar um dos inputs informados.',
            "Confirme txid, vout e se o UTXO pertence à wallet ativa e ainda está em listunspent.",
        )

    if msg:
        return (
            f'Erro do Bitcoin Core no RPC "{method}": {msg}',
            "Veja rpc_error.code e a documentação do método no bitcoin-cli help.",
        )

    return (
        f'Erro JSON-RPC sem mensagem clara no método "{method}".',
        "Inspecione o objeto rpc_error abaixo.",
    )


class BitcoinRpcClient:
    """
    Cliente RPC com dois contextos:
    - node RPC (sem wallet no path)
    - wallet RPC (/wallet/<wallet_name>)
    """

    def __init__(self) -> None:
        self._base_url = f"http://{settings.BITCOIN_HOST}:{settings.BITCOIN_RPC_PORT}"
        self._auth = (settings.BITCOIN_RPC_USER, settings.BITCOIN_RPC_PASSWORD)

    def call(self, method: str, params: Any | None = None, wallet: str | None = None) -> Any:
        """
        Executa método JSON-RPC no contexto global do node ou da wallet.
        """
        url = self._base_url if not wallet else f"{self._base_url}/wallet/{wallet}"
        payload = {
            "jsonrpc": "1.0",
            "id": "corecraft-a3",
            "method": method,
            "params": [] if params is None else params,
        }
        try:
            with httpx.Client(timeout=10.0) as client:
                response = client.post(url, json=payload, auth=self._auth)
            body = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"bitcoin_rpc_unavailable: {exc}",
            ) from exc

        rpc_error = body.get("error")
        if rpc_error:
            # O bitcoind frequentemente responde HTTP 500 junto com erro JSON-RPC.
            # Mantemos os detalhes completos para o frontend mostrar o motivo real.
            explicacao_pt, sugestao_pt = _explain_bitcoin_rpc_error(method, rpc_error)
            rpc_msg = ""
            rpc_code = None
            if isinstance(rpc_error, dict):
                rpc_msg = str(rpc_error.get("message") or "")
                rpc_code = rpc_error.get("code")
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail={
                    "type": "bitcoin_rpc_error",
                    "method": method,
                    "wallet": wallet,
                    "http_status": response.status_code,
                    "rpc_error": rpc_error,
                    "rpc_error_code": rpc_code,
                    "rpc_error_message": rpc_msg,
                    "explicacao_pt": explicacao_pt,
                    "sugestao_pt": sugestao_pt,
                },
            )

        if response.status_code >= 400:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail={
                    "type": "bitcoin_rpc_http_error",
                    "method": method,
                    "wallet": wallet,
                    "http_status": response.status_code,
                    "body": body,
                    "explicacao_pt": "O bitcoind devolveu HTTP de erro; o corpo pode não ser um JSON-RPC válido.",
                    "sugestao_pt": "Confira RPC user/senha, porta, wallet carregada e se o método existe (bitcoin-cli help).",
                },
            )
        return body.get("result")

    def call_soft(self, method: str, params: Any | None = None, wallet: str | None = None) -> tuple[Any | None, dict | None]:
        """
        Igual a `call`, mas devolve (None, rpc_error) em erro JSON-RPC em vez de HTTPException.

        Útil para padrões «tentar N wallets» (ex.: `gettransaction` no filtro ZMQ): -5 «não é desta wallet»
        não deve abortar o pedido HTTP inteiro.
        """
        url = self._base_url if not wallet else f"{self._base_url}/wallet/{wallet}"
        payload = {
            "jsonrpc": "1.0",
            "id": "corecraft-a3",
            "method": method,
            "params": [] if params is None else params,
        }
        try:
            with httpx.Client(timeout=10.0) as client:
                response = client.post(url, json=payload, auth=self._auth)
            body = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"bitcoin_rpc_unavailable: {exc}",
            ) from exc

        rpc_error = body.get("error")
        if rpc_error:
            err = rpc_error if isinstance(rpc_error, dict) else {"message": str(rpc_error)}
            return (None, err)

        if response.status_code >= 400:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail={
                    "type": "bitcoin_rpc_http_error",
                    "method": method,
                    "wallet": wallet,
                    "http_status": response.status_code,
                    "body": body,
                    "explicacao_pt": "O bitcoind devolveu HTTP de erro; o corpo pode não ser um JSON-RPC válido.",
                    "sugestao_pt": "Confira RPC user/senha, porta, wallet carregada e se o método existe (bitcoin-cli help).",
                },
            )
        return (body.get("result"), None)
