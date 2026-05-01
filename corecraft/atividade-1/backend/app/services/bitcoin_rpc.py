from __future__ import annotations

from typing import Any

import httpx
from fastapi import HTTPException, status

from app.config import settings


class BitcoinRpcClient:
    def __init__(self) -> None:
        self._url = f"http://{settings.BITCOIN_HOST}:{settings.BITCOIN_RPC_PORT}"
        self._auth = (settings.BITCOIN_RPC_USER, settings.BITCOIN_RPC_PASSWORD)

    def call(self, method: str, params: Any | None = None) -> Any:
        payload = {
            "jsonrpc": "1.0",
            "id": "corecraft-a1",
            "method": method,
            "params": [] if params is None else params,
        }
        try:
            with httpx.Client(timeout=10.0) as client:
                resp = client.post(self._url, json=payload, auth=self._auth)
            data = resp.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"bitcoin_rpc_unavailable: {exc}",
            ) from exc

        rpc_error = data.get("error")
        if rpc_error:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"bitcoin_rpc_error: {rpc_error}",
            )
        if resp.status_code >= 400:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"bitcoin_rpc_http_error: status={resp.status_code}",
            )
        return data.get("result")

    def call_wallet(self, wallet: str, method: str, params: Any | None = None) -> Any:
        payload = {
            "jsonrpc": "1.0",
            "id": "corecraft-a1-wallet",
            "method": method,
            "params": [] if params is None else params,
        }
        url = f"{self._url}/wallet/{wallet}"
        try:
            with httpx.Client(timeout=10.0) as client:
                resp = client.post(url, json=payload, auth=self._auth)
            data = resp.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"bitcoin_rpc_unavailable: {exc}",
            ) from exc

        rpc_error = data.get("error")
        if rpc_error:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"bitcoin_rpc_error: {rpc_error}",
            )
        if resp.status_code >= 400:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"bitcoin_rpc_http_error: status={resp.status_code}",
            )
        return data.get("result")
