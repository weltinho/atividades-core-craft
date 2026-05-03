import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

type Theme = "light" | "dark";

type ZmqListener = {
  url_configured?: boolean;
  url?: string | null;
  thread_alive?: boolean;
  connected?: boolean;
  last_error?: string | null;
  events_total?: number;
};

type ZmqHashtxEvent = {
  topic: string;
  txid: string;
  received_at: number;
  zmq_seq: number | null;
  /** Presente quando o backend filtra por wallets carregadas (`gettransaction`). */
  wallets_on_node?: string[];
};

type ZmqFeedPayload = {
  channel?: string;
  nota_pt?: string;
  nota_filtro_wallet_pt?: string;
  listener?: ZmqListener;
  recent?: ZmqHashtxEvent[];
  detail?: unknown;
  zmq_buffer_len?: number;
  wallet_relevant_filter?: boolean;
  wallet_filter_scan_depth?: number;
  wallet_filter_scanned_events?: number;
  wallet_filter_matched?: number;
  loaded_wallets_checked?: string[];
  independent_of_rpc_queries?: boolean;
};

type ZmqSortKey = "txid" | "wallets" | "zmq_seq" | "received_at";

function defaultSortDirForKey(key: ZmqSortKey): "asc" | "desc" {
  if (key === "txid" || key === "wallets") return "asc";
  return "desc";
}

const THEME_KEY = "corecraft-theme-a3";
const POLL_MS = 4000;

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

function formatTs(ts: number): string {
  try {
    return new Date(ts * 1000).toLocaleString();
  } catch {
    return String(ts);
  }
}

