const SETTINGS_KEY = "pm_settings";
const WORKSPACE_PREFIX = "pm_workspace_";
const MAX_ENTRIES = 5000;
const MAX_PATTERNS = 2000;
const MAX_FINDINGS = 500;
const HIGH_VALUE_SCORE = 40;
const SAVE_DEBOUNCE_MS = 1000;

const DEFAULT_SETTINGS = {
  passiveEnabled: true,
  activeEnabled: false,
  allowGraphqlChecks: false,
  storeRawUrls: false,
  activeDepth: 2,
  activeMaxPages: 30,
  activeDelayMs: 300,
  activeConcurrency: 2,
  patternAggressive: false,
  patternIncludeQueryKeys: false,
};

const workspaceCache = new Map();
const saveTimers = new Map();
const requestMeta = new Map();
const crawlStates = new Map();
const lastNotify = new Map();

let settingsCache = { ...DEFAULT_SETTINGS };
let settingsLoaded = false;

async function ensureSettings() {
  if (settingsLoaded) return settingsCache;
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  settingsCache = { ...DEFAULT_SETTINGS, ...(data[SETTINGS_KEY] || {}) };
  settingsLoaded = true;
  return settingsCache;
}

async function saveSettings(next) {
  const prev = settingsCache;
  settingsCache = { ...settingsCache, ...next };
  await chrome.storage.local.set({ [SETTINGS_KEY]: settingsCache });
  const patternSettingsChanged =
    prev.patternAggressive !== settingsCache.patternAggressive ||
    prev.patternIncludeQueryKeys !== settingsCache.patternIncludeQueryKeys;
  if (patternSettingsChanged) {
    for (const [workspaceKey, workspace] of workspaceCache.entries()) {
      if (!workspace.entries || workspace.entries.size === 0) continue;
      buildPatternsFromEntries(workspace, settingsCache);
      workspace.patternsBuilt = true;
      scheduleSave(workspaceKey);
      notifyWorkspace(workspaceKey);
    }
  }
  return settingsCache;
}

function getWorkspaceKey(url) {
  try {
    return new URL(url).hostname;
  } catch (error) {
    return "unknown";
  }
}

function getOrigin(url) {
  try {
    return new URL(url).origin;
  } catch (error) {
    return "";
  }
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    const params = Array.from(parsed.searchParams.entries()).sort((a, b) =>
      a[0].localeCompare(b[0])
    );
    parsed.search = params.length
      ? "?" + params.map(([k, v]) => `${k}=${v}`).join("&")
      : "";
    return parsed.origin + parsed.pathname + parsed.search;
  } catch (error) {
    return url.split("#")[0];
  }
}

function redactUrl(url) {
  const jwtRegex =
    /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
  const secretKeys = [
    "api_key",
    "apikey",
    "token",
    "auth",
    "authorization",
    "session",
    "key",
    "access_token",
    "refresh_token",
    "id_token",
    "secret",
    "password",
  ];
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    parsed.hash = "";
    parsed.searchParams.forEach((value, key) => {
      if (secretKeys.includes(key.toLowerCase())) {
        parsed.searchParams.set(key, "[REDACTED]");
      }
    });
    return parsed.toString().replace(jwtRegex, "[REDACTED_JWT]");
  } catch (error) {
    return url.replace(jwtRegex, "[REDACTED_JWT]");
  }
}

function hashString(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash +=
      (hash << 1) +
      (hash << 4) +
      (hash << 7) +
      (hash << 8) +
      (hash << 24);
  }
  return (hash >>> 0).toString(36);
}

function hasQueryParams(url) {
  try {
    return Boolean(new URL(url).search);
  } catch (error) {
    return url.includes("?");
  }
}

function getExtension(url) {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").pop() || "";
    const dot = last.lastIndexOf(".");
    if (dot <= 0 || dot === last.length - 1) return "";
    return last.slice(dot + 1).toLowerCase();
  } catch (error) {
    return "";
  }
}

