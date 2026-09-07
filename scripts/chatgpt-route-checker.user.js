// ==UserScript==
// @name         ChatGPT 模型检测
// @namespace    https://github.com/zjm54321/chatgpt-scripts
// @version      v2026.09.07-1
// @author       zjm54321
// @description  观察请求与响应中的模型标识，在 ChatGPT 顶栏显示状态。
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        none
// @run-at       document-start
// @noframes
// @homepageURL  https://github.com/zjm54321/chatgpt-scripts
// @supportURL   https://github.com/zjm54321/chatgpt-scripts/issues
// @downloadURL  https://raw.githubusercontent.com/zjm54321/chatgpt-scripts/main/scripts/chatgpt-route-checker.user.js
// @updateURL    https://raw.githubusercontent.com/zjm54321/chatgpt-scripts/main/scripts/chatgpt-route-checker.user.js
// ==/UserScript==

(function () {
  'use strict';

  if (window.__CHATGPT_SCRIPTS_ROUTE_CHECKER__) return;
  window.__CHATGPT_SCRIPTS_ROUTE_CHECKER__ = true;

function createModelMonitor(notify) {
  'use strict';

  var LIMIT = 1024 * 1024;
  var MAX_DEPTH = 12;
  var nativeFetch = window.fetch;
  var xhrPrototype = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  var nativeOpen = xhrPrototype && xhrPrototype.open;
  var nativeSend = xhrPrototype && xhrPrototype.send;
  var beaconOwner = window.navigator;
  var nativeBeacon = beaconOwner && beaconOwner.sendBeacon;
  var xhrInfo = new WeakMap();
  var xhrWatchers = [];
  var responseReaders = [];
  var serial = 0;
  var alive = true;
  var turn = { active: false, stamp: 0, userId: null };
  var state = {
    phase: 'idle',
    requestedModel: null,
    reportedModel: null,
    thinkingEffort: null,
    comparison: 'unknown'
  };

  function usable(value) {
    return typeof value === 'string' && value.trim() ? value : null;
  }

  function isAlias(value) {
    return /(^|[-_\s])(auto|unknown)([-_\s]|$)/i.test(value);
  }

  function compareModels(requested, reported) {
    var left = usable(requested);
    var right = usable(reported);
    var leftSeries;
    var rightSeries;
    if (!left || !right || isAlias(left) || isAlias(right)) return 'unknown';
    if (left === right) return 'exact';
    leftSeries = /^gpt-(\d+(?:[.-]\d+)*)\b/i.exec(left);
    rightSeries = /^gpt-(\d+(?:[.-]\d+)*)\b/i.exec(right);
    if (leftSeries && rightSeries &&
        leftSeries[1].replace(/[.-]/g, '-') === rightSeries[1].replace(/[.-]/g, '-')) {
      return 'family';
    }
    return 'different';
  }

  function snapshot() {
    return Object.freeze({
      phase: state.phase,
      requestedModel: state.requestedModel,
      reportedModel: state.reportedModel,
      thinkingEffort: state.thinkingEffort,
      comparison: state.comparison
    });
  }

  function publish() {
    state.comparison = compareModels(state.requestedModel, state.reportedModel);
    if (typeof notify === 'function') {
      try { notify(snapshot()); } catch (_) {}
    }
  }

  function isCurrent(stamp) {
    return alive && turn.active && turn.stamp === stamp;
  }

  function quietlyCancel(reader) {
    try {
      var pending = reader.cancel();
      if (pending && typeof pending.catch === 'function') pending.catch(function () {});
    } catch (_) {}
  }

  function stopResponseReaders() {
    var old = responseReaders;
    responseReaders = [];
    old.forEach(function (record) { quietlyCancel(record.reader); });
  }

  function beginTurn() {
    serial += 1;
    stopResponseReaders();
    turn.active = true;
    turn.stamp = serial;
    turn.userId = null;
    state.phase = 'waiting';
    state.requestedModel = null;
    state.reportedModel = null;
    state.thinkingEffort = null;
    publish();
    return serial;
  }

  function noModel(stamp) {
    if (!isCurrent(stamp) || state.reportedModel) return;
    state.phase = 'error';
    publish();
  }

  function failTurn(stamp) {
    if (!isCurrent(stamp)) return;
    turn.active = false;
    stopResponseReaders();
    state.phase = 'error';
    publish();
  }

  function endpointFor(source) {
    var raw = typeof source === 'string' ? source :
      (source && (source.url ||
        (typeof URL !== 'undefined' && source instanceof URL && source.href)));
    var url;
    try { url = new URL(raw, window.location.href); } catch (_) { return null; }
    if (url.origin !== window.location.origin) return null;
    if (url.pathname === '/backend-api/f/conversation' ||
        url.pathname === '/backend-api/conversation') return 'conversation';
    if (url.pathname === '/ces/v1/telemetry/intake') return 'telemetry';
    return null;
  }

  function fetchMethod(input, init) {
    if (init && init.method) return String(init.method).toUpperCase();
    if (input && typeof input !== 'string' && input.method) {
      return String(input.method).toUpperCase();
    }
    return 'GET';
  }

  function decodeBytes(bytes) {
    try { return new TextDecoder('utf-8').decode(bytes); } catch (_) { return null; }
  }

  function simpleBodyText(body) {
    var bytes;
    if (typeof body === 'string') return Promise.resolve(body.length <= LIMIT ? body : null);
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
      return Promise.resolve(body.toString());
    }
    if (typeof Blob !== 'undefined' && body instanceof Blob) {
      if (body.size > LIMIT || typeof body.text !== 'function') return Promise.resolve(null);
      return body.text().then(function (text) {
        return text.length <= LIMIT ? text : null;
      }, function () { return null; });
    }
    if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) {
      if (body.byteLength > LIMIT) return Promise.resolve(null);
      return Promise.resolve(decodeBytes(new Uint8Array(body)));
    }
    if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(body)) {
      if (body.byteLength > LIMIT) return Promise.resolve(null);
      bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
      return Promise.resolve(decodeBytes(bytes));
    }
    return Promise.resolve(null);
  }

  function readStreamText(stream) {
    var reader;
    var decoder;
    var parts = [];
    var size = 0;
    try {
      reader = stream.getReader();
      decoder = new TextDecoder('utf-8');
    } catch (_) {
      return Promise.resolve(null);
    }
    return new Promise(function (resolve) {
      function finish(value) {
        quietlyCancel(reader);
        resolve(value);
      }
      function next() {
        reader.read().then(function (result) {
          var chunk;
          if (result.done) {
            chunk = decoder.decode();
            if (size + chunk.length > LIMIT) return finish(null);
            return finish(parts.join('') + chunk);
          }
          chunk = decoder.decode(result.value, { stream: true });
          size += chunk.length;
          if (size > LIMIT) return finish(null);
          parts.push(chunk);
          next();
        }, function () { finish(null); });
      }
      next();
    });
  }

  function fetchBodyText(input, init) {
    if (init && Object.prototype.hasOwnProperty.call(init, 'body')) {
      return simpleBodyText(init.body);
    }
    try {
      if (typeof Request !== 'undefined' && input instanceof Request) {
        var duplicate = input.clone();
        return duplicate.body ? readStreamText(duplicate.body) : Promise.resolve(null);
      }
    } catch (_) {}
    return Promise.resolve(null);
  }

  function parseJson(text) {
    if (typeof text !== 'string' || text.length > LIMIT) return null;
    try { return JSON.parse(text); } catch (_) { return null; }
  }

  function userMessageId(message) {
    var role;
    if (!message || typeof message !== 'object') return null;
    role = message.role || (message.author && message.author.role);
    if (role !== 'user') return null;
    return usable(message.id) || usable(message.message_id);
  }

  function lastUserId(payload) {
    var messages = payload && payload.messages;
    var index;
    var id;
    if (Array.isArray(messages)) {
      for (index = messages.length - 1; index >= 0; index -= 1) {
        id = userMessageId(messages[index]);
        if (id) return id;
      }
    }
    return userMessageId(payload && payload.message);
  }

  function applyRequest(payload, stamp) {
    if (!isCurrent(stamp) || !payload || typeof payload !== 'object') return;
    state.requestedModel = usable(payload.model);
    state.thinkingEffort = usable(payload.thinking_effort);
    turn.userId = lastUserId(payload);
    publish();
  }

  function inspectRequest(textPromise, stamp, telemetry) {
    textPromise.then(function (text) {
      var payload = parseJson(text);
      if (!payload) return;
      if (telemetry) applyTelemetry(payload, stamp);
      else applyRequest(payload, stamp);
    }, function () {});
  }

  function directServerSlug(value) {
    var metadata;
    var nested;
    var slug;
    if (!value || typeof value !== 'object') return null;
    if (value.type === 'server_ste_metadata') {
      metadata = value.metadata;
      slug = metadata && usable(metadata.model_slug);
      if (slug) return slug;
    }
    nested = value.server_ste_metadata;
    if (nested && typeof nested === 'object') {
      return usable(nested.model_slug) || (nested.metadata && usable(nested.metadata.model_slug));
    }
    return null;
  }

  function serverSlug(value, depth, budget) {
    var key;
    var found;
    if (!value || typeof value !== 'object' || depth > MAX_DEPTH || budget.left-- <= 0) return null;
    found = directServerSlug(value);
    if (found) return found;
    for (key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key) &&
          value[key] && typeof value[key] === 'object') {
        found = serverSlug(value[key], depth + 1, budget);
        if (found) return found;
      }
    }
    return null;
  }

  function reportSlug(slug, stamp) {
    if (!isCurrent(stamp) || !slug) return false;
    state.reportedModel = slug;
    state.phase = 'ready';
    publish();
    return true;
  }

  function reportMetadata(payload, stamp) {
    return reportSlug(serverSlug(payload, 0, { left: 3000 }), stamp);
  }

  function ownCurrentId(record, userId) {
    return Object.prototype.hasOwnProperty.call(record, 'message_id') && record.message_id === userId ||
      Object.prototype.hasOwnProperty.call(record, 'user_message_id') && record.user_message_id === userId ||
      Object.prototype.hasOwnProperty.call(record, 'current_message_id') && record.current_message_id === userId;
  }

  function localTelemetrySlug(record, depth, budget) {
    var analytics;
    var found;
    if (!record || typeof record !== 'object' || depth > MAX_DEPTH || budget.left-- <= 0) return null;
    found = directServerSlug(record);
    if (found) return found;
    analytics = record.turn_analytics;
    if (analytics && typeof analytics === 'object') {
      return localTelemetrySlug(analytics, depth + 1, budget);
    }
    return null;
  }

  function telemetrySlug(value, userId, depth, budget) {
    var key;
    var found;
    if (!value || typeof value !== 'object' || depth > MAX_DEPTH || budget.left-- <= 0) return null;
    if (!Array.isArray(value) && ownCurrentId(value, userId)) {
      return localTelemetrySlug(value, 0, { left: 300 });
    }
    for (key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key) &&
          value[key] && typeof value[key] === 'object') {
        found = telemetrySlug(value[key], userId, depth + 1, budget);
        if (found) return found;
      }
    }
    return null;
  }

  function applyTelemetry(payload, stamp) {
    var slug;
    if (!isCurrent(stamp) || !turn.userId) return;
    slug = telemetrySlug(payload, turn.userId, 0, { left: 3000 });
    if (slug) reportSlug(slug, stamp);
  }

  function removeReader(record) {
    var index = responseReaders.indexOf(record);
    if (index >= 0) responseReaders.splice(index, 1);
  }

  function observeFetchResponse(response, stamp) {
    var copy;
    var reader;
    var decoder;
    var record;
    var lineBuffer = '';
    var eventLines = [];
    var eventSize = 0;
    var raw = '';
    var rawOpen = true;
    var settled = false;
    try {
      copy = response.clone();
      if (!copy.body) return noModel(stamp);
      reader = copy.body.getReader();
      decoder = new TextDecoder('utf-8');
    } catch (_) {
      return noModel(stamp);
    }
    record = { reader: reader };
    responseReaders.push(record);

    function finish(found) {
      if (settled) return;
      settled = true;
      removeReader(record);
      quietlyCancel(reader);
      if (!found) noModel(stamp);
    }
    function readEvent() {
      var payload;
      if (!eventLines.length) return false;
      payload = parseJson(eventLines.join('\n'));
      eventLines = [];
      eventSize = 0;
      return payload ? reportMetadata(payload, stamp) : false;
    }
    function readLine(line) {
      var size;
      var data;
      if (!line) return readEvent();
      if (line.slice(0, 5) !== 'data:') return false;
      data = line.slice(5);
      if (data.charAt(0) === ' ') data = data.slice(1);
      size = eventSize + data.length + (eventLines.length ? 1 : 0);
      if (size > LIMIT) {
        eventLines = [];
        eventSize = 0;
        return false;
      }
      eventLines.push(data);
      eventSize = size;
      return false;
    }
    function receive(text) {
      var newline;
      var line;
      if (rawOpen) {
        if (raw.length + text.length <= LIMIT) raw += text;
        else rawOpen = false;
      }
      lineBuffer += text;
      while ((newline = lineBuffer.indexOf('\n')) >= 0) {
        line = lineBuffer.slice(0, newline);
        lineBuffer = lineBuffer.slice(newline + 1);
        if (line.charAt(line.length - 1) === '\r') line = line.slice(0, -1);
        if (readLine(line)) return true;
      }
      if (lineBuffer.length > LIMIT) lineBuffer = '';
      return false;
    }
    function endOfFile() {
      var found = false;
      if (lineBuffer) found = readLine(lineBuffer.replace(/\r$/, ''));
      if (!found) found = readEvent();
      if (!found && rawOpen) {
        found = reportMetadata(parseJson(raw), stamp);
      }
      finish(found);
    }
    function pump() {
      reader.read().then(function (result) {
        var text;
        if (settled) return;
        if (!isCurrent(stamp)) return finish(true);
        if (result.done) {
          text = decoder.decode();
          if (text && receive(text)) return finish(true);
          return endOfFile();
        }
        text = decoder.decode(result.value, { stream: true });
        if (receive(text)) return finish(true);
        pump();
      }, function () { finish(false); });
    }
    pump();
  }

  function responseTextMetadata(text, stamp) {
    var lines;
    var index;
    var line;
    var data = [];
    var size = 0;
    var found = false;
    var payload = parseJson(text);
    if (payload) return reportMetadata(payload, stamp);
    lines = text.split(/\r?\n/);
    for (index = 0; index <= lines.length; index += 1) {
      line = lines[index] || '';
      if (!line) {
        if (data.length) {
          payload = parseJson(data.join('\n'));
          data = [];
          size = 0;
          if (payload && reportMetadata(payload, stamp)) return true;
        }
      } else if (line.slice(0, 5) === 'data:') {
        line = line.slice(5);
        if (line.charAt(0) === ' ') line = line.slice(1);
        size += line.length + (data.length ? 1 : 0);
        if (size <= LIMIT) data.push(line);
        else { data = []; size = 0; }
      }
    }
    return found;
  }

  function inspectXhrResponse(xhr, stamp) {
    var type;
    var payload;
    var text;
    if (!isCurrent(stamp)) return false;
    try { type = xhr.responseType; } catch (_) { return false; }
    try {
      if (type === 'json') {
        payload = xhr.response;
        return payload && typeof payload === 'object' && reportMetadata(payload, stamp);
      }
      if (type === '' || type === 'text') {
        text = xhr.responseText;
        return typeof text === 'string' && text.length <= LIMIT && responseTextMetadata(text, stamp);
      }
    } catch (_) {}
    return false;
  }

  function forgetXhr(xhr) {
    var index;
    for (index = xhrWatchers.length - 1; index >= 0; index -= 1) {
      if (xhrWatchers[index].xhr === xhr) xhrWatchers[index].cleanup();
    }
  }

  function clearXhrWatchers() {
    while (xhrWatchers.length) xhrWatchers[0].cleanup();
  }

  function watchXhr(xhr, stamp) {
    var watcher;
    function cleanup() {
      var index = xhrWatchers.indexOf(watcher);
      xhr.removeEventListener('loadend', onLoadEnd);
      if (index >= 0) xhrWatchers.splice(index, 1);
    }
    function onLoadEnd() {
      var status;
      cleanup();
      if (!isCurrent(stamp)) return;
      try { status = xhr.status; } catch (_) { return failTurn(stamp); }
      if (status < 200 || status >= 300) return failTurn(stamp);
      inspectXhrResponse(xhr, stamp);
      noModel(stamp);
    }
    watcher = { xhr: xhr, cleanup: cleanup };
    xhrWatchers.push(watcher);
    xhr.addEventListener('loadend', onLoadEnd);
    return cleanup;
  }

  function fetchWrapper(input, init) {
    var kind;
    var method;
    var stamp;
    var result;
    if (!alive) return nativeFetch.apply(this, arguments);
    kind = endpointFor(input);
    method = fetchMethod(input, init);
    if (kind === 'conversation' && method === 'POST') {
      stamp = beginTurn();
      inspectRequest(fetchBodyText(input, init), stamp, false);
      try {
        result = nativeFetch.apply(this, arguments);
      } catch (error) {
        failTurn(stamp);
        throw error;
      }
      try {
        result.then(function (response) {
          if (!response || !response.ok) failTurn(stamp);
          else observeFetchResponse(response, stamp);
        }, function () { failTurn(stamp); });
      } catch (_) {}
      return result;
    }
    if (kind === 'telemetry' && method === 'POST' && turn.active) {
      inspectRequest(fetchBodyText(input, init), turn.stamp, true);
    }
    return nativeFetch.apply(this, arguments);
  }

  function openWrapper(method, url) {
    if (!alive) return nativeOpen.apply(this, arguments);
    forgetXhr(this);
    xhrInfo.set(this, {
      kind: endpointFor(url),
      method: String(method || 'GET').toUpperCase()
    });
    return nativeOpen.apply(this, arguments);
  }

  function sendWrapper(body) {
    var xhr = this;
    var info;
    var stamp;
    var cleanup;
    if (!alive) return nativeSend.apply(this, arguments);
    info = xhrInfo.get(xhr);
    if (info && info.kind === 'conversation' && info.method === 'POST') {
      stamp = beginTurn();
      inspectRequest(simpleBodyText(body), stamp, false);
      cleanup = watchXhr(xhr, stamp);
      try {
        return nativeSend.apply(this, arguments);
      } catch (error) {
        cleanup();
        failTurn(stamp);
        throw error;
      }
    }
    if (info && info.kind === 'telemetry' && info.method === 'POST' && turn.active) {
      inspectRequest(simpleBodyText(body), turn.stamp, true);
    }
    return nativeSend.apply(this, arguments);
  }

  function beaconWrapper(url, data) {
    if (!alive) return nativeBeacon.apply(this, arguments);
    if (endpointFor(url) === 'telemetry' && turn.active) {
      inspectRequest(simpleBodyText(data), turn.stamp, true);
    }
    return nativeBeacon.apply(this, arguments);
  }

  try {
    if (typeof nativeFetch === 'function') window.fetch = fetchWrapper;
  } catch (_) {}
  try {
    if (xhrPrototype) {
      xhrPrototype.open = openWrapper;
      xhrPrototype.send = sendWrapper;
    }
  } catch (_) {}
  try {
    if (typeof nativeBeacon === 'function') beaconOwner.sendBeacon = beaconWrapper;
  } catch (_) {}

  function stop() {
    if (!alive) return;
    alive = false;
    turn.active = false;
    stopResponseReaders();
    clearXhrWatchers();
    if (window.fetch === fetchWrapper) {
      try { window.fetch = nativeFetch; } catch (_) {}
    }
    if (xhrPrototype && xhrPrototype.open === openWrapper) {
      try { xhrPrototype.open = nativeOpen; } catch (_) {}
    }
    if (xhrPrototype && xhrPrototype.send === sendWrapper) {
      try { xhrPrototype.send = nativeSend; } catch (_) {}
    }
    if (beaconOwner && beaconOwner.sendBeacon === beaconWrapper) {
      try { beaconOwner.sendBeacon = nativeBeacon; } catch (_) {}
    }
  }

  return Object.freeze({ snapshot: snapshot, stop: stop });
}

