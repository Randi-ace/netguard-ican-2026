/**
 * ShieldFlow — 单页应用交互、图表与动效
 */
(function () {
  "use strict";

  const THEME_KEY = "shieldflow-theme";
  const PROFILE_KEY = "shieldflow-profile";

  const DEFAULT_AVATAR = "https://api.dicebear.com/7.x/avataaars/svg?seed=shield";

  /** @type {Record<string, string>} */
  const DASH_TITLES = {
    "dash-home": "控制台首页",
    "dash-logs": "风险日志",
    "dash-reports": "安全概览",
    "dash-family": "家庭管理",
    "dash-modes": "模式选择",
    "dash-sub": "订阅详情",
    "dash-analytics": "数据分析",
    "dash-settings": "个人设置",
  };

  /** @type {Record<string, string>} */
  const MODE_COPY = {
    normal:
      "普通模式在体验与防护间取得平衡：常规广告与跟踪器默认拦截，对可信站点降低打扰。适合日常办公与娱乐浏览。",
    strict:
      "严格模式启用全量规则与更激进的脚本管控，金融与政务类站点自动提升验证等级。可能出现少量误杀，可通过白名单微调。",
    elder:
      "老人模式提供大字体、高对比界面与红色强风险提示，自动隐藏复杂广告模块，并提供一键加固入口，降低误点风险。",
    child:
      "儿童模式启用学习优先策略，限制娱乐内容曝光并加入浏览时长提醒；界面采用柔和配色与正向反馈动画，帮助建立安全习惯。",
  };

  let chartsInitialized = false;
  const chartRefs = {};
  let statisticsData = null;
  let statisticsStatus = "idle";
  let dashboardTrendData = null;
  let dashboardTrendStatus = "idle";
  let riskDistributionData = null;
  let riskDistributionStatus = "idle";
  let riskLogRecords = [];
  let riskLogPage = 1;
  let riskLogRequestedPage = 1;
  let riskLogTotalPages = 0;
  let riskLogLoading = false;
  const RISK_LOG_PAGE_SIZE = 20;
  let currentMode = null;
  let currentSettings = null;
  let settingsLoading = false;
  let settingsSaving = false;
  let settingsRefreshPromise = null;
  let settingsRequestGeneration = 0;
  let aiScanLoading = false;
  let pendingAiScan = null;
  let recentRiskRecordsLoading = false;
  let reportRiskRecords = [];
  let dashboardRefreshPromise = null;
  let dashboardRefreshQueued = false;
  
  async function fetchStatistics() {
    statisticsStatus = "loading";
    try {
      const response = await api.get("/api/dashboard/overview");
      if (!response || response.code !== 0 || !response.data) {
        throw new Error(response?.message || "Dashboard overview response is invalid");
      }
      statisticsData = response.data;
      statisticsStatus = "ready";
      setDashboardOverviewStatus("");
      return statisticsData;
    } catch (error) {
      console.error('Failed to fetch statistics:', error);
      statisticsData = null;
      statisticsStatus = "error";
      updateCountersWithData(null);
      setDashboardOverviewStatus("Dashboard 数据暂时无法加载，请稍后重试。", "error");
      setChartEmptyState(
        "chart-ai-bar",
        "chart-ai-status",
        "bar",
        "AI 检测数据暂时无法加载。",
        "error"
      );
      setChartEmptyState(
        "chart-report-bar",
        "chart-report-bar-status",
        "reportBar",
        "报告数据暂时无法加载。",
        "error"
      );
      return null;
    }
  }

  async function fetchDashboardTrend(days = 7) {
    dashboardTrendStatus = "loading";
    try {
      const response = await api.get("/api/dashboard/trend?days=" + days);
      const data = response?.data;
      if (
        !response ||
        response.code !== 0 ||
        !data ||
        !Array.isArray(data.dates) ||
        !Array.isArray(data.risk_counts) ||
        !Array.isArray(data.ad_counts) ||
        data.dates.length !== data.risk_counts.length ||
        data.dates.length !== data.ad_counts.length
      ) {
        throw new Error(response?.message || "Dashboard trend response is invalid");
      }

      dashboardTrendData = data;
      dashboardTrendStatus = "ready";
      return dashboardTrendData;
    } catch (error) {
      console.error("Failed to fetch dashboard trend:", error);
      dashboardTrendData = null;
      dashboardTrendStatus = "error";
      setChartEmptyState(
        "chart-ads-line",
        "chart-trend-status",
        "line",
        "趋势数据暂时无法加载。",
        "error"
      );
      return null;
    }
  }

  async function fetchRiskDistribution() {
    riskDistributionStatus = "loading";
    try {
      const response = await api.get("/api/dashboard/risk-distribution");
      const data = response?.data;
      const levels = ["safe", "low", "medium", "high"];
      if (
        !response ||
        response.code !== 0 ||
        !data ||
        !levels.every((level) => Object.prototype.hasOwnProperty.call(data, level))
      ) {
        throw new Error(response?.message || "Risk distribution response is invalid");
      }

      riskDistributionData = {
        safe: data.safe ?? 0,
        low: data.low ?? 0,
        medium: data.medium ?? 0,
        high: data.high ?? 0,
      };
      riskDistributionStatus = "ready";
      return riskDistributionData;
    } catch (error) {
      console.error("Failed to fetch risk distribution:", error);
      riskDistributionData = null;
      riskDistributionStatus = "error";
      setChartEmptyState(
        "chart-risk-pie",
        "chart-risk-status",
        "pie",
        "风险分布数据暂时无法加载。",
        "error"
      );
      return null;
    }
  }
  
  async function fetchRiskLogs(page = 1) {
    if (riskLogLoading) return null;
    riskLogRequestedPage = page;
    riskLogLoading = true;
    setRiskLogState("loading", "加载中…");
    updateRiskLogPagination();

    try {
      const response = await api.get(
        "/api/logs/risk?page=" + page + "&page_size=" + RISK_LOG_PAGE_SIZE
      );
      const data = response?.data;
      if (
        !response ||
        response.code !== 0 ||
        !data ||
        !Array.isArray(data.records) ||
        !data.pagination
      ) {
        throw new Error(response?.message || "Risk log response is invalid");
      }

      const pagination = data.pagination;
      const currentPage = Number(pagination.page ?? page);
      const pageSize = Number(pagination.page_size ?? RISK_LOG_PAGE_SIZE);
      const total = Number(pagination.total ?? 0);
      const totalPages = Number(
        pagination.pages ?? (pageSize > 0 ? Math.ceil(total / pageSize) : 0)
      );
      if (
        !Number.isFinite(currentPage) ||
        currentPage < 1 ||
        !Number.isFinite(pageSize) ||
        pageSize < 1 ||
        !Number.isFinite(total) ||
        total < 0 ||
        !Number.isFinite(totalPages) ||
        totalPages < 0
      ) {
        throw new Error("Risk log pagination is invalid");
      }

      riskLogRecords = data.records;
      riskLogPage = currentPage;
      riskLogTotalPages = totalPages;
      renderRiskLogs(riskLogRecords);
      updateRiskLogPagination(total);

      if (riskLogRecords.length === 0) {
        setRiskLogState("empty", "暂无记录");
      } else {
        setRiskLogState("ready", "");
      }
      return data;
    } catch (error) {
      console.error("Failed to fetch risk logs:", error);
      riskLogRecords = [];
      riskLogTotalPages = 0;
      renderRiskLogs([]);
      updateRiskLogPagination(0);
      setRiskLogState("error", "日志接口加载失败。");
      return null;
    } finally {
      riskLogLoading = false;
      updateRiskLogPagination();
    }
  }

  async function fetchRecentRiskRecords() {
    if (recentRiskRecordsLoading) return null;
    recentRiskRecordsLoading = true;
    setRecentSecurityEventsState("loading", "加载中…");
    setReportRiskRecordsState("loading", "加载中…");
    try {
      const response = await api.get("/api/logs/risk?page=1&page_size=3");
      const data = response?.data;
      if (!response || response.code !== 0 || !data || !Array.isArray(data.records)) {
        throw new Error(response?.message || "Recent risk record response is invalid");
      }

      renderRecentSecurityEvents(data.records);
      reportRiskRecords = data.records;
      renderReportRiskRecords(reportRiskRecords);
      if (data.records.length === 0) {
        setRecentSecurityEventsState("empty", "暂无安全事件");
        setReportRiskRecordsState("empty", "暂无风险记录");
      } else {
        setRecentSecurityEventsState("ready", "");
        setReportRiskRecordsState("ready", "");
      }
      return data.records;
    } catch (error) {
      console.error("Failed to fetch recent risk records:", error);
      renderRecentSecurityEvents([]);
      reportRiskRecords = [];
      renderReportRiskRecords(reportRiskRecords);
      setRecentSecurityEventsState("error", error?.message || "最近安全事件加载失败");
      setReportRiskRecordsState("error", error?.message || "报告风险记录加载失败");
      return null;
    } finally {
      recentRiskRecordsLoading = false;
    }
  }
  
  function updateCountersWithData(data) {
    const dashboardIds = [
      "dash-today-risk",
      "dash-ad-block",
      "dash-ai-check",
      "dash-url-check",
      "dash-high-risk",
      "dash-welcome-ai-count",
    ];

    if (!data) {
      dashboardIds.forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.textContent = "—";
      });
      $all("[data-stat]").forEach((el) => {
        el.setAttribute("data-counter", "0");
        el.textContent = "—";
      });
      return;
    }

    const counters = {
      'stat-url': data.url_check_count ?? 0,
      'stat-ai': data.ai_check_count ?? 0,
      'stat-high': data.high_risk_count ?? 0,
      'stat-ad': data.ad_block_count ?? 0
    };

    Object.keys(counters).forEach(key => {
      const el = document.querySelector(`[data-stat="${key}"]`);
      if (el) {
        el.setAttribute('data-counter', counters[key].toString());
        el.textContent = Number(counters[key]).toLocaleString("zh-CN");
      }
    });

    const dashboardCounters = {
      "dash-today-risk": data.today_risk_count ?? 0,
      "dash-ad-block": data.ad_block_count ?? 0,
      "dash-ai-check": data.ai_check_count ?? 0,
      "dash-url-check": data.url_check_count ?? 0,
      "dash-high-risk": data.high_risk_count ?? 0,
      "dash-welcome-ai-count": data.ai_check_count ?? 0,
    };

    Object.entries(dashboardCounters).forEach(([id, value]) => {
      const el = document.getElementById(id);
      if (el) el.textContent = Number(value).toLocaleString("zh-CN");
    });
  }

  function setDashboardOverviewStatus(message, state = "") {
    const status = document.getElementById("dash-overview-status");
    if (!status) return;
    status.textContent = message;
    status.hidden = !message;
    status.className = state === "error" ? "small risk-high" : "muted small";
  }

  function setReportSummaryStatus(message, state = "") {
    const status = document.getElementById("report-summary-status");
    if (!status) return;
    status.textContent = message;
    status.hidden = !message;
    status.className = state === "error" ? "small risk-high" : "muted small";
  }

  function setChartLoadingState(canvasId, statusId) {
    const canvas = document.getElementById(canvasId);
    const status = document.getElementById(statusId);
    if (canvas) canvas.hidden = true;
    if (status) {
      status.textContent = "加载中…";
      status.hidden = false;
      status.className = "muted small";
    }
  }

  function setChartEmptyState(canvasId, statusId, chartKey, message, state = "") {
    const canvas = document.getElementById(canvasId);
    const status = document.getElementById(statusId);

    if (message && ["pie", "bar", "line", "stack"].includes(chartKey)) {
      chartsInitialized = false;
    }
    if (message && chartRefs[chartKey]) {
      chartRefs[chartKey].destroy();
      chartRefs[chartKey] = null;
    }
    if (canvas) canvas.hidden = Boolean(message);
    if (status) {
      status.textContent = message;
      status.hidden = !message;
      status.className = state === "error" ? "small risk-high" : "muted small";
    }
  }

  function isRiskDistributionEmpty(data) {
    return Boolean(data) && ["safe", "low", "medium", "high"].every(
      (level) => Number(data[level]) === 0
    );
  }

  function isReportChartEmpty(data) {
    return Boolean(data) && [
      "ad_block_count",
      "url_check_count",
      "ai_check_count",
      "high_risk_count",
    ].every((field) => Number(data[field]) === 0);
  }

  function isAiChartEmpty(data) {
    return Boolean(data) && Number(data.ai_check_count) === 0;
  }

  function ensureChartLibraryAvailable() {
    if (typeof window.Chart === "function") return true;

    const message = "图表组件加载失败，请检查网络后刷新页面。";
    [
      ["chart-risk-pie", "chart-risk-status", "pie"],
      ["chart-ai-bar", "chart-ai-status", "bar"],
      ["chart-ads-line", "chart-trend-status", "line"],
      ["chart-report-stack", "chart-report-stack-status", "stack"],
      ["chart-report-bar", "chart-report-bar-status", "reportBar"],
    ].forEach(([canvasId, statusId, chartKey]) => {
      setChartEmptyState(canvasId, statusId, chartKey, message, "error");
    });
    return false;
  }
  
  function renderRiskLogs(records) {
    const body = $("#ad-log-body");
    if (!body) return;
    body.replaceChildren();

    records.forEach((record) => {
      const tr = document.createElement("tr");
      const typeCell = document.createElement("td");
      const urlCell = document.createElement("td");
      const urlCode = document.createElement("code");
      const riskCell = document.createElement("td");
      const reasonCell = document.createElement("td");
      const timeCell = document.createElement("td");

      typeCell.textContent = record.type || "—";
      urlCode.textContent = record.url || "—";
      urlCell.appendChild(urlCode);
      riskCell.textContent = formatRiskLevel(record.risk_level);
      if (record.risk_level === "high") riskCell.className = "risk-high";
      else if (record.risk_level === "medium") riskCell.className = "risk-mid";
      else if (record.risk_level === "low" || record.risk_level === "safe") {
        riskCell.className = "risk-low";
      }
      reasonCell.textContent = record.reason || "—";
      timeCell.textContent = formatRiskLogTime(record.time);

      tr.append(typeCell, urlCell, riskCell, reasonCell, timeCell);
      body.appendChild(tr);
    });
  }

  function renderRecentSecurityEvents(records) {
    const body = $("#recent-security-events-body");
    if (!body) return;
    body.replaceChildren();

    records.forEach((record) => {
      const row = document.createElement("tr");
      const typeCell = document.createElement("td");
      const urlCell = document.createElement("td");
      const urlCode = document.createElement("code");
      const riskCell = document.createElement("td");
      const reasonCell = document.createElement("td");
      const timeCell = document.createElement("td");

      typeCell.textContent = record.type || "—";
      urlCode.textContent = record.url || "—";
      urlCell.appendChild(urlCode);
      riskCell.textContent = formatRiskLevel(record.risk_level);
      if (record.risk_level === "high") riskCell.className = "risk-high";
      else if (record.risk_level === "medium") riskCell.className = "risk-mid";
      else if (record.risk_level === "low" || record.risk_level === "safe") {
        riskCell.className = "risk-low";
      }
      reasonCell.textContent = record.reason || "—";
      timeCell.textContent = formatRiskLogTime(record.time);

      row.append(typeCell, urlCell, riskCell, reasonCell, timeCell);
      body.appendChild(row);
    });
  }

  function setRecentSecurityEventsState(state, message) {
    const status = $("#recent-security-events-state");
    const table = $("#recent-security-events-table");
    const ready = state === "ready";
    if (status) {
      status.textContent = message;
      status.hidden = ready;
      status.className = state === "error" ? "small risk-high" : "muted small";
    }
    if (table) table.hidden = !ready;
  }

  function renderReportSummary(overview, riskDistribution) {
    const values = {
      "report-high-risk": riskDistribution?.high,
      "report-medium-risk": riskDistribution?.medium,
      "report-ad-count": overview?.ad_block_count,
      "report-ai-count": overview?.ai_check_count,
    };

    Object.entries(values).forEach(([id, value]) => {
      const element = $("#" + id);
      if (!element) return;
      const numericValue = Number(value);
      element.textContent =
        value === null || value === undefined || !Number.isFinite(numericValue)
          ? "—"
          : numericValue.toLocaleString("zh-CN");
    });

    const generatedAt = $("#report-generated-at");
    if (generatedAt) generatedAt.textContent = new Date().toLocaleString("zh-CN");
  }

  function renderReportRiskRecords(records) {
    const list = $("#report-risk-records-list");
    if (!list) return;
    list.replaceChildren();

    records.forEach((record) => {
      const item = document.createElement("li");
      const time = document.createElement("time");
      const detail = document.createElement("span");
      const type = record.type || "未知类型";
      const url = record.url || "无 URL";
      const reason = record.reason || "无风险说明";

      time.textContent = formatRiskLogTime(record.time);
      detail.textContent =
        type + " · " + formatRiskLevel(record.risk_level) + " · " + reason + " · " + url;
      item.append(time, detail);
      list.appendChild(item);
    });
  }

  function setReportRiskRecordsState(state, message) {
    const status = $("#report-risk-records-state");
    const list = $("#report-risk-records-list");
    const ready = state === "ready";
    if (status) {
      status.textContent = message;
      status.hidden = ready;
      status.className = state === "error" ? "small risk-high" : "muted small";
    }
    if (list) list.hidden = !ready;
  }

  function formatRiskLevel(level) {
    const labels = {
      safe: "安全",
      low: "低风险",
      medium: "中风险",
      high: "高风险",
    };
    if (level === null || level === undefined) return "不适用";
    return labels[level] || String(level);
  }

  function formatRiskLogTime(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString("zh-CN");
  }

  function setRiskLogState(state, message) {
    const stateBox = $("#risk-log-state");
    const stateText = $("#risk-log-state-text");
    const retry = $("#risk-log-retry");
    const table = $("#ad-log-table");
    const showState = state !== "ready";

    if (stateBox) stateBox.hidden = !showState;
    if (stateText) stateText.textContent = message;
    if (retry) retry.hidden = state !== "error";
    if (table) table.hidden = showState;
  }

  function updateRiskLogPagination(total) {
    const totalEl = $("#risk-log-total");
    const currentPageEl = $("#risk-log-current-page");
    const totalPagesEl = $("#risk-log-total-pages");
    const prev = $("#risk-log-prev");
    const next = $("#risk-log-next");

    if (total !== undefined && totalEl) {
      totalEl.textContent = Number(total).toLocaleString("zh-CN");
    }
    if (currentPageEl) currentPageEl.textContent = String(riskLogPage);
    if (totalPagesEl) totalPagesEl.textContent = String(riskLogTotalPages);
    if (prev instanceof HTMLButtonElement) {
      prev.disabled = riskLogLoading || riskLogPage <= 1;
    }
    if (next instanceof HTMLButtonElement) {
      next.disabled =
        riskLogLoading || riskLogTotalPages === 0 || riskLogPage >= riskLogTotalPages;
    }
  }

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }

  function $all(sel, root) {
    return Array.from((root || document).querySelectorAll(sel));
  }

  function getTheme() {
    return document.documentElement.getAttribute("data-theme") || "light";
  }

  function setTheme(next) {
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch (_) {}
    updateChartsTheme();
  }

  function initTheme() {
    let t = "light";
    try {
      t = localStorage.getItem(THEME_KEY) || "light";
    } catch (_) {}
    if (t !== "light" && t !== "dark") t = "light";
    setTheme(t);
    const btn = $("#theme-toggle");
    if (btn) {
      btn.addEventListener("click", () => {
        setTheme(getTheme() === "dark" ? "light" : "dark");
      });
    }
  }

  function chartColors() {
    const dark = getTheme() === "dark";
    return {
      text: dark ? "#e5e7eb" : "#334155",
      grid: dark ? "rgba(148,163,184,0.15)" : "rgba(100,116,139,0.15)",
    };
  }

  function updateChartsTheme() {
    const c = chartColors();
    Object.values(chartRefs).forEach((ch) => {
      if (!ch || !ch.options) return;
      if (ch.options.plugins && ch.options.plugins.legend && ch.options.plugins.legend.labels) {
        ch.options.plugins.legend.labels.color = c.text;
      }
      if (ch.options.scales) {
        Object.keys(ch.options.scales).forEach((key) => {
          const s = ch.options.scales[key];
          if (!s) return;
          if (s.ticks) s.ticks.color = c.text;
          if (s.grid) s.grid.color = c.grid;
          if (s.title) s.title.color = c.text;
        });
      }
      ch.update();
    });
  }

  function showView(name) {
    $all(".view").forEach((v) => {
      const isTarget = v.getAttribute("data-view") === name;
      v.hidden = !isTarget;
      v.classList.toggle("is-visible", isTarget);
    });
    $all(".site-nav__link").forEach((b) => {
      b.classList.toggle("is-active", b.getAttribute("data-nav") === name);
    });
    if (name === "dashboard") {
      requestAnimationFrame(() => {
        if (!chartsInitialized && getVisibleDashPage() === "dash-analytics") {
          initCharts();
        }
      });
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function getVisibleDashPage() {
    const p = $(".dash-page.is-visible");
    return p ? p.getAttribute("data-dash-page") || "" : "";
  }

  function showDashPage(id) {
    $all(".dash-page").forEach((p) => {
      const on = p.getAttribute("data-dash-page") === id;
      p.hidden = !on;
      p.classList.toggle("is-visible", on);
    });
    $all(".dash-nav__item").forEach((b) => {
      b.classList.toggle("is-active", b.getAttribute("data-dash") === id);
    });
    const title = $("#dash-page-title");
    if (title) title.textContent = DASH_TITLES[id] || "控制台";
    if (id === "dash-analytics") {
      requestAnimationFrame(() => {
        if (!ensureChartLibraryAvailable()) return;
        initCharts();
      });
    }
    if (id === "dash-reports") {
      requestAnimationFrame(() => {
        if (ensureChartLibraryAvailable()) ensureReportChart();
      });
    }
    if (id === "dash-modes") {
      getModeFromBackend();
    }
  }

  function bindNav() {
    document.addEventListener("click", (e) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      const navEl = t.closest("[data-nav]");
      if (!navEl) return;
      e.preventDefault();
      const name = navEl.getAttribute("data-nav");
      if (!name) return;
      showView(name);
      if (name === "dashboard") {
        showDashPage("dash-home");
      }
    });
  }

  function bindDashNav() {
    $all(".dash-nav__item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-dash");
        if (id) showDashPage(id);
      });
    });
    document.querySelectorAll("[data-dash]").forEach((el) => {
      if (!(el instanceof HTMLElement)) return;
      if (el.classList.contains("dash-nav__item")) return;
      el.addEventListener("click", (ev) => {
        const id = el.getAttribute("data-dash");
        if (!id) return;
        ev.preventDefault();
        showView("dashboard");
        showDashPage(id);
      });
    });
  }

  function bindScrollButtons() {
    document.addEventListener("click", (e) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      const b = t.closest("[data-scroll]");
      if (!b) return;
      e.preventDefault();
      const sel = b.getAttribute("data-scroll");
      if (!sel) return;
      const el = document.querySelector(sel);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  function toast(msg) {
    const stack = $("#toast-stack");
    if (!stack) return;
    const n = document.createElement("div");
    n.className = "toast";
    n.textContent = msg;
    stack.appendChild(n);
    setTimeout(() => {
      n.style.opacity = "0";
      n.style.transform = "translateY(8px)";
      n.style.transition = "0.3s ease";
      setTimeout(() => n.remove(), 320);
    }, 2600);
  }

  function closeAuthModals() {
    const lg = $("#login-modal");
    const rg = $("#register-modal");
    if (lg) lg.hidden = true;
    if (rg) rg.hidden = true;
  }

  function openLoginModal() {
    closeSearch();
    const rg = $("#register-modal");
    if (rg) rg.hidden = true;
    const lg = $("#login-modal");
    if (lg) lg.hidden = false;
  }

  function openRegisterModal() {
    closeSearch();
    const lg = $("#login-modal");
    if (lg) lg.hidden = true;
    const rg = $("#register-modal");
    if (rg) rg.hidden = false;
  }

  function isPhoneOk(s) {
    return /^1\d{10}$/.test(String(s || "").trim());
  }

  let smsCountdownTimer = null;
  let smsDemoCode = "123456";

  function bindSmsDemo() {
    const btn = $("#reg-send-sms");
    const phoneEl = $("#reg-phone");
    const tip = $("#reg-sms-tip");
    const codeInput = $("#reg-sms-code");
    if (!(btn instanceof HTMLButtonElement)) return;

    btn.addEventListener("click", () => {
      const phone = phoneEl instanceof HTMLInputElement ? phoneEl.value.trim() : "";
      if (!isPhoneOk(phone)) {
        toast("请输入正确的 11 位手机号");
        return;
      }
      if (btn.disabled && smsCountdownTimer) return;
      smsDemoCode = String(100000 + Math.floor(Math.random() * 900000));
      if (tip) tip.textContent = "演示验证码（不会真实发短信）：" + smsDemoCode;
      if (codeInput instanceof HTMLInputElement) {
        codeInput.value = "";
        codeInput.placeholder = "请输入 " + smsDemoCode;
      }
      toast("验证码已发送（演示）");
      if (smsCountdownTimer) clearInterval(smsCountdownTimer);
      let left = 60;
      btn.disabled = true;
      btn.textContent = left + " 秒后重发";
      smsCountdownTimer = window.setInterval(() => {
        left -= 1;
        if (left <= 0) {
          if (smsCountdownTimer) clearInterval(smsCountdownTimer);
          smsCountdownTimer = null;
          btn.disabled = false;
          btn.textContent = "发送验证码";
          return;
        }
        btn.textContent = left + " 秒后重发";
      }, 1000);
    });
  }

  function bindRegTabs() {
    const tabs = $all(".reg-tab");
    const panels = $all(".reg-panel");
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const name = tab.getAttribute("data-reg-tab");
        tabs.forEach((t) => {
          const on = t.getAttribute("data-reg-tab") === name;
          t.classList.toggle("is-active", on);
          t.setAttribute("aria-selected", on ? "true" : "false");
        });
        panels.forEach((p) => {
          const on = p.getAttribute("data-reg-panel") === name;
          p.classList.toggle("is-visible", on);
          p.hidden = !on;
        });
      });
    });
  }

  function validateRegCommon() {
    const phoneEl = $("#reg-phone");
    const codeEl = $("#reg-sms-code");
    const phone = phoneEl instanceof HTMLInputElement ? phoneEl.value.trim() : "";
    const code = codeEl instanceof HTMLInputElement ? codeEl.value.trim() : "";
    if (!isPhoneOk(phone)) {
      toast("请先填写正确的手机号");
      return null;
    }
    if (!/^\d{6}$/.test(code)) {
      toast("请填写 6 位短信验证码");
      return null;
    }
    if (code !== smsDemoCode) {
      toast("验证码不正确（演示请使用提示中的 6 位数字）");
      return null;
    }
    return { phone, code };
  }

  function bindRegisterSubmits() {
    $all("[data-reg-submit]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const kind = btn.getAttribute("data-reg-submit");
        const ok = validateRegCommon();
        if (!ok) return;
        if (kind === "sms") {
          const p1 = $("#reg-sms-password");
          const p2 = $("#reg-sms-password2");
          const nick = $("#reg-nick-sms");
          if (!(p1 instanceof HTMLInputElement) || !(p2 instanceof HTMLInputElement)) return;
          const n = nick instanceof HTMLInputElement ? nick.value.trim() : "";
          if (n.length < 2) {
            toast("昵称至少 2 个字符");
            return;
          }
          if (p1.value.length < 8 || p1.value !== p2.value) {
            toast("两次密码需一致且不少于 8 位");
            return;
          }
        }
        if (kind === "pwd") {
          const p1 = $("#reg-pwd-password");
          const p2 = $("#reg-pwd-password2");
          const nick = $("#reg-nick-pwd");
          if (!(p1 instanceof HTMLInputElement) || !(p2 instanceof HTMLInputElement)) return;
          const n = nick instanceof HTMLInputElement ? nick.value.trim() : "";
          if (n.length < 2) {
            toast("昵称至少 2 个字符");
            return;
          }
          if (p1.value.length < 8 || p1.value !== p2.value) {
            toast("两次密码需一致且不少于 8 位");
            return;
          }
        }
        toast("注册成功（演示），已绑定手机号 " + ok.phone);
        closeAuthModals();
      });
    });
  }

  function bindLoginForm() {
    const form = $("#login-form");
    if (!(form instanceof HTMLFormElement)) return;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const phone = String(fd.get("login-phone") || "").trim();
      const pw = $("#login-password");
      if (!isPhoneOk(phone)) {
        toast("请输入正确的手机号");
        return;
      }
      if (!(pw instanceof HTMLInputElement) || pw.value.length < 1) {
        toast("请输入密码");
        return;
      }
      toast("登录成功（演示）");
      closeAuthModals();
    });
  }

  function bindAuthModals() {
    $("#btn-login")?.addEventListener("click", (e) => {
      e.preventDefault();
      openLoginModal();
    });
    $("#btn-register")?.addEventListener("click", (e) => {
      e.preventDefault();
      openRegisterModal();
    });
    $("#login-modal")?.addEventListener("click", (e) => {
      const t = e.target;
      if (t instanceof Element && t.hasAttribute("data-close-auth")) closeAuthModals();
    });
    $("#register-modal")?.addEventListener("click", (e) => {
      const t = e.target;
      if (t instanceof Element && t.hasAttribute("data-close-auth")) closeAuthModals();
    });
    $("#open-register-from-login")?.addEventListener("click", () => openRegisterModal());
    $("#open-login-from-register")?.addEventListener("click", () => openLoginModal());
    bindSmsDemo();
    bindRegTabs();
    bindRegisterSubmits();
    bindLoginForm();
  }

  function bindPwdToggles() {
    document.addEventListener("click", (e) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      const btn = t.closest("[data-pwd-toggle]");
      if (!(btn instanceof HTMLElement)) return;
      const id = btn.getAttribute("data-pwd-toggle");
      const input = id ? document.getElementById(id) : null;
      if (!(input instanceof HTMLInputElement)) return;
      e.preventDefault();
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.textContent = show ? "🙈" : "👁";
      btn.setAttribute("aria-label", show ? "隐藏密码" : "显示密码");
    });
  }

  function applyElderGlobal(on) {
    document.documentElement.classList.toggle("elder-global-text", !!on);
    const banner = $("#elder-global-banner");
    if (banner) banner.hidden = !on;
  }

  function applyUserDisplay(nickname, avatarSrc) {
    const nick = (nickname || "林悦").trim() || "林悦";
    const src = avatarSrc || DEFAULT_AVATAR;
    const h = $("#header-avatar");
    const d = $("#dash-user-avatar");
    const p = $("#settings-avatar-preview");
    const w = $("#dash-welcome-name");
    const dn = $("#dash-user-name");
    if (h instanceof HTMLImageElement) h.src = src;
    if (d instanceof HTMLImageElement) d.src = src;
    if (p instanceof HTMLImageElement) p.src = src;
    if (w) w.textContent = nick;
    if (dn) dn.textContent = nick + " · Pro";
  }

  function loadProfile() {
    let data = null;
    try {
      const raw = localStorage.getItem(PROFILE_KEY);
      if (raw) data = JSON.parse(raw);
    } catch (_) {}
    const nick = data && data.nickname ? data.nickname : "林悦";
    const email = data && data.email ? data.email : "";
    const avatar = data && data.avatarDataUrl ? data.avatarDataUrl : DEFAULT_AVATAR;
    applyUserDisplay(nick, avatar);
    const ne = $("#settings-nickname");
    const ee = $("#settings-email");
    const wk = $("#settings-weekly");
    const tf = $("#settings-2fa");
    if (ne instanceof HTMLInputElement) ne.value = nick;
    if (ee instanceof HTMLInputElement) ee.value = email;
    if (wk instanceof HTMLInputElement) wk.checked = data ? !!data.weekly : true;
    if (tf instanceof HTMLInputElement) tf.checked = data ? !!data.twoFa : true;
  }

  function bindProfileForm() {
    const pick = $("#settings-avatar-pick");
    const file = $("#settings-avatar-file");
    const form = $("#profile-form");
    pick?.addEventListener("click", () => file?.click());
    file?.addEventListener("change", () => {
      if (!(file instanceof HTMLInputElement) || !file.files || !file.files[0]) return;
      const f = file.files[0];
      if (f.size > 1024 * 1024) {
        toast("图片请小于 1MB");
        file.value = "";
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const url = typeof reader.result === "string" ? reader.result : "";
        if (url.length > 450000) {
          toast("图片编码过大，请换一张更小的图");
          return;
        }
        const prev = $("#settings-avatar-preview");
        if (prev instanceof HTMLImageElement) prev.src = url;
        window.__sfPendingAvatar = url;
        toast("头像已更新预览，保存后生效到顶栏与侧边栏");
      };
      reader.readAsDataURL(f);
    });
    if (!(form instanceof HTMLFormElement)) return;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const ne = $("#settings-nickname");
      const ee = $("#settings-email");
      const wk = $("#settings-weekly");
      const tf = $("#settings-2fa");
      const nick = ne instanceof HTMLInputElement ? ne.value.trim() : "林悦";
      const email = ee instanceof HTMLInputElement ? ee.value.trim() : "";
      if (nick.length < 2) {
        toast("昵称至少 2 个字符");
        return;
      }
      const cur = $("#settings-cur-password");
      const np = $("#settings-new-password");
      const n2 = $("#settings-new-password2");
      const wantPwd =
        cur instanceof HTMLInputElement &&
        np instanceof HTMLInputElement &&
        n2 instanceof HTMLInputElement &&
        (cur.value.length > 0 || np.value.length > 0 || n2.value.length > 0);
      if (wantPwd) {
        if (!(cur instanceof HTMLInputElement) || cur.value.length < 1) {
          toast("修改密码需填写当前密码（演示任意非空即可）");
          return;
        }
        if (!(np instanceof HTMLInputElement) || np.value.length < 8) {
          toast("新密码至少 8 位");
          return;
        }
        if (!(n2 instanceof HTMLInputElement) || np.value !== n2.value) {
          toast("两次新密码不一致");
          return;
        }
      }
      let avatarDataUrl = null;
      try {
        const prev = localStorage.getItem(PROFILE_KEY);
        if (prev) {
          const o = JSON.parse(prev);
          if (o && o.avatarDataUrl) avatarDataUrl = o.avatarDataUrl;
        }
      } catch (_) {}
      if (typeof window.__sfPendingAvatar === "string" && window.__sfPendingAvatar.indexOf("data:") === 0) {
        avatarDataUrl = window.__sfPendingAvatar;
      }
      const payload = {
        nickname: nick,
        email: email || "",
        avatarDataUrl: avatarDataUrl || null,
        weekly: wk instanceof HTMLInputElement ? wk.checked : true,
        twoFa: tf instanceof HTMLInputElement ? tf.checked : true,
      };
      try {
        localStorage.setItem(PROFILE_KEY, JSON.stringify(payload));
      } catch (err) {
        toast("保存失败：本地存储空间不足，请缩小头像图片");
        return;
      }
      applyUserDisplay(nick, avatarDataUrl || DEFAULT_AVATAR);
      window.__sfPendingAvatar = null;
      if (wantPwd && cur instanceof HTMLInputElement && np instanceof HTMLInputElement) {
        cur.value = "";
        np.value = "";
        if (n2 instanceof HTMLInputElement) n2.value = "";
      }
      toast("个人信息已保存（本地演示）");
    });
  }

  function openSearch() {
    const pop = $("#search-pop");
    if (!pop) return;
    pop.hidden = false;
    const input = $(".search-pop__input", pop);
    if (input instanceof HTMLInputElement) input.focus();
  }

  function closeSearch() {
    const pop = $("#search-pop");
    if (pop) pop.hidden = true;
  }

  function bindSearch() {
    $("#btn-global-search")?.addEventListener("click", openSearch);
    $("#btn-dash-search")?.addEventListener("click", openSearch);
    $("#search-pop")?.addEventListener("click", (e) => {
      const t = e.target;
      if (t instanceof Element && t.hasAttribute("data-close-search")) closeSearch();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        closeSearch();
        closeAuthModals();
      }
    });
  }

  function bindModal() {
    const modal = $("#risk-modal");
    const open = () => {
      if (modal) modal.hidden = false;
    };
    const close = () => {
      if (modal) modal.hidden = true;
    };
    modal?.addEventListener("click", (e) => {
      const t = e.target;
      if (t instanceof Element && t.hasAttribute("data-close-modal")) close();
    });
    $("#risk-modal-confirm")?.addEventListener("click", () => {
      close();
    });
    $("#btn-notify")?.addEventListener("click", () => {
      open();
      const body = $("#risk-modal-body");
      if (body) body.textContent = "实时风险信息请以最近安全事件与风险日志为准。";
    });
  }

  function animateCounters() {
    $all("[data-counter]").forEach((el) => {
      const target = parseInt(el.getAttribute("data-counter") || "0", 10);
      const dur = 1400;
      const t0 = performance.now();
      function frame(now) {
        const p = Math.min(1, (now - t0) / dur);
        const eased = 1 - Math.pow(1 - p, 3);
        const val = Math.floor(target * eased);
        el.textContent = val.toLocaleString("zh-CN");
        if (p < 1) requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    });
  }

  function normalizeSharedSettings(raw = {}) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("设置状态无效");
    }

    const rawMode = ["normal", "strict", "elder", "child"].includes(raw.mode)
      ? raw.mode
      : "normal";
    const childRequested = rawMode === "child" || raw.child_mode === true;
    const elderRequested = rawMode === "elder" || raw.elder_mode === true;
    const mode = childRequested
      ? "child"
      : elderRequested
        ? "elder"
        : rawMode === "strict"
          ? "strict"
          : "normal";

    return {
      mode,
      elder_mode: mode === "elder",
      child_mode: mode === "child",
      paused: raw.paused === true,
    };
  }

  function normalizeSettingsResponse(response) {
    if (!response || response.code !== 0 || !response.data) {
      throw new Error(response?.message || "设置接口响应无效");
    }

    const data = response.data;
    if (!["normal", "strict", "elder", "child"].includes(data.mode)) {
      throw new Error("设置接口返回了不支持的 mode");
    }
    if (
      typeof data.elder_mode !== "boolean" ||
      typeof data.child_mode !== "boolean" ||
      typeof data.paused !== "boolean"
    ) {
      throw new Error("设置接口返回字段不完整");
    }

    return normalizeSharedSettings(data);
  }

  function createSettingsPayload(settings) {
    const normalized = normalizeSharedSettings(settings);
    return {
      mode: normalized.mode,
      elder_mode: normalized.elder_mode,
      child_mode: normalized.child_mode,
      paused: normalized.paused,
    };
  }

  function transitionSharedSettings(settings, nextMode, enabled = true) {
    const current = normalizeSharedSettings(settings);
    if (nextMode === "normal" || nextMode === "strict") {
      return normalizeSharedSettings({
        mode: nextMode,
        elder_mode: false,
        child_mode: false,
        paused: current.paused,
      });
    }
    if (nextMode !== "elder" && nextMode !== "child") {
      return current;
    }
    if (!enabled) {
      return current.mode === nextMode
        ? normalizeSharedSettings({
            mode: "normal",
            elder_mode: false,
            child_mode: false,
            paused: current.paused,
          })
        : current;
    }
    return normalizeSharedSettings({
      mode: nextMode,
      elder_mode: nextMode === "elder",
      child_mode: nextMode === "child",
      paused: current.paused,
    });
  }

  function setSettingsRequestState(state, message) {
    const status = $("#settings-api-state");
    const statusText = $("#settings-api-state-text");
    const retry = $("#settings-api-retry");
    const form = $("#security-settings-form");
    const save = $("#settings-api-save");
    const editable = state === "ready" || state === "save-error";
    const showForm = state !== "loading" && state !== "error";

    if (status) status.hidden = state === "ready";
    if (statusText) statusText.textContent = message || "";
    if (retry instanceof HTMLButtonElement) retry.hidden = state !== "error";
    if (form instanceof HTMLFormElement) form.hidden = !showForm;
    $all(".mode-card").forEach((card) => {
      if (card instanceof HTMLButtonElement) card.disabled = !editable;
    });
    ["settings-elder-mode", "settings-child-mode", "settings-paused"].forEach((id) => {
      const input = $("#" + id);
      if (input instanceof HTMLInputElement) input.disabled = !editable;
    });
    if (save instanceof HTMLButtonElement) {
      save.disabled = !editable;
      save.textContent = state === "saving" ? "保存中…" : "保存设置";
    }
  }

  function updateSettingsPreviews() {
    const elderToggle = $("#settings-elder-mode");
    const childToggle = $("#settings-child-mode");
    const elderOn = elderToggle instanceof HTMLInputElement && elderToggle.checked;
    const childOn = childToggle instanceof HTMLInputElement && childToggle.checked;
    const elderPreview = $("#mode-preview-elder");
    const childPreview = $("#mode-preview-child");

    if (elderPreview) elderPreview.hidden = !elderOn;
    if (childPreview) childPreview.hidden = !childOn;
    applyElderGlobal(elderOn);
  }

  function setModeUI(mode) {
    $all(".mode-card").forEach((card) => {
      card.classList.toggle("is-active", card.getAttribute("data-mode") === mode);
    });
    const text = $("#mode-detail-text");
    if (text) {
      text.textContent = MODE_COPY[mode] || "选择普通模式或严格模式查看策略说明。";
    }
  }

  function applySettingsToUI(settings) {
    const normalized = normalizeSharedSettings(settings);
    currentMode = normalized.mode;
    setModeUI(currentMode);

    const elderMode = $("#settings-elder-mode");
    const childMode = $("#settings-child-mode");
    const paused = $("#settings-paused");
    if (elderMode instanceof HTMLInputElement) elderMode.checked = normalized.elder_mode;
    if (childMode instanceof HTMLInputElement) childMode.checked = normalized.child_mode;
    if (paused instanceof HTMLInputElement) paused.checked = normalized.paused;
    updateSettingsPreviews();
    return normalized;
  }

  function readSettingsFromUI() {
    const elderMode = $("#settings-elder-mode");
    const childMode = $("#settings-child-mode");
    const paused = $("#settings-paused");
    if (
      !["normal", "strict", "elder", "child"].includes(currentMode) ||
      !(elderMode instanceof HTMLInputElement) ||
      !(childMode instanceof HTMLInputElement) ||
      !(paused instanceof HTMLInputElement)
    ) {
      throw new Error("设置页面状态无效，请重新加载");
    }
    return normalizeSharedSettings({
      mode: currentMode,
      elder_mode: elderMode.checked,
      child_mode: childMode.checked,
      paused: paused.checked,
    });
  }

  async function getModeFromBackend(options = {}) {
    const background = options.background === true;
    if (settingsSaving || settingsLoading || settingsRefreshPromise) return null;

    const generation = ++settingsRequestGeneration;
    if (!background) {
      settingsLoading = true;
      setSettingsRequestState("loading", "加载设置中");
    }

    const operation = (async () => {
      try {
        const response = await api.get("/api/settings");
        const nextSettings = normalizeSettingsResponse(response);
        if (generation !== settingsRequestGeneration || settingsSaving) {
          return null;
        }
        currentSettings = nextSettings;
        applySettingsToUI(currentSettings);
        setSettingsRequestState("ready", "");
        return currentSettings;
      } catch (error) {
        if (generation !== settingsRequestGeneration || settingsSaving) {
          return null;
        }
        console.error("Failed to load settings:", error);
        if (currentSettings) {
          setSettingsRequestState(
            "save-error",
            "设置同步失败：暂时无法获取最新设置，当前显示最近一次已知状态"
          );
        } else {
          currentSettings = null;
          currentMode = null;
          setModeUI(null);
          applyElderGlobal(false);
          setSettingsRequestState("error", "设置加载失败，请重试");
        }
        return null;
      } finally {
        if (!background) settingsLoading = false;
      }
    })();

    settingsRefreshPromise = operation;
    try {
      return await operation;
    } finally {
      if (settingsRefreshPromise === operation) {
        settingsRefreshPromise = null;
      }
    }
  }

  async function setModeToBackend(settings) {
    const payload = createSettingsPayload(settings);
    const response = await api.post("/api/settings", payload);
    return normalizeSettingsResponse(response);
  }

  async function refreshVisibleSettings() {
    if (getVisibleDashPage() !== "dash-modes" || settingsSaving) return null;
    return getModeFromBackend({ background: true });
  }

  function bindModes() {
    setSettingsRequestState("loading", "加载设置中");
    $all(".mode-card").forEach((card) => {
      card.addEventListener("click", () => {
        const mode = card.getAttribute("data-mode");
        if (mode !== "normal" && mode !== "strict") return;
        const nextSettings = transitionSharedSettings(
          readSettingsFromUI(),
          mode
        );
        applySettingsToUI(nextSettings);
      });
    });

    ["elder", "child"].forEach((mode) => {
      const id = mode === "elder" ? "settings-elder-mode" : "settings-child-mode";
      const input = $("#" + id);
      if (input instanceof HTMLInputElement) {
        input.addEventListener("change", () => {
          const nextSettings = transitionSharedSettings(
            readSettingsFromUI(),
            mode,
            input.checked
          );
          applySettingsToUI(nextSettings);
        });
      }
    });

    const paused = $("#settings-paused");
    if (paused instanceof HTMLInputElement) {
      paused.addEventListener("change", () => {
        const nextSettings = readSettingsFromUI();
        applySettingsToUI(
          normalizeSharedSettings({
            ...nextSettings,
            paused: paused.checked,
          })
        );
      });
    }

    const retry = $("#settings-api-retry");
    if (retry instanceof HTMLButtonElement) {
      retry.addEventListener("click", getModeFromBackend);
    }

    const form = $("#security-settings-form");
    if (form instanceof HTMLFormElement) {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!currentSettings || settingsLoading || settingsSaving) return;
        const previousSettings = { ...currentSettings };
        const generation = ++settingsRequestGeneration;
        try {
          const nextSettings = normalizeSharedSettings(readSettingsFromUI());
          settingsSaving = true;
          setSettingsRequestState("saving", "保存设置中…");
          const savedSettings = await setModeToBackend(nextSettings);
          if (generation !== settingsRequestGeneration) return;
          currentSettings = savedSettings;
          applySettingsToUI(currentSettings);
          setSettingsRequestState("ready", "");
          toast("保护设置已保存，并会与浏览器扩展自动同步");
        } catch (error) {
          if (generation !== settingsRequestGeneration) return;
          console.error("Failed to save settings:", error);
          currentSettings = previousSettings;
          applySettingsToUI(previousSettings);
          setSettingsRequestState("save-error", "设置保存失败，已恢复原状态");
          toast("设置保存失败，请稍后重试");
        } finally {
          settingsSaving = false;
        }
      });
    }

    document.addEventListener("click", (e) => {
      const t = e.target;
      if (t instanceof Element && t.classList.contains("elder-preview__cta")) {
        e.preventDefault();
        toast("已为老人设备强化防护");
      }
    });
  }

  function bindElderFontToggle() {
    const sw = document.querySelector('[data-toggle="elder-font"]');
    const preview = document.querySelector(".elder-preview");
    if (!(sw instanceof HTMLInputElement) || !preview) return;
    const apply = () => preview.classList.toggle("elder-preview--mega", sw.checked);
    sw.addEventListener("change", apply);
    apply();
  }

  function setAiScanState(state, message) {
    const status = $("#ai-scan-status");
    const submit = $("#btn-ai-scan");
    const urlInput = $("#ai-scan-url");
    const contentInput = $("#ai-scan-content");
    const loading = state === "loading";

    if (status) {
      status.hidden = !message;
      status.textContent = message || "";
      status.className =
        state === "error" || state === "retry" ? "small risk-high" : "muted small";
    }
    if (submit instanceof HTMLButtonElement) {
      submit.disabled = loading;
      submit.textContent = loading
        ? "扫描中…"
        : state === "retry"
          ? "重试扫描"
          : "运行快速扫描";
    }
    if (urlInput instanceof HTMLInputElement) urlInput.disabled = loading;
    if (contentInput instanceof HTMLTextAreaElement) contentInput.disabled = loading;
  }

  function generateAiScanEventUuid() {
    const cryptoApi = window.crypto;
    if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
      return cryptoApi.randomUUID();
    }
    if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
      const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"));
      return [
        hex.slice(0, 4).join(""),
        hex.slice(4, 6).join(""),
        hex.slice(6, 8).join(""),
        hex.slice(8, 10).join(""),
        hex.slice(10, 16).join(""),
      ].join("-");
    }
    throw new Error("当前浏览器不支持生成安全的扫描标识，请升级后重试");
  }

  function getAiScanAttempt(url, content) {
    if (
      pendingAiScan &&
      pendingAiScan.url === url &&
      pendingAiScan.content === content
    ) {
      return pendingAiScan;
    }

    pendingAiScan = {
      eventUuid: generateAiScanEventUuid(),
      url,
      content,
    };
    return pendingAiScan;
  }

  function isRetryableAiScanError(error) {
    const status = Number(error?.status);
    return !Number.isFinite(status) || status === 0 || (status >= 500 && status < 600);
  }

  function handleAiScanInputChange() {
    if (!pendingAiScan || aiScanLoading) return;
    const urlInput = $("#ai-scan-url");
    const contentInput = $("#ai-scan-content");
    if (!(urlInput instanceof HTMLInputElement) || !(contentInput instanceof HTMLTextAreaElement)) {
      return;
    }
    if (
      urlInput.value.trim() !== pendingAiScan.url ||
      contentInput.value !== pendingAiScan.content
    ) {
      pendingAiScan = null;
      setAiScanState("idle", "");
    }
  }

  function renderAiScanResult(data) {
    const riskLabels = {
      safe: "安全",
      low: "低风险",
      medium: "中风险",
      high: "高风险",
    };
    const riskClasses = {
      safe: "risk-low",
      low: "risk-low",
      medium: "risk-mid",
      high: "risk-high",
    };
    const result = $("#ai-scan-result");
    const riskLevel = $("#ai-scan-risk-level");
    const score = $("#ai-scan-score");
    const reason = $("#ai-scan-reason");

    if (result) result.hidden = false;
    if (riskLevel) {
      riskLevel.textContent = riskLabels[data.risk_level];
      riskLevel.className = riskClasses[data.risk_level];
    }
    if (score) score.textContent = String(data.score);
    if (reason) reason.textContent = data.reason;
  }

  async function runAiRiskScan() {
    if (aiScanLoading) return;
    const urlInput = $("#ai-scan-url");
    const contentInput = $("#ai-scan-content");
    const result = $("#ai-scan-result");
    if (!(urlInput instanceof HTMLInputElement) || !(contentInput instanceof HTMLTextAreaElement)) {
      return;
    }

    const url = urlInput.value.trim();
    const content = contentInput.value;
    if (!url) {
      setAiScanState("error", "请输入需要检测的 URL");
      urlInput.focus();
      return;
    }

    let scanAttempt;
    try {
      scanAttempt = getAiScanAttempt(url, content);
    } catch (error) {
      setAiScanState("error", error?.message || "无法创建扫描请求");
      return;
    }

    aiScanLoading = true;
    if (result) result.hidden = true;
    setAiScanState("loading", "扫描中，请稍候…");
    try {
      const response = await api.post("/api/risk/check", {
        event_uuid: scanAttempt.eventUuid,
        url: scanAttempt.url,
        content: scanAttempt.content,
        source: "ui",
      });
      const data = response?.data;
      if (
        !response ||
        response.code !== 0 ||
        !data ||
        !["safe", "low", "medium", "high"].includes(data.risk_level) ||
        !Number.isFinite(Number(data.score)) ||
        typeof data.reason !== "string"
      ) {
        throw new Error(response?.message || "风险检测接口响应无效");
      }

      renderAiScanResult(data);
      pendingAiScan = null;
      setAiScanState("success", "扫描完成");
      try {
        await loadDataAndUpdateUI();
      } catch (refreshError) {
        console.error("Failed to refresh Dashboard after AI scan:", refreshError);
      }
    } catch (error) {
      console.error("AI risk scan failed:", error);
      if (result) result.hidden = true;
      const retryable = isRetryableAiScanError(error);
      if (!retryable) pendingAiScan = null;
      const message =
        typeof error?.message === "string" && error.message
          ? error.message
          : "网络请求失败，请稍后重试";
      setAiScanState(
        retryable ? "retry" : "error",
        retryable ? message + "；可重试本次扫描" : message
      );
    } finally {
      aiScanLoading = false;
      const submit = $("#btn-ai-scan");
      const currentUrlInput = $("#ai-scan-url");
      const currentContentInput = $("#ai-scan-content");
      if (submit instanceof HTMLButtonElement) submit.disabled = false;
      if (currentUrlInput instanceof HTMLInputElement) currentUrlInput.disabled = false;
      if (currentContentInput instanceof HTMLTextAreaElement) currentContentInput.disabled = false;
    }
  }

  function bindQuickActions() {
    $("#ai-scan-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      runAiRiskScan();
    });
    $("#ai-scan-url")?.addEventListener("input", handleAiScanInputChange);
    $("#ai-scan-content")?.addEventListener("input", handleAiScanInputChange);
    $("#quick-risk-scan")?.addEventListener("click", () => {
      requestAnimationFrame(() => {
        const form = $("#ai-scan-form");
        const urlInput = $("#ai-scan-url");
        form?.scrollIntoView({ behavior: "smooth", block: "center" });
        if (urlInput instanceof HTMLInputElement) {
          urlInput.focus({ preventScroll: true });
        }
      });
    });
    $("#btn-dash-settings")?.addEventListener("click", () => {
      showDashPage("dash-settings");
    });
  }

  function bindRiskLogControls() {
    $("#risk-log-prev")?.addEventListener("click", () => {
      if (!riskLogLoading && riskLogPage > 1) {
        fetchRiskLogs(riskLogPage - 1);
      }
    });
    $("#risk-log-next")?.addEventListener("click", () => {
      if (!riskLogLoading && riskLogPage < riskLogTotalPages) {
        fetchRiskLogs(riskLogPage + 1);
      }
    });
    $("#risk-log-retry")?.addEventListener("click", () => {
      if (!riskLogLoading) fetchRiskLogs(riskLogRequestedPage);
    });
  }

  function ensureReportChart() {
    if (!ensureChartLibraryAvailable()) return;
    const reportBar = $("#chart-report-bar");
    if (!(reportBar instanceof HTMLCanvasElement)) return;
    if (statisticsStatus === "error") {
      setChartEmptyState(
        "chart-report-bar",
        "chart-report-bar-status",
        "reportBar",
        "报告数据暂时无法加载。",
        "error"
      );
      return;
    }
    if (statisticsStatus !== "ready") {
      setChartLoadingState("chart-report-bar", "chart-report-bar-status");
      return;
    }
    if (!statisticsData || isReportChartEmpty(statisticsData)) {
      setChartEmptyState(
        "chart-report-bar",
        "chart-report-bar-status",
        "reportBar",
        "暂无报告数据。"
      );
      return;
    }

    const data = [
      statisticsData.ad_block_count ?? 0,
      statisticsData.url_check_count ?? 0,
      statisticsData.ai_check_count ?? 0,
      statisticsData.high_risk_count ?? 0,
    ];
    const colors = chartColors();
    setChartEmptyState("chart-report-bar", "chart-report-bar-status", "reportBar", "");

    if (chartRefs.reportBar) {
      chartRefs.reportBar.data.datasets[0].data = data;
      chartRefs.reportBar.options.scales.x.ticks.color = colors.text;
      chartRefs.reportBar.options.scales.x.grid.color = colors.grid;
      chartRefs.reportBar.options.scales.y.ticks.color = colors.text;
      chartRefs.reportBar.options.scales.y.grid.color = colors.grid;
      chartRefs.reportBar.update();
      chartRefs.reportBar.resize();
      return;
    }

    chartRefs.reportBar = new window.Chart(reportBar, {
      type: "bar",
      data: {
        labels: ["广告拦截", "URL 检测", "AI 检测", "高风险"],
        datasets: [
          {
            label: "事件数",
            data,
            backgroundColor: ["#6366f1", "#22d3ee", "#f97316", "#ef4444"],
            borderRadius: 8,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: colors.text }, grid: { color: colors.grid } },
          y: { ticks: { color: colors.text }, grid: { color: colors.grid } },
        },
      },
    });
  }

  function initCharts() {
    if (!ensureChartLibraryAvailable()) return;
    chartsInitialized = true;
    const Chart = window.Chart;
    const c = chartColors();

    const commonOpts = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: c.text } } },
      scales: {
        x: { ticks: { color: c.text }, grid: { color: c.grid } },
        y: { ticks: { color: c.text }, grid: { color: c.grid } },
      },
    };

    const pieCtx = $("#chart-risk-pie");
    if (pieCtx instanceof HTMLCanvasElement) {
      if (riskDistributionStatus === "error") {
        setChartEmptyState(
          "chart-risk-pie",
          "chart-risk-status",
          "pie",
          "风险分布数据暂时无法加载。",
          "error"
        );
      } else if (riskDistributionStatus !== "ready") {
        setChartLoadingState("chart-risk-pie", "chart-risk-status");
      } else if (!riskDistributionData || isRiskDistributionEmpty(riskDistributionData)) {
        setChartEmptyState(
          "chart-risk-pie",
          "chart-risk-status",
          "pie",
          "暂无风险分布数据。"
        );
      } else {
        if (chartRefs.pie) chartRefs.pie.destroy();
        setChartEmptyState("chart-risk-pie", "chart-risk-status", "pie", "");
        chartRefs.pie = new Chart(pieCtx, {
          type: "doughnut",
          data: {
            labels: ["安全", "低危", "中危", "高危"],
            datasets: [
              {
                data: [
                  riskDistributionData.safe ?? 0,
                  riskDistributionData.low ?? 0,
                  riskDistributionData.medium ?? 0,
                  riskDistributionData.high ?? 0,
                ],
                backgroundColor: ["#22c55e", "#3b82f6", "#f59e0b", "#ef4444"],
                borderWidth: 0,
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: "bottom", labels: { color: c.text, padding: 14 } } },
          },
        });
      }
    }

    const barCtx = $("#chart-ai-bar");
    if (barCtx instanceof HTMLCanvasElement) {
      if (statisticsStatus === "error") {
        setChartEmptyState(
          "chart-ai-bar",
          "chart-ai-status",
          "bar",
          "AI 检测数据暂时无法加载。",
          "error"
        );
      } else if (statisticsStatus !== "ready") {
        setChartLoadingState("chart-ai-bar", "chart-ai-status");
      } else if (!statisticsData || isAiChartEmpty(statisticsData)) {
        setChartEmptyState(
          "chart-ai-bar",
          "chart-ai-status",
          "bar",
          "暂无 AI 检测数据。"
        );
      } else {
        if (chartRefs.bar) chartRefs.bar.destroy();
        setChartEmptyState("chart-ai-bar", "chart-ai-status", "bar", "");
        const aiCount = statisticsData.ai_check_count ?? 0;
        chartRefs.bar = new Chart(barCtx, {
          type: "bar",
          data: {
            labels: ["AI 检测"],
            datasets: [
              {
                label: "检测次数",
                data: [aiCount],
                borderRadius: 8,
                backgroundColor: ["#6366f1"],
              },
            ],
          },
          options: { ...commonOpts, plugins: { legend: { display: false } } },
        });
      }
    }

    const lineCtx = $("#chart-ads-line");
    if (lineCtx instanceof HTMLCanvasElement) {
      if (dashboardTrendStatus === "error") {
        setChartEmptyState(
          "chart-ads-line",
          "chart-trend-status",
          "line",
          "趋势数据暂时无法加载。",
          "error"
        );
      } else if (dashboardTrendStatus !== "ready") {
        setChartLoadingState("chart-ads-line", "chart-trend-status");
      } else if (!dashboardTrendData || dashboardTrendData.dates.length === 0) {
        setChartEmptyState(
          "chart-ads-line",
          "chart-trend-status",
          "line",
          "暂无趋势数据。"
        );
      } else {
        if (chartRefs.line) chartRefs.line.destroy();
        setChartEmptyState("chart-ads-line", "chart-trend-status", "line", "");
        chartRefs.line = new Chart(lineCtx, {
          type: "line",
          data: {
            labels: dashboardTrendData.dates,
            datasets: [
              {
                label: "风险事件",
                data: dashboardTrendData.risk_counts,
                tension: 0.35,
                fill: false,
                borderColor: "#ef4444",
                pointRadius: 3,
                pointBackgroundColor: "#ef4444",
              },
              {
                label: "广告拦截",
                data: dashboardTrendData.ad_counts,
                tension: 0.35,
                fill: true,
                backgroundColor: "rgba(99,102,241,0.12)",
                borderColor: "#6366f1",
                pointRadius: 3,
                pointBackgroundColor: "#22d3ee",
              },
            ],
          },
          options: { ...commonOpts, plugins: { legend: { labels: { color: c.text } } } },
        });
      }
    }

    const stackCtx = $("#chart-report-stack");
    if (stackCtx instanceof HTMLCanvasElement) {
      if (dashboardTrendStatus === "error") {
        setChartEmptyState(
          "chart-report-stack",
          "chart-report-stack-status",
          "stack",
          "事件分析数据暂时无法加载。",
          "error"
        );
      } else if (dashboardTrendStatus !== "ready") {
        setChartLoadingState("chart-report-stack", "chart-report-stack-status");
      } else if (!dashboardTrendData || dashboardTrendData.dates.length === 0) {
        setChartEmptyState(
          "chart-report-stack",
          "chart-report-stack-status",
          "stack",
          "暂无事件分析数据。"
        );
      } else {
        if (chartRefs.stack) chartRefs.stack.destroy();
        setChartEmptyState(
          "chart-report-stack",
          "chart-report-stack-status",
          "stack",
          ""
        );
        chartRefs.stack = new Chart(stackCtx, {
          type: "bar",
          data: {
            labels: dashboardTrendData.dates,
            datasets: [
              { label: "风险事件", data: dashboardTrendData.risk_counts, backgroundColor: "#ef4444", borderRadius: 6 },
              { label: "广告拦截", data: dashboardTrendData.ad_counts, backgroundColor: "#6366f1", borderRadius: 6 },
            ],
          },
          options: {
            ...commonOpts,
            scales: {
              x: { stacked: true, ticks: { color: c.text }, grid: { display: false } },
              y: { stacked: true, ticks: { color: c.text }, grid: { color: c.grid } },
            },
          },
        });
      }
    }

    ensureReportChart();

    updateChartsTheme();
  }

  async function runDataRefreshOnce() {
    updateCountersWithData(null);
    setDashboardOverviewStatus("Dashboard 数据加载中…", "loading");
    renderReportSummary(null, null);
    setReportSummaryStatus("报告数据加载中…", "loading");
    [
      ["chart-risk-pie", "chart-risk-status"],
      ["chart-ai-bar", "chart-ai-status"],
      ["chart-ads-line", "chart-trend-status"],
      ["chart-report-stack", "chart-report-stack-status"],
      ["chart-report-bar", "chart-report-bar-status"],
    ].forEach(([canvasId, statusId]) => setChartLoadingState(canvasId, statusId));

    await Promise.all([
      fetchStatistics(),
      fetchDashboardTrend(7),
      fetchRiskDistribution(),
      fetchRecentRiskRecords(),
    ]);
    updateCountersWithData(statisticsData);
    renderReportSummary(statisticsData, riskDistributionData);
    setReportSummaryStatus(
      statisticsData && riskDistributionData ? "" : "报告 KPI 数据暂时无法完整加载。",
      statisticsData && riskDistributionData ? "" : "error"
    );

    if (ensureChartLibraryAvailable()) {
      if (getVisibleDashPage() === "dash-analytics") {
        initCharts();
      }
      if (getVisibleDashPage() === "dash-reports") {
        ensureReportChart();
      }
    }

    await fetchRiskLogs(riskLogPage);
    await refreshVisibleSettings();
  }

  async function loadDataAndUpdateUI() {
    if (dashboardRefreshPromise) {
      dashboardRefreshQueued = true;
      return dashboardRefreshPromise;
    }

    dashboardRefreshPromise = (async () => {
      do {
        dashboardRefreshQueued = false;
        try {
          await runDataRefreshOnce();
        } catch (error) {
          console.error("Failed to refresh Dashboard data:", error);
        }
      } while (dashboardRefreshQueued);
    })();

    try {
      await dashboardRefreshPromise;
    } finally {
      dashboardRefreshPromise = null;
    }
  }

  async function init() {
    initTheme();
    bindNav();
    bindDashNav();
    bindScrollButtons();
    bindAuthModals();
    bindPwdToggles();
    loadProfile();
    bindProfileForm();
    bindSearch();
    bindModal();
    bindQuickActions();
    bindRiskLogControls();
    await bindModes();
    bindElderFontToggle();

    showView("home");
    showDashPage("dash-home");

    loadDataAndUpdateUI();

    const obs = new IntersectionObserver(
      (entries) => {
        entries.forEach((en) => {
          if (en.isIntersecting) animateCounters();
        });
      },
      { threshold: 0.25 }
    );
    const metrics = $("#home-metrics");
    if (metrics) obs.observe(metrics);

    window.addEventListener("load", () => {
      if (getVisibleDashPage() === "dash-analytics" && !chartsInitialized) {
        initCharts();
      }
    });

    setInterval(loadDataAndUpdateUI, 30000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
