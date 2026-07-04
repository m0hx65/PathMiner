const state = {
  activeTab: null,
  workspaceKey: null,
  origin: null,
  entries: [],
  patterns: [],
  findings: [],
  settings: {},
  crawl: null,
  renderLimit: 200,
  view: "endpoints",
  filters: {
    search: "",
    method: "all",
    status: "all",
    tag: "all",
    highOnly: false,
  },
};

const HIGH_VALUE_SCORE = 40;
const ui = {};

document.addEventListener("DOMContentLoaded", () => {
  cacheElements();
  bindEvents();
  loadActiveTab();
  if (ui.searchInput) ui.searchInput.focus();
});

function cacheElements() {
  const ids = [
    "runCode", "refreshBtn",
    "crawlSeed", "crawlStart", "crawlStop", "crawlProgress",
    "viewEndpoints", "viewPatterns",
    "searchInput", "methodFilter", "statusFilter", "highOnly", "tagChips",
    "entriesSection", "entries", "loadMore",
    "patternsSection", "patterns",
    "findingsSection", "findings", "findingsCount", "findingsCopy",
    "paramsPanel", "paramsList", "paramsCount", "paramsCopy",
    "exportCopy", "exportJson", "exportCsv", "exportTxt", "exportWords", "exportCurl",
    "graphqlTools", "graphqlTarget", "graphqlGuess", "graphqlIntrospect",
    "graphqlAllowToggle", "graphqlStatus",
    "settingsPanel", "setPassive", "setActive", "setStoreRaw", "setAggressive",
    "setQueryKeys", "setDepth", "setMaxPages", "clearData",
    "hostName", "statEndpoints", "statPatterns", "statHigh", "statSensitive",
    "status",
  ];
  for (const id of ids) ui[id] = document.getElementById(id);
}

function bindEvents() {
  on(ui.runCode, "click", handleRunScan);
  on(ui.refreshBtn, "click", refreshState);

  on(ui.crawlStart, "click", handleCrawlStart);
  on(ui.crawlStop, "click", handleCrawlStop);

  on(ui.viewEndpoints, "click", () => setView("endpoints"));
  on(ui.viewPatterns, "click", () => setView("patterns"));

  on(ui.searchInput, "input", debounce(() => {
    state.filters.search = ui.searchInput.value.trim().toLowerCase();
    renderCurrentView();
  }, 140));
  on(ui.searchInput, "keydown", (event) => {
    if (event.key === "Escape") {
      ui.searchInput.value = "";
      state.filters.search = "";
      renderCurrentView();
    }
  });
  on(ui.methodFilter, "change", () => {
    state.filters.method = ui.methodFilter.value;
    renderCurrentView();
  });
  on(ui.statusFilter, "change", () => {
    state.filters.status = ui.statusFilter.value;
    renderCurrentView();
  });
  on(ui.highOnly, "change", () => {
    state.filters.highOnly = ui.highOnly.checked;
    renderCurrentView();
  });

  on(ui.loadMore, "click", () => {
    state.renderLimit += 200;
    renderEntries();
  });

  on(ui.exportCopy, "click", () => exportData("copy"));
  on(ui.exportJson, "click", () => exportData("json"));
  on(ui.exportCsv, "click", () => exportData("csv"));
  on(ui.exportTxt, "click", () => exportData("txt"));
  on(ui.exportWords, "click", () => exportData("wordlist"));
  on(ui.exportCurl, "click", () => exportData("curl"));
  on(ui.findingsCopy, "click", handleFindingsCopy);
  on(ui.paramsCopy, "click", handleParamsCopy);

  on(ui.graphqlGuess, "click", handleGraphqlGuess);
  on(ui.graphqlIntrospect, "click", handleGraphqlIntrospect);
  on(ui.graphqlAllowToggle, "change", () =>
    updateSettings({ allowGraphqlChecks: ui.graphqlAllowToggle.checked })
  );

  on(ui.setPassive, "change", () => updateSettings({ passiveEnabled: ui.setPassive.checked }));
  on(ui.setActive, "change", () => updateSettings({ activeEnabled: ui.setActive.checked }));
  on(ui.setStoreRaw, "change", () => updateSettings({ storeRawUrls: ui.setStoreRaw.checked }));
  on(ui.setAggressive, "change", () => updateSettings({ patternAggressive: ui.setAggressive.checked }));
  on(ui.setQueryKeys, "change", () => updateSettings({ patternIncludeQueryKeys: ui.setQueryKeys.checked }));
  on(ui.setDepth, "change", () => updateSettings({ activeDepth: clampInt(ui.setDepth.value, 0, 6, 2) }));
  on(ui.setMaxPages, "change", () => updateSettings({ activeMaxPages: clampInt(ui.setMaxPages.value, 1, 500, 30) }));
  on(ui.clearData, "click", handleClearData);

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || !message.type) return;
    if (
      (message.type === "pm_workspace_updated" || message.type === "pm_crawl_update") &&
      message.workspaceKey === state.workspaceKey
    ) {
      refreshState();
    }
  });
}

function on(element, event, handler) {
  if (element) element.addEventListener(event, handler);
}

function debounce(fn, wait) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

async function loadActiveTab() {
  const tab = await getActiveTab();
  if (!tab) {
    setStatus("No active tab detected.");
    return;
  }
  state.activeTab = tab;
  state.workspaceKey = getWorkspaceKey(tab.url || "");
  state.origin = getOrigin(tab.url || "");
  if (ui.hostName) ui.hostName.textContent = state.workspaceKey || "—";
  if (ui.crawlSeed && !ui.crawlSeed.value) ui.crawlSeed.value = state.origin || "";
  await refreshState();
}

function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs && tabs.length ? tabs[0] : null);
    });
  });
}

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      void chrome.runtime.lastError;
      resolve(response);
    });
  });
}

function setStatus(text) {
  if (ui.status) ui.status.textContent = text;
}

function getWorkspaceKey(url) {
  try {
    return new URL(url).hostname;
  } catch (error) {
    return "";
  }
}

function getOrigin(url) {
  try {
    return new URL(url).origin;
  } catch (error) {
    return "";
  }
}

async function refreshState() {
  if (!state.workspaceKey) return;
  const response = await sendMessage({
    type: "pm_get_state",
    workspaceKey: state.workspaceKey,
    origin: state.origin,
  });
  if (!response || !response.ok) {
    setStatus("Unable to load workspace.");
    return;
  }
  state.settings = response.settings || {};
  state.entries = (response.workspace && response.workspace.entries) || [];
  state.patterns = (response.workspace && response.workspace.patterns) || [];
  state.findings = (response.workspace && response.workspace.findings) || [];
  state.crawl = response.crawl || null;
  applySettingsToUI();
  updateCrawlUI();
  updateStats();
  updateGraphqlTargets();
  renderTagChips();
  renderFindings();
  renderParams();
  renderCurrentView();
}

