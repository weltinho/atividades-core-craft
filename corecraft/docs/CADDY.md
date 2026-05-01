# Caddy no monorepo CoreCraft

O serviço **Caddy** é definido na raiz em [../docker-compose.yml](../docker-compose.yml) e usa o ficheiro [../infra/caddy/Caddyfile](../infra/caddy/Caddyfile). Os exemplos abaixo servem para afinar ou para replicar noutro Caddy à parte.

## Convenção path-based

Prefixos **`/a1`**, **`/a2`**, **`/a3`**. O FastAPI expõe rotas na raiz (`/health`, …); com `handle_path /aN/api/*` o Caddy **remove** `/aN/api` antes do proxy — o upstream vê `/health` para `https://host/a1/api/health`.

## Upstreams na rede Docker `corecraft`

Com as atividades no ar, o Caddyfile da raiz usa nomes de contentor:

| Atividade | API (upstream) | UI (upstream) |
|-----------|----------------|----------------|
| 1 | `corecraft-a1-backend:8000` | `corecraft-a1-frontend:5173` |
| 2 | `corecraft-a2-backend:8000` | `corecraft-a2-frontend:5173` |
| 3 | `corecraft-a3-backend:8000` | `corecraft-a3-frontend:5173` |

## Acesso direto por portas no host (sem DNS Docker)

| Atividade | Backend | Frontend |
|-----------|---------|----------|
| 1 | 127.0.0.1:8101 | 127.0.0.1:5174 |
| 2 | 127.0.0.1:8102 | 127.0.0.1:5175 |
| 3 | 127.0.0.1:8103 | 127.0.0.1:5176 |

Exemplo equivalente no Caddyfile (substituir os `reverse_proxy` por IP:porta se o Caddy **não** estiver na mesma rede que os contentores):

```caddyfile
handle_path /a1/api/* {
	reverse_proxy 127.0.0.1:8101
}
handle_path /a1/* {
	reverse_proxy 127.0.0.1:5174
}
```

## Bloco global (referência)

```caddyfile
{
	default_sni {$CADDY_DEFAULT_SNI:localhost}
}
```

## Redirecionamento HTTP → HTTPS

```caddyfile
:80 {
	redir https://{host}{uri}
}
```

## Site com TLS interno (laboratório)

```caddyfile
{$CADDY_SITE_ADDRESSES} {
	tls internal
	# handles por atividade — ver Caddyfile na raiz do repo
}
```

## Modelo — um hostname por atividade

```caddyfile
a1.example.com {
	tls internal
	handle_path /api/* {
		reverse_proxy 127.0.0.1:8101
	}
	handle /ws/* {
		reverse_proxy 127.0.0.1:8101
	}
	handle {
		reverse_proxy 127.0.0.1:5174
	}
}
```

## Alinhamento com Vite (dev no container)

O Vite faz proxy de `/api` → `http://backend:8000` com rewrite que remove `/api`. No Caddy, **`handle_path /aN/api/*`** continua a ir para o backend (prefixo removido). Para o **frontend** Vite com `base: /aN/`, usa-se **`handle /aN/*`** **sem** strip: o upstream tem de ver caminhos `/aN/...`; com `handle_path` o Vite recebia `/` e respondia com redirect para `/aN/` → **ERR_TOO_MANY_REDIRECTS**.

## Variáveis de ambiente

- `CADDY_SITE_ADDRESSES` — endereço do bloco do site (ex.: `localhost` ou lista conforme documentação Caddy).
- `CADDY_DEFAULT_SNI` — para `curl`/clientes sem SNI em IPv4.

## Bitcoin Core

O `bitcoind` do monorepo está no compose da raiz; imagem **`bitcoin/bitcoin:31.0`**. RPC **signet** na rede interna: **38332** (ver `bitcoin.conf`).
