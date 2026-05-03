# Atividade 3 — CoreCraft

Stack: **FastAPI** + **Vite**. Host: **8103** (API), **5176** (UI).

## O que esta atividade faz (visão geral)

Dashboard **multi-wallet** sobre o Bitcoin Core: listar e seleccionar wallets, estado da wallet activa (saldo, UTXOs), envio de transacções (fluxo simples e PSBT), histórico e **interpretação de estado** das txs (mempool, confirmações, avisos). Inclui extras de laboratório (página UTXOs, feed ZMQ `hashtx`, criar wallet, inspecção raw de tx, smoke script para API exposta). O detalhe face ao enunciado da Aula 03 está nas secções **Enunciado** e **O que este projecto cumpre** abaixo.

URLs típicas: **`http://HOST:8103/...`** ou **`http://HOST/a3/api/...`** atrás do Caddy.

## Enunciado (Mentoria — Aula 03)

Resumo do que a tarefa pedia:

1. **Multi-wallet no backend** — listar wallets (`listwalletdir` / `listwallets`), carregar se preciso (`loadwallet`), wallet activa, e usar o contexto `/wallet/<nome>` para operações de carteira vs RPC global do node.
2. **Endpoints** — `GET /wallets`, `POST /wallet/select` com resposta incluindo dados básicos da wallet.
3. **Frontend** — selector de wallet, troca de contexto sem alterar código, envio no contexto seleccionado, e lista de envios com nome da wallet.
4. **Interpretação de estado** — além do estado cru, mensagens de negócio (broadcast, mempool, confirmed, unknown) e aviso se a tx ficar demasiado tempo na mempool.
5. **`GET /tx/<txid>` enriquecido** — `txid`, `wallet`, `status`, `confirmed`, `confirmations`, `block_hash`, `age_seconds`, `message`, `warning` opcional.
6. **`GET /wallet/status`** — saldo e número de UTXOs da wallet activa; UI com indicadores antes de enviar.

*(Exposição pública via VPS/túnel fica ao cargo do aluno, conforme o enunciado.)*

## O que este projecto cumpre

| Pedido | Onde |
|--------|------|
| `GET /wallets` | `backend/app/main.py` — `available_wallets`, `loaded_wallets`, `selected_wallet` |
| `POST /wallet/select` | Valida existência, `loadwallet` se necessário, `wallet_info` (`getwalletinfo`) |
| RPC node vs wallet | `backend/app/services/bitcoin_rpc.py` — URL com ou sem `/wallet/<nome>` |
| `GET /wallet/status` | Saldo + contagem de UTXOs (`listunspent` + `getbalances`; alinhado às listas da UI) |
| `GET /tx/{txid}` enriquecido | `_interpret_tx_state`, idade desde `_track_tx`, fallback `getmempoolentry` |
| `GET /tx/history` | Txs registadas pela API com `wallet` de origem |
| Envio no contexto da wallet | `POST /tx/send` (PSBT + `sendrawtransaction`), `POST /tx/send-simple` (`sendtoaddress`) |
| Frontend | `frontend/src/Dashboard.tsx` — card de contexto, selector, histórico com `wallet` |

## Extras acrescentados durante o trabalho

O enunciado da Aula 03 não pedia isto explicitamente. Foi código **extra** que fomos acrescentando ao longo da confecção da atividade para **facilitar testes**, **reduzir tentativa-e-erro** no Signet e **deixar o comportamento do Core mais legível** quando algo falha — útil no laboratório, não uma lista de “funcionalidades obrigatórias”.

- **`POST /wallet/create`** — criar wallet no Core sem sair da UI.
- **`GET /wallet/utxos`** — listar `listunspent` com filtro (página **UTXOs**).
- **`GET /tx/{txid}/inspect`** — resumo de `getrawtransaction` (verbose) para comparar com o estado interpretado.
- **`GET /config/bitcoin-stub`** — confirmar rede / URL de explorador sem chamar o RPC.
- **PSBT com inputs manuais** (`txid:vout`) — para reproduzir cenários de funding com UTXOs conhecidos.
- **ZMQ `hashtx` + feed na API** — ver o node a anunciar txs; filtro opcional por wallets carregadas para não inundar a lista em aulas com muito tráfego de relay.
- **Mensagens de erro RPC em português** (`explicacao_pt` / `sugestao_pt`) — quando o Core devolve `-26`, dust, etc., o payload ajuda a perceber o próximo passo.
- **`scripts/smoke_external_rpc.py`** — verificar API (e opcionalmente um write leve) depois de expor por túnel ou VPN.
- **Pequenos ajustes de UI** — ZMQ numa página à parte, validações visuais no envio PSBT, modo por wallet no dashboard.

