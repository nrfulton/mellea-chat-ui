"""Persistence layer.

`ChatStore` is the abstract interface the rest of the application talks to —
nothing outside this module writes SQL. `SQLiteChatStore` is the concrete
implementation; swapping in Postgres or an in-memory fake means subclassing
`ChatStore` and changing one line in `main.py`.

All methods are async. SQLite itself is synchronous, so the concrete store
hands each statement to a worker thread (`asyncio.to_thread`) and guards the
shared connection with a lock, which keeps the event loop responsive while a
generation is streaming.
"""

from __future__ import annotations

import asyncio
import sqlite3
import threading
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

# Roles we accept from callers. "system" is owned by the engine, not the store.
VALID_ROLES = ("user", "assistant")


def _now() -> str:
    """Current UTC time as an ISO-8601 string (sorts lexicographically).

    Microsecond precision matters: the sidebar orders chats by `updated_at`, and
    at second resolution two chats touched in the same second tie, leaving the
    order up to SQLite.
    """
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def _new_id() -> str:
    return uuid.uuid4().hex


@dataclass
class Message:
    """A single turn in a conversation."""

    id: int
    chat_id: str
    role: str
    content: str
    created_at: str

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "chat_id": self.chat_id,
            "role": self.role,
            "content": self.content,
            "created_at": self.created_at,
        }


@dataclass
class Chat:
    """A conversation thread shown in the sidebar."""

    id: str
    title: str
    created_at: str
    updated_at: str
    # True while the title is still the placeholder or an LLM-generated summary.
    # A manual rename clears it so we never overwrite the user's own wording.
    title_is_auto: bool = True
    message_count: int = 0
    preview: str = ""

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "title_is_auto": self.title_is_auto,
            "message_count": self.message_count,
            "preview": self.preview,
        }


class ChatStore(ABC):
    """Abstract persistence interface for chats and their messages."""

    # --- lifecycle ---

    @abstractmethod
    async def connect(self) -> None:
        """Open resources and ensure the schema exists."""

    @abstractmethod
    async def close(self) -> None:
        """Release resources."""

    # --- chats ---

    @abstractmethod
    async def create_chat(self, title: str = "New chat") -> Chat:
        """Create an empty chat and return it."""

    @abstractmethod
    async def list_chats(self) -> list[Chat]:
        """Return every chat, most recently active first."""

    @abstractmethod
    async def get_chat(self, chat_id: str) -> Chat | None:
        """Return one chat, or None if it does not exist."""

    @abstractmethod
    async def set_title(self, chat_id: str, title: str, *, is_auto: bool) -> None:
        """Set a chat's title.

        `is_auto=False` marks the title as user-owned so automatic
        summarization will not replace it later.
        """

    @abstractmethod
    async def delete_chat(self, chat_id: str) -> bool:
        """Delete a chat and its messages. Returns False if it did not exist."""

    # --- messages ---

    @abstractmethod
    async def add_message(self, chat_id: str, role: str, content: str) -> Message:
        """Append a message and bump the chat's `updated_at`."""

    @abstractmethod
    async def list_messages(self, chat_id: str) -> list[Message]:
        """Return a chat's messages in chronological order."""

    @abstractmethod
    async def delete_message(self, chat_id: str, message_id: int) -> bool:
        """Remove a single message. Returns False if it was not found."""