export default function ZmqFeedPage() {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [payload, setPayload] = useState<ZmqFeedPayload | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [limit, setLimit] = useState(80);
  const [walletRelevantOnly, setWalletRelevantOnly] = useState(true);
  const [scanDepth, setScanDepth] = useState(500);
  const [copiedTxid, setCopiedTxid] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<ZmqSortKey>("received_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const apiUrl = useMemo(() => {
    const p = new URLSearchParams();
    p.set("limit", String(limit));
    p.set("wallet_relevant_only", walletRelevantOnly ? "true" : "false");
    if (walletRelevantOnly) p.set("scan_depth", String(scanDepth));
    return `${import.meta.env.BASE_URL}api/zmq/hashtx-feed?${p.toString()}`;
  }, [limit, scanDepth, walletRelevantOnly]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(apiUrl);
      const body = (await response.json()) as ZmqFeedPayload;
      if (!response.ok) {
        throw new Error(formatApiError(body, `HTTP ${String(response.status)}`));
      }
      setPayload(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro inesperado");
    } finally {
      setLoading(false);
    }
  }, [apiUrl]);

  useEffect(() => {
    if (!walletRelevantOnly && sortKey === "wallets") {
      setSortKey("received_at");
      setSortDir("desc");
    }
  }, [walletRelevantOnly, sortKey]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(id);
  }, [autoRefresh, load]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  const statusClass = useMemo(() => {
    if (loading && !payload) return "status";
    return error ? "status status-error" : "status status-ok";
  }, [loading, error, payload]);

  const copyTxid = useCallback(async (txid: string) => {
    try {
      await navigator.clipboard.writeText(txid);
      setCopiedTxid(txid);
      window.setTimeout(() => setCopiedTxid((c) => (c === txid ? null : c)), 2000);
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = txid;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        setCopiedTxid(txid);
        window.setTimeout(() => setCopiedTxid((c) => (c === txid ? null : c)), 2000);
      } catch {
        /* ignore */
      }
    }
  }, []);

  const listener = payload?.listener;
  const walletFilter = Boolean(payload?.wallet_relevant_filter);

  const sortedRecent = useMemo(() => {
    const r = [...(payload?.recent ?? [])];
    const m = sortDir === "asc" ? 1 : -1;
    r.sort((a, b) => {
      if (sortKey === "received_at") {
        return m * ((a.received_at ?? 0) - (b.received_at ?? 0));
      }
      if (sortKey === "wallets") {
        const wa = (a.wallets_on_node ?? []).join(",");
        const wb = (b.wallets_on_node ?? []).join(",");
        return m * wa.localeCompare(wb);
      }
      if (sortKey === "zmq_seq") {
        const va = a.zmq_seq;
        const vb = b.zmq_seq;
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        return m * (va - vb);
      }
      return m * a.txid.localeCompare(b.txid);
    });
    return r;
  }, [payload?.recent, sortDir, sortKey]);

  const onSortHeaderClick = useCallback((key: ZmqSortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(defaultSortDirForKey(key));
    }
  }, [sortKey]);

  return (
    <main className="layout">
      <header className="header">
        <div className="brand">
          <div className="brand-logo" aria-hidden>
            <span className="brand-logo-symbol">₿</span>
          </div>
          <h1 className="title">CoreCraft — Atividade 3 · ZMQ hashtx</h1>
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
          <Link className="btn btn-subtle" to="/utxos" target="_blank" rel="noreferrer">
            UTXOs (nova aba)
          </Link>
          <button className="btn btn-primary" type="button" onClick={() => void load()} disabled={loading}>
            Atualizar agora
          </button>
        </div>
      </div>

      <section className="card">
        <h2>Feed ZMQ (<code>hashtx</code>)</h2>
        <p className="muted">
          Fonte: <code>{apiUrl}</code> — canal paralelo ao RPC; o ZMQ publica hashes de tx que o <strong>node</strong>{" "}
          vê (mempool/bloco). Por defeito a tabela abaixo só lista tx que as <strong>wallets carregadas</strong> neste
          node reconhecem (cruzamento RPC no backend).
        </p>
        {payload?.nota_pt ? <p className="muted">{payload.nota_pt}</p> : null}
        {payload?.nota_filtro_wallet_pt ? <p className="zmq-filter-banner">{payload.nota_filtro_wallet_pt}</p> : null}
        <p className={statusClass}>
          {loading && !payload ? "carregando…" : error ? `erro: ${error}` : "ligado ao endpoint"}
        </p>

        <div className="field-grid" style={{ maxWidth: "720px" }}>
          <label>
            Limite (<code>recent</code>)
            <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
              <option value={40}>40</option>
              <option value={80}>80</option>
              <option value={120}>120</option>
              <option value={200}>200</option>
            </select>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            Atualização automática (~{String(POLL_MS / 1000)} s)
          </label>
          <label style={{ display: "flex", alignItems: "flex-start", gap: "8px", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={walletRelevantOnly}
              onChange={(e) => setWalletRelevantOnly(e.target.checked)}
            />
            <span>
              Só transacções das <strong>wallets carregadas</strong> neste node (filtro por{" "}
              <code>gettransaction</code>). Desligue para ver o feed ZMQ bruto de <em>todas</em> as tx que o relay
              anuncia.
            </span>
          </label>
          {walletRelevantOnly ? (
            <label>
              Profundidade de varredura (<code>scan_depth</code>)
              <select value={scanDepth} onChange={(e) => setScanDepth(Number(e.target.value))}>
                <option value={200}>200 eventos ZMQ</option>
                <option value={500}>500</option>
                <option value={1000}>1000</option>
                <option value={2000}>2000</option>
              </select>
              <span className="muted" style={{ fontSize: "0.82rem", marginTop: "4px", display: "block" }}>
                Quantos eventos recentes do buffer ZMQ o backend percorre para encontrar até {String(limit)} tx
                reconhecidas pelas wallets.
              </span>
            </label>
          ) : null}
        </div>
        {walletFilter && payload ? (
          <p className="muted" style={{ fontSize: "0.85rem", marginTop: "8px" }}>
            Buffer ZMQ: <code>{payload.zmq_buffer_len ?? "—"}</code> entradas · Última resposta percorreu{" "}
            <code>{payload.wallet_filter_scanned_events ?? "—"}</code> evento(s) · Na tabela:{" "}
            <code>{payload.wallet_filter_matched ?? payload.recent?.length ?? 0}</code> linha(s) (limite pedido:{" "}
            {String(limit)}).
          </p>
        ) : null}

        <h3 style={{ marginTop: "1.25rem" }}>Estado do listener</h3>
        <div className="meta-list">
          <div className="meta-item">
            <span>URL configurada</span>
            <code>{listener?.url_configured ? "sim" : "não"}</code>
          </div>
          <div className="meta-item">
            <span>URL SUB</span>
            <code>{listener?.url ?? "—"}</code>
          </div>
          <div className="meta-item">
            <span>Thread ativa</span>
            <code>{listener?.thread_alive ? "sim" : "não"}</code>
          </div>
          <div className="meta-item">
            <span>Ligado ao PUB</span>
            <code>{listener?.connected ? "sim" : "não"}</code>
          </div>
          <div className="meta-item">
            <span>Total de eventos (sessão)</span>
            <code>{listener?.events_total ?? "—"}</code>
          </div>
          <div className="meta-item">
            <span>Último erro</span>
            <code>{listener?.last_error ?? "—"}</code>
          </div>
        </div>

        <h3 style={{ marginTop: "1.25rem" }}>Eventos recentes</h3>
        {sortedRecent.length === 0 && !loading ? (
          <p className="muted">
            {walletFilter
              ? "Nenhuma transacção do buffer ZMQ recente foi reconhecida pelas wallets carregadas (ou ainda não há eventos). Experimente aumentar a profundidade de varredura, aguarde tráfego na wallet, ou desligue o filtro para ver todo o tráfego do node."
              : "Nenhum evento no buffer ainda (ou ZMQ desactivado no backend)."}
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="zmq-feed-table">
              <thead>
                <tr>
                  <th
                    scope="col"
                    aria-sort={sortKey === "txid" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                  >
                    <button
                      type="button"
                      className="zmq-sort-th-btn"
                      onClick={() => onSortHeaderClick("txid")}
                    >
                      txid
                      {sortKey === "txid" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                    </button>
                  </th>
                  {walletFilter ? (
                    <th
                      scope="col"
                      aria-sort={sortKey === "wallets" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                    >
                      <button
                        type="button"
                        className="zmq-sort-th-btn"
                        onClick={() => onSortHeaderClick("wallets")}
                      >
                        wallets
                        {sortKey === "wallets" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                      </button>
                    </th>
                  ) : null}
                  <th
                    scope="col"
                    aria-sort={sortKey === "zmq_seq" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                  >
                    <button
                      type="button"
                      className="zmq-sort-th-btn"
                      onClick={() => onSortHeaderClick("zmq_seq")}
                    >
                      zmq_seq
                      {sortKey === "zmq_seq" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                    </button>
                  </th>
                  <th
                    scope="col"
                    aria-sort={
                      sortKey === "received_at" ? (sortDir === "asc" ? "ascending" : "descending") : "none"
                    }
                  >
                    <button
                      type="button"
                      className="zmq-sort-th-btn"
                      onClick={() => onSortHeaderClick("received_at")}
                    >
                      recebido (local)
                      {sortKey === "received_at" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                    </button>
                  </th>
                  <th scope="col" aria-label="Acções" className="zmq-feed-actions-col" />
                </tr>
              </thead>
              <tbody>
                {sortedRecent.map((ev, i) => (
                  <tr key={`${ev.txid}-${String(ev.zmq_seq ?? "n")}-${String(ev.received_at)}-${String(i)}`}>
                    <td>
                      <code className="zmq-txid-cell">{ev.txid}</code>
                    </td>
                    {walletFilter ? (
                      <td>
                        {ev.wallets_on_node?.length ? (
                          <code>{ev.wallets_on_node.join(", ")}</code>
                        ) : (
                          "—"
                        )}
                      </td>
                    ) : null}
                    <td>{ev.zmq_seq ?? "—"}</td>
                    <td>{formatTs(ev.received_at)}</td>
                    <td>
                      <button type="button" className="btn btn-subtle" onClick={() => void copyTxid(ev.txid)}>
                        Copiar txid
                      </button>
                      {copiedTxid === ev.txid ? (
                        <span className="muted" style={{ marginLeft: "6px" }}>
                          OK
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
