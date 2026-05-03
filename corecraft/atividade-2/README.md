# Atividade 2 — CoreCraft

Stack: **FastAPI** + **Vite**. Host: **8102** (API), **5175** (UI).

## O que esta atividade faz

Backend que **subscreve ZMQ** ao `bitcoind` (`rawtx`, blocos / hashes conforme config) e mantém **buffers em memória** dos últimos eventos. A API expõe:

- **`/events/summary`** — agregados numa janela temporal (tx/blocos observados, taxa aproximada, etc.).
- **`/events/latest`** — últimos eventos de tx e bloco com timestamp local.
- **`/events/state-comparison`** — comparação entre o último bloco visto via ZMQ e o estado consultado por **RPC** (útil para aulas sobre consistência / atraso).
- **`/config/bitcoin-stub`** — confirma rede / endpoints sem chamar o RPC pesado.

A UI consome estes endpoints para visualizar actividade em tempo quase real.

URLs típicas: **`http://HOST:8102/...`** ou **`http://HOST/a2/api/...`** atrás do Caddy.

## Montagem do ambiente (primeiro passo)

1. Na raiz **`corecraft/`**: `docker compose up -d` (rede `corecraft`, bitcoind, caddy) — ou `montar-ambiente-linux.sh`, `montar-ambiente-mac.sh` / `montar-ambiente-windows.bat` nessa pasta.

2. Nesta pasta **`atividade-2/`**: `docker compose up -d --build` (ou use na raiz o script com `--todas-atividades`).

O **`.env`** está no repositório.

## Testes

### Backend (porta directa)

```bash
curl -sS http://127.0.0.1:8102/health
curl -sS http://127.0.0.1:8102/events/summary | jq
curl -sS http://127.0.0.1:8102/events/latest | jq
curl -sS http://127.0.0.1:8102/events/state-comparison | jq
```

### Via Caddy

```bash
curl -sS http://localhost/a2/api/health
curl -sS http://localhost/a2/api/events/summary | jq
```

### Frontend

- Directo: `http://127.0.0.1:5175`
- Com Caddy: `http://localhost/a2/`

## Referência de endpoints

| Método | Caminho | Notas |
|--------|---------|--------|
| `GET` | `/health` | Healthcheck |
| `GET` | `/events/summary` | Agregados de eventos |
| `GET` | `/events/latest` | Últimos eventos |
| `GET` | `/events/state-comparison` | Comparação de estado (ZMQ vs RPC) |
| `GET` | `/config/bitcoin-stub` | Lê config exposta (sem RPC) |

**Segurança:** se a API ficar **na Internet**, restringe acesso e credenciais; o `.env` commitado é só para laboratório local.

## `.env`

Inclui RPC (`bitcoind:38332`) e ZMQ (`bitcoind:28332/28333`) para eventos em tempo real.
