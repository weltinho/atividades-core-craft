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
```

Frontend: `http://127.0.0.1:5175` · Caddy: `https://localhost/a2/`

## `.env`

Igual à atividade 1 (host `bitcoind`, signet, porta **38332**), com credenciais iguais à raiz.