async function updateSettings(partial) {
  if (!partial) return;
  const response = await sendMessage({ type: "pm_update_settings", settings: partial });
  if (response && response.settings) {
    state.settings = response.settings;
    applySettingsToUI();
    refreshState();
  }
}

function applySettingsToUI() {
  const s = state.settings || {};
  setChecked(ui.graphqlAllowToggle, s.allowGraphqlChecks === true);
  setChecked(ui.setPassive, s.passiveEnabled !== false);
  setChecked(ui.setActive, s.activeEnabled === true);
  setChecked(ui.setStoreRaw, s.storeRawUrls === true);
  setChecked(ui.setAggressive, s.patternAggressive === true);
  setChecked(ui.setQueryKeys, s.patternIncludeQueryKeys === true);
  if (ui.setDepth && document.activeElement !== ui.setDepth) {
    ui.setDepth.value = s.activeDepth ?? 2;
  }
  if (ui.setMaxPages && document.activeElement !== ui.setMaxPages) {
    ui.setMaxPages.value = s.activeMaxPages ?? 30;
  }
  if (ui.graphqlIntrospect) ui.graphqlIntrospect.disabled = s.allowGraphqlChecks !== true;
}

function setChecked(element, value) {
  if (element) element.checked = value;
}

function updateStats() {
  const deduped = dedupeEntries(state.entries);
  const high = deduped.filter((e) => (e.score || 0) >= HIGH_VALUE_SCORE).length;
  const sensitive = deduped.filter((e) => (e.tags || []).includes("sensitive")).length;
  if (ui.statEndpoints) ui.statEndpoints.textContent = String(deduped.length);
  if (ui.statPatterns) ui.statPatterns.textContent = String(state.patterns.length);
  if (ui.statHigh) ui.statHigh.textContent = String(high);
  if (ui.statSensitive) ui.statSensitive.textContent = String(sensitive);
}

function updateCrawlUI() {
  const crawl = state.crawl;
  const running = Boolean(crawl && crawl.running);
  if (ui.crawlStart) ui.crawlStart.disabled = running;
  if (ui.crawlStop) ui.crawlStop.disabled = !running;
  if (ui.crawlProgress) {
    if (!crawl) {
      ui.crawlProgress.textContent = "";
    } else {
      ui.crawlProgress.textContent = running
        ? `Crawling… ${crawl.pagesCrawled}/${crawl.maxPages} pages · queue ${crawl.queueSize} · seen ${crawl.visitedCount}`
        : `Crawl done: ${crawl.pagesCrawled} pages, ${crawl.visitedCount} URLs seen.`;
    }
  }
}

/* ---------- View switching & filtering ---------- */

function setView(view) {
  state.view = view;
  if (ui.viewEndpoints) ui.viewEndpoints.classList.toggle("active", view === "endpoints");
  if (ui.viewPatterns) ui.viewPatterns.classList.toggle("active", view === "patterns");
  renderCurrentView();
}

function renderCurrentView() {
  if (state.view === "patterns") {
    if (ui.entriesSection) ui.entriesSection.classList.add("hidden");
    renderPatterns();
  } else {
    if (ui.patternsSection) ui.patternsSection.classList.add("hidden");
    renderEntries();
  }
}

function passesFilters(entry) {
  const f = state.filters;
  if (f.highOnly && (entry.score || 0) < HIGH_VALUE_SCORE) return false;

  if (f.method !== "all") {
    const methods = entry._methodsSeen && entry._methodsSeen.length
      ? entry._methodsSeen
      : [entry.method || "GET"];
    if (!methods.map((m) => String(m).toUpperCase()).includes(f.method)) return false;
  }

  if (f.status !== "all") {
    const cls = typeof entry.status === "number" ? getStatusClass(entry.status) : "none";
    if (f.status === "none" && typeof entry.status === "number") return false;
    if (f.status !== "none" && `status-${f.status}` !== cls) return false;
  }

  if (f.tag !== "all") {
    if (!(entry.tags || []).includes(f.tag)) return false;
  }

  if (f.search) {
    const hay = `${entry.url || ""} ${(entry.tags || []).join(" ")} ${(entry._methodsSeen || []).join(" ")}`.toLowerCase();
    if (!hay.includes(f.search)) return false;
  }
  return true;
}

function getVisibleEntries() {
  return dedupeEntries(state.entries)
    .filter(passesFilters)
    .sort((a, b) => {
      const scoreDiff = (b.score || 0) - (a.score || 0);
      if (scoreDiff !== 0) return scoreDiff;
      return (b.lastSeen || 0) - (a.lastSeen || 0);
    });
}

function renderTagChips() {
  if (!ui.tagChips) return;
  const counts = new Map();
  for (const entry of dedupeEntries(state.entries)) {
    for (const tag of entry.tags || []) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  const sorted = Array.from(counts.entries()).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });

  ui.tagChips.innerHTML = "";
  const allChip = makeChip(`all (${dedupeEntries(state.entries).length})`, state.filters.tag === "all");
  allChip.addEventListener("click", () => {
    state.filters.tag = "all";
    renderTagChips();
    renderCurrentView();
  });
  ui.tagChips.appendChild(allChip);

  for (const [tag, count] of sorted) {
    const chip = makeChip(`${tag} (${count})`, state.filters.tag === tag);
    if (tag === "sensitive") chip.style.color = "var(--danger)";
    chip.addEventListener("click", () => {
      state.filters.tag = state.filters.tag === tag ? "all" : tag;
      renderTagChips();
      renderCurrentView();
    });
    ui.tagChips.appendChild(chip);
  }
}

function makeChip(label, active) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "chip" + (active ? " active" : "");
  chip.textContent = label;
  return chip;
}

/* ---------- Endpoint list ---------- */

function renderEntries() {
  if (!ui.entries) return;
  const entries = getVisibleEntries();
  if (ui.entriesSection) {
    ui.entriesSection.classList.toggle("hidden", entries.length === 0);
  }
  const visible = entries.slice(0, state.renderLimit);

  ui.entries.innerHTML = "";
  const fragment = document.createDocumentFragment();
  for (const entry of visible) fragment.appendChild(createEntryRow(entry));
  ui.entries.appendChild(fragment);

  if (ui.loadMore) {
    ui.loadMore.classList.toggle("hidden", entries.length <= visible.length);
  }
}

