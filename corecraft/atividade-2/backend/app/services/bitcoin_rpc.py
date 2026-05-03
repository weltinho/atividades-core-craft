from __future__ import annotations

from typing import Any

import httpx
from fastapi import HTTPException, status

from app.config import settings


class BitcoinRpcClient:
    """
    Cliente mínimo para conversar com o JSON-RPC do Bitcoin Core.

    Papel no sistema:
    - encapsular URL e autenticação do nó;
    - montar payloads no formato JSON-RPC 1.0;
    - traduzir falhas de rede/RPC para HTTPException (padrão do FastAPI);
    - devolver apenas o campo "result", que é o dado útil para os endpoints.
    """

    def __init__(self) -> None:
        # Endpoint RPC do bitcoind (normalmente na rede docker interna).
        self._url = f"http://{settings.BITCOIN_HOST}:{settings.BITCOIN_RPC_PORT}"
        # Credenciais definidas no .env da atividade.
        self._auth = (settings.BITCOIN_RPC_USER, settings.BITCOIN_RPC_PASSWORD)

    def call(self, method: str, params: Any | None = None) -> Any:
        """
        Executa uma chamada RPC e retorna o campo "result".

        Exemplo de uso:
            rpc.call("getbestblockhash")
            rpc.call("getblock", [block_hash, 1])
        """
        # Estrutura esperada pelo Bitcoin Core para JSON-RPC 1.0.
        payload = {
            "jsonrpc": "1.0",
            "id": "corecraft-a2",
            "method": method,
            "params": [] if params is None else params,
        }
        try:
            # Timeout curto para evitar travar endpoint quando o nó está indisponível.
            with httpx.Client(timeout=10.0) as client:
                resp = client.post(self._url, json=payload, auth=self._auth)
            data = resp.json()
        except (httpx.HTTPError, ValueError) as exc:
            # Erro de transporte (rede, DNS, timeout) ou resposta não-JSON.
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"bitcoin_rpc_unavailable: {exc}",
            ) from exc

        # Erro de aplicação retornado pelo próprio Bitcoin Core.
        rpc_error = data.get("error")
        if rpc_error:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"bitcoin_rpc_error: {rpc_error}",
            )
        # Erro HTTP puro (proxy/rede/servidor).
        if resp.status_code >= 400:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"bitcoin_rpc_http_error: status={resp.status_code}",
            )
        # Caminho de sucesso: somente o conteúdo útil para o chamador.
        return data.get("result")
