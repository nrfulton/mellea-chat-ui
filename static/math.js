/* ---------------------------------------------------------------------------
   LaTeX in model output.

   KaTeX (vendored under static/vendor/katex, MIT) does the typesetting. This
   file does the part KaTeX cannot: deciding which stretches of text are math
   in the first place, and keeping them away from the Markdown renderer.

   That separation is the whole point. `_`, `^` and `*` are structure to LaTeX
   and emphasis markers to Markdown, so `a_1 + a_2` would come out of the
   Markdown pass as `a<em>1 + a</em>2` — unrecoverable by the time KaTeX ran.
   KaTeX's own auto-render extension has the same problem: it walks a live DOM
   after the damage is done. So math is lifted out of the raw source first and
   replaced with NUL sentinels, which survive HTML-escaping and every emphasis
   rule, then put back as rendered KaTeX at the very end:

     const m = LatexMath.protect(src)   // math -> sentinels, code skipped
     ... render the Markdown of m.text ...
     LatexMath.restore(html, m.spans)   // sentinels -> KaTeX output

   Supported delimiters: \[...\], \(...\), $$...$$, cautious $...$, and the
   usual display environments (align, cases, pmatrix, ...).
   --------------------------------------------------------------------------- */

(() => {
  'use strict';

  // Environments that are display math when they appear on their own in prose.
  const DISPLAY_ENVS = /^(equation|align|alignat|aligned|gather|gathered|multline|eqnarray|split|cases|dcases|[bBvVp]?matrix|smallmatrix|array|darray)\*?$/;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // Is `$...$` math, or is it money? Require something structural, or plain
  // algebra with an operator in it, and never a bare amount. Guessing wrong in
  // the permissive direction turns "$5 and $7 total" into an equation, so the
  // bar is deliberately high. \(...\) and $$...$$ are never guessed at.
  function looksLikeMath(body) {
    if (!body || body.length > 400) return false;
    if (/^\s|\s$/.test(body)) return false;      // "$5 and $7" -> "5 and "
    if (/\n\s*\n/.test(body)) return false;      // spans a paragraph break
    if (/^\d[\d.,]*$/.test(body)) return false;  // "$100"
    if (/[\\^_{}]/.test(body)) return true;      // a command, script or group
    return /^[A-Za-z0-9\s+\-*/=<>().,|']{1,60}$/.test(body)
      && /[A-Za-z]/.test(body)
      && /[=+\-*/<>]/.test(body);
  }

  // Scans one stretch of prose (no fenced code) and swaps math for sentinels.
  function scanSegment(text, spans) {
    let out = '';
    let i = 0;

    const take = (tex, display) => {
      spans.push({ tex, display: Boolean(display) });
      return '\u0000M' + (spans.length - 1) + '\u0000';
    };

    while (i < text.length) {
      const rest = text.slice(i);

      // Inline code wins: `\frac{a}{b}` in backticks is being discussed, not
      // typeset.
      if (text[i] === '`') {
        const code = /^(`+)([\s\S]*?)\1/.exec(rest);
        if (code && !/\n\s*\n/.test(code[2])) {
          out += code[0];
          i += code[0].length;
          continue;
        }
      }

      if (rest.startsWith('\\[')) {
        const end = rest.indexOf('\\]', 2);
        if (end > 0) {
          out += take(rest.slice(2, end), true);
          i += end + 2;
          continue;
        }
      }
      if (rest.startsWith('\\(')) {
        const end = rest.indexOf('\\)', 2);
        if (end > 0) {
          out += take(rest.slice(2, end), false);
          i += end + 2;
          continue;
        }
      }
      if (rest.startsWith('$$')) {
        const end = rest.indexOf('$$', 2);
        if (end > 0) {
          out += take(rest.slice(2, end), true);
          i += end + 2;
          continue;
        }
      }
      if (text[i] === '$') {
        const m = /^\$((?:[^$\\\n]|\\.)+)\$/.exec(rest);
        if (m && looksLikeMath(m[1])) {
          out += take(m[1], false);
          i += m[0].length;
          continue;
        }
      }
      const env = /^\\begin\{([a-zA-Z*]+)\}/.exec(rest);
      if (env && DISPLAY_ENVS.test(env[1])) {
        const close = '\\end{' + env[1] + '}';
        const end = rest.indexOf(close);
        if (end > 0) {
          out += take(rest.slice(0, end + close.length), true);
          i += end + close.length;
          continue;
        }
      }

      // An opener with no closer yet — the reply is still streaming — falls
      // through and stays literal until the rest of it arrives.
      out += text[i];
      i++;
    }
    return out;
  }

  function protect(src) {
    const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    const spans = [];
    const out = [];
    let buf = [];
    let fence = null;

    const flush = () => {
      if (buf.length) {
        out.push(scanSegment(buf.join('\n'), spans));
        buf = [];
      }
    };

    for (const line of lines) {
      const marker = line.match(/^\s*(`{3,}|~{3,})/);
      if (fence !== null) {
        // Inside a code fence: verbatim, math delimiters and all.
        flush();
        out.push(line);
        if (marker && marker[1][0] === fence) fence = null;
        continue;
      }
      if (marker) {
        flush();
        out.push(line);
        fence = marker[1][0];
        continue;
      }
      buf.push(line);
    }
    flush();

    return { text: out.join('\n'), spans };
  }

  function sourceOf(span) {
    return span.display ? '\\[' + span.tex + '\\]' : '\\(' + span.tex + '\\)';
  }

  function render(span) {
    if (typeof katex === 'undefined') {
      // Vendored KaTeX missing: show the source rather than nothing.
      return '<code class="math-raw">' + escapeHtml(sourceOf(span)) + '</code>';
    }
    // throwOnError:false keeps one bad expression from taking down a whole
    // message — the offending fragment renders in red, the rest is fine.
    return katex.renderToString(span.tex, {
      displayMode: span.display,
      throwOnError: false,
      errorColor: '#e05561',
      strict: false,            // model output is not a LaTeX purist
      trust: false,             // no \href, \url, \includegraphics, \htmlClass
      output: 'htmlAndMathml',  // visual fidelity plus an accessible tree
      maxSize: 30,              // caps \rule and friends
      maxExpand: 1000,          // macro-expansion bomb guard
      macros: {
        '\\R': '\\mathbb{R}',
        '\\N': '\\mathbb{N}',
        '\\Z': '\\mathbb{Z}',
        '\\Q': '\\mathbb{Q}',
        '\\C': '\\mathbb{C}',
      },
    });
  }

  function restore(html, spans) {
    return String(html).replace(/\u0000M(\d+)\u0000/g, (whole, index) => {
      const span = spans && spans[Number(index)];
      if (!span) return whole;
      try {
        return render(span);
      } catch (err) {
        // Belt and braces: throwOnError should have prevented this.
        return '<code class="math-raw">' + escapeHtml(sourceOf(span)) + '</code>';
      }
    });
  }

  const api = { protect, restore, looksLikeMath };
  if (typeof window !== 'undefined') window.LatexMath = api;
  if (typeof globalThis !== 'undefined') globalThis.LatexMath = api;
})();
