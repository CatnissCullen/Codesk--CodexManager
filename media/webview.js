"use strict";

(() => {
  const vscode = acquireVsCodeApi();
  const persisted = vscode.getState() || {};
  const DEFAULT_RPC_TIMEOUT = 30000;
  const LIST_RPC_TIMEOUT = 120000;

  const state = {
    reqSeq: 1,
    pending: new Map(),
    scope: "project",
    search: "",
    searchField: "title",
    archiveFilter: "active",
    searchTimer: null,
    items: [],
    selectedId: "",
    detail: null,
    optimisticRename: null,
    loading: false,
    bootstrap: null,
    layout: {
      leftPaneWidth: Number.isFinite(Number(persisted.leftPaneWidth)) ? Number(persisted.leftPaneWidth) : 35,
      swapped: !!persisted.swapped,
      dragging: false,
    },
    reveal: {
      id: false,
      cwd: false,
      forkCwd: false,
      forkId: false,
    },
  };

  const els = {
    scopeHint: document.getElementById("scopeHint"),
    refreshBtn: document.getElementById("refreshBtn"),
    layout: document.querySelector(".layout"),
    listPane: document.querySelector(".list-pane"),
    detailPane: document.querySelector(".detail-pane"),
    splitter: document.getElementById("splitter"),
    swapPanesBtn: document.getElementById("swapPanesBtn"),
    scopeToggleBtn: document.getElementById("scopeToggleBtn"),
    archivedScopeBtn: document.getElementById("archivedScopeBtn"),
    searchFieldSelect: document.getElementById("searchFieldSelect"),
    searchInput: document.getElementById("searchInput"),
    listSummary: document.getElementById("listSummary"),
    taskList: document.getElementById("taskList"),
    emptyState: document.getElementById("emptyState"),
    detailCard: document.getElementById("detailCard"),
    detailTitle: document.getElementById("detailTitle"),
    openTaskBtn: document.getElementById("openTaskBtn"),
    archiveTaskBtn: document.getElementById("archiveTaskBtn"),
    deleteTaskBtn: document.getElementById("deleteTaskBtn"),
    showIdBtn: document.getElementById("showIdBtn"),
    showCwdBtn: document.getElementById("showCwdBtn"),
    detailIdWrap: document.getElementById("detailIdWrap"),
    detailCwdWrap: document.getElementById("detailCwdWrap"),
    detailId: document.getElementById("detailId"),
    detailCwd: document.getElementById("detailCwd"),
    copyIdBtn: document.getElementById("copyIdBtn"),
    copyCwdBtn: document.getElementById("copyCwdBtn"),
    detailCreated: document.getElementById("detailCreated"),
    detailUpdated: document.getElementById("detailUpdated"),
    firstMessage: document.getElementById("firstMessage"),
    postForkMessageSection: document.getElementById("postForkMessageSection"),
    postForkFirstMessage: document.getElementById("postForkFirstMessage"),
    forkInfo: document.getElementById("forkInfo"),
    renameBtn: document.getElementById("renameBtn"),
    statusBar: document.getElementById("statusBar"),
  };

  function esc(text) {
    return String(text ?? "").replace(/[&<>"']/g, (ch) => {
      const map = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      };
      return map[ch] || ch;
    });
  }

  function highlightSnippet(text, keyword) {
    const source = String(text || "");
    const q = String(keyword || "").trim();
    if (!source) {
      return "";
    }

    const escapedSource = esc(source);
    if (!q) {
      return escapedSource;
    }

    const pattern = new RegExp(`(${String(q).replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")})`, "ig");
    return escapedSource.replace(pattern, "<mark>$1</mark>");
  }

  function formatTime(value) {
    if (!value) {
      return "-";
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  }

  function setStatus(message, kind = "info") {
    if (!els.statusBar) {
      return;
    }
    els.statusBar.textContent = message;
    els.statusBar.classList.remove("is-error", "is-success");
    if (kind === "error") {
      els.statusBar.classList.add("is-error");
    }
    if (kind === "success") {
      els.statusBar.classList.add("is-success");
    }
  }

  function persistViewState() {
    vscode.setState({
      leftPaneWidth: state.layout.leftPaneWidth,
      swapped: state.layout.swapped,
    });
  }

  function clampPaneWidth(percent) {
    return Math.max(12, Math.min(88, Number(percent || 35)));
  }

  function syncPaneOrder() {
    if (!els.layout || !els.listPane || !els.detailPane || !els.splitter) {
      return;
    }

    if (state.layout.swapped) {
      els.layout.appendChild(els.detailPane);
      els.layout.appendChild(els.splitter);
      els.layout.appendChild(els.listPane);
      return;
    }

    els.layout.appendChild(els.listPane);
    els.layout.appendChild(els.splitter);
    els.layout.appendChild(els.detailPane);
  }

  function applyLayout() {
    const left = clampPaneWidth(state.layout.leftPaneWidth);
    state.layout.leftPaneWidth = left;
    if (els.layout) {
      els.layout.style.gridTemplateColumns = `minmax(0, ${left}fr) 28px minmax(0, ${100 - left}fr)`;
    }
    syncPaneOrder();
    if (els.splitter) {
      els.splitter.setAttribute("aria-valuetext", state.layout.swapped ? "Detail on the left, list on the right" : "List on the left, detail on the right");
    }
    if (els.swapPanesBtn) {
      els.swapPanesBtn.setAttribute("aria-pressed", state.layout.swapped ? "true" : "false");
      els.swapPanesBtn.title = state.layout.swapped ? "Restore list left, detail right" : "Swap left and right panes";
      els.swapPanesBtn.setAttribute("aria-label", els.swapPanesBtn.title);
    }
  }

  function beginSplitDrag(event) {
    event.preventDefault();
    state.layout.dragging = true;
    document.body.classList.add("is-resizing");
  }

  function updateSplitDrag(clientX) {
    if (!state.layout.dragging || !els.layout) {
      return;
    }

    const rect = els.layout.getBoundingClientRect();
    if (!rect.width) {
      return;
    }

    const next = ((clientX - rect.left) / rect.width) * 100;
    state.layout.leftPaneWidth = clampPaneWidth(next);
    applyLayout();
  }

  function endSplitDrag() {
    if (!state.layout.dragging) {
      return;
    }
    state.layout.dragging = false;
    document.body.classList.remove("is-resizing");
    persistViewState();
  }

  function resetRevealState() {
    state.reveal.id = false;
    state.reveal.cwd = false;
    state.reveal.forkCwd = false;
    state.reveal.forkId = false;
  }

  function scrollTaskIntoView(id) {
    if (!id || !els.taskList) {
      return;
    }

    const target = els.taskList.querySelector(`.task-item[data-id="${CSS.escape(String(id))}"]`);
    if (!target) {
      return;
    }

    const listRect = els.taskList.getBoundingClientRect();
    const itemRect = target.getBoundingClientRect();
    const currentTop = els.taskList.scrollTop;
    const offsetWithinList = itemRect.top - listRect.top + currentTop;
    const targetTop = offsetWithinList - (listRect.height / 2) + (itemRect.height / 2);
    const maxTop = Math.max(0, els.taskList.scrollHeight - els.taskList.clientHeight);
    const nextTop = Math.max(0, Math.min(maxTop, targetTop));

    els.taskList.scrollTo({
      top: nextTop,
      behavior: "smooth",
    });
  }

  async function copyText(text, successMessage) {
    await rpc("copyToClipboard", { text: String(text || "") });
    setStatus(successMessage, "success");
  }

  function rpc(op, payload, options = {}) {
    return new Promise((resolve, reject) => {
      const id = String(state.reqSeq++);
      state.pending.set(id, { resolve, reject });
      vscode.postMessage({ id, op, payload: payload || {} });
      const timeoutMs = Number(options.timeoutMs || DEFAULT_RPC_TIMEOUT);
      setTimeout(() => {
        if (!state.pending.has(id)) {
          return;
        }
        state.pending.delete(id);
        reject(new Error(`Request timed out: ${op}`));
      }, timeoutMs);
    });
  }

  window.addEventListener("message", (event) => {
    const message = event.data || {};
    if (message.type === "refresh") {
      refreshAll({ keepSelection: true, preserveState: true }).catch((error) => {
        setStatus(`Refresh failed: ${error.message}`, "error");
      });
      return;
    }

    const pending = state.pending.get(message.id);
    if (!pending) {
      return;
    }
    state.pending.delete(message.id);

    if (message.ok) {
      pending.resolve(message.data);
    } else {
      pending.reject(new Error(message.error || "Unknown error"));
    }
  });

  function renderScope() {
    const activeProject = state.scope === "project";
    const activeArchived = state.archiveFilter === "archived";
    els.scopeToggleBtn.classList.toggle("is-active", activeProject);
    els.archivedScopeBtn.classList.toggle("is-active", activeArchived);
    els.scopeToggleBtn.setAttribute("aria-pressed", activeProject ? "true" : "false");
    els.archivedScopeBtn.setAttribute("aria-pressed", activeArchived ? "true" : "false");
    els.scopeToggleBtn.textContent = activeProject ? "Project" : "All tasks";
    els.archivedScopeBtn.textContent = activeArchived ? "Archived" : "Active";
    document.body.classList.toggle("is-archived-scope", activeArchived);
  }

  function renderHint(listData) {
    if (!state.bootstrap) {
      els.scopeHint.textContent = "Loading...";
      return;
    }

    if (!state.bootstrap.sqliteAvailable) {
      els.scopeHint.textContent = "This VS Code runtime does not support node:sqlite";
      els.scopeHint.classList.add("is-error");
      return;
    }

    els.scopeHint.classList.remove("is-error");
    if (!listData?.hasWorkspace && state.scope === "project") {
      els.scopeHint.textContent = "No project open, showing all tasks";
      return;
    }

    const archiveLabel = state.archiveFilter === "archived" ? "archived" : "active";
    if (state.scope === "project") {
      const count = listData?.workspaceRoots?.length || 0;
      els.scopeHint.textContent = `Project scope · ${archiveLabel} · ${count} workspace roots`;
    } else {
      els.scopeHint.textContent = `All Codex tasks · ${archiveLabel}`;
    }
  }

  function renderList() {
    if (state.loading) {
      els.taskList.innerHTML = "<div class=\"empty-list\">Loading...</div>";
      return;
    }

    if (!state.items.length) {
      let emptyText = "No tasks to show";
      if (state.scope === "project") {
        emptyText = state.archiveFilter === "archived" ? "No archived tasks in this project" : "No tasks in this project";
      } else if (state.archiveFilter === "archived") {
        emptyText = "No archived tasks";
      }
      els.taskList.innerHTML = `<div class="empty-list">${esc(emptyText)}</div>`;
      return;
    }

    els.taskList.innerHTML = state.items
      .map((item) => {
        const selected = item.id === state.selectedId ? "is-selected" : "";
        const title = item.title || item.firstUserMessage || item.id;
        const snippet = state.search
          ? `<div class="task-snippet">${highlightSnippet(item.matchSnippet || "", state.search)}</div>`
          : "";
        return `
          <button class="task-item ${selected}" data-id="${esc(item.id)}" title="${esc(item.id)}">
            <div class="task-title">${esc(title)}</div>
            ${snippet}
          </button>
        `;
      })
      .join("");
  }

  function rerenderListPreservingScroll() {
    if (!els.taskList) {
      renderList();
      return;
    }

    const previousScrollTop = els.taskList.scrollTop;
    renderList();
    els.taskList.scrollTop = previousScrollTop;
  }

  function renderDetail() {
    const task = state.detail?.task;
    if (!task || task.id !== state.selectedId) {
      els.emptyState.classList.remove("hidden");
      els.detailCard.classList.add("hidden");
      return;
    }

    els.emptyState.classList.add("hidden");
    els.detailCard.classList.remove("hidden");

    els.detailTitle.textContent = task.title || task.firstUserMessage || task.id;
    els.openTaskBtn.textContent = task.archived ? "Restore" : "Open";
    els.archiveTaskBtn.classList.toggle("hidden", !!task.archived);
    els.deleteTaskBtn.classList.toggle("hidden", !task.archived);
    els.detailId.textContent = task.id;
    els.detailCwd.textContent = task.cwd || "-";
    els.detailCwd.title = task.cwd || "";
    els.detailIdWrap.classList.toggle("hidden", !state.reveal.id);
    els.detailCwdWrap.classList.toggle("hidden", !state.reveal.cwd);
    els.detailCreated.textContent = formatTime(task.createdAt);
    els.detailUpdated.textContent = formatTime(task.updatedAt);
    els.firstMessage.textContent = task.firstUserMessage || "No first user message";
    const postForkMessage = String(task.postForkFirstUserMessage || "").trim();
    els.postForkMessageSection.classList.toggle("hidden", !postForkMessage);
    els.postForkFirstMessage.textContent = postForkMessage || "";

    const fork = state.detail?.fork;
    if (!fork || !fork.id) {
      els.forkInfo.innerHTML = '<span class="fork-empty">This conversation was not forked</span>';
      return;
    }

    const forkTitle = fork.title || fork.id;
    let forkMeta = '<span class="fork-meta is-missing">Parent conversation is not in the index</span>';
    if (fork.exists) {
      const forkIdRevealClass = state.reveal.forkId ? "" : "hidden";
      const forkCwdRevealClass = state.reveal.forkCwd ? "" : "hidden";
      forkMeta = `
        <div class="fork-meta-stack">
          <div class="fork-meta-row">
            <button class="btn mini fork-show-id-btn">ID</button>
            <span class="reveal-output ${forkIdRevealClass}">
              <span class="fork-meta mono">${esc(fork.id)}</span>
              <button class="btn mini fork-copy-id-btn" data-text="${esc(fork.id)}">Copy</button>
            </span>
            <button class="btn mini fork-show-cwd-btn">CWD</button>
            <span class="reveal-output ${forkCwdRevealClass}" id="forkCwdWrap">
              <span class="fork-meta">${esc(fork.cwd || "-")}</span>
              <button class="btn mini fork-copy-cwd-btn" data-text="${esc(fork.cwd || "")}">Copy</button>
            </span>
          </div>
        </div>
      `;
    }

    els.forkInfo.innerHTML = `
      <button class="fork-link" data-id="${esc(fork.id)}" data-archived="${fork.archived ? "true" : "false"}" title="${esc(fork.id)}">${esc(forkTitle)}</button>
      ${forkMeta}
    `;
  }

  function renderSummary(data) {
    const shown = state.items.length;
    const filtered = data?.totalFiltered || 0;
    const archiveTotal = data?.totalByArchiveFilter || 0;
    const suffix = data?.truncated ? `, showing first ${shown}` : "";
    const archiveLabel = state.archiveFilter === "archived" ? "archived" : "active";
    els.listSummary.textContent = `Showing ${shown}/${filtered}, ${archiveLabel} total ${archiveTotal}${suffix}`;
  }

  async function loadBootstrap(options = {}) {
    const data = await rpc("bootstrap");
    state.bootstrap = data;
    if (!options.preserveState) {
      state.scope = data.defaultScope || "project";
      state.archiveFilter = "active";
    }
    renderScope();
    renderHint(null);
  }

  async function loadList(options = {}) {
    state.loading = true;
    renderList();

    const data = await rpc("listTasks", {
      scope: state.scope,
      q: state.search,
      searchField: state.searchField,
      archiveFilter: state.archiveFilter,
      limit: 250,
    }, { timeoutMs: LIST_RPC_TIMEOUT });

    state.items = Array.isArray(data.items) ? data.items : [];
    state.searchField = data.searchField || state.searchField;
    state.archiveFilter = data.archiveFilter || state.archiveFilter;
    els.searchFieldSelect.value = state.searchField;
    renderScope();
    const selectedVisible = state.items.some((item) => item.id === state.selectedId);
    if (!options.keepSelection) {
      state.selectedId = state.items[0]?.id || "";
      state.detail = null;
    } else if (!selectedVisible && !options.preserveDetailSelection) {
      state.selectedId = state.items[0]?.id || "";
      state.detail = null;
    }

    state.loading = false;
    renderHint(data);
    renderSummary(data);
    renderList();

    if (state.selectedId && (!options.preserveDetailSelection || state.items.some((item) => item.id === state.selectedId))) {
      await selectTask(state.selectedId, { silent: true });
    } else {
      renderDetail();
    }
  }

  async function selectTask(id, options = {}) {
    if (!id) {
      return;
    }

    if (state.optimisticRename && state.optimisticRename.id !== id) {
      state.optimisticRename = null;
    }
    state.selectedId = id;
    resetRevealState();
    vscode.postMessage({ id: `select-${Date.now()}`, op: "setSelectedTask", payload: { id, scope: state.scope } });
    if (options.scrollListToCenter) {
      renderList();
    } else {
      rerenderListPreservingScroll();
    }
    if (options.scrollListToCenter) {
      scrollTaskIntoView(id);
    }

    const data = await rpc("getTaskDetail", { id });
    if (state.selectedId !== id) {
      return;
    }

    if (
      state.optimisticRename &&
      state.optimisticRename.id === id &&
      data?.task &&
      new Date(String(data.task.updatedAt || 0)).getTime() < state.optimisticRename.updatedAtMs
    ) {
      data.task.title = state.optimisticRename.title;
      data.task.updatedAt = state.optimisticRename.updatedAt;
    }

    state.detail = data;
    renderDetail();
    if (!options.silent) {
      setStatus("Details updated", "success");
    }
  }

  async function refreshAll(options = {}) {
    setStatus("Refreshing...");
    await loadBootstrap({ preserveState: !!options.preserveState });
    await loadList({ keepSelection: !!options.keepSelection, preserveDetailSelection: !!options.preserveDetailSelection });
    setStatus("Refresh complete", "success");
  }

  async function navigateToFork(id, archived) {
    const nextArchiveFilter = archived ? "archived" : "active";
    const needsArchiveSwitch = state.archiveFilter !== nextArchiveFilter;
    if (needsArchiveSwitch) {
      state.archiveFilter = nextArchiveFilter;
      renderScope();
      await loadList({
        keepSelection: true,
        preserveDetailSelection: true,
      });
    }
    await selectTask(id, { scrollListToCenter: true });
  }

  async function renameSelected() {
    if (!state.selectedId) {
      setStatus("Select a task first", "error");
      return;
    }

    try {
      const result = await rpc("promptRenameTask", { id: state.selectedId });
      if (result?.cancelled) {
        setStatus("Rename cancelled");
        return;
      }
      if (result?.unchanged) {
        setStatus("Name unchanged");
        return;
      }
      if (state.detail?.task?.id === state.selectedId) {
        state.detail.task.title = result.title;
        state.detail.task.updatedAt = result.updatedAt || state.detail.task.updatedAt;
      }
      const item = state.items.find((entry) => entry.id === state.selectedId);
      if (item) {
        item.title = result.title;
        item.updatedAt = result.updatedAt || item.updatedAt;
      }
      state.optimisticRename = {
        id: state.selectedId,
        title: result.title,
        updatedAt: result.updatedAt || new Date().toISOString(),
        updatedAtMs: Date.parse(result.updatedAt || new Date().toISOString()) || Date.now(),
      };
      renderList();
      renderDetail();
      setStatus("Task name updated", "success");
      loadList({ keepSelection: true }).catch((error) => {
        setStatus(`Background refresh failed: ${error.message}`, "error");
      });
    } catch (error) {
      setStatus(`Rename failed: ${error.message}`, "error");
    }
  }

  async function openSelectedInOfficial() {
    if (!state.selectedId) {
      setStatus("Select a task first", "error");
      return;
    }

    try {
      const result = await rpc("openOfficialTask", { id: state.selectedId });
      if (result?.exact) {
        setStatus("Tried opening the conversation in the official Codex extension", "success");
      } else {
        setStatus("Opened the official Codex extension; locate the conversation manually if needed", "success");
      }
    } catch (error) {
      setStatus(`Open failed: ${error.message}`, "error");
    }
  }

  async function restoreSelected() {
    if (!state.selectedId) {
      setStatus("Select a task first", "error");
      return;
    }

    try {
      await rpc("restoreTask", { id: state.selectedId });
      await loadList({ keepSelection: false });
      setStatus("Archived conversation restored", "success");
    } catch (error) {
      setStatus(`Restore failed: ${error.message}`, "error");
    }
  }

  async function archiveSelected() {
    if (!state.selectedId) {
      setStatus("Select a task first", "error");
      return;
    }

    try {
      await rpc("archiveTask", { id: state.selectedId });
      await loadList({ keepSelection: false });
      setStatus("Conversation archived", "success");
    } catch (error) {
      setStatus(`Archive failed: ${error.message}`, "error");
    }
  }

  async function deleteSelected() {
    if (!state.selectedId) {
      setStatus("Select a task first", "error");
      return;
    }
    if (!state.detail?.task?.archived) {
      setStatus("Only archived conversations can be deleted", "error");
      return;
    }

    try {
      setStatus("Deleting...");
      const result = await rpc("deleteTask", { id: state.selectedId });
      if (result?.cancelled) {
        setStatus("Delete cancelled");
        return;
      }
      state.detail = null;
      state.selectedId = "";
      await loadList({ keepSelection: false });
      setStatus("Archived conversation permanently deleted", "success");
    } catch (error) {
      setStatus(`Delete failed: ${error.message}`, "error");
    }
  }

  function bindEvents() {
    els.refreshBtn.addEventListener("click", () => {
      refreshAll({ keepSelection: true, preserveState: true }).catch((error) => {
        setStatus(`Refresh failed: ${error.message}`, "error");
      });
    });

    els.swapPanesBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      state.layout.swapped = !state.layout.swapped;
      state.layout.leftPaneWidth = clampPaneWidth(100 - state.layout.leftPaneWidth);
      applyLayout();
      persistViewState();
    });

    els.splitter.addEventListener("mousedown", beginSplitDrag);
    window.addEventListener("mousemove", (event) => updateSplitDrag(event.clientX));
    window.addEventListener("mouseup", endSplitDrag);
    window.addEventListener("mouseleave", endSplitDrag);

    els.scopeToggleBtn.addEventListener("click", () => {
      state.scope = state.scope === "project" ? "all" : "project";
      state.selectedId = "";
      state.detail = null;
      renderScope();
      loadList({ keepSelection: false }).catch((error) => {
        setStatus(`Switch failed: ${error.message}`, "error");
      });
    });

    els.archivedScopeBtn.addEventListener("click", () => {
      state.archiveFilter = state.archiveFilter === "archived" ? "active" : "archived";
      renderScope();
      loadList({ keepSelection: true, preserveDetailSelection: true }).catch((error) => {
        setStatus(`Switch failed: ${error.message}`, "error");
      });
    });

    els.searchInput.addEventListener("input", () => {
      state.search = els.searchInput.value.trim();
      if (state.searchTimer) {
        clearTimeout(state.searchTimer);
      }
      state.searchTimer = setTimeout(() => {
        loadList({ keepSelection: false }).catch((error) => {
          setStatus(`Search failed: ${error.message}`, "error");
        });
      }, 320);
    });

    els.searchInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") {
        return;
      }
      if (state.searchTimer) {
        clearTimeout(state.searchTimer);
      }
      state.search = els.searchInput.value.trim();
      loadList({ keepSelection: false }).catch((error) => {
        setStatus(`Search failed: ${error.message}`, "error");
      });
    });

    els.searchFieldSelect.addEventListener("change", () => {
      state.searchField = els.searchFieldSelect.value || "title";
      loadList({ keepSelection: false }).catch((error) => {
        setStatus(`Search field switch failed: ${error.message}`, "error");
      });
    });

    els.taskList.addEventListener("click", (event) => {
      const item = event.target.closest(".task-item[data-id]");
      if (!item) {
        return;
      }
      selectTask(item.dataset.id || "").catch((error) => {
        setStatus(`Load failed: ${error.message}`, "error");
      });
    });

    els.forkInfo.addEventListener("click", (event) => {
      const showForkIdBtn = event.target.closest(".fork-show-id-btn");
      if (showForkIdBtn) {
        state.reveal.forkId = !state.reveal.forkId;
        renderDetail();
        return;
      }

      const copyForkIdBtn = event.target.closest(".fork-copy-id-btn");
      if (copyForkIdBtn) {
        copyText(copyForkIdBtn.dataset.text || "", "Parent ID copied").catch((error) => {
          setStatus(`Copy failed: ${error.message}`, "error");
        });
        return;
      }

      const showForkCwdBtn = event.target.closest(".fork-show-cwd-btn");
      if (showForkCwdBtn) {
        state.reveal.forkCwd = !state.reveal.forkCwd;
        renderDetail();
        return;
      }

      const copyForkCwdBtn = event.target.closest(".fork-copy-cwd-btn");
      if (copyForkCwdBtn) {
        copyText(copyForkCwdBtn.dataset.text || "", "Parent CWD copied").catch((error) => {
          setStatus(`Copy failed: ${error.message}`, "error");
        });
        return;
      }

      const target = event.target.closest(".fork-link[data-id]");
      if (!target) {
        return;
      }
      const forkArchived = String(target.dataset.archived || "").trim() === "true";
      navigateToFork(target.dataset.id || "", forkArchived).catch((error) => {
        setStatus(`Parent load failed: ${error.message}`, "error");
      });
    });

    els.showIdBtn.addEventListener("click", () => {
      state.reveal.id = !state.reveal.id;
      renderDetail();
    });

    els.openTaskBtn.addEventListener("click", () => {
      if (state.detail?.task?.archived) {
        restoreSelected().catch((error) => {
          setStatus(`Restore failed: ${error.message}`, "error");
        });
        return;
      }
      openSelectedInOfficial().catch((error) => {
        setStatus(`Open failed: ${error.message}`, "error");
      });
    });

    els.archiveTaskBtn.addEventListener("click", () => {
      archiveSelected().catch((error) => {
        setStatus(`Archive failed: ${error.message}`, "error");
      });
    });

    els.deleteTaskBtn.addEventListener("click", () => {
      deleteSelected().catch((error) => {
        setStatus(`Delete failed: ${error.message}`, "error");
      });
    });

    els.showCwdBtn.addEventListener("click", () => {
      state.reveal.cwd = !state.reveal.cwd;
      renderDetail();
    });

    els.copyIdBtn.addEventListener("click", () => {
      copyText(state.detail?.task?.id || "", "Session ID copied").catch((error) => {
        setStatus(`Copy failed: ${error.message}`, "error");
      });
    });

    els.copyCwdBtn.addEventListener("click", () => {
      copyText(state.detail?.task?.cwd || "", "Session CWD copied").catch((error) => {
        setStatus(`Copy failed: ${error.message}`, "error");
      });
    });

    els.renameBtn.addEventListener("click", renameSelected);
  }

  async function init() {
    bindEvents();
    applyLayout();
    renderScope();
    try {
      await refreshAll({ keepSelection: false, preserveState: false });
    } catch (error) {
      state.loading = false;
      renderList();
      renderDetail();
      setStatus(`Load failed: ${error.message}`, "error");
      els.scopeHint.textContent = "Load failed. Check the Codex data directory or VS Code version.";
      els.listSummary.textContent = "Failed to load tasks";
    }
  }

  init();
})();
