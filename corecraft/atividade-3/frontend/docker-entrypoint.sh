#!/bin/sh
set -eu

# Quando o bind-mount ./frontend:/app sobrescreve /app, o volume anônimo /app/node_modules
# pode ficar desatualizado em relação ao package-lock.json do host.
# Para evitar exatamente o erro "Failed to resolve import ..." após adicionar deps,
# sincronizamos node_modules com o lockfile no boot do container.
echo "[corecraft-a3-frontend] sincronizando node_modules (npm ci)..."
npm ci

exec "$@"
