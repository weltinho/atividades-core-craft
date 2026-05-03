import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** Prefixo público atrás do Caddy (ex. /a3/). Definir no Docker: VITE_PUBLIC_BASE=/a3 */
function publicBase(): string {
  const raw = process.env.VITE_PUBLIC_BASE?.trim();
  if (!raw || raw === "/") return "/";
  return raw.endsWith("/") ? raw : `${raw}/`;
}

/** URL que o browser usa (ex. https://corecraft-welton.duckdns.org). Obrigatório atrás do Caddy + TLS. */
function devOrigin(): string | undefined {
  const o = process.env.VITE_DEV_ORIGIN?.trim();
  return o || undefined;
}

function hmrFromOrigin(origin: string) {
  try {
    const u = new URL(origin);
    const protocol = u.protocol === "https:" ? "wss" : "ws";
    const clientPort = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
    return { host: u.hostname, protocol, clientPort } as const;
  } catch {
    return { host: "localhost", protocol: "wss" as const, clientPort: 8443 };
  }
}

const base = publicBase();
const origin = devOrigin();

const disableHmr =
  process.env.VITE_DISABLE_HMR === "1" ||
  process.env.VITE_DISABLE_HMR === "true";

export default defineConfig({
  base,
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    ...(origin
      ? {
          origin,
          hmr: disableHmr ? false : hmrFromOrigin(origin),
        }
      : {}),
    proxy: {
      "/api": {
        target: "http://backend:8000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      "/ws": {
        target: "ws://backend:8000",
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
