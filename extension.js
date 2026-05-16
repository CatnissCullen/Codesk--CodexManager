"use strict";

const vscode = require("vscode");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const VIEW_TYPE = "codesk.main";
const MAX_TITLE_LENGTH = 120;
const VALID_SEARCH_FIELDS = new Set(["title", "id", "cwd", "firstUserMessage", "conversation"]);
const VALID_ARCHIVE_FILTERS = new Set(["active", "archived"]);

let activeProvider = null;
const conversationSearchCache = new Map();
const sessionIndexCache = new Map();
const rolloutAnalysisCache = new Map();

function activate(context) {
  const provider = new TaskManagerViewProvider(context);
  activeProvider = provider;

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codesk.open", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.codesk");
      provider.refreshVisibleViews();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codesk.refresh", () => {
      provider.refreshVisibleViews();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codesk.renameTask", async () => {
      await provider.renameSelectedTask();
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.refreshVisibleViews()),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("codesk.codexHome") ||
        event.affectsConfiguration("codesk.defaultScope")
      ) {
        provider.refreshVisibleViews();
      }
    }),
  );
}

function deactivate() {
  activeProvider = null;
}

class TaskManagerViewProvider {
  constructor(context) {
    this.context = context;
    this.views = new Set();
    this.selectedId = "";
    this.lastScope = "";
  }

  resolveWebviewView(webviewView) {
    this.views.add(webviewView);
    webviewView.onDidDispose(() => this.views.delete(webviewView));

    const webview = webviewView.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    webview.html = getWebviewHtml(webview, this.context.extensionUri);

    webview.onDidReceiveMessage(async (message) => {
      if (!message || typeof message !== "object") {
        return;
      }

      const id = message.id;
      const op = message.op;
      const payload = message.payload || {};
      if (!id || !op) {
        return;
      }

      try {
        const data = await this.handleOperation(op, payload);
        webview.postMessage({ id, ok: true, data });
      } catch (error) {
        webview.postMessage({
          id,
          ok: false,
          error: error?.message || String(error),
        });
      }
    });
  }

  async handleOperation(op, payload) {
    switch (op) {
      case "bootstrap":
        return getBootstrapInfo();
      case "listTasks":
        return listTasks(payload || {});
      case "getTaskDetail":
        return getTaskDetail(payload || {});
      case "setSelectedTask":
        this.selectedId = String(payload.id || "").trim();
        this.lastScope = String(payload.scope || "").trim();
        return { selectedId: this.selectedId };
      case "copyToClipboard":
        return copyToClipboard(payload || {});
      case "openOfficialTask":
        return openOfficialTask(payload || {});
      case "archiveTask":
        return archiveTask(payload || {});
      case "restoreTask":
        return restoreTask(payload || {});
      case "deleteTask":
        return deleteTask(payload || {});
      case "promptRenameTask":
        return this.promptRenameTask(payload || {});
      default:
        throw new Error(`Unknown operation: ${op}`);
    }
  }

  refreshVisibleViews() {
    for (const view of this.views) {
      view.webview.postMessage({ type: "refresh" });
    }
  }

  async renameSelectedTask() {
    if (!this.selectedId) {
      const picked = await pickTaskForRename(this.lastScope || getDefaultScope());
      if (!picked) {
        return;
      }
      this.selectedId = picked.id;
    }

    await this.promptRenameTask({ id: this.selectedId });
    this.refreshVisibleViews();
  }

  async promptRenameTask(payload) {
    const id = String(payload.id || "").trim();
    if (!id) {
      throw new Error("Please select a task first.");
    }

    const task = getTaskById(id);
    const currentTitle = task.title || task.firstUserMessage || task.id;
    const nextTitle = await vscode.window.showInputBox({
      title: "Rename Codex Task",
      prompt: "Enter a new task name.",
      value: currentTitle,
      validateInput: validateTaskTitle,
      ignoreFocusOut: true,
    });

    if (nextTitle === undefined) {
      return { cancelled: true };
    }

    const result = await renameTask(id, nextTitle);
    if (result.rolloutSyncPending) {
      vscode.window.showWarningMessage(`Task renamed: ${result.title}. The conversation is still running; rename it again after completion to sync the official extension title.`);
    } else {
      vscode.window.showInformationMessage(`Renamed Codex task: ${result.title}`);
    }
    return result;
  }
}

function getConfig() {
  const cfg = vscode.workspace.getConfiguration("codesk");
  return {
    codexHome: String(cfg.get("codexHome") || "").trim(),
    defaultScope: normalizeScope(cfg.get("defaultScope") || "project"),
  };
}

function getDefaultScope() {
  return getConfig().defaultScope;
}

function normalizeScope(scope) {
  const value = String(scope || "").trim().toLowerCase();
  if (value === "all") {
    return "all";
  }
  return "project";
}

function resolveCodexHome(configuredHome) {
  if (configuredHome) {
    if (configuredHome === "~") {
      return os.homedir();
    }
    if (configuredHome.startsWith("~/") || configuredHome.startsWith("~\\")) {
      return path.join(os.homedir(), configuredHome.slice(2));
    }
    return configuredHome;
  }
  return path.join(os.homedir(), ".codex");
}

function getCodexPaths() {
  const config = getConfig();
  const codexHome = resolveCodexHome(config.codexHome);
  return {
    ...config,
    codexHome,
    dbPath: path.join(codexHome, "state_5.sqlite"),
    sessionIndexPath: path.join(codexHome, "session_index.jsonl"),
  };
}

function getWorkspaceRoots() {
  return getWorkspaceFolderInfos()
    .map((info) => info.normalized)
    .filter(Boolean);
}

function getWorkspaceFolderInfos() {
  const folders = vscode.workspace.workspaceFolders || [];
  return folders
    .map((folder) => {
      const actual = normalizePathForDisplay(folder.uri.fsPath);
      const normalized = normalizePathForCompare(actual);
      if (!actual || !normalized) {
        return null;
      }
      return {
        actual,
        normalized,
        nameNormalized: path.basename(normalized),
      };
    })
    .filter(Boolean);
}

function getBootstrapInfo() {
  const paths = getCodexPaths();
  const workspaceRoots = getWorkspaceRoots();
  return {
    codexHome: paths.codexHome,
    dbPath: paths.dbPath,
    defaultScope: paths.defaultScope,
    hasWorkspace: workspaceRoots.length > 0,
    workspaceRoots,
    sqliteAvailable: canLoadSqlite(),
  };
}

function canLoadSqlite() {
  try {
    getSqliteModule();
    return true;
  } catch {
    return false;
  }
}

