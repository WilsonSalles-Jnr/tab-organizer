const COLORS = [
  "blue", "red", "yellow", "green", "pink",
  "purple", "cyan", "orange"
];
const UNGROUPED_TITLE = "Não classificadas";
const MANAGED_GROUP_PREFIX = "TO:";
const DEFAULTS = {
  autoOrganize: false,
  rules: [],
  collections: []
};

chrome.runtime.onInstalled.addListener(async () => {
  const saved = await chrome.storage.local.get(DEFAULTS);
  await chrome.storage.local.set({
    autoOrganize: saved.autoOrganize ?? false,
    rules: saved.rules ?? [],
    collections: saved.collections ?? []
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      let result;
      switch (message?.type) {
        case "GET_STATUS": result = await getStatus(); break;
        case "ORGANIZE": result = await organizeCurrentWindow(); break;
        case "TOGGLE_AUTO": result = await setAutoOrganize(Boolean(message.value)); break;
        case "GET_COLLECTIONS": result = await getCollections(); break;
        case "SAVE_COLLECTION": result = await saveCollection(message.name); break;
        case "RESTORE_COLLECTION": result = await restoreCollection(message.id); break;
        case "FIND_DUPLICATES": result = await findDuplicates(); break;
        case "CLOSE_DUPLICATES": result = await closeDuplicates(); break;
        case "ADD_RULE": result = await addRule(message.domain, message.groupName); break;
        case "REMOVE_RULE": result = await removeRule(message.domain); break;
        default: throw new Error("Ação desconhecida.");
      }
      sendResponse({ ok: true, result });
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || "Ocorreu um erro." });
    }
  })();
  return true;
});

chrome.tabs.onCreated.addListener(async (tab) => {
  const { autoOrganize = false } = await chrome.storage.local.get("autoOrganize");
  if (autoOrganize && tab.url) await organizeTab(tab.id).catch(() => {});
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== "complete") return;
  const { autoOrganize = false } = await chrome.storage.local.get("autoOrganize");
  if (autoOrganize && tab.url && changeInfo.status === "complete") {
    await organizeTab(tabId).catch(() => {});
  }
});

function getDomain(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    let host = url.hostname.toLowerCase().replace(/^www\./, "");
    // Keep common multi-part public suffixes together without requiring a suffix database.
    const parts = host.split(".");
    const commonSecondLevel = new Set(["com.br", "net.br", "org.br", "gov.br", "co.uk", "com.au", "co.nz", "co.jp", "com.mx", "com.tr"]);
    if (parts.length >= 3 && commonSecondLevel.has(parts.slice(-2).join("."))) {
      return parts.slice(-3).join(".");
    }
    return parts.length > 2 ? parts.slice(-2).join(".") : host;
  } catch {
    return null;
  }
}

function isGroupable(tab) {
  return Boolean(tab && !tab.pinned && !tab.discarded && getDomain(tab.url));
}

async function getRules() {
  const { rules = [] } = await chrome.storage.local.get("rules");
  return rules;
}

function groupNameFor(domain, rules) {
  const match = rules.find(rule => rule.domain.toLowerCase() === domain.toLowerCase());
  return match?.groupName?.trim() || domain;
}

async function organizeCurrentWindow() {
  const win = await chrome.windows.getCurrent();
  const tabs = await chrome.tabs.query({ windowId: win.id });
  const rules = await getRules();
  const buckets = new Map();
  const ungrouped = [];

  for (const tab of tabs) {
    if (tab.id == null || tab.pinned) continue;
    const domain = getDomain(tab.url);
    if (!domain) {
      ungrouped.push(tab.id);
      continue;
    }
    const name = groupNameFor(domain, rules);
    if (!buckets.has(name)) buckets.set(name, []);
    buckets.get(name).push(tab.id);
  }

  let groupedCount = 0;
  for (const [name, tabIds] of buckets) {
    if (tabIds.length === 0) continue;
    const groupId = await chrome.tabs.group({ tabIds });
    await chrome.tabGroups.update(groupId, {
      title: name,
      color: colorForName(name),
      collapsed: false
    });
    groupedCount += tabIds.length;
  }

  // Keep special/internal pages out of domain groups. Do not create an empty group.
  let ungroupedCount = 0;
  if (ungrouped.length) {
    // Existing tabs may still belong to a previous group; Chrome does not support
    // explicitly "ungrouping" via groupId. tabGroups is not needed for this action:
    // tabs.ungroup removes them from their current groups.
    await chrome.tabs.ungroup(ungrouped);
    ungroupedCount = ungrouped.length;
  }

  return { groupedCount, ungroupedCount, domainGroups: buckets.size };
}

async function organizeTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!isGroupable(tab)) {
    if (tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
      await chrome.tabs.ungroup(tabId);
    }
    return { skipped: true };
  }
  const domain = getDomain(tab.url);
  const rules = await getRules();
  const name = groupNameFor(domain, rules);
  const winTabs = await chrome.tabs.query({ windowId: tab.windowId });
  const matching = winTabs.filter(t => t.id !== tabId && !t.pinned &&
    getDomain(t.url) && groupNameFor(getDomain(t.url), rules) === name);
  const ids = [tabId, ...matching.map(t => t.id)];
  const groupId = await chrome.tabs.group({ tabIds: ids });
  await chrome.tabGroups.update(groupId, { title: name, color: colorForName(name) });
}

function colorForName(name) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return COLORS[Math.abs(hash) % COLORS.length];
}

