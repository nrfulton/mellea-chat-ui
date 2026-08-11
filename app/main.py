"""FastAPI application: REST for chat management, streaming for generation.

The app is deliberately single-user — there is no auth, no per-user scoping, and
it binds to localhost by default. Bind it to a public interface only behind your
own authentication.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from .config import settings
from .engine import ChatEngine
from .store import Chat, ChatStore, SQLiteChatStore

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
)
logger = logging.getLogger("chat")

store: ChatStore = SQLiteChatStore(settings.db_path)
engine = ChatEngine(settings)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await store.connect()
    logger.info("SQLite ready at %s", settings.db_path)
    logger.info(
        "Inference via mellea -> %s (model %s)",
        settings.llama_base_url,
        settings.model_id,
    )
    try:
        yield
    finally:
        await store.close()


app = FastAPI(title="Chat Interface", lifespan=lifespan)


# --------------------------------------------------------------------------
# Request models
# --------------------------------------------------------------------------


class NewMessage(BaseModel):
    content: str = Field(min_length=1, max_length=100_000)

    @field_validator("content")
    @classmethod
    def not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("content must not be blank")
        return v


class RenameChat(BaseModel):
    title: str = Field(min_length=1, max_length=120)

    @field_validator("title")
    @classmethod
    def tidy(cls, v: str) -> str:
        title = " ".join(v.split())
        if not title:
            raise ValueError("title must not be blank")
        return title


# --------------------------------------------------------------------------
# Chat management
# --------------------------------------------------------------------------


async def _require_chat(chat_id: str) -> Chat:
    chat = await store.get_chat(chat_id)
    if chat is None:
        raise HTTPException(status_code=404, detail="Chat not found")
    return chat


@app.get("/api/chats")
async def list_chats() -> dict:
    chats = await store.list_chats()
    return {"chats": [c.to_dict() for c in chats]}


@app.post("/api/chats", status_code=201)
async def create_chat() -> dict:
    chat = await store.create_chat()
    return {"chat": chat.to_dict()}


@app.get("/api/chats/{chat_id}")
async def get_chat(chat_id: str) -> dict:
    chat = await _require_chat(chat_id)
    messages = await store.list_messages(chat_id)
    return {"chat": chat.to_dict(), "messages": [m.to_dict() for m in messages]}


@app.patch("/api/chats/{chat_id}")
async def rename_chat(chat_id: str, payload: RenameChat) -> dict:
    await _require_chat(chat_id)
    # is_auto=False: a manual rename is never overwritten by summarization.
    await store.set_title(chat_id, payload.title, is_auto=False)
    chat = await _require_chat(chat_id)
    return {"chat": chat.to_dict()}


@app.delete("/api/chats/{chat_id}", status_code=204)
async def delete_chat(chat_id: str):
    if not await store.delete_chat(chat_id):
        raise HTTPException(status_code=404, detail="Chat not found")
    return None


# --------------------------------------------------------------------------
# Generation
# --------------------------------------------------------------------------


def _event(kind: str, **payload) -> bytes:
    """Encode one NDJSON stream event."""
    return (json.dumps({"type": kind, **payload}) + "\n").encode("utf-8")


# Detached tasks need a strong reference or the loop may garbage-collect them
# mid-flight.
_background: set[asyncio.Task] = set()


def _spawn(coro) -> None:
    """Run `coro` independently of the current task.

    Used for work that must still happen after the client disconnects. Awaiting
    inside a cancelled task raises `CancelledError` immediately, so a detached
    task is the only way to finish a write once cancellation has begun.
    """
    task = asyncio.create_task(coro)
    _background.add(task)
    task.add_done_callback(_background.discard)


async def _persist_interrupted(chat_id: str, reply: str, fallback_title: str | None):
    """Save whatever streamed before the client went away."""
    try:
        if reply:
            await store.add_message(chat_id, "assistant", reply)
            logger.info("Saved partial reply for chat %s (%d chars)", chat_id, len(reply))
        if fallback_title is not None:
            await store.set_title(chat_id, fallback_title, is_auto=True)
    except Exception:
        logger.exception("Failed to persist interrupted reply for chat %s", chat_id)


@app.post("/api/chats/{chat_id}/messages")
async def send_message(chat_id: str, payload: NewMessage):
    """Persist a user turn and stream the assistant's reply as NDJSON.

    Event types: `user`, `delta`, `title`, `done`, `error`.
    """
    chat = await _require_chat(chat_id)
    content = payload.content.strip()

    # History as it stood *before* this turn; the engine appends the new turn.
    history = await store.list_messages(chat_id)
    user_message = await store.add_message(chat_id, "user", content)
    # Titles are generated from the first exchange only.
    should_title = chat.title_is_auto and len(history) == 0

    async def stream() -> AsyncIterator[bytes]:
        parts: list[str] = []
        interrupted = False
        # Track what has already been committed. A client can disconnect *after*
        # the reply is saved (during the title or done event), and the
        # interrupted-path must not then write a duplicate.
        saved = False
        titled = False
        try:
            yield _event("user", message=user_message.to_dict())

            try:
                async for delta in engine.stream_reply(history, content):
                    parts.append(delta)
                    yield _event("delta", text=delta)
            except (asyncio.CancelledError, GeneratorExit):
                # Client aborted (stop button or navigation): keep what we have.
                interrupted = True
                raise
            except Exception as exc:
                logger.exception("Generation failed")
                if not parts:
                    # Nothing to save; drop the orphaned user turn so a retry
                    # does not duplicate it in the history.
                    await store.delete_message(chat_id, user_message.id)
                    yield _event(
                        "error",
                        message=f"Inference failed: {exc}",
                        removed_message_id=user_message.id,
                    )
                    return
                yield _event("error", message=f"Generation interrupted: {exc}")

            reply = "".join(parts).strip()
            assistant_message = None
            if reply:
                assistant_message = await store.add_message(
                    chat_id, "assistant", reply
                )
                saved = True

            title = None
            if should_title and reply:
                title = await engine.summarize_title(content, reply)
                await store.set_title(chat_id, title, is_auto=True)
                titled = True
                yield _event("title", title=title)

            yield _event(
                "done",
                message=assistant_message.to_dict() if assistant_message else None,
                title=title,
            )
        except (asyncio.CancelledError, GeneratorExit):
            # A yield can also fail once the client is gone.
            interrupted = True
            raise
        finally:
            if interrupted:
                # This task is already cancelled, so awaiting here would raise
                # instead of writing. Hand the work to a detached task and let
                # the generator finish unwinding.
                _spawn(
                    _persist_interrupted(
                        chat_id,
                        "" if saved else "".join(parts).strip(),
                        engine.fallback_title(content)
                        if (should_title and not titled)
                        else None,
                    )
                )

    return StreamingResponse(
        stream(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


@app.post("/api/chats/{chat_id}/title")
async def regenerate_title(chat_id: str) -> dict:
    """Ask the model for a fresh sidebar title on demand."""
    await _require_chat(chat_id)
    messages = await store.list_messages(chat_id)
    if not messages:
        raise HTTPException(status_code=400, detail="Chat has no messages yet")

    first_user = next((m.content for m in messages if m.role == "user"), "")
    first_assistant = next((m.content for m in messages if m.role == "assistant"), "")
    title = await engine.summarize_title(first_user, first_assistant)
    await store.set_title(chat_id, title, is_auto=True)
    return {"title": title}


# --------------------------------------------------------------------------
# Health + static frontend
# --------------------------------------------------------------------------


@app.get("/api/health")
async def health() -> JSONResponse:
    """Report whether the llama-server behind mellea is answering."""
    try:
        reply = await engine.check_backend()
        return JSONResponse(
            {
                "ok": True,
                "model": settings.model_id,
                "endpoint": settings.llama_base_url,
                "reply": reply,
            }
        )
    except Exception as exc:
        logger.warning("Health probe failed: %s", exc)
        return JSONResponse(
            {"ok": False, "model": settings.model_id, "error": str(exc)},
            status_code=503,
        )


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(settings.static_dir / "index.html")


app.mount("/static", StaticFiles(directory=settings.static_dir), name="static")
