(() => {
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const API = String(window.CT_API || "").replace(/\/+$/, "");
  const PREFS_KEY = "claude-terminal.prefs";
  const TOKEN_KEY = "claude-terminal.token";

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

  // Two ways to work. Anything else is reachable with /model <name>.
  const MODES = [
    { id: "simple", model: "claude-opus-5-5", label: "Simple questions", desc: "Opus · quicker, cheaper", tier: 2 },
    { id: "complex", model: "claude-fable-5-1", label: "Complex questions", desc: "Fable · most capable", tier: 3 },
  ];
  const EFFORT_LABELS = { low: "Quick · fast", medium: "Balanced", high: "Thorough · slower", xhigh: "Deep · slow", max: "Maximum · very slow" };
  const EFFORT_RANK = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 };
  const modeFor = (model) => MODES.find((m) => m.model === model) || null;
  function speedHint(model, effort) {
    const info = modelInfo(model);
    const tier = modeFor(model) ? modeFor(model).tier : /fable|mythos/.test(model || "") ? 3 : /opus/.test(model || "") ? 2 : /haiku/.test(model || "") ? 0 : 1;
    const eff = effort || (info && info.defaultEffort) || "high";
    const score = tier + (EFFORT_RANK[eff] ?? 2);
    if (score <= 2) return { cls: "fast", text: "replies will be fast" };
    if (score <= 4) return { cls: "", text: "replies take a few seconds to a minute" };
    if (score <= 5) return { cls: "slow", text: "replies will be slow (thinks hard)" };
    return { cls: "very-slow", text: "replies will be very slow (maximum thinking)" };
  }

  // Patterns that get color-coded in answers and document previews.
  const NUMWORD = "\\d{1,4}|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|thirty|forty-five|sixty|ninety|one hundred twenty|one hundred eighty";
  const UNIT = "(?:business\\s|calendar\\s|court\\s)?(?:days?|months?|years?|weeks?|hours?)";
  const LEGAL = [
    { cls: "lg-case", title: "Case name", re: /\b(?:In\sre\s)?[A-Z][\w.'&-]*(?:\s(?:of|the|and|&|[A-Z][\w.'&-]*)){0,5}\sv\.\s[A-Z][\w.'&-]*(?:\s(?:of|the|and|&|[A-Z][\w.'&-]*)){0,5}/g },
    { cls: "lg-cite", title: "Reporter citation", re: /\b\d{1,4}\s(?:U\.S\.|S\.\s?Ct\.|L\.\s?Ed\.\s?2d|F\.\s?(?:2d|3d|4th)|F\.\s?Supp\.(?:\s?[23]d)?|F\.\s?App'x|B\.R\.|WL|[A-Z][A-Za-z.']{0,12}(?:\s[A-Z][A-Za-z.']{0,12}){0,2}\s?(?:2d|3d|4th|5th)?)\s\d{1,7}(?:,\s?\d{1,5})?(?:\s\([^()]{0,40}\d{4}\))?/g },
    { cls: "lg-stat", title: "Statute, regulation or rule", re: /\b\d{1,3}\s(?:U\.S\.C\.(?:A\.)?|C\.F\.R\.)\s§+\s?\d[\w.()-]*(?:\s?et\sseq\.)?|§+\s?\d[\w.()-]*(?:\s?et\sseq\.)?|\b(?:CPLR|UCC|U\.C\.C\.|FRCP|FRE|FRAP|Fed\.\s?R\.\s?(?:Civ|Crim|Evid|App|Bankr)\.\s?P\.|Rule)\s\d+[\w.()-]*/g },
    { cls: "lg-date", title: "Date", re: /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s\d{1,2},?\s\d{4}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g },
    { cls: "lg-deadline", title: "Deadline", re: new RegExp(`\\b(?:within|no\\slater\\sthan|not\\slater\\sthan|at\\sleast|not\\sless\\sthan|not\\smore\\sthan|on\\sor\\sbefore)\\s(?:${NUMWORD})(?:\\s?\\(\\d+\\))?\\s${UNIT}\\b`, "gi") },
    { cls: "lg-period", title: "Time period", re: new RegExp(`\\b(?:${NUMWORD})(?:\\s?\\(\\d+\\))?[\\s-]${UNIT}\\b`, "gi") },
    { cls: "lg-money", title: "Amount", re: /\$\s?\d[\d,]*(?:\.\d{1,2})?(?:\s?(?:million|billion|thousand))?\b/g },
    { cls: "lg-term", title: "Defined term", re: /[“"][A-Z][A-Za-z0-9&'’-]*(?:\s[A-Z][A-Za-z0-9&'’-]*){0,5}[”"]/g },
    { cls: "lg-party", title: "Party or role", re: /\b(?:Plaintiffs?|Defendants?|Petitioners?|Respondents?|Appellants?|Appellees?|Movants?|Landlords?|Tenants?|Lessors?|Lessees?|Licensors?|Licensees?|Buyers?|Sellers?|Purchasers?|Vendors?|Employers?|Employees?|Contractors?|Subcontractors?|Guarantors?|Borrowers?|Lenders?|Trustees?|Beneficiar(?:y|ies)|Grantors?|Grantees?|Indemnitors?|Indemnitees?|Insureds?|Insurers?|Debtors?|Creditors?|Executors?|Testators?|Settlors?)\b/g },
    { cls: "lg-oblig", title: "Obligation", re: /\b(?:shall\snot|shall|must\snot|must|may\snot|is\srequired\sto|are\srequired\sto|waives?|waived|indemnif(?:y|ies|ied|ication))\b/g },
  ];

  const state = {
    index: [], loaded: new Map(), activeId: null, settings: {}, prefs: { sidebar: true, activeId: null },
    models: [], limits: {}, legalPrompt: "", defaultModel: "claude-opus-5-5",
    streaming: null, attachments: [], histIdx: -1, live: { budget: null, today: null, rateLimit: null },
    saveTimers: new Map(), blobs: new Map(),
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
  const safeFile = (s) => String(s || "document").replace(/[\\/:*?"<>|]+/g, "_").trim().slice(0, 60) || "document";
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
  const getToken = () => {
    try {
      return localStorage.getItem(TOKEN_KEY) || "";
    } catch {
      return "";
    }
  };
  const setToken = (t) => {
    try {
      if (t) localStorage.setItem(TOKEN_KEY, t);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
  };

  // Base64 helpers (files travel as base64 strings).
  function bufToB64(buf) {
    const bytes = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  async function api(path, { method = "GET", body, signal } = {}) {
    const headers = { "X-Requested-With": "claude-terminal" };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(API + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal });
    if (res.status === 401) {
      setToken("");
      showLogin();
      throw new Error("Signed out");
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
    }, 1000);
  }
  const downloadText = (text, name, mime = "text/plain") => downloadBlob(new Blob([text], { type: mime + ";charset=utf-8" }), name);

  const EXT = { python: "py", javascript: "js", typescript: "ts", json: "json", html: "html", css: "css", bash: "sh", sql: "sql", yaml: "yml", markdown: "md", csv: "csv", text: "txt", plaintext: "txt" };
  const extFor = (lang) => EXT[(lang || "").toLowerCase()] || "txt";

  // ------------------------------------------------------------ files (stored as base64 in KV)
  async function fetchFile(f) {
    if (state.blobs.has(f.id)) return state.blobs.get(f.id);
    const data = await apiJson(`/api/files/${f.id}`);
    const bytes = b64ToBytes(data.b64);
    const entry = { bytes, text: data.text, blob: new Blob([bytes], { type: f.mime || "application/octet-stream" }), url: null };
    entry.url = URL.createObjectURL(entry.blob);
    state.blobs.set(f.id, entry);
    return entry;
  }
  async function downloadFile(f) {
    try {
      const { blob } = await fetchFile(f);
      downloadBlob(blob, f.name);
    } catch (e) {
      note(`Download failed: ${e.message}`);
    }
  }
  async function uploadFiles(files, { attach = true, source } = {}) {
    const added = [];
    for (const file of files) {
      try {
        const buf = await file.arrayBuffer();
        const body = { name: file.name || "pasted", type: file.type || "", source, b64: bufToB64(buf) };
        if (/\.docx$/i.test(file.name || "")) {
          if (!window.mammoth) throw new Error("the Word reader has not loaded yet; try again in a moment");
          body.text = (await mammoth.extractRawText({ arrayBuffer: buf })).value;
        }
        const entry = await apiJson("/api/upload", { method: "POST", body });
        added.push(entry);
        if (attach) state.attachments.push(entry);
        if (entry.evicted) note(`Storage is full: the ${entry.evicted} oldest file(s) were removed to make room (first in, first out).`);
      } catch (e) {
        note(`Upload failed for ${file.name || "file"}: ${e.message}`);
      }
    }
    renderAttachments();
    return added;
  }

  // ------------------------------------------------------------ threads
  const active = () => (state.activeId && state.loaded.get(state.activeId)) || null;
  const modelInfo = (id) => state.models.find((m) => m.id === id || (id && id.startsWith(m.id + "-"))) || null;
  const summaryOf = (t) => ({ id: t.id, title: t.title, createdAt: t.createdAt, updatedAt: t.updatedAt, cost: t.cost || 0, count: t.messages.filter((m) => m.role !== "note").length, jurisdiction: t.jurisdiction, model: t.model });

  function newThread() {
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
  const ensureThread = () => active() || newThread();
  function setActive(id) {
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
        const r = await apiJson(`/api/threads/${t.id}`, { method: "PUT", body });
        delete t.unsaved;
        if (r.evicted) {
          note(`Thread storage is full: the ${r.evicted} oldest thread(s) were removed to make room (first in, first out).`);
          refreshIndex().then(renderSidebar).catch(() => {});
        }
      } catch (e) {
        if (e.message !== "Signed out") note(`Could not save this thread: ${e.message}`);
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
    for (const t of state.loaded.values()) if (t.unsaved && !state.index.find((s) => s.id === t.id)) state.index.unshift(summaryOf(t));
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

  // ------------------------------------------------------------ legal highlighting
  function highlightLegal(container) {
    if (state.settings.highlight === false) return;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeValue.trim().length < 3 || n.parentElement.closest("code, pre, a, .lg, script, style, textarea") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
    for (const node of nodes) {
      const text = node.nodeValue;
      const found = [];
      for (const p of LEGAL) {
        p.re.lastIndex = 0;
        let m;
        while ((m = p.re.exec(text))) {
          if (!m[0]) {
            p.re.lastIndex += 1;
            continue;
          }
          found.push({ start: m.index, end: m.index + m[0].length, cls: p.cls, title: p.title });
        }
      }
      if (!found.length) continue;
      found.sort((a, b) => a.start - b.start || b.end - a.end);
      const frag = document.createDocumentFragment();
      let pos = 0;
      for (const f of found) {
        if (f.start < pos) continue;
        if (f.start > pos) frag.appendChild(document.createTextNode(text.slice(pos, f.start)));
        const span = el("span", `lg ${f.cls}`);
        span.title = f.title;
        span.textContent = text.slice(f.start, f.end);
        frag.appendChild(span);
        pos = f.end;
      }
      if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
      node.replaceWith(frag);
    }
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
    const opts = MODES.map((m) => {
      const info = modelInfo(m.model);
      const o = new Option(`${m.label} · ${m.desc}`, m.model);
      o.title = info && info.in != null ? `${info.display}: $${info.in} per million input tokens, $${info.out} per million output tokens` : m.model;
      return o;
    });
    if (model && !modeFor(model)) opts.push(new Option(`Custom · ${model}`, model));
    fillSelect($("#model"), opts, model);
    fillSelect($("#jurisdiction"), [new Option("none", ""), ...JURISDICTIONS.map((j) => new Option(j, j))], t ? t.jurisdiction || "" : state.settings.jurisdiction || "");
    $("#highlight").checked = state.settings.highlight !== false;
    document.body.classList.toggle("no-highlight", state.settings.highlight === false);
    renderEffortOptions();
    renderStats();
    renderUsageChip();
  }
  function renderEffortOptions() {
    const t = active();
    const info = modelInfo(t ? t.model : state.settings.model || state.defaultModel);
    const efforts = info ? info.efforts : [];
    const sel = $("#effort");
    const def = info && info.defaultEffort ? `Default (${EFFORT_LABELS[info.defaultEffort] || info.defaultEffort})` : "Default";
    const current = efforts.includes(state.settings.effort) ? state.settings.effort : "";
    fillSelect(sel, [new Option(def, ""), ...efforts.map((e) => new Option(EFFORT_LABELS[e] || e, e))], current);
    sel.disabled = efforts.length === 0;
    const hint = speedHint(t ? t.model : state.settings.model || state.defaultModel, current);
    const h = $("#speed-hint");
    h.textContent = hint.text;
    h.className = `speed ${hint.cls}`;
  }
  function renderStats() {
    const t = active();
    const s = $("#thread-stats");
    if (!s) return;
    if (!t || !t.messages.length) return (s.textContent = "");
    s.textContent = `${fmtNum(t.tokens.in)} in · ${fmtNum(t.tokens.out)} out · ${fmtCost(t.cost)} this thread`;
  }
  function renderUsageChip() {
    const chip = $("#usage-chip");
    const b = state.live.budget;
    const exact = b && b.source === "anthropic";
    const parts = [];
    if (state.live.today != null) parts.push(`today ${fmtCost(state.live.today)}`);
    if (b) {
      parts.push(`month ${fmtCost(b.spent)}`);
      if (b.monthly != null) {
        const pct = b.monthly > 0 ? b.spent / b.monthly : 1;
        parts.push(`<span class="${pct >= 1 ? "bad" : pct >= 0.8 ? "warn" : "ok"}">${fmtCost(Math.max(0, b.remaining))} left</span>`);
      }
      if (!exact) parts.push(`<span title="Estimated from token counts. Add an ANTHROPIC_ADMIN_KEY secret for Anthropic's exact figures.">est.</span>`);
    }
    chip.title = exact ? "Figures from Anthropic's cost report" : "Estimated from token counts; add an ANTHROPIC_ADMIN_KEY secret for exact figures";
    chip.innerHTML = parts.length ? parts.join(" · ") : "usage";
  }
  function renderTemplates() {
    const box = $("#templates");
    if (!box) return;
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
      img.alt = "";
      fetchFile(f).then((e) => (img.src = e.url)).catch(() => {});
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
      const dl = btn("↓", (e) => {
        e.stopPropagation();
        downloadFile(f);
      }, "dl");
      dl.title = `Download ${f.name}`;
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
    } else root.appendChild(el("div", "body", esc(m.text || "")));
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
    if (final) {
      decorateCode(body);
      highlightLegal(body);
    }
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
    const s = { ctrl, threadId: t.id, msg: am, usage: null, started: Date.now() };
    state.streaming = s;
    document.body.classList.add("streaming");
    const info = modelInfo(t.model);
    const body = {
      conv: t.id, model: t.model || state.settings.model || state.defaultModel, system: composeSystem(t),
      messages: toApiMessages(t.messages.filter((m) => m !== am)),
      effort: info && info.efforts.includes(state.settings.effort) ? state.settings.effort : null,
      maxTokens: state.settings.maxTokens || 16000, showThinking: state.settings.showThinking !== false, fallbacks: state.settings.fallbacks !== false,
    };
    try {
      const res = await api("/api/chat", { method: "POST", body, signal: ctrl.signal });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      try {
        const rl = JSON.parse(res.headers.get("X-Anthropic-RateLimit") || "null");
        if (rl && Object.keys(rl).length) state.live.rateLimit = { at: Date.now(), ...rl };
      } catch {
        /* ignore */
      }
      await readSSE(res, (ev) => handleEvent(ev, s, am));
    } catch (e) {
      if (e.name === "AbortError") am.meta.stopped = true;
      else if (e.message !== "Signed out") am.meta.error = e.message;
    } finally {
      delete am.pending;
      am.meta.ms = Date.now() - s.started;
      if (s.usage) am.meta.usage = s.usage;
      state.streaming = null;
      document.body.classList.remove("streaming");
      if (s.usage) {
        t.tokens.in += (s.usage.input_tokens || 0) + (s.usage.cache_read_input_tokens || 0) + (s.usage.cache_creation_input_tokens || 0);
        t.tokens.out += s.usage.output_tokens || 0;
        try {
          const r = await apiJson("/api/usage", { method: "POST", body: { model: am.meta.model || t.model, conv: t.id, usage: s.usage, ms: am.meta.ms, stop: am.meta.stop_reason } });
          am.meta.cost = r.cost;
          if (r.cost) t.cost = (t.cost || 0) + r.cost;
          state.live.budget = r.budget || state.live.budget;
          state.live.today = r.today;
        } catch {
          /* usage report is best-effort */
        }
      }
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

  // Reads the Messages API stream as the Worker passes it through, untouched.
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
        let data = "";
        for (const line of chunk.split("\n")) if (line.startsWith("data:")) data += line.slice(5).trim();
        if (!data) continue;
        try {
          onEvent(JSON.parse(data));
        } catch (e) {
          console.warn("bad event", chunk, e);
        }
      }
    }
  }
  function handleEvent(ev, s, am) {
    switch (ev.type) {
      case "message_start": {
        const msg = ev.message || {};
        if (msg.model) am.meta.model = msg.model;
        const u = msg.usage || {};
        s.usage = { input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0, cache_read_input_tokens: u.cache_read_input_tokens || 0, cache_creation_input_tokens: u.cache_creation_input_tokens || 0 };
        break;
      }
      case "content_block_start": {
        const cb = ev.content_block || {};
        if (cb.type === "fallback") am.meta.fallback = `${(cb.from && cb.from.model) || "?"} → ${(cb.to && cb.to.model) || "?"}`;
        break;
      }
      case "content_block_delta": {
        const d = ev.delta || {};
        if (d.type === "text_delta" && d.text) {
          am.text += d.text;
          scheduleStreamRender();
        } else if (d.type === "thinking_delta" && d.thinking && state.settings.showThinking !== false) {
          am.thinking += d.thinking;
          scheduleStreamRender();
        }
        break;
      }
      case "message_delta": {
        const d = ev.delta || {};
        if (d.stop_reason) am.meta.stop_reason = d.stop_reason;
        if (d.stop_reason === "refusal") {
          const sd = d.stop_details || {};
          am.meta.error = `Claude declined this request${sd.category ? ` (${sd.category})` : ""}${sd.explanation ? ": " + sd.explanation : "."}`;
        }
        if (ev.usage) {
          s.usage = s.usage || { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
          for (const k of Object.keys(s.usage)) if (ev.usage[k] != null) s.usage[k] = ev.usage[k];
        }
        break;
      }
      case "error":
        am.meta.error = (ev.error && ev.error.message) || "The stream reported an error.";
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

  // ------------------------------------------------------------ Word export (in the browser)
  function markdownToDocx(markdown, title) {
    const D = window.docx;
    if (!D || !window.marked) throw new Error("the Word writer has not loaded yet; try again in a moment");
    const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType, ShadingType, ExternalHyperlink, LevelFormat } = D;
    const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
    const numberings = [];
    const newNumbering = (start) => {
      const reference = `num-${numberings.length + 1}`;
      numberings.push({ reference, levels: [0, 1, 2, 3].map((level) => ({ level, format: LevelFormat.DECIMAL, text: `%${level + 1}.`, alignment: AlignmentType.START, start: level === 0 ? Math.max(1, Number(start) || 1) : 1, style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } } })) });
      return reference;
    };
    const indentOf = (depth) => (depth ? { left: 720 * depth } : undefined);
    function runs(tokens, style = {}) {
      const out = [];
      for (const t of tokens || []) {
        switch (t.type) {
          case "strong": out.push(...runs(t.tokens, { ...style, bold: true })); break;
          case "em": out.push(...runs(t.tokens, { ...style, italics: true })); break;
          case "del": out.push(...runs(t.tokens, { ...style, strike: true })); break;
          case "codespan": out.push(new TextRun({ text: t.text, font: "Consolas", ...style })); break;
          case "br": out.push(new TextRun({ text: "", break: 1 })); break;
          case "link": out.push(new ExternalHyperlink({ link: t.href, children: runs(t.tokens, { ...style, style: "Hyperlink" }) })); break;
          case "image": out.push(new TextRun({ text: `[image: ${t.text || t.href}]`, italics: true, ...style })); break;
          default:
            if (t.tokens && t.tokens.length) out.push(...runs(t.tokens, style));
            else if (typeof t.text === "string") out.push(new TextRun({ text: t.text, ...style }));
        }
      }
      return out;
    }
    function listItem(item, ref, level, depth) {
      const out = [];
      for (const sub of item.tokens || []) {
        if (sub.type === "list") {
          const subRef = sub.ordered ? newNumbering(sub.start) : null;
          for (const it of sub.items) out.push(...listItem(it, subRef, level + 1, depth));
          continue;
        }
        const r = runs(sub.tokens && sub.tokens.length ? sub.tokens : [{ type: "text", text: sub.text || sub.raw || "" }]);
        out.push(new Paragraph({ children: r, ...(ref ? { numbering: { reference: ref, level } } : { bullet: { level } }), spacing: { after: 60 } }));
      }
      return out;
    }
    function blocks(tokens, depth = 0) {
      const out = [];
      for (const t of tokens) {
        switch (t.type) {
          case "heading": out.push(new Paragraph({ heading: HEADINGS[Math.min(Math.max(t.depth, 1), 6) - 1], children: runs(t.tokens), indent: indentOf(depth) })); break;
          case "paragraph":
          case "text": out.push(new Paragraph({ children: runs(t.tokens && t.tokens.length ? t.tokens : [{ type: "text", text: t.text || "" }]), spacing: { after: 160 }, indent: indentOf(depth) })); break;
          case "list": {
            const ref = t.ordered ? newNumbering(t.start) : null;
            for (const item of t.items) out.push(...listItem(item, ref, 0, depth));
            out.push(new Paragraph({ text: "", spacing: { after: 60 } }));
            break;
          }
          case "blockquote": out.push(...blocks(t.tokens, depth + 1)); break;
          case "code":
            for (const line of String(t.text).split("\n")) out.push(new Paragraph({ children: [new TextRun({ text: line, font: "Consolas", size: 18 })], shading: { type: ShadingType.CLEAR, fill: "F2F2F2" }, spacing: { after: 0 }, indent: indentOf(depth) }));
            out.push(new Paragraph({ text: "", spacing: { after: 120 } }));
            break;
          case "hr": out.push(new Paragraph({ thematicBreak: true })); break;
          case "table": {
            const row = (cells, header) => new TableRow({ tableHeader: header, children: cells.map((c) => new TableCell({ children: [new Paragraph({ children: runs(c.tokens, header ? { bold: true } : {}) })], shading: header ? { type: ShadingType.CLEAR, fill: "E8EEF5" } : undefined })) });
            out.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [row(t.header, true), ...t.rows.map((r) => row(r, false))] }));
            out.push(new Paragraph({ text: "", spacing: { after: 120 } }));
            break;
          }
          case "html": out.push(new Paragraph({ text: String(t.text || ""), indent: indentOf(depth) })); break;
          default: break;
        }
      }
      return out;
    }
    const body = blocks(marked.lexer(markdown));
    if (!numberings.length) newNumbering(1);
    const doc = new Document({
      creator: "claude terminal", title: title || "Document", numbering: { config: numberings },
      styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
      sections: [{ children: [...(title ? [new Paragraph({ text: title, heading: HeadingLevel.TITLE })] : []), ...body] }],
    });
    return Packer.toBlob(doc);
  }
  async function downloadDocx(markdown, title) {
    try {
      downloadBlob(await markdownToDocx(markdown, title), `${safeFile(title)}.docx`);
    } catch (e) {
      note(`Word export failed: ${e.message}`);
    }
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
      case "docx": return downloadDocx(threadMarkdown(t), t.title);
      case "md": return downloadText(threadMarkdown(t), `${safeFile(t.title)}.md`, "text/markdown");
      case "json": return downloadText(JSON.stringify(t, null, 2), `${safeFile(t.title)}.json`, "application/json");
      case "print": return window.print();
      case "clear":
        if (!t.messages.length || confirm("Remove every message in this thread?")) {
          t.messages = [];
          t.cost = 0;
          t.tokens = { in: 0, out: 0 };
          saveThread(t, true);
          renderAll();
        }
        return;
      case "delete": return deleteThread(t.id);
      default: return;
    }
  }

  // ------------------------------------------------------------ slash commands
  const HELP = `Commands
  /new                  start a new thread
  /title <text>         rename this thread
  /jurisdiction <name>  set the jurisdiction for this thread (e.g. /jurisdiction Texas, or none)
  /system [text|clear]  instructions for this thread only
  /model simple|complex|<name>   switch mode or pick any model · /models lists them with prices
  /effort <level>       low (fast) · medium · high (slower) · xhigh (slow) · max (very slow) · default
  /thinking on|off      show the reasoning summary
  /highlight on|off     color-code legal references
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
      case "help": return note(HELP);
      case "new": return newThread();
      case "clear": return threadAction("clear");
      case "delete": return threadAction("delete");
      case "print": return threadAction("print");
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
        const mode = MODES.find((x) => x.id === q);
        const m = mode ? { id: mode.model } : state.models.find((x) => x.id === q) || state.models.find((x) => x.id.includes(q) || x.name.toLowerCase().includes(q));
        if (!m) return note(`No model matches "${arg}". Try simple, complex, or a name from /models.`);
        setModel(m.id);
        return note(`Model → ${m.id}`);
      }
      case "models": return note("Models (price per 1M tokens, in / out)\n" + state.models.map((m) => `  ${m.id.padEnd(20)} ${m.in != null ? `$${m.in} / $${m.out}` : "?"}`).join("\n"));
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
      case "highlight":
        await saveSettings({ highlight: arg ? /^(on|1|true|yes)$/i.test(arg) : state.settings.highlight === false });
        renderAll();
        return note(`Highlights → ${state.settings.highlight === false ? "off" : "on"}`);
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
      case "export": return threadAction(arg.toLowerCase() === "json" ? "json" : /^(docx|word)$/i.test(arg) ? "docx" : "md");
      case "files": return openFiles();
      case "usage": return openUsage();
      case "context": return countContext();
      case "budget": {
        if (!arg) return openUsage();
        const off = /^(off|none|clear|0)$/i.test(arg);
        const n = off ? null : Number(arg.replace(/[$,]/g, ""));
        if (!off && !(n >= 0)) return note("Usage: /budget 25   or   /budget off");
        await saveSettings({ monthlyBudget: n });
        await refreshUsage();
        return note(off ? "Monthly budget cleared." : `Monthly budget → $${n}`);
      }
      case "logout": return logout();
      default: return note(`Unknown command /${cmd}. Try /help.`);
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
      if (e.message !== "Signed out") note(`Could not save settings: ${e.message}`);
    }
  }
  function applyTheme() {
    const dark = state.settings.theme === "dark";
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    const l = $("#hljs-light");
    const d = $("#hljs-dark");
    if (l) l.disabled = dark;
    if (d) d.disabled = !dark;
    document.body.classList.toggle("no-highlight", state.settings.highlight === false);
  }
  function openSettings() {
    const s = state.settings;
    $("#set-system").value = s.systemPrompt || state.legalPrompt || "";
    const curModel = s.model || state.defaultModel;
    fillSelect($("#set-mode"), [...MODES.map((m) => new Option(`${m.label} · ${m.desc}`, m.model)), ...(modeFor(curModel) ? [] : [new Option(`Custom · ${curModel}`, curModel)])], curModel);
    fillSelect($("#set-jurisdiction"), [new Option("none", ""), ...JURISDICTIONS.map((j) => new Option(j, j))], s.jurisdiction || "");
    $("#set-budget").value = s.monthlyBudget == null ? "" : s.monthlyBudget;
    $("#set-max").value = s.maxTokens || 16000;
    $("#set-theme").value = s.theme === "dark" ? "dark" : "light";
    $("#set-highlight").checked = s.highlight !== false;
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
      model: $("#set-mode").value || null,
      jurisdiction: $("#set-jurisdiction").value || null,
      monthlyBudget: $("#set-budget").value === "" ? null : Number($("#set-budget").value),
      maxTokens: Number($("#set-max").value) || 16000,
      theme: $("#set-theme").value,
      highlight: $("#set-highlight").checked,
      showThinking: $("#set-thinking").checked,
      fallbacks: $("#set-fallback").checked,
    });
    $("#settings-panel").classList.add("hidden");
    refreshUsage().catch(() => {});
    renderAll();
    note("Settings saved.");
  }

  // ------------------------------------------------------------ usage panel
  async function refreshUsage() {
    const u = await apiJson("/api/usage");
    state.live.budget = u.budget;
    const exact = u.official && !u.official.error ? u.official : null;
    state.live.today = exact ? exact.today : u.totals.today.cost;
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
      const exact = u.official && !u.official.error ? u.official : null;
      const today = exact ? exact.today : u.totals.today.cost;
      const week = exact ? exact.week : u.totals.week.cost;
      const month = exact ? exact.month : u.totals.month.cost;
      const b = u.budget;
      const now = new Date();
      const resets = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });
      body.innerHTML = "";
      const cards = el("div", "cards");
      cards.appendChild(el("div", "card", `<div class="k">Today</div><div class="v">${fmtCost(today)}</div><div class="s">&nbsp;</div>`));
      cards.appendChild(el("div", "card", `<div class="k">This week</div><div class="v">${fmtCost(week)}</div><div class="s">last 7 days</div>`));
      cards.appendChild(el("div", "card", `<div class="k">This month</div><div class="v">${fmtCost(month)}</div><div class="s">resets ${resets}</div>`));
      if (b.monthly != null) {
        const pct = b.monthly > 0 ? Math.min(1, month / b.monthly) : 1;
        const cls = pct >= 1 ? "bad" : pct >= 0.8 ? "warn" : "ok";
        cards.appendChild(el("div", "card", `<div class="k">Remaining this month</div><div class="v"><span class="${cls}">${fmtCost(Math.max(0, b.monthly - month))}</span></div><div class="s">of ${fmtCost(b.monthly)} · ${Math.round(pct * 100)}% used</div>`));
      } else {
        cards.appendChild(el("div", "card", `<div class="k">Remaining this month</div><div class="v">—</div><div class="s">set a monthly limit in Settings</div>`));
      }
      body.appendChild(cards);
      let note;
      if (exact) note = `Figures from Anthropic, up to the minute (checked ${fmtAgo(exact.at)}).`;
      else if (u.official && u.official.error) note = `Anthropic's figures could not be read (${esc(u.official.error)}); these are this terminal's estimates.`;
      else note = "Estimates from this terminal's token counts. Add an ANTHROPIC_ADMIN_KEY secret for Anthropic's exact figures.";
      body.appendChild(el("div", "fine", note));
    } catch (e) {
      body.textContent = "Could not load usage: " + e.message;
    }
  }

  // ------------------------------------------------------------ files panel + preview
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
          img.alt = "";
          fetchFile(f).then((e) => (img.src = e.url)).catch(() => {});
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
        row.appendChild(btn("Download", () => downloadFile(f), "small"));
        row.appendChild(btn("Delete", async () => {
          if (!confirm(`Delete ${f.name}?`)) return;
          await apiJson(`/api/files/${f.id}`, { method: "DELETE" });
          state.blobs.delete(f.id);
          openFiles();
        }, "small danger"));
        body.appendChild(row);
      }
    } catch (e) {
      body.textContent = "Could not load files: " + e.message;
    }
  }
  async function openPreview(f) {
    const panel = $("#preview-panel");
    panel.classList.remove("hidden");
    $("#preview-title").textContent = f.name;
    $("#preview-dl").onclick = () => downloadFile(f);
    const body = $("#preview-body");
    body.innerHTML = "";
    body.appendChild(el("div", "preview-loading", "Loading…"));
    try {
      const file = await fetchFile(f);
      body.innerHTML = "";
      if (f.kind === "image") {
        const img = el("img", "preview-img");
        img.src = file.url;
        img.alt = f.name;
        body.appendChild(img);
      } else if (f.kind === "pdf") {
        const frame = el("iframe", "preview-frame");
        frame.src = file.url;
        frame.title = f.name;
        body.appendChild(frame);
      } else if (f.kind === "docx") {
        if (!window.mammoth) throw new Error("the Word reader has not loaded yet");
        const html = (await mammoth.convertToHtml({ arrayBuffer: file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.byteLength) })).value;
        const doc = el("div", "doc-preview");
        doc.innerHTML = window.DOMPurify ? DOMPurify.sanitize(html) : esc(html);
        highlightLegal(doc);
        body.appendChild(doc);
      } else {
        const pre = el("pre", "text-preview", esc(file.text != null ? file.text : new TextDecoder().decode(file.bytes)));
        highlightLegal(pre);
        body.appendChild(pre);
      }
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
    setToken("");
    showLogin();
  }
  async function boot(me) {
    $("#login").classList.add("hidden");
    $("#app").classList.remove("hidden");
    try {
      if (!me) me = await (await api("/api/me")).json();
      state.legalPrompt = me.legalPrompt || "";
      state.limits = me.limits || {};
      state.defaultModel = me.defaultModel || state.defaultModel;
      if (me.hasApiKey === false) note("The Worker has no ANTHROPIC_API_KEY secret yet, so replies will fail until it is added.");
      const [models, settings] = await Promise.all([apiJson("/api/models").catch(() => []), apiJson("/api/settings").catch(() => ({}))]);
      state.models = Array.isArray(models) ? models : [];
      state.settings = settings;
      applyTheme();
      await refreshIndex();
    } catch (e) {
      if (e.message === "Signed out") return;
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
        const res = await fetch(API + "/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Requested-With": "claude-terminal" },
          body: JSON.stringify({ key: $("#password").value }),
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
        setToken(data.token);
        $("#password").value = "";
        boot();
      } catch (e2) {
        err.textContent = `Could not reach the server (${e2.message}).`;
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
    $("#effort").addEventListener("change", async (e) => {
      await saveSettings({ effort: e.target.value || null });
      renderEffortOptions();
    });
    $("#highlight").addEventListener("change", async (e) => {
      await saveSettings({ highlight: e.target.checked });
      renderTranscript();
    });
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
      for (const t of state.loaded.values()) if (state.saveTimers.has(t.id)) saveThread(t, true);
      if (state.streaming) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
  }

  // ------------------------------------------------------------ start
  loadPrefs();
  wire();
  (async () => {
    try {
      if (!getToken()) return showLogin();
      const res = await fetch(API + "/api/me", { headers: { Authorization: `Bearer ${getToken()}`, "X-Requested-With": "claude-terminal" } });
      const me = await res.json();
      if (me.authed) boot(me);
      else {
        setToken("");
        showLogin();
      }
    } catch {
      showLogin();
    }
  })();
})();
