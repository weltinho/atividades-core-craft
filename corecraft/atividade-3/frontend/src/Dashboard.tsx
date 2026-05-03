import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

type Theme = "light" | "dark";
type WalletsPayload = { available_wallets: string[]; loaded_wallets: string[]; selected_wallet: string | null };
type WalletStatus = {
  wallet: string;
  /** Soma de UTXOs via listunspent minconf=0 (inclui troco / outputs na mempool). */
  balance: number;
  utxo_balances: {
    total_btc: number;
    confirmed_btc: number;
    unconfirmed_btc: number;
  };
  utxo_counts: {
    total: number;
    confirmed: number;
    unconfirmed: number;
  };
  utxos: number;
};
type TxSend = {
  txid: string;
  wallet: string;
  status: string;
  message: string;
  fee_rate_sat_vb?: number | null;
  inputs?: Array<{ txid: string; vout: number }>;
  /** Resposta antiga ou espelho do usado no funding. */
  change_address?: string | null;
  change_address_requested?: string | null;
  change_address_used?: string | null;
  simple_path?: "sendtoaddress" | "psbt";
};
type TxStatus = {
  txid: string;
  wallet: string;
  status: string;
  confirmed: boolean;
  confirmations: number;
  block_hash: string | null;
  age_seconds: number;
  message: string;
  warning: string | null;
};
type TxHistory = {
  items: Array<{
    txid: string;
    wallet: string;
    created_at: number;
    last_status: string;
    to_address?: string;
    amount_btc: number;
  }>;
};
type BitcoinStubConfig = {
  network?: string;
  tx_explorer_tx_url_template?: string | null;
};
type TxInspectSummary = {
  txid?: string;
  size?: number;
  vsize?: number;
  weight?: number;
  vin_count?: number;
  vout_count?: number;
  vout_total_btc?: number;
  fee_btc?: number | null;
  fee_rate_sat_vb?: number | null;
  confirmations?: number;
  blockhash?: string;
};
type RpcLogEntry = {
  tsIso: string;
  endpoint: string;
  payload: unknown;
};

const THEME_KEY = "corecraft-theme-a3";
type ActionMode = "new_address" | "send_simple" | "send_raw";

/** Limites do slider de taxa (sat/vB), alinhados com min/max/step do `<input type="range">`. */
const FEE_RATE_SAT_VB_MIN = 1;
const FEE_RATE_SAT_VB_MAX = 50;
const FEE_RATE_SAT_VB_STEP = 0.5;

/** Alinhado ao backend `MAX_PSBT_EXPLICIT_INPUTS`. */
const MAX_PSBT_EXPLICIT_INPUTS = 50;

type RawUtxoRow = { id: string; value: string };