function mountRouteChecker(options = {}) {
    let currentSnapshot = {
        phase: "idle",
        requestedModel: null,
        reportedModel: null,
        thinkingEffort: null,
        comparison: "unknown"
    };
    let isOpen = false;

    // Clean up any stale existing host
    const oldHost = document.getElementById("__chatgpt_route_checker_host__");
    if (oldHost) oldHost.remove();

    const ICONS = {
        ellipsis: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
        pending: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
        check: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>',
        warning: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
        close: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
    };

    function resolveVerdict(snap) {
        if (!snap || snap.phase === "idle") {
            return {
                status: "idle",
                text: "等待发送新消息",
                iconSvg: ICONS.ellipsis,
                isWarning: false
            };
        }
        if (snap.phase === "error") {
            return {
                status: "error",
                text: "未取得模型信息",
                iconSvg: ICONS.pending,
                isWarning: false
            };
        }
        if (snap.phase === "waiting") {
            const text = !snap.requestedModel ? "读取请求中…" : "等待服务端响应…";
            return {
                status: "pending",
                text,
                iconSvg: ICONS.pending,
                isWarning: false
            };
        }
        if (snap.phase === "ready") {
            if (snap.comparison === "exact") {
                return {
                    status: "match",
                    text: "模型一致",
                    iconSvg: ICONS.check,
                    isWarning: false
                };
            }
            if (snap.comparison === "family") {
                return {
                    status: "family-match",
                    text: "同系列模型",
                    iconSvg: ICONS.check,
                    isWarning: false
                };
            }
            if (snap.comparison === "different") {
                return {
                    status: "mismatch",
                    text: "模型不一致",
                    iconSvg: ICONS.warning,
                    isWarning: true
                };
            }
            return {
                status: "unknown",
                text: "模型标识暂无法比较",
                iconSvg: ICONS.pending,
                isWarning: false
            };
        }
        return {
            status: "idle",
            text: "等待发送新消息",
            iconSvg: ICONS.ellipsis,
            isWarning: false
        };
    }

    // Host & Shadow DOM Setup
    const host = document.createElement("div");
    host.id = "__chatgpt_route_checker_host__";
    host.setAttribute("data-chatgpt-route-checker", "");
    document.documentElement.appendChild(host);

    const shadow = host.attachShadow({ mode: "open" });

    const styleEl = document.createElement("style");
    styleEl.textContent = `
        :host {
            --cg-rc-bg-popover: #ffffff;
            --cg-rc-bg-secondary: #f7f7f8;
            --cg-rc-bg-hover: rgba(0, 0, 0, 0.06);
            --cg-rc-bg-active: rgba(0, 0, 0, 0.1);
            --cg-rc-border: rgba(0, 0, 0, 0.1);
            --cg-rc-border-secondary: rgba(0, 0, 0, 0.06);
            --cg-rc-text-primary: #0d0d0d;
            --cg-rc-text-secondary: #5d5d5d;
            --cg-rc-text-muted: #8e8e8e;
            --cg-rc-warning-fg: #b45309;
            --cg-rc-warning-bg: rgba(245, 158, 11, 0.08);
            --cg-rc-warning-border: rgba(245, 158, 11, 0.25);
            --cg-rc-focus-ring: #0d0d0d;
            --cg-rc-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1), 0 0 0 1px rgba(0, 0, 0, 0.06);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            -webkit-font-smoothing: antialiased;
            -moz-osx-font-smoothing: grayscale;
        }

        :host([data-theme="dark"]) {
            --cg-rc-bg-popover: #212121;
            --cg-rc-bg-secondary: #2f2f2f;
            --cg-rc-bg-hover: rgba(255, 255, 255, 0.08);
            --cg-rc-bg-active: rgba(255, 255, 255, 0.14);
            --cg-rc-border: rgba(255, 255, 255, 0.15);
            --cg-rc-border-secondary: rgba(255, 255, 255, 0.08);
            --cg-rc-text-primary: #ececec;
            --cg-rc-text-secondary: #b4b4b4;
            --cg-rc-text-muted: #737373;
            --cg-rc-warning-fg: #f59e0b;
            --cg-rc-warning-bg: rgba(245, 158, 11, 0.12);
            --cg-rc-warning-border: rgba(245, 158, 11, 0.3);
            --cg-rc-focus-ring: #ececec;
            --cg-rc-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.1);
        }

        @media (prefers-color-scheme: dark) {
            :host(:not([data-theme="light"])) {
                --cg-rc-bg-popover: #212121;
                --cg-rc-bg-secondary: #2f2f2f;
                --cg-rc-bg-hover: rgba(255, 255, 255, 0.08);
                --cg-rc-bg-active: rgba(255, 255, 255, 0.14);
                --cg-rc-border: rgba(255, 255, 255, 0.15);
                --cg-rc-border-secondary: rgba(255, 255, 255, 0.08);
                --cg-rc-text-primary: #ececec;
                --cg-rc-text-secondary: #b4b4b4;
                --cg-rc-text-muted: #737373;
                --cg-rc-warning-fg: #f59e0b;
                --cg-rc-warning-bg: rgba(245, 158, 11, 0.12);
                --cg-rc-warning-border: rgba(245, 158, 11, 0.3);
                --cg-rc-focus-ring: #ececec;
                --cg-rc-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.1);
            }
        }

        .cg-rc-btn {
            position: fixed;
            z-index: 2147483646;
            width: 36px;
            height: 36px;
            padding: 0;
            margin: 0;
            box-sizing: border-box;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            border-radius: 8px;
            border: none;
            background: transparent;
            color: var(--cg-rc-text-primary);
            cursor: pointer;
            outline: none;
            user-select: none;
            transition: background-color 0.15s ease, color 0.15s ease, transform 0.1s ease;
        }

        .cg-rc-btn[hidden] {
            display: none !important;
        }

        .cg-rc-btn:hover {
            background-color: var(--cg-rc-bg-hover);
        }

        .cg-rc-btn:active {
            background-color: var(--cg-rc-bg-active);
            transform: scale(0.96);
        }

        .cg-rc-btn:focus-visible {
            outline: 2px solid var(--cg-rc-focus-ring);
            outline-offset: 2px;
        }

        .cg-rc-btn.mismatch {
            color: var(--cg-rc-warning-fg);
        }

        .cg-rc-icon-slot {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 18px;
            height: 18px;
        }

        .cg-rc-popover {
            position: fixed;
            z-index: 2147483647;
            width: 280px;
            max-width: calc(100vw - 24px);
            box-sizing: border-box;
            background: var(--cg-rc-bg-popover);
            border: 1px solid var(--cg-rc-border);
            border-radius: 12px;
            box-shadow: var(--cg-rc-shadow);
            color: var(--cg-rc-text-primary);
            padding: 12px;
            display: flex;
            flex-direction: column;
            gap: 10px;
            user-select: none;
            overflow-y: auto;
        }

        .cg-rc-popover[hidden] {
            display: none !important;
        }

        .cg-rc-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
        }

        .cg-rc-verdict-tag {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 4px 8px;
            border-radius: 6px;
            background: var(--cg-rc-bg-secondary);
            border: 1px solid var(--cg-rc-border-secondary);
            font-size: 12px;
            font-weight: 500;
            line-height: 1.3;
            color: var(--cg-rc-text-primary);
        }

        .cg-rc-verdict-tag.mismatch {
            color: var(--cg-rc-warning-fg);
            background: var(--cg-rc-warning-bg);
            border-color: var(--cg-rc-warning-border);
        }

        .cg-rc-verdict-icon {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 14px;
            height: 14px;
        }

        .cg-rc-verdict-icon svg {
            width: 14px;
            height: 14px;
        }

        .cg-rc-close-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 24px;
            height: 24px;
            border-radius: 6px;
            border: none;
            background: transparent;
            color: var(--cg-rc-text-muted);
            cursor: pointer;
            padding: 0;
            outline: none;
            transition: background-color 0.15s ease, color 0.15s ease;
        }

        .cg-rc-close-btn:hover {
            background-color: var(--cg-rc-bg-hover);
            color: var(--cg-rc-text-primary);
        }

        .cg-rc-close-btn:focus-visible {
            outline: 2px solid var(--cg-rc-focus-ring);
            outline-offset: 1px;
        }

        .cg-rc-card {
            background: var(--cg-rc-bg-secondary);
            border: 1px solid var(--cg-rc-border-secondary);
            border-radius: 8px;
            padding: 8px 10px;
        }

        .cg-rc-card-label {
            font-size: 10px;
            color: var(--cg-rc-text-muted);
            margin-bottom: 3px;
            letter-spacing: 0.2px;
        }

        .cg-rc-card-val {
            font-size: 13px;
            font-weight: 600;
            color: var(--cg-rc-text-primary);
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            word-break: break-all;
            user-select: text;
            -webkit-user-select: text;
            cursor: text;
        }

        .cg-rc-card-val.empty {
            color: var(--cg-rc-text-muted);
            font-weight: normal;
            font-size: 12px;
        }

        .cg-rc-list-card {
            display: flex;
            flex-direction: column;
            gap: 5px;
            background: var(--cg-rc-bg-secondary);
            border: 1px solid var(--cg-rc-border-secondary);
            border-radius: 8px;
            padding: 8px 10px;
        }

        .cg-rc-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            font-size: 11px;
        }

        .cg-rc-row-key {
            color: var(--cg-rc-text-muted);
            flex-shrink: 0;
        }

        .cg-rc-row-val {
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-size: 11.5px;
            color: var(--cg-rc-text-primary);
            max-width: 140px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            user-select: text;
            -webkit-user-select: text;
            cursor: text;
            text-align: right;
        }

        .cg-rc-row-val.empty {
            color: var(--cg-rc-text-muted);
        }

        .cg-rc-footer {
            font-size: 10.5px;
            color: var(--cg-rc-text-muted);
            line-height: 1.4;
            padding-top: 4px;
            border-top: 1px solid var(--cg-rc-border-secondary);
        }

        @media (prefers-reduced-motion: reduce) {
            .cg-rc-btn, .cg-rc-close-btn, .cg-rc-popover {
                transition: none !important;
                animation: none !important;
            }
        }
    `;
    shadow.appendChild(styleEl);

    // Build DOM structure
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cg-rc-btn";
    btn.id = "cg-rc-trigger-btn";
    btn.setAttribute("data-testid", "route-checker-btn");
    btn.setAttribute("aria-haspopup", "dialog");
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-controls", "cg-rc-popover");
    btn.hidden = true;

    const iconSlot = document.createElement("span");
    iconSlot.className = "cg-rc-icon-slot";
    btn.appendChild(iconSlot);
    shadow.appendChild(btn);

    const popover = document.createElement("div");
    popover.id = "cg-rc-popover";
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", "模型路由检测详情");
    popover.setAttribute("aria-modal", "false");
    popover.setAttribute("data-testid", "route-checker-popover");
    popover.className = "cg-rc-popover";
    popover.hidden = true;

    popover.innerHTML = `
        <div class="cg-rc-header">
            <div class="cg-rc-verdict-tag" data-testid="route-checker-verdict">
                <span class="cg-rc-verdict-icon"></span>
                <span class="cg-rc-verdict-text"></span>
            </div>
            <button type="button" class="cg-rc-close-btn" data-testid="route-checker-close" aria-label="关闭详情" title="关闭详情">
                ${ICONS.close}
            </button>
        </div>
        <div class="cg-rc-card">
            <div class="cg-rc-card-label">server_ste_metadata.model_slug</div>
            <div class="cg-rc-card-val server-val" data-field="server-model"></div>
        </div>
        <div class="cg-rc-list-card">
            <div class="cg-rc-row">
                <span class="cg-rc-row-key">request.model</span>
                <span class="cg-rc-row-val req-val" data-field="request-model"></span>
            </div>
            <div class="cg-rc-row">
                <span class="cg-rc-row-key">request.thinking_effort</span>
                <span class="cg-rc-row-val effort-val" data-field="thinking-effort"></span>
            </div>
        </div>
        <div class="cg-rc-footer">
            仅对比模型标识，不代表回答质量。
        </div>
    `;
    shadow.appendChild(popover);

    const verdictTagEl = popover.querySelector(".cg-rc-verdict-tag");
    const verdictIconEl = popover.querySelector(".cg-rc-verdict-icon");
    const verdictTextEl = popover.querySelector(".cg-rc-verdict-text");
    const closeBtn = popover.querySelector(".cg-rc-close-btn");
    const serverValEl = popover.querySelector(".server-val");
    const reqValEl = popover.querySelector(".req-val");
    const effortValEl = popover.querySelector(".effort-val");

    // Theme Management
    const darkMedia = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

    function getExplicitTheme(el) {
        if (!el) return null;
        const dt = el.getAttribute("data-theme");
        if (dt === "dark" || dt === "light") return dt;
        if (el.classList.contains("dark")) return "dark";
        if (el.classList.contains("light")) return "light";
        return null;
    }

    function updateTheme() {
        const theme = getExplicitTheme(document.documentElement) ||
                      getExplicitTheme(document.body) ||
                      (darkMedia && darkMedia.matches ? "dark" : "light");
        host.setAttribute("data-theme", theme);
    }
    updateTheme();

    if (darkMedia) {
        darkMedia.addEventListener("change", updateTheme);
    }

    const themeObserver = new MutationObserver(updateTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
    if (document.body) {
        themeObserver.observe(document.body, { attributes: true, attributeFilter: ["class", "data-theme"] });
    }

    // Toggle popover
    function togglePopover(force, returnFocus = true) {
        const next = typeof force === "boolean" ? force : !isOpen;
        if (isOpen === next) return;
        isOpen = next;
        btn.setAttribute("aria-expanded", String(next));
        host.setAttribute("data-open", String(next));

        if (next) {
            popover.hidden = false;
            updatePosition();
        } else {
            popover.hidden = true;
            if (returnFocus && !btn.hidden) {
                btn.focus();
            }
        }
    }

    const onBtnClick = (e) => {
        e.stopPropagation();
        togglePopover();
    };

    const onCloseClick = (e) => {
        e.stopPropagation();
        togglePopover(false, true);
    };

    const onPointerDown = (e) => {
        if (!isOpen) return;
        const path = e.composedPath ? e.composedPath() : [];
        if (!path.includes(host)) {
            togglePopover(false, false);
        }
    };

    const onKeyDown = (e) => {
        if (e.key === "Escape" && isOpen) {
            e.stopPropagation();
            togglePopover(false, true);
        }
    };

    btn.addEventListener("click", onBtnClick);
    closeBtn.addEventListener("click", onCloseClick);
    document.addEventListener("pointerdown", onPointerDown, { passive: true });
    window.addEventListener("keydown", onKeyDown);

    // Robust element visibility helper
    function isElementVisible(el) {
        if (!el || !(el instanceof Element) || !el.isConnected) return false;
        if (typeof el.checkVisibility === "function") {
            if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
                return false;
            }
        } else {
            if (el.getClientRects().length === 0) return false;
            try {
                const style = window.getComputedStyle(el);
                if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || parseFloat(style.opacity) === 0) {
                    return false;
                }
            } catch {}
        }
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        if (r.bottom <= 0 || r.top >= window.innerHeight || r.right <= 0 || r.left >= window.innerWidth) {
            return false;
        }
        return true;
    }

    // Positioning and native anchor search
    function findNativeAnchor() {
        const candidates = [
            ...document.querySelectorAll('[data-testid="share-chat-button"]'),
            ...document.querySelectorAll('#conversation-header-actions')
        ];
        for (const el of candidates) {
            if (isElementVisible(el)) {
                const r = el.getBoundingClientRect();
                if (r.top >= 0 && r.top < 200) {
                    return { element: el, rect: r };
                }
            }
        }
        return null;
    }

    function getTargetAnchor() {
        const native = findNativeAnchor();
        if (!native) return null;

        let targetRect = native.rect;

        // Check if Inkstone is present, active in header mode, actually visible, and geometry consistent
        const inkHost = document.querySelector('[data-inkstone]');
        if (inkHost && (!inkHost.getAttribute('data-pos') || inkHost.getAttribute('data-pos') === 'header')) {
            const inkFab = inkHost.shadowRoot?.querySelector('.fab');
            if (isElementVisible(inkFab)) {
                const inkRect = inkFab.getBoundingClientRect();
                if (Math.abs(inkRect.top - native.rect.top) < 30 && inkRect.left < native.rect.right && inkRect.left > native.rect.left - 140) {
                    targetRect = inkRect;
                }
            } else if (inkHost.isConnected) {
                targetRect = {
                    left: native.rect.left - 44,
                    top: native.rect.top,
                    width: 36,
                    height: native.rect.height
                };
            }
        }

        return targetRect;
    }

    let lastTop = -1;
    let lastRight = -1;

    function updatePosition() {
        const targetRect = getTargetAnchor();

        if (!targetRect) {
            btn.hidden = true;
            if (isOpen) {
                togglePopover(false, false);
            }
            lastTop = -1;
            lastRight = -1;
            return;
        }

        btn.hidden = false;

        const right = window.innerWidth - targetRect.left + 8;
        const top = targetRect.top + (targetRect.height - 36) / 2;

        const maxRight = Math.max(8, window.innerWidth - 44);
        const minRight = 8;
        const clampedRight = Math.min(Math.max(right, minRight), maxRight);
        const maxTop = Math.max(4, window.innerHeight - 36 - 8);
        const clampedTop = Math.min(Math.max(4, top), maxTop);

        if (Math.abs(clampedTop - lastTop) > 0.5 || Math.abs(clampedRight - lastRight) > 0.5) {
            lastTop = clampedTop;
            lastRight = clampedRight;
            btn.style.top = `${clampedTop}px`;
            btn.style.right = `${clampedRight}px`;
        }

        if (isOpen) {
            const popoverWidth = 280;
            const popTop = clampedTop + 42;
            const maxPopRight = Math.max(12, window.innerWidth - popoverWidth - 12);
            const minPopRight = 12;
            const clampedPopRight = Math.min(Math.max(clampedRight, minPopRight), maxPopRight);
            const maxPopHeight = Math.max(0, window.innerHeight - popTop - 12);

            popover.style.top = `${popTop}px`;
            popover.style.right = `${clampedPopRight}px`;
            popover.style.maxHeight = `${maxPopHeight}px`;
            popover.style.overflowY = "auto";
        }
    }

    let rafId = null;
    function schedulePositionUpdate() {
        if (rafId) return;
        rafId = requestAnimationFrame(() => {
            rafId = null;
            updatePosition();
        });
    }

    window.addEventListener("resize", schedulePositionUpdate, { passive: true });
    window.addEventListener("scroll", schedulePositionUpdate, { passive: true });

    const domObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
            if (m.target === host || host.contains(m.target)) continue;
            schedulePositionUpdate();
            break;
        }
    });
    domObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });

    const pollIntervalId = setInterval(schedulePositionUpdate, 1500);

    // Stable UI render based on snapshot
    function render() {
        const v = resolveVerdict(currentSnapshot);

        host.setAttribute("data-status", v.status);
        btn.setAttribute("title", `模型路由检测: ${v.text}`);
        btn.setAttribute("aria-label", `模型路由检测: ${v.text}`);

        if (v.isWarning) {
            btn.classList.add("mismatch");
        } else {
            btn.classList.remove("mismatch");
        }

        iconSlot.innerHTML = v.iconSvg;
        verdictIconEl.innerHTML = v.iconSvg;
        verdictTextEl.textContent = v.text;

        verdictTagEl.className = `cg-rc-verdict-tag ${v.status}`;
        if (v.isWarning) {
            verdictTagEl.classList.add("mismatch");
        }

        if (currentSnapshot.reportedModel) {
            serverValEl.textContent = currentSnapshot.reportedModel;
            serverValEl.title = currentSnapshot.reportedModel;
            serverValEl.classList.remove("empty");
        } else {
            serverValEl.textContent = "等待捕获…";
            serverValEl.title = "";
            serverValEl.classList.add("empty");
        }

        if (currentSnapshot.requestedModel) {
            reqValEl.textContent = currentSnapshot.requestedModel;
            reqValEl.title = currentSnapshot.requestedModel;
            reqValEl.classList.remove("empty");
        } else {
            reqValEl.textContent = "-";
            reqValEl.title = "";
            reqValEl.classList.add("empty");
        }

        if (currentSnapshot.thinkingEffort) {
            effortValEl.textContent = currentSnapshot.thinkingEffort;
            effortValEl.title = currentSnapshot.thinkingEffort;
            effortValEl.classList.remove("empty");
        } else {
            effortValEl.textContent = "-";
            effortValEl.title = "";
            effortValEl.classList.add("empty");
        }
    }

    render();
    updatePosition();

    return {
        update(snapshot) {
            if (snapshot && typeof snapshot === "object") {
                currentSnapshot = { ...currentSnapshot, ...snapshot };
                render();
            }
        },
        destroy() {
            if (pollIntervalId) clearInterval(pollIntervalId);
            if (rafId) cancelAnimationFrame(rafId);
            domObserver.disconnect();
            themeObserver.disconnect();
            if (darkMedia) darkMedia.removeEventListener("change", updateTheme);
            btn.removeEventListener("click", onBtnClick);
            closeBtn.removeEventListener("click", onCloseClick);
            document.removeEventListener("pointerdown", onPointerDown);
            window.removeEventListener("keydown", onKeyDown);
            window.removeEventListener("resize", schedulePositionUpdate);
            window.removeEventListener("scroll", schedulePositionUpdate);
            host.remove();
        }
    };
}

  var view = null;
  var monitor = createModelMonitor(function (snap) {
    if (view) view.update(snap);
  });

  function mount() {
    if (view || !document.documentElement) return;
    view = mountRouteChecker();
    view.update(monitor.snapshot());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
}());