function scoreEndpoint(entry) {
  const tags = new Set();
  const lower = entry.normalizedUrl.toLowerCase();
  let score = 0;

  const path = (() => {
    try {
      return new URL(entry.normalizedUrl).pathname.toLowerCase();
    } catch (error) {
      return lower;
    }
  })();

  const hasApi = path.startsWith("/api") || path.includes("/api/");
  if (hasApi) {
    score += 20;
    tags.add("api");
  }

  if (lower.includes("graphql")) {
    score += 25;
    tags.add("graphql");
  }

  if (/(admin|internal|private|debug|dev|staging)/.test(lower)) {
    score += 20;
    tags.add("admin");
  }

  if (/(swagger|openapi|api-docs)/.test(lower)) {
    score += 15;
    tags.add("docs");
  }

  if (/(auth|token|login|oauth|sso|callback|redirect)/.test(lower)) {
    score += 15;
    tags.add("auth");
    if (/(callback|redirect)/.test(lower)) {
      tags.add("redirect");
    }
  }

  if (/(upload|import|export|download)/.test(lower)) {
    score += 15;
    tags.add("upload");
  }

  if (/(webhook|callback|notify|ipn)/.test(lower)) {
    score += 10;
    tags.add("webhook");
  }

  if (/(payment|billing|invoice|checkout|charge|refund|wallet|balance)/.test(lower)) {
    score += 15;
    tags.add("payment");
  }

  // High-signal sensitive files / leaked artifacts.
  if (
    /(\.env|\.git\/|\.svn\/|\.hg\/|\.bak|\.old|\.orig|\.swp|\.sql|\.sqlite|\.db|\.log|\.pem|\.key|\.p12|\.pfx|id_rsa|\.htpasswd|\.htaccess|wp-config|web\.config|\.ds_store|dump|backup|credentials|secret)/.test(
      lower
    )
  ) {
    score += 35;
    tags.add("sensitive");
  }

  // Framework debug / management surfaces.
  if (
    /\/(actuator|jolokia|heapdump|threaddump|env|metrics|prometheus|phpinfo|server-status|_status|debug|__debug__)(\/|$|\?)/.test(
      path
    )
  ) {
    score += 20;
    tags.add("actuator");
  }

  // Structured data responses worth inspecting.
  if (/\.(json|xml|ya?ml|csv)(\?|$)/.test(lower)) {
    score += 5;
    tags.add("data");
  }

  if (hasQueryParams(entry.normalizedUrl)) {
    score += 10;
    tags.add("params");
  }

  if (entry.method && entry.method.toUpperCase() !== "GET") {
    score += 10;
    tags.add("write");
  }

  if (typeof entry.status === "number" && entry.status >= 400) {
    score += 10;
    tags.add("error");
  }

  const ext = getExtension(entry.normalizedUrl);
  if (/(png|jpg|jpeg|gif|svg|woff|woff2|ttf|css|map)/.test(ext)) {
    score -= 10;
  }

  score = Math.max(0, Math.min(100, score));

  const openapiCandidate =
    lower.endsWith("swagger.json") ||
    lower.endsWith("openapi.json") ||
    lower.includes("/api-docs") ||
    lower.includes("/swagger");
  const graphqlCandidate =
    lower.includes("graphql") ||
    (entry.contentType || "").toLowerCase().includes("graphql");

  if (openapiCandidate) {
    tags.add("docs");
  }
  if (graphqlCandidate) {
    tags.add("graphql");
  }

  return {
    score,
    tags: Array.from(tags),
    openapiCandidate,
    graphqlCandidate,
  };
}

const STATIC_SEGMENTS = new Set([
  "api",
  "v1",
  "v2",
  "v3",
  "admin",
  "auth",
  "graphql",
  "swagger",
  "openapi",
  "api-docs",
  "assets",
  "static",
]);

const SEGMENT_CACHE = new Map();

const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const OBJECT_ID_REGEX = /^[a-fA-F0-9]{24}$/;
const LONG_HEX_REGEX = /^[a-fA-F0-9]{16,}$/;
const NUMERIC_REGEX = /^\d{2,}$/;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const TOKEN_REGEX = /^[A-Za-z0-9_-]{20,}$/;

function classifySegment(segment, aggressive) {
  const key = `${segment}|${aggressive ? "1" : "0"}`;
  if (SEGMENT_CACHE.has(key)) {
    return SEGMENT_CACHE.get(key);
  }

  const lower = segment.toLowerCase();
  if (STATIC_SEGMENTS.has(lower)) {
    SEGMENT_CACHE.set(key, segment);
    return segment;
  }

  let result = segment;
  if (UUID_REGEX.test(segment)) {
    result = "{uuid}";
  } else if (OBJECT_ID_REGEX.test(segment)) {
    result = "{objectId}";
  } else if (LONG_HEX_REGEX.test(segment)) {
    result = "{hash}";
  } else if (NUMERIC_REGEX.test(segment)) {
    result = "{id}";
  } else if (DATE_REGEX.test(segment)) {
    result = "{date}";
  } else if (TOKEN_REGEX.test(segment)) {
    result = "{token}";
  } else if (
    aggressive &&
    segment.length >= 12 &&
    segment.includes("-") &&
    /^[A-Za-z0-9-]+$/.test(segment)
  ) {
    result = "{slug}";
  }

  SEGMENT_CACHE.set(key, result);
  return result;
}

function generatePattern(normalizedUrl, settings) {
  const aggressive = settings.patternAggressive === true;
  const includeQueryKeys = settings.patternIncludeQueryKeys === true;

  try {
    const parsed = new URL(normalizedUrl);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const mapped = segments.map((segment) =>
      classifySegment(segment, aggressive)
    );
    const path = mapped.length ? "/" + mapped.join("/") : "/";
    let pattern = parsed.origin + path;
    if (includeQueryKeys) {
      const keys = Array.from(new Set(parsed.searchParams.keys())).sort();
      if (keys.length) {
        pattern += "?{" + keys.join(",") + "}";
      }
    }
    return pattern;
  } catch (error) {
    const [base, query] = normalizedUrl.split("?");
    if (!includeQueryKeys || !query) return base;
    const keys = query
      .split("&")
      .map((pair) => pair.split("=")[0])
      .filter(Boolean);
    const unique = Array.from(new Set(keys)).sort();
    if (!unique.length) return base;
    return base + "?{" + unique.join(",") + "}";
  }
}

