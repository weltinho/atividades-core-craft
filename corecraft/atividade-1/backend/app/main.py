from fastapi import FastAPI

from app.config import settings

app = FastAPI(title="CoreCraft Atividade 1", version="0.1.0")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "activity": "atividade-1"}


@app.get("/test")
def test_ping() -> dict[str, bool | str]:
    """Resposta simples para o front de teste (proxy Vite: /api/test → aqui)."""
    return {"ok": True, "from": "atividade-1-backend", "hint": "Chamada via /api/test no browser"}


@app.get("/config/bitcoin-stub")
def bitcoin_config_stub() -> dict[str, str | int]:
    """Exponde leitura de env (sem chamar o RPC). Útil para validar .env."""
    return {
        "host": settings.BITCOIN_HOST,
        "rpc_port": settings.BITCOIN_RPC_PORT,
        "network": settings.BITCOIN_NETWORK,
    }