function dedupeEntries(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = entry.normalizedUrl || entry.url;
    if (!key) continue;
    const method = (entry.method || "GET").toUpperCase();
    const count = entry.count || 1;

    if (!groups.has(key)) {
      groups.set(key, {
        rep: entry,
        methods: new Set([method]),
        sources: new Set(entry.source ? [entry.source] : []),
        tags: new Set(Array.isArray(entry.tags) ? entry.tags : []),
        countTotal: count,
        scoreMax: entry.score || 0,
        openapi: entry.openapiCandidate === true,
        graphql: entry.graphqlCandidate === true,
      });
      continue;
    }

    const group = groups.get(key);
    group.methods.add(method);
    if (entry.source) group.sources.add(entry.source);
    group.countTotal += count;
    if (Array.isArray(entry.tags)) entry.tags.forEach((tag) => group.tags.add(tag));
    group.scoreMax = Math.max(group.scoreMax || 0, entry.score || 0);
    group.openapi = group.openapi || entry.openapiCandidate === true;
    group.graphql = group.graphql || entry.graphqlCandidate === true;
    if (isBetterEntry(entry, group.rep)) group.rep = entry;
  }

  const result = [];
  for (const group of groups.values()) {
    const rep = { ...group.rep };
    rep._methodsSeen = Array.from(group.methods);
    rep._sourcesSeen = Array.from(group.sources);
    rep._countTotal = group.countTotal;
    rep.score = group.scoreMax;
    rep.tags = Array.from(group.tags);
    rep.openapiCandidate = rep.openapiCandidate || group.openapi;
    rep.graphqlCandidate = rep.graphqlCandidate || group.graphql;
    result.push(rep);
  }
  return result;
}

function isBetterEntry(candidate, current) {
  if (!current) return true;
  const candLast = candidate.lastSeen || 0;
  const currLast = current.lastSeen || 0;
  if (candLast !== currLast) return candLast > currLast;
  const candScore = candidate.score || 0;
  const currScore = current.score || 0;
  if (candScore !== currScore) return candScore > currScore;
  const candStatus = candidate.status != null;
  const currStatus = current.status != null;
  if (candStatus !== currStatus) return candStatus;
  return false;
}

function createEntryRow(entry) {
  const row = document.createElement("div");
  row.className = "entry";

  const main = document.createElement("div");
  main.className = "entry-main";

  const method = document.createElement("span");
  method.className = "badge method";
  const methodsSeen = entry._methodsSeen && entry._methodsSeen.length
    ? entry._methodsSeen
    : [entry.method || "GET"];
  method.textContent = formatMethods(methodsSeen);

  const status = document.createElement("span");
  status.className = "badge";
  if (typeof entry.status === "number") {
    status.textContent = String(entry.status);
    const statusClass = getStatusClass(entry.status);
    if (statusClass) status.classList.add(statusClass);
  } else {
    status.textContent = "--";
  }

  const url = document.createElement("span");
  url.className = "entry-url";
  url.textContent = entry.url || "";
  url.title = "Click to open · " + (entry.url || "");
  url.addEventListener("click", () => {
    if (entry.url && entry.url.startsWith("http")) chrome.tabs.create({ url: entry.url });
  });

  main.appendChild(method);
  main.appendChild(status);
  main.appendChild(url);

  const meta = document.createElement("div");
  meta.className = "entry-meta";

  const score = document.createElement("span");
  score.className = "pill score";
  score.textContent = String(entry.score ?? 0);
  meta.appendChild(score);

  if (entry._countTotal > 1) {
    const count = document.createElement("span");
    count.className = "pill count";
    count.textContent = "×" + entry._countTotal;
    meta.appendChild(count);
  }

  const tags = Array.isArray(entry.tags) ? entry.tags : [];
  const shownTags = tags.slice(0, 4);
  for (const tag of shownTags) {
    const pill = document.createElement("span");
    pill.className = "pill" + (tag === "sensitive" ? " sensitive" : "");
    pill.textContent = tag;
    meta.appendChild(pill);
  }
  if (tags.length > shownTags.length) {
    const more = document.createElement("span");
    more.className = "pill";
    more.textContent = `+${tags.length - shownTags.length}`;
    meta.appendChild(more);
  }

  const copyBtn = document.createElement("button");
  copyBtn.className = "chip mini";
  copyBtn.type = "button";
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    copyText(entry.url || "");
    copyBtn.textContent = "Copied";
    setTimeout(() => (copyBtn.textContent = "Copy"), 1000);
  });
  meta.appendChild(copyBtn);

  const curlBtn = document.createElement("button");
  curlBtn.className = "chip mini";
  curlBtn.type = "button";
  curlBtn.textContent = "cURL";
  curlBtn.title = "Copy as cURL";
  curlBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    copyText(toCurl(entry));
    curlBtn.textContent = "Copied";
    setTimeout(() => (curlBtn.textContent = "cURL"), 1000);
  });
  meta.appendChild(curlBtn);

  if (entry.openapiCandidate || tags.includes("docs")) {
    const parseButton = document.createElement("button");
    parseButton.type = "button";
    parseButton.className = "chip mini";
    parseButton.textContent = "Parse OpenAPI";
    parseButton.addEventListener("click", (event) => {
      event.stopPropagation();
      handleOpenApiParse(entry.url);
    });
    meta.appendChild(parseButton);
  }

  row.appendChild(main);
  row.appendChild(meta);
  return row;
}

/* ---------- Pattern list ---------- */