function buildPatternsFromEntries(workspace, settings) {
  const patterns = new Map();
  const patternIndex = new Map();

  for (const entry of workspace.entries.values()) {
    const pattern = generatePattern(entry.normalizedUrl, settings);
    const patternId = hashString(`${entry.workspaceKey}|${pattern}`);
    patternIndex.set(entry.id, patternId);

    const entryCount = entry.count || 1;
    const method = (entry.method || "GET").toUpperCase();
    if (!patterns.has(patternId)) {
      patterns.set(patternId, {
        id: patternId,
        workspaceKey: entry.workspaceKey,
        pattern,
        countTotal: entryCount,
        uniqueUrls: 1,
        lastSeen: entry.lastSeen,
        firstSeen: entry.firstSeen,
        exampleUrls: [entry.url],
        topMethods: { [method]: entryCount },
        tags: Array.isArray(entry.tags) ? Array.from(new Set(entry.tags)) : [],
        score: entry.score || 0,
      });
      continue;
    }

    const record = patterns.get(patternId);
    record.countTotal += entryCount;
    record.uniqueUrls += 1;
    record.lastSeen = Math.max(record.lastSeen || 0, entry.lastSeen || 0);
    record.firstSeen = Math.min(
      record.firstSeen || entry.firstSeen || Date.now(),
      entry.firstSeen || Date.now()
    );
    record.score = Math.max(record.score || 0, entry.score || 0);
    record.topMethods[method] =
      (record.topMethods[method] || 0) + entryCount;

    if (Array.isArray(entry.tags)) {
      const tagSet = new Set(record.tags || []);
      entry.tags.forEach((tag) => tagSet.add(tag));
      record.tags = Array.from(tagSet);
    }

    if (
      Array.isArray(record.exampleUrls) &&
      record.exampleUrls.length < 5 &&
      !record.exampleUrls.includes(entry.url)
    ) {
      record.exampleUrls.push(entry.url);
    }
  }

  workspace.patterns = patterns;
  workspace.patternIndex = patternIndex;
}

function updatePatternForEntry(workspace, entry, previousEntry, settings) {
  if (!workspace.patterns) workspace.patterns = new Map();
  if (!workspace.patternIndex) workspace.patternIndex = new Map();

  const pattern = generatePattern(entry.normalizedUrl, settings);
  const patternId = hashString(`${entry.workspaceKey}|${pattern}`);
  const previousPatternId = workspace.patternIndex.get(entry.id);
  const previousCount = previousEntry ? previousEntry.count || 0 : 0;
  const delta = (entry.count || 1) - previousCount;

  if (previousPatternId && previousPatternId !== patternId) {
    const previousPattern = workspace.patterns.get(previousPatternId);
    if (previousPattern) {
      previousPattern.countTotal = Math.max(
        0,
        (previousPattern.countTotal || 0) - previousCount
      );
      previousPattern.uniqueUrls = Math.max(
        0,
        (previousPattern.uniqueUrls || 0) - 1
      );
      if (previousEntry && previousPattern.topMethods) {
        const method = (previousEntry.method || "GET").toUpperCase();
        if (previousPattern.topMethods[method] != null) {
          previousPattern.topMethods[method] -= previousCount;
          if (previousPattern.topMethods[method] <= 0) {
            delete previousPattern.topMethods[method];
          }
        }
      }
      if (previousEntry && Array.isArray(previousPattern.exampleUrls)) {
        previousPattern.exampleUrls = previousPattern.exampleUrls.filter(
          (url) => url !== previousEntry.url
        );
      }
      if ((previousPattern.uniqueUrls || 0) <= 0) {
        workspace.patterns.delete(previousPatternId);
      }
    }
  }

  workspace.patternIndex.set(entry.id, patternId);
  const entryCount = entry.count || 1;
  const entryMethod = (entry.method || "GET").toUpperCase();
  let record = workspace.patterns.get(patternId);
  if (!record) {
    record = {
      id: patternId,
      workspaceKey: entry.workspaceKey,
      pattern,
      countTotal: entryCount,
      uniqueUrls: 1,
      lastSeen: entry.lastSeen,
      firstSeen: entry.firstSeen,
      exampleUrls: [entry.url],
      topMethods: { [entryMethod]: entryCount },
      tags: Array.isArray(entry.tags) ? Array.from(new Set(entry.tags)) : [],
      score: entry.score || 0,
    };
    workspace.patterns.set(patternId, record);
    return;
  }

  if (previousPatternId === patternId) {
    if (delta > 0) {
      record.countTotal = (record.countTotal || 0) + delta;
    }
  } else {
    record.countTotal = (record.countTotal || 0) + entryCount;
    record.uniqueUrls = (record.uniqueUrls || 0) + 1;
  }

  record.lastSeen = Math.max(record.lastSeen || 0, entry.lastSeen || 0);
  record.firstSeen = Math.min(
    record.firstSeen || entry.firstSeen || Date.now(),
    entry.firstSeen || Date.now()
  );
  record.score = Math.max(record.score || 0, entry.score || 0);

  if (!record.topMethods) record.topMethods = {};
  const methodDelta = previousPatternId === patternId ? Math.max(delta, 0) : entryCount;
  record.topMethods[entryMethod] =
    (record.topMethods[entryMethod] || 0) + methodDelta;

  if (Array.isArray(entry.tags)) {
    const tagSet = new Set(record.tags || []);
    entry.tags.forEach((tag) => tagSet.add(tag));
    record.tags = Array.from(tagSet);
  }

  if (!record.exampleUrls) record.exampleUrls = [];
  if (
    record.exampleUrls.length < 5 &&
    !record.exampleUrls.includes(entry.url)
  ) {
    record.exampleUrls.push(entry.url);
  }
}

function ensurePatterns(workspace, workspaceKey, settings) {
  if (!workspace) return;
  if (!workspace.entries || workspace.entries.size === 0) {
    workspace.patterns = workspace.patterns || new Map();
    workspace.patternIndex = workspace.patternIndex || new Map();
    workspace.patternsBuilt = true;
    return;
  }

  if (!workspace.patternsBuilt || !workspace.patterns || workspace.patterns.size === 0) {
    buildPatternsFromEntries(workspace, settings);
    workspace.patternsBuilt = true;
    scheduleSave(workspaceKey);
    return;
  }

  if (!workspace.patternIndex || workspace.patternIndex.size === 0) {
    buildPatternsFromEntries(workspace, settings);
    workspace.patternsBuilt = true;
    scheduleSave(workspaceKey);
  }
}

