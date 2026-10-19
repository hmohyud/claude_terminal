(() => {
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const STORE_KEY = "claude-terminal.v1";

  const state = {
    convs: [],
    activeId: null,
    settings: { model: "claude-opus-5-5", effort: "", showThinking: true, maxTokens: 16000, fallbacks: true, sidebar: true },
    models: [],
    streaming: null,
    attachments: [],
    histIdx: -1,
    live: { budget: null, today: null, rateLimit: null },
  };

  // ------------------------------------------------------------ helpers
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtCost = (c) => (c == null ? "–" : "$" + c.toFixed(c < 0.01 ? 4 : c < 1 ? 3 : 2));
  const fmtNum = (n) => (n == null ? "–" : Number(n).toLocaleString());
  const fmtBytes = (b) => (b < 1024 ? b + " B" : b < 1048576 ? (b / 1024).toFixed(1) + " KB" : (b / 1048576).toFixed(1) + " MB");
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const fmtAgo = (ts) => {
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return "now";
    if (s < 3600) return Math.floor(s / 60) + "m";
    if (s < 86400) return Math.floor(s / 3600) + "h";
    return Math.floor(s / 86400) + "d";
  };
  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };
  const btn = (label, onClick, cls) => {
    const b = el("button", cls, esc(label));
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  };

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
      if (Array.isArray(raw.convs)) state.convs = raw.convs;
      if (raw.settings) Object.assign(state.settings, raw.settings);
      state.activeId = raw.activeId || null;
    } catch {
      /* fresh start */
    }
  }
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ convs: state.convs, settings: state.settings, activeId: state.activeId }));
    } catch (e) {
      console.warn("save failed", e);
    }
  }

  async function api(path, { method = "GET", body, signal, raw } = {}) {
    const headers = { "X-Requested-With": "claude-terminal" };
    if (body !== undefined && !raw) headers["Content-Type"] = "application/json";
    const res = await fetch(path, { method, headers, body: raw ? body : body !== undefined ? JSON.stringify(body) : undefined, credentials: "same-origin", signal });
    if (res.status === 401) {
      showLogin();
      throw new Error("Logged out");
    }
    return res;
  }
  async function apiJson(path, opts) {
    const res = await api(path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function downloadText(text, name, mime = "text/plain") {
    const blob = new Blob([text], { type: mime + ";charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 500);
  }

  const EXT = { python: "py", py: "py", javascript: "js", js: "js", typescript: "ts", ts: "ts", tsx: "tsx", jsx: "jsx", json: "json", html: "html", css: "css", bash: "sh", sh: "sh", shell: "sh", zsh: "sh", powershell: "ps1", ps1: "ps1", sql: "sql", yaml: "yml", yml: "yml", toml: "toml", markdown: "md", md: "md", go: "go", rust: "rs", rs: "rs", java: "java", kotlin: "kt", c: "c", cpp: "cpp", "c++": "cpp", csharp: "cs", cs: "cs", php: "php", ruby: "rb", rb: "rb", swift: "swift", xml: "xml", diff: "diff", text: "txt", txt: "txt", plaintext: "txt", csv: "csv", r: "r", lua: "lua", dockerfile: "Dockerfile" };
  const extFor = (lang) => EXT[(lang || "").toLowerCase()] || "txt";

  // ------------------------------------------------------------ conversations
  const active = () => state.convs.find((c) => c.id === state.activeId) || null;
  const modelInfo = (id) => state.models.find((m) => m.id === id || (id && id.startsWith(m.id + "-"))) || null;

  function newConv() {
    const c = { id: uid(), title: "new chat", createdAt: Date.now(), updatedAt: Date.now(), model: state.settings.model, system: "", messages: [], cost: 0, tokens: { in: 0, out: 0 } };
    state.convs.unshift(c);
    state.activeId = c.id;
    state.attachments = [];
    save();
    renderAll();
    $("#input").focus();
    return c;
  }
  function ensureConv() {
    return active() || newConv();
  }
  function switchConv(id) {
    state.activeId = id;
    save();
    renderAll();
    $("#input").focus();
  }
  function deleteConv(id) {
    const c = state.convs.find((x) => x.id === id);
    if (!c) return;
    if (c.messages.length && !confirm(`Delete "${c.title}"?`)) return;
    if (state.streaming && state.streaming.convId === id) state.streaming.ctrl.abort();
    state.convs = state.convs.filter((x) => x.id !== id);
    if (state.activeId === id) state.activeId = state.convs[0] ? state.convs[0].id : null;
    save();
    renderAll();
  }

  function toApiMessages(msgs) {
    const out = [];
    for (const m of msgs) {
      if (m.role === "note") continue;
      if (m.role === "assistant") {
        if (m.text && m.text.trim()) out.push({ role: "assistant", content: m.text });
        continue;
      }
      const blocks = (m.files || []).map((f) => ({ type: "file", id: f.id, name: f.name }));
      if (m.text) blocks.push({ type: "text", text: m.text });
      if (!blocks.length) continue;
      out.push({ role: "user", content: blocks.length === 1 && blocks[0].type === "text" ? m.text : blocks });
    }
    return out;
  }

  function note(text) {
    const c = ensureConv();
    c.messages.push({ id: uid(), role: "note", text, ts: Date.now() });
    save();
    renderTranscript();
  }

  // ------------------------------------------------------------ rendering
  function renderAll() {
    renderSidebar();
    renderTopbar();
    renderTranscript();
    renderAttachments();
  }

  function renderSidebar() {
    const list = $("#conv-list");
    list.innerHTML = "";
    const sorted = state.convs.slice().sort((a, b) => b.updatedAt - a.updatedAt);
    for (const c of sorted) {
      const row = el("div", "conv" + (c.id === state.activeId ? " active" : ""));
      row.appendChild(el("span", "name", esc(c.title || "new chat")));
      row.appendChild(el("span", "sub", `${c.cost ? fmtCost(c.cost) : ""} ${fmtAgo(c.updatedAt)}`));
      const del = btn("×", (e) => {
        e.stopPropagation();
        deleteConv(c.id);
      }, "del");
      del.title = "delete";
      row.appendChild(del);
      row.addEventListener("click", () => switchConv(c.id));
      list.appendChild(row);
    }
    $("#app").classList.toggle("no-sidebar", !state.settings.sidebar);
  }

  function renderTopbar() {
    const c = active();
    $("#conv-title").textContent = c ? c.title : "new chat";
    const sel = $("#model");
    const current = c ? c.model : state.settings.model;
    sel.innerHTML = "";
    const ids = state.models.map((m) => m.id);
    if (current && !ids.includes(current)) sel.appendChild(new Option(current, current));
    for (const m of state.models) {
      const o = new Option(m.name + (m.in != null ? `  $${m.in}/$${m.out}` : ""), m.id);
      o.title = `${m.display} — ${m.in != null ? `$${m.in} in / $${m.out} out per 1M tokens` : "pricing unknown"}`;
      sel.appendChild(o);
    }
    sel.value = current;
    renderEffortOptions();
    $("#thinking").checked = !!state.settings.showThinking;
    renderStats();
    renderUsageChip();
  }

  function renderEffortOptions() {
    const c = active();
    const info = modelInfo(c ? c.model : state.settings.model);
    const sel = $("#effort");
    sel.innerHTML = "";
    const efforts = info ? info.efforts : [];
    sel.appendChild(new Option(info && info.defaultEffort ? `default (${info.defaultEffort})` : "default", ""));
    for (const e of efforts) sel.appendChild(new Option(e, e));
    sel.value = efforts.includes(state.settings.effort) ? state.settings.effort : "";
    sel.disabled = efforts.length === 0;
  }

  function renderStats() {
    const c = active();
    const s = $("#conv-stats");
    if (!c || !c.messages.length) return (s.textContent = "");
    s.textContent = `${fmtNum(c.tokens.in)} in · ${fmtNum(c.tokens.out)} out · ${fmtCost(c.cost)} this chat`;
  }

  function renderUsageChip() {
    const chip = $("#usage-chip");
    const b = state.live.budget;
    const parts = [];
    if (state.live.today != null) parts.push(`today ${fmtCost(state.live.today)}`);
    if (b) {
      parts.push(`month ${fmtCost(b.spent)}`);
      if (b.monthly != null) {
        const pct = b.monthly > 0 ? b.spent / b.monthly : 1;
        const cls = pct >= 1 ? "bad" : pct >= 0.8 ? "warn" : "ok";
        parts.push(`<span class="${cls}">${fmtCost(Math.max(0, b.remaining))} left</span>`);
      }
    }
    const rl = state.live.rateLimit;
    if (rl && rl["requests-remaining"] != null) {
      const rem = Number(rl["requests-remaining"]);
      const lim = Number(rl["requests-limit"]);
      const cls = lim && rem / lim < 0.2 ? "warn" : "";
      parts.push(`<span class="${cls}">rpm ${rem}/${lim}</span>`);
    }
    chip.innerHTML = parts.length ? parts.join(" · ") : "usage";
  }

  function renderTranscript() {
    const t = $("#transcript");
    const c = active();
    const wasBottom = atBottom();
    t.innerHTML = "";
    if (!c || !c.messages.length) {
      t.appendChild(el("div", "empty", `<b>❯ claude terminal</b><br>type a message to start · <b>/help</b> for commands<br>drop or paste images, PDFs, Word or text files to attach them`));
      return;
    }
    for (const m of c.messages) t.appendChild(renderMessage(m, c));
    if (wasBottom) t.scrollTop = t.scrollHeight;
  }

  function atBottom() {
    const t = $("#transcript");
    return t.scrollHeight - t.scrollTop - t.clientHeight < 60;
  }

  const KIND_ICON = { pdf: "⎘", docx: "▤", text: "≡" };
  function fileChip(f, { removable, onRemove } = {}) {
    const a = el("span", "file-chip");
    a.title = `preview ${f.name}`;
    a.addEventListener("click", () => openPreview(f));
    if (f.kind === "image") {
      const img = el("img");
      img.src = `/api/files/${f.id}?inline=1`;
      img.alt = "";
      a.appendChild(img);
    } else {
      a.appendChild(el("span", "", KIND_ICON[f.kind] || "≡"));
    }
    a.appendChild(el("span", "fname", esc(f.name)));
    a.appendChild(el("span", "fsize", fmtBytes(f.size)));
    if (removable) {
      const rm = btn("×", (e) => {
        e.stopPropagation();
        onRemove(e);
      }, "rm");
      rm.title = "remove";
      a.appendChild(rm);
    } else {
      const dl = el("a", "dl", "↓");
      dl.href = `/api/files/${f.id}`;
      dl.title = `download ${f.name}`;
      dl.addEventListener("click", (e) => e.stopPropagation());
      a.appendChild(dl);
    }
    return a;
  }

  function renderMessage(m, conv) {
    const root = el("div", `msg ${m.role}`);
    root.dataset.mid = m.id;
    const head = el("div", "msg-head");
    const who = m.role === "user" ? "❯ you" : m.role === "assistant" ? "◆ claude" : "· note";
    head.appendChild(el("span", "who", who));
    if (m.role === "assistant" && m.meta && m.meta.model) head.appendChild(el("span", "model", esc(m.meta.model)));
    head.appendChild(el("span", "time", fmtTime(m.ts)));
    const actions = el("span", "actions");
    if (m.role === "assistant") {
      actions.appendChild(btn("copy", () => navigator.clipboard.writeText(m.text || "")));
      actions.appendChild(btn("download", () => downloadText(m.text || "", `claude-${new Date(m.ts).toISOString().slice(0, 19).replace(/[:T]/g, "-")}.md`, "text/markdown")));
      actions.appendChild(btn("save to files", () => saveToFiles(m)));
      actions.appendChild(btn("retry", () => retryFrom(conv, m)));
    } else if (m.role === "user") {
      actions.appendChild(btn("copy", () => navigator.clipboard.writeText(m.text || "")));
      actions.appendChild(btn("edit", () => editFrom(conv, m)));
    }
    actions.appendChild(btn("delete", () => {
      conv.messages = conv.messages.filter((x) => x !== m);
      save();
      renderTranscript();
    }));
    head.appendChild(actions);
    root.appendChild(head);

    if (m.files && m.files.length) {
      const files = el("div", "files");
      for (const f of m.files) files.appendChild(fileChip(f));
      root.appendChild(files);
    }

    if (m.role === "assistant") {
      const think = el("details", "thinking" + (m.thinking ? "" : " hidden"));
      think.appendChild(el("summary", "", "thinking"));
      think.appendChild(el("div", "think-body", esc(m.thinking || "")));
      root.appendChild(think);
      const body = el("div", "body md");
      renderBody(body, m, !m.pending);
      root.appendChild(body);
      const meta = el("div", "meta");
      renderMeta(meta, m);
      root.appendChild(meta);
    } else {
      root.appendChild(el("div", "body", esc(m.text || "")));
    }
    return root;
  }

  function renderMarkdown(text) {
    if (window.marked && window.DOMPurify) {
      try {
        const html = marked.parse(text, { gfm: true, breaks: false });
        return DOMPurify.sanitize(html);
      } catch {
        /* fall through */
      }
    }
    return `<pre class="plain">${esc(text)}</pre>`;
  }

  function renderBody(body, m, final) {
    if (m.meta && m.meta.error && !m.text) {
      body.className = "body error";
      body.textContent = "error: " + m.meta.error;
      return;
    }
    body.className = "body md" + (m.pending && !final ? " cursor" : "");
    body.innerHTML = renderMarkdown(m.text || "");
    if (final) decorateCode(body);
    if (m.meta && m.meta.error && m.text) body.appendChild(el("div", "error", "error: " + esc(m.meta.error)));
  }

  function decorateCode(container) {
    for (const pre of $$("pre", container)) {
      const code = pre.querySelector("code");
      if (!code) continue;
      const langClass = Array.from(code.classList).find((c) => c.startsWith("language-"));
      const lang = langClass ? langClass.slice(9) : "";
      if (window.hljs) {
        try {
          hljs.highlightElement(code);
        } catch {
          /* ignore */
        }
      }
      const bar = el("div", "code-bar");
      bar.appendChild(el("span", "lang", esc(lang || "text")));
      bar.appendChild(btn("copy", () => navigator.clipboard.writeText(code.innerText)));
      bar.appendChild(btn("download", () => downloadText(code.innerText, `snippet.${extFor(lang)}`)));
      pre.prepend(bar);
    }
    for (const a of $$("a", container)) {
      a.target = "_blank";
      a.rel = "noopener";
    }
  }

  function renderMeta(meta, m) {
    const x = m.meta || {};
    const bits = [];
    if (x.usage) {
      const u = x.usage;
      let inp = `${fmtNum(u.input_tokens)} in`;
      if (u.cache_read_input_tokens) inp += ` (+${fmtNum(u.cache_read_input_tokens)} cached)`;
      bits.push(inp, `${fmtNum(u.output_tokens)} out`);
    }
    if (x.cost != null) bits.push(fmtCost(x.cost));
    if (x.ms) bits.push((x.ms / 1000).toFixed(1) + "s");
    if (x.fallback) bits.push(`<span class="stop-bad">fallback ${esc(x.fallback)}</span>`);
    if (x.stop_reason && x.stop_reason !== "end_turn") {
      let s = x.stop_reason;
      if (x.stop_details && x.stop_details.category) s += ` (${x.stop_details.category})`;
      bits.push(`<span class="stop-bad">${esc(s)}</span>`);
    }
    if (x.stopped) bits.push(`<span class="stop-bad">stopped</span>`);
    meta.innerHTML = bits.map((b) => `<span>${b}</span>`).join("");
  }

  const msgEl = (m) => $(`#transcript [data-mid="${m.id}"]`);

  let renderQueued = false;
  function scheduleStreamRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      const s = state.streaming;
      if (!s) return;
      const root = msgEl(s.msg);
      if (!root) return;
      const wasBottom = atBottom();
      const think = $("details.thinking", root);
      if (s.msg.thinking) {
        think.classList.remove("hidden");
        $(".think-body", think).textContent = s.msg.thinking;
        if (!s.msg.text && !think.open && !s.thinkOpened) {
          think.open = true;
          s.thinkOpened = true;
        }
      }
      if (s.msg.text && think.open && s.thinkOpened && !s.thinkClosed) {
        think.open = false;
        s.thinkClosed = true;
      }
      renderBody($(".body", root), s.msg, false);
      if (wasBottom) $("#transcript").scrollTop = $("#transcript").scrollHeight;
    });
  }

  // ------------------------------------------------------------ attachments
  function renderAttachments() {
    const box = $("#attachments");
    box.innerHTML = "";
    box.classList.toggle("hidden", state.attachments.length === 0);
    state.attachments.forEach((f, i) => {
      box.appendChild(fileChip(f, { removable: true, onRemove: () => {
        state.attachments.splice(i, 1);
        renderAttachments();
      } }));
    });
  }

  async function uploadFiles(files, { attach = true, source } = {}) {
    const added = [];
    for (const file of files) {
      try {
        const q = new URLSearchParams({ name: file.name || "pasted", type: file.type || "" });
        if (source) q.set("source", source);
        const entry = await apiJson(`/api/upload?${q}`, { method: "POST", body: file, raw: true });
        added.push(entry);
        if (attach) state.attachments.push(entry);
      } catch (e) {
        note(`upload failed: ${e.message}`);
      }
    }
    renderAttachments();
    return added;
  }

  async function saveToFiles(m) {
    const name = `claude-${new Date(m.ts).toISOString().slice(0, 19).replace(/[:T]/g, "-")}.md`;
    const file = new File([m.text || ""], name, { type: "text/markdown" });
    const added = await uploadFiles([file], { attach: false, source: "assistant" });
    if (added.length) note(`saved to files: ${added[0].name} (open the files panel to download)`);
  }

  // ------------------------------------------------------------ chat
  async function sendMessage(text) {
    const c = ensureConv();
    if (state.streaming) return note("still streaming — press Esc or ■ to stop first");
    const files = state.attachments.splice(0);
    renderAttachments();
    if (!text && !files.length) return;
    c.messages.push({ id: uid(), role: "user", text, files, ts: Date.now() });
    if (!c.title || c.title === "new chat") c.title = (text || files[0].name).slice(0, 48);
    const am = { id: uid(), role: "assistant", text: "", thinking: "", meta: { model: c.model }, ts: Date.now(), pending: true };
    c.messages.push(am);
    c.updatedAt = Date.now();
    save();
    renderAll();
    await streamInto(c, am);
  }

  async function streamInto(conv, am) {
    const ctrl = new AbortController();
    state.streaming = { ctrl, convId: conv.id, msg: am };
    document.body.classList.add("streaming");
    const info = modelInfo(conv.model);
    const body = {
      conv: conv.id,
      model: conv.model || state.settings.model,
      system: conv.system || "",
      messages: toApiMessages(conv.messages.filter((m) => m !== am)),
      effort: info && info.efforts.includes(state.settings.effort) ? state.settings.effort : null,
      maxTokens: state.settings.maxTokens,
      showThinking: state.settings.showThinking,
      fallbacks: state.settings.fallbacks,
    };
    try {
      const res = await api("/api/chat", { method: "POST", body, signal: ctrl.signal });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      await readSSE(res, (ev) => handleEvent(ev, conv, am));
    } catch (e) {
      if (e.name === "AbortError") am.meta.stopped = true;
      else am.meta.error = e.message;
    } finally {
      delete am.pending;
      state.streaming = null;
      document.body.classList.remove("streaming");
      conv.updatedAt = Date.now();
      save();
      const root = msgEl(am);
      if (root) {
        const wasBottom = atBottom();
        root.replaceWith(renderMessage(am, conv));
        if (wasBottom) $("#transcript").scrollTop = $("#transcript").scrollHeight;
      }
      renderSidebar();
      renderStats();
      renderUsageChip();
      $("#input").focus();
    }
  }

  async function readSSE(res, onEvent) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          try {
            onEvent(JSON.parse(line.slice(6)));
          } catch (e) {
            console.warn("bad event", line, e);
          }
        }
      }
    }
  }

  function handleEvent(ev, conv, am) {
    switch (ev.t) {
      case "start":
        am.meta.model = ev.model;
        break;
      case "think":
        am.thinking += ev.v;
        scheduleStreamRender();
        break;
      case "text":
        am.text += ev.v;
        scheduleStreamRender();
        break;
      case "fallback":
        am.meta.fallback = `${ev.from || "?"} → ${ev.to || "?"}`;
        break;
      case "done":
        am.meta.model = ev.model;
        am.meta.usage = ev.usage;
        am.meta.cost = ev.cost;
        am.meta.ms = ev.ms;
        am.meta.stop_reason = ev.stop_reason;
        am.meta.stop_details = ev.stop_details;
        if (ev.usage) {
          conv.tokens.in += (ev.usage.input_tokens || 0) + (ev.usage.cache_read_input_tokens || 0) + (ev.usage.cache_creation_input_tokens || 0);
          conv.tokens.out += ev.usage.output_tokens || 0;
        }
        if (ev.cost) conv.cost = (conv.cost || 0) + ev.cost;
        state.live.budget = ev.budget || state.live.budget;
        state.live.today = ev.today;
        if (ev.rateLimit) state.live.rateLimit = ev.rateLimit;
        if (ev.stop_reason === "refusal") {
          am.meta.error = `refused${ev.stop_details && ev.stop_details.category ? ` (${ev.stop_details.category})` : ""}${ev.stop_details && ev.stop_details.explanation ? ": " + ev.stop_details.explanation : ""}`;
        }
        break;
      case "error":
        am.meta.error = (ev.status ? ev.status + " " : "") + ev.message;
        break;
      default:
        break;
    }
  }

  function stopStreaming() {
    if (state.streaming) state.streaming.ctrl.abort();
  }

  async function retryFrom(conv, m) {
    if (state.streaming) return;
    const idx = conv.messages.indexOf(m);
    if (idx < 0) return;
    conv.messages.splice(idx);
    const am = { id: uid(), role: "assistant", text: "", thinking: "", meta: { model: conv.model }, ts: Date.now(), pending: true };
    conv.messages.push(am);
    save();
    renderTranscript();
    await streamInto(conv, am);
  }

  function editFrom(conv, m) {
    if (state.streaming) return;
    const idx = conv.messages.indexOf(m);
    if (idx < 0) return;
    conv.messages.splice(idx);
    state.attachments = (m.files || []).slice();
    save();
    renderTranscript();
    renderAttachments();
    const input = $("#input");
    input.value = m.text || "";
    autosize();
    input.focus();
  }

  // ------------------------------------------------------------ slash commands
  const HELP = `commands
  /new                 start a new chat
  /clear               clear messages in this chat
  /delete              delete this chat
  /title <text>        rename this chat
  /model [name]        show or switch model (e.g. /model sonnet)
  /models              list models and prices
  /system [text|clear] show / set / clear the system prompt
  /effort [level]      show or set effort (low · medium · high · xhigh · max · default)
  /thinking on|off     show Claude's thinking summary
  /max <n>             max output tokens (currently ${state.settings.maxTokens})
  /fallback on|off     server-side fallback to another model on a safety refusal
  /retry               regenerate the last reply
  /undo                remove the last exchange
  /export [md|json]    download this chat
  /files               open the files panel (upload / download)
  /usage               open the usage panel
  /context             count tokens in the current context
  /budget <usd|off>    set a monthly budget to track remaining spend
  /logout              sign out of this browser
keys
  enter send · shift+enter newline · esc stop · ↑/↓ recall earlier messages
  paste or drop images, PDFs, Word (.docx) and text/code files to attach them · click a file to preview it`;

  async function runCommand(line) {
    const [cmd, ...rest] = line.slice(1).trim().split(/\s+/);
    const arg = line.slice(1).trim().slice(cmd.length).trim();
    const c = active();
    switch ((cmd || "").toLowerCase()) {
      case "help":
        return note(HELP);
      case "new":
        return newConv();
      case "clear":
        if (c) {
          c.messages = [];
          c.cost = 0;
          c.tokens = { in: 0, out: 0 };
          save();
          renderAll();
        }
        return;
      case "delete":
        if (c) deleteConv(c.id);
        return;
      case "title":
        if (c && arg) {
          c.title = arg.slice(0, 80);
          save();
          renderAll();
        }
        return;
      case "model": {
        if (!arg) return note(`model: ${c ? c.model : state.settings.model}`);
        const q = arg.toLowerCase();
        const m = state.models.find((x) => x.id === q) || state.models.find((x) => x.id.includes(q) || x.name.toLowerCase().includes(q));
        if (!m) return note(`no model matches "${arg}" — try /models`);
        setModel(m.id);
        return note(`model → ${m.id}`);
      }
      case "models":
        return note("models (price per 1M tokens in / out)\n" + state.models.map((m) => `  ${m.id.padEnd(20)} ${m.in != null ? `$${m.in} / $${m.out}` : "?"}${m.thinking === "always" ? "  (thinking always on)" : ""}`).join("\n"));
      case "system":
        if (!c) ensureConv();
        if (!arg) return note(`system prompt: ${active().system ? "\n" + active().system : "(none)"}`);
        active().system = arg.toLowerCase() === "clear" ? "" : arg;
        save();
        return note(active().system ? "system prompt set" : "system prompt cleared");
      case "effort": {
        if (!arg) return note(`effort: ${state.settings.effort || "default"}`);
        const v = arg.toLowerCase();
        if (v === "default" || v === "off") state.settings.effort = "";
        else if (["low", "medium", "high", "xhigh", "max"].includes(v)) state.settings.effort = v;
        else return note("effort must be low, medium, high, xhigh, max or default");
        save();
        renderEffortOptions();
        return note(`effort → ${state.settings.effort || "default"}`);
      }
      case "thinking":
        state.settings.showThinking = arg ? /^(on|1|true|yes)$/i.test(arg) : !state.settings.showThinking;
        save();
        $("#thinking").checked = state.settings.showThinking;
        return note(`thinking display → ${state.settings.showThinking ? "on" : "off"}`);
      case "max": {
        const n = parseInt(arg, 10);
        if (!n) return note(`max tokens: ${state.settings.maxTokens}`);
        state.settings.maxTokens = Math.max(256, Math.min(128000, n));
        save();
        return note(`max tokens → ${state.settings.maxTokens}`);
      }
      case "fallback":
        state.settings.fallbacks = arg ? /^(on|1|true|yes)$/i.test(arg) : !state.settings.fallbacks;
        save();
        return note(`refusal fallback → ${state.settings.fallbacks ? "on" : "off"}`);
      case "retry": {
        if (!c) return;
        const last = c.messages.slice().reverse().find((m) => m.role === "assistant");
        if (last) return retryFrom(c, last);
        return;
      }
      case "undo": {
        if (!c) return;
        while (c.messages.length && c.messages[c.messages.length - 1].role !== "user") c.messages.pop();
        c.messages.pop();
        save();
        renderTranscript();
        return;
      }
      case "export":
        return exportConv(arg.toLowerCase() === "json" ? "json" : "md");
      case "files":
        return openFiles();
      case "usage":
        return openUsage();
      case "context":
        return countContext();
      case "budget": {
        if (!arg) return openUsage();
        const off = /^(off|none|clear|0)$/i.test(arg);
        const n = off ? null : Number(arg.replace(/[$,]/g, ""));
        if (!off && !(n >= 0)) return note("usage: /budget 25   or   /budget off");
        await apiJson("/api/budget", { method: "POST", body: { monthly: n } });
        await refreshUsage();
        return note(off ? "monthly budget cleared" : `monthly budget → $${n}`);
      }
      case "logout":
        return logout();
      default:
        return note(`unknown command /${cmd} — try /help`);
    }
  }

  function setModel(id) {
    const c = active();
    state.settings.model = id;
    if (c) c.model = id;
    save();
    renderTopbar();
  }

  function exportConv(kind) {
    const c = active();
    if (!c) return;
    const stamp = new Date().toISOString().slice(0, 10);
    const base = (c.title || "chat").replace(/[^\w.-]+/g, "_").slice(0, 40);
    if (kind === "json") return downloadText(JSON.stringify(c, null, 2), `${base}-${stamp}.json`, "application/json");
    const lines = [`# ${c.title}`, "", `model: ${c.model}`, c.system ? `system: ${c.system}` : "", ""];
    for (const m of c.messages) {
      if (m.role === "note") continue;
      lines.push(`## ${m.role === "user" ? "You" : "Claude"} · ${new Date(m.ts).toLocaleString()}`, "");
      if (m.files && m.files.length) lines.push(m.files.map((f) => `[attached: ${f.name}]`).join(" "), "");
      lines.push(m.text || "", "");
    }
    downloadText(lines.join("\n"), `${base}-${stamp}.md`, "text/markdown");
  }

  async function countContext() {
    const c = active();
    if (!c || !c.messages.some((m) => m.role === "user")) return note("nothing in context yet");
    try {
      const msgs = toApiMessages(c.messages);
      if (msgs[msgs.length - 1].role !== "user") msgs.push({ role: "user", content: "." });
      const r = await apiJson("/api/count", { method: "POST", body: { model: c.model, system: c.system, messages: msgs } });
      const info = modelInfo(c.model);
      const est = info && info.in != null ? ` ≈ ${fmtCost((r.input_tokens * info.in) / 1e6)} of input per message` : "";
      note(`context: ${fmtNum(r.input_tokens)} tokens${est}`);
    } catch (e) {
      note(`count failed: ${e.message}`);
    }
  }

  // ------------------------------------------------------------ usage panel
  async function refreshUsage() {
    const u = await apiJson("/api/usage");
    state.live.budget = u.budget;
    state.live.today = u.totals.today.cost;
    if (u.rateLimit) state.live.rateLimit = u.rateLimit;
    renderUsageChip();
    return u;
  }

  async function openUsage() {
    const panel = $("#usage-panel");
    panel.classList.remove("hidden");
    const body = $("#usage-body");
    body.textContent = "loading…";
    try {
      const u = await refreshUsage();
      body.innerHTML = "";
      const cards = el("div", "cards");
      for (const [k, label] of [["today", "today"], ["week", "last 7 days"], ["month", "this month"], ["all", "all time"]]) {
        const s = u.totals[k];
        cards.appendChild(el("div", "card", `<div class="k">${label}</div><div class="v">${fmtCost(s.cost)}</div><div class="s">${fmtNum(s.requests)} req · ${fmtNum(s.input + s.cacheRead + s.cacheWrite)} in · ${fmtNum(s.output)} out</div>`));
      }
      body.appendChild(cards);

      body.appendChild(el("div", "section", "monthly budget"));
      const row = el("div", "budget-row");
      const input = el("input");
      input.type = "number";
      input.min = "0";
      input.step = "1";
      input.placeholder = "usd";
      input.value = u.budget.monthly == null ? "" : u.budget.monthly;
      row.appendChild(el("span", "", "$"));
      row.appendChild(input);
      row.appendChild(btn("save", async () => {
        try {
          await apiJson("/api/budget", { method: "POST", body: { monthly: input.value === "" ? null : Number(input.value) } });
          openUsage();
        } catch (e) {
          note(`budget: ${e.message}`);
        }
      }, "small"));
      const bar = el("div", "bar");
      const fill = el("div");
      if (u.budget.monthly) {
        const pct = Math.min(1, u.budget.spent / u.budget.monthly);
        fill.style.width = (pct * 100).toFixed(1) + "%";
        fill.className = pct >= 1 ? "bad" : pct >= 0.8 ? "warn" : "";
        bar.appendChild(fill);
        row.appendChild(bar);
        row.appendChild(el("span", "", `${fmtCost(u.budget.spent)} spent · <b>${fmtCost(Math.max(0, u.budget.remaining))} remaining</b> of ${fmtCost(u.budget.monthly)} (${u.month})`));
      } else {
        row.appendChild(el("span", "", `no budget set — ${fmtCost(u.budget.spent)} spent in ${u.month}`));
      }
      body.appendChild(row);

      body.appendChild(el("div", "section", "rate limits (from the last response)"));
      const rl = u.rateLimit;
      if (rl) {
        const grid = el("div", "rl");
        for (const [key, label] of [["requests", "requests / min"], ["tokens", "tokens / min"], ["input-tokens", "input tokens / min"], ["output-tokens", "output tokens / min"]]) {
          const rem = rl[`${key}-remaining`];
          const lim = rl[`${key}-limit`];
          if (rem == null && lim == null) continue;
          const reset = rl[`${key}-reset`];
          let resetTxt = "";
          if (reset) {
            const secs = Math.max(0, Math.round((new Date(reset).getTime() - Date.now()) / 1000));
            resetTxt = `resets in ${secs}s`;
          }
          grid.appendChild(el("div", "card", `<div class="k">${label}</div><div class="v">${fmtNum(rem)} <span class="s">/ ${fmtNum(lim)} remaining</span></div><div class="s">${resetTxt}</div>`));
        }
        grid.appendChild(el("div", "card", `<div class="k">captured</div><div class="v">${fmtAgo(rl.at)} ago</div><div class="s">${new Date(rl.at).toLocaleTimeString()}</div>`));
        body.appendChild(grid);
      } else {
        body.appendChild(el("div", "s", "no response seen yet — send a message to populate"));
      }

      body.appendChild(el("div", "section", "last 30 days"));
      const spark = el("div", "spark");
      const max = Math.max(0.000001, ...u.days.map((d) => d.cost));
      for (const d of u.days) {
        const b = el("div");
        b.style.height = Math.max(2, (d.cost / max) * 100) + "%";
        b.title = `${d.day}: ${fmtCost(d.cost)} · ${d.requests} req`;
        spark.appendChild(b);
      }
      body.appendChild(spark);
      body.appendChild(el("div", "spark-labels", `<span>${u.days[0].day}</span><span>${u.days[u.days.length - 1].day}</span>`));

      if (u.byModel.length) {
        body.appendChild(el("div", "section", "by model (this month)"));
        const t = el("table", "t", `<tr><th>model</th><th class="num">req</th><th class="num">input</th><th class="num">cached</th><th class="num">output</th><th class="num">cost</th></tr>`);
        for (const r of u.byModel) t.insertAdjacentHTML("beforeend", `<tr><td>${esc(r.model)}</td><td class="num">${fmtNum(r.requests)}</td><td class="num">${fmtNum(r.input)}</td><td class="num">${fmtNum(r.cacheRead)}</td><td class="num">${fmtNum(r.output)}</td><td class="num">${fmtCost(r.cost)}</td></tr>`);
        body.appendChild(t);
      }

      if (u.recent.length) {
        body.appendChild(el("div", "section", "recent requests"));
        const t = el("table", "t", `<tr><th>when</th><th>model</th><th class="num">in</th><th class="num">out</th><th class="num">time</th><th class="num">cost</th><th>stop</th></tr>`);
        for (const r of u.recent) t.insertAdjacentHTML("beforeend", `<tr><td>${new Date(r.ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td><td>${esc(r.model)}</td><td class="num">${fmtNum(r.input + (r.cacheRead || 0))}</td><td class="num">${fmtNum(r.output)}</td><td class="num">${(r.ms / 1000).toFixed(1)}s</td><td class="num">${fmtCost(r.cost)}</td><td>${esc(r.stop || "")}</td></tr>`);
        body.appendChild(t);
      }

      body.appendChild(el("div", "fine", "costs are estimates: token counts × list prices, recorded by this terminal only. the official number is on console.anthropic.com → usage."));
    } catch (e) {
      body.textContent = "could not load usage: " + e.message;
    }
  }

  // ------------------------------------------------------------ files panel
  async function openFiles() {
    const panel = $("#files-panel");
    panel.classList.remove("hidden");
    const body = $("#files-body");
    body.textContent = "loading…";
    try {
      const files = await apiJson("/api/files");
      body.innerHTML = "";
      if (!files.length) body.appendChild(el("div", "s", "no files yet — upload one, drop one into the chat, or use “save to files” on a reply"));
      for (const f of files) {
        const row = el("div", "file-row");
        if (f.kind === "image") {
          const img = el("img");
          img.src = `/api/files/${f.id}?inline=1`;
          img.alt = "";
          row.appendChild(img);
        } else row.appendChild(el("span", "kind", f.kind));
        row.appendChild(el("span", "fname", esc(f.name)));
        row.appendChild(el("span", "fmeta", `${fmtBytes(f.size)} · ${new Date(f.ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}${f.source === "assistant" ? " · from claude" : ""}`));
        row.appendChild(btn("preview", () => openPreview(f), "small"));
        row.appendChild(btn("attach", () => {
          if (!state.attachments.find((x) => x.id === f.id)) state.attachments.push(f);
          renderAttachments();
          panel.classList.add("hidden");
          $("#input").focus();
        }, "small"));
        const dl = el("a", "", "download");
        dl.href = `/api/files/${f.id}`;
        row.appendChild(dl);
        row.appendChild(btn("delete", async () => {
          if (!confirm(`Delete ${f.name}?`)) return;
          await apiJson(`/api/files/${f.id}`, { method: "DELETE" });
          openFiles();
        }, "small danger"));
        body.appendChild(row);
      }
    } catch (e) {
      body.textContent = "could not load files: " + e.message;
    }
  }

  // ------------------------------------------------------------ preview
  async function openPreview(f) {
    const panel = $("#preview-panel");
    panel.classList.remove("hidden");
    $("#preview-title").textContent = f.name;
    $("#preview-dl").href = `/api/files/${f.id}`;
    const body = $("#preview-body");
    body.innerHTML = "";
    if (f.kind === "image") {
      const img = el("img", "preview-img");
      img.src = `/api/files/${f.id}?inline=1`;
      img.alt = f.name;
      body.appendChild(img);
      return;
    }
    if (f.kind === "pdf") {
      const frame = el("iframe", "preview-frame");
      frame.src = `/api/files/${f.id}?inline=1`;
      frame.title = f.name;
      body.appendChild(frame);
      return;
    }
    body.appendChild(el("div", "preview-loading", "loading…"));
    try {
      const p = await apiJson(`/api/files/${f.id}/preview`);
      body.innerHTML = "";
      if (p.kind === "html") {
        const doc = el("div", "doc-preview");
        doc.innerHTML = window.DOMPurify ? DOMPurify.sanitize(p.html) : esc(p.html);
        body.appendChild(doc);
      } else if (p.kind === "text") {
        body.appendChild(el("pre", "text-preview", esc(p.text)));
      } else {
        body.appendChild(el("div", "preview-loading", "no preview for this file type"));
      }
    } catch (e) {
      body.innerHTML = "";
      body.appendChild(el("div", "preview-loading", "could not load preview: " + esc(e.message)));
    }
  }

  // ------------------------------------------------------------ auth
  function showLogin() {
    $("#app").classList.add("hidden");
    $("#login").classList.remove("hidden");
    setTimeout(() => $("#password").focus(), 0);
  }

  async function logout() {
    try {
      await api("/api/logout", { method: "POST", body: {} });
    } catch {
      /* ignore */
    }
    showLogin();
  }

  async function boot() {
    $("#login").classList.add("hidden");
    $("#app").classList.remove("hidden");
    try {
      state.models = await apiJson("/api/models");
    } catch (e) {
      note(`could not load model list: ${e.message}`);
    }
    if (!state.models.find((m) => m.id === state.settings.model) && state.models[0]) state.settings.model = state.models[0].id;
    if (!active()) {
      if (state.convs[0]) state.activeId = state.convs[0].id;
      else newConv();
    }
    renderAll();
    refreshUsage().catch(() => {});
    $("#input").focus();
  }

  // ------------------------------------------------------------ input
  function autosize() {
    const t = $("#input");
    t.style.height = "auto";
    t.style.height = Math.min(t.scrollHeight, window.innerHeight * 0.4) + "px";
  }

  function userHistory() {
    const c = active();
    return c ? c.messages.filter((m) => m.role === "user").map((m) => m.text) : [];
  }

  function wire() {
    $("#login-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = $("#login-error");
      const b = $("#login-btn");
      err.textContent = "";
      b.disabled = true;
      try {
        const res = await fetch("/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Requested-With": "claude-terminal" },
          body: JSON.stringify({ password: $("#password").value }),
          credentials: "same-origin",
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          err.textContent = data.error || `error ${res.status}`;
          if (data.retryAfter) {
            let left = data.retryAfter;
            const tick = setInterval(() => {
              left -= 1;
              if (left <= 0) {
                clearInterval(tick);
                err.textContent = "you can try again now";
              } else err.textContent = `locked — try again in ${left}s`;
            }, 1000);
          }
          return;
        }
        $("#password").value = "";
        boot();
      } catch (e2) {
        err.textContent = e2.message;
      } finally {
        b.disabled = false;
      }
    });

    const input = $("#input");
    $("#composer").addEventListener("submit", (e) => {
      e.preventDefault();
      submit();
    });
    function submit() {
      const text = input.value.trim();
      input.value = "";
      autosize();
      state.histIdx = -1;
      if (text.startsWith("/") && !text.startsWith("//")) return runCommand(text);
      sendMessage(text.startsWith("//") ? text.slice(1) : text);
    }
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submit();
      } else if (e.key === "Escape") {
        stopStreaming();
      } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && (input.value === "" || state.histIdx >= 0)) {
        const h = userHistory();
        if (!h.length) return;
        e.preventDefault();
        if (e.key === "ArrowUp") state.histIdx = state.histIdx < 0 ? h.length - 1 : Math.max(0, state.histIdx - 1);
        else state.histIdx = state.histIdx < 0 ? -1 : state.histIdx + 1;
        if (state.histIdx >= h.length || state.histIdx < 0) {
          state.histIdx = -1;
          input.value = "";
        } else input.value = h[state.histIdx];
        autosize();
      }
    });
    input.addEventListener("input", autosize);
    input.addEventListener("paste", (e) => {
      const files = Array.from(e.clipboardData && e.clipboardData.files ? e.clipboardData.files : []);
      if (files.length) {
        e.preventDefault();
        uploadFiles(files);
      }
    });

    $("#send").addEventListener("click", (e) => e.preventDefault());
    $("#stop").addEventListener("click", stopStreaming);
    $("#attach").addEventListener("click", () => $("#file").click());
    $("#files-upload").addEventListener("click", () => {
      $("#file").dataset.mode = "store";
      $("#file").click();
    });
    $("#file").addEventListener("change", async (e) => {
      const files = Array.from(e.target.files || []);
      const mode = e.target.dataset.mode;
      e.target.dataset.mode = "";
      e.target.value = "";
      if (!files.length) return;
      await uploadFiles(files, { attach: mode !== "store" });
      if (mode === "store") openFiles();
    });

    $("#new-conv").addEventListener("click", () => newConv());
    $("#logout").addEventListener("click", logout);
    $("#usage-btn").addEventListener("click", openUsage);
    $("#usage-chip").addEventListener("click", openUsage);
    $("#files-btn").addEventListener("click", openFiles);
    $("#toggle-sidebar").addEventListener("click", () => {
      state.settings.sidebar = !state.settings.sidebar;
      save();
      renderSidebar();
    });
    $("#conv-title").addEventListener("dblclick", () => {
      const c = active();
      if (!c) return;
      const t = prompt("chat title", c.title);
      if (t != null) {
        c.title = t.trim().slice(0, 80) || c.title;
        save();
        renderAll();
      }
    });

    $("#model").addEventListener("change", (e) => setModel(e.target.value));
    $("#effort").addEventListener("change", (e) => {
      state.settings.effort = e.target.value;
      save();
    });
    $("#thinking").addEventListener("change", (e) => {
      state.settings.showThinking = e.target.checked;
      save();
    });

    for (const b of $$("[data-close]")) b.addEventListener("click", () => $("#" + b.dataset.close).classList.add("hidden"));
    for (const m of $$(".modal")) m.addEventListener("click", (e) => {
      if (e.target === m) m.classList.add("hidden");
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") for (const m of $$(".modal")) m.classList.add("hidden");
    });

    // drag & drop anywhere
    let dragDepth = 0;
    document.addEventListener("dragenter", (e) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes("Files")) return;
      dragDepth += 1;
      $("#drop-overlay").classList.remove("hidden");
    });
    document.addEventListener("dragleave", () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) $("#drop-overlay").classList.add("hidden");
    });
    document.addEventListener("dragover", (e) => e.preventDefault());
    document.addEventListener("drop", (e) => {
      e.preventDefault();
      dragDepth = 0;
      $("#drop-overlay").classList.add("hidden");
      const files = Array.from(e.dataTransfer ? e.dataTransfer.files : []);
      if (files.length && !$("#app").classList.contains("hidden")) uploadFiles(files);
    });

    window.addEventListener("beforeunload", (e) => {
      if (state.streaming) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
  }

  // ------------------------------------------------------------ start
  load();
  wire();
  fetch("/api/me", { credentials: "same-origin" })
    .then((r) => r.json())
    .then((me) => (me.authed ? boot() : showLogin()))
    .catch(() => showLogin());
})();
