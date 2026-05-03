from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    BITCOIN_RPC_USER: str = "bitcoin"
    BITCOIN_RPC_PASSWORD: str = "bitcoin"
    BITCOIN_RPC_PORT: int = 38332
    BITCOIN_HOST: str = "bitcoind"
    BITCOIN_NETWORK: str = "signet"
    # Aviso em GET /tx/{txid} quando a tx está em mempool há mais de este tempo (Aula 03: ex. 2 min).
    TX_STUCK_WARNING_SECONDS: int = 120
    # Opcional: URL ZMQ SUB (ex. tcp://bitcoind:28333). Vazio = não inicia listener (só RPC).
    BITCOIN_ZMQ_SUB_URL: str = ""


settings = Settings()


def tx_explorer_tx_url_template() -> str | None:
    """Template com placeholder {txid} para explorador público; None em redes sem explorador comum."""
    n = settings.BITCOIN_NETWORK.strip().lower()
    if n == "signet":
        return "https://mempool.space/signet/tx/{txid}"
    if n in ("test", "testnet"):
        return "https://mempool.space/testnet/tx/{txid}"
    if n in ("main", "mainnet"):
        return "https://mempool.space/tx/{txid}"
    return None
