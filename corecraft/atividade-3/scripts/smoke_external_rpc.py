#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any


@dataclass
class CheckResult:
    name: str
    ok: bool
    detail: str


def http_json(method: str, url: str, body: dict[str, Any] | None = None) -> tuple[int, Any]:
    payload = None
    headers = {"Accept": "application/json"}
    if body is not None:
        payload = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url=url, method=method, headers=headers, data=payload)
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            status = response.getcode()
            raw = response.read().decode("utf-8")
            parsed = json.loads(raw) if raw else {}
            return status, parsed
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8")
        try:
            parsed = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            parsed = {"raw": raw}
        return exc.code, parsed


def add_result(results: list[CheckResult], name: str, ok: bool, detail: str) -> None:
    results.append(CheckResult(name=name, ok=ok, detail=detail))


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Smoke test de acessibilidade externa dos endpoints RPC da Atividade 3."
    )
    parser.add_argument(
        "--base-url",
        default="http://127.0.0.1:8103",
        help="URL base exposta externamente (ex.: http://SEU_IP:8103 ou http://localhost:8103).",
    )
    parser.add_argument(
        "--with-write",
        action="store_true",
        help="Inclui chamadas que alteram estado (ex.: gerar novo endereço).",
    )
    args = parser.parse_args()

    base = args.base_url.rstrip("/")
    results: list[CheckResult] = []

    # 1) Health da API
    status, body = http_json("GET", f"{base}/health")
    add_result(results, "GET /health", status == 200 and body.get("status") == "ok", f"status={status} body={body}")

    # 2) Wallets (usa listwalletdir/listwallets internamente)
    status, body = http_json("GET", f"{base}/wallets")
    wallets_ok = status == 200 and isinstance(body.get("available_wallets"), list) and isinstance(body.get("loaded_wallets"), list)
    add_result(results, "GET /wallets", wallets_ok, f"status={status} body={body}")

    selected_wallet = body.get("selected_wallet") if isinstance(body, dict) else None
    available_wallets = body.get("available_wallets", []) if isinstance(body, dict) else []
    first_wallet = available_wallets[0] if available_wallets else None

    # 3) Seleção de wallet (se houver pelo menos uma)
    if first_wallet:
        status, select_body = http_json("POST", f"{base}/wallet/select", {"wallet": first_wallet})
        select_ok = status == 200 and select_body.get("selected_wallet") == first_wallet
        add_result(results, "POST /wallet/select", select_ok, f"status={status} body={select_body}")
        selected_wallet = first_wallet
    else:
        add_result(results, "POST /wallet/select", False, "sem wallets disponíveis no node para validar seleção")

    # 4) Status da wallet (usa getwalletinfo/listunspent internamente)
    status, body = http_json("GET", f"{base}/wallet/status")
    ub = body.get("utxo_balances")
    uc = body.get("utxo_counts")
    wallet_status_ok = (
        status == 200
        and isinstance(body.get("wallet"), str)
        and isinstance(ub, dict)
        and all(k in ub for k in ("total_btc", "confirmed_btc", "unconfirmed_btc"))
        and isinstance(uc, dict)
        and all(k in uc for k in ("total", "confirmed", "unconfirmed"))
        and "balance" in body
        and "utxos" in body
    )
    add_result(results, "GET /wallet/status", wallet_status_ok, f"status={status} body={body}")

    # 4b) Lista de UTXOs (listunspent)
    status, body = http_json("GET", f"{base}/wallet/utxos")
    wallet_utxos_ok = (
        status == 200
        and isinstance(body.get("wallet"), str)
        and isinstance(body.get("utxos"), list)
        and body.get("filter") == "all"
    )
    add_result(results, "GET /wallet/utxos", wallet_utxos_ok, f"status={status} body={body}")

    # 5) Histórico de tx acompanhadas
    status, body = http_json("GET", f"{base}/tx/history")
    tx_history_ok = status == 200 and isinstance(body.get("items"), list)
    add_result(results, "GET /tx/history", tx_history_ok, f"status={status} body={body}")

    # 6) Escrita opcional: gerar novo endereço da wallet selecionada
    if args.with_write:
        status, body = http_json("POST", f"{base}/wallet/address/new")
        address_ok = status == 200 and isinstance(body.get("address"), str) and body.get("wallet")
        add_result(results, "POST /wallet/address/new", address_ok, f"status={status} body={body}")
    else:
        add_result(results, "POST /wallet/address/new", True, "SKIPPED (--with-write não informado)")

    print("\n=== Smoke Test: External RPC Accessibility (Atividade 3) ===")
    print(f"base_url: {base}")
    print(f"selected_wallet: {selected_wallet}")
    print()

    failed = 0
    for item in results:
        marker = "PASS" if item.ok else "FAIL"
        print(f"[{marker}] {item.name}")
        if not item.ok:
            failed += 1
        print(f"       {item.detail}")

    print()
    if failed:
        print(f"Resultado: {failed} falha(s).")
        return 1

    print("Resultado: todos os checks passaram.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
