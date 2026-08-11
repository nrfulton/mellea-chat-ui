"""Tools the model can call, wired up as mellea tools.

Two are available:

* `web_search` — queries a search engine over plain HTTP and returns ranked
  titles, URLs and snippets.
* `run_python` — runs a short program in a throwaway subprocess and returns
  whatever it printed.

`build_tools` hands back `MelleaTool` objects, which is what mellea's backends
expect in `ModelOption.TOOLS`. They are built from `Settings` rather than
declared at module scope because their endpoints, timeouts and limits are
configurable — and because tests need to point the search tool at a stub.

SECURITY: `run_python` executes model-authored code on this machine. It gets a
separate process, a wiped environment, a fresh working directory, and CPU,
memory, file-size and wall-clock limits — but this is damage control, not a
sandbox. The code can still read anything the server user can read and can open
network connections. This app is single-user and binds to localhost; keep it
that way, or set `PYTHON_TOOL_ENABLED=0`.
"""

from __future__ import annotations

import json
import logging
import math
import os
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

from mellea.backends.tools import MelleaTool

from .config import Settings

logger = logging.getLogger(__name__)

WEB_SEARCH = "web_search"
RUN_PYTHON = "run_python"

# Shown to the model when it is asked which tools a turn needs. Deliberately
# concrete: that is a small, fast call, and it decides better from examples than
# from adjectives.
TOOL_GUIDE: dict[str, str] = {
    WEB_SEARCH: (
        "look something up online — current events, prices, weather, sports "
        "results, release versions, someone's recent work, a specific page the "
        "user names, or anything that may have changed since training"
    ),
    RUN_PYTHON: (
        "run Python for an exact answer — arithmetic beyond a couple of digits, "
        "statistics over data in the conversation, date arithmetic, parsing or "
        "transforming text, or checking what a snippet really prints"
    ),
}

# A browser-ish identity. The HTML endpoints used here serve a JS challenge to
# clients that look automated, and there is no API to ask instead.
_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

_DDG_ENDPOINT = "https://html.duckduckgo.com/html/"
_SNIPPET_CHARS = 320


class ToolError(RuntimeError):
    """A tool could not run at all, as opposed to running and finding nothing."""


# ---------------------------------------------------------------------------
# Web search
# ---------------------------------------------------------------------------