function newEmptyUtxoRow(): RawUtxoRow {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${String(Date.now())}-${String(Math.random()).slice(2, 11)}`;
  return { id, value: "" };
}

/** Erros HTTP 422 do FastAPI/Pydantic: `detail` costuma ser um array de objetos { loc, msg, type }. Só as causas por campo. */
function linesFromFastApiValidationDetail(detail: unknown): string[] {
  if (!Array.isArray(detail) || detail.length === 0) return [];
  const out: string[] = [];
  for (const item of detail) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const msg = typeof o.msg === "string" ? o.msg : "";
    const loc = o.loc;
    const field =
      Array.isArray(loc) ? loc.filter((x) => x !== "body" && x !== "query" && x !== "path").join(".") : "";
    const type = typeof o.type === "string" ? o.type : "";

    if (field === "to_address" && (type === "string_too_short" || type === "missing")) {
      out.push("«To Address» está vazio ou incompleto — preencha um endereço Bitcoin válido (ex.: tb1…).");
      continue;
    }
    if (field === "amount_btc" && msg) {
      out.push(`Montante (amount_btc): ${msg}`);
      continue;
    }
    if (field && msg) out.push(`${field}: ${msg}`);
    else if (msg) out.push(msg);
  }
  return out;
}

function formatApiError(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback;
  if ("detail" in payload) {
    const detail = (payload as { detail?: unknown }).detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      const validationLines = linesFromFastApiValidationDetail(detail);
      if (validationLines.length) {
        const head = "HTTP 422 — validação do backend (o bitcoind não foi chamado).";
        return `${head}\n${validationLines.join("\n")}\n\n— Detalhe bruto —\n${JSON.stringify(detail, null, 2)}`;
      }
      return JSON.stringify(detail, null, 2);
    }
    if (detail && typeof detail === "object") {
      const d = detail as Record<string, unknown>;
      const parts: string[] = [];
      if (typeof d.explicacao_pt === "string" && d.explicacao_pt.trim()) parts.push(d.explicacao_pt.trim());
      if (typeof d.sugestao_pt === "string" && d.sugestao_pt.trim()) parts.push(`Sugestão: ${d.sugestao_pt.trim()}`);
      if (typeof d.rpc_error_message === "string" && d.rpc_error_message) {
        parts.push(
          `Mensagem do Core: ${d.rpc_error_message}${d.rpc_error_code != null ? ` (código ${String(d.rpc_error_code)})` : ""}`,
        );
      }
      if (parts.length) {
        parts.push("— Detalhe técnico (JSON) —");
        parts.push(JSON.stringify(detail, null, 2));
        return parts.join("\n\n");
      }
      return JSON.stringify(detail, null, 2);
    }
  }
  return fallback;
}

/** Linhas legíveis para o painel RPC RESPONSE (falhas API / Bitcoin RPC). */
function collectProblemLines(payload: unknown): string[] {
  const lines: string[] = [];
  if (!payload || typeof payload !== "object") return lines;
  const p = payload as Record<string, unknown>;
  let detail: unknown;
  if ("detail" in p) detail = p.detail;
  else if (p.apiResponse && typeof p.apiResponse === "object" && "detail" in (p.apiResponse as object)) {
    detail = (p.apiResponse as { detail: unknown }).detail;
  }

  const is422 = p.ok === false && p.httpStatus === 422;
  if (p.ok === false && typeof p.httpStatus === "number") {
    if (is422) {
      lines.push("HTTP 422 — validação do backend (o bitcoind não foi chamado).");
    } else {
      lines.push(`Resposta HTTP ${String(p.httpStatus)} (erro).`);
    }
  }

  if (Array.isArray(detail)) {
    lines.push(...linesFromFastApiValidationDetail(detail));
  } else if (typeof detail === "string" && detail.trim()) {
    lines.push(detail.trim());
  } else if (detail && typeof detail === "object") {
    const d = detail as Record<string, unknown>;
    if (typeof d.explicacao_pt === "string" && d.explicacao_pt.trim()) lines.push(d.explicacao_pt.trim());
    if (typeof d.sugestao_pt === "string" && d.sugestao_pt.trim()) lines.push(`Sugestão: ${d.sugestao_pt.trim()}`);
    if (typeof d.rpc_error_message === "string" && d.rpc_error_message) {
      lines.push(
        `Mensagem do Core: ${d.rpc_error_message}${d.rpc_error_code != null ? ` · código ${String(d.rpc_error_code)}` : ""}`,
      );
    }
    if (typeof d.method === "string") {
      lines.push(
        `RPC: ${d.method}${typeof d.wallet === "string" ? ` · wallet «${d.wallet}»` : ""}`,
      );
    }
    if (d.funding_context && typeof d.funding_context === "object") {
      lines.push(`Contexto (inputs vs montante):\n${JSON.stringify(d.funding_context, null, 2)}`);
    }
  }

  if (p.request && typeof p.request === "object") {
    lines.push(`Pedido enviado: ${JSON.stringify(p.request)}`);
  }

  if (!lines.length && typeof p.error === "string" && p.error.trim()) {
    lines.push(p.error.trim());
  }
  return lines;
}

/** Erros longos (RPC, JSON, várias linhas) mostram-se só em «Saída RPC / API», não no card de operações. */
function shouldDeferActionErrorToRpcPanel(message: string): boolean {
  if (message.length >= 160) return true;
  if (message.includes("\n— Detalhe")) return true;
  if (message.includes("bitcoin_rpc_error")) return true;
  if ((message.match(/\n/g) || []).length >= 3) return true;
  return false;
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse `txid:vout` sem lançar — útil para validação em tempo real. */
function tryParseUtxoSlot(raw: string): { txid: string; vout: number } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(":");
  if (parts.length !== 2) return null;
  const [txid, voutRaw] = parts.map((part) => part.trim());
  if (!txid || !voutRaw) return null;
  const vout = Number(voutRaw);
  if (!Number.isInteger(vout) || vout < 0) return null;
  return { txid, vout };
}

function parseUtxoSlot(raw: string, index: number): { txid: string; vout: number } {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`UTXO ${index + 1} está vazio.`);
  }
  const p = tryParseUtxoSlot(raw);
  if (!p) {
    throw new Error(`UTXO ${index + 1} inválido. Use o formato txid:vout (ex.: abc...:0).`);
  }
  return p;
}

type WalletListUtxo = { txid?: unknown; vout?: unknown; amount?: unknown };

type UtxoSlotLiveStatus =
  | "empty"
  | "bad_format"
  | "loading"
  | "catalog_error"
  | "not_in_wallet"
  | "duplicate"
  | "ok";

type UtxoSlotLive = { rowId: string; status: UtxoSlotLiveStatus; amountBtc?: number; key: string | null };

export default function Dashboard() {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const [loading, setLoading] = useState(true);
  const [contextError, setContextError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionErrorRpcHint, setActionErrorRpcHint] = useState(false);
  const [wallets, setWallets] = useState<WalletsPayload | null>(null);
  const [walletStatus, setWalletStatus] = useState<WalletStatus | null>(null);
  const [selectedWallet, setSelectedWallet] = useState("");
  const [newWalletName, setNewWalletName] = useState("");
  /** Modo de operação por nome de wallet (chave = wallet activa no Core). Ausente → «novo endereço». */
  const [actionModeByWallet, setActionModeByWallet] = useState<Record<string, ActionMode>>({});
  const [toAddress, setToAddress] = useState("");
  const [amountBtc, setAmountBtc] = useState("0.00001");
  const [rawFeeRateSatVb, setRawFeeRateSatVb] = useState("2");
  const [changeAddressInput, setChangeAddressInput] = useState("");
  const [rawUtxoSlots, setRawUtxoSlots] = useState<RawUtxoRow[]>(() => [newEmptyUtxoRow()]);
  const [walletListUtxos, setWalletListUtxos] = useState<WalletListUtxo[]>([]);
  const [walletUtxosLoadState, setWalletUtxosLoadState] = useState<"idle" | "loading" | "error">("idle");
  const [walletUtxosLoadError, setWalletUtxosLoadError] = useState<string | null>(null);
  /** Incrementado após refresh / envio para recarregar o catálogo usado na validação PSBT. */
  const [utxoCatalogNonce, setUtxoCatalogNonce] = useState(0);
  const [generatedAddress, setGeneratedAddress] = useState<string | null>(null);
  const [generatedAddressWallet, setGeneratedAddressWallet] = useState<string | null>(null);
  const [generatedAddressCopied, setGeneratedAddressCopied] = useState(false);
  const [lastTx, setLastTx] = useState<TxSend | null>(null);
  const [txStatus, setTxStatus] = useState<TxStatus | null>(null);
  const [history, setHistory] = useState<TxHistory | null>(null);
  const [bitcoinConfig, setBitcoinConfig] = useState<BitcoinStubConfig | null>(null);
  const [inspectByTxid, setInspectByTxid] = useState<
    Record<string, { loading: boolean; summary?: TxInspectSummary; error?: string }>
  >({});
  const [rpcLogs, setRpcLogs] = useState<RpcLogEntry[]>([]);
  const activeWalletLabel = walletStatus?.wallet ?? (selectedWallet || "--");
  const walletKeyForMode = useMemo(
    () => (walletStatus?.wallet ?? selectedWallet ?? "").trim(),
    [walletStatus?.wallet, selectedWallet],
  );
  const actionMode = useMemo((): ActionMode => {
    if (!walletKeyForMode) return "new_address";
    return actionModeByWallet[walletKeyForMode] ?? "new_address";
  }, [walletKeyForMode, actionModeByWallet]);
  const setActionModeForActiveWallet = useCallback(
    (mode: ActionMode) => {
      if (!walletKeyForMode) return;
      setActionModeByWallet((prev) => ({ ...prev, [walletKeyForMode]: mode }));
    },
    [walletKeyForMode],
  );
  const showFeeControl = actionMode === "send_raw";
  const feeRateSelectedDisplay = Number.parseFloat(rawFeeRateSatVb);

  const utxoAmountByKey = useMemo(() => {
    const m = new Map<string, number>();
    for (const u of walletListUtxos) {
      if (!u || typeof u !== "object") continue;
      const t = u.txid;
      const v = u.vout;
      const a = u.amount;
      if (typeof t !== "string" || typeof v !== "number" || typeof a !== "number") continue;
      m.set(`${t}:${String(v)}`, a);
    }
    return m;
  }, [walletListUtxos]);

  const rawUtxoLive = useMemo(() => {
    const rows: UtxoSlotLive[] = [];
    const seenKeyToRowId = new Map<string, string>();
    let sumMatchedBtc = 0;
    const loadState = walletUtxosLoadState;

    for (const row of rawUtxoSlots) {
      const raw = row.value.trim();
      if (!raw) {
        rows.push({ rowId: row.id, status: "empty", key: null });
        continue;
      }
      const parsed = tryParseUtxoSlot(row.value);
      if (!parsed) {
        rows.push({ rowId: row.id, status: "bad_format", key: null });
        continue;
      }
      const key = `${parsed.txid}:${String(parsed.vout)}`;
      const firstId = seenKeyToRowId.get(key);
      if (firstId && firstId !== row.id) {
        const dupAmt = utxoAmountByKey.get(key);
        rows.push({ rowId: row.id, status: "duplicate", key, amountBtc: dupAmt });
        continue;
      }
      seenKeyToRowId.set(key, row.id);

      if (loadState === "loading") {
        rows.push({ rowId: row.id, status: "loading", key });
        continue;
      }
      if (loadState === "error") {
        rows.push({ rowId: row.id, status: "catalog_error", key });
        continue;
      }
      const amt = utxoAmountByKey.get(key);
      if (amt === undefined) {
        rows.push({ rowId: row.id, status: "not_in_wallet", key });
        continue;
      }
      rows.push({ rowId: row.id, status: "ok", key, amountBtc: amt });
      sumMatchedBtc += amt;
    }
    return { rows, sumMatchedBtc };
  }, [rawUtxoSlots, utxoAmountByKey, walletUtxosLoadState]);

  const rawUtxoRowStatusById = useMemo(() => {
    const m = new Map<string, UtxoSlotLive>();
    for (const r of rawUtxoLive.rows) m.set(r.rowId, r);
    return m;
  }, [rawUtxoLive.rows]);

  useEffect(() => {
    if (actionMode !== "send_raw" || !walletKeyForMode) {
      setWalletListUtxos([]);
      setWalletUtxosLoadState("idle");
      setWalletUtxosLoadError(null);
      return;
    }
    const ac = new AbortController();
    setWalletUtxosLoadState("loading");
    setWalletUtxosLoadError(null);
    void (async () => {
      try {
        const r = await fetch(`${import.meta.env.BASE_URL}api/wallet/utxos`, { signal: ac.signal });
        const j = (await r.json()) as { utxos?: unknown; detail?: unknown };
        if (!r.ok) throw new Error(formatApiError(j, `HTTP ${String(r.status)}`));
        const list = Array.isArray(j.utxos) ? j.utxos : [];
        setWalletListUtxos(list as WalletListUtxo[]);
        setWalletUtxosLoadState("idle");
      } catch (e) {
        if (ac.signal.aborted) return;
        setWalletListUtxos([]);
        setWalletUtxosLoadState("error");
        setWalletUtxosLoadError(e instanceof Error ? e.message : "Erro ao listar UTXOs");
      }
    })();
    return () => ac.abort();
  }, [actionMode, walletKeyForMode, utxoCatalogNonce]);

  useEffect(() => {
    if (actionMode === "send_simple") {
      setChangeAddressInput("");
    }
  }, [actionMode]);

  useEffect(() => {
    setGeneratedAddressCopied(false);
  }, [generatedAddress]);

  const copyGeneratedAddress = useCallback(async (address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      setGeneratedAddressCopied(true);
      window.setTimeout(() => setGeneratedAddressCopied(false), 2000);
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = address;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        setGeneratedAddressCopied(true);
        window.setTimeout(() => setGeneratedAddressCopied(false), 2000);
      } catch {
        /* ignore */
      }
    }
  }, []);

  const appendRpcLog = useCallback((endpoint: string, payload: unknown) => {
    const entry: RpcLogEntry = {
      tsIso: new Date().toISOString(),
      endpoint,
      payload,
    };
    setRpcLogs((prev) => [entry, ...prev].slice(0, 80));
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setContextError(null);
    try {
      const base = import.meta.env.BASE_URL;
      const [walletsResp, statusResp, historyResp, configResp] = await Promise.all([
        fetch(`${base}api/wallets`),
        fetch(`${base}api/wallet/status`),
        fetch(`${base}api/tx/history`),
        fetch(`${base}api/config/bitcoin-stub`),
      ]);
      if (!walletsResp.ok || !statusResp.ok || !historyResp.ok) {
        const walletsJson = await walletsResp.json().catch(() => ({}));
        const statusJson = await statusResp.json().catch(() => ({}));
        const historyJson = await historyResp.json().catch(() => ({}));
        const parts: string[] = [];
        if (!walletsResp.ok) parts.push(`wallets(${walletsResp.status}): ${formatApiError(walletsJson, "erro")}`);
        if (!statusResp.ok) parts.push(`wallet_status(${statusResp.status}): ${formatApiError(statusJson, "erro")}`);
        if (!historyResp.ok) parts.push(`tx_history(${historyResp.status}): ${formatApiError(historyJson, "erro")}`);
        throw new Error(parts.join(" | "));
      }
      const [walletsBody, statusBody, historyBody] = await Promise.all([
        walletsResp.json() as Promise<WalletsPayload>,
        statusResp.json() as Promise<WalletStatus>,
        historyResp.json() as Promise<TxHistory>,
      ]);
      if (configResp.ok) {
        const cfg = (await configResp.json()) as BitcoinStubConfig;
        setBitcoinConfig(cfg);
        appendRpcLog("GET /config/bitcoin-stub", cfg);
      }
      setWallets(walletsBody);
      setWalletStatus(statusBody);
      setHistory(historyBody);
      setSelectedWallet((current) => current || walletsBody.selected_wallet || walletsBody.available_wallets[0] || "");
      setUtxoCatalogNonce((n) => n + 1);
      appendRpcLog("GET /wallets + /wallet/status + /tx/history", {
        wallets: walletsBody,
        wallet_status: statusBody,
        tx_history: historyBody,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Erro inesperado";
      setContextError(message);
      appendRpcLog("GET /wallets + /wallet/status + /tx/history (falha)", { ok: false, error: message });
    } finally {
      setLoading(false);
    }
  }, [appendRpcLog]);

  /** Só `/wallet/status` — sem piscar o loading global; útil após broadcast (troco na mempool). */
  const refreshWalletStatusOnly = useCallback(async () => {
    try {
      const base = import.meta.env.BASE_URL;
      const statusResp = await fetch(`${base}api/wallet/status`);
      const statusJson = (await statusResp.json().catch(() => ({}))) as WalletStatus | Record<string, unknown>;
      if (!statusResp.ok) {
        appendRpcLog("GET /wallet/status (reconsulta)", { ok: false, httpStatus: statusResp.status, body: statusJson });
        return;
      }
      setWalletStatus(statusJson as WalletStatus);
      appendRpcLog("GET /wallet/status (reconsulta)", statusJson);
    } catch (err) {
      appendRpcLog("GET /wallet/status (reconsulta, falha)", {
        error: err instanceof Error ? err.message : "erro",
      });
    }
  }, [appendRpcLog]);

  const explorerUrlForTx = useCallback(
    (txid: string) => {
      const tpl = bitcoinConfig?.tx_explorer_tx_url_template;
      if (!tpl?.includes("{txid}")) return null;
      return tpl.replace("{txid}", txid);
    },
    [bitcoinConfig?.tx_explorer_tx_url_template],
  );

  const loadTxInspect = useCallback(
    async (txid: string) => {
      setInspectByTxid((prev) => ({ ...prev, [txid]: { loading: true } }));
      try {
        const response = await fetch(`${import.meta.env.BASE_URL}api/tx/${txid}/inspect`);
        const payload = (await response.json()) as { summary?: TxInspectSummary; detail?: unknown };
        if (!response.ok) {
          throw new Error(formatApiError(payload, `HTTP ${response.status}`));
        }
        const summary = payload.summary;
        if (!summary) throw new Error("Resposta sem summary.");
        setInspectByTxid((prev) => ({ ...prev, [txid]: { loading: false, summary } }));
        appendRpcLog(`GET /tx/${txid}/inspect`, payload);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Erro ao inspecionar tx";
        setInspectByTxid((prev) => ({ ...prev, [txid]: { loading: false, error: message } }));
        appendRpcLog(`GET /tx/${txid}/inspect`, { error: message });
      }
    },
    [appendRpcLog],
  );

  const selectWallet = useCallback(async (wallet: string) => {
    setContextError(null);
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}api/wallet/select`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet }),
      });
      const payload = (await response.json()) as unknown;
      if (!response.ok) {
        appendRpcLog("POST /wallet/select (falha)", {
          ok: false,
          httpStatus: response.status,
          request: { wallet },
          apiResponse: payload,
        });
        throw new Error(formatApiError(payload, "Erro ao selecionar wallet"));
      }
      setSelectedWallet(wallet);
      appendRpcLog("POST /wallet/select", payload);
      await refresh();
    } catch (err) {
      setContextError(err instanceof Error ? err.message : "Erro ao selecionar wallet");
    }
  }, [appendRpcLog, refresh]);

  const createWallet = useCallback(async () => {
    setContextError(null);
    try {
      const wallet = newWalletName.trim();
      if (!wallet) throw new Error("Informe um nome para a nova wallet.");
      const response = await fetch(`${import.meta.env.BASE_URL}api/wallet/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet }),
      });
      const payload = (await response.json()) as { selected_wallet?: string; detail?: unknown };
      if (!response.ok) {
        appendRpcLog("POST /wallet/create (falha)", {
          ok: false,
          httpStatus: response.status,
          request: { wallet },
          apiResponse: payload,
        });
        throw new Error(formatApiError(payload, "Falha ao criar wallet"));
      }
      setSelectedWallet(payload.selected_wallet ?? wallet);
      setNewWalletName("");
      appendRpcLog("POST /wallet/create", payload);
      await refresh();
    } catch (err) {
      setContextError(err instanceof Error ? err.message : "Erro ao criar wallet");
    }
  }, [appendRpcLog, newWalletName, refresh]);

  const executeAction = useCallback(async () => {
    setActionError(null);
    setActionErrorRpcHint(false);
    try {
      if (actionMode === "new_address") {
        const response = await fetch(`${import.meta.env.BASE_URL}api/wallet/address/new`, { method: "POST" });
        const payload = (await response.json()) as { wallet?: string; address?: string; detail?: unknown };
        if (!response.ok) {
          appendRpcLog("POST /wallet/address/new (falha)", {
            ok: false,
            httpStatus: response.status,
            apiResponse: payload,
          });
          throw new Error(formatApiError(payload, "Falha ao gerar endereço"));
        }
        setGeneratedAddress(payload.address ?? null);
        setGeneratedAddressWallet(payload.wallet ?? null);
        appendRpcLog("POST /wallet/address/new", payload);
        await refresh();
        return;
      }

      const endpoint = actionMode === "send_simple" ? "api/tx/send-simple" : "api/tx/send";
      const requestBody: {
        to_address: string;
        amount_btc: number;
        fee_rate_sat_vb?: number;
        change_address?: string;
        inputs?: Array<{ txid: string; vout: number }>;
      } = {
        to_address: toAddress,
        amount_btc: Number(amountBtc),
      };
      if (actionMode === "send_raw" && changeAddressInput.trim()) {
        requestBody.change_address = changeAddressInput.trim();
      }
      const feeRateApplies = actionMode === "send_raw";
      if (feeRateApplies) {
        requestBody.fee_rate_sat_vb = Number(rawFeeRateSatVb);
      }
      if (actionMode === "send_raw") {
        const filledSlots = rawUtxoSlots.map((row) => row.value.trim()).filter(Boolean);
        if (filledSlots.length === 0) {
          throw new Error("Informe pelo menos 1 UTXO no formato txid:vout.");
        }
        if (filledSlots.length > MAX_PSBT_EXPLICIT_INPUTS) {
          throw new Error(`No máximo ${String(MAX_PSBT_EXPLICIT_INPUTS)} UTXOs por envio.`);
        }
        if (walletUtxosLoadState === "loading") {
          throw new Error("A carregar UTXOs da carteira para validação. Aguarde um momento.");
        }
        if (walletUtxosLoadState === "error") {
          throw new Error(
            walletUtxosLoadError
              ? `Não foi possível validar UTXOs nesta carteira: ${walletUtxosLoadError}`
              : "Não foi possível validar UTXOs nesta carteira.",
          );
        }
        for (const live of rawUtxoLive.rows) {
          if (live.status === "empty" || live.status === "ok") continue;
          if (live.status === "bad_format") {
            throw new Error(
              "Um ou mais UTXOs têm formato inválido. Use apenas txid:vout (hex de 64 caracteres, dois pontos, número do vout).",
            );
          }
          if (live.status === "duplicate") {
            throw new Error("Não repita o mesmo txid:vout em mais do que uma linha.");
          }
          if (live.status === "not_in_wallet") {
            throw new Error(
              `O UTXO ${live.key ?? ""} não consta na carteira actual (listunspent). Confira em /utxos ou actualize o estado.`,
            );
          }
          throw new Error("Validação de UTXOs indisponível. Actualize o estado ou tente de novo.");
        }
        const parsedInputs = filledSlots.map((slot, index) => parseUtxoSlot(slot, index));
        requestBody.inputs = parsedInputs;
      }
      const response = await fetch(`${import.meta.env.BASE_URL}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      const payload = (await response.json()) as TxSend | { detail?: unknown };
      if (!response.ok) {
        appendRpcLog(`POST /${endpoint} (falha)`, {
          ok: false,
          httpStatus: response.status,
          request: requestBody,
          apiResponse: payload,
        });
        throw new Error(formatApiError(payload, "Falha ao enviar tx"));
      }
      setGeneratedAddress(null);
      setGeneratedAddressWallet(null);
      setLastTx(payload as TxSend);
      appendRpcLog(`POST /${endpoint}`, payload);
      await refresh();
      const txid = (payload as TxSend).txid;
      const statusResp = await fetch(`${import.meta.env.BASE_URL}api/tx/${txid}`);
      if (statusResp.ok) {
        const statusBody = (await statusResp.json()) as TxStatus;
        setTxStatus(statusBody);
      }
      // A wallet do Core pode actualizar listunspent logo após o broadcast; o 1.º refresh por vezes
      // ainda não vê o troco 0-conf. Reconsultar só o saldo com pequenos atrasos.
      void (async () => {
        for (const ms of [350, 900, 2000]) {
          await delayMs(ms);
          await refreshWalletStatusOnly();
        }
      })();
    } catch (err) {
      const raw = err instanceof Error ? err.message : "Erro ao executar ação";
      if (shouldDeferActionErrorToRpcPanel(raw)) {
        setActionError(
          "Operação recusada. O diagnóstico completo está na secção «Saída RPC / API» no final desta página.",
        );
        setActionErrorRpcHint(true);
      } else {
        setActionError(raw);
        setActionErrorRpcHint(false);
      }
    }
  }, [
    actionMode,
    amountBtc,
    appendRpcLog,
    changeAddressInput,
    rawFeeRateSatVb,
    rawUtxoLive.rows,
    rawUtxoSlots,
    refresh,
    refreshWalletStatusOnly,
    toAddress,
    walletUtxosLoadError,
    walletUtxosLoadState,
  ]);

  const refreshTxStatus = useCallback(async () => {
    if (!lastTx?.txid) return;
    setActionError(null);
    setActionErrorRpcHint(false);
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}api/tx/${lastTx.txid}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as TxStatus;
      setTxStatus(payload);
      appendRpcLog(`GET /tx/${lastTx.txid}`, payload);
      await refresh();
    } catch (err) {
      const raw = err instanceof Error ? err.message : "Erro ao consultar status de tx";
      if (shouldDeferActionErrorToRpcPanel(raw)) {
        setActionError(
          "Não foi possível atualizar o status. Veja «Saída RPC / API» no final da página se houver mais detalhe.",
        );
        setActionErrorRpcHint(true);
      } else {
        setActionError(raw);
        setActionErrorRpcHint(false);
      }
    }
  }, [appendRpcLog, lastTx?.txid, refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  const statusClass = useMemo(() => {
    if (loading) return "status";
    return contextError ? "status status-error" : "status status-ok";
  }, [loading, contextError]);

  return (
    <main className="layout">
      <header className="header">
        <div className="brand">
          <div className="brand-logo" aria-hidden>
            <span className="brand-logo-symbol">₿</span>
          </div>
          <h1 className="title">CoreCraft — Atividade 3</h1>
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
        <a className="btn btn-subtle" href="/home">← Voltar para Home</a>
        <div className="inline-row" style={{ flexWrap: "wrap", gap: "8px" }}>
          <Link className="btn btn-subtle" to="/zmq" target="_blank" rel="noreferrer">
            Feed ZMQ hashtx (nova aba)
          </Link>
          <button className="btn btn-primary" type="button" onClick={() => void refresh()}>Atualizar Estado</button>
        </div>
      </div>

      <section className="grid">
        <article className="card">
          <h2>Wallet Context</h2>
          <p className="muted">A transação será criada e assinada no contexto da wallet selecionada.</p>
          <p className="muted">
            Saldos e contagens de UTXO incluem outputs com <strong>0 confirmações</strong> (mempool), por exemplo troco
            de uma env ainda não minerada (incluindo outputs marcados como “unsafe” no Core, p.ex. com tx replaceable).
            Após enviar, o painel reconsulta o saldo automaticamente algumas vezes — ou use «Atualizar Estado».
          </p>
          <p className={statusClass}>{loading ? "carregando..." : contextError ? `erro: ${contextError}` : "conectado"}</p>
          <div className="field-grid">
            <label>
              Wallet ativa
              <select
                value={selectedWallet}
                onChange={(event) => void selectWallet(event.target.value)}
                disabled={(wallets?.available_wallets?.length ?? 0) <= 1}
              >
                {(wallets?.available_wallets ?? []).map((wallet) => (
                  <option key={wallet} value={wallet}>{wallet}</option>
                ))}
              </select>
            </label>
            <label>
              Criar nova wallet
              <div className="inline-row">
                <input
                  value={newWalletName}
                  onChange={(event) => setNewWalletName(event.target.value)}
                  placeholder="ex: wallet-lab-01"
                />
                <button className="btn btn-primary" type="button" onClick={() => void createWallet()}>
                  Criar nova wallet
                </button>
              </div>
            </label>
          </div>
          <div className="meta-list" style={{ marginTop: "8px" }}>
            <div className="meta-item"><span>Wallet selecionada</span><code>{walletStatus?.wallet ?? "--"}</code></div>
            <div className="meta-item">
              <span>Saldo total (UTXOs)</span>
              <code>{walletStatus?.utxo_balances?.total_btc ?? walletStatus?.balance ?? "--"}</code>
            </div>
            <div className="meta-item">
              <span>Saldo confirmado (≥1 conf.)</span>
              <code>{walletStatus?.utxo_balances?.confirmed_btc ?? "--"}</code>
            </div>
            <div className="meta-item">
              <span>Saldo não confirmado (mempool)</span>
              <code>{walletStatus?.utxo_balances?.unconfirmed_btc ?? "--"}</code>
            </div>
            <div className="meta-item">
              <span>UTXOs confirmados (≥1 conf.)</span>
              <div className="inline-row" style={{ justifyContent: "flex-end" }}>
                <code>{walletStatus?.utxo_counts?.confirmed ?? "--"}</code>
                <Link className="btn btn-subtle" to="/utxos?filter=confirmed" target="_blank" rel="noreferrer">
                  Ver só confirmados
                </Link>
              </div>
            </div>
            <div className="meta-item">
              <span>UTXOs não confirmados (mempool)</span>
              <div className="inline-row" style={{ justifyContent: "flex-end" }}>
                <code>{walletStatus?.utxo_counts?.unconfirmed ?? "--"}</code>
                <Link className="btn btn-subtle" to="/utxos?filter=unconfirmed" target="_blank" rel="noreferrer">
                  Ver só mempool
                </Link>
              </div>
            </div>
            <div className="meta-item">
              <span>UTXOs no total</span>
              <div className="inline-row" style={{ justifyContent: "flex-end" }}>
                <code>{walletStatus?.utxo_counts?.total ?? walletStatus?.utxos ?? "--"}</code>
                <Link className="btn btn-subtle" to="/utxos" target="_blank" rel="noreferrer">
                  Ver todos
                </Link>
              </div>
            </div>
          </div>
        </article>

        <article className="card">
          <h2>Operações da Wallet</h2>
          <div className="field-grid">
            <label>
              Ação
              <select
                value={actionMode}
                disabled={!walletKeyForMode}
                onChange={(event) => setActionModeForActiveWallet(event.target.value as ActionMode)}
              >
                <option value="new_address">{`Obter novo endereço da wallet [${activeWalletLabel}]`}</option>
                <option value="send_simple">{`Criar tx com sendtoaddress [${activeWalletLabel}]`}</option>
                <option value="send_raw">{`Criar tx com sendrawtransaction [${activeWalletLabel}] (PSBT)`}</option>
              </select>
              <span className="muted" style={{ fontSize: "0.78rem", fontWeight: 400 }}>
                O modo escolhido fica guardado <strong>por wallet</strong>; ao mudar no selector de cima, volta ao
                último modo dessa carteira (por defeito: novo endereço).
              </span>
            </label>
            {actionMode !== "new_address" && (
              <>
            <label>
              To Address
              <input value={toAddress} onChange={(event) => setToAddress(event.target.value)} placeholder="tb1..." />
            </label>
            <label>
              <span
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "baseline",
                  gap: "6px 10px",
                }}
              >
                <span>Amount (BTC)</span>
                {actionMode === "send_raw" ? (
                  <span className="muted" style={{ fontWeight: 400, fontSize: "0.82rem" }}>
                    soma utxos selecionados:{" "}
                    <code>
                      {walletUtxosLoadState === "loading"
                        ? "…"
                        : `${rawUtxoLive.sumMatchedBtc.toFixed(8)} BTC`}
                    </code>
                  </span>
                ) : actionMode === "send_simple" ? (
                  <span className="muted" style={{ fontWeight: 400, fontSize: "0.82rem" }}>
                    saldo confirmado (wallet):{" "}
                    <code>
                      {typeof walletStatus?.utxo_balances?.confirmed_btc === "number"
                        ? `${walletStatus.utxo_balances.confirmed_btc.toFixed(8)} BTC`
                        : "—"}
                    </code>
                  </span>
                ) : null}
              </span>
              <input value={amountBtc} onChange={(event) => setAmountBtc(event.target.value)} />
              {actionMode === "send_raw" ? (
                <span className="muted" style={{ fontSize: "0.85rem", marginTop: "4px", display: "block" }}>
                  A taxa (PSBT) sai dos inputs; o valor útil para o destinatário é menor que essa soma.
                </span>
              ) : null}
            </label>
            {actionMode === "send_raw" && (
              <label>
                Endereço de troco (change)
                <input
                  value={changeAddressInput}
                  onChange={(event) => setChangeAddressInput(event.target.value)}
                  title="Vazio: o Core usa getrawchangeaddress (próximo change da wallet). Preenchido: troco para este endereço no funding PSBT."
                  placeholder="Vazio = próximo change da wallet (getrawchangeaddress); preencha para forçar um endereço"
                />
                <span className="muted" style={{ fontSize: "0.85rem", marginTop: "4px", display: "block" }}>
                  Vazio → <code>getrawchangeaddress</code> no funding PSBT. Preenchido → troco para o endereço indicado.
                </span>
              </label>
            )}
            {actionMode === "send_simple" && (
              <p className="muted" style={{ fontSize: "0.85rem", margin: 0 }}>
                <strong>Troco:</strong> <code>sendtoaddress</code> não tem argumento de endereço de troco — o Core
                gera troco interno na mesma wallet. <strong>Taxa:</strong> o RPC aceita{" "}
                <code>fee_rate</code> (sat/vB), <code>conf_target</code> / <code>estimate_mode</code>, etc. (ver{" "}
                <a href="https://developer.bitcoin.org/reference/rpc/sendtoaddress.html" target="_blank" rel="noreferrer">
                  sendtoaddress
                </a>
                ); esta UI só envia destino e montante, logo aplicam-se os defaults da wallet. Para UTXOs manuais,
                troco explícito no PSBT ou o slider de sat/vB daqui, use{" "}
                <strong>Criar tx com sendrawtransaction (PSBT)</strong>.
              </p>
            )}
            {showFeeControl && (
              <label>
                Taxa para o funding PSBT (sat/vB)
                <span className="muted" style={{ fontSize: "0.85rem", display: "block", marginBottom: "6px" }}>
                  Passos de <code>{FEE_RATE_SAT_VB_STEP}</code> sat/vB entre o mínimo e o máximo do controlo abaixo.
                  {" "}
                  (modo PSBT / raw.)
                </span>
                <div
                  className="inline-row fee-rate-slider-row"
                  style={{ alignItems: "center", gap: "12px", flexWrap: "wrap", width: "100%" }}
                >
                  <span className="muted fee-rate-slider-bound" title="Extremo esquerdo do slider">
                    mín. <strong>{String(FEE_RATE_SAT_VB_MIN)}</strong>
                  </span>
                  <input
                    type="range"
                    className="fee-rate-slider-input"
                    min={FEE_RATE_SAT_VB_MIN}
                    max={FEE_RATE_SAT_VB_MAX}
                    step={FEE_RATE_SAT_VB_STEP}
                    value={rawFeeRateSatVb}
                    onChange={(event) => setRawFeeRateSatVb(event.target.value)}
                    aria-valuemin={FEE_RATE_SAT_VB_MIN}
                    aria-valuemax={FEE_RATE_SAT_VB_MAX}
                    aria-valuenow={Number.isFinite(feeRateSelectedDisplay) ? feeRateSelectedDisplay : undefined}
                    aria-label={`Taxa em sat/vB, de ${String(FEE_RATE_SAT_VB_MIN)} a ${String(FEE_RATE_SAT_VB_MAX)}`}
                  />
                  <span className="muted fee-rate-slider-bound" title="Extremo direito do slider">
                    máx. <strong>{String(FEE_RATE_SAT_VB_MAX)}</strong>
                  </span>
                </div>
                <div className="muted fee-rate-slider-selected" style={{ fontSize: "0.9rem", marginTop: "8px" }}>
                  Valor enviado à API:{" "}
                  <code>
                    {Number.isFinite(feeRateSelectedDisplay) ? feeRateSelectedDisplay : rawFeeRateSatVb}
                  </code>{" "}
                  sat/vB
                </div>
              </label>
            )}
              {actionMode === "send_raw" && (
                <>
                  <div>
                    <div className="muted" style={{ marginBottom: "6px" }}>
                      UTXOs seleccionados (lista dinâmica; máximo {String(MAX_PSBT_EXPLICIT_INPUTS)} por pedido). Formato
                      obrigatório: <code>txid:vout</code> (dois pontos + índice <code>vout</code>, ex.{" "}
                      <code>…ffe457:831</code>). Só o txid sem <code>:vout</code> é inválido. Em{" "}
                      <Link to="/utxos" target="_blank" rel="noreferrer">/utxos</Link>, use{" "}
                      <strong>Copiar para sendraw</strong> para colar aqui já no formato certo.
                    </div>
                    <div className="utxo-slots utxo-slots-stack">
                      {rawUtxoSlots.map((row, index) => {
                        const live = rawUtxoRowStatusById.get(row.id);
                        const st = live?.status ?? "empty";
                        const trimmed = row.value.trim();
                        const parsedFormat = trimmed ? tryParseUtxoSlot(row.value) : null;
                        const formatClass =
                          !trimmed
                            ? undefined
                            : parsedFormat
                              ? "utxo-input-format-valid"
                              : "utxo-input-format-invalid";
                        const hint =
                          st === "empty"
                            ? ""
                            : st === "bad_format"
                              ? "Formato inválido (use txid:vout)."
                              : st === "loading"
                                ? "A validar na carteira…"
                                : st === "catalog_error"
                                  ? "Não foi possível carregar a lista de UTXOs."
                                  : st === "not_in_wallet"
                                    ? "Este output não aparece em listunspent desta wallet."
                                    : st === "duplicate"
                                      ? "Duplicado: o mesmo txid:vout noutra linha."
                                      : st === "ok" && typeof live?.amountBtc === "number"
                                        ? `Na wallet: ${live.amountBtc.toFixed(8)} BTC`
                                        : "";
                        const hintClass =
                          st === "ok"
                            ? "utxo-slot-hint utxo-slot-hint-ok"
                            : st === "bad_format" ||
                                st === "not_in_wallet" ||
                                st === "duplicate" ||
                                st === "catalog_error"
                              ? "utxo-slot-hint utxo-slot-hint-err"
                              : "utxo-slot-hint utxo-slot-hint-muted";
                        return (
                        <div key={row.id} className="utxo-slot-row">
                          <label>
                            UTXO {index + 1}
                            <input
                              className={formatClass}
                              value={row.value}
                              onChange={(event) => {
                                const v = event.target.value;
                                setRawUtxoSlots((prev) => prev.map((r) => (r.id === row.id ? { ...r, value: v } : r)));
                              }}
                              placeholder="txid64hex:vout"
                              title="Texto completo txid:vout. O vout é o número após os dois pontos (pode ser grande, ex. 831)."
                              autoComplete="off"
                              spellCheck={false}
                            />
                            {hint ? (
                              <span className={hintClass}>{hint}</span>
                            ) : null}
                          </label>
                          {rawUtxoSlots.length > 1 ? (
                            <button
                              type="button"
                              className="btn btn-subtle"
                              aria-label={`Remover UTXO ${String(index + 1)}`}
                              onClick={() => {
                                setRawUtxoSlots((prev) =>
                                  prev.length <= 1 ? prev : prev.filter((r) => r.id !== row.id),
                                );
                              }}
                            >
                              Remover
                            </button>
                          ) : null}
                        </div>
                        );
                      })}
                    </div>
                    <div className="inline-row" style={{ marginTop: "10px", flexWrap: "wrap", gap: "8px" }}>
                      <button
                        type="button"
                        className="btn btn-subtle"
                        disabled={rawUtxoSlots.length >= MAX_PSBT_EXPLICIT_INPUTS}
                        onClick={() => setRawUtxoSlots((prev) => [...prev, newEmptyUtxoRow()])}
                      >
                        + utxo
                      </button>
                      {rawUtxoSlots.length >= MAX_PSBT_EXPLICIT_INPUTS ? (
                        <span className="muted">Limite de {String(MAX_PSBT_EXPLICIT_INPUTS)} linhas atingido.</span>
                      ) : null}
                    </div>
                  </div>
                </>
              )}
              </>
            )}
            <button
              className="btn btn-primary"
              type="button"
              disabled={actionMode === "send_raw" && walletUtxosLoadState === "loading"}
              onClick={() => void executeAction()}
            >
              {actionMode === "new_address"
                ? "Gerar novo endereço"
                : actionMode === "send_simple"
                  ? "Enviar via sendtoaddress"
                  : "Enviar via sendrawtransaction"}
            </button>
            {actionError && (
              <p className="status status-error">
                {actionErrorRpcHint ? (
                  <>
                    {actionError}{" "}
                    <a href="#corecraft-rpc-saida" className="rpc-saida-anchor">
                      Ir para Saída RPC / API
                    </a>
                  </>
                ) : (
                  <>erro: {actionError}</>
                )}
              </p>
            )}
            {generatedAddress && (
              <div
                className="muted inline-row"
                style={{ marginTop: "10px", flexWrap: "wrap", alignItems: "center", rowGap: "6px" }}
              >
                <span>
                  Novo endereço gerado para <code>{generatedAddressWallet ?? walletStatus?.wallet ?? "--"}</code>:
                </span>
                <code style={{ wordBreak: "break-all" }}>{generatedAddress}</code>
                <button
                  type="button"
                  className="btn btn-subtle"
                  onClick={() => void copyGeneratedAddress(generatedAddress)}
                >
                  {generatedAddressCopied ? "Copiado!" : "Copiar"}
                </button>
              </div>
            )}
            {lastTx && (
              <p className="muted">
                Último envio: <code>{lastTx.txid}</code>{" "}
                (
                wallet: <code>{lastTx.wallet}</code>
                {lastTx.simple_path ? (
                  <>
                    , caminho: <code>{lastTx.simple_path}</code>
                  </>
                ) : null}
                {lastTx.change_address_used ? (
                  <>
                    , troco (funding): <code>{lastTx.change_address_used}</code>
                  </>
                ) : null}
                )
              </p>
            )}
          </div>
        </article>

        <article className="card">
          <h2>Status Enriquecido /tx/{`{txid}`}</h2>
          <div className="actions" style={{ marginBottom: "8px" }}>
            <button className="btn btn-subtle" type="button" onClick={() => void refreshTxStatus()} disabled={!lastTx?.txid}>
              Atualizar status da última TX
            </button>
          </div>
          <div className="meta-list">
            <div className="meta-item"><span>txid</span><code>{txStatus?.txid ?? "--"}</code></div>
            <div className="meta-item"><span>wallet</span><code>{txStatus?.wallet ?? "--"}</code></div>
            <div className="meta-item"><span>status</span><code>{txStatus?.status ?? "--"}</code></div>
            <div className="meta-item"><span>confirmada</span><code>{String(txStatus?.confirmed ?? false)}</code></div>
            <div className="meta-item"><span>confirmações</span><code>{txStatus?.confirmations ?? "--"}</code></div>
            <div className="meta-item"><span>age_seconds</span><code>{txStatus?.age_seconds ?? "--"}</code></div>
          </div>
          {txStatus?.message && <p className="text-ok">{txStatus.message}</p>}
          {txStatus?.warning && <p className="text-danger">{txStatus.warning}</p>}
        </article>

        <article className="card">
          <h2>Transações Acompanhadas</h2>
          <p className="muted">Cada item mostra também a wallet de origem.</p>
          <ul className="event-list">
            {(history?.items ?? []).slice(0, 8).map((item) => {
              const explorerHref = explorerUrlForTx(item.txid);
              const inspect = inspectByTxid[item.txid];
              return (
              <li key={item.txid}>
                <div><strong>txid:</strong> <code>{item.txid}</code></div>
                <div><strong>wallet:</strong> <code>{item.wallet}</code></div>
                <div>
                  <strong>destino:</strong> <code>{item.to_address?.trim() ? item.to_address : "—"}</code>
                </div>
                <div><strong>status:</strong> {item.last_status}</div>
                <div><strong>amount:</strong> {item.amount_btc} BTC</div>
                <div className="inline-row" style={{ marginTop: "8px", flexWrap: "wrap", gap: "8px" }}>
                  {explorerHref && (
                    <a
                      className="btn btn-subtle"
                      href={explorerHref}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Abrir no explorador
                    </a>
                  )}
                  <button className="btn btn-subtle" type="button" onClick={() => void loadTxInspect(item.txid)}>
                    Detalhes (getrawtransaction)
                  </button>
                </div>
                {inspect?.loading && <p className="muted">Carregando detalhes…</p>}
                {inspect?.error && (
                  <p className="status status-error" style={{ marginTop: "8px" }}>
                    {inspect.error}
                  </p>
                )}
                {inspect?.summary && (
                  <div className="meta-list" style={{ marginTop: "8px" }}>
                    <div className="meta-item"><span>vsize</span><code>{inspect.summary.vsize ?? "—"}</code></div>
                    <div className="meta-item"><span>size</span><code>{inspect.summary.size ?? "—"}</code></div>
                    <div className="meta-item"><span>weight</span><code>{inspect.summary.weight ?? "—"}</code></div>
                    <div className="meta-item"><span>inputs</span><code>{inspect.summary.vin_count ?? "—"}</code></div>
                    <div className="meta-item"><span>outputs</span><code>{inspect.summary.vout_count ?? "—"}</code></div>
                    <div className="meta-item">
                      <span>soma outputs (BTC)</span>
                      <code>{inspect.summary.vout_total_btc ?? "—"}</code>
                    </div>
                    <div className="meta-item">
                      <span>taxa (BTC)</span>
                      <code>{inspect.summary.fee_btc ?? "—"}</code>
                    </div>
                    <div className="meta-item">
                      <span>feerate (sat/vB)</span>
                      <code>{inspect.summary.fee_rate_sat_vb ?? "—"}</code>
                    </div>
                    <div className="meta-item">
                      <span>confirmações</span>
                      <code>{inspect.summary.confirmations ?? "—"}</code>
                    </div>
                  </div>
                )}
              </li>
              );
            })}
          </ul>
        </article>
      </section>

      <section id="corecraft-rpc-saida" className="card">
        <h2>Saída RPC / API</h2>
        <p className="muted">
          Em falhas do Bitcoin Core, o painel destaca <strong>o problema</strong> e a <strong>sugestão</strong>; o JSON completo fica abaixo.
        </p>
        <div className="code-box">
          {rpcLogs.length === 0 && "vazio"}
          {rpcLogs.map((entry, index) => {
            const problems = collectProblemLines(entry.payload);
            return (
              <div key={`${entry.tsIso}-${index}`} className="rpc-log-entry" style={{ marginBottom: "12px" }}>
                <div>
                  <strong>{entry.tsIso}</strong> | <strong>{entry.endpoint}</strong>
                </div>
                {problems.length > 0 && (
                  <div className="rpc-log-problem" role="alert">
                    <div className="rpc-log-problem-title">Diagnóstico</div>
                    {problems.map((line, i) => (
                      <p key={`${entry.tsIso}-p-${i}`} className="rpc-log-problem-line">
                        {line}
                      </p>
                    ))}
                  </div>
                )}
                <pre style={{ margin: "6px 0 0", whiteSpace: "pre-wrap" }}>
                  {JSON.stringify(entry.payload, null, 2)}
                </pre>
              </div>
            );
          })}
        </div>
      </section>
    </main>
  );
}