function renderPatterns() {
  if (!ui.patterns) return;
  const f = state.filters;
  const patterns = state.patterns
    .filter((p) => {
      if (f.highOnly && (p.score || 0) < HIGH_VALUE_SCORE) return false;
      if (f.tag !== "all" && !(p.tags || []).includes(f.tag)) return false;
      if (f.method !== "all") {
        const methods = Object.keys(p.topMethods || {}).map((m) => m.toUpperCase());
        if (!methods.includes(f.method)) return false;
      }
      if (f.search) {
        const hay = `${p.pattern || ""} ${(p.tags || []).join(" ")}`.toLowerCase();
        if (!hay.includes(f.search)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const scoreDiff = (b.score || 0) - (a.score || 0);
      if (scoreDiff !== 0) return scoreDiff;
      return (b.countTotal || 0) - (a.countTotal || 0);
    });

  if (ui.patternsSection) ui.patternsSection.classList.toggle("hidden", patterns.length === 0);

  ui.patterns.innerHTML = "";
  const fragment = document.createDocumentFragment();
  for (const pattern of patterns.slice(0, 500)) {
    fragment.appendChild(createPatternRow(pattern));
  }
  ui.patterns.appendChild(fragment);
}

function createPatternRow(pattern) {
  const row = document.createElement("div");
  row.className = "entry";

  const main = document.createElement("div");
  main.className = "entry-main";

  const methods = Object.keys(pattern.topMethods || { GET: 1 });
  const method = document.createElement("span");
  method.className = "badge method";
  method.textContent = formatMethods(methods);

  const url = document.createElement("span");
  url.className = "entry-url";
  url.textContent = pattern.pattern || "";
  url.title = pattern.pattern || "";

  main.appendChild(method);
  main.appendChild(url);

  const meta = document.createElement("div");
  meta.className = "entry-meta";

  const score = document.createElement("span");
  score.className = "pill score";
  score.textContent = String(pattern.score ?? 0);
  meta.appendChild(score);

  const unique = document.createElement("span");
  unique.className = "pill count";
  unique.textContent = `${pattern.uniqueUrls || 1} urls`;
  meta.appendChild(unique);

  const total = document.createElement("span");
  total.className = "pill";
  total.textContent = `×${pattern.countTotal || 1}`;
  meta.appendChild(total);

  for (const tag of (pattern.tags || []).slice(0, 3)) {
    const pill = document.createElement("span");
    pill.className = "pill" + (tag === "sensitive" ? " sensitive" : "");
    pill.textContent = tag;
    meta.appendChild(pill);
  }

  row.appendChild(main);
  row.appendChild(meta);

  const examples = Array.isArray(pattern.exampleUrls) ? pattern.exampleUrls.slice(0, 3) : [];
  for (const example of examples) {
    const ex = document.createElement("div");
    ex.className = "example";
    ex.textContent = example;
    ex.addEventListener("click", () => {
      if (example.startsWith("http")) chrome.tabs.create({ url: example });
    });
    row.appendChild(ex);
  }
  return row;
}

/* ---------- Findings (secrets) ---------- */

function renderFindings() {
  if (!ui.findings) return;
  const findings = (state.findings || []).slice().sort((a, b) => {
    const rank = { high: 0, medium: 1, low: 2 };
    const sev = (rank[a.severity] ?? 1) - (rank[b.severity] ?? 1);
    if (sev !== 0) return sev;
    return (b.lastSeen || 0) - (a.lastSeen || 0);
  });
  if (ui.findingsSection) ui.findingsSection.classList.toggle("hidden", findings.length === 0);
  if (ui.findingsCount) ui.findingsCount.textContent = String(findings.length);

  ui.findings.innerHTML = "";
  const fragment = document.createDocumentFragment();
  for (const finding of findings) fragment.appendChild(createFindingRow(finding));
  ui.findings.appendChild(fragment);
}

function createFindingRow(finding) {
  const row = document.createElement("div");
  row.className = "entry";

  const main = document.createElement("div");
  main.className = "entry-main";

  const sev = document.createElement("span");
  sev.className = "badge";
  sev.style.color =
    finding.severity === "high" ? "var(--danger)" : finding.severity === "low" ? "var(--muted)" : "var(--accent-2)";
  sev.textContent = (finding.severity || "medium").toUpperCase();

  const type = document.createElement("span");
  type.className = "entry-url";
  type.textContent = finding.type + (finding.preview ? "  " + finding.preview : "");
  type.title = finding.type;

  main.appendChild(sev);
  main.appendChild(type);

  const meta = document.createElement("div");
  meta.className = "entry-meta";
  if (finding.count > 1) {
    const count = document.createElement("span");
    count.className = "pill count";
    count.textContent = "×" + finding.count;
    meta.appendChild(count);
  }
  if (finding.source) {
    const src = document.createElement("span");
    src.className = "example";
    src.textContent = finding.source;
    src.title = "Open source: " + finding.source;
    src.addEventListener("click", () => {
      if (finding.source.startsWith("http")) chrome.tabs.create({ url: finding.source });
    });
    row.appendChild(main);
    row.appendChild(meta);
    row.appendChild(src);
    return row;
  }

  row.appendChild(main);
  row.appendChild(meta);
  return row;
}

function handleFindingsCopy() {
  const text = (state.findings || [])
    .map((f) => `[${f.severity}] ${f.type} ${f.preview} :: ${f.source}`)
    .join("\n");
  copyText(text);
  setStatus(`Copied ${state.findings.length} findings.`);
}

/* ---------- Parameter mining ---------- */

function collectParams() {
  const counts = new Map();
  for (const entry of dedupeEntries(state.entries)) {
    try {
      const params = new URL(entry.url).searchParams;
      for (const key of params.keys()) {
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    } catch (error) {
      // ignore
    }
  }
  return Array.from(counts.entries()).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });
}

function renderParams() {
  if (!ui.paramsList) return;
  const params = collectParams();
  if (ui.paramsPanel) ui.paramsPanel.classList.toggle("hidden", params.length === 0);
  if (ui.paramsCount) ui.paramsCount.textContent = String(params.length);

  ui.paramsList.innerHTML = "";
  for (const [key, count] of params) {
    const chip = document.createElement("span");
    chip.className = "pill";
    chip.textContent = `${key} (${count})`;
    chip.style.cursor = "pointer";
    chip.title = "Filter by this parameter";
    chip.addEventListener("click", () => {
      if (ui.searchInput) ui.searchInput.value = key;
      state.filters.search = key.toLowerCase();
      renderCurrentView();
    });
    ui.paramsList.appendChild(chip);
  }
}

function handleParamsCopy() {
  const params = collectParams().map(([key]) => key);
  copyText(params.join("\n"));
  setStatus(`Copied ${params.length} parameter names.`);
}

/* ---------- Export ---------- */

function toCurl(entry) {
  const methods = entry._methodsSeen && entry._methodsSeen.length ? entry._methodsSeen : [entry.method || "GET"];
  const method = methods[0] || "GET";
  const url = (entry.url || "").replace(/'/g, "'\\''");
  const parts = ["curl"];
  if (method && method !== "GET") parts.push("-X", method);
  parts.push(`'${url}'`);
  return parts.join(" ");
}

function exportData(format) {
  const entries = getVisibleEntries();
  if (!entries.length) {
    setStatus("Nothing to export in the current view.");
    return;
  }
  const host = state.workspaceKey || "pathminer";

  if (format === "txt" || format === "copy") {
    const text = entries.map((e) => e.url).filter(Boolean).join("\n");
    if (format === "copy") {
      copyText(text);
      setStatus(`Copied ${entries.length} URLs.`);
    } else {
      downloadFile(`${host}-endpoints.txt`, text, "text/plain");
      setStatus(`Exported ${entries.length} URLs.`);
    }
    return;
  }

  if (format === "wordlist") {
    const words = new Set();
    for (const e of entries) {
      try {
        const path = new URL(e.url).pathname;
        for (const seg of path.split("/")) {
          if (seg) words.add(seg);
        }
        if (path && path !== "/") words.add(path.replace(/^\//, ""));
      } catch (error) {
        // ignore unparsable URLs
      }
    }
    const list = Array.from(words).sort();
    downloadFile(`${host}-wordlist.txt`, list.join("\n"), "text/plain");
    setStatus(`Exported ${list.length} unique path words.`);
    return;
  }

  if (format === "curl") {
    const text = entries.map((e) => toCurl(e)).join("\n");
    downloadFile(`${host}-requests.sh`, "#!/bin/sh\n" + text + "\n", "text/plain");
    setStatus(`Exported ${entries.length} cURL commands.`);
    return;
  }

  if (format === "json") {
    const payload = entries.map((e) => ({
      url: e.url,
      methods: e._methodsSeen || [e.method],
      status: e.status ?? null,
      score: e.score ?? 0,
      tags: e.tags || [],
      sources: e._sourcesSeen || [e.source],
      count: e._countTotal || e.count || 1,
      contentType: e.contentType ?? null,
      size: e.size ?? null,
      firstSeen: e.firstSeen ?? null,
      lastSeen: e.lastSeen ?? null,
    }));
    downloadFile(`${host}-endpoints.json`, JSON.stringify(payload, null, 2), "application/json");
    setStatus(`Exported ${entries.length} endpoints as JSON.`);
    return;
  }

  if (format === "csv") {
    const headers = ["url", "methods", "status", "score", "tags", "sources", "count", "contentType", "size"];
    const rows = [headers.join(",")];
    for (const e of entries) {
      rows.push([
        csvCell(e.url),
        csvCell((e._methodsSeen || [e.method]).join("|")),
        csvCell(e.status ?? ""),
        csvCell(e.score ?? 0),
        csvCell((e.tags || []).join("|")),
        csvCell((e._sourcesSeen || [e.source]).join("|")),
        csvCell(e._countTotal || e.count || 1),
        csvCell(e.contentType ?? ""),
        csvCell(e.size ?? ""),
      ].join(","));
    }
    downloadFile(`${host}-endpoints.csv`, rows.join("\n"), "text/csv");
    setStatus(`Exported ${entries.length} endpoints as CSV.`);
  }
}

function csvCell(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
  return text;
}

function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(link.href), 2000);
}

/* ---------- Crawl ---------- */

async function handleCrawlStart() {
  if (!state.workspaceKey || !state.origin) {
    setStatus("No site context for crawl.");
    return;
  }
  if (state.settings.activeEnabled !== true) {
    await updateSettings({ activeEnabled: true });
  }
  const seed = (ui.crawlSeed && ui.crawlSeed.value.trim()) || state.origin;
  setStatus("Starting crawl…");
  const response = await sendMessage({
    type: "pm_start_crawl",
    workspaceKey: state.workspaceKey,
    origin: state.origin,
    seed,
  });
  if (!response || !response.ok) {
    setStatus(response && response.error ? response.error : "Crawl failed to start.");
    return;
  }
  setStatus("Crawl started.");
  refreshState();
}

async function handleCrawlStop() {
  const response = await sendMessage({ type: "pm_stop_crawl", workspaceKey: state.workspaceKey });
  setStatus(response && response.ok ? "Crawl stopping…" : "No crawl running.");
  refreshState();
}

async function handleClearData() {
  if (!state.workspaceKey) return;
  const response = await sendMessage({ type: "pm_clear_workspace", workspaceKey: state.workspaceKey });
  if (response && response.ok) {
    state.renderLimit = 200;
    setStatus("Cleared this site's data.");
    refreshState();
  } else {
    setStatus("Failed to clear data.");
  }
}

/* ---------- GraphQL ---------- */

function setGraphqlStatus(text) {
  if (ui.graphqlStatus) ui.graphqlStatus.textContent = text;
}

function updateGraphqlTargets() {
  if (!ui.graphqlTarget) return;
  const candidates = dedupeEntries(state.entries).filter((entry) => {
    const tags = entry.tags || [];
    return entry.graphqlCandidate || tags.includes("graphql");
  });
  const unique = new Map();
  for (const entry of candidates) {
    if (entry.url && !unique.has(entry.url)) unique.set(entry.url, entry);
  }
  const current = ui.graphqlTarget.value;
  ui.graphqlTarget.innerHTML = "";
  if (unique.size === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No GraphQL candidates yet";
    ui.graphqlTarget.appendChild(option);
    if (ui.graphqlIntrospect) ui.graphqlIntrospect.disabled = true;
    return;
  }
  for (const entry of unique.values()) {
    const option = document.createElement("option");
    option.value = entry.url;
    option.textContent = entry.url;
    ui.graphqlTarget.appendChild(option);
  }
  if (current) ui.graphqlTarget.value = current;
  if (ui.graphqlIntrospect) ui.graphqlIntrospect.disabled = state.settings.allowGraphqlChecks !== true;
}

async function handleGraphqlGuess() {
  if (!state.origin) {
    setGraphqlStatus("No origin available.");
    return;
  }
  setGraphqlStatus("Adding guesses…");
  const response = await sendMessage({
    type: "pm_graphql_guess",
    workspaceKey: state.workspaceKey,
    origin: state.origin,
  });
  if (!response || !response.ok) {
    setGraphqlStatus(response && response.error ? response.error : "Failed.");
    return;
  }
  setGraphqlStatus(`Added ${response.added || 0} guesses.`);
  refreshState();
}

async function handleGraphqlIntrospect() {
  const target = ui.graphqlTarget ? ui.graphqlTarget.value : "";
  if (!target) {
    setGraphqlStatus("No GraphQL target.");
    return;
  }
  if (state.settings.allowGraphqlChecks !== true) {
    setGraphqlStatus("Enable introspection first.");
    return;
  }
  setGraphqlStatus("Running introspection…");
  const response = await sendMessage({
    type: "pm_graphql_introspect",
    url: target,
    workspaceKey: state.workspaceKey,
    origin: state.origin,
  });
  if (!response || !response.ok) {
    setGraphqlStatus(response && response.error ? response.error : "Failed.");
    return;
  }
  setGraphqlStatus(response.enabled ? "Introspection ENABLED." : "Introspection blocked.");
  refreshState();
}

async function handleOpenApiParse(url) {
  if (!url) return;
  setStatus("Parsing OpenAPI…");
  const response = await sendMessage({
    type: "pm_parse_openapi",
    url,
    workspaceKey: state.workspaceKey,
    origin: state.origin,
  });
  if (!response || !response.ok) {
    setStatus(response && response.error ? response.error : "Parse failed.");
    return;
  }
  setStatus(`Added ${response.added || 0} endpoints.`);
  refreshState();
}

/* ---------- Run scan (page injection) ---------- */

async function ensureBridgeNonce() {
  const key = "pm_bridge_nonce";
  const data = await new Promise((resolve) => chrome.storage.local.get(key, resolve));
  let nonce = data && data[key];
  if (!nonce) {
    nonce =
      (typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2)) +
      "-" +
      Date.now().toString(36);
    await new Promise((resolve) => chrome.storage.local.set({ [key]: nonce }, resolve));
  }
  return nonce;
}

async function handleRunScan() {
  setStatus("Running scan…");
  const nonce = await ensureBridgeNonce();
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || !tabs.length) {
      setStatus("No active tab.");
      return;
    }
    const tabId = tabs[0].id;
    chrome.scripting.executeScript(
      { target: { tabId }, func: installPageBridge, args: [nonce] },
      () => {
      if (chrome.runtime.lastError) {
        setStatus(`Scan failed: ${chrome.runtime.lastError.message}`);
        return;
      }
      chrome.scripting.executeScript(
        { target: { tabId }, func: installPageHookMain, world: "MAIN", args: [nonce] },
        () => {
          if (chrome.runtime.lastError) {
            setStatus(`Hook failed: ${chrome.runtime.lastError.message}`);
            return;
          }
          chrome.scripting.executeScript({ target: { tabId }, func: runCustomCode }, () => {
            if (chrome.runtime.lastError) {
              setStatus(`Scan failed: ${chrome.runtime.lastError.message}`);
              return;
            }
            setStatus("Scan running — hooks active, results streaming in.");
          });
        }
      );
    });
  });
}

