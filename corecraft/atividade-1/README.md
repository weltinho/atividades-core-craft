# Atividade 1 — CoreCraft

Stack: **FastAPI** (8000 no container) + **Vite/React** (5173). No host: **8101** (API), **5174** (UI).

## Pré-requisito

Na raiz **`corecraft/`**, sobe primeiro o compose de infra (**bitcoind** + **caddy**), que cria a rede Docker **`corecraft`**:

```bash
cd ..
docker compose up -d
```

## Arranque desta atividade

```bash
cp .env.example .env
docker compose up -d --build
```

## Testes

```bash
curl -sS http://127.0.0.1:8101/health
```

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