async function loadWorkspace(workspaceKey) {
  if (workspaceCache.has(workspaceKey)) {
    return workspaceCache.get(workspaceKey);
  }
  const data = await chrome.storage.local.get(
    WORKSPACE_PREFIX + workspaceKey
  );
  const stored = data[WORKSPACE_PREFIX + workspaceKey];
  const entries = new Map();
  if (stored && Array.isArray(stored.entries)) {
    for (const entry of stored.entries) {
      entries.set(entry.id, entry);
    }
  }
  const patterns = new Map();
  let patternsBuilt = false;
  if (stored && Array.isArray(stored.patterns)) {
    patternsBuilt = true;
    for (const pattern of stored.patterns) {
      patterns.set(pattern.id, pattern);
    }
  }
  const findings = new Map();
  if (stored && Array.isArray(stored.findings)) {
    for (const finding of stored.findings) {
      if (finding && finding.id) findings.set(finding.id, finding);
    }
  }
  const workspace = {
    entries,
    patterns,
    patternIndex: new Map(),
    patternsBuilt,
    findings,
  };
  workspaceCache.set(workspaceKey, workspace);
  return workspace;
}

function scheduleSave(workspaceKey) {
  if (saveTimers.has(workspaceKey)) return;
  const timer = setTimeout(async () => {
    saveTimers.delete(workspaceKey);
    await saveWorkspace(workspaceKey);
  }, SAVE_DEBOUNCE_MS);
  saveTimers.set(workspaceKey, timer);
}

const notifyTimers = new Map();

function emitMessage(message) {
  try {
    chrome.runtime.sendMessage(message, () => {
      // Popup may be closed; reading lastError prevents "Unchecked runtime.lastError" noise.
      void chrome.runtime.lastError;
    });
  } catch (error) {
    // Service worker context can be torn down mid-send; ignore.
  }
}

function notifyWorkspace(workspaceKey) {
  const now = Date.now();
  const last = lastNotify.get(workspaceKey) || 0;
  if (now - last >= 500) {
    lastNotify.set(workspaceKey, now);
    emitMessage({ type: "pm_workspace_updated", workspaceKey });
    return;
  }
  // Within the throttle window: guarantee a trailing notification so the popup
  // never misses the final state of a burst of updates.
  if (notifyTimers.has(workspaceKey)) return;
  const wait = 500 - (now - last);
  const timer = setTimeout(() => {
    notifyTimers.delete(workspaceKey);
    lastNotify.set(workspaceKey, Date.now());
    emitMessage({ type: "pm_workspace_updated", workspaceKey });
  }, wait);
  notifyTimers.set(workspaceKey, timer);
}

async function saveWorkspace(workspaceKey) {
  const workspace = workspaceCache.get(workspaceKey);
  if (!workspace) return;
  const entries = Array.from(workspace.entries.values());
  if (entries.length > MAX_ENTRIES) {
    entries.sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      return a.lastSeen - b.lastSeen;
    });
    const toRemove = entries.length - MAX_ENTRIES;
    for (let i = 0; i < toRemove; i++) {
      workspace.entries.delete(entries[i].id);
    }
  }
  const patterns = Array.from((workspace.patterns || new Map()).values());
  if (patterns.length > MAX_PATTERNS) {
    patterns.sort((a, b) => {
      if (a.countTotal !== b.countTotal) return a.countTotal - b.countTotal;
      return a.lastSeen - b.lastSeen;
    });
    const toRemove = patterns.length - MAX_PATTERNS;
    for (let i = 0; i < toRemove; i++) {
      workspace.patterns.delete(patterns[i].id);
    }
  }
  const findings = Array.from((workspace.findings || new Map()).values());
  if (findings.length > MAX_FINDINGS) {
    findings.sort((a, b) => (a.lastSeen || 0) - (b.lastSeen || 0));
    const toRemove = findings.length - MAX_FINDINGS;
    for (let i = 0; i < toRemove; i++) {
      workspace.findings.delete(findings[i].id);
    }
  }
  await chrome.storage.local.set({
    [WORKSPACE_PREFIX + workspaceKey]: {
      entries: Array.from(workspace.entries.values()),
      patterns: Array.from((workspace.patterns || new Map()).values()),
      findings: Array.from((workspace.findings || new Map()).values()),
    },
  });
  refreshBadgeForWorkspace(workspaceKey);
}

async function upsertEntry(input, options = {}) {
  const settings = await ensureSettings();
  const workspaceKey = input.workspaceKey || getWorkspaceKey(input.url);
  const origin = input.origin || getOrigin(input.url);
  const rawUrl = input.url;
  const storedUrl = settings.storeRawUrls ? rawUrl : redactUrl(rawUrl);
  const normalizedUrl = normalizeUrl(storedUrl);
  const method = (input.method || "GET").toUpperCase();

  const baseEntry = {
    workspaceKey,
    origin,
    url: storedUrl,
    normalizedUrl,
    method,
    status: input.status ?? null,
    contentType: input.contentType ?? null,
    size: input.size ?? null,
    durationMs: input.durationMs ?? null,
    source: input.source || "passive_network",
    initiator: input.initiator ?? null,
    tabId: input.tabId ?? null,
    frameId: input.frameId ?? null,
  };

  const scored = scoreEndpoint(baseEntry);
  baseEntry.score = scored.score;
  const extraTags = Array.isArray(input.tags) ? input.tags : [];
  baseEntry.tags = Array.from(new Set([...scored.tags, ...extraTags]));
  baseEntry.openapiCandidate = scored.openapiCandidate;
  baseEntry.graphqlCandidate = scored.graphqlCandidate;

  const id = hashString(`${workspaceKey}|${normalizedUrl}|${method}`);
  const workspace = await loadWorkspace(workspaceKey);
  const now = Date.now();
  const previousEntry = workspace.entries.get(id) || null;

  if (workspace.entries.has(id)) {
    const existing = workspace.entries.get(id);
    const merged = {
      ...existing,
      ...baseEntry,
      id,
      firstSeen: existing.firstSeen,
      lastSeen: now,
      count: (existing.count || 1) + 1,
    };
    workspace.entries.set(id, merged);
  } else {
    workspace.entries.set(id, {
      ...baseEntry,
      id,
      firstSeen: now,
      lastSeen: now,
      count: 1,
    });
  }

  const entry = workspace.entries.get(id);
  updatePatternForEntry(workspace, entry, previousEntry, settings);

  scheduleSave(workspaceKey);
  if (!options.silent) {
    notifyWorkspace(workspaceKey);
  }
}

