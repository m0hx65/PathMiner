const state = {
  activeTab: null,
  workspaceKey: null,
  origin: null,
  entries: [],
  settings: {},
  renderLimit: 200,
};

const ui = {};

document.addEventListener("DOMContentLoaded", () => {
  cacheElements();
  bindEvents();
  loadActiveTab();
});

function cacheElements() {
  ui.runCode = document.getElementById("runCode");
  ui.status = document.getElementById("status");
  ui.entries = document.getElementById("entries");
  ui.loadMore = document.getElementById("loadMore");
  ui.entriesSection = document.getElementById("entriesSection");
  ui.graphqlTools = document.getElementById("graphqlTools");
  ui.graphqlTarget = document.getElementById("graphqlTarget");
  ui.graphqlGuess = document.getElementById("graphqlGuess");
  ui.graphqlIntrospect = document.getElementById("graphqlIntrospect");
  ui.graphqlAllowToggle = document.getElementById("graphqlAllowToggle");
  ui.graphqlStatus = document.getElementById("graphqlStatus");
}

function bindEvents() {
  if (ui.runCode) ui.runCode.addEventListener("click", handleRunScan);

  if (ui.loadMore) {
    ui.loadMore.addEventListener("click", () => {
      state.renderLimit += 200;
      renderEntries();
    });
  }

  if (ui.graphqlGuess) {
    ui.graphqlGuess.addEventListener("click", handleGraphqlGuess);
  }

  if (ui.graphqlIntrospect) {
    ui.graphqlIntrospect.addEventListener("click", handleGraphqlIntrospect);
  }

  if (ui.graphqlAllowToggle) {
    ui.graphqlAllowToggle.addEventListener("change", () => {
      updateSettings({ allowGraphqlChecks: ui.graphqlAllowToggle.checked });
    });
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || !message.type) return;
    if (
      (message.type === "pm_workspace_updated" ||
        message.type === "pm_crawl_update") &&
      message.workspaceKey === state.workspaceKey
    ) {
      refreshState();
    }
  });
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
    chrome.runtime.sendMessage(message, (response) => resolve(response));
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
  applySettingsToUI();
  updateGraphqlTargets();
  renderEntries();
}

async function updateSettings(partial) {
  if (!partial) return;
  const response = await sendMessage({ type: "pm_update_settings", settings: partial });
  if (response && response.settings) {
    state.settings = response.settings;
    applySettingsToUI();
  }
}

function applySettingsToUI() {
  if (ui.graphqlAllowToggle) {
    ui.graphqlAllowToggle.checked = state.settings.allowGraphqlChecks === true;
  }
  if (ui.graphqlIntrospect) {
    ui.graphqlIntrospect.disabled = state.settings.allowGraphqlChecks !== true;
  }
}

function handleRunScan() {
  setStatus("Running scan...");
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || !tabs.length) {
      setStatus("No active tab.");
      return;
    }
    const tabId = tabs[0].id;
    chrome.scripting.executeScript(
      {
        target: { tabId },
        func: installPageBridge,
      },
      () => {
        if (chrome.runtime.lastError) {
          setStatus(`Scan failed: ${chrome.runtime.lastError.message}`);
          return;
        }
        chrome.scripting.executeScript(
          {
            target: { tabId },
            func: installPageHookMain,
            world: "MAIN",
          },
          () => {
            if (chrome.runtime.lastError) {
              setStatus(`Hook failed: ${chrome.runtime.lastError.message}`);
              return;
            }
            chrome.scripting.executeScript(
              {
                target: { tabId },
                func: runCustomCode,
              },
              () => {
                if (chrome.runtime.lastError) {
                  setStatus(`Scan failed: ${chrome.runtime.lastError.message}`);
                  return;
                }
                setStatus("Hook active on this tab.");
                setTimeout(() => window.close(), 500);
              }
            );
          }
        );
      }
    );
  });
}

function setGraphqlStatus(text) {
  if (ui.graphqlStatus) ui.graphqlStatus.textContent = text;
}