/* ---------- Shared helpers ---------- */

function copyText(text) {
  if (!text) return;
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).catch(() => {});
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    document.execCommand("copy");
  } catch (error) {
    // ignore
  } finally {
    document.body.removeChild(textarea);
  }
}

function getStatusClass(status) {
  if (status >= 200 && status < 300) return "status-2xx";
  if (status >= 300 && status < 400) return "status-3xx";
  if (status >= 400 && status < 500) return "status-4xx";
  if (status >= 500) return "status-5xx";
  return "";
}

function formatMethods(methods) {
  const unique = Array.from(
    new Set((methods || []).map((method) => String(method).toUpperCase()))
  ).filter(Boolean);
  if (!unique.length) return "GET";
  const shown = unique.slice(0, 3);
  let label = shown.join("+");
  if (unique.length > shown.length) label += `+${unique.length - shown.length}`;
  return label;
}

/* ---------- Injected page functions (serialized by executeScript) ---------- */

function installPageBridge(nonce) {
  // Runs in the isolated content-script world; this window/property is not
  // reachable from the page's own scripts. Keep the expected nonce current.
  window.__PM_BRIDGE_NONCE__ = nonce;
  if (window.__PM_BRIDGE__) return;
  window.__PM_BRIDGE__ = true;
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__pm !== true || data.kind !== "hook") return;
    // Reject events that don't carry the nonce our own hook was seeded with.
    if (!data.nonce || data.nonce !== window.__PM_BRIDGE_NONCE__) return;
    chrome.runtime.sendMessage({ type: "pm_hook_event", payload: data.payload });
  });
}