function getSqliteModule() {
  try {
    const sqlite = require("node:sqlite");
    if (!sqlite?.DatabaseSync) {
      throw new Error("node:sqlite does not expose DatabaseSync.");
    }
    return sqlite;
  } catch (error) {
    throw new Error(
      `VS Code runtime does not support node:sqlite (${error?.message || error}). Please use a newer VS Code build.`,
    );
  }
}

function openDb(readOnly = true) {
  const { dbPath } = getCodexPaths();
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Codex sqlite database not found: ${dbPath}`);
  }

  const sqlite = getSqliteModule();
  const db = new sqlite.DatabaseSync(dbPath, { readOnly });
  if (!readOnly) {
    try {
      db.exec("PRAGMA busy_timeout = 1000");
    } catch {
      // Ignore pragma failure and fall back to SQLite defaults.
    }
  }
  return db;
}

function closeDb(db) {
  if (db) {
    db.close();
  }
}

function dbAll(db, sql, params = []) {
  return db.prepare(sql).all(...params);
}

function dbGet(db, sql, params = []) {
  return db.prepare(sql).get(...params);
}

function dbRun(db, sql, params = []) {
  return db.prepare(sql).run(...params);
}

function toIso(value) {
  if (value === null || value === undefined || value === "") {
    return "";
  }
  const num = Number(value);
  if (Number.isFinite(num)) {
    const millis = num > 10_000_000_000 ? num : num * 1000;
    return new Date(millis).toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function normalizePathForCompare(inputPath) {
  const raw = normalizeWindowsNamespacePath(String(inputPath || "").trim());
  if (!raw) {
    return "";
  }

  let normalized = path.resolve(raw).replace(/[\\/]+/g, path.sep);
  while (normalized.length > 1 && /[\\/]$/.test(normalized)) {
    normalized = normalized.slice(0, -1);
  }
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function normalizePathForDisplay(inputPath) {
  const raw = normalizeWindowsNamespacePath(String(inputPath || "").trim());
  if (!raw) {
    return "";
  }

  let normalized = path.resolve(raw).replace(/[\\/]+/g, path.sep);
  while (normalized.length > 1 && /[\\/]$/.test(normalized)) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function normalizeWindowsNamespacePath(inputPath) {
  if (process.platform !== "win32") {
    return inputPath;
  }

  if (inputPath.startsWith("\\\\?\\UNC\\")) {
    return `\\\\${inputPath.slice("\\\\?\\UNC\\".length)}`;
  }
  if (inputPath.startsWith("\\\\?\\")) {
    return inputPath.slice("\\\\?\\".length);
  }
  return inputPath;
}

function isPathInsideAnyRoot(candidatePath, roots) {
  const normalized = normalizePathForCompare(candidatePath);
  if (!normalized || !roots.length) {
    return false;
  }

  return roots.some((root) => {
    if (normalized === root) {
      return true;
    }
    const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    return normalized.startsWith(prefix);
  });
}

function resolveTaskWorkspacePath(cwd, workspaceInfos = null) {
  const normalizedCwd = normalizePathForCompare(cwd);
  const displayCwd = normalizePathForDisplay(cwd);
  const infos = Array.isArray(workspaceInfos) ? workspaceInfos : getWorkspaceFolderInfos();
  if (!normalizedCwd) {
    return {
      cwd: displayCwd,
      projectPath: "",
      remapped: false,
    };
  }

  const directMatch = infos.find((info) => {
    if (normalizedCwd === info.normalized) {
      return true;
    }
    const prefix = info.normalized.endsWith(path.sep) ? info.normalized : `${info.normalized}${path.sep}`;
    return normalizedCwd.startsWith(prefix);
  });
  if (directMatch) {
    return {
      cwd: displayCwd,
      projectPath: directMatch.actual,
      remapped: false,
    };
  }

  const cwdSegments = normalizedCwd.split(path.sep).filter(Boolean);
  let bestMatch = null;
  for (const info of infos) {
    if (!info.nameNormalized) {
      continue;
    }
    for (let index = 0; index < cwdSegments.length; index += 1) {
      if (cwdSegments[index] !== info.nameNormalized) {
        continue;
      }
      const suffixSegments = cwdSegments.slice(index + 1);
      const candidateActual = normalizePathForDisplay(
        suffixSegments.length ? path.join(info.actual, ...suffixSegments) : info.actual,
      );
      if (!candidateActual) {
        continue;
      }
      const candidateExists = fs.existsSync(candidateActual);
      const rootExists = fs.existsSync(info.actual);
      if (!candidateExists && !(rootExists && suffixSegments.length === 0)) {
        continue;
      }
      const score = candidateExists ? 2 : 1;
      const depth = suffixSegments.length;
      if (!bestMatch || score > bestMatch.score || (score === bestMatch.score && depth > bestMatch.depth)) {
        bestMatch = {
          cwd: candidateActual,
          projectPath: info.actual,
          remapped: true,
          score,
          depth,
        };
      }
    }
  }

  if (bestMatch) {
    return {
      cwd: bestMatch.cwd,
      projectPath: bestMatch.projectPath,
      remapped: true,
    };
  }

  return {
    cwd: displayCwd,
    projectPath: "",
    remapped: false,
  };
}

function mapTaskRow(row, sessionNames = null, workspaceInfos = null) {
  const { codexHome } = getCodexPaths();
  const rawRolloutPath = row.rollout_path || "";
  const rolloutPath = resolveExistingRolloutPath(codexHome, rawRolloutPath);
  const cleanId = String(row.id || "").trim();
  const sessionTitle = String(sessionNames?.get(cleanId) || "").trim();
  const dbTitle = String(row.title || "").trim();
  const rolloutFirstUserMessage = readFirstUserMessageFromRollout(rolloutPath);
  const resolvedWorkspacePath = resolveTaskWorkspacePath(row.cwd || "", workspaceInfos);
  return {
    id: row.id || "",
    title: sessionTitle || dbTitle || row.first_user_message || row.id || "",
    rawTitle: dbTitle,
    sessionTitle,
    firstUserMessage: rolloutFirstUserMessage || row.first_user_message || "",
    cwd: resolvedWorkspacePath.cwd || row.cwd || "",
    rawCwd: row.cwd || "",
    projectPath: resolvedWorkspacePath.projectPath || resolvedWorkspacePath.cwd || row.cwd || "",
    rolloutPath,
    rawRolloutPath,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    archived: Number(row.archived || 0) === 1,
  };
}

function escapeRegExp(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildFieldSnippet(text, query, radius = 28) {
  const source = String(text || "");
  const q = String(query || "").trim();
  if (!source || !q) {
    return "";
  }

  const haystack = source.toLowerCase();
  const index = haystack.indexOf(q.toLowerCase());
  if (index === -1) {
    return "";
  }

  const start = Math.max(0, index - radius);
  const end = Math.min(source.length, index + q.length + radius);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < source.length ? "..." : "";
  return `${prefix}${source.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
}

function normalizeSearchText(text) {
  return String(text || "").normalize("NFKC").toLowerCase();
}

function extractConversationSearchText(value, output) {
  if (value === null || value === undefined) {
    return;
  }

  if (typeof value === "string") {
    const text = String(value).replace(/\r/g, "\n").trim();
    if (text) {
      output.push(text);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      extractConversationSearchText(item, output);
    }
    return;
  }

  if (typeof value !== "object") {
    return;
  }

  const itemType = String(value.type || "").trim().toLowerCase();
  if (itemType === "input_text" || itemType === "output_text" || itemType === "summary_text" || itemType === "text") {
    extractConversationSearchText(value.text, output);
    return;
  }

  const preferredKeys = ["text", "content", "message", "body", "output", "input"];
  for (const key of preferredKeys) {
    if (key in value) {
      extractConversationSearchText(value[key], output);
    }
  }
}

function extractVisibleConversationEntry(entry) {
  const type = String(entry?.type || "").trim().toLowerCase();
  const payload = entry?.payload;
  const collected = [];

  if (type === "event_msg") {
    const eventType = String(payload?.type || "").trim().toLowerCase();
    if (eventType === "user_message" || eventType === "agent_message") {
      extractConversationSearchText(payload?.message, collected);
    }
  } else if (type === "response_item") {
    const itemType = String(payload?.type || "").trim().toLowerCase();
    const role = String(payload?.role || "").trim().toLowerCase();
    if (itemType === "message" && (role === "user" || role === "assistant")) {
      extractConversationSearchText(payload?.content, collected);
    }
  }

  return collected
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseConversationSearchEntry(line) {
  if (!line.trim()) {
    return "";
  }

  try {
    const entry = JSON.parse(line);
    return extractVisibleConversationEntry(entry);
  } catch {
    return "";
  }
}

function isEnvironmentContextText(text) {
  const normalized = String(text || "").replace(/\r/g, "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return normalized.startsWith("<environment_context>") && normalized.endsWith("</environment_context>");
}

function getRolloutAnalysis(filePath) {
  const cleanPath = String(filePath || "").trim();
  if (!cleanPath || !fs.existsSync(cleanPath)) {
    return {
      firstUserMessage: "",
      postForkFirstUserMessage: "",
      entries: [],
      mtimeMs: 0,
      size: 0,
    };
  }

  const stat = fs.statSync(cleanPath);
  const cacheKey = normalizePathForCompare(cleanPath) || cleanPath;
  const cached = rolloutAnalysisCache.get(cacheKey);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached;
  }

  let firstUserMessage = "";
  let postForkFirstUserMessage = "";
  const entries = [];
  let isForkedSession = false;
  let passedForkBoundary = false;

  try {
    const content = fs.readFileSync(cleanPath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }

      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (
        entry?.type === "session_meta" &&
        String(entry?.payload?.forked_from_id || "").trim()
      ) {
        isForkedSession = true;
      }

      if (
        isForkedSession &&
        entry?.type === "event_msg" &&
        String(entry?.payload?.type || "").trim().toLowerCase() === "thread_rolled_back"
      ) {
        passedForkBoundary = true;
        continue;
      }

      const text = extractVisibleConversationEntry(entry);
      if (!text || isEnvironmentContextText(text)) {
        continue;
      }

      if (!firstUserMessage) {
        firstUserMessage = text;
      }

      if (
        isForkedSession &&
        passedForkBoundary &&
        !postForkFirstUserMessage &&
        (
          (
            entry?.type === "event_msg" &&
            String(entry?.payload?.type || "").trim().toLowerCase() === "user_message"
          ) ||
          (
            entry?.type === "response_item" &&
            String(entry?.payload?.type || "").trim().toLowerCase() === "message" &&
            String(entry?.payload?.role || "").trim().toLowerCase() === "user"
          )
        )
      ) {
        postForkFirstUserMessage = text;
      }

      entries.push(text);
    }
  } catch {
    firstUserMessage = "";
    postForkFirstUserMessage = "";
    entries.length = 0;
  }

  const analysis = {
    firstUserMessage,
    postForkFirstUserMessage,
    entries,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  };
  rolloutAnalysisCache.set(cacheKey, analysis);
  return analysis;
}

function getConversationSearchData(filePath, query, radius = 36) {
  const cleanPath = String(filePath || "").trim();
  const q = normalizeSearchText(query).trim();
  if (!cleanPath || !q || !fs.existsSync(cleanPath)) {
    return { found: false, snippet: "" };
  }

  const analysis = getRolloutAnalysis(cleanPath);
  const cacheKey = `${normalizePathForCompare(cleanPath) || cleanPath}::conversation::${q}`;
  const cached = conversationSearchCache.get(cacheKey);
  if (cached && cached.mtimeMs === analysis.mtimeMs && cached.size === analysis.size) {
    return { found: cached.found, snippet: cached.snippet };
  }

  let found = false;
  let snippet = "";

  try {
    for (const searchable of analysis.entries) {
      const normalized = normalizeSearchText(searchable);
      const index = normalized.indexOf(q);
      if (index === -1) {
        continue;
      }

      found = true;
      const start = Math.max(0, index - radius);
      const end = Math.min(searchable.length, index + q.length + radius);
      const prefix = start > 0 ? "..." : "";
      const suffix = end < searchable.length ? "..." : "";
      snippet = `${prefix}${searchable.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
      break;
    }
  } catch {
    found = false;
    snippet = "";
  }

  conversationSearchCache.set(cacheKey, {
    mtimeMs: analysis.mtimeMs,
    size: analysis.size,
    found,
    snippet,
  });
  return { found, snippet };
}

function getSessionIndexNames(indexPath) {
  const cleanPath = String(indexPath || "").trim();
  if (!cleanPath || !fs.existsSync(cleanPath)) {
    sessionIndexCache.delete(cleanPath);
    return new Map();
  }

  const stat = fs.statSync(cleanPath);
  const cacheKey = normalizePathForCompare(cleanPath) || cleanPath;
  const cached = sessionIndexCache.get(cacheKey);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.names;
  }

  const names = new Map();
  const content = fs.readFileSync(cleanPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    try {
      const entry = JSON.parse(line);
      const id = String(entry?.id || "").trim();
      const threadName = String(entry?.thread_name || "").trim();
      if (id && threadName) {
        names.set(id, threadName);
      }
    } catch {
      // Ignore malformed lines so one bad record does not break the whole index.
    }
  }

  sessionIndexCache.set(cacheKey, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    names,
  });
  return names;
}

function getAllActiveTasks() {
  const { sessionIndexPath } = getCodexPaths();
  const sessionNames = getSessionIndexNames(sessionIndexPath);
  const workspaceInfos = getWorkspaceFolderInfos();
  const db = openDb(true);
  try {
    return dbAll(
      db,
      `SELECT id, title, first_user_message, cwd, rollout_path, created_at, updated_at, archived
       FROM threads
       ORDER BY updated_at DESC, id DESC`,
      ).map((row) => mapTaskRow(row, sessionNames, workspaceInfos));
  } finally {
    closeDb(db);
  }
}

function reconcileTaskRolloutPaths(tasks) {
  const paths = getCodexPaths();
  const fixes = tasks
    .map((task) => ({
      id: task.id,
      nextStoredPath: toStoredRolloutPath(paths.codexHome, task.rolloutPath),
      currentStoredPath: String(task.rawRolloutPath || ""),
    }))
    .filter((item) => item.nextStoredPath && item.nextStoredPath !== item.currentStoredPath);

  if (!fixes.length) {
    return;
  }

  const db = openDb(false);
  try {
    for (const item of fixes) {
      dbRun(db, "UPDATE threads SET rollout_path = ? WHERE id = ?", [item.nextStoredPath, item.id]);
    }
  } finally {
    closeDb(db);
  }

  for (const task of tasks) {
    const fixed = fixes.find((item) => item.id === task.id);
    if (fixed) {
      task.rawRolloutPath = fixed.nextStoredPath;
    }
  }
}

function normalizeArchiveFilter(value) {
  return VALID_ARCHIVE_FILTERS.has(String(value || "").trim().toLowerCase()) ? String(value).trim().toLowerCase() : "active";
}

function normalizeSearchField(field) {
  const value = String(field || "").trim();
  return VALID_SEARCH_FIELDS.has(value) ? value : "title";
}

function filterTasks(tasks, query, scope, searchFieldRaw, archiveFilterRaw) {
  const workspaceRoots = getWorkspaceRoots();
  const requestedScope = normalizeScope(scope);
  const effectiveScope = requestedScope === "project" && workspaceRoots.length === 0 ? "all" : requestedScope;
  const q = String(query || "").trim().toLowerCase();
  const searchField = normalizeSearchField(searchFieldRaw);
  const archiveFilter = normalizeArchiveFilter(archiveFilterRaw);

  let items = tasks.filter((task) => (archiveFilter === "archived" ? task.archived : !task.archived));
  const totalByArchiveFilter = items.length;
  if (effectiveScope === "project") {
    items = items.filter((task) => isPathInsideAnyRoot(task.cwd, workspaceRoots));
  }

  if (q) {
    items = items
      .map((task) => {
        let matched = false;
        let snippet = "";

        if (searchField === "title") {
          matched = [task.title, task.rawTitle].join("\n").toLowerCase().includes(q);
          snippet = matched ? buildFieldSnippet(task.title || task.rawTitle, q) : "";
        } else if (searchField === "id") {
          matched = String(task.id || "").toLowerCase().includes(q);
          snippet = matched ? buildFieldSnippet(task.id, q) : "";
        } else if (searchField === "cwd") {
          matched = String(task.cwd || "").toLowerCase().includes(q);
          snippet = matched ? buildFieldSnippet(task.cwd, q) : "";
        } else if (searchField === "firstUserMessage") {
          matched = String(task.firstUserMessage || "").toLowerCase().includes(q);
          snippet = matched ? buildFieldSnippet(task.firstUserMessage, q) : "";
        } else {
          const conversationResult = getConversationSearchData(task.rolloutPath, q);
          matched = conversationResult.found;
          snippet = conversationResult.snippet;
        }

        return matched ? { ...task, matchSnippet: snippet } : null;
      })
      .filter(Boolean);
  }

  return {
    requestedScope,
    effectiveScope,
    workspaceRoots,
    searchField,
    archiveFilter,
    totalByArchiveFilter,
    items,
  };
}

function listTasks(payload) {
  const paths = getCodexPaths();
  const scope = normalizeScope(payload.scope || paths.defaultScope);
  const q = String(payload.q || "").trim();
  const searchField = normalizeSearchField(payload.searchField || "title");
  const archiveFilter = normalizeArchiveFilter(payload.archiveFilter || "active");
  const limit = Math.max(20, Math.min(500, Number(payload.limit || 250)));
  const allTasks = getAllActiveTasks();
  reconcileTaskRolloutPaths(allTasks);
  const filtered = filterTasks(allTasks, q, scope, searchField, archiveFilter);
  const items = filtered.items.slice(0, limit);

  return {
    codexHome: paths.codexHome,
    dbPath: paths.dbPath,
    scope: filtered.effectiveScope,
    requestedScope: filtered.requestedScope,
    hasWorkspace: filtered.workspaceRoots.length > 0,
    workspaceRoots: filtered.workspaceRoots,
    searchField: filtered.searchField,
    archiveFilter: filtered.archiveFilter,
    totalAll: allTasks.length,
    totalByArchiveFilter: filtered.totalByArchiveFilter,
    totalFiltered: filtered.items.length,
    limit,
    truncated: filtered.items.length > items.length,
    items,
  };
}

function getTaskById(id) {
  const cleanId = String(id || "").trim();
  if (!cleanId) {
    throw new Error("id is required");
  }

  const { sessionIndexPath } = getCodexPaths();
  const sessionNames = getSessionIndexNames(sessionIndexPath);
  const workspaceInfos = getWorkspaceFolderInfos();
  const db = openDb(true);
  try {
    const row = dbGet(
      db,
      `SELECT id, title, first_user_message, cwd, rollout_path, created_at, updated_at, archived
       FROM threads
       WHERE id = ?`,
      [cleanId],
    );
    if (!row) {
      throw new Error("Task not found.");
    }
    return mapTaskRow(row, sessionNames, workspaceInfos);
  } finally {
    closeDb(db);
  }
}

function readFirstJsonLine(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }

  const fd = fs.openSync(filePath, "r");
  const chunkSize = 64 * 1024;
  const chunks = [];
  let offset = 0;

  try {
    while (true) {
      const buf = Buffer.allocUnsafe(chunkSize);
      const bytesRead = fs.readSync(fd, buf, 0, chunkSize, offset);
      if (bytesRead === 0) {
        break;
      }

      const data = buf.subarray(0, bytesRead);
      const nl = data.indexOf(0x0a);
      if (nl !== -1) {
        let linePart = data.subarray(0, nl);
        if (linePart.length && linePart[linePart.length - 1] === 0x0d) {
          linePart = linePart.subarray(0, linePart.length - 1);
        }
        chunks.push(linePart);
        break;
      }

      chunks.push(data);
      offset += bytesRead;
    }

    const line = Buffer.concat(chunks).toString("utf8").trim();
    if (!line) {
      return null;
    }
    return JSON.parse(line);
  } finally {
    fs.closeSync(fd);
  }
}

function readForkParentId(filePath) {
  try {
    const first = readFirstJsonLine(filePath);
    const forkedFromId = String(first?.payload?.forked_from_id || "").trim();
    return forkedFromId || "";
  } catch {
    return "";
  }
}

function getTaskReferenceById(id) {
  const cleanId = String(id || "").trim();
  if (!cleanId) {
    return null;
  }

  const { sessionIndexPath } = getCodexPaths();
  const sessionNames = getSessionIndexNames(sessionIndexPath);
  const workspaceInfos = getWorkspaceFolderInfos();
  const db = openDb(true);
  try {
    const row = dbGet(
      db,
      `SELECT id, title, first_user_message, cwd, rollout_path, created_at, updated_at, archived
       FROM threads
       WHERE id = ?`,
      [cleanId],
    );
    return row ? mapTaskRow(row, sessionNames, workspaceInfos) : null;
  } finally {
    closeDb(db);
  }
}

function getTaskDetail(payload) {
  const id = String(payload.id || "").trim();
  const task = getTaskById(id);
  const paths = getCodexPaths();
  const db = openDb(false);
  try {
    syncStoredRolloutPathIfNeeded(db, paths.codexHome, task.id, task.rawRolloutPath, task.rolloutPath);
  } finally {
    closeDb(db);
  }
  task.firstUserMessage = readFirstUserMessageFromRollout(task.rolloutPath) || task.firstUserMessage;
  task.postForkFirstUserMessage = "";
  const forkedFromId = readForkParentId(task.rolloutPath);
  if (forkedFromId) {
    task.postForkFirstUserMessage = readPostForkFirstUserMessageFromRollout(task.rolloutPath);
  }
  const parentTask = forkedFromId ? getTaskReferenceById(forkedFromId) : null;

  return {
    task,
    fork: forkedFromId
      ? {
          id: forkedFromId,
          title: parentTask?.title || parentTask?.firstUserMessage || forkedFromId,
          cwd: parentTask?.cwd || "",
          archived: !!parentTask?.archived,
          exists: !!parentTask,
        }
      : null,
  };
}

function validateTaskTitle(value) {
  const title = String(value || "").trim();
  if (!title) {
    return "Task name cannot be empty.";
  }
  if (title.length > MAX_TITLE_LENGTH) {
    return `Task name must be ${MAX_TITLE_LENGTH} characters or fewer.`;
  }
  if (/[\r\n]/.test(title)) {
    return "Task name must be a single line.";
  }
  return null;
}

async function renameTask(id, titleValue) {
  const cleanId = String(id || "").trim();
  const title = String(titleValue || "").trim();
  const validationError = validateTaskTitle(title);
  if (validationError) {
    throw new Error(validationError);
  }

  const paths = getCodexPaths();
  const db = openDb(false);
  let previousTitle = "";
  let previousUpdatedAt = 0;
  let previousUpdatedAtMs = 0;
  let previousStoredRolloutPath = "";
  let rolloutPath = "";
  const updatedAtMs = Date.now();
  const updatedAtSec = Math.floor(updatedAtMs / 1000);
  try {
    const row = dbGet(
      db,
      "SELECT id, title, updated_at, updated_at_ms, rollout_path FROM threads WHERE id = ?",
      [cleanId],
    );
    if (!row) {
      throw new Error("Task not found.");
    }
    previousTitle = String(row.title || "");
    previousUpdatedAt = Number(row.updated_at || 0);
    previousUpdatedAtMs = Number(row.updated_at_ms || 0);
    previousStoredRolloutPath = String(row.rollout_path || "");
    rolloutPath = resolveExistingRolloutPath(paths.codexHome, row.rollout_path || "");
    if (rolloutPath) {
      syncStoredRolloutPathIfNeeded(db, paths.codexHome, cleanId, previousStoredRolloutPath, rolloutPath);
    }

    if (title === previousTitle.trim()) {
      return {
        id: cleanId,
        title: previousTitle,
        updatedAt: toIso(previousUpdatedAt) || new Date().toISOString(),
        unchanged: true,
      };
    }

    dbRun(db, "UPDATE threads SET title = ?, updated_at = ?, updated_at_ms = ? WHERE id = ?", [
      title,
      updatedAtSec,
      updatedAtMs,
      cleanId,
    ]);
  } finally {
    closeDb(db);
  }

  let rolloutSyncPending = false;
  try {
    await updateSessionIndex(paths.sessionIndexPath, cleanId, title, updatedAtSec);
    if (rolloutPath) {
      try {
        await updateRolloutSessionMeta(rolloutPath, cleanId, title, updatedAtMs);
      } catch (error) {
        if (isFileBusyError(error)) {
          rolloutSyncPending = true;
        } else {
          throw error;
        }
      }
    }
  } catch (error) {
    const revertDb = openDb(false);
    try {
      dbRun(
        revertDb,
        "UPDATE threads SET title = ?, updated_at = ?, updated_at_ms = ?, rollout_path = ? WHERE id = ?",
        [
          previousTitle,
          previousUpdatedAt,
          previousUpdatedAtMs,
          previousStoredRolloutPath,
          cleanId,
        ],
      );
    } finally {
      closeDb(revertDb);
    }
    throw new Error(`Renaming sync failed, database change was rolled back: ${error?.message || error}`);
  }

  vscode.commands.executeCommand("chatgpt.openSidebar").catch(() => {
    // Ignore if the official extension/command is unavailable.
  });
  setTimeout(() => {
    vscode.commands.executeCommand("chatgpt.openSidebar").catch(() => {
      // Ignore if the official extension/command is unavailable.
    });
  }, 150);

  return {
    id: cleanId,
    title,
    updatedAt: toIso(updatedAtSec),
    updatedAtSec,
    rolloutSyncPending,
  };
}

async function flushFile(filePath) {
  if (process.platform === "win32") {
    return;
  }

  let handle;
  try {
    handle = await fsp.open(filePath, "r+");
    await handle.sync();
  } catch (error) {
    const code = String(error?.code || "").trim().toUpperCase();
    if (code === "EPERM" || code === "EINVAL" || code === "ENOTSUP" || code === "EBADF") {
      return;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function writeAtomicTextFile(filePath, content) {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });

  const tmpPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await fsp.writeFile(tmpPath, content, "utf8");
  await fsp.rename(tmpPath, filePath);
  await flushFile(filePath);
}

async function readTextFileIfExists(filePath) {
  try {
    return await fsp.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function updateSessionIndex(indexPath, id, title, updatedAtSec) {
  const dir = path.dirname(indexPath);
  await fsp.mkdir(dir, { recursive: true });

  const content = await readTextFileIfExists(indexPath);

  const lines = content ? content.split(/\r?\n/) : [];
  const output = [];
  let found = false;
  const updatedAt = toIso(updatedAtSec) || new Date().toISOString();

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    try {
      const entry = JSON.parse(line);
      if (entry?.id === id) {
        entry.thread_name = title;
        entry.updated_at = updatedAt;
        found = true;
      }
      output.push(JSON.stringify(entry));
    } catch {
      output.push(line);
    }
  }

  if (!found) {
    output.push(JSON.stringify({ id, thread_name: title, updated_at: updatedAt }));
  }

  await writeAtomicTextFile(indexPath, `${output.join(os.EOL)}${os.EOL}`);
  sessionIndexCache.delete(normalizePathForCompare(indexPath) || indexPath);
}

async function updateRolloutSessionMeta(rolloutPath, id, title, updatedAtMs) {
  const cleanPath = String(rolloutPath || "").trim();
  if (!cleanPath || !fs.existsSync(cleanPath)) {
    return;
  }

  const content = await readTextFileIfExists(cleanPath);
  if (!content) {
    return;
  }

  const lines = content.split(/\r?\n/);
  let changed = false;
  let sawSessionMeta = false;
  let sawRenameEvent = false;
  const updatedAtIso = new Date(updatedAtMs).toISOString();
  const output = lines.map((line) => {
    if (!line.trim()) {
      return line;
    }

    try {
      const entry = JSON.parse(line);
      const isSessionMeta = entry?.type === "session_meta";
      const metaId = String(entry?.payload?.id || "").trim();
      if (!isSessionMeta || metaId !== id) {
        return line;
      }

      sawSessionMeta = true;
      entry.timestamp = updatedAtIso;
      entry.payload = {
        ...entry.payload,
        title,
        thread_name: title,
        title_override: title,
        updated_at: updatedAtIso,
        updated_at_ms: updatedAtMs,
      };
      changed = true;
      return JSON.stringify(entry);

      // Unreachable by design.
    } catch {
      return line;
    }
  });

  for (let index = 0; index < output.length; index += 1) {
    const line = output[index];
    if (!line || !line.trim()) {
      continue;
    }

    try {
      const entry = JSON.parse(line);
      const payload = entry?.payload;
      const payloadType = String(payload?.type || "").trim();
      const renameThreadId = String(payload?.thread_id || payload?.id || "").trim();
      const isRenameEvent =
        entry?.type === "event_msg" &&
        (payloadType === "thread_name_updated" || payloadType === "thread/name/updated") &&
        renameThreadId === id;

      if (!isRenameEvent) {
        continue;
      }

      sawRenameEvent = true;
      entry.timestamp = updatedAtIso;
      entry.payload = {
        ...payload,
        type: payloadType || "thread_name_updated",
        thread_id: id,
        thread_name: title,
        title,
        updated_at: updatedAtIso,
        updated_at_ms: updatedAtMs,
      };
      output[index] = JSON.stringify(entry);
      changed = true;
    } catch {
      // Keep malformed lines untouched.
    }
  }

  if (!sawSessionMeta) {
    return;
  }

  if (!sawRenameEvent) {
    output.push(
      JSON.stringify({
        timestamp: updatedAtIso,
        type: "event_msg",
        payload: {
          type: "thread_name_updated",
          thread_id: id,
          thread_name: title,
          title,
          updated_at: updatedAtIso,
          updated_at_ms: updatedAtMs,
        },
      }),
    );
    changed = true;
  }

  if (changed) {
    await writeAtomicTextFile(cleanPath, `${output.join(os.EOL)}${os.EOL}`);
    invalidateConversationSearchCache(cleanPath);
  }
}

function readFirstUserMessageFromRollout(filePath) {
  return getRolloutAnalysis(filePath).firstUserMessage || "";
}

function readPostForkFirstUserMessageFromRollout(filePath) {
  return getRolloutAnalysis(filePath).postForkFirstUserMessage || "";
}

function isFileBusyError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  if (code === "EPERM" || code === "EBUSY" || code === "EACCES") {
    return true;
  }

  const message = String(error?.message || "").toLowerCase();
  return message.includes("operation not permitted") || message.includes("resource busy") || message.includes("used by another process");
}

async function removeSessionIndexEntry(indexPath, id) {
  const content = await readTextFileIfExists(indexPath);
  const lines = content ? content.split(/\r?\n/) : [];
  const output = [];
  let removed = false;

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    try {
      const parsed = JSON.parse(line);
      if (parsed?.id === id) {
        removed = true;
        continue;
      }
      output.push(JSON.stringify(parsed));
    } catch {
      output.push(line);
    }
  }

  const nextContent = output.length ? `${output.join(os.EOL)}${os.EOL}` : "";
  await writeAtomicTextFile(indexPath, nextContent);
  sessionIndexCache.delete(normalizePathForCompare(indexPath) || indexPath);
  return { removed };
}

async function pickTaskForRename(scope) {
  const list = listTasks({ scope, limit: 200 });
  if (!list.items.length) {
    vscode.window.showWarningMessage("No Codex task is available to rename.");
    return null;
  }

  return vscode.window.showQuickPick(
    list.items.map((task) => ({
      label: task.title || task.id,
      description: shortId(task.id),
      detail: task.cwd || "No cwd",
      id: task.id,
    })),
    {
      title: "Select Codex Task to Rename",
      placeHolder: "Pick a task",
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );
}

function shortId(id) {
  const raw = String(id || "");
  return raw.length > 14 ? `${raw.slice(0, 8)}...${raw.slice(-4)}` : raw;
}

async function copyToClipboard(payload) {
  const text = String(payload.text || "");
  if (!text) {
    throw new Error("Nothing to copy.");
  }
  await vscode.env.clipboard.writeText(text);
  return { copied: true };
}

async function openOfficialTask(payload) {
  const id = String(payload.id || "").trim();
  if (!id) {
    throw new Error("Task id is required.");
  }

  const officialExtension = vscode.extensions.getExtension("openai.chatgpt");
  if (!officialExtension) {
    throw new Error("The official OpenAI Codex extension is not installed.");
  }

  if (!officialExtension.isActive) {
    await officialExtension.activate();
  }

  await vscode.commands.executeCommand("chatgpt.openSidebar");

  const encodedId = encodeURIComponent(id);
  const routeUri = vscode.Uri.parse(`vscode://openai.chatgpt/local/${encodedId}`);
  const handled = await vscode.env.openExternal(routeUri);
  if (handled) {
    return { opened: true, exact: true, method: "uri", route: `/local/${id}` };
  }

  return { opened: true, exact: false, method: "sidebar" };
}

function resolveExistingRolloutPath(codexHome, rolloutPath) {
  const normalized = String(rolloutPath || "").trim();
  if (!normalized) {
    return "";
  }

  const candidates = [];
  if (path.isAbsolute(normalized)) {
    candidates.push(normalized);
  } else {
    candidates.push(path.join(codexHome, normalized));
  }

  const basename = path.basename(normalized);
  if (basename) {
    candidates.push(path.join(codexHome, "archived_sessions", basename));
    candidates.push(path.join(codexHome, "sessions", basename.slice(8, 12), basename.slice(13, 15), basename.slice(16, 18), basename));
  }

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0] || "";
}

function toStoredRolloutPath(codexHome, absolutePath) {
  const cleanPath = String(absolutePath || "").trim();
  if (!cleanPath) {
    return "";
  }

  const relative = path.relative(codexHome, cleanPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return cleanPath;
  }

  return relative.replace(/[\\/]+/g, "/");
}

function syncStoredRolloutPathIfNeeded(db, codexHome, id, storedPath, absolutePath) {
  const desiredStoredPath = toStoredRolloutPath(codexHome, absolutePath);
  const currentStoredPath = String(storedPath || "");
  if (!desiredStoredPath || desiredStoredPath === currentStoredPath) {
    return desiredStoredPath || currentStoredPath;
  }

  dbRun(db, "UPDATE threads SET rollout_path = ? WHERE id = ?", [desiredStoredPath, id]);
  return desiredStoredPath;
}

function buildActiveRolloutPath(codexHome, rolloutPath) {
  const basename = path.basename(String(rolloutPath || "").trim());
  if (!basename || !basename.startsWith("rollout-")) {
    throw new Error("Could not recognize this conversation's rollout filename.");
  }

  const year = basename.slice(8, 12);
  const month = basename.slice(13, 15);
  const day = basename.slice(16, 18);
  if (!/^\d{4}$/.test(year) || !/^\d{2}$/.test(month) || !/^\d{2}$/.test(day)) {
    throw new Error("Could not infer the original session directory from the rollout filename.");
  }

  return path.join(codexHome, "sessions", year, month, day, basename);
}

function buildArchivedRolloutPath(codexHome, rolloutPath) {
  const basename = path.basename(String(rolloutPath || "").trim());
  if (!basename) {
    throw new Error("Could not recognize this conversation's rollout filename.");
  }
  return path.join(codexHome, "archived_sessions", basename);
}

async function moveRolloutFile(fromPath, toPath) {
  if (!fromPath || !toPath || normalizePathForCompare(fromPath) === normalizePathForCompare(toPath)) {
    return toPath || fromPath;
  }

  await fsp.mkdir(path.dirname(toPath), { recursive: true });
  try {
    await fsp.rename(fromPath, toPath);
  } catch (error) {
    if (error?.code === "EXDEV") {
      await fsp.copyFile(fromPath, toPath);
      await fsp.unlink(fromPath);
    } else {
      throw error;
    }
  }
  return toPath;
}

async function setTaskArchivedState(id, nextArchived) {
  const cleanId = String(id || "").trim();
  if (!cleanId) {
    throw new Error("Task id is required.");
  }

  const paths = getCodexPaths();
  const db = openDb(false);
  let row;
  let fromPath = "";
  let targetPath = "";
  let previousStoredPath = "";
  try {
    row = dbGet(db, "SELECT id, archived, rollout_path FROM threads WHERE id = ?", [cleanId]);
    if (!row) {
      throw new Error("Task not found.");
    }
    previousStoredPath = String(row.rollout_path || "");

    const currentArchived = Number(row.archived || 0) === 1;
    if (currentArchived === nextArchived) {
      throw new Error(nextArchived ? "This conversation is already archived." : "This conversation is already active.");
    }

    fromPath = resolveExistingRolloutPath(paths.codexHome, row.rollout_path || "");
    if (!fromPath || !fs.existsSync(fromPath)) {
      throw new Error("The rollout file for this conversation was not found, so archive state could not be synced.");
    }

    targetPath = nextArchived
      ? buildArchivedRolloutPath(paths.codexHome, row.rollout_path || fromPath)
      : buildActiveRolloutPath(paths.codexHome, row.rollout_path || fromPath);

    await moveRolloutFile(fromPath, targetPath);
    const storedPath = toStoredRolloutPath(paths.codexHome, targetPath);
    dbRun(db, "UPDATE threads SET archived = ?, rollout_path = ?, updated_at = ? WHERE id = ?", [
      nextArchived ? 1 : 0,
      storedPath,
      nowSec(),
      cleanId,
    ]);

    return { id: cleanId, archived: nextArchived, rolloutPath: targetPath, storedPath };
  } catch (error) {
    if (targetPath && fromPath && fs.existsSync(targetPath) && !fs.existsSync(fromPath)) {
      try {
        await moveRolloutFile(targetPath, fromPath);
      } catch {
        // Keep the original error; caller should resolve manually if rollback also fails.
      }
    }
    if (previousStoredPath) {
      try {
        dbRun(db, "UPDATE threads SET rollout_path = ? WHERE id = ?", [previousStoredPath, cleanId]);
      } catch {
        // Ignore rollback failure here and preserve original error.
      }
    }
    throw error;
  } finally {
    closeDb(db);
  }
}

async function archiveTask(payload) {
  return setTaskArchivedState(payload.id, true);
}

async function restoreTask(payload) {
  const id = String(payload.id || "").trim();
  const result = await setTaskArchivedState(id, false);
  return { restored: true, id: result.id, rolloutPath: result.rolloutPath };
}

function invalidateConversationSearchCache(filePath) {
  const normalized = normalizePathForCompare(filePath) || String(filePath || "").trim();
  if (!normalized) {
    return;
  }

  const prefix = `${normalized}::conversation::`;
  for (const key of conversationSearchCache.keys()) {
    if (key.startsWith(prefix)) {
      conversationSearchCache.delete(key);
    }
  }
  rolloutAnalysisCache.delete(normalized);
}

async function deleteArchivedTaskRollout(rolloutPath) {
  const cleanPath = String(rolloutPath || "").trim();
  if (!cleanPath || !fs.existsSync(cleanPath)) {
    return;
  }

  await fsp.unlink(cleanPath);
}

async function deleteTask(payload) {
  const id = String(payload.id || "").trim();
  if (!id) {
    throw new Error("Task id is required.");
  }

  const confirmLabel = "Delete";
  const picked = await vscode.window.showWarningMessage(
    "This permanently deletes all local data for this archived conversation and cannot be undone.",
    { modal: true, detail: `Conversation ID: ${id}` },
    confirmLabel,
  );
  if (picked !== confirmLabel) {
    return { deleted: false, cancelled: true, id };
  }

  try {
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Codesk is deleting the archived conversation",
        cancellable: false,
      },
      async (progress) => {
        const paths = getCodexPaths();
        const originalSessionIndexContent = await readTextFileIfExists(paths.sessionIndexPath);
        const db = openDb(false);
        let rolloutPath = "";

        try {
          progress.report({ message: "Checking conversation state..." });
          const row = dbGet(
            db,
            "SELECT id, title, first_user_message, cwd, rollout_path, created_at, updated_at, archived FROM threads WHERE id = ?",
            [id],
          );
          if (!row) {
            throw new Error("Task not found.");
          }
          if (Number(row.archived || 0) !== 1) {
            throw new Error("Only archived tasks can be permanently deleted.");
          }

          rolloutPath = resolveExistingRolloutPath(paths.codexHome, row.rollout_path || "");
          if (rolloutPath) {
            const normalizedRollout = normalizePathForCompare(rolloutPath);
            const codexRoot = normalizePathForCompare(paths.codexHome);
            if (!normalizedRollout || !codexRoot || !isPathInsideAnyRoot(normalizedRollout, [codexRoot])) {
              throw new Error("Refusing to delete a rollout file outside Codex storage.");
            }
          }

          progress.report({ message: "Updating session_index.jsonl..." });
          await removeSessionIndexEntry(paths.sessionIndexPath, id);

          progress.report({ message: "Updating sqlite index..." });
          dbRun(db, "DELETE FROM threads WHERE id = ?", [id]);

          if (rolloutPath && fs.existsSync(rolloutPath)) {
            progress.report({ message: "Deleting conversation files..." });
            await deleteArchivedTaskRollout(rolloutPath);
            invalidateConversationSearchCache(rolloutPath);
          }

          return { deleted: true, id };
        } catch (error) {
          try {
            await writeAtomicTextFile(paths.sessionIndexPath, originalSessionIndexContent);
          } catch {
            // Preserve the original error and surface recovery needs to the user instead.
          }
          throw error;
        } finally {
          closeDb(db);
        }
      },
    );

    vscode.window.showInformationMessage(`Archived conversation permanently deleted: ${id}`);
    return result;
  } catch (error) {
    vscode.window.showErrorMessage(`Delete failed: ${error?.message || error}`);
    throw error;
  }
}

