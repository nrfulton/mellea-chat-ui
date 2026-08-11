"""Inference orchestration.

Every model call in this application goes through mellea. Three things happen
here:

1. `stream_reply` — rebuilds a `ChatContext` from the conversation as stored in
   SQLite, adds the new user turn, and streams the assistant's response back
   token-by-token. Tools are woven into this: before generating, a cheap query
   decides which tools (if any) the turn could need; only those are offered to
   the model; anything it calls is executed and fed back so it can answer with
   the results.
2. `select_tools` — that relevance query. It uses constrained decoding
   (`format=`) to get booleans instead of prose, and fails closed: if it errors
   out, the turn simply runs without tools.
3. `summarize_title` — a second, independent mellea session that turns the
   opening exchange into a short sidebar label, also via `format=`, so the model
   returns parseable JSON instead of a sentence like "Sure! Here's a title:".

Mellea contexts are immutable — `ctx.add(...)` returns a new context — so
rebuilding history per request is cheap and avoids any cross-chat leakage. The
database stays the single source of truth for conversation state.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections.abc import AsyncIterator, Iterable, Mapping
from typing import Any

from pydantic import BaseModel, Field

from mellea import MelleaSession, start_session
from mellea.backends.model_options import ModelOption
from mellea.core.base import ModelToolCall
from mellea.stdlib.components.chat import Message as MelleaMessage
from mellea.stdlib.components.chat import ToolMessage
from mellea.stdlib.context.chat import ChatContext

from .config import Settings
from .store import Message
from .tools import RUN_PYTHON, TOOL_GUIDE, WEB_SEARCH, build_tools

logger = logging.getLogger(__name__)

# How much of the opening exchange to show the titling model.
_TITLE_USER_CHARS = 600
_TITLE_ASSISTANT_CHARS = 400
_TITLE_MAX_WORDS = 6
_FALLBACK_TITLE = "New chat"

# How much conversation the tool-relevance query sees. Enough for "look that up
# too" to resolve, short enough to stay a cheap call.
_ROUTER_TURNS = 6
_ROUTER_CHARS = 400

# Handing a model tool schemas is not the same as convincing it to use them: left
# to itself it will happily do ten-digit arithmetic in its head and be wrong. The
# system prompt gets this addendum for turns where tools are on offer.
_TOOL_POLICIES = {
    WEB_SEARCH: (
        "call web_search instead of asserting facts that may have changed or "
        "that you are unsure of"
    ),
    RUN_PYTHON: (
        "call run_python instead of doing multi-digit arithmetic, data wrangling "
        "or date maths in your head"
    ),
}

# Tool call arguments and output are echoed to the browser so the user can see
# what ran. Both are clipped: this is a display copy, not the model's copy.
_ARG_PREVIEW_CHARS = 2000
_OUTPUT_PREVIEW_CHARS = 1200

# Strong references for detached cleanup tasks, so the loop can't collect them
# before they run.
_pending: set[asyncio.Task] = set()


class ChatTitle(BaseModel):
    """Schema for constrained title generation."""

    title: str = Field(description="A short, specific title of at most six words.")


class ToolChoice(BaseModel):
    """Schema for the tool-relevance query — one boolean per tool."""

    web_search: bool = Field(
        description="True only if answering needs information from the web."
    )
    run_python: bool = Field(
        description="True only if answering needs code to be run for an exact result."
    )


class ChatEngine:
    """Wraps mellea so the web layer never touches a backend directly."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        # Built once: the schemas mellea derives from them do not change, and
        # the tools themselves are stateless.
        self._tools = build_tools(settings)

    @property
    def tool_names(self) -> list[str]:
        """Names of the tools this engine may offer, in a stable order."""
        return [name for name in (WEB_SEARCH, RUN_PYTHON) if name in self._tools]

    # --- session construction ---

    def _base_kwargs(self) -> dict:
        return {
            "backend_name": "openai",
            "model_id": self._settings.model_id,
            "base_url": self._settings.llama_base_url,
            "api_key": self._settings.api_key,
        }

    def _system_prompt(self, offering: list[str]) -> str:
        """The system prompt, plus a tool policy when tools are on offer."""
        prompt = self._settings.system_prompt
        if not offering:
            return prompt
        clauses = "; ".join(_TOOL_POLICIES[name] for name in offering)
        return (
            f"{prompt}\n\nTools are available for this turn. Use them rather than "
            f"guessing: {clauses}. Make an actual tool call — do not describe the "
            "call or write the code out in your reply instead. When results come "
            "back, answer from them and mention what you used."
        )

    def _chat_session(
        self, history: Iterable[Message], offering: list[str] | None = None
    ) -> MelleaSession:
        """A session whose context mirrors `history`, ready for the next turn."""
        session = start_session(
            **self._base_kwargs(),
            # Trim history to the serving window instead of overflowing it on
            # long conversations. The explicit token limit takes priority over
            # mellea's model-name lookup, which returns nothing for a locally
            # served checkpoint and would leave history untrimmed.
            ctx=ChatContext(
                model_id=self._settings.model_id,
                token_context_length_limit=self._settings.context_tokens,
            ),
            model_options={
                ModelOption.STREAM: True,
                ModelOption.STREAM_TIMEOUT: self._settings.stream_timeout,
                ModelOption.TEMPERATURE: self._settings.temperature,
                ModelOption.MAX_NEW_TOKENS: self._settings.max_tokens,
            },
        )

        ctx = session.ctx.add(
            MelleaMessage("system", self._system_prompt(offering or []))
        )
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
    ) -> AsyncIterator[dict]:
        """Stream the assistant's reply to `user_content` as events.

        Each event is a dict with a `type`: `delta` carries a chunk of text,
        `tool` reports a tool call starting or finishing. `history` must not
        already contain `user_content`; this method adds it.

        When tools are in play the model may take several turns — call a tool,
        read the result, maybe call another — before it answers. Text from every
        turn is streamed as it arrives, so a preamble like "let me look that up"
        reaches the user immediately rather than after the search.
        """
        history = list(history)
        selected = await self.select_tools(history, user_content)

        session = self._chat_session(history, selected)
        action: MelleaMessage = MelleaMessage("user", user_content)
        thunk = None
        call_number = 0

        try:
            # One pass per model turn: tool rounds, then a final turn with no
            # tools on offer so the model has to answer.
            for round_number in range(self._settings.tool_max_rounds + 1):
                offering = selected if round_number < self._settings.tool_max_rounds else []
                thunk = await session.aact(
                    action,
                    await_result=False,
                    tool_calls=bool(offering),
                    model_options=(
                        {ModelOption.TOOLS: [self._tools[name] for name in offering]}
                        if offering
                        else None
                    ),
                )

                # astream() blocks on the backend queue and returns only the new
                # text since the previous call, so this loop does not spin.
                while not thunk.is_computed():
                    delta = await thunk.astream()
                    if delta:
                        yield {"type": "delta", "text": delta}

                calls = list(thunk.tool_calls or ())
                if not calls:
                    return

                results: list[ToolMessage] = []
                for call in calls:
                    call_number += 1
                    yield {
                        "type": "tool",
                        "phase": "start",
                        "id": call_number,
                        "name": call.name,
                        "args": _preview_args(call.args),
                    }
                    output, ok, elapsed_ms = await self._run_tool(call)
                    yield {
                        "type": "tool",
                        "phase": "end",
                        "id": call_number,
                        "name": call.name,
                        "ok": ok,
                        "ms": elapsed_ms,
                        "output": _clip(output, _OUTPUT_PREVIEW_CHARS),
                    }
                    results.append(
                        ToolMessage("tool", output, output, call.name, call.args, call)
                    )

                # Results go back to the model as `tool` turns. aact() appends
                # whatever action it is handed, so all but the last go into the
                # context here and the last becomes the next round's action.
                for message in results[:-1]:
                    session.ctx = session.ctx.add(message)
                action = results[-1]
        finally:
            # Leaving early (client abort, stop button, error) means the
            # llama-server is still producing tokens nobody will read.
            # cancel_generation() is a coroutine and we may already be inside a
            # cancelled task — where awaiting raises instead of running — so
            # detach it rather than awaiting.
            if thunk is not None and not thunk.is_computed():
                task = asyncio.ensure_future(thunk.cancel_generation())
                _pending.add(task)
                task.add_done_callback(_pending.discard)
            session.cleanup()

    async def select_tools(
        self, history: Iterable[Message], user_content: str
    ) -> list[str]:
        """Ask the model which tools, if any, the next reply needs.

        Returns tool names in a stable order, restricted to what is enabled.
        Fails closed: any error means an ordinary, tool-free turn, which is the
        behaviour a user notices least.
        """
        available = self.tool_names
        if not available:
            return []

        prompt = self._router_prompt(history, user_content, available)
        session = self._utility_session()
        try:
            result = await session.ainstruct(
                prompt,
                format=ToolChoice,
                # One cheap call in front of every message: no validate/repair
                # loop, and a hard fallback to "no tools" below.
                strategy=None,
                await_result=True,
            )
            choice = ToolChoice.model_validate_json(str(result))
            picked = [
                name
                for name in available
                if getattr(choice, name.replace("-", "_"), False)
            ]
            logger.info("Tool relevance: %s", picked or "none")
            return picked
        except Exception:
            logger.warning("Tool relevance query failed; skipping tools.", exc_info=True)
            return []
        finally:
            session.cleanup()

    def _router_prompt(
        self, history: Iterable[Message], user_content: str, available: list[str]
    ) -> str:
        """Build the prompt for the relevance query."""
        catalogue = "\n".join(f"- {name}: {TOOL_GUIDE[name]}" for name in available)
        lines = [
            "Decide which tools, if any, are needed to answer the user's latest "
            "message.",
            "",
            "Tools:",
            catalogue,
            "",
            "Rules:",
            "- Choose a tool only if a good answer is impossible without it — "
            "because the facts change, are obscure, or must be computed exactly.",
            "- Choose nothing for general knowledge, explanations, opinions, "
            "writing, chat, or code the user only wants to read.",
            "- More than one tool may be needed.",
            "",
        ]

        recent = list(history)[-_ROUTER_TURNS:]
        if recent:
            lines.append("Conversation so far:")
            for message in recent:
                text = " ".join(message.content.split())
                lines.append(f"{message.role}: {_clip(text, _ROUTER_CHARS)}")
            lines.append("")

        lines.append("Latest user message:")
        lines.append(_clip(" ".join(user_content.split()), _ROUTER_CHARS * 2))
        return "\n".join(lines)

    async def _run_tool(self, call: ModelToolCall) -> tuple[str, bool, int]:
        """Execute one tool call and report `(output, succeeded, milliseconds)`.

        Tools are synchronous and can block for seconds, so they run in a worker
        thread rather than on the event loop. Failures are turned into text for
        the model instead of exceptions: a broken tool should degrade the answer,
        not the conversation.
        """
        started = time.monotonic()
        try:
            output = await asyncio.to_thread(call.call_func)
            ok = True
        except Exception as exc:
            logger.warning("Tool %s failed", call.name, exc_info=True)
            output = f"The {call.name} tool failed: {exc}"
            ok = False
        elapsed_ms = int((time.monotonic() - started) * 1000)
        text = output if isinstance(output, str) else str(output)
        logger.info("Tool %s finished in %dms (%d chars)", call.name, elapsed_ms, len(text))
        return text, ok, elapsed_ms

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


def _clip(text: str, limit: int) -> str:
    """Shorten `text` to `limit` characters, marking that something was cut."""
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + "…"


def _preview_args(args: Mapping[str, Any]) -> dict[str, Any]:
    """Copy tool arguments for display, clipping anything long."""
    return {
        key: _clip(value, _ARG_PREVIEW_CHARS) if isinstance(value, str) else value
        for key, value in args.items()
    }
