# Atividade 1 — CoreCraft

Stack: **FastAPI** (8000 no container) + **Vite/React** (5173). No host: **8101** (API), **5174** (UI).

## O que esta atividade faz

API e UI ligadas ao **Bitcoin Core** (Signet por defeito) para:

- **Mempool** — resumo com estatísticas de taxas (classificação low/medium/high e agregação a partir de `getrawmempool` verbose + `getmempoolinfo`).
- **Sincronização** — atraso / lag da blockchain (`/blockchain/lag`).
- **Wallet de laboratório** — no arranque, o backend tenta carregar ou criar a wallet de teste (`BITCOIN_TEST_WALLET`, default `testwallet`), expõe estado e endereço para funding via **faucet Signet**, e permite refrescar contexto e enviar uma **tx de teste** (`/mempool/send-test-tx`).
- **Config de diagnóstico** — `GET /config/bitcoin-stub` expõe parâmetros de rede/URL sem chamar o RPC.

URLs típicas: API **`http://HOST:8101/...`** ou atrás do Caddy **`http://HOST/a1/api/...`** (o prefixo `/api` vem do reverse proxy).

## Montagem do ambiente (primeiro passo)

1. Na raiz **`corecraft/`**, sobe **infra + todas as atividades** (rede Docker **`corecraft`**, bitcoind, caddy, a1, a2, a3):

   ```bash
   cd ..
   ./montar-ambiente-linux.sh
   ```

   Ou: `./montar-ambiente-mac.sh` (macOS) / `montar-ambiente-windows.bat` (Windows) na mesma pasta `corecraft/`.

2. **Opcional** — só rebuild desta stack (a partir desta pasta `atividade-1/`, após alterar código):

   ```bash
   docker compose up -d --build
   ```

O **`.env`** desta atividade está no repositório (defaults Signet/lab).

## Testes

### Backend (porta directa no host)

```bash
curl -sS http://127.0.0.1:8101/health
curl -sS http://127.0.0.1:8101/mempool/summary | jq
curl -sS http://127.0.0.1:8101/blockchain/lag | jq
```

### Via Caddy (infra na raiz `corecraft/`)

```bash
curl -sS http://localhost/a1/api/health
curl -sS http://localhost/a1/api/mempool/summary | jq
curl -sS http://localhost/a1/api/blockchain/lag | jq
```

### Wallet de laboratório

```bash
curl -sS http://127.0.0.1:8101/wallet/test/status | jq
curl -sS -X POST http://127.0.0.1:8101/wallet/test/refresh | jq
curl -sS -X POST http://127.0.0.1:8101/mempool/send-test-tx -H 'Content-Type: application/json' -d '{}' | jq
```

Em **signet**, fundos vêm de faucet (não há mint local como no regtest).

### Frontend

- Abrir `http://localhost/a1/` (ou HTTPS na porta configurada no Caddy).
- Verificar cards de mempool/sync, saldo da wallet de teste e painel `RPC RESPONSE`.
- Home com links para atividades: `http://localhost/home`.

Frontend **direto no host** (compose define `VITE_PUBLIC_BASE=/a1`): usa o mesmo prefixo que o Caddy — **`http://127.0.0.1:5174/a1/`** (não a raiz `/`).

Com Caddy (infra na raiz): **`https://localhost:8443/a1/`** e `curl -k https://localhost:8443/a1/api/test`

Para correr o Vite **sem** prefixo (só `http://127.0.0.1:5173/`), remove ou comenta `VITE_PUBLIC_BASE` no `docker-compose.yml` do frontend.

O **HMR** (hot reload WebSocket) fica **desligado** por defeito no Docker (`VITE_DISABLE_HMR=1`) porque atrás do Caddy com `handle_path /a1` o cliente Vite entra em **“too many retries”**. Atualiza a página manualmente após mudar código. Para tentar HMR (pode voltar a falhar): no `docker-compose.yml` ou `.env` da atividade, `VITE_DISABLE_HMR=0`.

Se a página em branco atrás do Caddy persistir, recria o frontend e reinicia o Caddy (novos headers `X-Forwarded-*`):

```bash
cd corecraft && docker compose up -d --force-recreate caddy
cd atividade-1 && docker compose up -d --build frontend
```

## Variáveis `.env`

Alinhadas ao `bitcoind` do compose da raiz: **`BITCOIN_HOST=bitcoind`**, **`BITCOIN_RPC_PORT=38332`**, **`BITCOIN_NETWORK=signet`**, e as mesmas credenciais RPC que no `.env` da raiz.

Para os testes de mempool, o backend cria/carrega automaticamente a wallet de laboratório (`BITCOIN_TEST_WALLET`, default `testwallet`) no startup.  
Em **signet** não há mint local de saldo: usa `GET /wallet/test/status` para obter o `funding_address` e enviar fundos de faucet; depois `POST /mempool/send-test-tx`.

## Referência de endpoints

Quando a API está exposta (porta directa ou Caddy), tudo o que estiver listado fica acessível a quem tiver URL e rede.

| Método | Caminho | Notas |
|--------|---------|--------|
| `GET` | `/health` | Healthcheck |
| `GET` | `/test` | Rota de teste |
| `GET` | `/wallet/test/status` | Estado da wallet de laboratório |
| `POST` | `/wallet/test/refresh` | **Escrita** — refresca contexto de teste |
| `POST` | `/mempool/send-test-tx` | **Escrita** — envia tx de teste (Signet) |
| `GET` | `/mempool/summary` | Resumo da mempool |
| `GET` | `/blockchain/lag` | Atraso / sincronização |
| `GET` | `/config/bitcoin-stub` | Lê `.env` exposto (sem RPC) |

**Segurança:** em laboratório local os defaults Signet são aceitáveis. Se a API ficar **na Internet**, restringe acesso (firewall, VPN, auth à frente do Caddy) e **roda credenciais**.
