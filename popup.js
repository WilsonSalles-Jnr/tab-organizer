const $ = (selector) => document.querySelector(selector);
const send = (type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra });

function setStatus(message, isError = false) {
  const el = $("#status");
  el.textContent = message || "";
  el.classList.toggle("error", isError);
}

async function runAction(type, extra = {}, successMessage) {
  try {
    const response = await send(type, extra);
    if (!response?.ok) throw new Error(response?.error || "Não foi possível concluir a ação.");
    if (successMessage) setStatus(typeof successMessage === "function" ? successMessage(response.result) : successMessage);
    await refresh();
    return response.result;
  } catch (error) {
    setStatus(error.message || "Ocorreu um erro.", true);
    return null;
  }
}

async function refresh() {
  try {
    const response = await send("GET_STATUS");
    if (!response.ok) throw new Error(response.error);
    const s = response.result;
    $("#tabCount").textContent = s.totalTabs;
    $("#domainCount").textContent = s.domains;
    $("#groupCount").textContent = s.groups;
    $("#autoToggle").checked = s.autoOrganize;
    $("#duplicateHint").textContent = s.duplicates ? `${s.duplicates} cópia(s) adicional(is) encontrada(s)` : "Detectar URLs repetidas";
    await renderCollections();
    await renderRules();
  } catch (error) {
    setStatus(error.message || "Erro ao carregar o estado.", true);
  }
}

$("#organizeBtn").addEventListener("click", async () => {
  const result = await runAction("ORGANIZE", {}, r => `Organização concluída: ${r.groupedCount} aba(s) agrupada(s), ${r.ungroupedCount} não classificadas.`);
});

$("#refreshBtn").addEventListener("click", refresh);

$("#autoToggle").addEventListener("change", async (event) => {
  await runAction("TOGGLE_AUTO", { value: event.target.checked },
    event.target.checked ? "Organização automática ativada." : "Organização automática desativada.");
});

$("#duplicatesBtn").addEventListener("click", async () => {
  const result = await runAction("FIND_DUPLICATES");
  if (!result) return;
  const area = $("#duplicatesArea");
  area.classList.remove("hidden");
  if (!result.length) {
    area.innerHTML = '<p class="empty">Nenhuma URL duplicada encontrada.</p>';
    return;
  }
  area.replaceChildren();
  for (const group of result) {
    const item = document.createElement("div");
    item.className = "duplicate-item";
    const title = document.createElement("strong");
    title.textContent = group.tabs[0]?.title || group.url;
    const detail = document.createElement("small");
    detail.textContent = `${group.tabs.length} abas com a mesma URL`;
    item.append(title, detail);
    area.append(item);
  }
  setStatus(`${result.length} conjunto(s) de URLs duplicadas encontrado(s).`);
});

$("#closeDuplicatesBtn").addEventListener("click", async () => {
  const result = await runAction("CLOSE_DUPLICATES", {}, r => `${r.closed} aba(s) duplicada(s) fechada(s).`);
  $("#duplicatesArea").classList.add("hidden");
});

$("#saveForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = $("#collectionName").value.trim();
  const result = await runAction("SAVE_COLLECTION", { name }, r => `Coleção "${r.name}" salva com ${r.tabs} aba(s).`);
  if (result) $("#collectionName").value = "";
});

async function renderCollections() {
  const response = await send("GET_COLLECTIONS");
  if (!response.ok) return;
  const list = $("#collectionsList");
  list.replaceChildren();
  if (!response.result.length) {
    list.innerHTML = '<p class="empty">Suas coleções salvas aparecerão aqui.</p>';
    return;
  }
  for (const collection of response.result) {
    const row = document.createElement("div");
    row.className = "collection-item";
    const copy = document.createElement("div");
    copy.className = "item-copy";
    const name = document.createElement("strong");
    name.textContent = collection.name;
    const count = document.createElement("small");
    count.textContent = `${collection.tabs.length} abas · ${new Date(collection.createdAt).toLocaleDateString()}`;
    copy.append(name, count);
    const restore = document.createElement("button");
    restore.className = "small-btn";
    restore.textContent = "Restaurar";
    restore.addEventListener("click", async () => {
      await runAction("RESTORE_COLLECTION", { id: collection.id }, r => `Coleção restaurada: ${r.restored} aba(s).`);
    });
    row.append(copy, restore);
    list.append(row);
  }
}

$("#ruleForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const domain = $("#ruleDomain").value.trim();
  const groupName = $("#ruleName").value.trim();
  const result = await runAction("ADD_RULE", { domain, groupName }, "Regra salva. Organize as abas para aplicá-la agora.");
  if (result) {
    $("#ruleDomain").value = "";
    $("#ruleName").value = "";
  }
});

async function renderRules() {
  const response = await chrome.storage.local.get({ rules: [] });
  const list = $("#rulesList");
  list.replaceChildren();
  if (!response.rules.length) {
    list.innerHTML = '<p class="empty">Sem regras personalizadas. Por padrão, o grupo usa o domínio.</p>';
    return;
  }
  for (const rule of response.rules) {
    const row = document.createElement("div");
    row.className = "rule-item";
    const copy = document.createElement("div");
    copy.className = "item-copy";
    const name = document.createElement("strong");
    name.textContent = rule.groupName;
    const domain = document.createElement("small");
    domain.textContent = rule.domain;
    copy.append(name, domain);
    const remove = document.createElement("button");
    remove.className = "small-btn danger";
    remove.textContent = "Remover";
    remove.addEventListener("click", async () => {
      const result = await runAction("REMOVE_RULE", { domain: rule.domain }, "Regra removida.");
    });
    row.append(copy, remove);
    list.append(row);
  }
}

refresh();