function extractUrlsFromHtml(html, baseUrl) {
  const results = [];
  const seen = new Set();
  const pushResult = (url, method) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    results.push({ url, method });
  };

  const attrRegex =
    /<(a|link|script)\b[^>]*(href|src)\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = attrRegex.exec(html))) {
    pushResult(match[3], "GET");
  }

  const formRegex = /<form\b[^>]*>/gi;
  while ((match = formRegex.exec(html))) {
    const tag = match[0];
    const actionMatch = tag.match(/action\s*=\s*["']([^"']+)["']/i);
    const methodMatch = tag.match(/method\s*=\s*["']([^"']+)["']/i);
    if (actionMatch) {
      const method = methodMatch ? methodMatch[1].toUpperCase() : "GET";
      pushResult(actionMatch[1], method);
    }
  }

  const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  while ((match = scriptRegex.exec(html))) {
    const scriptContent = match[1] || "";
    const fetchRegex =
      /fetch\s*\(\s*["'`]([^"'`]+)["'`]\s*(?:,\s*{[^}]*method\s*:\s*["'`]?([A-Za-z]+)["'`]?)?/gi;
    let fetchMatch;
    while ((fetchMatch = fetchRegex.exec(scriptContent))) {
      pushResult(fetchMatch[1], (fetchMatch[2] || "GET").toUpperCase());
    }

    const axiosRegex =
      /axios\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/gi;
    let axiosMatch;
    while ((axiosMatch = axiosRegex.exec(scriptContent))) {
      pushResult(axiosMatch[2], axiosMatch[1].toUpperCase());
    }

    const pathRegex = /["'`](\/[a-zA-Z0-9_?&=/#.~%-]+)["'`]/g;
    let pathMatch;
    while ((pathMatch = pathRegex.exec(scriptContent))) {
      pushResult(pathMatch[1], "GET");
    }
  }

  return results
    .map((item) => {
      try {
        const resolved = new URL(item.url, baseUrl).href;
        if (!resolved.startsWith("http")) return null;
        return { url: resolved, method: item.method || "GET" };
      } catch (error) {
        return null;
      }
    })
    .filter(Boolean);
}

async function crawlPage(state, targetUrl, depth) {
  if (state.stopped) return;
  if (state.pagesCrawled >= state.maxPages) return;

  const controller = new AbortController();
  state.controllers.add(controller);
  const start = Date.now();
  try {
    const response = await fetch(targetUrl, {
      method: "GET",
      credentials: "omit",
      signal: controller.signal,
    });
    const durationMs = Date.now() - start;
    state.pagesCrawled += 1;

    const contentType = response.headers.get("content-type");
    const contentLength = response.headers.get("content-length");

    await upsertEntry({
      url: targetUrl,
      method: "GET",
      status: response.status,
      contentType: contentType,
      size: contentLength ? Number(contentLength) : null,
      durationMs,
      source: "active_crawl",
      workspaceKey: state.workspaceKey,
      origin: state.origin,
    });

    if (!contentType || !contentType.includes("text/html")) return;
    const html = await response.text();
    const extracted = extractUrlsFromHtml(html, targetUrl);

    for (const item of extracted) {
      if (state.stopped) return;
      const normalized = normalizeUrl(item.url);
      if (!normalized.startsWith(state.origin)) continue;
      if (state.visited.has(normalized)) continue;
      state.visited.add(normalized);

      await upsertEntry({
        url: item.url,
        method: item.method || "GET",
        status: null,
        contentType: null,
        size: null,
        durationMs: null,
        source: "active_crawl",
        workspaceKey: state.workspaceKey,
        origin: state.origin,
      });

      if (depth + 1 <= state.depth && state.queue.length < state.maxPages) {
        state.queue.push({ url: item.url, depth: depth + 1 });
      }
    }
  } catch (error) {
    state.pagesCrawled += 1;
  } finally {
    state.controllers.delete(controller);
  }
}

async function startCrawl(options) {
  const settings = await ensureSettings();
  if (!settings.activeEnabled) {
    return { ok: false, error: "Active mode disabled." };
  }

  const workspaceKey = options.workspaceKey;
  const origin = options.origin;
  if (!workspaceKey || !origin) {
    return { ok: false, error: "Missing workspace or origin." };
  }

  if (crawlStates.has(workspaceKey) && crawlStates.get(workspaceKey).running) {
    return { ok: false, error: "Crawl already running." };
  }

  const state = {
    running: true,
    stopped: false,
    workspaceKey,
    origin,
    depth: options.depth ?? settings.activeDepth,
    maxPages: options.maxPages ?? settings.activeMaxPages,
    delayMs: settings.activeDelayMs,
    concurrency: settings.activeConcurrency,
    queue: [],
    visited: new Set(),
    pagesCrawled: 0,
    controllers: new Set(),
    activeWorkers: 0,
  };

  const seed = normalizeUrl(options.seed || origin);
  state.queue.push({ url: seed, depth: 0 });
  state.visited.add(seed);
  crawlStates.set(workspaceKey, state);

  for (let i = 0; i < state.concurrency; i++) {
    runCrawlWorker(state);
  }

  emitMessage({ type: "pm_crawl_update", workspaceKey });
  return { ok: true };
}

async function runCrawlWorker(state) {
  state.activeWorkers += 1;
  while (state.running && !state.stopped) {
    const next = state.queue.shift();
    if (!next) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (state.pagesCrawled >= state.maxPages) break;
      if (state.queue.length === 0) break;
      continue;
    }
    if (state.pagesCrawled >= state.maxPages) break;
    await crawlPage(state, next.url, next.depth);
    emitMessage({ type: "pm_crawl_update", workspaceKey: state.workspaceKey });
    await new Promise((resolve) => setTimeout(resolve, state.delayMs));
  }
  state.activeWorkers -= 1;
  if (state.activeWorkers <= 0) {
    state.running = false;
    emitMessage({ type: "pm_crawl_update", workspaceKey: state.workspaceKey });
  }
}

function stopCrawl(workspaceKey) {
  const state = crawlStates.get(workspaceKey);
  if (!state) return { ok: false, error: "No crawl running." };
  state.stopped = true;
  for (const controller of state.controllers) {
    controller.abort();
  }
  return { ok: true };
}

async function parseOpenApi(url, workspaceKey, origin) {
  try {
    const response = await fetch(url, { credentials: "omit" });
    if (!response.ok) {
      return { ok: false, error: `OpenAPI fetch failed (${response.status}).` };
    }
    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();
    if (contentType.includes("yaml") || text.trim().startsWith("openapi:")) {
      return { ok: false, error: "YAML not supported." };
    }

    const spec = JSON.parse(text);
    const paths = spec.paths || {};
    const baseUrl = (() => {
      if (spec.servers && spec.servers.length) {
        try {
          return new URL(spec.servers[0].url, origin || url).href;
        } catch (error) {
          return origin || getOrigin(url);
        }
      }
      if (spec.basePath) {
        return (origin || getOrigin(url)) + spec.basePath;
      }
      return origin || getOrigin(url);
    })();

    let added = 0;
    for (const [path, methods] of Object.entries(paths)) {
      if (!methods) continue;
      for (const method of Object.keys(methods)) {
        const upperMethod = method.toUpperCase();
        if (!/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/.test(upperMethod)) {
          continue;
        }
        let resolved;
        try {
          resolved = new URL(path, baseUrl).href;
        } catch (error) {
          continue;
        }
        if (workspaceKey && getWorkspaceKey(resolved) !== workspaceKey) {
          continue;
        }
        await upsertEntry({
          url: resolved,
          method: upperMethod,
          status: null,
          contentType: null,
          size: null,
          durationMs: null,
          source: "openapi",
          tags: ["docs"],
          workspaceKey,
          origin,
        });
        added += 1;
      }
    }
    return { ok: true, added };
  } catch (error) {
    return { ok: false, error: "Failed to parse OpenAPI spec." };
  }
}

async function addGraphqlGuesses(origin, workspaceKey) {
  if (!origin) {
    return { ok: false, error: "Missing origin." };
  }
  const guesses = [
    "/graphql",
    "/api/graphql",
    "/v1/graphql",
    "/v2/graphql",
    "/graphql/",
  ];
  let added = 0;
  for (const path of guesses) {
    try {
      const resolved = new URL(path, origin).href;
      await upsertEntry({
        url: resolved,
        method: "POST",
        status: null,
        contentType: null,
        size: null,
        durationMs: null,
        source: "guess",
        tags: ["graphql", "guess"],
        workspaceKey,
        origin,
      });
      added += 1;
    } catch (error) {
      continue;
    }
  }
  return { ok: true, added };
}

async function introspectGraphql(url, workspaceKey, origin) {
  const settings = await ensureSettings();
  if (!settings.allowGraphqlChecks) {
    return { ok: false, error: "GraphQL checks disabled." };
  }
  if (!url || !url.startsWith("http")) {
    return { ok: false, error: "Invalid GraphQL URL." };
  }
  const query = {
    query:
      "query IntrospectionQuery{__schema{queryType{name}mutationType{name}subscriptionType{name}}}",
  };
  const start = Date.now();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(query),
      credentials: "omit",
    });
    const durationMs = Date.now() - start;
    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();
    let introspectionEnabled = false;
    try {
      const json = JSON.parse(text);
      introspectionEnabled = Boolean(json && json.data && json.data.__schema);
    } catch (error) {
      introspectionEnabled = false;
    }

    await upsertEntry({
      url,
      method: "POST",
      status: response.status,
      contentType,
      size: text.length,
      durationMs,
      source: "graphql_check",
      tags: ["graphql"],
      workspaceKey,
      origin,
    });

    return { ok: true, enabled: introspectionEnabled };
  } catch (error) {
    return { ok: false, error: "GraphQL introspection failed." };
  }
}

