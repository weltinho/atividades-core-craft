# Atividade 2 — CoreCraft

Stack: **FastAPI** + **Vite**. Host: **8102** (API), **5175** (UI).

## Pré-requisito

Na raiz **`corecraft/`**: `docker compose up -d` (rede `corecraft`, bitcoind, caddy).

## Arranque

```bash
cp .env.example .env
docker compose up -d --build
```

## Testes

```bash
curl -sS http://127.0.0.1:8102/health
curl -sS http://127.0.0.1:8102/events/summary | jq
curl -sS http://127.0.0.1:8102/events/latest | jq
curl -sS http://127.0.0.1:8102/events/state-comparison | jq
```

Frontend: `http://127.0.0.1:5175` · Caddy: `http://localhost/a2/`

## `.env`

Inclui RPC (`bitcoind:38332`) e ZMQ (`bitcoind:28332/28333`) para eventos em tempo real.
