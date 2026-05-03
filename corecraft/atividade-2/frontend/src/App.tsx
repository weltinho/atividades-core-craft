import { useCallback, useEffect, useMemo, useState } from "react";

type Theme = "light" | "dark";

type EventsSummary = {
  blocks_observed: number;
  tx_observed: number;
  blocks_observed_total: number;
  tx_observed_total: number;
  last_event_time: number | null;
  last_block_time: number | null;
  tx_per_second: number;
  window_seconds: number;
};

type LatestPayload = {
  blocks: Array<{ hash: string; ts: number }>;
  txs: Array<{ txid: string; ts: number }>;
  limit: number;
};

type StateComparison = {
  best_block: string;
  last_seen_block: string | null;
  divergence: boolean;
};

const THEME_KEY = "corecraft-theme-a2";

function fmtTs(ts: number | null | undefined): string {
  if (!ts) return "--";
  return new Date(ts * 1000).toLocaleTimeString();
}

function maskHash(value: string | null | undefined): string {
  if (!value) return "--";
  if (value.length <= 8) return value;
  return `${value.slice(0, 3)}...${value.slice(-5)}`;
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<EventsSummary | null>(null);
  const [latest, setLatest] = useState<LatestPayload | null>(null);
  const [comparison, setComparison] = useState<StateComparison | null>(null);
  const [rpcResponseText, setRpcResponseText] = useState("vazio");

  const setRpcPanel = useCallback((apiMessage: string, rawPayload: unknown) => {
    const rawJson = JSON.stringify(rawPayload, null, 2);
    setRpcResponseText(`${apiMessage}\n\n${rawJson}`);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [summaryResp, latestResp, comparisonResp] = await Promise.all([
        fetch(`${import.meta.env.BASE_URL}api/events/summary`),
        fetch(`${import.meta.env.BASE_URL}api/events/latest`),
        fetch(`${import.meta.env.BASE_URL}api/events/state-comparison`),
      ]);
      if (!summaryResp.ok || !latestResp.ok || !comparisonResp.ok) {
        throw new Error("Falha ao consultar endpoints de eventos");
      }
      const [summaryBody, latestBody, comparisonBody] = await Promise.all([
        summaryResp.json() as Promise<EventsSummary>,
        latestResp.json() as Promise<LatestPayload>,
        comparisonResp.json() as Promise<StateComparison>,
      ]);
      setSummary(summaryBody);
      setLatest(latestBody);
      setComparison(comparisonBody);
      setRpcPanel("API de eventos atualizada com sucesso.", {
        summary: summaryBody,
        latest: latestBody,
        state_comparison: comparisonBody,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro inesperado");
      setRpcPanel("Falha na API de eventos.", {
        error: err instanceof Error ? err.message : "Erro inesperado",
      });
    } finally {
      setLoading(false);
    }
  }, [setRpcPanel]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  const statusClass = useMemo(() => {
    if (loading) return "status";
    return error ? "status status-error" : "status status-ok";
  }, [loading, error]);

  return (
    <main className="layout">
      <header className="header">
        <div className="brand">
          <div className="brand-logo" aria-hidden>
            <span className="brand-logo-symbol">₿</span>
          </div>
          <div>
            <h1 className="title">CoreCraft — Atividade 2</h1>
          </div>
        </div>
        <div className="actions">
          <button
            className="theme-toggle"
            type="button"
            aria-label={theme === "light" ? "Ativar tema escuro" : "Ativar tema claro"}
            title={theme === "light" ? "Ativar tema escuro" : "Ativar tema claro"}
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          >
            <span className="theme-icon" aria-hidden>{theme === "light" ? "🌙" : "☀️"}</span>
          </button>
        </div>
      </header>

      <div className="toolbar">
        <a className="btn btn-subtle" href="/home">
          ← Voltar para Home
        </a>
        <button className="btn btn-primary" type="button" onClick={() => void refresh()}>
          Atualizar Estado
        </button>
      </div>

      <section className="grid">
        <article className="card">
          <h2>Event Activity</h2>
          <p className="muted">
            Snapshot via RPC em <code>{`${import.meta.env.BASE_URL}api/events/summary`}</code>.
          </p>
          <div className="card-scroll">
            <p className={statusClass}>
              {loading ? "carregando..." : error ? `erro: ${error}` : "conectado"}
            </p>
            <div className="stats-grid">
              <div className="meta-item">
                <span>Blocos (janela)</span>
                <code>{summary?.blocks_observed ?? "--"}</code>
              </div>
              <div className="meta-item">
                <span>TX (janela)</span>
                <code>{summary?.tx_observed ?? "--"}</code>
              </div>
              <div className="meta-item">
                <span>Blocos (total buffer)</span>
                <code>{summary?.blocks_observed_total ?? "--"}</code>
              </div>
              <div className="meta-item">
                <span>TX (total buffer)</span>
                <code>{summary?.tx_observed_total ?? "--"}</code>
              </div>
              <div className="meta-item">
                <span>TX por segundo</span>
                <code>{summary?.tx_per_second ?? "--"}</code>
              </div>
              <div className="meta-item">
                <span>Último evento</span>
                <code>{fmtTs(summary?.last_event_time)}</code>
              </div>
              <div className="meta-item">
                <span>Último bloco ZMQ</span>
                <code>{fmtTs(summary?.last_block_time)}</code>
              </div>
              <div className="meta-item">
                <span>Janela (s)</span>
                <code>{summary?.window_seconds ?? "--"}</code>
              </div>
            </div>
          </div>
        </article>

        <article className="card">
          <div className="card-header-row">
            <h2>Comparação Estado vs Fluxo</h2>
          </div>
          <p className="muted">
            Compara <code>{`${import.meta.env.BASE_URL}api/events/state-comparison`}</code> (ZMQ vs RPC).
          </p>
          {comparison?.divergence ? (
            <p className="status status-error">⚠️ Divergência detectada entre ZMQ e RPC</p>
          ) : (
            <p className="status status-ok">✅ Sem divergência entre ZMQ e RPC</p>
          )}
          <div className="meta-list">
            <div className="meta-item">
              <span>Best block RPC</span>
              <code>{maskHash(comparison?.best_block)}</code>
            </div>
            <div className="meta-item">
              <span>Último bloco ZMQ</span>
              <code>{maskHash(comparison?.last_seen_block)}</code>
            </div>
            <div className="meta-item">
              <span>Divergência</span>
              <code className={comparison?.divergence ? "text-danger" : "text-ok"}>
                {comparison?.divergence ? "sim (alerta)" : "não"}
              </code>
            </div>
          </div>
          <p className="muted response-label">RPC RESPONSE</p>
          <div className="code-box">
            {loading && "A aguardar resposta do backend..."}
            {!loading && error && `Falha ao chamar backend:\n${error}`}
            {!loading && !error && rpcResponseText}
          </div>
        </article>

        <article className="card">
          <h2>Últimos Blocos</h2>
          <p className="muted">
            Eventos recentes via <code>{`${import.meta.env.BASE_URL}api/events/latest`}</code> (lista de blocos ZMQ).
          </p>
          <div className="event-scroll">
            <ul className="event-list">
              {(latest?.blocks ?? []).slice(-8).reverse().map((item) => (
                <li key={`${item.hash}-${item.ts}`}>
                  <code>{item.hash}</code>
                  <span className="muted">{fmtTs(item.ts)}</span>
                </li>
              ))}
            </ul>
          </div>
        </article>

        <article className="card">
          <h2>Últimas Transações</h2>
          <p className="muted">
            Eventos recentes via <code>{`${import.meta.env.BASE_URL}api/events/latest`}</code> (lista de txs ZMQ).
          </p>
          <div className="event-scroll">
            <ul className="event-list">
              {(latest?.txs ?? []).slice(-12).reverse().map((item) => (
                <li key={`${item.txid}-${item.ts}`}>
                  <code>{item.txid}</code>
                  <span className="muted">{fmtTs(item.ts)}</span>
                </li>
              ))}
            </ul>
          </div>
        </article>
      </section>
    </main>
  );
}
