# Atividade 3 — CoreCraft

Stack: **FastAPI** + **Vite**. Host: **8103** (API), **5176** (UI).

## Pré-requisito

Na raiz **`corecraft/`**: `docker compose up -d`.

## Arranque

```bash
cp .env.example .env
docker compose up -d --build
```

## Testes

```bash
curl -sS http://127.0.0.1:8103/health
```

Frontend: `http://127.0.0.1:5176` · Caddy: `https://localhost/a3/`

## `.env`

Igual às outras atividades (signet, `bitcoind:38332`).
