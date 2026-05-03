#!/usr/bin/env bash
# macOS — mesmo fluxo que montar-ambiente-linux.sh (Docker Desktop + Compose v2).
# Executar na raiz: corecraft/
# Uso: ./montar-ambiente-mac.sh
#       ./montar-ambiente-mac.sh --todas-atividades
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$ROOT/montar-ambiente-linux.sh" "$@"
