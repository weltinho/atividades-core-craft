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
    BITCOIN_ZMQ_BLOCK: str = "tcp://bitcoind:28332"
    BITCOIN_ZMQ_TX: str = "tcp://bitcoind:28333"
    EVENTS_BUFFER_SIZE: int = 300
    EVENTS_WINDOW_SECONDS: int = 60
    EVENTS_LATEST_LIMIT: int = 20


settings = Settings()
