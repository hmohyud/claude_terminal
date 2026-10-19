(() => {
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const PREFS_KEY = "claude-terminal.prefs";
  const LEGACY_KEY = "claude-terminal.v1";

  const JURISDICTIONS = [
    "Federal (U.S.)", "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware",
    "District of Columbia", "Florida", "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky",
    "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota", "Mississippi", "Missouri", "Montana",
    "Nebraska", "Nevada", "New Hampshire", "New Jersey", "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio",
    "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah",
    "Vermont", "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming", "Puerto Rico",
  ];

  // One-click tasks. They drop a prompt into the box; the user can edit before sending.
  const TEMPLATES = [
    { label: "Summarize", hint: "What it is, key terms, anything unfavorable", text: "Summarize the attached document(s). Cover: (1) what it is and who the parties are, (2) the key terms, obligations and dates, (3) anything unusual, missing or unfavorable. Keep it to about one page." },
    { label: "Issue-spot", hint: "Legal issues, rules, risks", text: "Identify the legal issues raised by the attached document(s) and the facts I have given. For each issue give the governing rule with authority, how it likely applies, which facts would change the answer, and a risk level." },
    { label: "Memo (IRAC)", hint: "Short answer first, then analysis", text: "Draft a legal memorandum in IRAC format on the question below. Put a short answer up front, cite authority, and note any contrary authority or open questions.\n\nQuestion: " },
    { label: "Plain English", hint: "Explain it to a non-lawyer", text: "Explain the attached document(s) in plain English for a non-lawyer: what it does, what each side must do, and what to watch out for." },
    { label: "Key dates", hint: "Deadlines and notice periods", text: "List every date, deadline, notice period and time limit in the attached document(s) in a table: what it is, when it falls or how it is computed, who it applies to, and what happens if it is missed." },
    { label: "Risky clauses", hint: "Unfavorable terms with suggested fixes", text: "Review the attached document(s) for provisions that are unfavorable, unusual or risky (indemnity, limitation of liability, termination, non-compete, assignment, governing law, arbitration, auto-renewal, fees, warranties). Quote each clause, explain the risk, and suggest revised language." },
    { label: "Compare", hint: "Differences between two drafts", text: "Compare the attached documents. List every substantive difference (added, removed or changed terms) in a table, and say which side each change favors." },
    { label: "Defined terms", hint: "Every definition, with problems flagged", text: "Extract every defined term in the attached document(s) with its definition, and flag any term that is used inconsistently, circularly, or before it is defined." },
    { label: "Draft a letter", hint: "Demand, notice or response", text: "Draft a professional letter based on the facts below. State the facts, the legal basis, what is requested, and a deadline for a response. Formal tone. Use [brackets] for details I have not given.\n\nType of letter (demand, notice, response): \nFacts: " },
    { label: "Check citations", hint: "Confidence in each authority cited", text: "List every case, statute, regulation and rule cited in your previous answer. For each one, say how confident you are that the citation is accurate and that it supports the proposition it was cited for, and flag anything that must be verified before use." },
  ];

  const state = {
    index: [],
    loaded: new Map(),
    activeId: null,
    settings: {},
    prefs: { sidebar: true, activeId: null },
    models: [],
    limits: {},
    legalPrompt: "",
    defaultModel: "claude-opus-5-5",
    streaming: null,
    attachments: [],
    histIdx: -1,
    live: { budget: null, today: null, rateLimit: null },
    saveTimers: new Map(),
  };

  // ------------------------------------------------------------ helpers
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtCost = (c) => (c == null ? "–" : "$" + c.toFixed(c < 0.01 ? 4 : c < 1 ? 3 : 2));
  const fmtNum = (n) => (n == null ? "–" : Number(n).toLocaleString());
  const fmtBytes = (b) => (b < 1024 ? b + " B" : b < 1048576 ? (b / 1024).toFixed(1) + " KB" : (b / 1048576).toFixed(1) + " MB");
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const fmtAgo = (ts) => {
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + " min ago";
    if (s < 86400) return Math.floor(s / 3600) + " h ago";
    if (s < 7 * 86400) return Math.floor(s / 86400) + " d ago";
    return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
  };
  const stamp = (ts) => new Date(ts || Date.now()).toISOString().slice(0, 19).replace(/[:T]/g, "-");
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

  function loadPrefs() {
    try {
      Object.assign(state.prefs, JSON.parse(localStorage.getItem(PREFS_KEY) || "{}"));
    } catch {
      /* fresh */
    }
  }
  function savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs));
    } catch {
      /* ignore */
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

  function downloadBlob(blob, name) {
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
  const downloadText = (text, name, mime = "text/plain") => downloadBlob(new Blob([text], { type: mime + ";charset=utf-8" }), name);

  async function downloadDocx(markdown, title) {
    try {
      const res = await api("/api/export/docx", { method: "POST", body: { title, markdown } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      downloadBlob(await res.blob(), `${safeFile(title)}.docx`);
    } catch (e) {
      note(`Word export failed: ${e.message}`);
    }
  }
  const safeFile = (s) => String(s || "document").replace(/[\\/:*?"<>|]+/g, "_").trim().slice(0, 60) || "document";

  const EXT = { python: "py", py: "py", javascript: "js", js: "js", typescript: "ts", ts: "ts", json: "json", html: "html", css: "css", bash: "sh", sh: "sh", shell: "sh", powershell: "ps1", sql: "sql", yaml: "yml", yml: "yml", markdown: "md", md: "md", go: "go", rust: "rs", java: "java", c: "c", cpp: "cpp", csharp: "cs", php: "php", ruby: "rb", swift: "swift", xml: "xml", diff: "diff", text: "txt", txt: "txt", plaintext: "txt", csv: "csv" };
  const extFor = (lang) => EXT[(lang || "").toLowerCase()] || "txt";

  // ------------------------------------------------------------ threads
  const active = () => (state.activeId && state.loaded.get(state.activeId)) || null;
  const modelInfo = (id) => state.models.find((m) => m.id === id || (id && id.startsWith(m.id + "-"))) || null;
  const summaryOf = (t) => ({ id: t.id, title: t.title, createdAt: t.createdAt, updatedAt: t.updatedAt, cost: t.cost || 0, count: t.messages.filter((m) => m.role !== "note").length, jurisdiction: t.jurisdiction, model: t.model });

  function newThread() {
    // Reuse the current thread if it is still empty.
    const cur = active();
    if (cur && !cur.messages.length && cur.title === "New thread") {
      $("#input").focus();
      return cur;
    }
    const t = {
      id: uid(), title: "New thread", createdAt: Date.now(), updatedAt: Date.now(),
      model: state.settings.model || state.defaultModel, system: "", jurisdiction: state.settings.jurisdiction || "Federal (U.S.)",
      messages: [], cost: 0, tokens: { in: 0, out: 0 }, unsaved: true,
    };
    state.loaded.set(t.id, t);
    state.index.unshift(summaryOf(t));
    setActive(t.id);
    state.attachments = [];
    renderAll();
    $("#input").focus();
    return t;
  }
  function ensureThread() {
    return active() || newThread();
  }
  function setActive(id) {
    // Drop an abandoned empty thread.
    const prev = active();
    if (prev && prev.id !== id && prev.unsaved && !prev.messages.length) {
      state.loaded.delete(prev.id);
      state.index = state.index.filter((s) => s.id !== prev.id);
    }
    state.activeId = id;
    state.prefs.activeId = id;
    savePrefs();
  }

  function saveThread(t, immediate) {
    if (!t) return;
    t.updatedAt = Date.now();
    const i = state.index.findIndex((s) => s.id === t.id);
    if (i >= 0) state.index[i] = summaryOf(t);
    else state.index.unshift(summaryOf(t));
    clearTimeout(state.saveTimers.get(t.id));
    const run = async () => {
      state.saveTimers.delete(t.id);
      try {
        const { unsaved, ...body } = t;
        await apiJson(`/api/threads/${t.id}`, { method: "PUT", body });
        delete t.unsaved;
      } catch (e) {
        note(`Could not save this thread: ${e.message}`);
      }
    };
    if (immediate) run();
    else state.saveTimers.set(t.id, setTimeout(run, 600));
  }

  async function openThread(id) {
    if (!state.loaded.has(id)) {
      try {
        const t = await apiJson(`/api/threads/${id}`);
        t.tokens = t.tokens || { in: 0, out: 0 };
        state.loaded.set(id, t);
      } catch (e) {
        note(`Could not open that thread: ${e.message}`);
        return;
      }
    }
    setActive(id);
    state.attachments = [];
    renderAll();
    $("#input").focus();
  }

  async function deleteThread(id) {
    const s = state.index.find((x) => x.id === id);
    if (s && s.count && !confirm(`Delete "${s.title}"?`)) return;
    if (state.streaming && state.streaming.threadId === id) state.streaming.ctrl.abort();
    const t = state.loaded.get(id);
    if (!(t && t.unsaved)) {
      try {
        await apiJson(`/api/threads/${id}`, { method: "DELETE" });
      } catch (e) {
        if (!/No such/.test(e.message)) return note(`Could not delete: ${e.message}`);
      }
    }
    state.loaded.delete(id);
    state.index = state.index.filter((x) => x.id !== id);
    if (state.activeId === id) {
      state.activeId = null;
      if (state.index[0]) await openThread(state.index[0].id);
      else newThread();
    }
    renderAll();
  }

  async function refreshIndex() {
    const r = await apiJson("/api/threads");
    state.index = r.threads;
    state.limits.threads = r.limit;
    // Keep threads we created locally but haven't saved yet.
    for (const t of state.loaded.values()) if (t.unsaved && !state.index.find((s) => s.id === t.id)) state.index.unshift(summaryOf(t));
  }

  // Bring threads saved by the older browser-only version onto the server, once.
  async function migrateLegacy() {
    let raw;
    try {
      raw = JSON.parse(localStorage.getItem(LEGACY_KEY) || "null");
    } catch {
      raw = null;
    }
    if (!raw || !Array.isArray(raw.convs) || !raw.convs.length) return;
    let moved = 0;
    for (const c of raw.convs) {
      if (!c || !c.id || !/^[a-z0-9]{6,24}$/.test(c.id) || !Array.isArray(c.messages)) continue;
      try {
        await apiJson(`/api/threads/${c.id}`, { method: "PUT", body: { ...c, title: c.title || "Untitled", jurisdiction: null } });
        moved += 1;
      } catch {
        /* skip */
      }
    }
    localStorage.removeItem(LEGACY_KEY);
    if (moved) await refreshIndex();
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

  function composeSystem(t) {
    const base = (t.system && t.system.trim()) || (state.settings.systemPrompt && state.settings.systemPrompt.trim()) || state.legalPrompt || "";
    const extras = [];
    if (t.jurisdiction) extras.push(`Default jurisdiction: ${t.jurisdiction}.`);
    extras.push(`Today's date: ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}.`);
    return base ? `${base}\n\n${extras.join(" ")}` : extras.join(" ");
  }

  function note(text) {
    const t = ensureThread();
    t.messages.push({ id: uid(), role: "note", text, ts: Date.now() });
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
    const list = $("#thread-list");
    list.innerHTML = "";
    const sorted = state.index.slice().sort((a, b) => b.updatedAt - a.updatedAt);
    if (!sorted.length) list.appendChild(el("div", "side-empty", "No threads yet."));
    for (const s of sorted) {
      const row = el("div", "thread" + (s.id === state.activeId ? " active" : ""));
      row.appendChild(el("div", "name", esc(s.title || "Untitled")));
      const bits = [];
      if (s.jurisdiction) bits.push(s.jurisdiction);
      bits.push(fmtAgo(s.updatedAt));
      if (s.cost) bits.push(fmtCost(s.cost));
      row.appendChild(el("div", "sub", esc(bits.join(" · "))));
      const del = btn("×", (e) => {
        e.stopPropagation();
        deleteThread(s.id);
      }, "del");
      del.title = "Delete";
      row.appendChild(del);
      row.addEventListener("click", () => openThread(s.id));
      list.appendChild(row);
    }
    $("#app").classList.toggle("no-sidebar", !state.prefs.sidebar);
  }

  function fillSelect(sel, options, value) {
    sel.innerHTML = "";
    for (const o of options) sel.appendChild(o instanceof Option ? o : new Option(o, o));
    sel.value = value;
  }

  function renderTopbar() {
    const t = active();
    $("#thread-title").textContent = t ? t.title : "New thread";
    const model = t ? t.model : state.settings.model || state.defaultModel;
    const opts = state.models.map((m) => {
      const o = new Option(m.name + (m.in != null ? `  ·  $${m.in}/$${m.out}` : ""), m.id);
      o.title = m.in != null ? `${m.display}: $${m.in} per million input tokens, $${m.out} per million output tokens` : m.display;
      return o;
    });
    if (model && !state.models.find((m) => m.id === model)) opts.unshift(new Option(model, model));
    fillSelect($("#model"), opts, model);
    const jur = t ? t.jurisdiction || "" : state.settings.jurisdiction || "";
    fillSelect($("#jurisdiction"), [new Option("none", ""), ...JURISDICTIONS.map((j) => new Option(j, j))], jur);
    renderEffortOptions();
    renderStats();
    renderUsageChip();
  }

  function renderEffortOptions() {
    const t = active();
    const info = modelInfo(t ? t.model : state.settings.model || state.defaultModel);
    const efforts = info ? info.efforts : [];
    const sel = $("#effort");
    fillSelect(sel, [new Option(info && info.defaultEffort ? `default (${info.defaultEffort})` : "default", ""), ...efforts.map((e) => new Option(e, e))], efforts.includes(state.settings.effort) ? state.settings.effort : "");
    sel.disabled = efforts.length === 0;
  }

  function renderStats() {
    const t = active();
    const s = $("#thread-stats");
    if (!t || !t.messages.length) return (s.textContent = "");
    s.textContent = `${fmtNum(t.tokens.in)} in · ${fmtNum(t.tokens.out)} out · ${fmtCost(t.cost)} this thread`;
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
    chip.innerHTML = parts.length ? parts.join(" · ") : "usage";
  }

  function renderTemplates() {
    const box = $("#templates");
    box.innerHTML = "";
    for (const tpl of TEMPLATES) {
      const b = btn(tpl.label, () => useTemplate(tpl));
      b.title = tpl.hint;
      box.appendChild(b);
    }
  }

  function useTemplate(tpl) {
    const input = $("#input");
    input.value = input.value.trim() ? input.value.replace(/\s*$/, "\n\n") + tpl.text : tpl.text;
    autosize();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function renderTranscript() {
    const box = $("#transcript");
    const t = active();
    const wasBottom = atBottom();
    box.innerHTML = "";
    if (!t || !t.messages.length) {
      const empty = el("div", "empty");
      empty.appendChild(el("h2", "", "What are you working on?"));
      empty.appendChild(el("p", "", `Ask a question, or attach a contract, filing, letter or statute (PDF, Word, image or text) and pick a task. Answers follow ${esc(t && t.jurisdiction ? t.jurisdiction : "your default jurisdiction")} unless you say otherwise.`));
      const grid = el("div", "starters");
      for (const tpl of TEMPLATES.slice(0, 6)) {
        const b = btn("", () => useTemplate(tpl), "starter");
        b.innerHTML = `<b>${esc(tpl.label)}</b><span>${esc(tpl.hint)}</span>`;
        grid.appendChild(b);
      }
      empty.appendChild(grid);
      box.appendChild(empty);
      return;
    }
    for (const m of t.messages) box.appendChild(renderMessage(m, t));
    if (wasBottom) box.scrollTop = box.scrollHeight;
  }

  function atBottom() {
    const b = $("#transcript");
    return b.scrollHeight - b.scrollTop - b.clientHeight < 60;
  }

  const KIND_ICON = { pdf: "⎘", docx: "▤", text: "≡" };
  function fileChip(f, { removable, onRemove } = {}) {
    const a = el("span", "file-chip");
    a.title = `Preview ${f.name}`;
    a.addEventListener("click", () => openPreview(f));
    if (f.kind === "image") {
      const img = el("img");
      img.src = `/api/files/${f.id}?inline=1`;
      img.alt = "";
      a.appendChild(img);
    } else a.appendChild(el("span", "", KIND_ICON[f.kind] || "≡"));
    a.appendChild(el("span", "fname", esc(f.name)));
    a.appendChild(el("span", "fsize", fmtBytes(f.size)));
    if (removable) {
      const rm = btn("×", (e) => {
        e.stopPropagation();
        onRemove(e);
      }, "rm");
      rm.title = "Remove";
      a.appendChild(rm);
    } else {
      const dl = el("a", "dl", "↓");
      dl.href = `/api/files/${f.id}`;
      dl.title = `Download ${f.name}`;
      dl.addEventListener("click", (e) => e.stopPropagation());
      a.appendChild(dl);
    }
    return a;
  }

  function renderMessage(m, t) {
    const root = el("div", `msg ${m.role}`);
    root.dataset.mid = m.id;
    const head = el("div", "msg-head");
    head.appendChild(el("span", "who", m.role === "user" ? "You" : m.role === "assistant" ? "Claude" : "Note"));
    if (m.role === "assistant" && m.meta && m.meta.model) head.appendChild(el("span", "model", esc(m.meta.model)));
    head.appendChild(el("span", "time", fmtTime(m.ts)));
    const actions = el("span", "actions");
    if (m.role === "assistant") {
      actions.appendChild(btn("Copy", () => navigator.clipboard.writeText(m.text || "")));
      actions.appendChild(btn("Word", () => downloadDocx(m.text || "", t.title)));
      actions.appendChild(btn("Print", () => printMessage(m)));
      actions.appendChild(btn("Save to files", () => saveToFiles(m, t)));
      actions.appendChild(btn("Retry", () => retryFrom(t, m)));
    } else if (m.role === "user") {
      actions.appendChild(btn("Copy", () => navigator.clipboard.writeText(m.text || "")));
      actions.appendChild(btn("Edit", () => editFrom(t, m)));
    }
    actions.appendChild(btn("Delete", () => {
      t.messages = t.messages.filter((x) => x !== m);
      saveThread(t);
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
      think.appendChild(el("summary", "", "Reasoning summary"));
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
        return DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: false }));
      } catch {
        /* fall through */
      }
    }
    return `<pre class="plain">${esc(text)}</pre>`;
  }

  function renderBody(body, m, final) {
    if (m.meta && m.meta.error && !m.text) {
      body.className = "body error";
      body.textContent = "Error: " + m.meta.error;
      return;
    }
    body.className = "body md" + (m.pending && !final ? " cursor" : "");
    body.innerHTML = renderMarkdown(m.text || "");
    if (final) decorateCode(body);
    if (m.meta && m.meta.error && m.text) body.appendChild(el("div", "error", "Error: " + esc(m.meta.error)));
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
      bar.appendChild(btn("Copy", () => navigator.clipboard.writeText(code.innerText)));
      bar.appendChild(btn("Download", () => downloadText(code.innerText, `snippet.${extFor(lang)}`)));
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
    if (x.fallback) bits.push(`<span class="stop-bad">answered by fallback model ${esc(x.fallback)}</span>`);
    if (x.stop_reason && x.stop_reason !== "end_turn") bits.push(`<span class="stop-bad">${esc(x.stop_reason === "max_tokens" ? "cut off at the reply length limit" : x.stop_reason)}</span>`);
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
        if (!s.msg.text && !s.thinkOpened) {
          think.open = true;
          s.thinkOpened = true;
        }
      }
      if (s.msg.text && s.thinkOpened && !s.thinkClosed) {
        think.open = false;
        s.thinkClosed = true;
      }
      renderBody($(".body", root), s.msg, false);
      if (wasBottom) $("#transcript").scrollTop = $("#transcript").scrollHeight;
    });
  }

  function printMessage(m) {
    const root = msgEl(m);
    if (!root) return;
    root.classList.add("print-target");
    document.body.classList.add("print-one");
    const cleanup = () => {
      root.classList.remove("print-target");
      document.body.classList.remove("print-one");
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    window.print();
    setTimeout(cleanup, 2000);
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
        if (entry.evicted) note(`Storage is full: the ${entry.evicted} oldest file(s) were removed to make room (first in, first out).`);
      } catch (e) {
        note(`Upload failed: ${e.message}`);
      }
    }
    renderAttachments();
    return added;
  }

  async function saveToFiles(m, t) {
    const name = `${safeFile(t.title)}-${stamp(m.ts)}.md`;
    const added = await uploadFiles([new File([m.text || ""], name, { type: "text/markdown" })], { attach: false, source: "assistant" });
    if (added.length) note(`Saved to Files as ${added[0].name}.`);
  }

  // ------------------------------------------------------------ chat
  async function sendMessage(text) {
    const t = ensureThread();
    if (state.streaming) return note("Still answering. Press Stop first.");
    const files = state.attachments.splice(0);
    renderAttachments();
    if (!text && !files.length) return;
    t.messages.push({ id: uid(), role: "user", text, files, ts: Date.now() });
    if (t.title === "New thread" || !t.title) t.title = (text || files[0].name).replace(/\s+/g, " ").slice(0, 60);
    const am = { id: uid(), role: "assistant", text: "", thinking: "", meta: { model: t.model }, ts: Date.now(), pending: true };
    t.messages.push(am);
    saveThread(t, true);
    renderAll();
    await streamInto(t, am);
  }

  async function streamInto(t, am) {
    const ctrl = new AbortController();
    state.streaming = { ctrl, threadId: t.id, msg: am };
    document.body.classList.add("streaming");
    const info = modelInfo(t.model);
    const body = {
      conv: t.id,
      model: t.model || state.settings.model || state.defaultModel,
      system: composeSystem(t),
      messages: toApiMessages(t.messages.filter((m) => m !== am)),
      effort: info && info.efforts.includes(state.settings.effort) ? state.settings.effort : null,
      maxTokens: state.settings.maxTokens || 16000,
      showThinking: state.settings.showThinking !== false,
      fallbacks: state.settings.fallbacks !== false,
    };
    try {
      const res = await api("/api/chat", { method: "POST", body, signal: ctrl.signal });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      await readSSE(res, (ev) => handleEvent(ev, t, am));
    } catch (e) {
      if (e.name === "AbortError") am.meta.stopped = true;
      else am.meta.error = e.message;
    } finally {
      delete am.pending;
      state.streaming = null;
      document.body.classList.remove("streaming");
      saveThread(t, true);
      const root = msgEl(am);
      if (root) {
        const wasBottom = atBottom();
        root.replaceWith(renderMessage(am, t));
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

  function handleEvent(ev, t, am) {
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
        if (ev.usage) {
          t.tokens.in += (ev.usage.input_tokens || 0) + (ev.usage.cache_read_input_tokens || 0) + (ev.usage.cache_creation_input_tokens || 0);
          t.tokens.out += ev.usage.output_tokens || 0;
        }
        if (ev.cost) t.cost = (t.cost || 0) + ev.cost;
        state.live.budget = ev.budget || state.live.budget;
        state.live.today = ev.today;
        if (ev.rateLimit) state.live.rateLimit = ev.rateLimit;
        if (ev.stop_reason === "refusal") {
          const d = ev.stop_details || {};
          am.meta.error = `Claude declined this request${d.category ? ` (${d.category})` : ""}${d.explanation ? ": " + d.explanation : "."}`;
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

  async function retryFrom(t, m) {
    if (state.streaming) return;
    const idx = t.messages.indexOf(m);
    if (idx < 0) return;
    t.messages.splice(idx);
    const am = { id: uid(), role: "assistant", text: "", thinking: "", meta: { model: t.model }, ts: Date.now(), pending: true };
    t.messages.push(am);
    renderTranscript();
    await streamInto(t, am);
  }

  function editFrom(t, m) {
    if (state.streaming) return;
    const idx = t.messages.indexOf(m);
    if (idx < 0) return;
    t.messages.splice(idx);
    state.attachments = (m.files || []).slice();
    saveThread(t);
    renderTranscript();
    renderAttachments();
    const input = $("#input");
    input.value = m.text || "";
    autosize();
    input.focus();
  }

  // ------------------------------------------------------------ thread menu + export
  function threadMarkdown(t) {
    const lines = [`# ${t.title}`, "", `Jurisdiction: ${t.jurisdiction || "not set"}  `, `Model: ${t.model}  `, `Exported: ${new Date().toLocaleString()}`, ""];
    for (const m of t.messages) {
      if (m.role === "note") continue;
      lines.push(`## ${m.role === "user" ? "You" : "Claude"} · ${new Date(m.ts).toLocaleString()}`, "");
      if (m.files && m.files.length) lines.push(m.files.map((f) => `*Attached: ${f.name}*`).join("  "), "");
      lines.push(m.text || "", "");
    }
    return lines.join("\n");
  }

  async function threadAction(act) {
    const t = active();
    $("#thread-menu").classList.add("hidden");
    if (!t) return;
    switch (act) {
      case "rename": {
        const v = prompt("Thread title", t.title);
        if (v != null && v.trim()) {
          t.title = v.trim().slice(0, 120);
          saveThread(t);
          renderAll();
        }
        return;
      }
      case "instructions":
        $("#thread-system").value = t.system || "";
        $("#instructions-panel").classList.remove("hidden");
        $("#thread-system").focus();
        return;
      case "docx":
        return downloadDocx(threadMarkdown(t), t.title);
      case "md":
        return downloadText(threadMarkdown(t), `${safeFile(t.title)}.md`, "text/markdown");
      case "json":
        return downloadText(JSON.stringify(t, null, 2), `${safeFile(t.title)}.json`, "application/json");
      case "print":
        return window.print();
      case "clear":
        if (!t.messages.length || confirm("Remove every message in this thread?")) {
          t.messages = [];
          t.cost = 0;
          t.tokens = { in: 0, out: 0 };
          saveThread(t, true);
          renderAll();
        }
        return;
      case "delete":
        return deleteThread(t.id);
      default:
        return;
    }
  }

  // ------------------------------------------------------------ slash commands
  const HELP = `Commands
  /new                  start a new thread
  /title <text>         rename this thread
  /jurisdiction <name>  set the jurisdiction for this thread (e.g. /jurisdiction Texas, or none)
  /system [text|clear]  instructions for this thread only
  /model [name]         show or switch model (e.g. /model sonnet) · /models lists them with prices
  /effort <level>       low · medium · high · xhigh · max · default
  /thinking on|off      show the reasoning summary
  /max <n>              longest reply, in tokens
  /fallback on|off      retry on another model if a reply is refused by safety filters
  /retry · /undo        regenerate the last answer · remove the last exchange
  /export [md|docx|json] download this thread
  /print                print this thread
  /files · /usage       open the Files or Usage panel
  /context              count the tokens Claude will read on the next message
  /budget <usd|off>     monthly budget for the "left" readout
  /clear · /delete      clear messages · delete this thread
  /logout               sign this browser out
Keys: Enter sends · Shift+Enter new line · Esc stops · ↑/↓ recall earlier messages.
Files: drop, paste or attach PDFs, Word (.docx), images and text. Click a file to preview it.`;

  async function runCommand(line) {
    const [cmd] = line.slice(1).trim().split(/\s+/);
    const arg = line.slice(1).trim().slice(cmd.length).trim();
    const t = active();
    switch ((cmd || "").toLowerCase()) {
      case "help":
        return note(HELP);
      case "new":
        return newThread();
      case "clear":
        return threadAction("clear");
      case "delete":
        return threadAction("delete");
      case "print":
        return threadAction("print");
      case "title":
        if (t && arg) {
          t.title = arg.slice(0, 120);
          saveThread(t);
          renderAll();
        }
        return;
      case "jurisdiction": {
        if (!t) return;
        if (!arg) return note(`Jurisdiction: ${t.jurisdiction || "none"}`);
        const q = arg.toLowerCase();
        const j = /^(none|off|clear)$/.test(q) ? "" : JURISDICTIONS.find((x) => x.toLowerCase() === q) || JURISDICTIONS.find((x) => x.toLowerCase().startsWith(q));
        if (j === undefined) return note(`No jurisdiction matches "${arg}".`);
        t.jurisdiction = j || null;
        saveThread(t);
        renderTopbar();
        return note(`Jurisdiction → ${j || "none"}`);
      }
      case "model": {
        if (!arg) return note(`Model: ${t ? t.model : state.settings.model || state.defaultModel}`);
        const q = arg.toLowerCase();
        const m = state.models.find((x) => x.id === q) || state.models.find((x) => x.id.includes(q) || x.name.toLowerCase().includes(q));
        if (!m) return note(`No model matches "${arg}". Try /models.`);
        setModel(m.id);
        return note(`Model → ${m.id}`);
      }
      case "models":
        return note("Models (price per 1M tokens, in / out)\n" + state.models.map((m) => `  ${m.id.padEnd(20)} ${m.in != null ? `$${m.in} / $${m.out}` : "?"}`).join("\n"));
      case "system":
        if (!t) return;
        if (!arg) return note(`Instructions for this thread: ${t.system ? "\n" + t.system : "(default)"}`);
        t.system = arg.toLowerCase() === "clear" ? "" : arg;
        saveThread(t);
        return note(t.system ? "Thread instructions set." : "Thread instructions cleared; using the default.");
      case "effort": {
        if (!arg) return note(`Effort: ${state.settings.effort || "default"}`);
        const v = arg.toLowerCase();
        if (/^(default|off)$/.test(v)) await saveSettings({ effort: null });
        else if (["low", "medium", "high", "xhigh", "max"].includes(v)) await saveSettings({ effort: v });
        else return note("Effort must be low, medium, high, xhigh, max or default.");
        renderEffortOptions();
        return note(`Effort → ${state.settings.effort || "default"}`);
      }
      case "thinking":
        await saveSettings({ showThinking: arg ? /^(on|1|true|yes)$/i.test(arg) : !state.settings.showThinking });
        return note(`Reasoning summary → ${state.settings.showThinking ? "shown" : "hidden"}`);
      case "max": {
        const n = parseInt(arg, 10);
        if (!n) return note(`Longest reply: ${state.settings.maxTokens} tokens`);
        await saveSettings({ maxTokens: n });
        return note(`Longest reply → ${state.settings.maxTokens} tokens`);
      }
      case "fallback":
        await saveSettings({ fallbacks: arg ? /^(on|1|true|yes)$/i.test(arg) : !state.settings.fallbacks });
        return note(`Refusal fallback → ${state.settings.fallbacks ? "on" : "off"}`);
      case "retry": {
        if (!t) return;
        const last = t.messages.slice().reverse().find((m) => m.role === "assistant");
        return last ? retryFrom(t, last) : undefined;
      }
      case "undo":
        if (!t) return;
        while (t.messages.length && t.messages[t.messages.length - 1].role !== "user") t.messages.pop();
        t.messages.pop();
        saveThread(t);
        renderTranscript();
        return;
      case "export":
        return threadAction(arg.toLowerCase() === "json" ? "json" : arg.toLowerCase() === "docx" || arg.toLowerCase() === "word" ? "docx" : "md");
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
        if (!off && !(n >= 0)) return note("Usage: /budget 25   or   /budget off");
        await saveSettings({ monthlyBudget: n });
        await refreshUsage();
        return note(off ? "Monthly budget cleared." : `Monthly budget → $${n}`);
      }
      case "logout":
        return logout();
      default:
        return note(`Unknown command /${cmd}. Try /help.`);
    }
  }

  function setModel(id) {
    const t = active();
    if (t) {
      t.model = id;
      saveThread(t);
    }
    saveSettings({ model: id });
    renderTopbar();
  }

  async function countContext() {
    const t = active();
    if (!t || !t.messages.some((m) => m.role === "user")) return note("Nothing in this thread yet.");
    try {
      const msgs = toApiMessages(t.messages);
      if (msgs[msgs.length - 1].role !== "user") msgs.push({ role: "user", content: "." });
      const r = await apiJson("/api/count", { method: "POST", body: { model: t.model, system: composeSystem(t), messages: msgs } });
      const info = modelInfo(t.model);
      const est = info && info.in != null ? ` ≈ ${fmtCost((r.input_tokens * info.in) / 1e6)} of input per message` : "";
      note(`Context: ${fmtNum(r.input_tokens)} tokens${est}`);
    } catch (e) {
      note(`Count failed: ${e.message}`);
    }
  }

  // ------------------------------------------------------------ settings
  async function saveSettings(patch) {
    try {
      state.settings = await apiJson("/api/settings", { method: "PUT", body: patch });
      applyTheme();
    } catch (e) {
      note(`Could not save settings: ${e.message}`);
    }
  }

  function applyTheme() {
    const dark = state.settings.theme === "dark";
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    const l = $("#hljs-light");
    const d = $("#hljs-dark");
    if (l) l.disabled = dark;
    if (d) d.disabled = !dark;
  }

  function openSettings() {
    const s = state.settings;
    $("#set-system").value = s.systemPrompt || state.legalPrompt || "";
    fillSelect($("#set-jurisdiction"), [new Option("none", ""), ...JURISDICTIONS.map((j) => new Option(j, j))], s.jurisdiction || "");
    $("#set-budget").value = s.monthlyBudget == null ? "" : s.monthlyBudget;
    $("#set-max").value = s.maxTokens || 16000;
    $("#set-theme").value = s.theme === "dark" ? "dark" : "light";
    $("#set-thinking").checked = s.showThinking !== false;
    $("#set-fallback").checked = s.fallbacks !== false;
    const L = state.limits;
    $("#set-limits").textContent = L.threads ? `Keeps the newest ${L.threads} threads and ${L.files} files (up to ${L.filesMb} MB); older ones are removed first in, first out.` : "";
    $("#settings-panel").classList.remove("hidden");
  }

  async function submitSettings() {
    const sys = $("#set-system").value.trim();
    await saveSettings({
      systemPrompt: sys && sys !== (state.legalPrompt || "").trim() ? sys : null,
      jurisdiction: $("#set-jurisdiction").value || null,
      monthlyBudget: $("#set-budget").value === "" ? null : Number($("#set-budget").value),
      maxTokens: Number($("#set-max").value) || 16000,
      theme: $("#set-theme").value,
      showThinking: $("#set-thinking").checked,
      fallbacks: $("#set-fallback").checked,
    });
    $("#settings-panel").classList.add("hidden");
    refreshUsage().catch(() => {});
    renderTopbar();
    note("Settings saved.");
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
    body.textContent = "Loading…";
    try {
      const u = await refreshUsage();
      body.innerHTML = "";
      const cards = el("div", "cards");
      for (const [k, label] of [["today", "Today"], ["week", "Last 7 days"], ["month", "This month"], ["all", "All time"]]) {
        const s = u.totals[k];
        cards.appendChild(el("div", "card", `<div class="k">${label}</div><div class="v">${fmtCost(s.cost)}</div><div class="s">${fmtNum(s.requests)} replies · ${fmtNum(s.input + s.cacheRead + s.cacheWrite)} in · ${fmtNum(s.output)} out</div>`));
      }
      body.appendChild(cards);

      body.appendChild(el("div", "section", "Monthly budget"));
      const row = el("div", "budget-row");
      const input = el("input");
      input.type = "number";
      input.min = "0";
      input.step = "1";
      input.placeholder = "USD";
      input.value = u.budget.monthly == null ? "" : u.budget.monthly;
      row.appendChild(el("span", "", "$"));
      row.appendChild(input);
      row.appendChild(btn("Save", async () => {
        await saveSettings({ monthlyBudget: input.value === "" ? null : Number(input.value) });
        openUsage();
      }, "small"));
      if (u.budget.monthly) {
        const pct = Math.min(1, u.budget.spent / u.budget.monthly);
        const bar = el("div", "bar");
        const fill = el("div");
        fill.style.width = (pct * 100).toFixed(1) + "%";
        fill.className = pct >= 1 ? "bad" : pct >= 0.8 ? "warn" : "";
        bar.appendChild(fill);
        row.appendChild(bar);
        row.appendChild(el("span", "", `${fmtCost(u.budget.spent)} spent · <b>${fmtCost(Math.max(0, u.budget.remaining))} remaining</b> of ${fmtCost(u.budget.monthly)} in ${u.month}`));
      } else {
        row.appendChild(el("span", "", `No budget set. ${fmtCost(u.budget.spent)} spent in ${u.month}.`));
      }
      body.appendChild(row);

      body.appendChild(el("div", "section", "Rate limits (from the last reply)"));
      const rl = u.rateLimit;
      if (rl) {
        const grid = el("div", "rl");
        for (const [key, label] of [["requests", "Requests per minute"], ["tokens", "Tokens per minute"], ["input-tokens", "Input tokens per minute"], ["output-tokens", "Output tokens per minute"]]) {
          const rem = rl[`${key}-remaining`];
          const lim = rl[`${key}-limit`];
          if (rem == null && lim == null) continue;
          const reset = rl[`${key}-reset`];
          const secs = reset ? Math.max(0, Math.round((new Date(reset).getTime() - Date.now()) / 1000)) : null;
          grid.appendChild(el("div", "card", `<div class="k">${label}</div><div class="v">${fmtNum(rem)} <span class="s">of ${fmtNum(lim)} left</span></div><div class="s">${secs != null ? `resets in ${secs}s` : ""}</div>`));
        }
        grid.appendChild(el("div", "card", `<div class="k">Captured</div><div class="v">${fmtAgo(rl.at)}</div><div class="s">${new Date(rl.at).toLocaleTimeString()}</div>`));
        body.appendChild(grid);
      } else body.appendChild(el("div", "fine", "No reply yet. Send a message to populate this."));

      body.appendChild(el("div", "section", "Last 30 days"));
      const spark = el("div", "spark");
      const max = Math.max(0.000001, ...u.days.map((d) => d.cost));
      for (const d of u.days) {
        const b = el("div");
        b.style.height = Math.max(2, (d.cost / max) * 100) + "%";
        b.title = `${d.day}: ${fmtCost(d.cost)} · ${d.requests} replies`;
        spark.appendChild(b);
      }
      body.appendChild(spark);
      body.appendChild(el("div", "spark-labels", `<span>${u.days[0].day}</span><span>${u.days[u.days.length - 1].day}</span>`));

      if (u.byModel.length) {
        body.appendChild(el("div", "section", "By model, this month"));
        const tb = el("table", "t", `<tr><th>Model</th><th class="num">Replies</th><th class="num">Input</th><th class="num">Cached</th><th class="num">Output</th><th class="num">Cost</th></tr>`);
        for (const r of u.byModel) tb.insertAdjacentHTML("beforeend", `<tr><td>${esc(r.model)}</td><td class="num">${fmtNum(r.requests)}</td><td class="num">${fmtNum(r.input)}</td><td class="num">${fmtNum(r.cacheRead)}</td><td class="num">${fmtNum(r.output)}</td><td class="num">${fmtCost(r.cost)}</td></tr>`);
        body.appendChild(tb);
      }
      if (u.recent.length) {
        body.appendChild(el("div", "section", "Recent replies"));
        const tb = el("table", "t", `<tr><th>When</th><th>Model</th><th class="num">In</th><th class="num">Out</th><th class="num">Time</th><th class="num">Cost</th></tr>`);
        for (const r of u.recent) tb.insertAdjacentHTML("beforeend", `<tr><td>${new Date(r.ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td><td>${esc(r.model)}</td><td class="num">${fmtNum(r.input + (r.cacheRead || 0))}</td><td class="num">${fmtNum(r.output)}</td><td class="num">${(r.ms / 1000).toFixed(1)}s</td><td class="num">${fmtCost(r.cost)}</td></tr>`);
        body.appendChild(tb);
      }
      body.appendChild(el("div", "fine", "Costs are estimates: token counts at list prices, recorded by this terminal only. The official figure is on console.anthropic.com."));
    } catch (e) {
      body.textContent = "Could not load usage: " + e.message;
    }
  }

  // ------------------------------------------------------------ files panel
  async function openFiles() {
    const panel = $("#files-panel");
    panel.classList.remove("hidden");
    const body = $("#files-body");
    body.textContent = "Loading…";
    try {
      const r = await apiJson("/api/files");
      const files = r.files || [];
      $("#files-cap").textContent = `${files.length} of ${r.limit} · ${fmtBytes(r.usedBytes || 0)} of ${r.limitMb} MB`;
      body.innerHTML = "";
      if (!files.length) body.appendChild(el("div", "fine", "No files yet. Upload one, drop one into a thread, or use “Save to files” on an answer."));
      for (const f of files) {
        const row = el("div", "file-row");
        if (f.kind === "image") {
          const img = el("img");
          img.src = `/api/files/${f.id}?inline=1`;
          img.alt = "";
          row.appendChild(img);
        } else row.appendChild(el("span", "kind", f.kind));
        row.appendChild(el("span", "fname", esc(f.name)));
        row.appendChild(el("span", "fmeta", `${fmtBytes(f.size)} · ${new Date(f.ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}${f.source === "assistant" ? " · from Claude" : ""}`));
        row.appendChild(btn("Preview", () => openPreview(f), "small"));
        row.appendChild(btn("Attach", () => {
          if (!state.attachments.find((x) => x.id === f.id)) state.attachments.push(f);
          renderAttachments();
          panel.classList.add("hidden");
          $("#input").focus();
        }, "small"));
        const dl = el("a", "", "Download");
        dl.href = `/api/files/${f.id}`;
        row.appendChild(dl);
        row.appendChild(btn("Delete", async () => {
          if (!confirm(`Delete ${f.name}?`)) return;
          await apiJson(`/api/files/${f.id}`, { method: "DELETE" });
          openFiles();
        }, "small danger"));
        body.appendChild(row);
      }
    } catch (e) {
      body.textContent = "Could not load files: " + e.message;
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
    body.appendChild(el("div", "preview-loading", "Loading…"));
    try {
      const p = await apiJson(`/api/files/${f.id}/preview`);
      body.innerHTML = "";
      if (p.kind === "html") {
        const doc = el("div", "doc-preview");
        doc.innerHTML = window.DOMPurify ? DOMPurify.sanitize(p.html) : esc(p.html);
        body.appendChild(doc);
      } else if (p.kind === "text") body.appendChild(el("pre", "text-preview", esc(p.text)));
      else body.appendChild(el("div", "preview-loading", "No preview for this file type."));
    } catch (e) {
      body.innerHTML = "";
      body.appendChild(el("div", "preview-loading", "Could not load the preview: " + esc(e.message)));
    }
  }

  // ------------------------------------------------------------ auth + boot
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

  async function boot(me) {
    $("#login").classList.add("hidden");
    $("#app").classList.remove("hidden");
    try {
      if (!me) me = await (await fetch("/api/me", { credentials: "same-origin" })).json();
      state.legalPrompt = me.legalPrompt || "";
      state.limits = me.limits || {};
      state.defaultModel = me.defaultModel || state.defaultModel;
      const [models, settings] = await Promise.all([apiJson("/api/models").catch(() => []), apiJson("/api/settings").catch(() => ({}))]);
      state.models = models;
      state.settings = settings;
      applyTheme();
      await refreshIndex();
      await migrateLegacy();
    } catch (e) {
      note(`Could not load everything: ${e.message}`);
    }
    renderTemplates();
    const want = state.prefs.activeId && state.index.find((s) => s.id === state.prefs.activeId) ? state.prefs.activeId : state.index[0] && state.index[0].id;
    if (want) await openThread(want);
    else newThread();
    renderAll();
    refreshUsage().catch(() => {});
    $("#input").focus();
  }

  // ------------------------------------------------------------ input + wiring
  function autosize() {
    const t = $("#input");
    t.style.height = "auto";
    t.style.height = Math.min(t.scrollHeight, window.innerHeight * 0.4) + "px";
  }

  function userHistory() {
    const t = active();
    return t ? t.messages.filter((m) => m.role === "user").map((m) => m.text) : [];
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
          err.textContent = data.error || `Error ${res.status}`;
          if (data.retryAfter) {
            let left = data.retryAfter;
            const tick = setInterval(() => {
              left -= 1;
              if (left <= 0) {
                clearInterval(tick);
                err.textContent = "You can try again now.";
              } else err.textContent = `Locked. Try again in ${left}s.`;
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
      } else if (e.key === "Escape") stopStreaming();
      else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && (input.value === "" || state.histIdx >= 0)) {
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

    $("#new-thread").addEventListener("click", () => newThread());
    $("#logout").addEventListener("click", logout);
    $("#usage-btn").addEventListener("click", openUsage);
    $("#usage-chip").addEventListener("click", openUsage);
    $("#files-btn").addEventListener("click", openFiles);
    $("#settings-btn").addEventListener("click", openSettings);
    $("#set-save").addEventListener("click", submitSettings);
    $("#set-system-reset").addEventListener("click", () => {
      $("#set-system").value = state.legalPrompt || "";
    });
    $("#thread-system-save").addEventListener("click", () => {
      const t = active();
      if (t) {
        t.system = $("#thread-system").value.trim();
        saveThread(t);
      }
      $("#instructions-panel").classList.add("hidden");
      note(t && t.system ? "Thread instructions saved." : "Thread instructions cleared; using the default.");
    });
    $("#toggle-sidebar").addEventListener("click", () => {
      state.prefs.sidebar = !state.prefs.sidebar;
      savePrefs();
      renderSidebar();
    });
    $("#thread-title").addEventListener("click", () => threadAction("rename"));
    $("#thread-menu-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      $("#thread-menu").classList.toggle("hidden");
    });
    for (const b of $$("#thread-menu button")) b.addEventListener("click", () => threadAction(b.dataset.act));
    document.addEventListener("click", (e) => {
      if (!e.target.closest("#thread-menu")) $("#thread-menu").classList.add("hidden");
    });

    $("#model").addEventListener("change", (e) => setModel(e.target.value));
    $("#effort").addEventListener("change", (e) => saveSettings({ effort: e.target.value || null }));
    $("#jurisdiction").addEventListener("change", (e) => {
      const t = active();
      const v = e.target.value || null;
      if (t) {
        t.jurisdiction = v;
        saveThread(t);
        renderSidebar();
      }
      saveSettings({ jurisdiction: v });
    });

    for (const b of $$("[data-close]")) b.addEventListener("click", () => $("#" + b.dataset.close).classList.add("hidden"));
    for (const m of $$(".modal")) m.addEventListener("click", (e) => {
      if (e.target === m) m.classList.add("hidden");
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        for (const m of $$(".modal")) m.classList.add("hidden");
        $("#thread-menu").classList.add("hidden");
      }
    });

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
      if (state.streaming || state.saveTimers.size) {
        for (const t of state.loaded.values()) if (state.saveTimers.has(t.id)) saveThread(t, true);
        if (state.streaming) {
          e.preventDefault();
          e.returnValue = "";
        }
      }
    });
  }

  // ------------------------------------------------------------ start
  loadPrefs();
  wire();
  fetch("/api/me", { credentials: "same-origin" })
    .then((r) => r.json())
    .then((me) => (me.authed ? boot(me) : showLogin()))
    .catch(() => showLogin());
})();
