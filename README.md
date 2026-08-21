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
- **Generation never blocks the UI.** Start a new chat or open another one while a
  reply is still streaming; it keeps running and picks up where it left off when
  you come back. Several chats can generate at once, and the sidebar marks the
  ones still working.
- **Tools: web search and a Python interpreter.** Before each reply a cheap query
  decides whether either could matter; only the relevant ones are offered to the
  model, and anything it calls is executed and fed back so it answers from real
  results. The UI shows what ran, with the output folded away behind it.
- **Markdown rendering** — code blocks with copy buttons, lists, tables, quotes.
- **LaTeX rendering.** `\[ ... \]`, `\( ... \)`, `$$ ... $$`, cautious `$ ... $` and
  the usual environments (`align`, `cases`, `pmatrix`, ...) are typeset with KaTeX.
- **Rename, regenerate title, delete.** A manual rename is never overwritten, and
  deletes are soft — the rows stay on disk behind a flag.
- **Policy guards.** When the app is pointed at an `m mitm --admin` proxy, the shield
  in the sidebar footer opens a panel that manages the behavioural policies that
  proxy screens replies against — create, edit, switch on and off, delete, live on
  the next reply. See [Policy guards](#policy-guards).
- Light and dark themes, keyboard shortcuts, and no build step. KaTeX is vendored
  rather than loaded from a CDN, so nothing is fetched at runtime.

## Requirements

- Python 3.10+
- A reachable `llama-server` exposing the OpenAI-compatible `/v1` API
- `pip install -r requirements.txt`

The tools need nothing extra: search goes through `urllib`, and the interpreter
runs the same `python3` in a subprocess. The model must support tool calling —
Granite does, and a backend that does not will simply answer in prose.

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
| `LLAMA_BASE_URL` | `http://127.0.0.1:8080/v1` | llama-server OpenAI endpoint |
| `LLAMA_MODEL_ID` | *auto-detected* | Pin a model name instead of asking the endpoint |
| `CONTEXT_TOKENS` | `32768` | Token budget for history trimming |
| `DB_PATH` | `./data/chat.db` | SQLite file |
| `SYSTEM_PROMPT` | see `app/config.py` | System prompt for every chat |
| `TEMPERATURE` | `0.7` | Sampling temperature |
| `MAX_TOKENS` | `2048` | Max tokens per reply |
| `STREAM_TIMEOUT` | `120` | Seconds to wait for one chunk |
| `HOST` / `PORT` | `127.0.0.1` / `8000` | Bind address |

The policy guard panel is off until you point it at a proxy:

| Variable | Default | Purpose |
|---|---|---|
| `MITM_BASE_URL` | *empty* | Base URL of an `m mitm --admin` proxy. Empty hides the panel |
| `MITM_TOKEN` | *empty* | Must match the proxy's `--admin-token` |
| `MITM_TIMEOUT` | `10` | Seconds to wait on a control-plane call |

Tools have their own block, all optional:

| Variable | Default | Purpose |
|---|---|---|
| `TOOLS_ENABLED` | `1` | Master switch. `0` skips the relevance query entirely |
| `WEB_SEARCH_ENABLED` | `1` | Offer `web_search` |
| `PYTHON_TOOL_ENABLED` | `1` | Offer `run_python` (see the warning below) |
| `TOOL_MAX_ROUNDS` | `2` | Tool-calling turns before the model must answer |
| `TOOL_OUTPUT_CHARS` | `4000` | Cap on what one tool may return to the model |
| `SEARCH_PROVIDER` | `duckduckgo` | `duckduckgo` (HTML scrape) or `searxng` (JSON API) |
| `SEARCH_URL` | provider default | Override the endpoint, e.g. your SearxNG `/search` |
| `SEARCH_RESULTS` | `5` | Results shown to the model |
| `SEARCH_TIMEOUT` | `12` | Seconds per search request |
| `PYTHON_TIMEOUT` | `15` | Wall-clock and CPU seconds per program |
| `PYTHON_MEMORY_MB` | `512` | Address-space limit per program |

Check connectivity at any time:

```bash
curl localhost:8000/api/health
# {"ok":true,"model":"ibm-granite/granite-4.1-30b","endpoint":"…",
#  "tools":["web_search","run_python"],"reply":"OK",
#  "guards":{"configured":true,"available":true,"count":2}}
```

The status dot at the bottom of the sidebar reflects the same probe. `guards` is
reported whether or not inference is healthy, because the proxy can be answering
while the model behind it is not — the panel stays reachable either way.

## Policy guards

[`m mitm`](https://docs.mellea.ai) is a mellea proxy that fronts an
OpenAI-compatible server and screens the replies it relays against behavioural
policies in the [`granite.trust.policy-tools`](https://github.com/ibm-granite/granite.trust.policy-tools)
schema. Each policy names a risk group; each risk under it lists what a reply
`reply_cannot_contain`, and a reply that trips one is replaced by a refusal composed
from that risk's `reply_may_contain` guidance.

Those policies are otherwise fixed when the proxy starts. Start it with `--admin` and
this app can manage them while it runs:

```bash
# 1. the proxy, in front of llama-server, with the control plane on
m mitm --upstream http://127.0.0.1:8080 \
       --policy policies/ --admin --admin-token s3cret \
       --host 127.0.0.1 --port 8081

# 2. this app, managing that proxy *and* generating through it
MITM_BASE_URL=http://127.0.0.1:8081 MITM_TOKEN=s3cret \
LLAMA_BASE_URL=http://127.0.0.1:8081/v1 ./run.sh
```

The shield button appears in the sidebar footer once the proxy answers. Everything the
panel does takes effect on the next reply the proxy screens; there is nothing to
restart and nothing written to disk, so a policy lives only as long as the proxy does.

**Two independent settings.** `MITM_BASE_URL` decides which proxy's guards you
*manage*; `LLAMA_BASE_URL` decides where replies *come from*. Point the second at the
proxy as above and the guards apply to these chats. Leave it at llama-server and the
panel still works, but it is administering a proxy other clients use — nothing you
say in this window is screened.

**Switch off versus delete.** A parked policy stays registered and editable but is not
screened against, which also means it stops costing anything: each restriction is a
separate model call on every reply, so a long policy is a slower proxy. Deleting is
what forgets it.

**The proxy owns validation.** The form does not check the schema — it sends the
document and shows whatever the proxy says, so an error names the field mellea itself
objected to.

> **Note:** the control plane can delete a guardrail, and `m mitm` binds every
> interface unless told otherwise. Give it an `--admin-token` and bind it to loopback,
> as above.

## Layout

```
app/
  config.py   Environment-driven settings
  store.py    ChatStore (abstract) + SQLiteChatStore
  engine.py   Mellea orchestration: streaming replies, tool rounds, titles
  tools.py    The two tools themselves: web search and the Python subprocess
  policies.py Client for the m mitm policy control plane
  main.py     FastAPI routes and the NDJSON streaming endpoint
static/
  index.html  Single page
  style.css   Theme
  app.js      UI, per-chat streaming client, small Markdown renderer
  math.js     Finds LaTeX in model output and hands it to KaTeX
  vendor/     KaTeX (MIT), js + css + woff2 fonts, ~600 KB
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
reply streams.

**Deletes are soft.** `delete_chat` and `delete_message` set `deleted = 1` and
stamp `deleted_at`; no statement in `store.py` removes a row, and every read
filters the flag out. So a delete hides data instead of destroying it, and
recovering one is a single `UPDATE`:

```sql
UPDATE chats SET deleted = 0, deleted_at = NULL WHERE id = '…';
```

Deleting a chat flags only the chat row — its messages keep `deleted = 0` and
become unreachable through it, so a restore does not have to guess which
messages the user had already deleted individually. Because the foreign key
still matches a soft-deleted chat, `add_message` checks the flag itself and
raises `LookupError` rather than writing into a deleted conversation. On an
existing database the two columns are added by an `ALTER TABLE` migration at
startup.

### Inference

`app/engine.py` is the only module that touches a model. Every entry point builds
a mellea session pointed at `llama_base_url` through mellea's OpenAI-compatible
backend:

- `stream_reply()` rebuilds a `ChatContext` from the rows in SQLite, appends the
  new user turn, and yields deltas as they arrive. Mellea contexts are immutable
  (`ctx.add()` returns a new context), so history is rebuilt per request and
  chats cannot leak into one another — the database stays the single source of
  truth. Passing `model_id` to `ChatContext` lets mellea trim history to the
  model's context window instead of overflowing it.
  Each request builds its own session, so generations for different chats are
  independent and run in parallel — which is what lets the UI leave one chat
  streaming while you work in another.
  It also drives the tool loop described below, streaming text from every model
  turn — not just the last one — so the user is never watching a blank bubble
  while a tool runs.
- `select_tools()` is the relevance query in front of it, and `_run_tool()`
  executes whatever comes back. See [Tools](#tools).
- `summarize_title()` uses a separate, historyless session so titling never
  pollutes the conversation, and `format=ChatTitle` to constrain the output to
  JSON. If the model is unreachable or returns something unusable it falls back
  to a truncation of the user's own words — a failed title never breaks a working
  chat.

**The model is not hardcoded.** At startup — and again on every health probe, so
swapping the checkpoint under a running app is picked up on the next page load —
`resolve_model_id()` asks the endpoint's `/v1/models` what it has loaded and uses
that. Both response shapes are accepted: OpenAI's `data[].id` and the
`models[].model` list llama-server also emits. This matters less for generation
than it looks — llama-server ignores the requested model name and serves whatever
is loaded — and more for honesty: a pinned name that has drifted makes
`/api/health` and the sidebar report a model the box is not running. If the
endpoint serves several models the first is used; set `LLAMA_MODEL_ID` to pin one
explicitly, which skips discovery entirely. If the endpoint is unreachable the app
still starts, labels the model `local-model`, and retries on the next probe.

### Tools

Everything here runs through mellea: the tools are `MelleaTool` objects passed as
`ModelOption.TOOLS`, and mellea derives each JSON schema from the function
signature and its `Args:` docstring, so the docstring *is* the model's briefing.
A turn has three stages.

**1. Is a tool relevant?** `select_tools()` asks the model, over the last few
turns plus the new message, with `format=ToolChoice` — constrained decoding, so
the answer is `{"web_search": false, "run_python": true}` rather than a paragraph
about what it might do. Two properties matter more than accuracy here: it is one
short call, and it **fails closed**. Any error, any unparseable answer, and the
turn simply runs without tools, which is the outcome a user notices least. The
decision is logged as `Tool relevance: [...]`.

**2. Generate with only those tools.** The selected tools go into the generation
call, and the system prompt gains a matching policy line. That addendum is not
decoration: handed schemas and nothing else, the model will cheerfully do
ten-digit arithmetic in its head and get it wrong, so it is told to *call*
`run_python` rather than describe the call. Streaming is unaffected — text
arrives token-by-token while tool calls accumulate, so "let me look that up"
reaches the user before the search does.

**3. Execute and feed back.** Each call is run in a worker thread (tools block
for seconds; the event loop must not) and returned to the model as a `tool`
message carrying its `tool_call_id`, exactly as the OpenAI protocol expects. The
model may then call again, up to `TOOL_MAX_ROUNDS`; the final turn is issued with
no tools on offer, so it has to answer. A tool that raises does not break the
conversation — the exception is turned into text the model can read and work
around.

Two deliberate choices:

- **`format=` and tool calling are mutually exclusive** in mellea's OpenAI
  backend (constrained decoding supersedes tools), which is why the relevance
  query is a separate, historyless session rather than a preamble to the real one.
- **Tool traces are progress, not transcript.** Only the prose is stored, so the
  database schema is untouched, later turns are not cluttered with search dumps,
  and a reload shows the conversation rather than the machinery.

`web_search` defaults to DuckDuckGo's no-JavaScript HTML endpoint, over POST,
which is what that page's own form uses and is challenged far less than GET.
Being honest about it: **there is no API key and no SLA here.** A burst of
searches gets an automated-traffic challenge (HTTP 202 and no results), and an
IP that has been hammered stays throttled for a while. On failure the tool
returns advice rather than an error — answer from your own knowledge and tell the
user the search did not work — so a throttled search degrades the answer instead
of breaking the turn. If you want reliability, run a
[SearxNG](https://docs.searxng.org) instance with `json` in its `search.formats`
and point the app at it:

```bash
SEARCH_PROVIDER=searxng SEARCH_URL=http://127.0.0.1:8888/search ./run.sh
```

> **`run_python` executes model-authored code on this machine.** It gets a
> separate process in isolated mode (`python -I`), a wiped environment — not
> `os.environ`, so endpoints and keys stay out of reach — a throwaway working
> directory, its own process group, and `RLIMIT_AS` / `RLIMIT_CPU` /
> `RLIMIT_FSIZE` plus a wall-clock timeout. That is damage control, **not a
> sandbox**: the code still runs as the server user, can read what that user can
> read, and can open network connections. There is no authentication in front of
> it either (see Notes). Acceptable for a single user on localhost, which is what
> this app is; anything else, set `PYTHON_TOOL_ENABLED=0`.

### Math

Model output is full of LaTeX, and Markdown and LaTeX disagree about `_`, `^`
and `*`: run the Markdown pass first and `a_1 + a_2` becomes
`a<em>1 + a</em>2`, with the original unrecoverable. KaTeX's own auto-render
extension has the same problem — it walks the DOM after the damage is done.

So `static/math.js` lifts math out of the raw text *before* the Markdown pass,
leaving NUL sentinels that survive HTML-escaping and every emphasis rule, and
substitutes rendered KaTeX at the very end. Fenced blocks and inline code are
skipped, so `` `\frac{a}{b}` `` stays literal when the subject *is* LaTeX.
`$ ... $` is only treated as math when it looks structural, so "it costs $5 and
$7" is left alone. An opener whose closer has not streamed in yet stays literal
and re-renders when the rest arrives, and `throwOnError: false` keeps one bad
expression from taking down the message around it.

KaTeX runs with `trust: false` (no `\href`, `\url`, `\includegraphics`) and a
`maxExpand` cap against macro-expansion bombs.

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/chats` | List chats for the sidebar |
| `POST` | `/api/chats` | Create a chat |
| `GET` | `/api/chats/{id}` | Chat plus its messages |
| `PATCH` | `/api/chats/{id}` | Rename (marks the title user-owned) |
| `DELETE` | `/api/chats/{id}` | Soft-delete a chat and its messages |
| `POST` | `/api/chats/{id}/messages` | Send a message, stream the reply |
| `POST` | `/api/chats/{id}/title` | Regenerate the title now |
| `GET` | `/api/health` | Probe the llama-server and the policy proxy |
| `GET` | `/api/policies` | List the proxy's policies, enforced or parked |
| `GET` | `/api/policies/{key}` | One policy, by risk group name or id |
| `POST` | `/api/policies` | Register a policy (`409` if the name is taken) |
| `PUT` | `/api/policies/{key}` | Replace a policy, optionally renaming it |
| `PATCH` | `/api/policies/{key}` | `{"enabled": bool}` — enforce or park it |
| `DELETE` | `/api/policies/{key}` | Forget a policy |

The `/api/policies` routes are a thin pass-through onto the proxy's own control
plane, so the browser never talks to the proxy and the admin token stays here. They
answer `503` when `MITM_BASE_URL` is unset or the proxy cannot be reached, and relay
the proxy's status and message otherwise — a malformed policy comes back as the `422`
mellea's own parser produced.

`POST /api/chats/{id}/messages` streams newline-delimited JSON — one object per
line — rather than SSE, so the client can POST the message and abort mid-stream:

```json
{"type": "user",  "message": {"id": 1, "role": "user", "content": "…"}}
{"type": "delta", "text": "Let me compute"}
{"type": "delta", "text": " that exactly.\n\n"}
{"type": "tool",  "phase": "start", "id": 1, "name": "run_python", "args": {"code": "…"}}
{"type": "tool",  "phase": "end",   "id": 1, "name": "run_python", "ok": true, "ms": 412,
                  "output": "4826665561"}
{"type": "delta", "text": "The exact product is 4826665561."}
{"type": "title", "title": "Exact Product Of Two Numbers"}
{"type": "done",  "message": {"id": 2, "role": "assistant", "content": "…"}}
```

`tool` events are paired by `id` and are display-only — they are not persisted,
and only `delta` text becomes the stored reply. Long `args` and `output` are
clipped for the browser; the model sees the full text.

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
it on a network — and note that with `run_python` enabled, anyone who can reach
the port can get code executed on the box by asking for it. Model output is
HTML-escaped before Markdown rendering, and links are restricted to `http(s)`
and `mailto`.

Soft-deleted rows are never purged automatically. On a long-lived database,
reclaim them yourself when you are sure you want them gone:

```sql
DELETE FROM messages WHERE deleted = 1;
DELETE FROM chats    WHERE deleted = 1;   -- cascades to remaining messages
```