async function ingestScanPaths(items, workspaceKey, origin) {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: true, added: 0 };
  }
  const seen = new Set();
  let added = 0;
  let derivedKey = workspaceKey || null;
  for (const item of items) {
    const url = item && item.url;
    if (!url || !/^https?:/i.test(url)) continue;
    if (url.startsWith("chrome-extension://")) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    if (!derivedKey) derivedKey = getWorkspaceKey(url);
    await upsertEntry(
      {
        url,
        method: item.method || "GET",
        status: null,
        contentType: null,
        size: null,
        durationMs: null,
        source: item.source || "page_scan",
        tags: Array.isArray(item.tags) ? item.tags : ["scan"],
        workspaceKey,
        origin,
      },
      { silent: true }
    );
    added += 1;
  }
  if (added && derivedKey) {
    notifyWorkspace(derivedKey);
  }
  return { ok: true, added };
}

// Store only finding metadata (type, source, masked preview) — never the raw secret.
async function ingestFindings(items, workspaceKey) {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: true, added: 0 };
  }
  let derivedKey = workspaceKey || null;
  if (!derivedKey && items[0] && items[0].source) {
    derivedKey = getWorkspaceKey(items[0].source);
  }
  if (!derivedKey) return { ok: true, added: 0 };

  const workspace = await loadWorkspace(derivedKey);
  if (!workspace.findings) workspace.findings = new Map();
  const now = Date.now();
  let added = 0;
  for (const item of items) {
    if (!item || !item.type) continue;
    const type = String(item.type).slice(0, 40);
    const source = typeof item.source === "string" ? item.source.slice(0, 300) : "";
    const preview = typeof item.preview === "string" ? item.preview.slice(0, 60) : "";
    const id = hashString(`${type}|${source}|${preview}`);
    const existing = workspace.findings.get(id);
    if (existing) {
      existing.count = (existing.count || 1) + 1;
      existing.lastSeen = now;
      continue;
    }
    workspace.findings.set(id, {
      id,
      type,
      source,
      preview,
      severity: item.severity === "high" || item.severity === "low" ? item.severity : "medium",
      count: 1,
      firstSeen: now,
      lastSeen: now,
    });
    added += 1;
  }
  if (added) {
    scheduleSave(derivedKey);
    notifyWorkspace(derivedKey);
  }
  return { ok: true, added };
}

