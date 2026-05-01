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


settings = Settings()
