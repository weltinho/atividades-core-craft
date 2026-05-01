import { useCallback, useEffect, useMemo, useState } from "react";

type TestPayload = { ok?: boolean; from?: string; hint?: string };
type Theme = "light" | "dark";

const THEME_KEY = "corecraft-theme";

function detectInitialTheme(): Theme {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === "dark" || saved === "light") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(detectInitialTheme);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<TestPayload | null>(null);

  const fetchTest = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${import.meta.env.BASE_URL}api/test`);
      if (!r.ok) {
        setError(`HTTP ${r.status}`);
        setData(null);
        return;
      }
      setData((await r.json()) as TestPayload);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro de rede");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchTest();
  }, [fetchTest]);

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
            <h1 className="title">CoreCraft — Atividade 1</h1>
            <p className="subtitle">Base visual inspirada no laboratório RPC, com tema claro/escuro.</p>
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
          <button className="btn btn-primary" type="button" onClick={() => void fetchTest()}>
            Chamar backend
          </button>
        </div>
      </header>

      <section className="grid">
        <article className="card">
          <h2>Laboratório de Teste API</h2>
          <p className="muted">
            Endpoint de teste: <code>{`${import.meta.env.BASE_URL}api/test`}</code>
          </p>
          <p className={statusClass}>
            {loading ? "carregando..." : error ? `erro: ${error}` : "conectado"}
          </p>
          <div className="code-box">
            {loading && "A aguardar resposta do backend..."}
            {!loading && error && `Falha ao chamar backend:\n${error}`}
            {!loading && !error && data && JSON.stringify(data, null, 2)}
          </div>
        </article>

        <article className="card">
          <h2>Resumo de Ambiente</h2>
          <div className="meta-list">
            <div className="meta-item">
              <span>Tema atual</span>
              <code>{theme}</code>
            </div>
            <div className="meta-item">
              <span>Base URL (Vite)</span>
              <code>{import.meta.env.BASE_URL}</code>
            </div>
            <div className="meta-item">
              <span>Proxy esperado</span>
              <code>/api -&gt; backend:8000</code>
            </div>
            <div className="meta-item">
              <span>Rota de health</span>
              <code>{`${import.meta.env.BASE_URL}api/health`}</code>
            </div>
          </div>
        </article>
      </section>
    </main>
  );
}