async function clearWorkspace(workspaceKey) {
  if (!workspaceKey) {
    return { ok: false, error: "No workspace." };
  }
  if (saveTimers.has(workspaceKey)) {
    clearTimeout(saveTimers.get(workspaceKey));
    saveTimers.delete(workspaceKey);
  }
  const workspace = await loadWorkspace(workspaceKey);
  workspace.entries = new Map();
  workspace.patterns = new Map();
  workspace.patternIndex = new Map();
  workspace.findings = new Map();
  workspace.patternsBuilt = true;
  await chrome.storage.local.remove(WORKSPACE_PREFIX + workspaceKey);
  notifyWorkspace(workspaceKey);
  refreshBadgeForWorkspace(workspaceKey);
  return { ok: true };
}

/* ---------- Toolbar badge (high-value count for the active tab's host) ---------- */

function countHighValue(workspace) {
  if (!workspace || !workspace.entries) return 0;
  const seen = new Set();
  let count = 0;
  for (const entry of workspace.entries.values()) {
    if ((entry.score || 0) < HIGH_VALUE_SCORE) continue;
    const key = entry.normalizedUrl || entry.url;
    if (seen.has(key)) continue;
    seen.add(key);
    count += 1;
  }
  return count;
}

async function updateBadgeForTab(tabId, url) {
  if (typeof tabId !== "number") return;
  try {
    if (!url || !/^https?:/i.test(url)) {
      chrome.action.setBadgeText({ tabId, text: "" });
      return;
    }
    const workspace = await loadWorkspace(getWorkspaceKey(url));
    const high = countHighValue(workspace);
    const text = high <= 0 ? "" : high > 99 ? "99+" : String(high);
    chrome.action.setBadgeText({ tabId, text });
  } catch (error) {
    // Tab may be gone; ignore.
  }
}

