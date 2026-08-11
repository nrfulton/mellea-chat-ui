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
    if (role === 'user') {
      // Show the user's text verbatim — no markdown interpretation.
      const p = document.createElement('p');
      p.style.whiteSpace = 'pre-wrap';
      p.textContent = content;
      body.appendChild(p);
    } else {
      body.innerHTML = renderMarkdown(content);
    }

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
    if (!rec.body) return; // Chat is off screen; text keeps accumulating.
    if (rec.painting && !final) return;
    rec.painting = true;
    requestAnimationFrame(() => {
      rec.painting = false;
      // The user may have switched chats between frames.
      if (!rec.body) return;
      rec.body.innerHTML = renderMarkdown(rec.text) + (final ? '' : CARET);
      if (state.currentId === rec.chatId) scrollToBottom();
    });
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
    rec.body = rec.node.querySelector('.body');
    rec.body.innerHTML = CARET;
    el.messages.appendChild(rec.node);
    paintStream(rec, false);
    scrollToBottom(true);
  }

  function detachStreams() {
    // renderMessages() wipes the transcript, so drop the stale paint targets.
    for (const rec of state.streams.values()) {
      rec.node = null;
      rec.body = null;
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
    node.querySelector('.body').innerHTML = CARET;
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
      body: node.querySelector('.body'),
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

  // ------------------------------------------------------------------- boot
  async function checkHealth() {
    try {
      const info = await api('/api/health');
      el.modelDot.className = 'model-dot ok';
      el.modelName.textContent = info.model;
      el.modelName.title = `Connected · ${info.model}`;
    } catch (err) {
      el.modelDot.className = 'model-dot bad';
      el.modelName.textContent = 'inference unreachable';
      el.modelName.title = err.message;
    }
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
