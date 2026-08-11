"""Application configuration.

Every value can be overridden with an environment variable, which keeps the
llama-server location out of the code for anyone who redeploys this.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

DEFAULT_SYSTEM_PROMPT = (
    "You are a helpful, knowledgeable assistant. Answer clearly and directly. "
    "Use Markdown for structure and fenced code blocks with a language tag for code."
)


@dataclass(frozen=True)
class Settings:
    """Runtime settings for the chat interface."""

    # --- Inference (llama-server, OpenAI-compatible endpoint) ---
    llama_base_url: str = os.getenv("LLAMA_BASE_URL", "http://9.105.22.23:8080/v1")
    model_id: str = os.getenv("LLAMA_MODEL_ID", "ibm-research/granite-5.0-20B-SFT")
    # llama-server ignores the key, but the OpenAI client requires a non-empty one.
    api_key: str = os.getenv("LLAMA_API_KEY", "llama-server")

    # Token budget used to trim history before a request. Mellea can look this
    # up for models in its own catalog, but not for a checkpoint served under a
    # local name, so it is stated here instead of silently disappearing. Set it
    # to the window the server was actually started with (`--ctx-size` for
    # llama-server, `--max-model-len` for vLLM) rather than the model's rated
    # maximum, which is far larger than anything typically served.
    context_tokens: int = int(os.getenv("CONTEXT_TOKENS", "32768"))

    system_prompt: str = os.getenv("SYSTEM_PROMPT", DEFAULT_SYSTEM_PROMPT)
    temperature: float = float(os.getenv("TEMPERATURE", "0.7"))
    max_tokens: int = int(os.getenv("MAX_TOKENS", "2048"))

    # Seconds to wait for a single streaming chunk before giving up.
    stream_timeout: float = float(os.getenv("STREAM_TIMEOUT", "120"))

    # --- Storage ---
    db_path: Path = Path(os.getenv("DB_PATH", str(BASE_DIR / "data" / "chat.db")))

    # --- Server ---
    host: str = os.getenv("HOST", "127.0.0.1")
    port: int = int(os.getenv("PORT", "8000"))

    @property
    def static_dir(self) -> Path:
        """Directory holding the single-page frontend."""
        return BASE_DIR / "static"


settings = Settings()
