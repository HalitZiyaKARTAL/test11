/*
 * ChatGPT Prompt / Full-Chat Extractor V3.0.1 — 2026-07-15
 *
 * Paste this entire file into DevTools Console while a ChatGPT conversation is
 * open, or save it as a DevTools Snippet. It scans the currently selected DOM
 * branch only, makes no network requests, changes no chat data, restores the
 * original scroll position, and downloads pretty JSON inside a unique .txt file.
 *
 * V3 is mutation-first: scrolling never waits for requestAnimationFrame.
 */
(() => {
  // ========================== EDIT THESE ==========================
  const INCLUDE_MODEL_MESSAGES = true;  // true: user + assistant; false: prompts only
  const EXPECTED_USER_PROMPTS = null;    // e.g. 145; null: discover automatically
  const CHAT_TITLE_OVERRIDE = "";        // blank: use the live browser-tab/chat title
  const INCLUDE_MESSAGE_HTML = false;    // true only for a larger exact DOM archive
  const FORCE_CONSERVATIVE_PASS = false; // true: always run the slower overlap verifier
  const INCLUDE_DEBUG_LOG = true;        // bounded move/performance diagnostics
  const RESTORE_ORIGINAL_SCROLL = true;  // false: leave the chat at the verified bottom
  const STARTUP_WAIT_MS = 20000;         // tolerate ChatGPT's temporarily empty virtual DOM
  // ================================================================

  const NAME = "ChatGPTPromptExtractorV3";
  const VERSION = "3.0.1";
  const MESSAGE_SELECTOR = "[data-message-author-role]";

  const DEFAULTS = {
    includeModelMessages: INCLUDE_MODEL_MESSAGES,
    expectedUserPrompts: EXPECTED_USER_PROMPTS,
    chatTitleOverride: CHAT_TITLE_OVERRIDE,
    includeMessageHtml: INCLUDE_MESSAGE_HTML,
    forceConservativePass: FORCE_CONSERVATIVE_PASS,
    includeDebugLog: INCLUDE_DEBUG_LOG,

    includeOtherRoles: false,
    includeLinks: true,
    includeMedia: true,
    includeMediaUrls: true,
    restoreScroll: RESTORE_ORIGINAL_SCROLL,
    autoDownload: true,

    startupWaitMs: STARTUP_WAIT_MS,
    startupPollMs: 100,
    startupWakeAfterMs: 600,
    startupWakeEveryMs: 900,

    debugEventLimit: 900,
    moveSampleLimit: 1200,
    slowMoveCount: 25,

    frontierOverlapViewports: 0.18,
    fastStepViewports: 0.82,
    fallbackStepViewports: 0.50,
    geometryGapViewports: 0.22,
    adaptiveOverlapSteps: 3,

    pollIntervalMs: 18,
    minimumSettleMs: 28,
    mutationQuietMs: 36,
    unchangedSettleMs: 95,
    maximumSettleMs: 750,
    edgeSettleMs: 650,
    bottomSettleMs: 900,
    topConfirmMs: 75,
    restoreSettleMs: 45,
    bottomRecheckMs: 110,
    bottomStableChecks: 3,
    bottomGeometryFallbackChecks: 6,
    bottomVisibilityToleranceViewports: 0.18,
    timerLagWarningMs: 250,

    maximumMovesPerPass: 6000,
    maximumRuntimeMs: 20 * 60 * 1000,
    progressEveryMessages: 25,
    progressEveryMs: 12000
  };

  const previous = window[NAME];
  if (previous?.running) {
    console.warn(`[${NAME}] Already running. Use ${NAME}.stop() first.`);
    return;
  }

  let activeController = null;
  let activeContext = null;

  const api = window[NAME] = {
    version: VERSION,
    running: false,
    lastResult: previous?.lastResult || null,
    lastPartial: previous?.lastPartial || null,
    lastDebug: previous?.lastDebug || null,
    lastDownloadMetrics: previous?.lastDownloadMetrics || null,
    lastScroller: previous?.lastScroller || null,
    lastError: null,
    run,
    stop() {
      if (!activeController) return false;
      activeController.abort("Stopped by user");
      return true;
    },
    download() {
      if (!api.lastResult) throw Error("No completed extraction is cached.");
      return download(api.lastResult);
    },
    downloadPartial() {
      if (!api.lastPartial) throw Error("No partial extraction is cached.");
      return download(api.lastPartial);
    },
    readable() {
      if (!api.lastResult) throw Error("No completed extraction is cached.");
      return readable(api.lastResult);
    },
    partialSummary() {
      if (!activeContext && !api.lastPartial) return null;
      const context = activeContext;
      return context ? {
        phase: context.phase,
        elapsed_ms: Math.round(performance.now() - context.startedPerformance),
        saved_messages: context.records.size,
        all_roles_seen: context.coverage.size,
        scroll_percent: percent(context.port)
      } : {
        phase: api.lastPartial.failure?.phase || null,
        saved_messages: api.lastPartial.counts?.saved_messages || 0,
        all_roles_seen: api.lastPartial.counts?.all_roles_seen || 0
      };
    }
  };

  function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
  }

  function rounded(value, digits = 3) {
    return Number(Number(value || 0).toFixed(digits));
  }

  function percent(port) {
    return rounded(port.max ? port.top / port.max * 100 : 100, 2);
  }

  function abortError(reason = "Extraction stopped") {
    return new DOMException(String(reason), "AbortError");
  }

  function check(context) {
    if (context.signal.aborted) throw abortError(context.signal.reason);
    if (location.pathname !== context.conversationPath)
      throw Error("The conversation changed while extraction was running.");
    if (performance.now() > context.deadline)
      throw Error("Maximum extraction runtime was reached.");
  }

  function delay(ms, signal) {
    if (signal?.aborted) return Promise.reject(abortError(signal.reason));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(done, Math.max(0, ms));
      function done() {
        signal?.removeEventListener("abort", stopped);
        resolve();
      }
      function stopped() {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stopped);
        reject(abortError(signal.reason));
      }
      signal?.addEventListener("abort", stopped, { once: true });
    });
  }

  function hash(text) {
    let value = 2166136261;
    for (let index = 0; index < text.length; index++)
      value = Math.imul(value ^ text.charCodeAt(index), 16777619);
    return (value >>> 0).toString(36);
  }

  function settings(overrides) {
    const external = window.ChatGPTPromptExtractorV3Config || {};
    const value = { ...DEFAULTS, ...external, ...overrides };
    const expected = value.expectedUserPrompts;
    value.expectedUserPrompts = expected == null || expected === "" ? null : Number(expected);
    if (value.expectedUserPrompts != null &&
        (!Number.isInteger(value.expectedUserPrompts) || value.expectedUserPrompts < 0))
      throw Error("expectedUserPrompts must be null or a non-negative integer.");

    value.frontierOverlapViewports = clamp(Number(value.frontierOverlapViewports) || 0.18, 0.05, 0.45);
    value.fastStepViewports = clamp(Number(value.fastStepViewports) || 0.82, 0.35, 0.95);
    value.fallbackStepViewports = clamp(Number(value.fallbackStepViewports) || 0.50, 0.20, 0.70);
    value.geometryGapViewports = clamp(Number(value.geometryGapViewports) || 0.22, 0.08, 0.50);
    value.adaptiveOverlapSteps = clamp(Math.round(Number(value.adaptiveOverlapSteps) || 3), 1, 12);
    value.pollIntervalMs = clamp(Number(value.pollIntervalMs) || 18, 4, 100);
    value.minimumSettleMs = clamp(Number(value.minimumSettleMs) || 28, 0, 500);
    value.mutationQuietMs = clamp(Number(value.mutationQuietMs) || 36, 8, 500);
    value.unchangedSettleMs = clamp(Number(value.unchangedSettleMs) || 95, 20, 1000);
    value.maximumSettleMs = clamp(Number(value.maximumSettleMs) || 750, 100, 10000);
    value.edgeSettleMs = clamp(Number(value.edgeSettleMs) || 650, 100, 15000);
    value.bottomSettleMs = clamp(Number(value.bottomSettleMs) || 900, 100, 15000);
    value.bottomStableChecks = clamp(Math.round(Number(value.bottomStableChecks) || 3), 1, 10);
    value.bottomGeometryFallbackChecks = clamp(
      Math.round(Number(value.bottomGeometryFallbackChecks) || 6),
      value.bottomStableChecks + 1,
      20
    );
    value.bottomVisibilityToleranceViewports = clamp(
      Number(value.bottomVisibilityToleranceViewports) || 0.18, 0.05, 0.60
    );
    value.startupWaitMs = clamp(Number(value.startupWaitMs) || 20000, 1000, 120000);
    value.startupPollMs = clamp(Number(value.startupPollMs) || 100, 20, 1000);
    value.startupWakeAfterMs = clamp(Number(value.startupWakeAfterMs) || 600, 0, value.startupWaitMs);
    value.startupWakeEveryMs = clamp(Number(value.startupWakeEveryMs) || 900, 100, 10000);
    value.debugEventLimit = clamp(Math.round(Number(value.debugEventLimit) || 900), 50, 10000);
    value.moveSampleLimit = clamp(Math.round(Number(value.moveSampleLimit) || 1200), 50, 10000);
    value.slowMoveCount = clamp(Math.round(Number(value.slowMoveCount) || 25), 5, 100);
    return value;
  }

  function debug(context, event, details = {}) {
    if (!context.settings.includeDebugLog) return;
    if (context.debugEvents.length >= context.settings.debugEventLimit) {
      context.debugDropped++;
      return;
    }
    context.debugEvents.push({
      at_ms: Math.round(performance.now() - context.startedPerformance),
      phase: context.phase,
      event,
      ...details
    });
  }

  async function phase(context, name, task) {
    const prior = context.phase;
    const started = performance.now();
    context.phase = name;
    debug(context, "phase_start");
    try {
      return await task();
    } finally {
      const duration = rounded(performance.now() - started);
      context.phaseTimings[name] = rounded((context.phaseTimings[name] || 0) + duration);
      debug(context, "phase_finish", { duration_ms: duration });
      context.phase = prior;
    }
  }

  function memorySnapshot() {
    const value = performance.memory;
    return value ? {
      used_js_heap_bytes: value.usedJSHeapSize,
      total_js_heap_bytes: value.totalJSHeapSize,
      js_heap_limit_bytes: value.jsHeapSizeLimit
    } : null;
  }

  function environmentSnapshot(port, initialCount) {
    return {
      user_agent: navigator.userAgent || null,
      language: navigator.language || null,
      platform: navigator.userAgentData?.platform || navigator.platform || null,
      hardware_concurrency: navigator.hardwareConcurrency || null,
      device_memory_gb: navigator.deviceMemory || null,
      viewport_width: window.innerWidth,
      viewport_height: window.innerHeight,
      device_pixel_ratio: window.devicePixelRatio || 1,
      visibility_state: document.visibilityState,
      browser_tab_title: document.title || null,
      initial_mounted_messages: initialCount,
      initial_scroll_top: Math.round(port.top),
      initial_scroll_maximum: Math.round(port.max)
    };
  }

  function startLongTaskObserver(context) {
    if (typeof PerformanceObserver !== "function" ||
        !PerformanceObserver.supportedEntryTypes?.includes("longtask")) return null;
    try {
      const observer = new PerformanceObserver(list => addLongTasks(context, list.getEntries()));
      observer.observe({ type: "longtask", buffered: false });
      return observer;
    } catch {
      return null;
    }
  }

  function addLongTasks(context, entries) {
    for (const item of entries) {
      context.stats.longTasks.count++;
      context.stats.longTasks.totalMs += item.duration;
      context.stats.longTasks.maximumMs = Math.max(context.stats.longTasks.maximumMs, item.duration);
    }
  }

  function probeAnimationFrame(context, moveIndex) {
    if (typeof requestAnimationFrame !== "function" || !context.frameProbesOpen) return;
    const requestedAt = performance.now();
    context.stats.frames.requested++;
    requestAnimationFrame(() => {
      if (!context.frameProbesOpen) return;
      const latency = performance.now() - requestedAt;
      context.stats.frames.completed++;
      context.stats.frames.totalMs += latency;
      context.stats.frames.maximumMs = Math.max(context.stats.frames.maximumMs, latency);
      context.stats.frames.samples.push(latency);
      if (latency >= 1000) {
        context.stats.frames.overOneSecond++;
        debug(context, "slow_animation_frame", { move: moveIndex, latency_ms: rounded(latency) });
      }
    });
  }

  function mounted() {
    return [...document.querySelectorAll(MESSAGE_SELECTOR)].filter(node => node.isConnected);
  }

  function startupScrollerCandidates() {
    const seen = new Set();
    const candidates = [];
    const add = node => {
      if (!node || seen.has(node) || node.isConnected === false) return;
      seen.add(node);
      const isDocument = node === document.scrollingElement ||
        node === document.documentElement || node === document.body;
      const clientHeight = isDocument ? window.innerHeight : Number(node.clientHeight) || 0;
      const clientWidth = isDocument ? window.innerWidth : Number(node.clientWidth) || 0;
      const scrollHeight = isDocument
        ? Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)
        : Number(node.scrollHeight) || 0;
      if (scrollHeight <= clientHeight + 40) return;
      let scrollable = isDocument;
      if (!isDocument) {
        try { scrollable = /(auto|scroll|overlay)/.test(getComputedStyle(node).overflowY); }
        catch { scrollable = false; }
      }
      if (!scrollable) return;
      candidates.push({
        node, isDocument, clientHeight, scrollHeight,
        score: clientWidth * clientHeight + (scrollHeight - clientHeight)
      });
    };

    add(api.lastScroller);
    add(document.scrollingElement);
    for (const node of document.querySelectorAll(
      'main,[role="main"],[class*="overflow-y-auto"],[class*="overflow-auto"]'
    )) add(node);
    return candidates.sort((a, b) => b.score - a.score);
  }

  function wakeVirtualizedMessages() {
    const candidates = startupScrollerCandidates().slice(0, 3);
    const nudged = [];
    for (const item of candidates) {
      const maximum = Math.max(0, item.scrollHeight - item.clientHeight);
      const before = item.isDocument ? window.scrollY : item.node.scrollTop;
      const target = maximum <= 0 ? before : before >= maximum - 1
        ? Math.max(0, before - 1) : Math.min(maximum, before + 1);
      if (item.isDocument) window.scrollTo(0, target);
      else item.node.scrollTop = target;
      try {
        item.node.dispatchEvent(new Event("scroll", { bubbles: true }));
        if (item.isDocument) window.dispatchEvent(new Event("scroll"));
      } catch { /* a synthetic wake is best effort */ }
      nudged.push({
        type: item.isDocument ? "document" : item.node.tagName,
        before_top: Math.round(before),
        after_top: Math.round(target),
        scroll_maximum: Math.round(maximum)
      });
    }
    return nudged;
  }

  async function waitForMountedMessages(value, signal) {
    const started = performance.now();
    let messages = mounted();
    if (messages.length) return {
      messages, waitedMs: 0, polls: 0, wakeAttempts: 0, wakeDetails: []
    };

    console.warn(
      `[${NAME}] Chat URL is open but its virtualized messages are not mounted yet; ` +
      `waiting up to ${Math.round(value.startupWaitMs / 1000)} seconds.`
    );
    let polls = 0;
    let wakeAttempts = 0;
    let lastWakeAt = -Infinity;
    const wakeDetails = [];

    while (performance.now() - started < value.startupWaitMs) {
      const elapsed = performance.now() - started;
      const remaining = value.startupWaitMs - elapsed;
      await delay(Math.min(value.startupPollMs, remaining), signal);
      polls++;
      messages = mounted();
      if (messages.length) {
        const waitedMs = rounded(performance.now() - started);
        console.log(`[${NAME}] Messages mounted after ${waitedMs} ms; extraction is starting.`);
        return { messages, waitedMs, polls, wakeAttempts, wakeDetails };
      }

      const nowElapsed = performance.now() - started;
      if (nowElapsed >= value.startupWakeAfterMs &&
          nowElapsed - lastWakeAt >= value.startupWakeEveryMs) {
        const details = wakeVirtualizedMessages();
        wakeAttempts++;
        lastWakeAt = nowElapsed;
        if (wakeDetails.length < 12) wakeDetails.push({
          at_ms: Math.round(nowElapsed), candidates: details
        });
      }
    }

    return {
      messages: mounted(),
      waitedMs: rounded(performance.now() - started),
      polls,
      wakeAttempts,
      wakeDetails
    };
  }

  function turnFor(message) {
    return message.closest('[data-testid^="conversation-turn-"]') ||
      message.closest("article") || message.closest("[data-message-id]") || message;
  }

  function identify(message, turn = turnFor(message)) {
    const role = message.getAttribute("data-message-author-role") || "unknown";
    const messageId = message.getAttribute("data-message-id") ||
      turn.getAttribute("data-message-id") || null;
    const testId = turn.getAttribute("data-testid") || null;
    const match = testId?.match(/conversation-turn-(\d+)/i) || testId?.match(/(\d+)(?!.*\d)/);
    const turnNumber = match ? Number(match[1]) : null;
    const key = messageId ? `id:${messageId}` : testId ? `turn:${testId}:${role}` :
      `fallback:${hash(`${role}\0${message.textContent || ""}`)}`;
    return {
      key, role, messageId, testId,
      turnNumber: Number.isFinite(turnNumber) ? turnNumber : null,
      unstable: !messageId && !testId
    };
  }

  function findScroller(seed) {
    const documentScroller = document.scrollingElement || document.documentElement;
    for (let node = seed.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (node.scrollHeight > node.clientHeight + 80 &&
          /(auto|scroll|overlay)/.test(style.overflowY)) return node;
    }
    return documentScroller;
  }

  function scrollPort(scroller) {
    const isDocument = scroller === document.scrollingElement ||
      scroller === document.documentElement || scroller === document.body;
    const styleNode = isDocument ? document.documentElement : scroller;
    return {
      scroller,
      isDocument,
      mutationRoot: isDocument ? document.body : scroller,
      get top() { return isDocument ? window.scrollY : scroller.scrollTop; },
      get view() { return isDocument ? window.innerHeight : scroller.clientHeight; },
      get height() {
        return isDocument
          ? Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)
          : scroller.scrollHeight;
      },
      get max() { return Math.max(0, this.height - this.view); },
      bounds() {
        if (isDocument) return { top: 0, bottom: window.innerHeight };
        const rect = scroller.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom };
      },
      set(value) {
        const target = clamp(Number(value) || 0, 0, this.max);
        if (isDocument) window.scrollTo(0, target);
        else scroller.scrollTop = target;
        return target;
      },
      disableSmooth() {
        const old = styleNode.style.scrollBehavior;
        styleNode.style.scrollBehavior = "auto";
        return () => { styleNode.style.scrollBehavior = old; };
      },
      describe() {
        if (isDocument) return { type: "document" };
        const className = typeof scroller.className === "string" ? scroller.className : "";
        return {
          type: "element", tag: scroller.tagName, id: scroller.id || null,
          class: className ? className.slice(0, 240) : null,
          class_truncated: className.length > 240
        };
      }
    };
  }

  function wanted(role, value) {
    return role === "user" ||
      (role === "assistant" && value.includeModelMessages) ||
      (!/^(user|assistant)$/.test(role) && value.includeOtherRoles);
  }

  function linksFrom(element) {
    const found = [], seen = new Set();
    for (const link of element.querySelectorAll("a[href]")) {
      const href = link.href || link.getAttribute("href") || "";
      const text = (link.innerText || link.textContent || link.getAttribute("aria-label") || "").trim();
      const key = `${text}\0${href}`;
      if (!seen.has(key)) {
        seen.add(key);
        found.push({ text, href });
      }
    }
    return found;
  }

  function mediaFrom(element, includeUrls) {
    const media = [];
    for (const node of element.querySelectorAll("img,video,audio,source")) {
      const raw = node.getAttribute("src") || node.getAttribute("poster") || "";
      media.push({
        type: node.tagName.toLowerCase(),
        alt: node.getAttribute("alt") || null,
        title: node.getAttribute("title") || null,
        aria_label: node.getAttribute("aria-label") || null,
        source: includeUrls
          ? (/^data:/i.test(raw) ? `[data URL: ${raw.length} characters]` : raw || null)
          : null,
        width: Number(node.getAttribute("width")) || node.naturalWidth || null,
        height: Number(node.getAttribute("height")) || node.naturalHeight || null
      });
    }

    const attachments = [], seen = new Set();
    const selector = [
      '[data-testid*="attachment"]', '[data-testid*="file"]',
      '[aria-label*="attachment" i]', '[aria-label*="file" i]'
    ].join(",");
    for (const node of element.querySelectorAll(selector)) {
      const item = {
        test_id: node.getAttribute("data-testid") || null,
        aria_label: node.getAttribute("aria-label") || null,
        text: (node.innerText || node.textContent || "").trim()
      };
      const key = JSON.stringify(item);
      if (!seen.has(key)) {
        seen.add(key);
        attachments.push(item);
      }
    }
    return { media, attachments };
  }

  function descriptor(message, port) {
    const turn = turnFor(message);
    const id = identify(message, turn);
    const rect = turn.getBoundingClientRect();
    const bounds = port.bounds();
    return { message, turn, id, rect, documentTop: port.top + rect.top - bounds.top };
  }

  function readRecord(item, context, old) {
    const started = performance.now();
    const capturedAt = new Date().toISOString();
    const capturedAfter = Math.round(started - context.startedPerformance);
    const scrollTop = Math.round(context.port.top);
    const scrollPercent = percent(context.port);
    const time = item.turn.querySelector("time");
    const expanded = [...item.message.querySelectorAll("button")].some(button =>
      /^show less$/i.test((button.innerText || button.textContent || button.getAttribute("aria-label") || "").trim())
    );
    if (expanded) context.expandedKeys.add(item.id.key);

    const record = {
      key: item.id.key,
      role: item.id.role,
      message_id: item.id.messageId,
      turn_testid: item.id.testId,
      turn_number: item.id.turnNumber,
      unstable_key: item.id.unstable,
      encounter_order: old?.encounter_order ?? context.encounter++,
      displayed_or_dom_time: time?.dateTime || time?.getAttribute("datetime") || time?.innerText || null,

      captured_at: old?.captured_at || capturedAt,
      captured_after_ms: old?.captured_after_ms ?? capturedAfter,
      capture_phase: old?.capture_phase || context.phase,
      capture_move_index: old?.capture_move_index ?? context.stats.moves,
      capture_scroll_top: old?.capture_scroll_top ?? scrollTop,
      capture_scroll_percent: old?.capture_scroll_percent ?? scrollPercent,
      approximate_document_top_at_capture:
        old?.approximate_document_top_at_capture ?? Math.round(item.documentTop),

      last_refreshed_at: capturedAt,
      last_refreshed_after_ms: capturedAfter,
      last_refresh_phase: context.phase,
      last_refresh_scroll_top: scrollTop,
      last_refresh_scroll_percent: scrollPercent,
      last_approximate_document_top: Math.round(item.documentTop),
      capture_count: (old?.capture_count || 0) + 1,
      expanded_in_ui_at_capture: old?.expanded_in_ui_at_capture || expanded,
      text: item.message.innerText ?? item.message.textContent ?? ""
    };

    if (context.settings.includeLinks) record.links = linksFrom(item.message);
    if (context.settings.includeMedia)
      Object.assign(record, mediaFrom(item.message, context.settings.includeMediaUrls));
    if (context.settings.includeMessageHtml) record.html = item.message.innerHTML;

    const duration = rounded(performance.now() - started);
    record.capture_duration_ms = old?.capture_duration_ms ?? duration;
    record.last_refresh_duration_ms = duration;
    record.total_capture_duration_ms = rounded((old?.total_capture_duration_ms || 0) + duration);
    context.stats.messageReads.operations++;
    context.stats.messageReads.totalMs += duration;
    context.stats.messageReads.maximumMs = Math.max(context.stats.messageReads.maximumMs, duration);
    if (old) context.stats.messageReads.refreshes++;
    else context.stats.messageReads.initial++;
    return record;
  }

  function capture(context, options = {}) {
    check(context);
    const started = performance.now();
    const items = mounted().map(node => descriptor(node, context.port))
      .filter(item => item.rect.width > 0 && item.rect.height > 0)
      .sort((a, b) => a.rect.top - b.rect.top);
    const keys = new Set();
    let added = 0;

    for (const item of items) {
      keys.add(item.id.key);
      if (!context.coverage.has(item.id.key)) {
        context.coverage.set(item.id.key, {
          key: item.id.key,
          role: item.id.role,
          message_id: item.id.messageId,
          turn_number: item.id.turnNumber,
          unstable_key: item.id.unstable
        });
        added++;
      }
      if (wanted(item.id.role, context.settings) &&
          (!context.records.has(item.id.key) || options.refresh)) {
        const old = context.records.get(item.id.key);
        context.records.set(item.id.key, readRecord(item, context, old));
      }
    }

    const bounds = context.port.bounds();
    const tolerance = Math.max(96, context.port.view * context.settings.geometryGapViewports);
    let frontier = bounds.top;
    let continuous = false;
    for (const item of items) {
      if (item.rect.bottom < bounds.top - tolerance) continue;
      if (!continuous) {
        if (item.rect.top <= bounds.top + tolerance && item.rect.bottom >= bounds.top - tolerance) {
          frontier = Math.max(frontier, item.rect.bottom);
          continuous = true;
        } else break;
      } else if (item.rect.top <= frontier + tolerance) {
        frontier = Math.max(frontier, item.rect.bottom);
      } else break;
    }

    const duration = rounded(performance.now() - started);
    context.stats.captures.count++;
    context.stats.captures.totalMs += duration;
    context.stats.captures.maximumMs = Math.max(context.stats.captures.maximumMs, duration);
    context.stats.newTurns += added;
    debug(context, "capture", {
      reason: options.reason || null,
      refresh: Boolean(options.refresh),
      mounted_messages: items.length,
      new_turns: added,
      saved_messages: context.records.size,
      duration_ms: duration,
      scroll_top: Math.round(context.port.top),
      scroll_percent: percent(context.port)
    });
    return {
      items, keys, added, frontier, continuous,
      minimumTurn: Math.min(...items.map(item => item.id.turnNumber).filter(Number.isFinite), Infinity),
      maximumTurn: Math.max(...items.map(item => item.id.turnNumber).filter(Number.isFinite), -Infinity)
    };
  }

  function domSignature(port) {
    const ids = mounted().map(node => {
      const turn = turnFor(node);
      return node.getAttribute("data-message-id") || turn.getAttribute("data-message-id") ||
        turn.getAttribute("data-testid") || "?";
    });
    return `${Math.round(port.max)}:${ids.join("|")}`;
  }

  function overlap(left, right) {
    if (left.size > right.size) [left, right] = [right, left];
    for (const key of left) if (right.has(key)) return true;
    return false;
  }

  function rememberMove(context, sample) {
    const stats = context.stats;
    stats.moves++;
    stats.settle.totalMs += sample.settle_ms;
    stats.settle.maximumMs = Math.max(stats.settle.maximumMs, sample.settle_ms);
    stats.settle.samples.push(sample.settle_ms);
    stats.settle.reasons[sample.settle_reason] =
      (stats.settle.reasons[sample.settle_reason] || 0) + 1;
    if (sample.settle_ms > sample.maximum_wait_ms) stats.settle.overMaximum++;
    stats.mutations += sample.mutations;
    stats.timer.polls += sample.polls;
    stats.timer.totalLagMs += sample.total_timer_lag_ms;
    stats.timer.maximumGapMs = Math.max(stats.timer.maximumGapMs, sample.maximum_poll_gap_ms);
    stats.timer.maximumLagMs = Math.max(stats.timer.maximumLagMs, sample.maximum_timer_lag_ms);
    stats.timer.delayedPolls += sample.delayed_polls;
    stats.scrollDistancePx += Math.abs(sample.after_top - sample.before_top);

    if (stats.moveSamples.length < context.settings.moveSampleLimit) stats.moveSamples.push(sample);
    else stats.moveSamplesDropped++;
  }

  async function move(context, target, options = {}) {
    check(context);
    const maximumWait = Number(options.maximumWait || context.settings.maximumSettleMs);
    const moveIndex = context.stats.moves + 1;
    const beforeTop = context.port.top;
    const beforeCoverage = context.coverage.size;
    let previousSignature = domSignature(context.port);
    let signatureChanges = 0;
    let mutations = 0;
    let lastActivity = performance.now();
    let polls = 0;
    let totalTimerLag = 0;
    let maximumTimerLag = 0;
    let maximumPollGap = 0;
    let delayedPolls = 0;

    const observer = new MutationObserver(list => {
      mutations += list.length;
      lastActivity = performance.now();
    });
    observer.observe(context.port.mutationRoot, {
      childList: true, subtree: true, characterData: true
    });

    const started = performance.now();
    const requestedTop = context.port.set(target);
    probeAnimationFrame(context, moveIndex); // diagnostic only; deliberately not awaited
    let lastPollAt = started;
    let settleReason = "maximum_wait";

    try {
      while (true) {
        check(context);
        const elapsedBeforeWait = performance.now() - started;
        if (elapsedBeforeWait >= maximumWait) break;
        const requestedDelay = Math.min(
          context.settings.pollIntervalMs,
          Math.max(0, maximumWait - elapsedBeforeWait)
        );
        await delay(requestedDelay, context.signal);
        const now = performance.now();
        polls++;
        const pollGap = now - lastPollAt;
        const timerLag = Math.max(0, pollGap - requestedDelay);
        maximumPollGap = Math.max(maximumPollGap, pollGap);
        maximumTimerLag = Math.max(maximumTimerLag, timerLag);
        totalTimerLag += timerLag;
        if (timerLag >= context.settings.timerLagWarningMs) delayedPolls++;
        lastPollAt = now;

        const nextSignature = domSignature(context.port);
        if (nextSignature !== previousSignature) {
          previousSignature = nextSignature;
          signatureChanges++;
          lastActivity = now;
        }

        const elapsed = now - started;
        const quiet = now - lastActivity;
        if (elapsed >= context.settings.minimumSettleMs &&
            (mutations > 0 || signatureChanges > 0) && quiet >= context.settings.mutationQuietMs) {
          settleReason = mutations > 0 ? "mutation_quiet" : "signature_quiet";
          break;
        }
        if (mutations === 0 && signatureChanges === 0 &&
            elapsed >= context.settings.unchangedSettleMs) {
          settleReason = "unchanged_timer";
          break;
        }
        if (elapsed >= maximumWait) break;
      }
    } finally {
      observer.disconnect();
    }

    const elapsed = rounded(performance.now() - started);
    const after = capture(context, { reason: `after ${options.mode || "move"}` });
    const sample = {
      index: moveIndex,
      phase: context.phase,
      mode: options.mode || "move",
      requested_top: Math.round(target),
      clamped_requested_top: Math.round(requestedTop),
      before_top: Math.round(beforeTop),
      after_top: Math.round(context.port.top),
      scroll_maximum: Math.round(context.port.max),
      settle_ms: elapsed,
      maximum_wait_ms: maximumWait,
      settle_reason: settleReason,
      polls,
      mutations,
      signature_changes: signatureChanges,
      new_turns: context.coverage.size - beforeCoverage,
      maximum_poll_gap_ms: rounded(maximumPollGap),
      maximum_timer_lag_ms: rounded(maximumTimerLag),
      total_timer_lag_ms: rounded(totalTimerLag),
      delayed_polls: delayedPolls,
      overlap_with_previous_window: null
    };
    rememberMove(context, sample);
    after.moveSample = sample;
    debug(context, "move", sample);
    return after;
  }

  async function settleAtTop(context, initial) {
    // The expensive V2 pattern moved to zero repeatedly even when already at
    // zero. V3 first trusts a mounted turn 1, then performs only a timer check.
    if (context.port.top <= 2 && (initial.minimumTurn === 1 || initial.minimumTurn === Infinity)) {
      context.stats.topMovesSkipped++;
      const before = domSignature(context.port);
      await delay(context.settings.topConfirmMs, context.signal);
      const confirmed = capture(context, { reason: "top already mounted" });
      const unchanged = before === domSignature(context.port);
      debug(context, "top_move_skipped", {
        minimum_turn: confirmed.minimumTurn === Infinity ? null : confirmed.minimumTurn,
        signature_unchanged: unchanged,
        top: Math.round(context.port.top)
      });
      return context.port.top <= 2;
    }

    let priorState = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      const current = await move(context, 0, {
        mode: "top settle",
        maximumWait: context.settings.edgeSettleMs
      });
      const state = `${Math.round(context.port.top)}:${Math.round(context.port.max)}:${
        current.minimumTurn === Infinity ? "?" : current.minimumTurn}:${context.coverage.size}`;
      if (context.port.top <= 2 && (state === priorState || current.minimumTurn === 1)) {
        debug(context, "top_settled", { attempt, state });
        return true;
      }
      priorState = state;
      await delay(60, context.signal);
    }
    const reached = context.port.top <= 2;
    debug(context, "top_settle_finished", { reached, state: priorState });
    return reached;
  }

  function report(context, force = false) {
    const now = performance.now();
    const userCount = [...context.records.values()].filter(item => item.role === "user").length;
    if (!force && userCount < context.stats.lastUserReport + context.settings.progressEveryMessages &&
        now < context.stats.lastReportAt + context.settings.progressEveryMs) return;
    context.stats.lastUserReport = userCount;
    context.stats.lastReportAt = now;
    console.log(
      `[${NAME}] prompts=${userCount}, saved=${context.records.size}, ` +
      `seen=${context.coverage.size}, scroll=${Math.round(percent(context.port))}%`
    );
  }

  async function step(context, current, conservative) {
    const { port, settings: value, stats } = context;
    const beforeTop = port.top;
    const beforeMax = port.max;
    const beforeKeys = current.keys;
    const frontierDistance = current.continuous
      ? current.frontier - port.bounds().top - port.view * value.frontierOverlapViewports
      : 0;
    const adaptive = context.adaptiveOverlapRemaining > 0;
    const frontierMode = !conservative && !adaptive &&
      frontierDistance > port.view * value.fastStepViewports;
    const distance = frontierMode ? frontierDistance :
      port.view * (conservative ? value.fallbackStepViewports :
        adaptive ? value.fallbackStepViewports : value.fastStepViewports);
    const target = clamp(beforeTop + Math.max(120, distance), 0, beforeMax);
    const mode = conservative ? "conservative overlap" : frontierMode ? "frontier jump" :
      adaptive ? "adaptive overlap" : "fast overlap";

    debug(context, "step_decision", {
      mode, before_top: Math.round(beforeTop), target_top: Math.round(target),
      frontier_distance: Math.round(frontierDistance), mounted_messages: current.items.length,
      adaptive_steps_remaining: context.adaptiveOverlapRemaining
    });

    if (target <= beforeTop + 2) return { atBottom: true, stalled: false, added: 0 };
    const after = await move(context, target, {
      mode,
      maximumWait: conservative ? Math.max(900, value.maximumSettleMs) : value.maximumSettleMs
    });
    const travelled = Math.max(0, port.top - beforeTop);
    const hasOverlap = overlap(beforeKeys, after.keys);
    after.moveSample.overlap_with_previous_window = hasOverlap;

    if (frontierMode && travelled > port.view * 0.75 && !hasOverlap) {
      stats.frontierRewinds++;
      context.adaptiveOverlapRemaining = value.adaptiveOverlapSteps;
      debug(context, "frontier_rewind", {
        before_top: Math.round(beforeTop), unsafe_top: Math.round(port.top),
        reason: "large jump lost mounted-message continuity"
      });
      console.warn(`[${NAME}] Frontier lost continuity; rewinding into overlap mode.`);
      await move(context, beforeTop, {
        mode: "frontier rewind", maximumWait: Math.max(550, value.maximumSettleMs)
      });
      const recovered = await move(context, beforeTop + port.view * value.fallbackStepViewports, {
        mode: "rewind recovery overlap", maximumWait: Math.max(900, value.maximumSettleMs)
      });
      return {
        atBottom: false,
        stalled: port.top <= beforeTop + 2,
        added: recovered.moveSample.new_turns
      };
    }

    if (frontierMode) stats.frontierJumps++;
    else stats.overlapSteps++;

    if (adaptive) context.adaptiveOverlapRemaining--;
    // Crossing already-captured overscan can legitimately add zero IDs while
    // still advancing thousands of pixels. Treat physical failure to advance,
    // not a single zero-ID jump, as unproductive.
    const minimumUsefulTravel = Math.min(
      port.view * 0.35,
      Math.max(2, (target - beforeTop) * 0.35)
    );
    if (frontierMode && travelled < minimumUsefulTravel) {
      context.adaptiveOverlapRemaining = value.adaptiveOverlapSteps;
      stats.unproductiveFrontierJumps++;
      debug(context, "frontier_unproductive", {
        travelled_px: Math.round(travelled),
        minimum_useful_travel_px: Math.round(minimumUsefulTravel),
        new_turns: after.moveSample.new_turns,
        next_overlap_steps: context.adaptiveOverlapRemaining
      });
    }

    return {
      atBottom: false,
      stalled: port.top <= beforeTop + 2,
      added: after.moveSample.new_turns
    };
  }

  function bottomEvidence(context, current) {
    const bounds = context.port.bounds();
    const last = current.items.at(-1) || null;
    const tolerance = Math.max(
      80,
      context.port.view * context.settings.bottomVisibilityToleranceViewports
    );
    const lastBottom = last?.rect?.bottom ?? null;
    const finalMessageAtViewportBottom = Boolean(last &&
      lastBottom <= bounds.bottom + tolerance &&
      lastBottom >= bounds.top - tolerance);
    return {
      at_scroll_maximum: context.port.top >= context.port.max - 2,
      final_message_at_viewport_bottom: finalMessageAtViewportBottom,
      last_key: last?.id?.key || null,
      last_message_id: last?.id?.messageId || null,
      last_turn_number: Number.isFinite(last?.id?.turnNumber) ? last.id.turnNumber : null,
      last_message_bottom_px: lastBottom == null ? null : Math.round(lastBottom),
      viewport_bottom_px: Math.round(bounds.bottom),
      tolerance_px: Math.round(tolerance),
      scroll_top: Math.round(context.port.top),
      scroll_maximum: Math.round(context.port.max),
      document_height: Math.round(context.port.height),
      all_roles_seen: context.coverage.size
    };
  }

  async function scan(context, conservative) {
    let current = capture(context, { reason: conservative ? "fallback initial" : "initial mounted window" });
    const reachedTop = await settleAtTop(context, current);
    current = capture(context, { reason: "top scan start" });
    let bottomStable = 0, bottomState = "", stalled = 0;

    for (let count = 0; count < context.settings.maximumMovesPerPass; count++) {
      check(context);
      report(context);

      if (context.port.top >= context.port.max - 2) {
        await delay(context.settings.bottomRecheckMs, context.signal);
        // Explicitly request the latest maximum even if we already appear to
        // be there. Virtualized chats can grow their scroll height only after
        // this bottom anchor is processed.
        const latest = await move(context, context.port.max, {
          mode: "bottom anchor verification",
          maximumWait: context.settings.bottomSettleMs
        });
      context.stats.bottomAnchors++;
        if (streaming()) capture(context, {
          reason: "streaming bottom refresh",
          refresh: true
        });
        const evidence = bottomEvidence(context, latest);
        context.lastBottomEvidence = evidence;
        const state = `${evidence.scroll_maximum}:${evidence.document_height}:` +
          `${evidence.last_key}:${evidence.last_turn_number}:${evidence.all_roles_seen}:` +
          `${evidence.final_message_at_viewport_bottom}`;
        bottomStable = state === bottomState && evidence.at_scroll_maximum ? bottomStable + 1 : 0;
        bottomState = state;
        debug(context, "bottom_anchor_check", {
          structurally_stable_checks: bottomStable,
          required_stable_checks: context.settings.bottomStableChecks,
          ...evidence
        });
        if (!evidence.at_scroll_maximum) {
          current = latest;
          continue;
        }
        if (bottomStable >= context.settings.bottomStableChecks &&
            evidence.final_message_at_viewport_bottom) {
          debug(context, "bottom_settled", {
            checks: bottomStable,
            iterations: count,
            evidence
          });
          return { reachedTop, reachedBottom: true, stalled: false, iterations: count };
        }
        // Some layouts reserve a large footer/composer region inside the
        // scroller, so the final message can sit above our geometry tolerance
        // even at the real maximum. Do not loop forever: after more repeated
        // checks prove max height, last ID/turn, and counts are unchanged,
        // accept the structural bottom and flag the geometry exception.
        if (bottomStable >= context.settings.bottomGeometryFallbackChecks) {
          evidence.geometry_fallback_used = true;
          context.lastBottomEvidence = evidence;
          context.stats.bottomGeometryFallbacks++;
          debug(context, "bottom_geometry_fallback", {
            checks: bottomStable,
            evidence
          });
          return { reachedTop, reachedBottom: true, stalled: false, iterations: count };
        }
        current = latest;
        continue;
      }

      bottomStable = 0;
      const outcome = await step(context, current, conservative);
      stalled = outcome.stalled ? stalled + 1 : 0;
      if (stalled >= 6)
        return { reachedTop, reachedBottom: false, stalled: true, iterations: count + 1 };
      current = capture(context, { reason: "step handoff" });
    }

    return {
      reachedTop,
      reachedBottom: context.port.top >= context.port.max - 2,
      stalled: false,
      iterations: context.settings.maximumMovesPerPass
    };
  }

  function roleCounts(messages) {
    return messages.reduce((out, item) => {
      out[item.role] = (out[item.role] || 0) + 1;
      return out;
    }, {});
  }

  function sorted(records) {
    return [...records.values()].sort((a, b) => {
      const at = Number.isFinite(a.turn_number) ? a.turn_number : Number.MAX_SAFE_INTEGER;
      const bt = Number.isFinite(b.turn_number) ? b.turn_number : Number.MAX_SAFE_INTEGER;
      return at - bt ||
        (a.approximate_document_top_at_capture ?? Number.MAX_SAFE_INTEGER) -
          (b.approximate_document_top_at_capture ?? Number.MAX_SAFE_INTEGER) ||
        a.encounter_order - b.encounter_order || a.key.localeCompare(b.key);
    });
  }

  function turnGaps(coverage) {
    const turns = [...new Set([...coverage.values()].map(item => item.turn_number)
      .filter(Number.isFinite))].sort((a, b) => a - b);
    const gaps = [];
    for (let index = 1; index < turns.length; index++) {
      const missing = turns[index] - turns[index - 1] - 1;
      if (missing > 0) gaps.push({ after: turns[index - 1], before: turns[index], missing });
    }
    return gaps;
  }

  function quantile(values, ratio) {
    if (!values.length) return 0;
    const sortedValues = [...values].sort((a, b) => a - b);
    return sortedValues[Math.min(sortedValues.length - 1,
      Math.max(0, Math.ceil(sortedValues.length * ratio) - 1))];
  }

  function distribution(values) {
    return {
      count: values.length,
      average_ms: rounded(values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)),
      p50_ms: rounded(quantile(values, 0.50)),
      p90_ms: rounded(quantile(values, 0.90)),
      p99_ms: rounded(quantile(values, 0.99)),
      maximum_ms: rounded(values.length ? Math.max(...values) : 0)
    };
  }

  function title(override) {
    const clean = value => String(value || "")
      .replace(/^\(\d+\)\s*/, "")
      .replace(/^\s*(?:ChatGPT|OpenAI)\s*[-—|:]\s*/i, "")
      .replace(/\s*[-—|:]\s*(?:ChatGPT|OpenAI)\s*$/i, "")
      .replace(/\s+/g, " ").trim();
    const usable = value => value && value.length <= 180 &&
      !/^(?:chatgpt|new chat|openai|skip to (?:main )?content|main content|navigation|chat history|open (?:menu|sidebar)|close (?:menu|sidebar))$/i.test(value);
    const browserTabTitle = document.title || "";
    const forced = clean(override);
    if (forced) return { value: forced, source: "override", browserTabTitle };

    const tab = clean(browserTabTitle);
    if (usable(tab)) return { value: tab, source: "browser tab", browserTabTitle };

    const metaTitle = clean(document.querySelector('meta[property="og:title"]')?.content || "");
    if (usable(metaTitle)) return { value: metaTitle, source: "page metadata", browserTabTitle };

    for (const link of document.querySelectorAll('a[href*="/c/"],a[href*="/g/"]')) {
      try {
        const url = new URL(link.getAttribute("href"), location.href);
        if (url.pathname !== location.pathname || url.hash) continue;
        for (const candidate of [link.getAttribute("title"), link.innerText, link.textContent]) {
          const value = clean(candidate);
          if (usable(value)) return { value, source: "conversation link", browserTabTitle };
        }
      } catch { /* malformed link */ }
    }

    const id = location.pathname.match(/\/(?:c|g)\/([^/?#]+)/)?.[1];
    return {
      value: id ? `chat-${id.slice(0, 12)}` : "chatgpt-chat",
      source: "conversation id fallback",
      browserTabTitle
    };
  }

  function timestamp(date) {
    const pad = (value, width = 2) => String(value).padStart(width, "0");
    return `${pad(date.getFullYear(), 4)}${pad(date.getMonth() + 1)}${pad(date.getDate())}_` +
      `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}_${pad(date.getMilliseconds(), 3)}`;
  }

  function token(length = 16) {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
      return crypto.randomUUID().replaceAll("-", "").slice(0, length);
    const random = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    return random.padEnd(length, "0").slice(0, length);
  }

  function safe(value, limit = 82) {
    const part = String(value).normalize("NFKC")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/\s+/g, " ").replace(/[. ]+$/g, "").trim().slice(0, limit) || "chatgpt-chat";
    return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(part) ? `chat-${part}` : part;
  }

  function streaming() {
    return Boolean(document.querySelector(
      '[data-testid="stop-button"],button[aria-label*="stop generating" i],button[aria-label*="stop streaming" i]'
    ));
  }

  function readable(result) {
    let users = 0, models = 0;
    const lines = [
      `Chat: ${result.conversation_title}`,
      `Snapshot: ${result.snapshot_at}`,
      `User prompts: ${result.counts.user_prompts}`,
      `Model messages: ${result.counts.model_messages}`,
      `Scan duration: ${result.timing.scan_duration_seconds} seconds`, ""
    ];
    for (const message of result.messages || []) {
      const label = message.role === "user" ? `USER PROMPT ${++users}` :
        message.role === "assistant" ? `MODEL MESSAGE ${++models}` : message.role.toUpperCase();
      lines.push(`===== ${label}${Number.isFinite(message.turn_number) ? ` | TURN ${message.turn_number}` : ""} =====`);
      lines.push(message.text || "");
      if (message.links?.length) {
        lines.push("Links:");
        for (const link of message.links) lines.push(`- ${link.text || "link"}: ${link.href}`);
      }
      if (message.attachments?.length) {
        lines.push("Attachments:");
        for (const item of message.attachments)
          lines.push(`- ${item.text || item.aria_label || item.test_id || "attachment"}`);
      }
      if (message.media?.length) {
        lines.push("Media:");
        for (const item of message.media)
          lines.push(`- ${item.type}: ${item.alt || item.title || item.aria_label || item.source || "unlabelled"}`);
      }
      lines.push("");
    }
    return lines.join("\n");
  }

  function download(result) {
    const savedAt = new Date();
    const saveId = token(16);
    const filename = `${result.output_basename}__save-${timestamp(savedAt)}-${saveId}.txt`;
    result.output = result.output || {};
    result.output.last_download_at = savedAt.toISOString();
    result.output.last_download_filename = filename;
    result.output.last_download_id = saveId;

    const serializationStarted = performance.now();
    const content = JSON.stringify(result, null, 2);
    const serializationMs = rounded(performance.now() - serializationStarted);
    const blobStarted = performance.now();
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" }); // no BOM
    const url = URL.createObjectURL(blob);
    const link = Object.assign(document.createElement("a"), { href: url, download: filename });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
    api.lastDownloadMetrics = {
      filename,
      serialization_ms: serializationMs,
      content_characters: content.length,
      blob_and_dispatch_ms: rounded(performance.now() - blobStarted)
    };
    return filename;
  }

  function createStats(startedPerformance) {
    return {
      moves: 0,
      moveSamples: [],
      moveSamplesDropped: 0,
      captures: { count: 0, totalMs: 0, maximumMs: 0 },
      messageReads: { operations: 0, initial: 0, refreshes: 0, totalMs: 0, maximumMs: 0 },
      settle: { totalMs: 0, maximumMs: 0, overMaximum: 0, samples: [], reasons: {} },
      timer: { polls: 0, totalLagMs: 0, maximumGapMs: 0, maximumLagMs: 0, delayedPolls: 0 },
      frames: { requested: 0, completed: 0, totalMs: 0, maximumMs: 0, overOneSecond: 0, samples: [] },
      longTasks: { count: 0, totalMs: 0, maximumMs: 0 },
      mutations: 0,
      newTurns: 0,
      frontierJumps: 0,
      frontierRewinds: 0,
      unproductiveFrontierJumps: 0,
      overlapSteps: 0,
      conservativePasses: 0,
      topMovesSkipped: 0,
      bottomAnchors: 0,
      bottomGeometryFallbacks: 0,
      scrollDistancePx: 0,
      lastUserReport: 0,
      lastReportAt: startedPerformance
    };
  }

  function performanceBlock(context, messages, prompts, scanDuration, longTaskSupported, memoryEnd) {
    const stats = context.stats;
    const slowest = [...stats.moveSamples].sort((a, b) => b.settle_ms - a.settle_ms)
      .slice(0, context.settings.slowMoveCount);
    return {
      messages_per_scan_second: rounded(messages.length / Math.max(0.001, scanDuration / 1000)),
      prompts_per_scan_second: rounded(prompts / Math.max(0.001, scanDuration / 1000)),
      settle_share_percent: rounded(stats.settle.totalMs / Math.max(1, scanDuration) * 100),
      settling: {
        ...distribution(stats.settle.samples),
        total_ms: rounded(stats.settle.totalMs),
        configured_maximum_ms: context.settings.maximumSettleMs,
        moves_over_configured_maximum: stats.settle.overMaximum,
        reason_counts: stats.settle.reasons
      },
      timer_scheduler: {
        polls: stats.timer.polls,
        total_lag_ms: rounded(stats.timer.totalLagMs),
        maximum_poll_gap_ms: rounded(stats.timer.maximumGapMs),
        maximum_timer_lag_ms: rounded(stats.timer.maximumLagMs),
        delayed_polls_over_warning: stats.timer.delayedPolls,
        warning_threshold_ms: context.settings.timerLagWarningMs
      },
      nonblocking_animation_frame_probe: {
        supported: typeof requestAnimationFrame === "function",
        requested: stats.frames.requested,
        completed_before_result_build: stats.frames.completed,
        pending_at_result_build: stats.frames.requested - stats.frames.completed,
        ...distribution(stats.frames.samples),
        over_one_second: stats.frames.overOneSecond,
        note: "These frames were measured asynchronously and were never awaited by traversal."
      },
      capture_batches: {
        count: stats.captures.count,
        total_ms: rounded(stats.captures.totalMs),
        average_ms: rounded(stats.captures.totalMs / Math.max(1, stats.captures.count)),
        maximum_ms: rounded(stats.captures.maximumMs)
      },
      message_dom_reads: {
        operations: stats.messageReads.operations,
        initial_reads: stats.messageReads.initial,
        refreshes: stats.messageReads.refreshes,
        total_ms: rounded(stats.messageReads.totalMs),
        average_ms: rounded(stats.messageReads.totalMs / Math.max(1, stats.messageReads.operations)),
        maximum_ms: rounded(stats.messageReads.maximumMs)
      },
      long_tasks: {
        supported: longTaskSupported,
        count: stats.longTasks.count,
        total_ms: rounded(stats.longTasks.totalMs),
        maximum_ms: rounded(stats.longTasks.maximumMs),
        share_of_scan_percent: rounded(stats.longTasks.totalMs / Math.max(1, scanDuration) * 100)
      },
      memory: {
        supported: Boolean(context.memoryStart && memoryEnd),
        start: context.memoryStart,
        finish: memoryEnd,
        used_heap_delta_bytes: context.memoryStart && memoryEnd
          ? memoryEnd.used_js_heap_bytes - context.memoryStart.used_js_heap_bytes : null
      },
      expanded_messages_detected: context.expandedKeys.size,
      slowest_moves: slowest,
      result_build_ms: null,
      serialization_preflight_ms: null,
      serialization_preflight_characters: null
    };
  }

  function partialResult(context, error) {
    const messages = sorted(context.records);
    const roles = roleCounts(messages);
    const now = new Date();
    const titleInfo = title(context.settings.chatTitleOverride);
    const prompts = roles.user || 0;
    const models = roles.assistant || 0;
    const runId = token(16);
    return {
      schema: "chatgpt-active-branch-extract-v3-partial",
      extractor_version: VERSION,
      conversation_title: titleInfo.value,
      conversation_title_source: titleInfo.source,
      browser_tab_title: titleInfo.browserTabTitle,
      conversation_id: location.pathname.match(/\/(?:c|g)\/([^/?#]+)/)?.[1] || null,
      source_url: location.href,
      snapshot_at: now.toISOString(),
      output_basename: [
        safe(titleInfo.value), `PARTIAL-prompts-${prompts}`,
        context.settings.includeModelMessages ? `model-${models}` : "user-only",
        `snapshot-${timestamp(now)}`, `run-${runId}`
      ].join("__"),
      failure: {
        phase: context.phase,
        after_ms: Math.round(performance.now() - context.startedPerformance),
        name: error?.name || "Error",
        message: String(error?.message || error),
        stack: error?.stack || null
      },
      counts: {
        user_prompts: prompts,
        model_messages: models,
        saved_messages: messages.length,
        all_roles_seen: context.coverage.size,
        role_counts: roles
      },
      debug: {
        dropped_events: context.debugDropped,
        environment: context.environment,
        events: context.debugEvents,
        move_samples: context.stats.moveSamples
      },
      messages
    };
  }

  function recordStartupFailure(error, invokedAt, invokedPerformance, startup = {}) {
    api.lastError = error;
    api.lastDebug = {
      failed_at: new Date().toISOString(),
      invoked_at: invokedAt.toISOString(),
      failed_after_ms: Math.round(performance.now() - invokedPerformance),
      phase: "startup wait",
      source_url: location.href,
      browser_tab_title: document.title || null,
      mounted_messages: mounted().length,
      startup: {
        configured_wait_ms: startup.configuredWaitMs || null,
        waited_ms: startup.waitedMs ?? Math.round(performance.now() - invokedPerformance),
        polls: startup.polls || 0,
        wake_attempts: startup.wakeAttempts || 0,
        wake_details: startup.wakeDetails || []
      },
      error: {
        name: error?.name || "Error",
        message: String(error?.message || error),
        stack: error?.stack || null
      }
    };
    window.__CHATGPT_PROMPT_EXTRACT_V3_DEBUG__ = api.lastDebug;
    if (error?.name === "AbortError") console.warn(`[${NAME}] Startup wait stopped.`);
    else console.error(`[${NAME}] FAILED:`, error);
    console.log(`[${NAME}] Startup diagnostics: ${NAME}.lastDebug`);
    api.running = false;
    activeController = null;
  }

  async function run(overrides = {}) {
    if (api.running) throw Error("An extraction is already running.");
    const value = settings(overrides);
    const controller = new AbortController();
    activeController = controller;
    api.running = true;
    api.lastError = null;
    api.lastPartial = null;
    const invokedAt = new Date();
    const invokedPerformance = performance.now();
    let startup;
    try {
      startup = await waitForMountedMessages(value, controller.signal);
    } catch (error) {
      recordStartupFailure(error, invokedAt, invokedPerformance, {
        configuredWaitMs: value.startupWaitMs
      });
      throw error;
    }
    const initial = startup.messages;
    if (!initial.length) {
      const error = Error(
        `No mounted ChatGPT messages appeared within ${Math.round(value.startupWaitMs)} ms. ` +
        `The conversation URL is open, but its virtualized DOM did not mount. ` +
        `Wait for the chat to render, then call ${NAME}.run() without pasting the code again.`
      );
      recordStartupFailure(error, invokedAt, invokedPerformance, {
        ...startup,
        configuredWaitMs: value.startupWaitMs
      });
      throw error;
    }

    const startedAt = new Date();
    const startedPerformance = performance.now();
    const port = scrollPort(findScroller(initial[0]));
    api.lastScroller = port.scroller;
    const originalRatio = port.max ? port.top / port.max : 1;
    const restoreSmooth = port.disableSmooth();
    const context = activeContext = {
      settings: value,
      signal: controller.signal,
      deadline: startedPerformance + value.maximumRuntimeMs,
      conversationPath: location.pathname,
      invokedAt,
      invokedPerformance,
      startup,
      startedPerformance,
      port,
      records: new Map(),
      coverage: new Map(),
      expandedKeys: new Set(),
      encounter: 0,
      phase: "initialization",
      phaseTimings: {},
      debugEvents: [],
      debugDropped: 0,
      adaptiveOverlapRemaining: 0,
      lastBottomEvidence: null,
      frameProbesOpen: true,
      environment: null,
      memoryStart: memorySnapshot(),
      stats: createStats(startedPerformance)
    };
    context.environment = environmentSnapshot(port, initial.length);
    const longTaskObserver = startLongTaskObserver(context);
    const streamedAtStart = streaming();
    let scrollRestored = false;

    debug(context, "run_start", {
      include_model_messages: value.includeModelMessages,
      expected_user_prompts: value.expectedUserPrompts,
      mounted_messages: initial.length,
      startup_wait_ms: startup.waitedMs,
      startup_polls: startup.polls,
      startup_wake_attempts: startup.wakeAttempts,
      scroller: port.describe(),
      settling_design: "mutation/timer first; requestAnimationFrame never awaited"
    });

    console.log(
      `[${NAME} ${VERSION}] Starting ${value.includeModelMessages ? "full-chat" : "prompt-only"} scan. ` +
      `Do not interact with the chat; ${NAME}.stop() aborts safely.`
    );

    try {
      const fast = await phase(context, "fast scan", () => scan(context, false));
      const fastUserCount = [...context.records.values()].filter(item => item.role === "user").length;
      const expectedMissed = value.expectedUserPrompts != null && fastUserCount < value.expectedUserPrompts;
      const mustVerify = value.forceConservativePass || !fast.reachedTop || !fast.reachedBottom ||
        fast.stalled || context.stats.frontierRewinds > 0 || expectedMissed;
      let conservative = null;

      if (mustVerify) {
        context.stats.conservativePasses++;
        context.adaptiveOverlapRemaining = 0;
        debug(context, "fallback_requested", {
          forced: value.forceConservativePass,
          fast_reached_top: fast.reachedTop,
          fast_reached_bottom: fast.reachedBottom,
          fast_stalled: fast.stalled,
          frontier_rewinds: context.stats.frontierRewinds,
          expected_count_missed: expectedMissed
        });
        console.warn(`[${NAME}] Running conservative overlapping verification.`);
        conservative = await phase(context, "conservative scan", () => scan(context, true));
      }

      await phase(context, "final capture", async () => {
        capture(context, { reason: "final mounted refresh", refresh: true });
      });

      const scanFinishedAt = new Date();
      const scanDuration = Math.round(performance.now() - startedPerformance);
      const messages = sorted(context.records);
      const roles = roleCounts(messages);
      const prompts = roles.user || 0;
      const models = roles.assistant || 0;
      const titleInfo = title(value.chatTitleOverride);
      const snapshot = timestamp(scanFinishedAt);
      const extractionRunId = token(16);

      let scrollRestoreMs = 0;
      if (value.restoreScroll) {
        context.phase = "scroll restore";
        const restoreStarted = performance.now();
        port.set(originalRatio * port.max);
        await delay(value.restoreSettleMs, controller.signal);
        scrollRestoreMs = rounded(performance.now() - restoreStarted);
        scrollRestored = true;
        debug(context, "scroll_restored", {
          duration_ms: scrollRestoreMs,
          restored_top: Math.round(port.top),
          target_ratio: rounded(originalRatio, 6)
        });
      }

      addLongTasks(context, longTaskObserver?.takeRecords?.() || []);
      longTaskObserver?.disconnect();
      context.frameProbesOpen = false;
      const memoryEnd = memorySnapshot();
      const buildStarted = performance.now();
      context.phase = "result build";
      const basename = [
        safe(titleInfo.value), `prompts-${prompts}`,
        value.includeModelMessages ? `model-${models}` : "user-only",
        `snapshot-${snapshot}`,
        `scan-${Math.max(1, Math.round(scanDuration / 1000))}s`,
        `run-${extractionRunId}`
      ].join("__");

      const result = {
        schema: "chatgpt-active-branch-extract-v3",
        extractor_version: VERSION,
        conversation_title: titleInfo.value,
        conversation_title_source: titleInfo.source,
        browser_tab_title: titleInfo.browserTabTitle,
        extraction_run_id: extractionRunId,
        conversation_id: location.pathname.match(/\/(?:c|g)\/([^/?#]+)/)?.[1] || null,
        source_url: location.href,
        snapshot_at: scanFinishedAt.toISOString(),
        snapshot_local_label: snapshot,
        output_basename: basename,
        scope: "currently selected active DOM branch; alternate branches and hidden system/tool data are unavailable",
        settings: {
          include_model_messages: value.includeModelMessages,
          include_other_roles: value.includeOtherRoles,
          include_message_html: value.includeMessageHtml,
          include_debug_log: value.includeDebugLog,
          restore_original_scroll: value.restoreScroll,
          startup_wait_ms: value.startupWaitMs,
          expected_user_prompts: value.expectedUserPrompts,
          force_conservative_pass: value.forceConservativePass,
          settling: {
            strategy: "mutation and timer polling; no awaited animation frames",
            poll_interval_ms: value.pollIntervalMs,
            minimum_ms: value.minimumSettleMs,
            mutation_quiet_ms: value.mutationQuietMs,
            unchanged_ms: value.unchangedSettleMs,
            maximum_ms: value.maximumSettleMs
          },
          output: "pretty JSON inside one BOM-free .txt file"
        },
        startup: {
          initially_mounted_messages: startup.waitedMs === 0 ? initial.length : 0,
          mounted_messages_when_started: initial.length,
          waited_ms: startup.waitedMs,
          polls: startup.polls,
          wake_attempts: startup.wakeAttempts,
          wake_details: startup.wakeDetails
        },
        timing: {
          invoked_at: invokedAt.toISOString(),
          started_at: startedAt.toISOString(),
          scan_finished_at: scanFinishedAt.toISOString(),
          scan_duration_ms: scanDuration,
          scan_duration_seconds: rounded(scanDuration / 1000),
          scroll_restore_ms: scrollRestoreMs,
          phase_duration_ms: context.phaseTimings,
          note: "Per-message capture times are extraction times, not original message creation times."
        },
        counts: {
          user_prompts: prompts,
          model_messages: models,
          saved_messages: messages.length,
          all_roles_seen: context.coverage.size,
          role_counts: roles,
          unique_saved_keys: new Set(messages.map(item => item.key)).size,
          unique_message_ids: new Set(messages.map(item => item.message_id).filter(Boolean)).size
        },
        validation: {
          reached_top: conservative?.reachedTop ?? fast.reachedTop,
          reached_bottom: conservative?.reachedBottom ?? fast.reachedBottom,
          expected_prompt_count_satisfied: value.expectedUserPrompts == null
            ? null : prompts >= value.expectedUserPrompts,
          conservative_fallback_run: Boolean(conservative),
          frontier_rewinds: context.stats.frontierRewinds,
          bottom_evidence: context.lastBottomEvidence,
          bottom_geometry_confirmed:
            context.lastBottomEvidence?.final_message_at_viewport_bottom ?? null,
          bottom_geometry_fallback_used:
            context.lastBottomEvidence?.geometry_fallback_used || false,
          unstable_keys: [...context.coverage.values()].filter(item => item.unstable_key).length,
          numeric_turn_gaps: turnGaps(context.coverage),
          note: "Numeric gaps can be legitimate when consecutive user turns or an unanswered prompt has no separate assistant message."
        },
        streaming: {
          detected_at_start: streamedAtStart,
          detected_at_finish: streaming(),
          warning: streamedAtStart || streaming()
            ? "A response was streaming during the snapshot and may be partial." : null
        },
        traversal: {
          scroller: port.describe(),
          captures: context.stats.captures.count,
          moves: context.stats.moves,
          top_moves_skipped: context.stats.topMovesSkipped,
          bottom_anchor_confirmations: context.stats.bottomAnchors,
          bottom_geometry_fallbacks: context.stats.bottomGeometryFallbacks,
          frontier_jumps: context.stats.frontierJumps,
          unproductive_frontier_jumps: context.stats.unproductiveFrontierJumps,
          frontier_rewinds: context.stats.frontierRewinds,
          overlap_steps: context.stats.overlapSteps,
          conservative_passes: context.stats.conservativePasses,
          mutations_observed: context.stats.mutations,
          total_scroll_distance_px: Math.round(context.stats.scrollDistancePx),
          move_samples_kept: context.stats.moveSamples.length,
          move_samples_dropped: context.stats.moveSamplesDropped
        },
        performance: performanceBlock(
          context, messages, prompts, scanDuration, Boolean(longTaskObserver), memoryEnd
        ),
        debug: value.includeDebugLog ? {
          event_limit: value.debugEventLimit,
          dropped_events: context.debugDropped,
          environment: context.environment,
          events: context.debugEvents
        } : { enabled: false },
        output: {
          extension: ".txt",
          content: "pretty JSON",
          bom: false,
          unique_filename_design: "millisecond snapshot + extraction token + fresh save token",
          last_download_at: null,
          last_download_filename: null,
          last_download_id: null
        },
        messages
      };

      result.performance.result_build_ms = rounded(performance.now() - buildStarted);
      const preflightStarted = performance.now();
      const preflight = JSON.stringify(result);
      result.performance.serialization_preflight_ms = rounded(performance.now() - preflightStarted);
      result.performance.serialization_preflight_characters = preflight.length;

      const finishedAt = new Date();
      const totalDuration = Math.round(performance.now() - startedPerformance);
      result.timing.finished_at = finishedAt.toISOString();
      result.timing.total_extraction_duration_ms = totalDuration;
      result.timing.total_extraction_duration_seconds = rounded(totalDuration / 1000);
      result.timing.total_from_invocation_ms = Math.round(performance.now() - invokedPerformance);
      result.timing.total_from_invocation_seconds = rounded(
        result.timing.total_from_invocation_ms / 1000
      );
      debug(context, "run_finish", {
        scan_duration_ms: scanDuration,
        total_extraction_duration_ms: totalDuration,
        total_from_invocation_ms: result.timing.total_from_invocation_ms,
        messages: messages.length,
        prompts,
        model_messages: models
      });
      if (value.includeDebugLog) result.debug.dropped_events = context.debugDropped;

      api.lastResult = result;
      api.lastDebug = result.debug;
      window.__CHATGPT_PROMPT_EXTRACT_V3__ = result;
      window.__CHATGPT_PROMPT_EXTRACT_V3_DEBUG__ = result.debug;
      report(context, true);
      const filename = value.autoDownload ? download(result) : null;

      console.table({
        prompts,
        model_messages: models,
        saved_messages: messages.length,
        seconds: result.timing.scan_duration_seconds,
        moves: context.stats.moves,
        settle_p90_ms: result.performance.settling.p90_ms,
        timer_lag_max_ms: result.performance.timer_scheduler.maximum_timer_lag_ms,
        frontier_jumps: context.stats.frontierJumps,
        rewinds: context.stats.frontierRewinds,
        conservative_fallback: Boolean(conservative),
        reached_top: result.validation.reached_top,
        reached_bottom: result.validation.reached_bottom
      });
      console.log(`[${NAME}] COMPLETE${filename ? ` — ${filename}` : " — result cached; call .download()"}`);
      console.log(value.restoreScroll
        ? `[${NAME}] The original scroll position was restored after bottom verification.`
        : `[${NAME}] RESTORE_ORIGINAL_SCROLL=false, so the chat was left at the verified bottom.`);
      console.log(`Result: window.__CHATGPT_PROMPT_EXTRACT_V3__ | Debug: ${NAME}.lastDebug | Readable: ${NAME}.readable()`);
      return result;
    } catch (error) {
      api.lastError = error;
      api.lastPartial = partialResult(context, error);
      api.lastDebug = api.lastPartial.debug;
      window.__CHATGPT_PROMPT_EXTRACT_V3_PARTIAL__ = api.lastPartial;
      window.__CHATGPT_PROMPT_EXTRACT_V3_DEBUG__ = api.lastDebug;
      if (error?.name === "AbortError")
        console.warn(`[${NAME}] Stopped. Partial data is cached; call ${NAME}.downloadPartial() if wanted.`);
      else console.error(`[${NAME}] FAILED:`, error);
      console.log(`[${NAME}] Failure diagnostics: ${NAME}.lastDebug`);
      throw error;
    } finally {
      context.frameProbesOpen = false;
      longTaskObserver?.disconnect();
      if (value.restoreScroll && !scrollRestored) {
        try { port.set(originalRatio * port.max); } catch { /* best effort */ }
      }
      restoreSmooth();
      api.running = false;
      activeController = null;
      activeContext = null;
    }
  }

  void api.run().catch(error => {
    if (api.lastError !== error) {
      api.lastError = error;
      console.error(`[${NAME}] FAILED:`, error);
    }
  });
})();
