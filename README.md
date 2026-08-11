# Chat Interface

A clean, single-user chat UI. [Mellea](https://docs.mellea.ai) orchestrates every
inference call against a `llama-server` instance, conversations persist in SQLite,
and the sidebar titles are short summaries written by the model itself.

```
┌────────────────┬──────────────────────────────────────┐
│ + New chat     │  Reversing a Linked List in C     ⟳ ✎ 🗑│
│ ─────────────  ├──────────────────────────────────────┤
│ Reversing a…   │  YOU  How do I reverse a linked list? │
│ 4 messages     │                                      │
│                │  AI   You walk the list re-pointing…  │
│ B-Tree Index…  │                                      │
│ 2 messages     ├──────────────────────────────────────┤
│                │  [ Send a message…              ] ▶  │
│ ● granite-4.1  │  Enter to send · Shift+Enter newline  │
└────────────────┴──────────────────────────────────────┘
```

## Features

- **Multiple conversations** in a sidebar, ordered by recent activity, with search.
- **Model-written titles.** After the first exchange the LLM summarizes it into a
  title of at most six words, using constrained decoding so the reply is
  parseable JSON rather than "Sure! Here's a title:".
- **Token-by-token streaming** with a stop button. Stopping keeps the partial reply.
- **Markdown rendering** — code blocks with copy buttons, lists, tables, quotes.
- **Rename, regenerate title, delete.** A manual rename is never overwritten.
- Light and dark themes, keyboard shortcuts, and no build step or CDN dependency.

## Requirements

- Python 3.10+
- A reachable `llama-server` exposing the OpenAI-compatible `/v1` API
- `pip install -r requirements.txt`

## Run

```bash
./run.sh                 # http://127.0.0.1:8000
```

Or directly:

```bash
python3 -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

### Configuration

Everything is environment-driven; the defaults match this deployment.

| Variable | Default | Purpose |
|---|---|---|
| `LLAMA_BASE_URL` | `http://9.105.22.23:8080/v1` | llama-server OpenAI endpoint |
| `LLAMA_MODEL_ID` | `ibm-granite/granite-4.1-30b` | Model name to request |
| `DB_PATH` | `./data/chat.db` | SQLite file |
| `SYSTEM_PROMPT` | see `app/config.py` | System prompt for every chat |
| `TEMPERATURE` | `0.7` | Sampling temperature |
| `MAX_TOKENS` | `2048` | Max tokens per reply |
| `STREAM_TIMEOUT` | `120` | Seconds to wait for one chunk |
| `HOST` / `PORT` | `127.0.0.1` / `8000` | Bind address |

Check connectivity at any time:

```bash
curl localhost:8000/api/health
# {"ok":true,"model":"ibm-granite/granite-4.1-30b","endpoint":"…","reply":"OK"}
```

The status dot at the bottom of the sidebar reflects the same probe.

## Layout

```
app/
  config.py   Environment-driven settings
  store.py    ChatStore (abstract) + SQLiteChatStore
  engine.py   Mellea orchestration: streaming replies, title summarization
  main.py     FastAPI routes and the NDJSON streaming endpoint
static/
  index.html  Single page
  style.css   Theme
  app.js      UI, streaming client, small Markdown renderer
```

### Persistence

All SQL lives behind `ChatStore`, the abstract base class in `app/store.py`:

```python
class ChatStore(ABC):
    async def connect(self) -> None: ...
    async def create_chat(self, title: str = "New chat") -> Chat: ...
    async def list_chats(self) -> list[Chat]: ...
    async def get_chat(self, chat_id: str) -> Chat | None: ...
    async def set_title(self, chat_id: str, title: str, *, is_auto: bool) -> None: ...
    async def delete_chat(self, chat_id: str) -> bool: ...
    async def add_message(self, chat_id: str, role: str, content: str) -> Message: ...
    async def list_messages(self, chat_id: str) -> list[Message]: ...
    async def delete_message(self, chat_id: str, message_id: int) -> bool: ...
    async def close(self) -> None: ...
```

Nothing outside this module writes SQL, so a different database means writing one
subclass and changing the single instantiation in `app/main.py`. SQLite is
synchronous, so `SQLiteChatStore` runs each statement in a worker thread and
guards the shared connection with a lock — the event loop stays free while a
reply streams. `messages.chat_id` cascades on delete, so removing a chat removes
its history.

### Inference

`app/engine.py` is the only module that touches a model. Both entry points build
a mellea session pointed at `llama_base_url` through mellea's OpenAI-compatible
backend:

- `stream_reply()` rebuilds a `ChatContext` from the rows in SQLite, appends the
  new user turn, and yields deltas as they arrive. Mellea contexts are immutable
  (`ctx.add()` returns a new context), so history is rebuilt per request and
  chats cannot leak into one another — the database stays the single source of
  truth. Passing `model_id` to `ChatContext` lets mellea trim history to the
  model's context window instead of overflowing it.
- `summarize_title()` uses a separate, historyless session so titling never
  pollutes the conversation, and `format=ChatTitle` to constrain the output to
  JSON. If the model is unreachable or returns something unusable it falls back
  to a truncation of the user's own words — a failed title never breaks a working
  chat.

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/chats` | List chats for the sidebar |
| `POST` | `/api/chats` | Create a chat |
| `GET` | `/api/chats/{id}` | Chat plus its messages |
| `PATCH` | `/api/chats/{id}` | Rename (marks the title user-owned) |
| `DELETE` | `/api/chats/{id}` | Delete a chat and its messages |
| `POST` | `/api/chats/{id}/messages` | Send a message, stream the reply |
| `POST` | `/api/chats/{id}/title` | Regenerate the title now |
| `GET` | `/api/health` | Probe the llama-server |

`POST /api/chats/{id}/messages` streams newline-delimited JSON — one object per
line — rather than SSE, so the client can POST the message and abort mid-stream:

```json
{"type": "user",  "message": {"id": 1, "role": "user", "content": "…"}}
{"type": "delta", "text": "A B-tree"}
{"type": "delta", "text": " index is…"}
{"type": "title", "title": "B-Tree Index Basics"}
{"type": "done",  "message": {"id": 2, "role": "assistant", "content": "…"}}
```

An `error` event carries a message; if generation failed before producing any
text it also carries `removed_message_id`, because the server discards the
orphaned user turn so a retry does not duplicate it.

## Shortcuts

| Key | Action |
|---|---|
| `Enter` | Send |
| `Shift` + `Enter` | Newline |
| `Ctrl/Cmd` + `K` | Focus search |
| `Ctrl/Cmd` + `Shift` + `O` | New chat |

## Notes

This is intentionally single-user: there is no authentication and no per-user
scoping, and it binds to localhost. Put it behind your own auth before exposing
it on a network. Model output is HTML-escaped before Markdown rendering, and
links are restricted to `http(s)` and `mailto`.
