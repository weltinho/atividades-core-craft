# CoreCraft — Monorepo de atividades

## Estrutura

```
corecraft/
├── docker-compose.yml      # bitcoind + caddy (raiz)
├── .env.example            # variáveis da infra da raiz
├── infra/
│   ├── bitcoin/bitcoin.conf
│   └── caddy/Caddyfile
├── docs/
│   └── CADDY.md
├── atividade-1/            # backend + frontend + compose de app
├── atividade-2/
└── atividade-3/
```

Na **raiz** ficam **Bitcoin Core** (`bitcoind`) e **Caddy** (`caddy`), com rede Docker nomeada **`corecraft`**. Cada **`atividade-n/`** contém só **`backend/`**, **`frontend/`**, `docker-compose.yml`, `README.md` e `.env.example`; os serviços de app ligam-se à rede externa `corecraft` para falar com o `bitcoind` e para o Caddy fazer `reverse_proxy` pelos nomes dos contentores.

## Índice das atividades

| Pasta | Descrição |
|-------|------------|
| [atividade-1](./atividade-1/) | Esqueleto app (health API + página Vite) |
| [atividade-2](./atividade-2/) | Idem, portas distintas |
| [atividade-3](./atividade-3/) | Idem, portas distintas |

## Arranque (ordem)

1. **Infra na raiz** (cria a rede `corecraft`, o `bitcoind` e o `caddy`):

   ```bash
   cd corecraft
   cp .env.example .env   # opcional; há defaults no compose
   docker compose up -d
   ```

2. **Cada atividade** (requer a rede `corecraft` já criada pelo passo 1):

   ```bash
   cd atividade-1
   cp .env.example .env
   docker compose up -d --build
   ```

Repetir o passo 2 para `atividade-2` e `atividade-3` quando precisares.

### Porta 80 (ou 443) já ocupada no host

Se aparecer `Bind for 0.0.0.0:80 failed: port is already allocated`, no `.env` da raiz usa portas alternativas e o URL de redirect HTTPS (ver comentários em [`.env.example`](./.env.example)). Exemplo:

- `CADDY_HTTP_PORT=8080`, `CADDY_HTTPS_PORT=8443`, `CADDY_REDIRECT_BASE=https://localhost:8443`
- Depois: `https://localhost:8443/a1/` (e `docker compose up -d` outra vez na raiz).

**“Too many redirects”:** (1) o Caddyfile preserva `Host` do browser para o Vite; (2) o **frontend** não pode usar `handle_path` no prefixo `/aN/` — o Vite com `base: /aN/` precisa de receber `/aN/...` no path (no repo usa-se `handle /aN/*` sem strip); (3) com HTTP na 8080, define `CADDY_REDIRECT_BASE` com a porta HTTPS certa (ex. `https://localhost:8443`).

## Bitcoin Core (signet por defeito)

O ficheiro [infra/bitcoin/bitcoin.conf](./infra/bitcoin/bitcoin.conf) usa **signet** (RPC **38332**, P2P **38333**). O nó sincroniza a signet pública (muito mais leve que mainnet). Credenciais vêm de `BITCOIN_RPC_USER` / `BITCOIN_RPC_PASSWORD` no **`.env` da raiz** (e espelhadas no `.env` de cada atividade).

Para **regtest** ou **mainnet**, substitui o `bitcoin.conf`, ajusta portas no `docker-compose.yml` da raiz e alinha `BITCOIN_RPC_PORT` / `BITCOIN_NETWORK` nos `.env` das atividades. Se mudares de rede com o mesmo volume, pode ser preciso limpar o datadir (`docker compose down -v` na raiz — apaga dados Bitcoin).

Volumes (referência oficial): `bitcoin.conf` montado em `/bitcoin/bitcoin.conf:ro` e volume nomeado em **`/home/bitcoin/.bitcoin`**.

## Caddy (raiz)

Imagem **`caddy:2.8`**, volumes `caddy-data:/data`, `caddy-config:/config`, Caddyfile em [infra/caddy/Caddyfile](./infra/caddy/Caddyfile). Variáveis típicas (ver [`.env.example`](./.env.example)):

- `CADDY_SITE_ADDRESSES` — ex.: `localhost`; na EC2 incluir IP público se acederes por `https://IP`.
- `CADDY_DEFAULT_SNI` — útil para clientes sem SNI ao usar IPv4.

Path-based **`/a1`**, **`/a2`**, **`/a3`**: exemplos adicionais e notas em [docs/CADDY.md](./docs/CADDY.md).

## Portas por atividade (host)

| Atividade | Backend (host→container) | Frontend (host→container) | Prefixo Caddy |
|-----------|---------------------------|----------------------------|---------------|
| atividade-1 | 8101→8000 | 5174→5173 | `/a1` |
| atividade-2 | 8102→8000 | 5175→5173 | `/a2` |
| atividade-3 | 8103→8000 | 5176→5173 | `/a3` |

Na rede **`corecraft`**, o Caddy usa os nomes **`corecraft-aN-backend`** e **`corecraft-aN-frontend`** (sem depender destas portas no host).

## Como testar

- **API direta no host:** `curl -sS http://127.0.0.1:8101/health` (8102 / 8103 para as outras).
- **UI direta no host:** `http://127.0.0.1:5174` (etc.).
- **Via Caddy (TLS interno):** `curl -k https://localhost/a1/api/health` (com as três atividades no ar).

## Validação dos compose

```bash
cd corecraft && docker compose config >/dev/null && echo "raiz OK"
for d in atividade-1 atividade-2 atividade-3; do
  (cd "$d" && docker compose config >/dev/null && echo "$d OK") || echo "$d FAIL"
done
```

Nota: `docker compose up` nas atividades **falha** se a rede `corecraft` ainda não existir; cria-a com o compose da raiz primeiro.

## Referência técnica (stack “bitcoin-coder”)

- **bitcoind:** `bitcoin/bitcoin:31.0`, `restart: unless-stopped`, comando com `-conf`, `-printtoconsole`, `-rpcuser` / `-rpcpassword`.
- **Backend:** `python:3.12-slim`, `uvicorn app.main:app`, porta **8000**.
- **Frontend:** `node:20-alpine`, Vite `--host 0.0.0.0 --port 5173`, proxy `/api` e `/ws` para o serviço `backend`.
- **Caddy:** `handle_path` remove o prefixo `/api` antes do proxy, alinhado ao rewrite do Vite.