Se estiveres a avaliar só o enunciado da mentoria, podes ignorar esta secção: o núcleo continua a ser multi-wallet, estado interpretado e `/wallet/status` / `/tx/{txid}` descritos em cima.

## Montagem do ambiente (primeiro passo)

1. Na raiz **`corecraft/`**, subir **tudo** (infra + atividades 1–3):

   ```bash
   cd corecraft
   ./montar-ambiente-linux.sh
   ```

   Ou `./montar-ambiente-mac.sh` / `montar-ambiente-windows.bat` na mesma pasta.

2. **Opcional** — só rebuild desta stack: nesta pasta **`atividade-3/`**, `docker compose up -d --build`.

Os ficheiros **`.env`** na raiz `corecraft/` e aqui vêm **no repositório**.

## Testes

```bash
curl -sS http://127.0.0.1:8103/health
curl -sS http://127.0.0.1:8103/wallets | jq
```

Via Caddy (exemplo):

```bash
curl -sS http://localhost/a3/api/health
```

Frontend: `http://127.0.0.1:5176` · Caddy: `https://localhost/a3/`

### UTXOs (página dedicada)

No painel principal, use **Ver UTXOs** (ou acesse diretamente):

- `http://127.0.0.1:5176/utxos` (dev)
- `https://localhost/a3/utxos` (via Caddy)

### Se o `/a3/` quebrar com `Failed to resolve import "react-router-dom"` (Docker)

Isso acontece quando o volume anônimo `/app/node_modules` ficou **desatualizado** em relação ao `package-lock.json`.

Depois desta correção, o container do frontend roda `npm ci` no boot para sincronizar dependências.

Ainda assim, após mudar dependências, o mais seguro é rebuildar a imagem:

```bash
docker compose build --no-cache frontend
docker compose up -d frontend
```

### Smoke test automatizado (acesso externo RPC/API)

Script: `scripts/smoke_external_rpc.py` — bate na API **como se estivesse exposta** (localhost, IP da VPS ou URL por túnel). Inclui chamadas só de leitura (`GET /health`, `/wallets`, `/wallet/status`, `/wallet/utxos`, `/tx/history`, etc.) e, se existir wallet no node, `POST /wallet/select`. Com **`--with-write`** também executa `POST /wallet/address/new` (altera estado no Core).

Da pasta desta atividade:

```bash
python3 scripts/smoke_external_rpc.py --base-url http://127.0.0.1:8103
```

Com write leve:

```bash
python3 scripts/smoke_external_rpc.py --base-url http://127.0.0.1:8103 --with-write
```

Da raiz `corecraft/`:

```bash
python3 atividade-3/scripts/smoke_external_rpc.py --base-url http://127.0.0.1:8103
```

## Referência de endpoints

| Método | Caminho | Notas |
|--------|---------|--------|
| `GET` | `/health` | Healthcheck |
| `GET` | `/zmq/hashtx-feed` | Feed ZMQ + filtro opcional por query string |
| `GET` | `/wallets` | Lista wallets do node |
| `POST` | `/wallet/select` | **Escrita** — wallet activa na API |
| `POST` | `/wallet/create` | **Escrita** — cria wallet no Core |
| `GET` | `/wallet/status` | Saldo / UTXOs (RPC) |
| `GET` | `/wallet/utxos` | `listunspent` filtrado |
| `POST` | `/wallet/address/new` | **Escrita** — novo endereço |
| `POST` | `/tx/send-simple` | **Escrita** — `sendtoaddress` (troco/taxa explícitos ou inputs manuais: `POST /tx/send`) |
| `POST` | `/tx/send` | **Escrita** — PSBT + `sendrawtransaction` |
| `GET` | `/tx/history` | Histórico em memória da API |
| `GET` | `/tx/{txid}/inspect` | `getrawtransaction` (verbose) |
| `GET` | `/tx/{txid}` | Estado interpretado da tx |
| `GET` | `/config/bitcoin-stub` | Lê config exposta (sem RPC) |

**Segurança:** em laboratório local os defaults (`bitcoin`/`bitcoin` no Signet) são aceitáveis. Se a API ficar **na Internet**, restringe acesso (firewall, VPN, auth à frente do Caddy) e **roda credenciais** — o `.env` commitado é só para reprodução local.

## `.env`

Valores de Signet / `bitcoind:38332` já estão no ficheiro **`.env`** commitado.