function updateGraphqlTargets() {
  if (!ui.graphqlTarget) return;
  const candidates = state.entries.filter((entry) => {
    const tags = entry.tags || [];
    return entry.graphqlCandidate || tags.includes("graphql");
  });
  const unique = new Map();
  for (const entry of candidates) {
    if (!entry.url) continue;
    if (!unique.has(entry.url)) {
      unique.set(entry.url, entry);
    }
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
  if (ui.graphqlIntrospect) {
    ui.graphqlIntrospect.disabled = state.settings.allowGraphqlChecks !== true;
  }
}

async function handleGraphqlGuess() {
  if (!state.origin) {
    setGraphqlStatus("No origin available.");
    return;
  }
  setGraphqlStatus("Adding guesses...");
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
  setGraphqlStatus("Running introspection...");
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
  setGraphqlStatus(response.enabled ? "Introspection enabled." : "Introspection blocked.");
  refreshState();
}


function installPageBridge() {
  if (window.__PM_BRIDGE__) return;
  window.__PM_BRIDGE__ = true;

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__pm !== true || data.kind !== "hook") return;
    chrome.runtime.sendMessage({ type: "pm_hook_event", payload: data.payload });
  });
}

function installPageHookMain() {
  if (window.__PM_HOOKED__) return;
  window.__PM_HOOKED__ = true;

  const toAbsolute = (url) => {
    try {
      return new URL(url, window.location.href).href;
    } catch (error) {
      return url;
    }
  };

  const post = (payload) => {
    window.postMessage({ __pm: true, kind: "hook", payload }, "*");
  };

  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url =
        typeof input === "string"
          ? input
          : input && input.url
          ? input.url
          : "";
      const method =
        (init && init.method) ||
        (input && input.method) ||
        "GET";
      const abs = toAbsolute(url);
      if (/^https?:/i.test(abs)) {
        post({
          url: abs,
          method: String(method).toUpperCase(),
          type: "fetch",
          ts: Date.now(),
        });
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
        post({
          url: abs,
          method: String(method || "GET").toUpperCase(),
          type: "xhr",
          ts: Date.now(),
        });
      }
    } catch (error) {
      // ignore
    }
    return originalOpen.apply(this, arguments);
  };
}