class _DuckDuckGoParser(HTMLParser):
    """Pull `(title, url, snippet)` triples out of DuckDuckGo's HTML results.

    The markup is stable and shallow — each result contributes an `a.result__a`
    (title and link) and an `a.result__snippet` — so a small state machine over
    anchors is enough, and survives the surrounding layout being rearranged.
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.results: list[dict[str, str]] = []
        self._mode: str | None = None
        self._buf: list[str] = []
        self._href = ""

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "a":
            return
        classes = (dict(attrs).get("class") or "").split()
        if "result__a" in classes:
            self._mode = "title"
            self._href = dict(attrs).get("href") or ""
            self._buf = []
        elif "result__snippet" in classes:
            self._mode = "snippet"
            self._buf = []

    def handle_endtag(self, tag: str) -> None:
        if tag != "a" or self._mode is None:
            return
        text = " ".join("".join(self._buf).split())
        if self._mode == "title":
            url = _unwrap_redirect(self._href)
            # Sponsored results redirect through /y.js; they are not answers.
            if url and "duckduckgo.com/y.js" not in url:
                self.results.append({"title": text, "url": url, "snippet": ""})
        elif self.results and not self.results[-1]["snippet"]:
            self.results[-1]["snippet"] = text
        self._mode = None
        self._buf = []

    def handle_data(self, data: str) -> None:
        if self._mode is not None:
            self._buf.append(data)


def _unwrap_redirect(href: str) -> str:
    """Turn a DuckDuckGo click-tracking link into the destination it points at."""
    if not href:
        return ""
    if href.startswith("//"):
        href = "https:" + href
    parsed = urllib.parse.urlparse(href)
    if "uddg" in urllib.parse.parse_qs(parsed.query):
        target = urllib.parse.parse_qs(parsed.query)["uddg"][0]
        return target or href
    return href


def _http(
    url: str,
    *,
    timeout: float,
    data: bytes | None = None,
    accept: str = "text/html,application/xhtml+xml",
) -> tuple[int, str]:
    """Fetch `url` and return `(status, body)`; `data` makes it a POST."""
    request = urllib.request.Request(
        url,
        data=data,
        headers={
            "User-Agent": _USER_AGENT,
            "Accept": accept,
            "Accept-Language": "en-US,en;q=0.9",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            charset = response.headers.get_content_charset() or "utf-8"
            return response.status, raw.decode(charset, errors="replace")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        return exc.code, body
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ToolError(f"could not reach the search endpoint ({exc})") from exc


def _search_duckduckgo(
    query: str, endpoint: str, timeout: float
) -> list[dict[str, str]]:
    """Search via DuckDuckGo's no-JavaScript HTML endpoint.

    POST is what the page's own form uses, and it is challenged noticeably less
    often than GET. Rapid bursts still get a JS challenge (HTTP 202 and no
    results), which surfaces as an empty list.
    """
    payload = urllib.parse.urlencode({"q": query, "kl": "wt-wt"}).encode("utf-8")
    status, body = _http(endpoint, timeout=timeout, data=payload)
    parser = _DuckDuckGoParser()
    parser.feed(body)
    if not parser.results and status != 200:
        raise ToolError(f"search endpoint returned HTTP {status}")
    return parser.results


def _search_searxng(query: str, endpoint: str, timeout: float) -> list[dict[str, str]]:
    """Search a SearxNG instance through its JSON API.

    Preferred when you run one: no scraping, no rate-limit roulette. The
    instance must have `json` in its `search.formats`.
    """
    url = endpoint + ("&" if "?" in endpoint else "?") + urllib.parse.urlencode(
        {"q": query, "format": "json", "language": "en"}
    )
    status, body = _http(url, timeout=timeout, accept="application/json")
    if status != 200:
        raise ToolError(f"search endpoint returned HTTP {status}")
    try:
        payload = json.loads(body)
    except ValueError as exc:
        raise ToolError(
            "search endpoint did not return JSON — does this instance allow "
            "format=json?"
        ) from exc
    return [
        {
            "title": str(item.get("title") or "").strip(),
            "url": str(item.get("url") or "").strip(),
            "snippet": " ".join(str(item.get("content") or "").split()),
        }
        for item in payload.get("results", [])
        if item.get("url")
    ]


_PROVIDERS = {
    "duckduckgo": (_search_duckduckgo, _DDG_ENDPOINT),
    "searxng": (_search_searxng, ""),
}


def _format_results(query: str, results: list[dict[str, str]], limit: int) -> str:
    """Render results as the flat, quotable text the model reads."""
    lines = [f'Web search results for "{query}":', ""]
    for index, item in enumerate(results[:limit], start=1):
        lines.append(f"{index}. {item['title'] or item['url']}")
        lines.append(f"   {item['url']}")
        snippet = item["snippet"]
        if snippet:
            if len(snippet) > _SNIPPET_CHARS:
                snippet = snippet[:_SNIPPET_CHARS].rstrip() + "…"
            lines.append(f"   {snippet}")
        lines.append("")
    lines.append(
        "Answer from these results and cite the URLs you used. If they do not "
        "cover the question, say so instead of guessing."
    )
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Python interpreter
# ---------------------------------------------------------------------------

# Runs in the child, before the model's code, to bound what that code can do.
# Limits are set here rather than in a `preexec_fn` because the caller is a
# worker thread, where forking with a Python callback is unsafe. `runpy` keeps
# the program in its own file so tracebacks point at real line numbers.
_BOOTSTRAP = """\
import resource
import runpy
import sys

resource.setrlimit(resource.RLIMIT_AS, ({memory}, {memory}))
resource.setrlimit(resource.RLIMIT_CPU, ({cpu}, {cpu}))
resource.setrlimit(resource.RLIMIT_FSIZE, ({fsize}, {fsize}))

