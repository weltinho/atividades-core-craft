# CoreCraft — Monorepo de Atividades

Monorepo no formato CoreCraft com infra compartilhada na raiz e apps por atividade.

## Instruções mais básicas para rodar

### 1) Subir infra da raiz

```bash
cd corecraft
cp .env.example .env
docker compose up -d
```

### 2) Subir uma atividade (ex.: atividade-1)

```bash
cd atividade-1
cp .env.example .env
docker compose up -d --build
```

### 3) Acessar no navegador

- Home: `https://localhost:8443/`
- Atividade 1: `https://localhost:8443/a1/`

## Estrutura

```text
corecraft/
├── docker-compose.yml      # infra compartilhada: bitcoind + caddy
├── .env.example            # variáveis da infra da raiz
├── infra/
│   ├── bitcoin/bitcoin.conf
│   └── caddy/Caddyfile
├── docs/
│   └── CADDY.md
├── atividade-1/
├── atividade-2/
└── atividade-3/
```

Cada `atividade-n/` contém somente app (`backend`, `frontend`, compose da atividade, README e `.env.example`).

## Arquitetura

- **Camada de infra (raiz)**
  - `bitcoind` (`bitcoin/bitcoin:31.0`) em signet por padrão
  - `caddy` (`caddy:2.8`) para TLS + reverse proxy
  - rede Docker nomeada `corecraft`
- **Camada de aplicação (por atividade)**
  - `backend` FastAPI (porta 8000 no container)
  - `frontend` Vite/React (porta 5173 no container)
  - serviços entram na rede `corecraft` para falar com `bitcoind` e `caddy`

Fluxo de tráfego (exemplo atividade 1):
`browser -> caddy -> frontend/backend da atividade -> bitcoind (RPC)`

## Portas e roteamento

| Atividade | Backend (host→container) | Frontend (host→container) | Prefixo no Caddy |
|-----------|---------------------------|----------------------------|------------------|
| atividade-1 | 8101→8000 | 5174→5173 | `/a1` |
| atividade-2 | 8102→8000 | 5175→5173 | `/a2` |
| atividade-3 | 8103→8000 | 5176→5173 | `/a3` |

## Setup do zero (passo a passo)

### 1) Pré-requisitos

- Docker + Docker Compose v2
- Portas de host livres conforme `.env` da raiz (`CADDY_HTTP_PORT`, `CADDY_HTTPS_PORT`, etc.)

### 2) Subir infra compartilhada (raiz)

```bash
cd corecraft
cp .env.example .env
docker compose up -d
```

### 3) Subir uma atividade (ex.: atividade 1)

```bash
cd atividade-1
cp .env.example .env
docker compose up -d --build
```

Repita para `atividade-2` e `atividade-3` quando necessário.

## Testes básicos (smoke test)

### Infra

```bash
cd corecraft
docker compose ps
```

### Atividade 1 — backend direto

```bash
curl -sS http://127.0.0.1:8101/health
curl -sS http://127.0.0.1:8101/mempool/summary | jq
curl -sS http://127.0.0.1:8101/blockchain/lag | jq
```

### Atividade 1 — via Caddy

```bash
curl -k -sS https://localhost:8443/a1/api/health
curl -k -sS https://localhost:8443/a1/api/mempool/summary | jq
curl -k -sS https://localhost:8443/a1/api/blockchain/lag | jq
```

### Frontend

- Abrir `https://localhost:8443/a1/`
- Verificar cards de mempool/sync, saldo da wallet de teste e painel `RPC RESPONSE`
- Home simples com links para atividades: `https://localhost:8443/home`

## Testes da wallet de laboratório (atividade 1)

```bash
curl -sS http://127.0.0.1:8101/wallet/test/status | jq
curl -sS -X POST http://127.0.0.1:8101/wallet/test/refresh | jq
curl -sS -X POST http://127.0.0.1:8101/mempool/send-test-tx -H 'Content-Type: application/json' -d '{}' | jq
```

Observação: em signet, fundos vêm de faucet (não há mint local como no regtest).

## Validação dos compose

```bash
cd corecraft && docker compose config >/dev/null && echo "raiz OK"
for d in atividade-1 atividade-2 atividade-3; do
  (cd "$d" && docker compose config >/dev/null && echo "$d OK") || echo "$d FAIL"
done
```

## Referência técnica usada

- `bitcoind`: `bitcoin/bitcoin:31.0`
- backend: `python:3.12-slim`
- frontend: `node:20-alpine`
- caddy: `caddy:2.8`