function renderEntries() {
  if (!ui.entries) return;
  const entries = dedupeEntries(state.entries).sort((a, b) => {
    const scoreDiff = (b.score || 0) - (a.score || 0);
    if (scoreDiff !== 0) return scoreDiff;
    return (b.lastSeen || 0) - (a.lastSeen || 0);
  });
  if (ui.entriesSection) {
    if (!entries.length) {
      ui.entriesSection.classList.add("hidden");
      return;
    }
    ui.entriesSection.classList.remove("hidden");
  }
  const limit = state.renderLimit;
  const visible = entries.slice(0, limit);

  ui.entries.innerHTML = "";
  const fragment = document.createDocumentFragment();

  for (const entry of visible) {
    fragment.appendChild(createEntryRow(entry));
  }

  ui.entries.appendChild(fragment);

  if (ui.loadMore) {
    if (entries.length > visible.length) {
      ui.loadMore.classList.remove("hidden");
    } else {
      ui.loadMore.classList.add("hidden");
    }
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
    if (Array.isArray(entry.tags)) {
      entry.tags.forEach((tag) => group.tags.add(tag));
    }
    group.scoreMax = Math.max(group.scoreMax || 0, entry.score || 0);
    group.openapi = group.openapi || entry.openapiCandidate === true;
    group.graphql = group.graphql || entry.graphqlCandidate === true;
    if (isBetterEntry(entry, group.rep)) {
      group.rep = entry;
    }
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
  url.title = entry.url || "";
  url.addEventListener("click", () => {
    if (entry.url && entry.url.startsWith("http")) {
      chrome.tabs.create({ url: entry.url });
    }
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

  const tags = Array.isArray(entry.tags) ? entry.tags : [];
  const shownTags = tags.slice(0, 3);
  for (const tag of shownTags) {
    const pill = document.createElement("span");
    pill.className = "pill";
    pill.textContent = tag;
    meta.appendChild(pill);
  }
  if (tags.length > shownTags.length) {
    const more = document.createElement("span");
    more.className = "pill";
    more.textContent = `+${tags.length - shownTags.length}`;
    meta.appendChild(more);
  }

  const source = document.createElement("span");
  source.className = "pill";
  if (entry._sourcesSeen && entry._sourcesSeen.length > 1) {
    source.textContent = "multi";
  } else {
    source.textContent = formatSource(entry.source);
  }
  meta.appendChild(source);

  if (entry.openapiCandidate || (entry.tags || []).includes("docs")) {
    const parseButton = document.createElement("button");
    parseButton.type = "button";
    parseButton.className = "chip";
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
  if (unique.length > shown.length) {
    label += `+${unique.length - shown.length}`;
  }
  return label;
}

function formatSource(source) {
  switch (source) {
    case "passive_network":
      return "passive";
    case "active_crawl":
      return "active";
    case "graphql_check":
      return "graphql";
    default:
      return source || "-";
  }
}

async function handleOpenApiParse(url) {
  if (!url) return;
  setStatus("Parsing OpenAPI...");
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


function runCustomCode() {
  // Place your custom JavaScript code here
  (function () {
    var scripts = document.getElementsByTagName("script"),
      regex = /(?<=(\"|\%27|\`))\/[a-zA-Z0-9_?&=\/\-\#\.]*(?=(\"|\'|\%60))/g,
      results = new Set(),
      timeoutDelay = 3000;
    for (var i = 0; i < scripts.length; i++) {
      var src = scripts[i].src;
      if (src)
        fetch(src)
          .then((response) => response.text())
          .then((content) => {
            let matches = content.matchAll(regex);
            for (let match of matches) results.add(match[0]);
          })
          .catch((error) => console.error("Error fetching script:", src, error));
    }
    var pageContent = document.documentElement.outerHTML,
      matches = pageContent.matchAll(regex);
    for (const match of matches) results.add(match[0]);
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
        .pm-modal {
          position: fixed;
          top: 8%;
          left: 50%;
          transform: translate(-50%, -8%);
          width: min(960px, 82vw);
          max-height: 84vh;
          background: #0a0a0a;
          color: #f5f5f5;
          border: 1px solid #1f1f1f;
          border-radius: 14px;
          box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
          padding: 16px;
          font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
          font-size: 13px;
          display: flex;
          flex-direction: column;
          gap: 10px;
          z-index: 2147483647;
          text-align: left;
          direction: ltr;
          overflow: hidden;
        }
        .pm-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.45);
          backdrop-filter: blur(2px);
          z-index: 2147483646;
        }
        .pm-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }
        .pm-header-actions {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .pm-title {
          font-size: 16px;
          font-weight: 600;
          margin: 0;
          color: #f5f5f5;
        }
        .pm-body {
          display: flex;
          flex-direction: column;
          gap: 10px;
          overflow: hidden;
        }
        .pm-icon-button {
          appearance: none;
          background: #0f0f0f;
          border: 1px solid #1f1f1f;
          color: #f5f5f5;
          width: 30px;
          height: 30px;
          border-radius: 10px;
          font-size: 13px;
          cursor: pointer;
        }
        .pm-counts {
          display: flex;
          justify-content: space-between;
          align-items: center;
          color: #93a0ad;
          font-size: 12px;
        }
        .pm-counts span {
          color: #f5f5f5;
          margin-left: 4px;
        }
        .pm-input {
          width: 100%;
          padding: 10px 12px;
          background: #0f0f0f;
          color: #f5f5f5;
          border: 1px solid #1f1f1f;
          border-radius: 10px;
          outline: none;
          box-sizing: border-box;
          font-size: 14px;
        }
        .pm-chips {
          display: flex;
          flex-wrap: wrap;
          gap: 6px 8px;
        }
        .pm-chip {
          appearance: none;
          background: #0f0f0f;
          border: 1px solid #1f1f1f;
          color: #cbd5e1;
          border-radius: 999px;
          padding: 5px 10px;
          font-size: 12px;
          cursor: pointer;
        }
        .pm-chip--active {
          border-color: #9ad7ff;
          color: #9ad7ff;
        }
        .pm-list-wrap {
          flex: 1;
          overflow: auto;
          border-top: 1px solid #121212;
          padding-top: 8px;
        }
        .pm-list {
          list-style: none;
          margin: 0;
          padding: 0;
        }
        .pm-item {
          padding: 6px 4px;
          word-break: break-word;
          cursor: pointer;
          color: #e5e7eb;
          text-decoration: underline;
          text-decoration-color: #1f1f1f;
        }
        .pm-item:hover {
          color: #ffffff;
          text-decoration-color: #9ad7ff;
        }
        .pm-actions {
          display: flex;
          gap: 8px;
          justify-content: flex-end;
        }
        .pm-button {
          appearance: none;
          padding: 8px 12px;
          border-radius: 10px;
          border: 1px solid #1f1f1f;
          background: #0f0f0f;
          color: #f5f5f5;
          font-size: 13px;
          cursor: pointer;
        }
        .pm-button--ghost {
          font-size: 12px;
          padding: 6px 10px;
          border-radius: 10px;
        }
        .pm-button:hover {
          border-color: #2d2d2d;
        }
      `;

      const header = document.createElement("div");
      header.className = "pm-header";

      const title = document.createElement("div");
      title.className = "pm-title";
      title.innerText = "Extracted URLs/Paths";

      function copyText(text) {
        if (navigator.clipboard && window.isSecureContext) {
          return navigator.clipboard.writeText(text);
        }
        return new Promise((resolve, reject) => {
          const textarea = document.createElement("textarea");
          textarea.value = text;
          textarea.style.position = "fixed";
          textarea.style.opacity = "0";
          document.body.appendChild(textarea);
          textarea.focus();
          textarea.select();
          try {
            document.execCommand("copy");
            resolve();
          } catch (error) {
            reject(error);
          } finally {
            document.body.removeChild(textarea);
          }
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
          .then(() => {
            const original = copyButtonTop.innerText;
            copyButtonTop.innerText = "Copied";
            setTimeout(() => {
              copyButtonTop.innerText = original;
            }, 1200);
          })
          .catch(() => {
            const original = copyButtonTop.innerText;
            copyButtonTop.innerText = "Copy failed";
            setTimeout(() => {
              copyButtonTop.innerText = original;
            }, 1400);
          });
      };

      const closeButtonTop = document.createElement("button");
      closeButtonTop.className = "pm-icon-button";
      closeButtonTop.type = "button";
      closeButtonTop.innerText = "X";
      closeButtonTop.setAttribute("aria-label", "Close");
      closeButtonTop.onclick = () => {
        backdrop.remove();
        modal.remove();
      };

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

      function resolveUrl(item) {
        if (/^https?:\/\//i.test(item)) return item;
        if (item.startsWith("//")) return window.location.protocol + item;
        try {
          return new URL(item, document.baseURI).href;
        } catch (error) {
          return item;
        }
      }

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
        const totalSearch = Array.from(groupMap.values()).reduce(
          (sum, value) => sum + value,
          0
        );
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
          chip.addEventListener("click", () => {
            activeExt = activeExt === ext ? "all" : ext;
            applyFilters();
          });
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

      searchBar.addEventListener("input", () => {
        searchText = searchBar.value.trim().toLowerCase();
        applyFilters();
      });

      const actions = document.createElement("div");
      actions.className = "pm-actions";

      const downloadButton = document.createElement("button");
      downloadButton.type = "button";
      downloadButton.className = "pm-button";
      downloadButton.innerText = "Download results";
      downloadButton.onclick = () => {
        const blob = new Blob([Array.from(results).join("\n")], {
          type: "text/plain",
        });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = "extracted_paths.txt";
        link.click();
      };

      const closeButtonBottom = document.createElement("button");
      closeButtonBottom.type = "button";
      closeButtonBottom.className = "pm-button";
      closeButtonBottom.innerText = "Close";
      closeButtonBottom.onclick = () => {
        backdrop.remove();
        modal.remove();
      };

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
      backdrop.addEventListener("click", () => {
        backdrop.remove();
        modal.remove();
      });
      document.body.appendChild(backdrop);
      document.body.appendChild(modal);

      applyFilters();
    }
    setTimeout(showResults, timeoutDelay);
  })();
}





