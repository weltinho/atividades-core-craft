FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY tsconfig.json tsconfig.node.json ./
COPY vite.config.ts ./
COPY index.html ./
COPY docker-entrypoint.sh ./docker-entrypoint.sh
COPY src ./src

EXPOSE 5173

# Bind-mount ./frontend:/app sobrescreve /app; o script no host costuma vir sem +x → "permission denied".
# Invocar via sh não exige bit executável no volume.
ENTRYPOINT ["/bin/sh", "/app/docker-entrypoint.sh"]
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]
