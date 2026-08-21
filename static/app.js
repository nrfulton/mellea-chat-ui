/* ---------------------------------------------------------------------------
   Chat interface frontend. No build step and no third-party runtime deps, so
   it works on a box with no internet access.
   --------------------------------------------------------------------------- */

(() => {
  'use strict';

  // ------------------------------------------------------------------ state
  const state = {
    chats: [],
    currentId: null,
    // Live generations keyed by chat id. Generation belongs to a chat, not to
    // the window, so starting or opening another chat never has to wait for it.
    streams: new Map(),
    filter: '',
  };

  const CARET = '<span class="caret"></span>';

  const $ = (id) => document.getElementById(id);
  const el = {
    sidebar: $('sidebar'),
    chatList: $('chat-list'),
    newChat: $('new-chat'),
    search: $('search'),
    menuBtn: $('menu-btn'),
    title: $('chat-title'),
    renameBtn: $('rename-btn'),
    retitleBtn: $('retitle-btn'),
    deleteBtn: $('delete-btn'),
    messages: $('messages'),
    composer: $('composer'),
    input: $('input'),
    send: $('send'),
    stop: $('stop'),
    banner: $('banner'),
    modelDot: $('model-dot'),
    modelName: $('model-name'),
    guardsBtn: $('guards-btn'),
    guardsDialog: $('guards'),
    guardsSub: $('guards-sub'),
    guardsBanner: $('guards-banner'),
    guardsBody: $('guards-body'),
    guardsFoot: $('guards-foot'),
    guardsClose: $('guards-close'),
  };

  // -------------------------------------------------------------------- api
  async function api(path, options = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const body = await res.json();
        detail = body.detail || detail;
      } catch { /* non-JSON error body */ }
      throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
    }
    return res.status === 204 ? null : res.json();
  }

  // --------------------------------------------------------------- markdown
  // Minimal renderer. Everything is HTML-escaped before any markup is added,
  // so model output cannot inject nodes.
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function renderInline(text) {
    // Pull inline code out first so emphasis rules don't touch its contents.
    // NUL sentinels can't occur in model output and pass through escapeHtml
    // unchanged, so they never collide with real text.
    const codes = [];
    let s = text.replace(/`([^`\n]+)`/g, (_, code) => {
      codes.push(code);
      return `\u0000C${codes.length - 1}\u0000`;
    });

    s = escapeHtml(s);

    // [label](url) — only http(s) and mailto survive.
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
      if (!/^(https?:\/\/|mailto:)/i.test(href)) return label;
      return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });
    // Bare URLs.
    s = s.replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+)/g,
      (m, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);

    s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

    return s.replace(/\u0000C(\d+)\u0000/g,
      (_, i) => `<code>${escapeHtml(codes[Number(i)])}</code>`);
  }

  // LaTeX is pulled out of the source before any of this runs and put back as
  // rendered KaTeX afterwards, because `_`, `^` and `*` mean different things
  // to the two grammars. See static/math.js.
  function renderMarkdown(src) {
    const text = String(src ?? '');
    if (!window.LatexMath) return renderBlocks(text);

    const math = window.LatexMath.protect(text);
    let html = renderBlocks(math.text);
    // Display math is already a block; a <br /> against it is redundant and
    // shows up as a gap. Easiest to strip while it is still a known token.
    html = html.replace(
      /(?:<br \/>\s*)?\u0000M(\d+)\u0000(?:\s*<br \/>)?/g,
      (whole, index) => {
        const span = math.spans[Number(index)];
        return span && span.display ? `\u0000M${index}\u0000` : whole;
      }
    );
    return window.LatexMath.restore(html, math.spans);
  }

  function renderBlocks(src) {
    const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;

    const isTableSep = (s) => /^\s*\|?[\s:-]*-[\s|:-]*\|?\s*$/.test(s) && s.includes('-');

    while (i < lines.length) {
      const line = lines[i];

      // fenced code
      const fence = line.match(/^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/);
      if (fence) {
        const marker = fence[1][0];
        const lang = fence[2] || '';
        const buf = [];
        i++;
        while (i < lines.length && !new RegExp(`^\\s*${marker}{3,}\\s*$`).test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        i++; // closing fence (or EOF while still streaming)
        const cls = lang ? ` class="lang-${escapeHtml(lang)}"` : '';
        out.push(
          `<pre><button class="copy-btn" type="button">Copy</button>` +
          `<code${cls}>${escapeHtml(buf.join('\n'))}</code></pre>`
        );
        continue;
      }

      if (!line.trim()) { i++; continue; }

      // heading
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        const lvl = Math.min(h[1].length, 3);
        out.push(`<h${lvl}>${renderInline(h[2].trim())}</h${lvl}>`);
        i++;
        continue;
      }

      // horizontal rule
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        out.push('<hr />');
        i++;
        continue;
      }

      // blockquote
      if (/^\s*>/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        out.push(`<blockquote>${renderBlocks(buf.join('\n'))}</blockquote>`);
        continue;
      }

      // table
      if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const cells = (s) => s.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|')
          .map((c) => c.trim());
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
          rows.push(cells(lines[i]));
          i++;
        }
        out.push(
          '<table><thead><tr>' +
          head.map((c) => `<th>${renderInline(c)}</th>`).join('') +
          '</tr></thead><tbody>' +
          rows.map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join('')}</tr>`).join('') +
          '</tbody></table>'
        );
        continue;
      }

      // lists (one level; nested items are folded into their parent)
      const bullet = line.match(/^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/);
      if (bullet) {
        const ordered = /\d/.test(bullet[2]);
        const items = [];
        while (i < lines.length) {
          const m = lines[i].match(/^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/);
          if (!m) {
            // continuation line belonging to the previous item
            if (items.length && lines[i].trim() && /^\s{2,}/.test(lines[i])) {
              items[items.length - 1] += '\n' + lines[i].trim();
              i++;
              continue;
            }
            break;
          }
          if (/\d/.test(m[2]) !== ordered) break;
          items.push(m[3]);
          i++;
        }
        const tag = ordered ? 'ol' : 'ul';
        out.push(
          `<${tag}>` +
          items.map((t) => `<li>${renderInline(t.replace(/\n/g, ' '))}</li>`).join('') +
          `</${tag}>`
        );
        continue;
      }

      // paragraph
      const buf = [];
      while (i < lines.length && lines[i].trim()
             && !/^\s*(#{1,6}\s|>|`{3,}|~{3,})/.test(lines[i])
             && !/^(\s*)([-*+]|\d{1,9}[.)])\s+/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      const para = buf.join('\n');
      // A paragraph holding nothing but display math needs no <p> around it.
      if (/^(?:\u0000M\d+\u0000\s*)+$/.test(para)) {
        out.push(para.trim());
        continue;
      }
      out.push(`<p>${renderInline(para).replace(/\n/g, '<br />')}</p>`);
    }

    return out.join('\n');
  }

  // -------------------------------------------------------------- rendering
  function initials(role) {
    return role === 'user' ? 'YOU' : 'AI';
  }

  function messageNode(role, content) {
    const wrap = document.createElement('div');
    wrap.className = `msg ${role}`;

    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = initials(role);

    const body = document.createElement('div');
    body.className = 'body';

    // The prose lives in its own element so a tool trace can be placed above it
    // without being wiped by the next repaint.
    const text = document.createElement('div');
    text.className = 'text';
    if (role === 'user') {
      // Show the user's text verbatim — no markdown interpretation.
      const p = document.createElement('p');
      p.style.whiteSpace = 'pre-wrap';
      p.textContent = content;
      text.appendChild(p);
    } else {
      text.innerHTML = renderMarkdown(content);
    }
    body.appendChild(text);

    wrap.append(who, body);
    return wrap;
  }

  function renderMessages(messages) {
    el.messages.innerHTML = '';
    if (!messages.length) {
      el.messages.innerHTML =
        '<div class="welcome"><h2>How can I help?</h2>' +
        '<p>Ask anything to start this conversation.</p></div>';
      return;
    }
    for (const m of messages) {
      el.messages.appendChild(messageNode(m.role, m.content));
    }
    scrollToBottom(true);
  }

  function scrollToBottom(force = false) {
    const box = el.messages;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
    if (force || nearBottom) box.scrollTop = box.scrollHeight;
  }

  function renderSidebar() {
    const q = state.filter.trim().toLowerCase();
    const chats = q
      ? state.chats.filter((c) =>
          c.title.toLowerCase().includes(q) || (c.preview || '').toLowerCase().includes(q))
      : state.chats;

    el.chatList.innerHTML = '';

    if (!chats.length) {
      const note = document.createElement('div');
      note.className = 'empty-note';
      note.textContent = state.chats.length ? 'No matching chats.' : 'No chats yet.';
      el.chatList.appendChild(note);
      return;
    }

    for (const chat of chats) {
      const live = state.streams.has(chat.id);
      const item = document.createElement('button');
      item.className = 'chat-item' + (chat.id === state.currentId ? ' active' : '');
      if (chat.message_count === 0 && !live) item.classList.add('pending');
      if (live) item.classList.add('streaming');
      item.dataset.id = chat.id;

      const title = document.createElement('span');
      title.className = 'row-title';
      title.textContent = chat.title;

      const meta = document.createElement('span');
      meta.className = 'row-meta';
      // Several chats can generate at once, so say which ones are working.
      meta.textContent = live
        ? 'Generating…'
        : chat.message_count
          ? `${chat.message_count} message${chat.message_count === 1 ? '' : 's'} · ${relTime(chat.updated_at)}`
          : 'Empty';

      const del = document.createElement('button');
      del.className = 'row-del';
      del.title = 'Delete chat';
      del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteChat(chat.id, chat.title);
      });

      item.append(title, meta, del);
      item.addEventListener('click', () => selectChat(chat.id));
      el.chatList.appendChild(item);
    }
  }

  function relTime(iso) {
    // The API sends microsecond precision; ECMAScript only specifies three
    // fractional digits, so clamp before parsing instead of trusting the engine.
    const safe = String(iso ?? '').replace(/\.(\d{3})\d+/, '.$1');
    const then = new Date(safe).getTime();
    if (Number.isNaN(then)) return '';
    const mins = Math.round((Date.now() - then) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.round(hrs / 24);
    return days < 7 ? `${days}d ago` : new Date(iso).toLocaleDateString();
  }

  function showBanner(msg) {
    el.banner.textContent = msg;
    el.banner.hidden = !msg;
  }

  // A failure in a chat the user has navigated away from still has to surface,
  // so name the chat it came from.
  function notify(chatId, msg) {
    if (state.currentId === chatId) {
      showBanner(msg);
      return;
    }
    const chat = state.chats.find((c) => c.id === chatId);
    showBanner(chat ? `${chat.title}: ${msg}` : msg);
  }

  function setChatChrome(chat) {
    const has = Boolean(chat);
    el.title.textContent = has ? chat.title : 'Chat';
    for (const b of [el.renameBtn, el.deleteBtn]) b.hidden = !has;
    el.retitleBtn.hidden = !has || !chat.message_count;
  }

  // ------------------------------------------------------------ live streams
  // The composer follows the chat on screen: Stop appears only when *this*
  // chat is generating, so another chat stays sendable meanwhile.
  function syncComposer() {
    const busy = state.streams.has(state.currentId);
    el.send.hidden = busy;
    el.stop.hidden = !busy;
    el.input.disabled = false;
  }

  function paintStream(rec, final = false) {
    if (!rec.out) return; // Chat is off screen; text keeps accumulating.
    if (rec.painting && !final) return;
    rec.painting = true;
    requestAnimationFrame(() => {
      rec.painting = false;
      // The user may have switched chats between frames.
      if (!rec.out) return;
      rec.out.innerHTML = renderMarkdown(rec.text) + (final ? '' : CARET);
      if (state.currentId === rec.chatId) scrollToBottom();
    });
  }

  // ------------------------------------------------------------- tool trace
  // What the model did before answering. Live progress rather than transcript:
  // it is not stored, so it is gone after a reload.
  const TOOL_LABELS = {
    web_search: ['Searching the web', 'Searched the web'],
    run_python: ['Running Python', 'Ran Python'],
  };

  function toolLabel(call) {
    const pair = TOOL_LABELS[call.name] || [call.name, call.name];
    return pair[call.done ? 1 : 0];
  }

  function toolDetail(call) {
    const args = call.args || {};
    const raw = args.query ?? args.code ?? Object.values(args)[0] ?? '';
    const first = String(raw).trim().split('\n')[0];
    return first.length > 80 ? first.slice(0, 79) + '…' : first;
  }

  function paintTools(rec) {
    if (!rec.node || !rec.tools.length) return;
    let box = rec.node.querySelector('.tools');
    if (!box) {
      box = document.createElement('div');
      box.className = 'tools';
      rec.node.querySelector('.body').insertBefore(box, rec.out);
    }

    box.innerHTML = '';
    for (const call of rec.tools) {
      const item = document.createElement('details');
      item.className = 'tool-call';
      if (!call.done) item.classList.add('running');
      if (call.done && !call.ok) item.classList.add('failed');

      const summary = document.createElement('summary');
      const label = document.createElement('span');
      label.className = 'tool-label';
      label.textContent = toolLabel(call) + (call.done ? '' : '…');
      summary.appendChild(label);

      const detail = toolDetail(call);
      if (detail) {
        const arg = document.createElement('span');
        arg.className = 'tool-arg';
        arg.textContent = detail;
        summary.appendChild(arg);
      }
      if (call.done) {
        const meta = document.createElement('span');
        meta.className = 'tool-meta';
        meta.textContent = `${(call.ms / 1000).toFixed(1)}s`;
        summary.appendChild(meta);
      }
      item.appendChild(summary);

      const output = document.createElement('pre');
      output.className = 'tool-output';
      output.textContent = call.done
        ? call.output || '(no output)'
        : 'Working…';
      item.appendChild(output);
      box.appendChild(item);
    }
  }

  function recordTool(rec, evt) {
    if (evt.phase === 'start') {
      rec.tools.push({ id: evt.id, name: evt.name, args: evt.args, done: false });
    } else {
      const call = rec.tools.find((c) => c.id === evt.id);
      if (!call) return;
      Object.assign(call, { done: true, ok: evt.ok, ms: evt.ms, output: evt.output });
    }
    paintTools(rec);
  }

  // Rebind a running generation to a freshly rendered transcript, so coming
  // back to a chat mid-flight resumes showing tokens instead of a gap.
  function attachStream(chatId, messages) {
    const rec = state.streams.get(chatId);
    if (!rec) return;

    const welcome = el.messages.querySelector('.welcome');
    if (welcome) el.messages.innerHTML = '';

    const last = messages[messages.length - 1];
    if (!last || last.role !== 'user' || last.content !== rec.userText) {
      // The user turn is not committed yet; show it so the turn isn't orphaned.
      el.messages.appendChild(messageNode('user', rec.userText));
    }

    rec.node = messageNode('assistant', '');
    rec.out = rec.node.querySelector('.text');
    rec.out.innerHTML = CARET;
    el.messages.appendChild(rec.node);
    paintTools(rec);
    paintStream(rec, false);
    scrollToBottom(true);
  }

  function detachStreams() {
    // renderMessages() wipes the transcript, so drop the stale paint targets.
    for (const rec of state.streams.values()) {
      rec.node = null;
      rec.out = null;
    }
  }

  // ---------------------------------------------------------------- actions
  async function refreshChats() {
    const { chats } = await api('/api/chats');
    state.chats = chats;
    renderSidebar();
  }

  async function selectChat(id, { focus = true } = {}) {
    showBanner('');
    state.currentId = id;
    localStorage.setItem('lastChatId', id);

    const { chat, messages } = await api(`/api/chats/${id}`);
    setChatChrome(chat);
    detachStreams();
    renderMessages(messages);
    attachStream(id, messages);
    syncComposer();
    renderSidebar();
    if (window.innerWidth <= 760) el.sidebar.classList.add('collapsed');
    if (focus) el.input.focus();
  }

  async function newChat() {
    // Reuse an existing empty chat instead of piling up blank threads — but not
    // one that is generating: its message_count is still the pre-send 0 here,
    // and reusing it would drop the user back into the chat they left.
    const blank = state.chats.find(
      (c) => c.message_count === 0 && !state.streams.has(c.id));
    if (blank) {
      await selectChat(blank.id);
      return;
    }
    const { chat } = await api('/api/chats', { method: 'POST' });
    state.chats.unshift(chat);
    await selectChat(chat.id);
  }

  async function deleteChat(id, title) {
    if (!confirm(`Delete "${title}"? This cannot be undone.`)) return;
    // Stop a generation for the chat that is about to disappear.
    state.streams.get(id)?.controller.abort();
    await api(`/api/chats/${id}`, { method: 'DELETE' });
    state.chats = state.chats.filter((c) => c.id !== id);
    if (state.currentId === id) {
      state.currentId = null;
      localStorage.removeItem('lastChatId');
      if (state.chats.length) {
        await selectChat(state.chats[0].id);
      } else {
        setChatChrome(null);
        detachStreams();
        renderMessages([]);
        syncComposer();
      }
    }
    renderSidebar();
  }

  async function renameChat() {
    const chat = state.chats.find((c) => c.id === state.currentId);
    if (!chat) return;
    const next = prompt('Chat title:', chat.title);
    if (next === null) return;
    const title = next.trim();
    if (!title || title === chat.title) return;
    const { chat: updated } = await api(`/api/chats/${chat.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    });
    Object.assign(chat, updated);
    setChatChrome(chat);
    renderSidebar();
  }

  async function regenerateTitle() {
    const chat = state.chats.find((c) => c.id === state.currentId);
    // Retitling mid-generation would race the automatic title write.
    if (!chat || state.streams.has(chat.id)) return;
    el.retitleBtn.disabled = true;
    try {
      const { title } = await api(`/api/chats/${chat.id}/title`, { method: 'POST' });
      chat.title = title;
      setChatChrome(chat);
      renderSidebar();
    } catch (err) {
      showBanner(err.message);
    } finally {
      el.retitleBtn.disabled = false;
    }
  }

  // --------------------------------------------------------------- send
  async function send(text) {
    const chatId = state.currentId;
    showBanner('');

    // Drop the welcome panel on the first message.
    const welcome = el.messages.querySelector('.welcome');
    if (welcome) el.messages.innerHTML = '';

    el.messages.appendChild(messageNode('user', text));
    scrollToBottom(true);

    // Placeholder assistant bubble with a blinking caret.
    const node = messageNode('assistant', '');
    node.querySelector('.text').innerHTML = CARET;
    el.messages.appendChild(node);
    scrollToBottom(true);

    // Everything this generation needs lives in the record, not in the DOM, so
    // it survives the user switching to — or starting — another chat.
    const rec = {
      chatId,
      controller: new AbortController(),
      text: '',
      userText: text,
      node,
      out: node.querySelector('.text'),
      tools: [],
      painting: false,
    };
    state.streams.set(chatId, rec);
    syncComposer();
    renderSidebar();

    const paint = (final = false) => paintStream(rec, final);
    const visible = () => state.currentId === chatId;

    try {
      const res = await fetch(`/api/chats/${chatId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }),
        signal: rec.controller.signal,
      });

      if (!res.ok || !res.body) {
        let detail = res.statusText;
        try { detail = (await res.json()).detail || detail; } catch {}
        throw new Error(typeof detail === 'string' ? detail : 'Request failed');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // NDJSON: complete lines only; keep any partial tail in the buffer.
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          let evt;
          try { evt = JSON.parse(line); } catch { continue; }

          if (evt.type === 'delta') {
            rec.text += evt.text;
            paint();
          } else if (evt.type === 'tool') {
            recordTool(rec, evt);
          } else if (evt.type === 'title') {
            const chat = state.chats.find((c) => c.id === chatId);
            if (chat) {
              chat.title = evt.title;
              if (visible()) setChatChrome(chat);
            }
            renderSidebar();
          } else if (evt.type === 'error') {
            notify(chatId, evt.message);
            if (evt.removed_message_id && visible()) {
              // Server discarded the user turn; drop both bubbles.
              rec.node?.remove();
              const bubbles = el.messages.querySelectorAll('.msg.user');
              if (bubbles.length) bubbles[bubbles.length - 1].remove();
            }
          }
        }
      }

      paint(true);
    } catch (err) {
      if (err.name === 'AbortError') {
        // Stopped by the user: keep whatever streamed in.
        paint(true);
      } else {
        notify(chatId, err.message || 'Something went wrong.');
        if (!rec.text) rec.node?.remove();
        else paint(true);
      }
    } finally {
      state.streams.delete(chatId);
      syncComposer();
      // Resync counts, ordering and any server-side title change.
      try { await refreshChats(); } catch {}
      if (!rec.text.trim()) {
        // Nothing was generated; make sure the caret does not linger.
        if (rec.node?.isConnected) rec.node.remove();
        if (visible() && !el.messages.children.length) renderMessages([]);
      }
      if (visible()) el.input.focus();
    }
  }

  // ----------------------------------------------------------------- events
  el.composer.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = el.input.value.trim();
    // One generation per chat — other chats are free.
    if (!text || state.streams.has(state.currentId)) return;

    if (!state.currentId) await newChat();

    el.input.value = '';
    autosize();
    await send(text);
  });

  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      el.composer.requestSubmit();
    }
  });

  function autosize() {
    el.input.style.height = 'auto';
    el.input.style.height = `${Math.min(el.input.scrollHeight, 220)}px`;
  }
  el.input.addEventListener('input', autosize);

  el.stop.addEventListener('click', () => {
    state.streams.get(state.currentId)?.controller.abort();
  });
  el.newChat.addEventListener('click', () => newChat().catch((e) => showBanner(e.message)));
  el.renameBtn.addEventListener('click', () => renameChat().catch((e) => showBanner(e.message)));
  el.retitleBtn.addEventListener('click', regenerateTitle);
  el.deleteBtn.addEventListener('click', () => {
    const chat = state.chats.find((c) => c.id === state.currentId);
    if (chat) deleteChat(chat.id, chat.title).catch((e) => showBanner(e.message));
  });
  el.title.addEventListener('dblclick', () => renameChat().catch(() => {}));
  el.menuBtn.addEventListener('click', () => el.sidebar.classList.toggle('collapsed'));
  el.search.addEventListener('input', () => {
    state.filter = el.search.value;
    renderSidebar();
  });

  // Copy buttons on code blocks.
  el.messages.addEventListener('click', (e) => {
    const btn = e.target.closest('.copy-btn');
    if (!btn) return;
    const code = btn.parentElement.querySelector('code');
    navigator.clipboard.writeText(code.textContent).then(() => {
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1400);
    });
  });

  // Ctrl/Cmd+K focuses search, Ctrl/Cmd+Shift+O starts a new chat.
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); el.search.focus(); }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); newChat(); }
  });

  // Warn if the user tries to leave while any chat is still generating.
  window.addEventListener('beforeunload', (e) => {
    if (state.streams.size) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---------------------------------------------------------------- guards
  // CRUD for the policies an `m mitm --admin` proxy screens replies against. Documents
  // follow the granite.trust.policy-tools schema and are edited field by field.
  //
  // The proxy owns the schema: nothing here re-implements its validation, so a rejected
  // save shows the parser's own message and this stays correct if the schema grows a
  // field. Every node is built with createElement and textContent, as elsewhere in this
  // file, so policy text is never parsed as markup.
  const guards = {
    entries: [],   // [{policy, enabled}] as the proxy reports them
    draft: null,   // {key, policy, enabled} while editing, else null
    busy: false,   // a toggle is in flight; blocks a second one
  };

  function guardBanner(msg) {
    el.guardsBanner.textContent = msg;
    el.guardsBanner.hidden = !msg;
  }

  function closeGuards() {
    el.guardsDialog.close();
  }

  async function openGuards() {
    guards.draft = null;
    guardBanner('');
    el.guardsDialog.showModal();
    await refreshGuards();
  }

  async function refreshGuards() {
    try {
      const { policies } = await api('/api/policies');
      guards.entries = policies;
      guardBanner('');
    } catch (err) {
      guards.entries = [];
      guardBanner(err.message);
    }
    renderGuards();
  }

  function countRestrictions(policy) {
    return (policy.risks || []).reduce(
      (n, risk) => n + (risk.policy?.reply_cannot_contain?.length || 0), 0);
  }

  function blankRisk() {
    return {
      risk: '', risk_id: '', description: '',
      reason_denial: null, short_reply_type: null, exception: null,
      policy: { reply_cannot_contain: [''], reply_may_contain: [''] },
    };
  }

  function blankPolicy() {
    return {
      risk_group: '', risk_group_id: '', description: '',
      policy_version: 'v1.0', risks: [blankRisk()],
    };
  }

  // Fill in anything a document is allowed to leave out, so the form can bind to every
  // field without checking each one for existence first.
  function normalizePolicy(policy) {
    const out = { ...blankPolicy(), ...policy };
    out.risks = (policy.risks || []).map((risk) => ({
      ...blankRisk(), ...risk,
      policy: {
        reply_cannot_contain: [...(risk.policy?.reply_cannot_contain || [])],
        reply_may_contain: [...(risk.policy?.reply_may_contain || [])],
      },
    }));
    if (!out.risks.length) out.risks = [blankRisk()];
    return out;
  }

  // ---- shared bits of chrome ----
  function guardButton(label, onClick, { kind = '', title = '' } = {}) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = kind ? `g-btn ${kind}` : 'g-btn';
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  function guardField(label, value, onInput, opts = {}) {
    const { placeholder = '', hint = '', mono = false, wide = false } = opts;
    const wrap = document.createElement('label');
    wrap.className = wide ? 'g-field wide' : 'g-field';

    const name = document.createElement('span');
    name.className = 'g-label';
    name.textContent = label;
    wrap.appendChild(name);

    const input = document.createElement('input');
    input.type = 'text';
    input.value = value ?? '';
    input.placeholder = placeholder;
    if (mono) input.classList.add('mono');
    input.addEventListener('input', () => onInput(input.value));
    wrap.appendChild(input);

    if (hint) {
      const note = document.createElement('span');
      note.className = 'g-hint';
      note.textContent = hint;
      wrap.appendChild(note);
    }
    return wrap;
  }

  // An editable list of restriction lines.
  //
  // The DOM is the source of truth here: every change rewrites the whole array from the
  // inputs, so there is no index bookkeeping to desynchronise when a line is added or
  // removed, and nothing re-renders under the caret while typing.
  function guardList(label, items, hint, placeholder) {
    const box = document.createElement('div');
    box.className = 'g-list';

    const head = document.createElement('span');
    head.className = 'g-label';
    head.textContent = label;
    box.appendChild(head);

    const note = document.createElement('span');
    note.className = 'g-hint';
    note.textContent = hint;
    box.appendChild(note);

    const rows = document.createElement('div');
    rows.className = 'g-list-rows';

    const sync = () => {
      items.length = 0;
      for (const input of rows.querySelectorAll('input')) items.push(input.value);
    };

    const addRow = (value, { focus = false } = {}) => {
      const row = document.createElement('div');
      row.className = 'g-list-row';

      const input = document.createElement('input');
      input.type = 'text';
      input.value = value ?? '';
      input.placeholder = placeholder;
      input.addEventListener('input', sync);

      const drop = document.createElement('button');
      drop.type = 'button';
      drop.className = 'icon-btn danger g-drop';
      drop.title = 'Remove this line';
      drop.setAttribute('aria-label', 'Remove this line');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M6 6l12 12M18 6L6 18');
      svg.appendChild(path);
      drop.appendChild(svg);
      drop.addEventListener('click', () => { row.remove(); sync(); });

      row.append(input, drop);
      rows.appendChild(row);
      if (focus) input.focus();
    };

    (items.length ? items : ['']).forEach((item) => addRow(item));
    box.appendChild(rows);
    box.appendChild(
      guardButton('+ Add line', () => addRow('', { focus: true }), { kind: 'quiet' }));
    return box;
  }

  // ---- list view ----
  function renderGuards() {
    el.guardsBody.replaceChildren();
    el.guardsFoot.replaceChildren();
    if (guards.draft) renderGuardForm();
    else renderGuardList();
  }

  function renderGuardList() {
    const total = guards.entries.length;
    const enforced = guards.entries.filter((e) => e.enabled).length;
    el.guardsSub.textContent = total
      ? `${total} ${total === 1 ? 'policy' : 'policies'}, ${enforced} enforced`
      : 'This proxy is screening nothing';

    if (!total) {
      const empty = document.createElement('p');
      empty.className = 'g-empty';
      empty.textContent = 'No policies are registered, so every reply the proxy relays '
        + 'reaches you unscreened.';
      el.guardsBody.appendChild(empty);
    }

    for (const entry of guards.entries) el.guardsBody.appendChild(guardRow(entry));

    el.guardsFoot.append(
      guardButton('Done', closeGuards),
      guardButton('New policy', () => startGuardDraft(null), { kind: 'primary' }),
    );
  }

  function guardRow(entry) {
    const policy = entry.policy;
    const row = document.createElement('div');
    row.className = entry.enabled ? 'g-row' : 'g-row parked';

    const main = document.createElement('div');
    main.className = 'g-row-main';

    const name = document.createElement('span');
    name.className = 'g-row-name';
    name.textContent = policy.risk_group;
    main.appendChild(name);

    const risks = (policy.risks || []).length;
    const rules = countRestrictions(policy);
    const bits = [];
    if (policy.risk_group_id) bits.push(`id ${policy.risk_group_id}`);
    bits.push(`${risks} ${risks === 1 ? 'risk' : 'risks'}`);
    bits.push(`${rules} ${rules === 1 ? 'restriction' : 'restrictions'}`);
    if (policy.policy_version) bits.push(policy.policy_version);

    const meta = document.createElement('span');
    meta.className = 'g-row-meta';
    meta.textContent = bits.join(' · ');
    main.appendChild(meta);

    if (policy.description) {
      const desc = document.createElement('span');
      desc.className = 'g-row-desc';
      desc.textContent = policy.description;
      main.appendChild(desc);
    }

    const actions = document.createElement('div');
    actions.className = 'g-row-actions';
    actions.append(
      guardSwitch(entry),
      guardButton('Edit', () => startGuardDraft(entry), { kind: 'quiet' }),
      guardButton('Delete', () => deleteGuard(entry), { kind: 'quiet danger' }),
    );

    row.append(main, actions);
    return row;
  }

  function guardSwitch(entry) {
    const wrap = document.createElement('label');
    wrap.className = 'g-switch';
    wrap.title = entry.enabled
      ? 'Enforced. Switch off to park it without deleting it.'
      : 'Parked: registered, but not screened against.';

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = entry.enabled;
    box.disabled = guards.busy;
    box.addEventListener('change', () => toggleGuard(entry, box.checked));

    const track = document.createElement('span');
    track.className = 'g-track';

    const text = document.createElement('span');
    text.className = 'g-switch-text';
    text.textContent = entry.enabled ? 'Enforced' : 'Parked';

    wrap.append(box, track, text);
    return wrap;
  }

  // ---- form view ----
  function startGuardDraft(entry) {
    guardBanner('');
    guards.draft = entry
      ? { key: entry.policy.risk_group, policy: normalizePolicy(entry.policy), enabled: null }
      : { key: null, policy: blankPolicy(), enabled: true };
    // enabled: null on an edit means "leave it as it is", so saving a change to a parked
    // guard does not quietly arm it.
    renderGuards();
    el.guardsBody.querySelector('input')?.focus();
  }

  function renderGuardForm() {
    const { key, policy } = guards.draft;
    el.guardsSub.textContent = key === null
      ? 'New policy. Live on the next reply the proxy screens.'
      : `Editing ${key}. Live on the next reply the proxy screens.`;

    el.guardsBody.appendChild(guardGroupBlock(policy));
    policy.risks.forEach((risk, i) => {
      el.guardsBody.appendChild(guardRiskBlock(risk, i));
    });

    const add = guardButton('+ Add risk', () => {
      policy.risks.push(blankRisk());
      renderGuards();
      const blocks = el.guardsBody.querySelectorAll('.g-risk');
      blocks[blocks.length - 1]?.querySelector('input')?.focus();
    });
    add.classList.add('g-add-risk');
    el.guardsBody.appendChild(add);

    el.guardsFoot.append(
      guardButton('Cancel', cancelGuardDraft),
      guardButton(key === null ? 'Create' : 'Save', saveGuard, { kind: 'primary' }),
    );
  }

  function guardGroupBlock(policy) {
    const box = document.createElement('section');
    box.className = 'g-block';

    const head = document.createElement('h3');
    head.className = 'g-block-head';
    head.textContent = 'Risk group';
    box.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'g-grid';
    grid.append(
      guardField('Name', policy.risk_group, (v) => { policy.risk_group = v; },
        { placeholder: 'alcohol_consumption_prohibited', mono: true,
          hint: 'Required. Identifies the policy on the proxy.' }),
      guardField('Group id', policy.risk_group_id, (v) => { policy.risk_group_id = v; },
        { placeholder: '11', mono: true, hint: 'Optional second handle for the policy.' }),
      guardField('Version', policy.policy_version, (v) => { policy.policy_version = v; },
        { placeholder: 'v1.0', mono: true }),
    );
    box.appendChild(grid);

    box.appendChild(guardField('Description', policy.description,
      (v) => { policy.description = v; },
      { placeholder: 'What this group covers and where it applies', wide: true }));
    return box;
  }

  function guardRiskBlock(risk, index) {
    const box = document.createElement('section');
    box.className = 'g-block g-risk';

    const bar = document.createElement('div');
    bar.className = 'g-block-bar';
    const title = document.createElement('h3');
    title.className = 'g-block-head';
    title.textContent = `Risk ${index + 1}`;
    bar.appendChild(title);
    if (guards.draft.policy.risks.length > 1) {
      bar.appendChild(guardButton('Remove risk', () => {
        guards.draft.policy.risks.splice(index, 1);
        renderGuards();
      }, { kind: 'quiet danger' }));
    }
    box.appendChild(bar);

    const grid = document.createElement('div');
    grid.className = 'g-grid';
    grid.append(
      guardField('Risk', risk.risk, (v) => { risk.risk = v; },
        { placeholder: 'alcohol_general_requests', mono: true, hint: 'Required.' }),
      guardField('Risk id', risk.risk_id, (v) => { risk.risk_id = v; },
        { placeholder: '11.1', mono: true }),
    );
    box.appendChild(grid);

    box.appendChild(guardField('Description', risk.description,
      (v) => { risk.description = v; },
      { placeholder: 'What kind of request this risk covers', wide: true }));

    const codes = document.createElement('div');
    codes.className = 'g-grid';
    codes.append(
      guardField('Denial reason', risk.reason_denial,
        (v) => { risk.reason_denial = v.trim() || null; },
        { placeholder: 'ALCOHOL_PROHIBITED', mono: true,
          hint: 'Shown with the canned refusal when no reply can be composed.' }),
      guardField('Short reply type', risk.short_reply_type,
        (v) => { risk.short_reply_type = v.trim() || null; },
        { placeholder: 'EXPLICIT_REFUSAL', mono: true,
          hint: 'Advisory only. The proxy carries it but does not act on it.' }),
      guardField('Exception', risk.exception,
        (v) => { risk.exception = v.trim() || null; },
        { placeholder: 'ALCOHOL_REQUEST_EXCEPTION', mono: true }),
    );
    box.appendChild(codes);

    box.appendChild(guardList(
      'Reply cannot contain', risk.policy.reply_cannot_contain,
      'What a reply may not say. Each line is scored against every reply the proxy '
      + 'relays, one model call each, so a long list is a slower proxy.',
      'Recommendations for alcoholic beverages'));

    box.appendChild(guardList(
      'Reply may contain', risk.policy.reply_may_contain,
      'The brief for writing the replacement. With no lines here a blocked reply becomes '
      + 'a canned refusal instead.',
      'Polite refusal explaining that assistance is unavailable'));

    return box;
  }

  // ---- writes ----
  function cancelGuardDraft() {
    guards.draft = null;
    guardBanner('');
    renderGuards();
  }

  async function saveGuard() {
    const { key, policy, enabled } = guards.draft;
    const body = JSON.stringify({ policy, enabled });
    try {
      if (key === null) await api('/api/policies', { method: 'POST', body });
      else await api(`/api/policies/${encodeURIComponent(key)}`, { method: 'PUT', body });
    } catch (err) {
      // The proxy validated it, so its message names the field that is wrong.
      guardBanner(err.message);
      return;
    }
    guards.draft = null;
    await refreshGuards();
  }

  async function toggleGuard(entry, enabled) {
    if (guards.busy) return;
    guards.busy = true;
    const previous = entry.enabled;
    entry.enabled = enabled;   // optimistic: the switch should not lag the click
    renderGuards();
    try {
      Object.assign(entry, await api(
        `/api/policies/${encodeURIComponent(entry.policy.risk_group)}`,
        { method: 'PATCH', body: JSON.stringify({ enabled }) }));
      guardBanner('');
    } catch (err) {
      entry.enabled = previous;
      guardBanner(err.message);
    } finally {
      guards.busy = false;
      renderGuards();
    }
  }

  async function deleteGuard(entry) {
    const name = entry.policy.risk_group;
    if (!confirm(
      `Delete "${name}"? The proxy stops screening replies against it immediately.`
    )) return;
    try {
      await api(`/api/policies/${encodeURIComponent(name)}`, { method: 'DELETE' });
    } catch (err) {
      guardBanner(err.message);
      return;
    }
    await refreshGuards();
  }

  el.guardsBtn.addEventListener('click', openGuards);
  el.guardsClose.addEventListener('click', closeGuards);

  // Clicking the backdrop closes the panel, but not out from under a half-written policy.
  el.guardsDialog.addEventListener('click', (e) => {
    if (e.target === el.guardsDialog && !guards.draft) closeGuards();
  });

  // Esc closes a <dialog> natively; make that path drop the draft too.
  el.guardsDialog.addEventListener('close', () => {
    guards.draft = null;
    guardBanner('');
  });

  // ------------------------------------------------------------------- boot
  async function checkHealth() {
    // Read the body whatever the status: a 503 still reports the guards, and the policy
    // proxy can be answering perfectly well while the model behind it is not.
    let info = null;
    try {
      const res = await fetch('/api/health');
      info = await res.json().catch(() => null);
      if (!res.ok) throw new Error(info?.error || res.statusText);
      el.modelDot.className = 'model-dot ok';
      el.modelName.textContent = info.model;
      el.modelName.title = `Connected · ${info.model}`;
    } catch (err) {
      el.modelDot.className = 'model-dot bad';
      el.modelName.textContent = 'inference unreachable';
      el.modelName.title = err.message;
    }
    el.guardsBtn.hidden = !info?.guards?.available;
  }

  async function boot() {
    try {
      await refreshChats();
      const last = localStorage.getItem('lastChatId');
      const target = state.chats.find((c) => c.id === last) || state.chats[0];
      if (target) await selectChat(target.id, { focus: false });
      else renderMessages([]);
    } catch (err) {
      showBanner(`Could not load chats: ${err.message}`);
    }
    autosize();
    checkHealth();
  }

  boot();
})();