function installPageHookMain(nonce) {
  if (window.__PM_HOOKED__) return;
  window.__PM_HOOKED__ = true;

  const bridgeNonce = nonce;
  const toAbsolute = (url) => {
    try {
      return new URL(url, window.location.href).href;
    } catch (error) {
      return url;
    }
  };
  const post = (payload) => {
    window.postMessage({ __pm: true, kind: "hook", nonce: bridgeNonce, payload }, "*");
  };

  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === "string" ? input : input && input.url ? input.url : "";
      const method = (init && init.method) || (input && input.method) || "GET";
      const abs = toAbsolute(url);
      if (/^https?:/i.test(abs)) {
        post({ url: abs, method: String(method).toUpperCase(), type: "fetch", ts: Date.now() });
      }
    } catch (error) {
      // ignore
    }
    return originalFetch.apply(this, arguments);
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      const abs = toAbsolute(url);
      if (/^https?:/i.test(abs)) {
        post({ url: abs, method: String(method || "GET").toUpperCase(), type: "xhr", ts: Date.now() });
      }
    } catch (error) {
      // ignore
    }
    return originalOpen.apply(this, arguments);
  };
}

function runCustomCode() {
  (function () {
    var scripts = document.getElementsByTagName("script"),
      regex = /(?<=(\"|\%27|\`))\/[a-zA-Z0-9_?&=\/\-\#\.]*(?=(\"|\'|\%60))/g,
      results = new Set(),
      findingKeys = new Set(),
      findingList = [],
      timeoutDelay = 3000;

    var secretPatterns = [
      { type: "AWS Access Key", severity: "high", re: /AKIA[0-9A-Z]{16}/g },
      { type: "AWS Secret Key", severity: "high", re: /aws_secret_access_key["'`\s:=]+([0-9A-Za-z\/+]{40})/gi },
      { type: "Google API Key", severity: "high", re: /AIza[0-9A-Za-z_\-]{35}/g },
      { type: "GitHub Token", severity: "high", re: /gh[pousr]_[0-9A-Za-z]{36,}/g },
      { type: "Slack Token", severity: "high", re: /xox[baprs]-[0-9A-Za-z-]{10,48}/g },
      { type: "Stripe Live Secret", severity: "high", re: /sk_live_[0-9A-Za-z]{16,}/g },
      { type: "Stripe Publishable", severity: "low", re: /pk_live_[0-9A-Za-z]{16,}/g },
      { type: "Google OAuth", severity: "high", re: /[0-9]+-[0-9A-Za-z_]{32}\.apps\.googleusercontent\.com/g },
      { type: "JWT", severity: "medium", re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g },
      { type: "Private Key", severity: "high", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g },
      { type: "Generic Secret", severity: "medium", re: /(?:api[_-]?key|secret|access[_-]?token|auth[_-]?token|client[_-]?secret)["'`]?\s*[:=]\s*["'`]([0-9A-Za-z_\-]{16,64})["'`]/gi },
    ];

    function maskSecret(value) {
      var s = String(value || "");
      if (s.length <= 8) return s.charAt(0) + "•••";
      return s.slice(0, 4) + "…" + s.slice(-2) + " (" + s.length + " chars)";
    }

    function scanSecrets(text, source) {
      if (!text) return;
      for (var p = 0; p < secretPatterns.length; p++) {
        var pattern = secretPatterns[p];
        pattern.re.lastIndex = 0;
        var match, guard = 0;
        while ((match = pattern.re.exec(text)) !== null && guard < 40) {
          guard += 1;
          var value = match[1] || match[0];
          var preview = maskSecret(value);
          var key = pattern.type + "|" + source + "|" + preview;
          if (findingKeys.has(key)) continue;
          findingKeys.add(key);
          findingList.push({
            type: pattern.type,
            severity: pattern.severity,
            source: source,
            preview: preview,
          });
        }
      }
    }

    for (var i = 0; i < scripts.length; i++) {
      var src = scripts[i].src;
      if (src)
        fetch(src)
          .then((response) => response.text())
          .then((content) => {
            let matches = content.matchAll(regex);
            for (let match of matches) results.add(match[0]);
            scanSecrets(content, src);
          })
          .catch((error) => console.error("Error fetching script:", src, error));
    }
    var pageContent = document.documentElement.outerHTML,
      matches = pageContent.matchAll(regex);
    for (const match of matches) results.add(match[0]);
    scanSecrets(pageContent, window.location.href);

    function resolveUrl(item) {
      if (/^https?:\/\//i.test(item)) return item;
      if (item.startsWith("//")) return window.location.protocol + item;
      try {
        return new URL(item, document.baseURI).href;
      } catch (error) {
        return item;
      }
    }

    function sendToWorkspace() {
      try {
        if (!chrome || !chrome.runtime || !chrome.runtime.id) return;
        const origin = window.location.origin;
        const seen = new Set();
        const items = [];
        results.forEach((item) => {
          const abs = resolveUrl(item);
          if (!/^https?:\/\//i.test(abs)) return;
          if (!abs.startsWith(origin)) return; // keep the workspace scoped to this site
          if (seen.has(abs)) return;
          seen.add(abs);
          items.push({ url: abs, method: "GET", source: "page_scan" });
        });
        if (items.length) {
          chrome.runtime.sendMessage({ type: "pm_scan_paths", items });
        }
      } catch (error) {
        // ignore
      }
    }

    function sendFindings() {
      try {
        if (!chrome || !chrome.runtime || !chrome.runtime.id) return;
        if (findingList.length) {
          chrome.runtime.sendMessage({
            type: "pm_scan_findings",
            workspaceKey: window.location.hostname,
            items: findingList.slice(0, 200),
          });
        }
      } catch (error) {
        // ignore
      }
    }

    function showResults() {
      const existingModal = document.querySelector(".pm-modal");
      const existingBackdrop = document.querySelector(".pm-backdrop");
      if (existingModal) existingModal.remove();
      if (existingBackdrop) existingBackdrop.remove();

      const backdrop = document.createElement("div");
      backdrop.className = "pm-backdrop";

      const modal = document.createElement("div");
      modal.className = "pm-modal";

      const style = document.createElement("style");
      style.textContent = `
        .pm-modal { position: fixed; top: 8%; left: 50%; transform: translate(-50%, -8%);
          width: min(960px, 82vw); max-height: 84vh; background: #0a0a0a; color: #f5f5f5;
          border: 1px solid #1f1f1f; border-radius: 14px; box-shadow: 0 20px 60px rgba(0,0,0,0.6);
          padding: 16px; font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif; font-size: 13px;
          display: flex; flex-direction: column; gap: 10px; z-index: 2147483647; text-align: left; direction: ltr; overflow: hidden; }
        .pm-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.45); backdrop-filter: blur(2px); z-index: 2147483646; }
        .pm-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .pm-header-actions { display: flex; align-items: center; gap: 6px; }
        .pm-title { font-size: 16px; font-weight: 600; margin: 0; color: #f5f5f5; }
        .pm-body { display: flex; flex-direction: column; gap: 10px; overflow: hidden; }
        .pm-icon-button { appearance: none; background: #0f0f0f; border: 1px solid #1f1f1f; color: #f5f5f5; width: 30px; height: 30px; border-radius: 10px; font-size: 13px; cursor: pointer; }
        .pm-counts { display: flex; justify-content: space-between; align-items: center; color: #93a0ad; font-size: 12px; }
        .pm-counts span { color: #f5f5f5; margin-left: 4px; }
        .pm-input { width: 100%; padding: 10px 12px; background: #0f0f0f; color: #f5f5f5; border: 1px solid #1f1f1f; border-radius: 10px; outline: none; box-sizing: border-box; font-size: 14px; }
        .pm-chips { display: flex; flex-wrap: wrap; gap: 6px 8px; }
        .pm-chip { appearance: none; background: #0f0f0f; border: 1px solid #1f1f1f; color: #cbd5e1; border-radius: 999px; padding: 5px 10px; font-size: 12px; cursor: pointer; }
        .pm-chip--active { border-color: #9ad7ff; color: #9ad7ff; }
        .pm-list-wrap { flex: 1; overflow: auto; border-top: 1px solid #121212; padding-top: 8px; }
        .pm-list { list-style: none; margin: 0; padding: 0; }
        .pm-item { padding: 6px 4px; word-break: break-word; cursor: pointer; color: #e5e7eb; text-decoration: underline; text-decoration-color: #1f1f1f; }
        .pm-item:hover { color: #ffffff; text-decoration-color: #9ad7ff; }
        .pm-actions { display: flex; gap: 8px; justify-content: flex-end; }
        .pm-button { appearance: none; padding: 8px 12px; border-radius: 10px; border: 1px solid #1f1f1f; background: #0f0f0f; color: #f5f5f5; font-size: 13px; cursor: pointer; }
        .pm-button--ghost { font-size: 12px; padding: 6px 10px; border-radius: 10px; }
        .pm-button:hover { border-color: #2d2d2d; }
      `;

      const header = document.createElement("div");
      header.className = "pm-header";
      const title = document.createElement("div");
      title.className = "pm-title";
      title.innerText = "Extracted URLs/Paths";

      function copyText(text) {
        if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
        return new Promise((resolve, reject) => {
          const textarea = document.createElement("textarea");
          textarea.value = text;
          textarea.style.position = "fixed";
          textarea.style.opacity = "0";
          document.body.appendChild(textarea);
          textarea.focus();
          textarea.select();
          try { document.execCommand("copy"); resolve(); }
          catch (error) { reject(error); }
          finally { document.body.removeChild(textarea); }
        });
      }

      const headerActions = document.createElement("div");
      headerActions.className = "pm-header-actions";
      const copyButtonTop = document.createElement("button");
      copyButtonTop.className = "pm-button pm-button--ghost";
      copyButtonTop.type = "button";
      copyButtonTop.innerText = "Copy list";
      copyButtonTop.onclick = () => {
        const text = Array.from(results).join("\n");
        copyText(text)
          .then(() => { copyButtonTop.innerText = "Copied"; setTimeout(() => (copyButtonTop.innerText = "Copy list"), 1200); })
          .catch(() => { copyButtonTop.innerText = "Copy failed"; setTimeout(() => (copyButtonTop.innerText = "Copy list"), 1400); });
      };
      const closeButtonTop = document.createElement("button");
      closeButtonTop.className = "pm-icon-button";
      closeButtonTop.type = "button";
      closeButtonTop.innerText = "X";
      closeButtonTop.setAttribute("aria-label", "Close");
      closeButtonTop.onclick = () => { backdrop.remove(); modal.remove(); };
      headerActions.appendChild(copyButtonTop);
      headerActions.appendChild(closeButtonTop);
      header.appendChild(title);
      header.appendChild(headerActions);

      const countsBar = document.createElement("div");
      countsBar.className = "pm-counts";
      const totalLabel = document.createElement("div");
      totalLabel.innerText = "Total:";
      const totalCount = document.createElement("span");
      totalLabel.appendChild(totalCount);
      const visibleLabel = document.createElement("div");
      visibleLabel.innerText = "Visible:";
      const visibleCount = document.createElement("span");
      visibleLabel.appendChild(visibleCount);
      countsBar.appendChild(totalLabel);
      countsBar.appendChild(visibleLabel);

      const searchBar = document.createElement("input");
      searchBar.type = "text";
      searchBar.placeholder = "Search...";
      searchBar.className = "pm-input";

      const groupCounts = document.createElement("div");
      groupCounts.className = "pm-chips";

      const listWrap = document.createElement("div");
      listWrap.className = "pm-list-wrap";
      const list = document.createElement("ul");
      list.className = "pm-list";
      listWrap.appendChild(list);

      function getExtension(item) {
        const clean = item.split(/[?#]/)[0];
        const last = clean.split("/").pop() || "";
        const dotIndex = last.lastIndexOf(".");
        if (dotIndex <= 0 || dotIndex === last.length - 1) return "(none)";
        return last.slice(dotIndex + 1).toLowerCase();
      }

      const items = [];
      results.forEach((item) => {
        const listItem = document.createElement("li");
        listItem.className = "pm-item";
        const resolvedUrl = resolveUrl(item);
        listItem.dataset.url = resolvedUrl;
        listItem.dataset.ext = getExtension(item);
        const link = document.createElement("a");
        link.href = resolvedUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = item;
        link.style.color = "inherit";
        link.style.textDecoration = "underline";
        link.style.textDecorationColor = "#1f1f1f";
        link.style.display = "block";
        link.title = "Open: " + resolvedUrl;
        listItem.appendChild(link);
        list.appendChild(listItem);
        items.push(listItem);
      });

      let activeExt = "all";
      let searchText = "";

      function renderChips(groupMap) {
        groupCounts.innerHTML = "";
        const totalSearch = Array.from(groupMap.values()).reduce((sum, value) => sum + value, 0);
        const entries = [["all", totalSearch]].concat(
          Array.from(groupMap.entries()).sort((a, b) => {
            if (b[1] !== a[1]) return b[1] - a[1];
            return a[0].localeCompare(b[0]);
          })
        );
        for (const [ext, count] of entries) {
          const chip = document.createElement("button");
          chip.type = "button";
          chip.className = "pm-chip" + (activeExt === ext ? " pm-chip--active" : "");
          chip.dataset.ext = ext;
          chip.innerText = ext + ": " + count;
          chip.addEventListener("click", () => { activeExt = activeExt === ext ? "all" : ext; applyFilters(); });
          groupCounts.appendChild(chip);
        }
      }

      function applyFilters() {
        const groupMap = new Map();
        let visible = 0;
        for (const item of items) {
          const text = item.textContent ? item.textContent.toLowerCase() : "";
          const matchesSearch = text.indexOf(searchText) > -1;
          if (matchesSearch) {
            const ext = item.dataset.ext || "(none)";
            groupMap.set(ext, (groupMap.get(ext) || 0) + 1);
          }
          const matchesExt = activeExt === "all" || item.dataset.ext === activeExt;
          const show = matchesSearch && matchesExt;
          item.style.display = show ? "" : "none";
          if (show) visible += 1;
        }
        totalCount.innerText = items.length.toString();
        visibleCount.innerText = visible.toString();
        renderChips(groupMap);
      }

      searchBar.addEventListener("input", () => { searchText = searchBar.value.trim().toLowerCase(); applyFilters(); });

      const actions = document.createElement("div");
      actions.className = "pm-actions";
      const downloadButton = document.createElement("button");
      downloadButton.type = "button";
      downloadButton.className = "pm-button";
      downloadButton.innerText = "Download results";
      downloadButton.onclick = () => {
        const blob = new Blob([Array.from(results).join("\n")], { type: "text/plain" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = "extracted_paths.txt";
        link.click();
      };
      const closeButtonBottom = document.createElement("button");
      closeButtonBottom.type = "button";
      closeButtonBottom.className = "pm-button";
      closeButtonBottom.innerText = "Close";
      closeButtonBottom.onclick = () => { backdrop.remove(); modal.remove(); };
      actions.appendChild(downloadButton);
      actions.appendChild(closeButtonBottom);

      const body = document.createElement("div");
      body.className = "pm-body";
      body.appendChild(countsBar);
      body.appendChild(searchBar);
      body.appendChild(groupCounts);
      body.appendChild(listWrap);
      body.appendChild(actions);

      modal.appendChild(style);
      modal.appendChild(header);
      modal.appendChild(body);
      backdrop.addEventListener("click", () => { backdrop.remove(); modal.remove(); });
      document.body.appendChild(backdrop);
      document.body.appendChild(modal);

      applyFilters();
      sendToWorkspace();
      sendFindings();
    }
    setTimeout(showResults, timeoutDelay);
  })();
}
