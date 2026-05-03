# CoreCraft — Monorepo de Atividades

Monorepo no formato CoreCraft com infra compartilhada na raiz e apps por atividade.

## Montagem do ambiente (primeiro passo)

Na pasta **`corecraft/`** (Docker + Docker Compose v2). Os `.env` da raiz e de cada atividade vêm **no repositório** com defaults de Signet/laboratório.

### Opção A — `docker compose` manual

```bash
cd corecraft
docker compose up -d
```

### Opção B — scripts na raiz `corecraft/`

- **Linux:** `./montar-ambiente-linux.sh`
- **macOS:** `./montar-ambiente-mac.sh` (equivalente: chama o mesmo fluxo que o script Linux)
- **Windows (CMD na pasta `corecraft`):** `montar-ambiente-windows.bat`

Equivalem ao `docker compose up -d` da raiz (bitcoind + caddy).

### Opcional — subir também as três atividades

```bash
./montar-ambiente-linux.sh --todas-atividades
./montar-ambiente-mac.sh --todas-atividades
montar-ambiente-windows.bat --todas-atividades
```

Se não usaste `--todas-atividades`, sobe cada app quando precisares:

```bash
cd atividade-1   # ou atividade-2, atividade-3
docker compose up -d --build
```

### Acessar no navegador

- Home (HTTP): `http://localhost/`
- Atividade 1 (HTTP): `http://localhost/a1/`
- Opcional HTTPS: `https://localhost:8443/` e `https://localhost:8443/a1/`

## Estrutura

```text
corecraft/
├── docker-compose.yml      # infra compartilhada: bitcoind + caddy
├── .env                    # defaults da infra (commitado, Signet/lab)
├── montar-ambiente-linux.sh
├── montar-ambiente-mac.sh
├── montar-ambiente-windows.bat
├── infra/
│   ├── bitcoin/bitcoin.conf
│   └── caddy/Caddyfile
├── docs/
│   └── CADDY.md
├── atividade-1/
├── atividade-2/
└── atividade-3/
```

Cada `atividade-n/` contém `backend/`, `frontend/`, ficheiros Docker Compose, `README` e `.env` commitados no repositório. **O que cada atividade faz, como testar e a referência de endpoints** estão em `atividade-1/README.md`, `atividade-2/README.md` e `atividade-3/README.md`.

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
docker compose up -d
```

(ou `./montar-ambiente-linux.sh` / `./montar-ambiente-mac.sh` / `montar-ambiente-windows.bat`.)

### 3) Subir uma atividade (ex.: atividade 1)

```bash
cd atividade-1
docker compose up -d --build
```

Repita para `atividade-2` e `atividade-3` quando necessário, ou use na raiz `--todas-atividades` nos scripts acima.

Smoke rápido da infra: `cd corecraft && docker compose ps`.

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
