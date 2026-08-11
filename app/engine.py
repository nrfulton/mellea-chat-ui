"""Inference orchestration.

Every model call in this application goes through mellea. Two things happen here:

1. `stream_reply` — rebuilds a `ChatContext` from the conversation as stored in
   SQLite, adds the new user turn, and streams the assistant's response back
   token-by-token.
2. `summarize_title` — a second, independent mellea session that turns the
   opening exchange into a short sidebar label. It uses constrained decoding
   (`format=`) so the model returns parseable JSON instead of a sentence like
   "Sure! Here's a title:".

Mellea contexts are immutable — `ctx.add(...)` returns a new context — so
rebuilding history per request is cheap and avoids any cross-chat leakage. The
database stays the single source of truth for conversation state.
"""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import AsyncIterator, Iterable

from pydantic import BaseModel, Field

from mellea import MelleaSession, start_session
from mellea.backends.model_options import ModelOption
from mellea.stdlib.components.chat import Message as MelleaMessage
from mellea.stdlib.context.chat import ChatContext

from .config import Settings
from .store import Message

logger = logging.getLogger(__name__)

# How much of the opening exchange to show the titling model.
_TITLE_USER_CHARS = 600
_TITLE_ASSISTANT_CHARS = 400
_TITLE_MAX_WORDS = 6
_FALLBACK_TITLE = "New chat"

# Strong references for detached cleanup tasks, so the loop can't collect them
# before they run.
_pending: set[asyncio.Task] = set()


class ChatTitle(BaseModel):
    """Schema for constrained title generation."""

    title: str = Field(description="A short, specific title of at most six words.")


class ChatEngine:
    """Wraps mellea so the web layer never touches a backend directly."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    # --- session construction ---

    def _base_kwargs(self) -> dict:
        return {
            "backend_name": "openai",
            "model_id": self._settings.model_id,
            "base_url": self._settings.llama_base_url,
            "api_key": self._settings.api_key,
        }

    def _chat_session(self, history: Iterable[Message]) -> MelleaSession:
        """A session whose context mirrors `history`, ready for the next turn."""
        session = start_session(
            **self._base_kwargs(),
            # model_id lets ChatContext trim to the server's context window
            # instead of overflowing it on long conversations.
            ctx=ChatContext(model_id=self._settings.model_id),
            model_options={
                ModelOption.STREAM: True,
                ModelOption.STREAM_TIMEOUT: self._settings.stream_timeout,
                ModelOption.TEMPERATURE: self._settings.temperature,
                ModelOption.MAX_NEW_TOKENS: self._settings.max_tokens,
            },
        )

        ctx = session.ctx.add(MelleaMessage("system", self._settings.system_prompt))
        for message in history:
            ctx = ctx.add(MelleaMessage(message.role, message.content))
        session.ctx = ctx
        return session

    def _utility_session(self) -> MelleaSession:
        """A fresh, historyless session for side tasks such as titling."""
        return start_session(
            **self._base_kwargs(),
            model_options={
                ModelOption.TEMPERATURE: 0.2,
                ModelOption.MAX_NEW_TOKENS: 64,
            },
        )

    # --- generation ---

    async def stream_reply(
        self, history: Iterable[Message], user_content: str
    ) -> AsyncIterator[str]:
        """Yield the assistant's reply to `user_content` as incremental deltas.

        `history` must not already contain `user_content`; this method adds it.
        """
        session = self._chat_session(history)
        thunk = await session.aact(
            MelleaMessage("user", user_content), await_result=False
        )

        try:
            # astream() blocks on the backend queue and returns only the new
            # text since the previous call, so this loop does not spin.
            while not thunk.is_computed():
                delta = await thunk.astream()
                if delta:
                    yield delta
        finally:
            # Leaving early (client abort, stop button, error) means the
            # llama-server is still producing tokens nobody will read.
            # cancel_generation() is a coroutine and we may already be inside a
            # cancelled task — where awaiting raises instead of running — so
            # detach it rather than awaiting.
            if not thunk.is_computed():
                task = asyncio.ensure_future(thunk.cancel_generation())
                _pending.add(task)
                task.add_done_callback(_pending.discard)
            session.cleanup()

    async def summarize_title(
        self, user_content: str, assistant_content: str = ""
    ) -> str:
        """Return a short sidebar title for an exchange.

        Falls back to a truncated version of the user's own words if the model
        is unreachable or returns something unusable — a failed title must never
        break a working conversation.
        """
        prompt = (
            "Write a short title for the following conversation, for display in "
            "a chat sidebar.\n\n"
            f"Rules:\n"
            f"- At most {_TITLE_MAX_WORDS} words.\n"
            "- Describe the specific topic, not the format. Never answer the question.\n"
            "- Use plain title case with no surrounding quotes and no trailing period.\n\n"
            f"User: {user_content[:_TITLE_USER_CHARS]}\n"
        )
        if assistant_content:
            prompt += f"Assistant: {assistant_content[:_TITLE_ASSISTANT_CHARS]}\n"

        session = self._utility_session()
        try:
            result = await session.ainstruct(
                prompt,
                format=ChatTitle,
                # No validate/repair loop: one cheap call, fall back on failure.
                strategy=None,
                # Required: with strategy=None the default (await_result=False)
                # returns an *uncomputed* thunk, which stringifies to "".
                await_result=True,
            )
            title = ChatTitle.model_validate_json(str(result)).title
            return self._clean_title(title) or self.fallback_title(user_content)
        except Exception:
            logger.warning("Title generation failed; using fallback.", exc_info=True)
            return self.fallback_title(user_content)
        finally:
            session.cleanup()

    async def check_backend(self) -> str:
        """Probe the llama-server with a tiny generation.

        Unlike `summarize_title`, this deliberately lets exceptions propagate —
        a health check that cannot fail tells you nothing.
        """
        session = self._utility_session()
        try:
            result = await session.ainstruct(
                "Reply with the single word: OK",
                strategy=None,
                await_result=True,
                model_options={ModelOption.MAX_NEW_TOKENS: 8},
            )
            return str(result).strip()
        finally:
            session.cleanup()

    # --- helpers ---

    @staticmethod
    def _clean_title(raw: str) -> str:
        """Strip the decorations models like to add and clamp the length."""
        title = " ".join(str(raw).split())
        title = title.strip("\"'“”‘’ \t")
        # Drop a leading "Title:" style prefix.
        title = re.sub(r"^(title|chat title)\s*[:\-–]\s*", "", title, flags=re.I)
        title = title.rstrip(".")
        words = title.split()
        if len(words) > _TITLE_MAX_WORDS:
            title = " ".join(words[:_TITLE_MAX_WORDS])
        return title[:80].strip()

    @staticmethod
    def fallback_title(user_content: str) -> str:
        text = " ".join(user_content.split())
        if not text:
            return _FALLBACK_TITLE
        words = text.split()[:_TITLE_MAX_WORDS]
        title = " ".join(words)
        if len(title) > 60:
            title = title[:57].rstrip() + "…"
        elif len(words) < len(text.split()):
            title += "…"
        return title