sys.argv = ["main.py"]
runpy.run_path("main.py", run_name="__main__")
"""

_MAX_FILE_BYTES = 16 * 1024 * 1024


def _execute_python(code: str, settings: Settings) -> str:
    """Run `code` in a fresh process and return its output as text."""
    timeout = settings.python_timeout
    with tempfile.TemporaryDirectory(prefix="chat-python-") as workdir:
        work = Path(workdir)
        (work / "main.py").write_text(code, encoding="utf-8")
        (work / "_sandbox.py").write_text(
            _BOOTSTRAP.format(
                memory=settings.python_memory_mb * 1024 * 1024,
                # A CPU-time cap as well as a wall-clock one, so a busy loop
                # dies even if the process ignores signals. For a spinning loop
                # this is what fires first, so keep the two in step.
                cpu=max(1, math.ceil(timeout)),
                fsize=_MAX_FILE_BYTES,
            ),
            encoding="utf-8",
        )

        process = subprocess.Popen(
            # -I: isolated mode. No user site-packages, no PYTHON* variables, no
            # implicit cwd on sys.path.
            [sys.executable, "-I", "_sandbox.py"],
            cwd=work,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            errors="replace",
            # Deliberately not os.environ: the server's environment holds
            # endpoints and keys the model has no business reading.
            env={
                "PATH": "/usr/bin:/bin",
                "HOME": str(work),
                "TMPDIR": str(work),
                "LC_ALL": "C.UTF-8",
                "PYTHONIOENCODING": "utf-8",
            },
            # Own process group, so a timeout can take the whole tree with it.
            start_new_session=True,
        )
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            _kill_group(process)
            stdout, stderr = process.communicate()
            return _compose_output(
                stdout,
                stderr,
                None,
                note=f"The program was still running after {timeout:g}s and was "
                "stopped. Print partial results early, or use a cheaper method.",
            )
        return _compose_output(stdout, stderr, process.returncode)


def _kill_group(process: subprocess.Popen) -> None:
    """SIGKILL the child's whole process group, ignoring races with its exit."""
    try:
        os.killpg(os.getpgid(process.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        process.kill()


# Why the kernel stopped the program, in terms the model can act on. A negative
# return code means it died on a signal, which is how the CPU and memory caps
# announce themselves — an unexplained "exit code -9" tells the model nothing.
_SIGNAL_NOTES = {
    signal.SIGXCPU: "used more CPU time than it is allowed and was stopped",
    signal.SIGKILL: "was stopped after hitting a time or memory limit",
    signal.SIGSEGV: "crashed with a segmentation fault",
}


def _compose_output(
    stdout: str, stderr: str, returncode: int | None, note: str = ""
) -> str:
    """Assemble stdout, stderr and exit status into one readable block."""
    sections: list[str] = []
    if stdout.strip():
        sections.append(stdout.rstrip())
    if stderr.strip():
        sections.append("stderr:\n" + stderr.rstrip())
    if returncode is not None and returncode < 0:
        try:
            reason = _SIGNAL_NOTES.get(
                signal.Signals(-returncode),
                f"was stopped by signal {signal.Signals(-returncode).name}",
            )
        except ValueError:  # pragma: no cover - signal numbers are stable
            reason = f"was stopped by signal {-returncode}"
        sections.append(
            f"(the program {reason} — try a cheaper approach, or print partial "
            "results as you go)"
        )
    elif returncode:
        sections.append(f"(the program exited with code {returncode})")
    if note:
        sections.append(note)
    if not sections:
        return (
            "The program ran and produced no output. Nothing is returned "
            "implicitly — print() the values you want to see."
        )
    return "\n\n".join(sections)


def _truncate(text: str, limit: int) -> str:
    """Clamp tool output; a runaway loop must not eat the context window."""
    if len(text) <= limit:
        return text
    kept = text[:limit].rstrip()
    return f"{kept}\n\n[... output truncated at {limit} characters ...]"


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------


def build_tools(settings: Settings) -> dict[str, MelleaTool]:
    """Return the enabled tools, keyed by the name the model sees.

    Docstrings matter here: mellea derives each tool's JSON schema from the
    signature and the `Args:` section, and that schema is the entire briefing
    the model gets about how to call it.
    """
    tools: dict[str, MelleaTool] = {}
    if not settings.tools_enabled:
        return tools

    if settings.web_search_enabled:

        def web_search(query: str) -> str:
            """Search the web and return the top results with links and snippets.

            Use this for facts that change or that you are unsure of, and cite
            the URLs you use.

            Args:
                query: What to search for, phrased as search keywords rather
                    than a full sentence.
            """
            query = " ".join(str(query).split())[:400]
            if not query:
                return "web_search needs a non-empty query."

            provider, default_endpoint = _PROVIDERS.get(
                settings.search_provider, _PROVIDERS["duckduckgo"]
            )
            endpoint = settings.search_url or default_endpoint
            if not endpoint:
                return (
                    f"Web search is misconfigured: provider "
                    f"{settings.search_provider!r} needs SEARCH_URL to be set. "
                    "Answer from your own knowledge and say search is unavailable."
                )

            results: list[dict[str, str]] = []
            problem = ""
            # One retry: the HTML endpoint challenges bursts, and a short pause
            # is usually enough. Never more than that — a user is waiting.
            for attempt in range(2):
                if attempt:
                    time.sleep(1.5)
                try:
                    results = provider(query, endpoint, settings.search_timeout)
                except ToolError as exc:
                    problem = str(exc)
                except Exception as exc:  # pragma: no cover - defensive
                    logger.warning("web_search failed", exc_info=True)
                    problem = str(exc)
                if results:
                    break

            if not results:
                detail = problem or (
                    "the search engine returned no results, which usually means "
                    "it served an automated-traffic challenge instead"
                )
                return (
                    f"Web search for {query!r} did not work: {detail}. Answer "
                    "from your own knowledge, and tell the user that you could "
                    "not search and that your answer may be out of date."
                )
            return _truncate(
                _format_results(query, results, settings.search_results),
                settings.tool_output_chars,
            )

        tools[WEB_SEARCH] = MelleaTool.from_callable(web_search, name=WEB_SEARCH)

    if settings.python_tool_enabled:

        def run_python(code: str) -> str:
            """Run a short Python 3 program and return what it printed.

            The program starts in an empty directory with only the standard
            library available, and is stopped if it runs too long. Nothing is
            returned implicitly: print the results you want to see.

            Args:
                code: A complete Python program, including any imports it needs.
            """
            code = str(code)
            if not code.strip():
                return "run_python needs some code to run."
            if len(code) > 20_000:
                return "That program is too long; keep it under 20,000 characters."
            try:
                output = _execute_python(code, settings)
            except Exception as exc:
                logger.warning("run_python failed", exc_info=True)
                return f"The program could not be started: {exc}"
            return _truncate(output, settings.tool_output_chars)

        tools[RUN_PYTHON] = MelleaTool.from_callable(run_python, name=RUN_PYTHON)

    return tools
