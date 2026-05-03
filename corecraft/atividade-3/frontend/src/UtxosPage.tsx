import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

type Theme = "light" | "dark";
type UtxoRow = Record<string, unknown>;

const THEME_KEY = "corecraft-theme-a3";

/** Referência no formato dos campos UTXO do painel (PSBT / sendraw): `txid:vout`. */
function utxoSendrawRef(row: UtxoRow): string | null {
  const txid = row.txid;
  const vout = row.vout;
  if (typeof txid !== "string" || txid.length < 10) return null;
  if (typeof vout !== "number" || !Number.isInteger(vout) || vout < 0) return null;
  return `${txid}:${String(vout)}`;
}

function formatApiError(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback;
  if ("detail" in payload) {
    const detail = (payload as { detail?: unknown }).detail;
    if (typeof detail === "string") return detail;
    if (detail && typeof detail === "object") {
      return JSON.stringify(detail, null, 2);
    }
  }
  return fallback;
}

export default function UtxosPage() {
  const [searchParams] = useSearchParams();
  const utxoFilter = useMemo((): "all" | "confirmed" | "unconfirmed" => {
    const f = searchParams.get("filter");
    if (f === "confirmed" || f === "unconfirmed") return f;
    return "all";
  }, [searchParams]);

  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [wallet, setWallet] = useState<string>("--");
  const [rows, setRows] = useState<UtxoRow[]>([]);
  const [appliedFilter, setAppliedFilter] = useState<string>("all");
  const [copiedSendrawKey, setCopiedSendrawKey] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = utxoFilter === "all" ? "" : `?filter=${encodeURIComponent(utxoFilter)}`;
      const response = await fetch(`${import.meta.env.BASE_URL}api/wallet/utxos${qs}`);
      const payload = (await response.json()) as {
        wallet?: string;
        utxos?: unknown;
        filter?: string;
        detail?: unknown;
      };
      if (!response.ok) {
        throw new Error(formatApiError(payload, "Falha ao carregar UTXOs"));
      }
      setWallet(String(payload.wallet ?? "--"));
      setAppliedFilter(String(payload.filter ?? utxoFilter));
      setRows(Array.isArray(payload.utxos) ? (payload.utxos as UtxoRow[]) : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro inesperado");
    } finally {
      setLoading(false);
    }
  }, [utxoFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  const statusClass = useMemo(() => {
    if (loading) return "status";
    return error ? "status status-error" : "status status-ok";
  }, [loading, error]);

  const filterDescription = useMemo(() => {
    if (utxoFilter === "confirmed") return "Somente UTXOs com ≥1 confirmação na chain.";
    if (utxoFilter === "unconfirmed") return "Somente UTXOs com 0 confirmações (mempool).";
    return "Todos os UTXOs retornados pelo listunspent.";
  }, [utxoFilter]);

  const apiPathLabel = useMemo(() => {
    const base = `${import.meta.env.BASE_URL}api/wallet/utxos`;
    return utxoFilter === "all" ? base : `${base}?filter=${utxoFilter}`;
  }, [utxoFilter]);

  const copySendrawSlot = useCallback(async (ref: string, rowKey: string) => {
    setCopyNotice(null);
    try {
      await navigator.clipboard.writeText(ref);
      setCopiedSendrawKey(rowKey);
      window.setTimeout(() => {
        setCopiedSendrawKey((current) => (current === rowKey ? null : current));
      }, 2000);
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = ref;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        setCopiedSendrawKey(rowKey);
        window.setTimeout(() => {
          setCopiedSendrawKey((current) => (current === rowKey ? null : current));
        }, 2000);
      } catch {
        setCopyNotice("Não foi possível copiar para a área de transferência.");
        window.setTimeout(() => setCopyNotice(null), 4000);
      }
    }
  }, []);

  return (
    <main className="layout">
      <header className="header">
        <div className="brand">
          <div className="brand-logo" aria-hidden>
            <span className="brand-logo-symbol">₿</span>
          </div>
          <h1 className="title">CoreCraft — Atividade 3 · UTXOs</h1>
        </div>
        <div className="actions">
          <button
            className="theme-toggle"
            type="button"
            aria-label={theme === "light" ? "Ativar tema escuro" : "Ativar tema claro"}
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          >
            {theme === "light" ? "🌙" : "☀️"}
          </button>
        </div>
      </header>

      <div className="toolbar">
        <a className="btn btn-subtle" href="/home">
          ← Voltar para Home
        </a>
        <div className="inline-row" style={{ flexWrap: "wrap", gap: "8px" }}>
          <Link className="btn btn-subtle" to="/">
            ← Voltar ao painel
          </Link>
          <Link className="btn btn-subtle" to="/utxos">
            Filtro: todos
          </Link>
          <Link className="btn btn-subtle" to="/utxos?filter=confirmed">
            Filtro: confirmados
          </Link>
          <Link className="btn btn-subtle" to="/utxos?filter=unconfirmed">
            Filtro: mempool
          </Link>
          <Link className="btn btn-subtle" to="/zmq" target="_blank" rel="noreferrer">
            Feed ZMQ (nova aba)
          </Link>
          <button className="btn btn-primary" type="button" onClick={() => void load()}>
            Atualizar UTXOs
          </button>
        </div>
      </div>

      <section className="card">
        <h2>UTXOs da wallet selecionada</h2>
        <p className="muted">
          Fonte: <code>{apiPathLabel}</code> (RPC <code>listunspent</code>).
        </p>
        <p className="muted">Filtro ativo (API): <code>{appliedFilter}</code> — {filterDescription}</p>
        <p className={statusClass}>{loading ? "carregando..." : error ? `erro: ${error}` : "ok"}</p>
        <p className="muted">
          Wallet: <code>{wallet}</code> · Exibindo: <code>{rows.length}</code>
        </p>
        <p className="muted" style={{ marginTop: 0 }}>
          Em cada UTXO: use <strong>Copiar para sendraw</strong> para obter <code>txid:vout</code> e colar nos campos
          UTXO do painel (modo PSBT / <code>sendrawtransaction</code>).
        </p>
        {copyNotice ? (
          <p className="status status-error" role="status">
            {copyNotice}
          </p>
        ) : null}

        <div className="code-box" style={{ maxHeight: "520px" }}>
          {rows.length === 0 && !loading && !error && "Nenhum UTXO retornado pelo listunspent."}
          {rows.map((row, index) => {
            const sendrawRef = utxoSendrawRef(row);
            const rowKey = sendrawRef ?? `${String(row.txid)}-${String(row.vout)}-${String(index)}`;
            return (
              <div key={rowKey} style={{ marginBottom: "12px" }}>
                {sendrawRef ? (
                  <div className="inline-row" style={{ flexWrap: "wrap", gap: "8px", marginBottom: "6px" }}>
                    <button
                      type="button"
                      className="btn btn-subtle"
                      onClick={() => void copySendrawSlot(sendrawRef, rowKey)}
                    >
                      Copiar para sendraw
                    </button>
                    <code className="muted" style={{ fontSize: "0.85rem" }}>
                      {sendrawRef}
                    </code>
                    {copiedSendrawKey === rowKey ? (
                      <span className="muted" aria-live="polite">
                        Copiado.
                      </span>
                    ) : null}
                  </div>
                ) : null}
                <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(row, null, 2)}</pre>
              </div>
            );
          })}
        </div>
      </section>
    </main>
  );
}