async function getStatus() {
  const win = await chrome.windows.getCurrent();
  const tabs = await chrome.tabs.query({ windowId: win.id });
  const domains = new Set();
  let special = 0;
  let duplicates = 0;
  const seen = new Set();
  for (const tab of tabs) {
    if (tab.pinned) continue;
    const domain = getDomain(tab.url);
    if (domain) domains.add(domain); else special++;
    const key = canonicalUrl(tab.url);
    if (key && seen.has(key)) duplicates++;
    else if (key) seen.add(key);
  }
  const groups = await chrome.tabGroups.query({ windowId: win.id });
  const { autoOrganize = false } = await chrome.storage.local.get("autoOrganize");
  return { totalTabs: tabs.length, domains: domains.size, special, duplicates, groups: groups.length, autoOrganize };
}

function canonicalUrl(raw) {
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    url.hash = "";
    // Treat a trailing slash as equivalent only for the root path.
    return url.href;
  } catch {
    return null;
  }
}

async function findDuplicates() {
  const win = await chrome.windows.getCurrent();
  const tabs = await chrome.tabs.query({ windowId: win.id });
  const map = new Map();
  for (const tab of tabs) {
    const key = canonicalUrl(tab.url);
    if (!key || tab.id == null) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ id: tab.id, title: tab.title || key, url: tab.url, active: tab.active });
  }
  return [...map.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([url, group]) => ({ url, tabs: group, closeIds: group.filter(t => !t.active).slice(1).map(t => t.id) }));
}

async function closeDuplicates() {
  const groups = await findDuplicates();
  const closeIds = [];
  for (const group of groups) {
    // Keep the active tab when possible; otherwise keep the first occurrence.
    const keep = group.tabs.find(t => t.active) || group.tabs[0];
    for (const tab of group.tabs) if (tab.id !== keep.id) closeIds.push(tab.id);
  }
  if (closeIds.length) await chrome.tabs.remove(closeIds);
  return { closed: closeIds.length, groups: groups.length };
}

async function setAutoOrganize(value) {
  await chrome.storage.local.set({ autoOrganize: value });
  return { autoOrganize: value };
}

async function getCollections() {
  const { collections = [] } = await chrome.storage.local.get("collections");
  return collections;
}

async function saveCollection(name) {
  const safeName = String(name || "").trim().slice(0, 60);
  if (!safeName) throw new Error("Informe um nome para a coleção.");
  const win = await chrome.windows.getCurrent();
  const tabs = await chrome.tabs.query({ windowId: win.id });
  const collection = {
    id: crypto.randomUUID(),
    name: safeName,
    createdAt: new Date().toISOString(),
    tabs: tabs.filter(t => t.url && /^https?:/.test(t.url)).map(t => ({
      url: t.url, title: t.title || t.url, domain: getDomain(t.url),
      groupTitle: t.groupId >= 0 ? (undefined) : undefined
    }))
  };
  // Preserve group titles using the native group metadata.
  const groups = await chrome.tabGroups.query({ windowId: win.id });
  const byId = new Map(groups.map(g => [g.id, g.title || "Grupo"]));
  collection.tabs = tabs.filter(t => t.url && /^https?:/.test(t.url)).map(t => ({
    url: t.url,
    title: t.title || t.url,
    domain: getDomain(t.url),
    groupTitle: t.groupId >= 0 ? (byId.get(t.groupId) || null) : null
  }));
  const collections = await getCollections();
  collections.unshift(collection);
  await chrome.storage.local.set({ collections: collections.slice(0, 30) });
  return { id: collection.id, name: collection.name, tabs: collection.tabs.length };
}

async function restoreCollection(id) {
  const collections = await getCollections();
  const collection = collections.find(item => item.id === id);
  if (!collection) throw new Error("Coleção não encontrada.");
  const created = [];
  for (const item of collection.tabs) {
    try {
      const tab = await chrome.tabs.create({ url: item.url, active: false });
      if (tab.id != null) created.push({ id: tab.id, groupTitle: item.groupTitle || item.domain || null });
    } catch { /* Ignore URLs Chrome can no longer open. */ }
  }
  const buckets = new Map();
  for (const tab of created) {
    if (!tab.groupTitle) continue;
    if (!buckets.has(tab.groupTitle)) buckets.set(tab.groupTitle, []);
    buckets.get(tab.groupTitle).push(tab.id);
  }
  for (const [title, ids] of buckets) {
    if (ids.length) {
      const groupId = await chrome.tabs.group({ tabIds: ids });
      await chrome.tabGroups.update(groupId, { title, color: colorForName(title) });
    }
  }
  return { restored: created.length, name: collection.name };
}

async function addRule(domain, groupName) {
  const cleanDomain = String(domain || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  const cleanName = String(groupName || "").trim().slice(0, 50);
  if (!cleanDomain || !cleanName || !/^[a-z0-9.-]+$/.test(cleanDomain)) {
    throw new Error("Informe um domínio válido e um nome de grupo.");
  }
  const rules = await getRules();
  const filtered = rules.filter(rule => rule.domain !== cleanDomain);
  filtered.push({ domain: cleanDomain, groupName: cleanName });
  await chrome.storage.local.set({ rules: filtered });
  return filtered;
}

async function removeRule(domain) {
  const rules = (await getRules()).filter(rule => rule.domain !== domain);
  await chrome.storage.local.set({ rules });
  return rules;
}