class SQLiteChatStore(ChatStore):
    """SQLite-backed `ChatStore`."""

    _SCHEMA = """
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS chats (
        id           TEXT PRIMARY KEY,
        title        TEXT NOT NULL,
        title_is_auto INTEGER NOT NULL DEFAULT 1,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content    TEXT NOT NULL,
        created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_chat
        ON messages (chat_id, id);
    CREATE INDEX IF NOT EXISTS idx_chats_updated
        ON chats (updated_at DESC);
    """

    def __init__(self, db_path: str | Path) -> None:
        self._db_path = Path(db_path)
        self._conn: sqlite3.Connection | None = None
        # Serializes access to the single shared connection across worker threads.
        self._lock = threading.Lock()

    # --- lifecycle ---

    async def connect(self) -> None:
        await asyncio.to_thread(self._connect_sync)

    def _connect_sync(self) -> None:
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self._db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.executescript(self._SCHEMA)
        conn.commit()
        self._conn = conn

    async def close(self) -> None:
        await asyncio.to_thread(self._close_sync)

    def _close_sync(self) -> None:
        with self._lock:
            if self._conn is not None:
                self._conn.close()
                self._conn = None

    # --- internals ---

    def _db(self) -> sqlite3.Connection:
        if self._conn is None:
            raise RuntimeError("Store is not connected; call connect() first.")
        return self._conn

    async def _run(self, fn, *args):
        """Run a synchronous unit of work against the connection off-loop."""

        def wrapped():
            with self._lock:
                return fn(self._db(), *args)

        return await asyncio.to_thread(wrapped)

    # --- chats ---

    async def create_chat(self, title: str = "New chat") -> Chat:
        chat = Chat(
            id=_new_id(),
            title=title,
            created_at=_now(),
            updated_at=_now(),
            title_is_auto=True,
        )

        def op(db: sqlite3.Connection) -> None:
            db.execute(
                "INSERT INTO chats (id, title, title_is_auto, created_at, updated_at)"
                " VALUES (?, ?, 1, ?, ?)",
                (chat.id, chat.title, chat.created_at, chat.updated_at),
            )
            db.commit()

        await self._run(op)
        return chat

    async def list_chats(self) -> list[Chat]:
        def op(db: sqlite3.Connection) -> list[sqlite3.Row]:
            return db.execute(
                """
                SELECT c.*,
                       (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id)
                           AS message_count,
                       (SELECT m.content FROM messages m
                         WHERE m.chat_id = c.id ORDER BY m.id LIMIT 1)
                           AS preview
                  FROM chats c
                 ORDER BY c.updated_at DESC, c.created_at DESC
                """
            ).fetchall()

        rows = await self._run(op)
        return [self._row_to_chat(r) for r in rows]

    async def get_chat(self, chat_id: str) -> Chat | None:
        def op(db: sqlite3.Connection) -> sqlite3.Row | None:
            return db.execute(
                """
                SELECT c.*,
                       (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id)
                           AS message_count,
                       (SELECT m.content FROM messages m
                         WHERE m.chat_id = c.id ORDER BY m.id LIMIT 1)
                           AS preview
                  FROM chats c
                 WHERE c.id = ?
                """,
                (chat_id,),
            ).fetchone()

        row = await self._run(op)
        return self._row_to_chat(row) if row is not None else None

    async def set_title(self, chat_id: str, title: str, *, is_auto: bool) -> None:
        def op(db: sqlite3.Connection) -> None:
            db.execute(
                "UPDATE chats SET title = ?, title_is_auto = ? WHERE id = ?",
                (title, 1 if is_auto else 0, chat_id),
            )
            db.commit()

        await self._run(op)

    async def delete_chat(self, chat_id: str) -> bool:
        def op(db: sqlite3.Connection) -> bool:
            cur = db.execute("DELETE FROM chats WHERE id = ?", (chat_id,))
            db.commit()
            return cur.rowcount > 0

        return await self._run(op)

    # --- messages ---

    async def add_message(self, chat_id: str, role: str, content: str) -> Message:
        if role not in VALID_ROLES:
            raise ValueError(f"role must be one of {VALID_ROLES}, got {role!r}")

        created_at = _now()

        def op(db: sqlite3.Connection) -> int:
            cur = db.execute(
                "INSERT INTO messages (chat_id, role, content, created_at)"
                " VALUES (?, ?, ?, ?)",
                (chat_id, role, content, created_at),
            )
            # Keep the sidebar ordered by real activity.
            db.execute(
                "UPDATE chats SET updated_at = ? WHERE id = ?", (created_at, chat_id)
            )
            db.commit()
            return int(cur.lastrowid)

        message_id = await self._run(op)
        return Message(
            id=message_id,
            chat_id=chat_id,
            role=role,
            content=content,
            created_at=created_at,
        )

    async def list_messages(self, chat_id: str) -> list[Message]:
        def op(db: sqlite3.Connection) -> list[sqlite3.Row]:
            return db.execute(
                "SELECT * FROM messages WHERE chat_id = ? ORDER BY id", (chat_id,)
            ).fetchall()

        rows = await self._run(op)
        return [
            Message(
                id=r["id"],
                chat_id=r["chat_id"],
                role=r["role"],
                content=r["content"],
                created_at=r["created_at"],
            )
            for r in rows
        ]

    async def delete_message(self, chat_id: str, message_id: int) -> bool:
        def op(db: sqlite3.Connection) -> bool:
            cur = db.execute(
                "DELETE FROM messages WHERE id = ? AND chat_id = ?",
                (message_id, chat_id),
            )
            db.commit()
            return cur.rowcount > 0

        return await self._run(op)

    # --- mapping ---

    @staticmethod
    def _row_to_chat(row: sqlite3.Row) -> Chat:
        preview = row["preview"] or ""
        return Chat(
            id=row["id"],
            title=row["title"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            title_is_auto=bool(row["title_is_auto"]),
            message_count=row["message_count"],
            preview=" ".join(preview.split())[:120],
        )
