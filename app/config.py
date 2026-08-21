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


def _flag(name: str, default: bool) -> bool:
    """Read a boolean environment variable, accepting the usual spellings."""
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    """Runtime settings for the chat interface."""

    # --- Inference (llama-server, OpenAI-compatible endpoint) ---
    # Defaults to this machine: the UI and the inference server normally run on
    # the same box.
    llama_base_url: str = os.getenv("LLAMA_BASE_URL", "http://127.0.0.1:8080/v1")
    # Empty means "serve whatever the endpoint has loaded" — the engine asks it
    # at startup (see ChatEngine.resolve_model_id). Set LLAMA_MODEL_ID only to
    # pin a specific name, e.g. when the endpoint serves several models and you
    # do not want the first one.
    model_id: str = os.getenv("LLAMA_MODEL_ID", "")
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

    # --- Tools (see app/tools.py) ---
    # Master switch. Off means no relevance query and no tool schemas, so a turn
    # costs exactly one generation again.
    tools_enabled: bool = _flag("TOOLS_ENABLED", True)
    web_search_enabled: bool = _flag("WEB_SEARCH_ENABLED", True)
    # Runs model-authored code on this machine. Limited, but not sandboxed —
    # read the warning at the top of app/tools.py before exposing this app.
    python_tool_enabled: bool = _flag("PYTHON_TOOL_ENABLED", True)

    # How many times the model may call tools before it has to answer. Each
    # round is one extra request to the inference server.
    tool_max_rounds: int = int(os.getenv("TOOL_MAX_ROUNDS", "2"))
    # Ceiling on a single tool's output, so a chatty result cannot crowd the
    # conversation out of the context window.
    tool_output_chars: int = int(os.getenv("TOOL_OUTPUT_CHARS", "4000"))

    # "duckduckgo" scrapes the no-JavaScript HTML endpoint and needs no
    # credentials, but rate-limits bursts; "searxng" uses the JSON API of an
    # instance you point SEARCH_URL at, and is the better option if you run one.
    search_provider: str = os.getenv("SEARCH_PROVIDER", "duckduckgo")
    search_url: str = os.getenv("SEARCH_URL", "")  # empty: provider default
    search_results: int = int(os.getenv("SEARCH_RESULTS", "5"))
    search_timeout: float = float(os.getenv("SEARCH_TIMEOUT", "12"))

    python_timeout: float = float(os.getenv("PYTHON_TIMEOUT", "15"))
    python_memory_mb: int = int(os.getenv("PYTHON_MEMORY_MB", "512"))

    # --- Policy guards (the `m mitm --admin` proxy) ---
    # Base URL of an `m mitm` proxy started with --admin, whose policy registry this UI
    # manages. Empty disables the feature: /api/policies answers 503 and the sidebar
    # button stays hidden, which is the default so nothing changes for a plain install.
    #
    # Note this is separate from LLAMA_BASE_URL. Managing a proxy's guards does not put
    # this UI behind it -- point LLAMA_BASE_URL at the proxy as well (normally the same
    # host with /v1 appended) if these chats should be screened by the guards.
    mitm_base_url: str = os.getenv("MITM_BASE_URL", "")
    # Sent as `Authorization: Bearer`. Must match the proxy's --admin-token. Empty means
    # the proxy is not asking for one.
    mitm_token: str = os.getenv("MITM_TOKEN", "")
    # The control plane only parses YAML, so it answers fast or not at all; no reason for
    # the generous timeout inference gets.
    mitm_timeout: float = float(os.getenv("MITM_TIMEOUT", "10"))

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
