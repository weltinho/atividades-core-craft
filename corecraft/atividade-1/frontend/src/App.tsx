import { useCallback, useEffect, useMemo, useState } from "react";

type Theme = "light" | "dark";
type FeeDistributionRule = {
  strategy: string;
  threshold_percent: number;
  weighted_center: number;
  low_cut: number;
  high_cut: number;
};
type MempoolSummary = {
  tx_count: number;
  total_vsize: number;
  total_fee_sats?: number;
  avg_fee_rate: number;
  min_fee_rate: number;
  max_fee_rate: number;
  fee_distribution: { low: number; medium: number; high: number };
  fee_distribution_rule?: FeeDistributionRule;
  rpc_raw?: unknown;
};
type BlockchainLag = { blocks: number; headers: number; lag: number; rpc_raw?: unknown };
type WalletStatus = {
  wallet: string;
  network: string;
  balance_btc: number;
  balance_confirmed_btc?: number;
  balance_pending_btc?: number;
  funding_address: string;
  hint: string;
  rpc_raw?: unknown;
};
type SendTxResponse = { txid?: string; amount_btc?: number; to?: string; rpc_raw?: unknown };

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
  const [mempool, setMempool] = useState<MempoolSummary | null>(null);
  const [lag, setLag] = useState<BlockchainLag | null>(null);
  const [wallet, setWallet] = useState<WalletStatus | null>(null);
  const [txResult, setTxResult] = useState<SendTxResponse | null>(null);
  const [rpcResponseText, setRpcResponseText] = useState("vazio");
  const [thresholdInput, setThresholdInput] = useState("70");

  const setRpcPanel = useCallback((apiMessage: string, rawPayload: unknown) => {
    const rawJson = JSON.stringify(rawPayload, null, 2);
    setRpcResponseText(`${apiMessage}\n\n${rawJson}`);
  }, []);

  const fetchSnapshotIntelligence = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const parsedThreshold = Number(thresholdInput);
      if (!Number.isFinite(parsedThreshold) || parsedThreshold < 0) {
        throw new Error("Input de limiar inválido");
      }
      const query = new URLSearchParams({ threshold_percent: String(parsedThreshold) }).toString();
      const [mempoolResp, lagResp] = await Promise.all([
        fetch(`${import.meta.env.BASE_URL}api/mempool/summary?${query}`),
        fetch(`${import.meta.env.BASE_URL}api/blockchain/lag`),
      ]);
      if (!mempoolResp.ok) {
        throw new Error(`mempool HTTP ${mempoolResp.status}`);
      }
      if (!lagResp.ok) {
        throw new Error(`lag HTTP ${lagResp.status}`);
      }
      const mempoolBody = (await mempoolResp.json()) as MempoolSummary;
      const lagBody = (await lagResp.json()) as BlockchainLag;
      setMempool(mempoolBody);
      setLag(lagBody);
      setRpcPanel("API snapshot atualizado com sucesso.", {
        mempool_summary: mempoolBody.rpc_raw ?? {},
        blockchain_lag: lagBody.rpc_raw ?? {},
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro de rede");
      setMempool(null);
      setLag(null);
      setRpcPanel("Falha na API de snapshot.", { error: e instanceof Error ? e.message : "Erro de rede" });
    } finally {
      setLoading(false);
    }
  }, [setRpcPanel, thresholdInput]);

  const fetchWalletStatus = useCallback(async () => {
    try {
      const resp = await fetch(`${import.meta.env.BASE_URL}api/wallet/test/status`);
      if (!resp.ok) throw new Error(`wallet HTTP ${resp.status}`);
      const body = (await resp.json()) as WalletStatus;
      setWallet(body);
      setRpcPanel("API wallet status atualizada.", { wallet_test_status: body.rpc_raw ?? {} });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro ao consultar wallet");
      setWallet(null);
      setRpcPanel("Falha na API wallet status.", { error: e instanceof Error ? e.message : "Erro ao consultar wallet" });
    }
  }, [setRpcPanel]);

  const refreshWalletFromRpc = useCallback(async () => {
    setError(null);
    try {
      const resp = await fetch(`${import.meta.env.BASE_URL}api/wallet/test/refresh`, {
        method: "POST",
      });
      if (!resp.ok) throw new Error(`wallet refresh HTTP ${resp.status}`);
      const body = (await resp.json()) as WalletStatus;
      setWallet(body);
      setRpcPanel("API wallet refresh executada.", { wallet_test_refresh: body.rpc_raw ?? {} });
      await fetchSnapshotIntelligence();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro ao atualizar carteira");
      setRpcPanel("Falha na API wallet refresh.", { error: e instanceof Error ? e.message : "Erro ao atualizar carteira" });
    }
  }, [fetchSnapshotIntelligence, setRpcPanel]);

  const sendTestTx = useCallback(async () => {
    setError(null);
    setTxResult(null);
    try {
      const resp = await fetch(`${import.meta.env.BASE_URL}api/mempool/send-test-tx`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body: unknown = await resp.json();
      if (!resp.ok) {
        const detail = typeof body === "object" && body !== null && "detail" in body ? (body as { detail?: unknown }).detail : undefined;
        if (typeof detail === "string") throw new Error(detail);
        if (detail && typeof detail === "object" && "message" in detail) {
          const msg = String((detail as { message?: unknown }).message ?? "Falha ao enviar TX de teste");
          setRpcPanel("Falha na API send-test-tx.", body);
          throw new Error(msg);
        }
        setRpcPanel("Falha na API send-test-tx.", body);
        throw new Error("Falha ao enviar TX de teste");
      }
      setTxResult(body as SendTxResponse);
      setRpcPanel("API send-test-tx executada com sucesso.", {
        send_test_tx: (body as SendTxResponse).rpc_raw ?? body,
      });
      await fetchSnapshotIntelligence();
      await fetchWalletStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao enviar TX");
    }
  }, [fetchSnapshotIntelligence, fetchWalletStatus, setRpcPanel]);

  useEffect(() => {
    void fetchSnapshotIntelligence();
    void fetchWalletStatus();
  }, [fetchSnapshotIntelligence, fetchWalletStatus]);

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
        <button className="btn btn-primary" type="button" onClick={() => void fetchSnapshotIntelligence()}>
          Atualizar Estado
        </button>
      </div>

      <section className="grid">
        <article className="card">
          <h2>Consulta de Estado do Bitcoin Core via RPC</h2>
          <p className="muted">
            Snapshot via RPC em <code>{`${import.meta.env.BASE_URL}api/mempool/summary`}</code>.
          </p>
          <div className="percentile-controls">
            <label>
              Input do limiar (%)
              <input
                type="number"
                min={0}
                step="0.1"
                value={thresholdInput}
                onChange={(e) => setThresholdInput(e.target.value)}
              />
            </label>
          </div>
          <p className={statusClass}>
            {loading ? "carregando..." : error ? `erro: ${error}` : "conectado"}
          </p>
          <div className="stats-grid">
            <div className="meta-item">
              <span>Total de tx</span>
              <code>{mempool?.tx_count ?? "--"}</code>
            </div>
            <div className="meta-item">
              <span>vsize total</span>
              <code>{mempool?.total_vsize ?? "--"}</code>
            </div>
            <div className="meta-item">
              <span>Taxa total (sats)</span>
              <code>{mempool?.total_fee_sats ?? "--"}</code>
            </div>
            <div className="meta-item">
              <span>Fee média ponderada (sat/vB)</span>
              <code>{mempool?.avg_fee_rate ?? "--"}</code>
            </div>
            <div className="meta-item">
              <span>Fee min / max</span>
              <code>
                {mempool ? `${mempool.min_fee_rate} / ${mempool.max_fee_rate}` : "--"}
              </code>
            </div>
          </div>
          <div className="dist-row">
            <span className="dist-pill dist-low">baixa: {mempool?.fee_distribution.low ?? "--"}</span>
            <span className="dist-pill dist-medium">média: {mempool?.fee_distribution.medium ?? "--"}</span>
            <span className="dist-pill dist-high">alta: {mempool?.fee_distribution.high ?? "--"}</span>
          </div>
          {mempool?.fee_distribution_rule && (
            <p className="muted percentile-hint">
              Regra dinâmica: low &lt; {mempool.fee_distribution_rule.low_cut} sat/vB; high &gt;{" "}
              {mempool.fee_distribution_rule.high_cut} sat/vB (centro:{" "}
              {mempool.fee_distribution_rule.weighted_center} | input: {mempool.fee_distribution_rule.threshold_percent}%)
            </p>
          )}
          {wallet && (
            <div className="wallet-note">
              <div className="wallet-note-header">
                <strong>Carteira de teste</strong>
                <div className="wallet-actions">
                  <button className="btn btn-subtle" type="button" onClick={() => void refreshWalletFromRpc()}>
                    Atualizar carteira
                  </button>
                  <button className="btn btn-accent" type="button" onClick={() => void sendTestTx()}>
                    <span aria-hidden>⚡</span> Gerar TX de teste
                  </button>
                </div>
              </div>
              <strong>Funding address:</strong> <code>{wallet.funding_address}</code>
              <br />
              <strong>Saldo:</strong> {wallet.balance_btc} BTC ({wallet.balance_pending_btc ?? 0} pending +{" "}
              {wallet.balance_confirmed_btc ?? 0} confirmed) ({wallet.network})
            </div>
          )}
          {txResult?.txid && (
            <div className="wallet-note">
              <strong>TX enviada:</strong> <code>{txResult.txid}</code>
            </div>
          )}
        </article>

        <article className="card">
          <div className="card-header-row">
            <h2>Estado da Blockchain com getblockchaininfo e getrawmempool</h2>
          </div>
          <div className="meta-list">
            <div className="meta-item">
              <span>Blocks</span>
              <code>{lag?.blocks ?? "--"}</code>
            </div>
            <div className="meta-item">
              <span>Headers</span>
              <code>{lag?.headers ?? "--"}</code>
            </div>
            <div className="meta-item">
              <span>Lag</span>
              <code>{lag?.lag ?? "--"}</code>
            </div>
          </div>
          <p className="muted response-label">RPC RESPONSE</p>
          <div className="code-box">
            {loading && "A aguardar resposta do backend..."}
            {!loading && error && `Falha ao chamar backend:\n${error}`}
            {!loading && !error && rpcResponseText}
          </div>
        </article>
      </section>
    </main>
  );
}
