#!/usr/bin/env bash
# Executar na raiz do repositório: corecraft/
# Uso: ./montar-ambiente-linux.sh
#       ./montar-ambiente-linux.sh --todas-atividades   # também sobe a1, a2 e a3
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

echo "==> Infra partilhada (bitcoind + caddy)"
docker compose up -d

if [[ "${1:-}" == "--todas-atividades" ]]; then
  for d in atividade-1 atividade-2 atividade-3; do
    echo "==> ${d}"
    (cd "${ROOT}/${d}" && docker compose up -d --build)
  done
  echo ""
  echo "Pronto: infra + atividades 1–3."
else
  echo ""
  echo "Infra no ar. Para subir também as stacks das atividades: $0 --todas-atividades"
  echo "Ou, manualmente: cd atividade-n && docker compose up -d --build"
fi