function getWebviewHtml(webview, extensionUri) {
  const nonce = `${Date.now()}${Math.random().toString(16).slice(2)}`;
  const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "webview.css"));
  const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "webview.js"));
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Codesk</title>
    <link rel="stylesheet" href="${cssUri}" />
  </head>
  <body>
    <div class="app">
      <header class="topbar">
        <div class="topbar-main">
          <div class="brand-row">
            <div class="brand">Codesk</div>
            <div id="scopeHint" class="scope-hint">Loading...</div>
          </div>
          <div class="controls-row">
            <div class="scope-switch topbar-scope" role="group" aria-label="Task scope">
              <button id="scopeToggleBtn" class="scope-btn">Project</button>
              <button id="archivedScopeBtn" class="scope-btn">Archived</button>
            </div>
            <button id="refreshBtn" class="btn">Refresh</button>
          </div>
        </div>
      </header>

      <section class="toolbar">
        <div class="search-row">
          <select id="searchFieldSelect" class="search-select" aria-label="Search field">
            <option value="title">Task title</option>
            <option value="id">Session ID</option>
            <option value="cwd">CWD</option>
            <option value="firstUserMessage">First message</option>
            <option value="conversation">User/assistant text</option>
          </select>
          <input id="searchInput" class="search" type="text" placeholder="Search keywords" />
        </div>
      </section>

      <main class="layout">
        <aside class="list-pane">
          <div id="listSummary" class="list-summary">Loading...</div>
          <div id="taskList" class="task-list"></div>
        </aside>

        <div id="splitter" class="splitter" role="separator" aria-orientation="vertical" aria-label="Resize list and detail panes">
          <button id="swapPanesBtn" class="splitter-swap-btn" type="button" title="Swap left and right panes" aria-label="Swap left and right panes">↔️</button>
        </div>

        <section class="detail-pane">
          <div id="emptyState" class="empty-state">Select a task to view details</div>
          <article id="detailCard" class="detail-card hidden">
            <div class="detail-head">
              <div class="detail-title-wrap">
                <h2 id="detailTitle" class="detail-title"></h2>
                <div id="detailProjectPath" class="detail-project-path hidden"></div>
              </div>
              <button id="renameBtn" class="btn primary rename-btn">Rename</button>
            </div>

            <div class="sensitive-actions">
              <div class="fork-meta-row">
                <button id="openTaskBtn" class="btn mini">Open</button>
                <button id="archiveTaskBtn" class="btn mini">Archive</button>
                <button id="deleteTaskBtn" class="btn mini danger hidden">Delete</button>
                <button id="showIdBtn" class="btn mini">ID</button>
                <span id="detailIdWrap" class="reveal-output hidden">
                  <span id="detailId" class="fork-meta mono"></span>
                  <button id="copyIdBtn" class="btn mini">Copy</button>
                </span>
              </div>
              <div class="fork-meta-row">
                <button id="showCwdBtn" class="btn mini">CWD</button>
                <span id="detailCwdWrap" class="reveal-output hidden">
                  <span id="detailCwd" class="fork-meta"></span>
                  <button id="copyCwdBtn" class="btn mini">Copy</button>
                </span>
              </div>
            </div>

            <p class="time-meta">
              <span>Created: <span id="detailCreated"></span></span>
              <span>Updated: <span id="detailUpdated"></span></span>
            </p>

            <details id="firstMessageSection" class="message-fold">
              <summary>First user message</summary>
              <pre id="firstMessage" class="first-message"></pre>
            </details>

            <details id="postForkMessageSection" class="message-fold hidden">
              <summary>First message after fork</summary>
              <pre id="postForkFirstMessage" class="first-message"></pre>
            </details>

            <section>
              <h3>Forked from</h3>
              <div id="forkInfo" class="fork-info">
                <span class="fork-empty">This conversation was not forked</span>
              </div>
            </section>
          </article>
        </section>
      </main>
      <div id="statusBar" class="status-bar">Ready</div>

    </div>
    <script nonce="${nonce}" src="${jsUri}"></script>
  </body>
</html>`;
}

module.exports = {
  activate,
  deactivate,
  _test: {
    normalizePathForCompare,
    isPathInsideAnyRoot,
    validateTaskTitle,
  },
};
