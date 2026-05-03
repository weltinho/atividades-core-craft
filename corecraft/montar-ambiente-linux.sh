#!/usr/bin/env bash
# Se correres com `sh este-script.sh` ou `sudo sh …`, o dash não suporta `pipefail`.
# Re-execução automática com bash (o shebang é ignorado quando o interpretador é `sh`).
if [ -z "${BASH_VERSION:-}" ]; then
  exec /usr/bin/env bash "$0" "$@"
fi
# Executar na raiz do repositório: corecraft/
# Sobe infra (bitcoind + caddy) e as stacks atividade-1 … atividade-3.
# Uso: ./montar-ambiente-linux.sh   ou   bash montar-ambiente-linux.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if [[ "${1:-}" == "--todas-atividades" ]]; then
  echo "==> Nota: --todas-atividades já não é necessário; este script sobe sempre todas as stacks."
fi

echo "==> Infra partilhada (bitcoind + caddy)"
docker compose up -d

for d in atividade-1 atividade-2 atividade-3; do
  echo "==> ${d}"
  (cd "${ROOT}/${d}" && docker compose up -d --build)
done

echo ""
echo "Pronto: infra + atividades 1–3."