function refreshBadgeForWorkspace(workspaceKey) {
  try {
    chrome.tabs.query({}, (tabs) => {
      void chrome.runtime.lastError;
      if (!tabs) return;
      for (const tab of tabs) {
        if (getWorkspaceKey(tab.url || "") === workspaceKey) {
          updateBadgeForTab(tab.id, tab.url);
        }
      }
    });
  } catch (error) {
    // ignore
  }
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!settingsCache.passiveEnabled) return;
    if (!details.url.startsWith("http")) return;
    if (details.url.startsWith("chrome-extension://")) return;
    requestMeta.set(details.requestId, {
      start: Date.now(),
      method: details.method,
      url: details.url,
      tabId: details.tabId,
      frameId: details.frameId,
      initiator: details.initiator || null,
    });
  },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onCompleted.addListener(
  async (details) => {
    if (!settingsCache.passiveEnabled) return;
    if (!details.url.startsWith("http")) return;
    if (details.url.startsWith("chrome-extension://")) return;
    const meta = requestMeta.get(details.requestId);
    requestMeta.delete(details.requestId);

    const headers = details.responseHeaders || [];
    const contentTypeHeader = headers.find(
      (header) => header.name.toLowerCase() === "content-type"
    );
    const lengthHeader = headers.find(
      (header) => header.name.toLowerCase() === "content-length"
    );
    const durationMs = meta ? Date.now() - meta.start : null;

    await upsertEntry({
      url: details.url,
      method: details.method,
      status: details.statusCode,
      contentType: contentTypeHeader ? contentTypeHeader.value : null,
      size: lengthHeader ? Number(lengthHeader.value) : null,
      durationMs,
      source: "passive_network",
      initiator: meta ? meta.initiator : details.initiator,
      tabId: details.tabId,
      frameId: details.frameId,
    });
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

chrome.webRequest.onErrorOccurred.addListener(
  async (details) => {
    if (!settingsCache.passiveEnabled) return;
    if (!details.url.startsWith("http")) return;
    if (details.url.startsWith("chrome-extension://")) return;
    const meta = requestMeta.get(details.requestId);
    requestMeta.delete(details.requestId);
    const durationMs = meta ? Date.now() - meta.start : null;
    await upsertEntry({
      url: details.url,
      method: details.method,
      status: null,
      contentType: null,
      size: null,
      durationMs,
      source: "passive_network",
      initiator: meta ? meta.initiator : details.initiator,
      tabId: details.tabId,
      frameId: details.frameId,
    });
  },
  { urls: ["<all_urls>"] }
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  if (message.type === "pm_get_state") {
    (async () => {
      const settings = await ensureSettings();
      const workspaceKey = message.workspaceKey;
      const workspace = workspaceKey ? await loadWorkspace(workspaceKey) : null;
      if (workspace && workspaceKey) {
        ensurePatterns(workspace, workspaceKey, settings);
      }
      const crawlState = workspaceKey ? crawlStates.get(workspaceKey) : null;
      const crawl = crawlState
        ? {
            running: crawlState.running,
            stopped: crawlState.stopped,
            pagesCrawled: crawlState.pagesCrawled,
            maxPages: crawlState.maxPages,
            queueSize: crawlState.queue.length,
            visitedCount: crawlState.visited.size,
          }
        : null;
      sendResponse({
        ok: true,
        settings,
        workspace: workspace
          ? {
              entries: Array.from(workspace.entries.values()),
              patterns: Array.from((workspace.patterns || new Map()).values()),
              findings: Array.from((workspace.findings || new Map()).values()),
            }
          : { entries: [], patterns: [], findings: [] },
        crawl,
      });
    })();
    return true;
  }

  if (message.type === "pm_update_settings") {
    saveSettings(message.settings || {}).then((settings) =>
      sendResponse({ ok: true, settings })
    );
    return true;
  }

  if (message.type === "pm_start_crawl") {
    startCrawl(message).then((result) => sendResponse(result));
    return true;
  }

  if (message.type === "pm_stop_crawl") {
    sendResponse(stopCrawl(message.workspaceKey));
    return true;
  }

  if (message.type === "pm_parse_openapi") {
    parseOpenApi(message.url, message.workspaceKey, message.origin).then(
      (result) => sendResponse(result)
    );
    return true;
  }

  if (message.type === "pm_graphql_guess") {
    addGraphqlGuesses(message.origin, message.workspaceKey).then((result) =>
      sendResponse(result)
    );
    return true;
  }

  if (message.type === "pm_graphql_introspect") {
    introspectGraphql(message.url, message.workspaceKey, message.origin).then(
      (result) => sendResponse(result)
    );
    return true;
  }

  if (message.type === "pm_scan_paths") {
    ingestScanPaths(message.items, message.workspaceKey, message.origin).then(
      (result) => sendResponse(result)
    );
    return true;
  }

  if (message.type === "pm_scan_findings") {
    ingestFindings(message.items, message.workspaceKey).then((result) =>
      sendResponse(result)
    );
    return true;
  }

  if (message.type === "pm_clear_workspace") {
    clearWorkspace(message.workspaceKey).then((result) => sendResponse(result));
    return true;
  }

  if (message.type === "pm_hook_event") {
    (async () => {
      // Only accept hook events relayed by our own content-script bridge in a tab.
      if (!sender || sender.id !== chrome.runtime.id || !sender.tab) {
        sendResponse({ ok: false, error: "Untrusted sender." });
        return;
      }
      const payload = message.payload || {};
      const url = payload.url || "";
      if (!/^https?:/i.test(url)) {
        sendResponse({ ok: false, error: "Invalid URL." });
        return;
      }
      if (url.startsWith("chrome-extension://")) {
        sendResponse({ ok: false, error: "Extension URL ignored." });
        return;
      }
      await upsertEntry({
        url,
        method: payload.method || "GET",
        status: null,
        contentType: null,
        size: null,
        durationMs: null,
        source: "page_hook",
        initiator: "page_hook",
        tabId: sender && sender.tab ? sender.tab.id : null,
        frameId: sender ? sender.frameId : null,
      });
      sendResponse({ ok: true });
    })();
    return true;
  }

  return false;
});

chrome.runtime.onSuspend.addListener(() => {
  for (const workspaceKey of workspaceCache.keys()) {
    saveWorkspace(workspaceKey);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[SETTINGS_KEY]) {
    settingsCache = {
      ...DEFAULT_SETTINGS,
      ...(changes[SETTINGS_KEY].newValue || {}),
    };
    settingsLoaded = true;
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, (tab) => {
    void chrome.runtime.lastError;
    if (tab) updateBadgeForTab(tabId, tab.url);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" || changeInfo.url) {
    updateBadgeForTab(tabId, tab && tab.url);
  }
});

function initBadge() {
  try {
    chrome.action.setBadgeBackgroundColor({ color: "#1f6feb" });
    if (chrome.action.setBadgeTextColor) {
      chrome.action.setBadgeTextColor({ color: "#ffffff" });
    }
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      void chrome.runtime.lastError;
      if (tabs && tabs[0]) updateBadgeForTab(tabs[0].id, tabs[0].url);
    });
  } catch (error) {
    // ignore
  }
}

ensureSettings();
initBadge();
