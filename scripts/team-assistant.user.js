// ==UserScript==
// @name         Team 助手
// @namespace    https://github.com/zjm54321/chatgpt-scripts
// @version      v2026.09.07-3
// @description  成员席位历史、用量额度统计与历史账单查询，隐藏指定用量提醒；不修改额度或计费设置。
// @author       zjm54321
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        none
// @run-at       document-start
// @noframes
// @homepageURL  https://github.com/zjm54321/chatgpt-scripts
// @supportURL   https://github.com/zjm54321/chatgpt-scripts/issues
// @downloadURL  https://raw.githubusercontent.com/zjm54321/chatgpt-scripts/main/scripts/team-assistant.user.js
// @updateURL    https://raw.githubusercontent.com/zjm54321/chatgpt-scripts/main/scripts/team-assistant.user.js
// ==/UserScript==

(() => {
    "use strict";

    // Idempotent singleton guard
    if (window.__CHATGPT_TEAM_ASSISTANT__) return;
    window.__CHATGPT_TEAM_ASSISTANT__ = true;

function createSeatHistoryMonitor(onChange) {
  'use strict';

  var HISTORY_KEY = 'codex:chatgpt-vacancy-monitor:v1';
  var MEMBERS_KEY = 'codex:chatgpt-vacancy-monitor:members:v1';
  var LOCK_NAME = 'codex:chatgpt-vacancy-monitor:write';
  var own = Object.prototype.hasOwnProperty;
  var win = typeof window === 'object' ? window : null;
  var doc = win && win.document;
  var destroyed = false;
  var storageError = null;
  var fallbackAccountId = null;
  var activeAccountId = null;
  var writeQueue = Promise.resolve();
  var latestMembersRequest = 0;
  var intervalId = null;
  var pendingXhrs = new Set();
  var xhrStates = new WeakMap();
  var nativeFetch = null;
  var fetchWrapper = null;
  var xhrPrototype = null;
  var nativeXhrOpen = null;
  var nativeXhrSend = null;
  var xhrOpenWrapper = null;
  var xhrSendWrapper = null;

  function has(object, key) {
    return object !== null && typeof object === 'object' && own.call(object, key);
  }

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function defineOwn(object, key, value) {
    Object.defineProperty(object, key, {
      configurable: true,
      enumerable: true,
      value: value,
      writable: true
    });
  }

  function safePrimitive(value) {
    if (value === null) return null;
    var type = typeof value;
    return type === 'string' || type === 'number' || type === 'boolean' ? value : null;
  }

  function ownPrimitive(object, key) {
    return has(object, key) ? safePrimitive(object[key]) : null;
  }

  function noteReadFailure() {
    if (storageError === null) storageError = '本地历史不可用';
  }

  function noteSaveFailure() {
    storageError = '本地历史未能保存';
  }

  function readStoredObject(key) {
    try {
      var raw = win.localStorage.getItem(key);
      if (raw === null) return { available: true, value: {} };
      var parsed = JSON.parse(raw);
      if (isRecord(parsed)) return { available: true, value: parsed };
      noteReadFailure();
      return { available: false, value: {} };
    } catch (_) {
      noteReadFailure();
      return { available: false, value: {} };
    }
  }

  function saveStoredObject(key, value) {
    try {
      win.localStorage.setItem(key, JSON.stringify(value));
      storageError = null;
      return true;
    } catch (_) {
      noteSaveFailure();
      return false;
    }
  }

  function stripQuotes(value) {
    if (value.length >= 2 && ((value[0] === '"' && value[value.length - 1] === '"') ||
        (value[0] === "'" && value[value.length - 1] === "'"))) {
      return value.slice(1, -1);
    }
    return value;
  }

  // Deliberately inspect only the _account cookie's value.
  function accountFromCookie() {
    if (!doc) return null;
    var cookies;
    try {
      cookies = doc.cookie;
    } catch (_) {
      return null;
    }
    var parts = cookies.split(';');
    for (var index = 0; index < parts.length; index += 1) {
      var part = parts[index];
      var equals = part.indexOf('=');
      var name = (equals < 0 ? part : part.slice(0, equals)).trim();
      if (name !== '_account') continue;
      var value = (equals < 0 ? '' : part.slice(equals + 1)).trim();
      value = stripQuotes(value);
      try {
        value = decodeURIComponent(value);
      } catch (_) {
        return null;
      }
      value = stripQuotes(value).trim();
      return value ? value : null;
    }
    return null;
  }

  function resolvedAccountId() {
    return accountFromCookie() || fallbackAccountId || null;
  }

  function refreshAccountId() {
    var next = resolvedAccountId();
    var changed = next !== activeAccountId;
    activeAccountId = next;
    return changed;
  }

  function cleanHistory(history) {
    var result = [];
    if (!Array.isArray(history)) return result;
    for (var index = 0; index < history.length; index += 1) {
      var item = history[index];
      if (!isRecord(item) || !has(item, 'capturedAt') || typeof item.capturedAt !== 'string') continue;
      result.push({
        capturedAt: item.capturedAt,
        vacancyOrdinal: ownPrimitive(item, 'vacancyOrdinal'),
        freeVacancyThreshold: ownPrimitive(item, 'freeVacancyThreshold'),
        billingStartsAt: ownPrimitive(item, 'billingStartsAt'),
        expiresAt: ownPrimitive(item, 'expiresAt')
      });
    }
    return result;
  }

  function snapshot() {
    refreshAccountId();
    var accountId = activeAccountId;
    var records = readStoredObject(HISTORY_KEY).value;
    var aliases = readStoredObject(MEMBERS_KEY).value;
    var accountAliases = accountId && has(aliases, accountId) && isRecord(aliases[accountId])
      ? aliases[accountId]
      : null;
    var entries = [];

    if (accountId) {
      var keys = Object.keys(records);
      for (var index = 0; index < keys.length; index += 1) {
        var record = records[keys[index]];
        if (!isRecord(record) || !has(record, 'accountId') || !has(record, 'userId') ||
            !has(record, 'history') || record.accountId !== accountId || typeof record.userId !== 'string' ||
            !Array.isArray(record.history)) continue;
        var email = accountAliases && has(accountAliases, record.userId) &&
            typeof accountAliases[record.userId] === 'string'
          ? accountAliases[record.userId]
          : null;
        var history = cleanHistory(record.history);
        if (!history.length) continue;
        entries.push({
          accountId: accountId,
          userId: record.userId,
          email: email,
          history: history
        });
      }
    }

    entries.sort(function (left, right) {
      var leftHistory = left.history;
      var rightHistory = right.history;
      var leftAt = leftHistory.length ? leftHistory[leftHistory.length - 1].capturedAt : '';
      var rightAt = rightHistory.length ? rightHistory[rightHistory.length - 1].capturedAt : '';
      if (leftAt !== rightAt) return leftAt < rightAt ? 1 : -1;
      return left.userId < right.userId ? -1 : left.userId > right.userId ? 1 : 0;
    });

    return {
      accountId: accountId,
      entries: entries,
      storageError: storageError
    };
  }

  function notify() {
    if (destroyed || typeof onChange !== 'function') return;
    try {
      onChange(snapshot());
    } catch (_) {
      // The host callback is never allowed to affect page behavior.
    }
  }

  function serialize(task) {
    function run() {
      var locks = win && win.navigator && win.navigator.locks;
      if (!locks || typeof locks.request !== 'function') return task();
      try {
        return locks.request(LOCK_NAME, { mode: 'exclusive' }, task);
      } catch (_) {
        return task();
      }
    }
    var next = writeQueue.then(run, run);
    writeQueue = next.catch(function () {});
    return next;
  }

  function samePolicy(left, right) {
    return left && Object.is(left.vacancyOrdinal, right.vacancyOrdinal) &&
      Object.is(left.freeVacancyThreshold, right.freeVacancyThreshold) &&
      Object.is(left.billingStartsAt, right.billingStartsAt) &&
      Object.is(left.expiresAt, right.expiresAt);
  }

  function appendPolicy(accountId, userId, values) {
    return serialize(function () {
      if (destroyed) return { ok: false, changed: false };
      var stored = readStoredObject(HISTORY_KEY);
      if (!stored.available) {
        noteSaveFailure();
        return { ok: false, changed: false };
      }
      var records = stored.value;
      var key = accountId + '/' + userId;
      var previous = has(records, key) && isRecord(records[key]) ? records[key] : null;
      var history = previous && has(previous, 'history') && Array.isArray(previous.history)
        ? previous.history.slice()
        : [];
      var last = history.length && isRecord(history[history.length - 1]) ? history[history.length - 1] : null;
      var lastValues = last && {
        vacancyOrdinal: ownPrimitive(last, 'vacancyOrdinal'),
        freeVacancyThreshold: ownPrimitive(last, 'freeVacancyThreshold'),
        billingStartsAt: ownPrimitive(last, 'billingStartsAt'),
        expiresAt: ownPrimitive(last, 'expiresAt')
      };
      if (samePolicy(lastValues, values)) return { ok: true, changed: false };

      history.push({
        capturedAt: new Date().toISOString(),
        vacancyOrdinal: values.vacancyOrdinal,
        freeVacancyThreshold: values.freeVacancyThreshold,
        billingStartsAt: values.billingStartsAt,
        expiresAt: values.expiresAt
      });
      defineOwn(records, key, { accountId: accountId, userId: userId, history: history });
      return { ok: saveStoredObject(HISTORY_KEY, records), changed: true };
    }).then(function (result) {
      if (!result.ok) notify();
      else if (result.changed) notify();
      return result.ok;
    }, function () {
      noteSaveFailure();
      notify();
      return false;
    });
  }

  function updateAliases(accountId, pairs) {
    if (!pairs.length) return Promise.resolve(true);
    return serialize(function () {
      if (destroyed) return { ok: false, changed: false };
      var stored = readStoredObject(MEMBERS_KEY);
      if (!stored.available) {
        noteSaveFailure();
        return { ok: false, changed: false };
      }
      var members = stored.value;
      var aliases = has(members, accountId) && isRecord(members[accountId]) ? members[accountId] : {};
      var changed = !has(members, accountId) || members[accountId] !== aliases;
      defineOwn(members, accountId, aliases);
      for (var index = 0; index < pairs.length; index += 1) {
        var pair = pairs[index];
        if (!has(aliases, pair.userId) || !Object.is(aliases[pair.userId], pair.email)) {
          defineOwn(aliases, pair.userId, pair.email);
          changed = true;
        }
      }
      if (!changed) return { ok: true, changed: false };
      return { ok: saveStoredObject(MEMBERS_KEY, members), changed: true };
    }).then(function (result) {
      if (!result.ok || result.changed) notify();
      return result.ok;
    }, function () {
      noteSaveFailure();
      notify();
      return false;
    });
  }

  function clearHistoryFor(accountId) {
    return serialize(function () {
      if (destroyed) return { ok: false, changed: false };
      var stored = readStoredObject(HISTORY_KEY);
      if (!stored.available) {
        noteSaveFailure();
        return { ok: false, changed: false };
      }
      var records = stored.value;
      var prefix = accountId + '/';
      var changed = false;
      Object.keys(records).forEach(function (key) {
        var record = records[key];
        if (key.indexOf(prefix) === 0 && isRecord(record) && has(record, 'accountId') &&
            record.accountId === accountId) {
          delete records[key];
          changed = true;
        }
      });
      if (!changed) return { ok: true, changed: false };
      return { ok: saveStoredObject(HISTORY_KEY, records), changed: true };
    }).then(function (result) {
      if (!result.ok || result.changed) notify();
      return result.ok;
    }, function () {
      noteSaveFailure();
      notify();
      return false;
    });
  }

  function policyValues(payload) {
    if (!isRecord(payload) || !has(payload, 'policy_notice')) return null;
    var notice = payload.policy_notice;
    if (notice === null) {
      return {
        vacancyOrdinal: null,
        freeVacancyThreshold: null,
        billingStartsAt: null,
        expiresAt: null
      };
    }
    if (!isRecord(notice) || !has(notice, 'vacancy_ordinal') ||
        !has(notice, 'free_vacancy_threshold')) return null;
    var vacancyOrdinal = policyNumber(notice.vacancy_ordinal);
    var freeVacancyThreshold = policyNumber(notice.free_vacancy_threshold);
    var billingStartsAt = has(notice, 'billing_starts_at')
      ? policyDate(notice.billing_starts_at)
      : { value: null };
    var expiresAt = has(notice, 'expires_at') ? policyDate(notice.expires_at) : { value: null };
    if (!vacancyOrdinal || !freeVacancyThreshold || !billingStartsAt || !expiresAt) return null;
    return {
      vacancyOrdinal: vacancyOrdinal.value,
      freeVacancyThreshold: freeVacancyThreshold.value,
      billingStartsAt: billingStartsAt.value,
      expiresAt: expiresAt.value
    };
  }

  function policyNumber(value) {
    if (value === null || (typeof value === 'number' && isFinite(value))) return { value: value };
    if (typeof value === 'string' && value.trim() !== '' && isFinite(Number(value))) {
      return { value: value };
    }
    return null;
  }

  function policyDate(value) {
    if (value === null || typeof value === 'string' ||
        (typeof value === 'number' && isFinite(value))) return { value: value };
    return null;
  }

  function decodeSegment(value) {
    try {
      var decoded = decodeURIComponent(value);
      return decoded && decoded.indexOf('/') < 0 ? decoded : null;
    } catch (_) {
      return null;
    }
  }

  function makeTarget(method, inputUrl) {
    if (!win || (method !== 'GET' && method !== 'DELETE')) return null;
    try {
      var url = new win.URL(inputUrl, win.location.href);
      if (url.origin !== win.location.origin) return null;
      var membersMatch = /^\/backend-api\/accounts\/([^/]+)\/users\/?$/.exec(url.pathname);
      if (method === 'GET' && membersMatch) {
        var membersAccount = decodeSegment(membersMatch[1]);
        if (!membersAccount) return null;
        return { accountId: membersAccount, kind: 'members' };
      }
      var deleteMatch = /^\/backend-api\/accounts\/([^/]+)\/users\/([^/]+)\/?$/.exec(url.pathname);
      if (method === 'DELETE' && deleteMatch) {
        var accountId = decodeSegment(deleteMatch[1]);
        var userId = decodeSegment(deleteMatch[2]);
        if (!accountId || !userId || userId.indexOf('user-') !== 0) return null;
        return { accountId: accountId, kind: 'delete', userId: userId };
      }
    } catch (_) {
      // URL inspection is best-effort and must not affect the request.
    }
    return null;
  }

  function beginMembersRequest(target) {
    if (!target || target.kind !== 'members') return target;
    latestMembersRequest += 1;
    var cookieAccountId = accountFromCookie();
    var started = {
      accountId: target.accountId,
      accountAtStart: cookieAccountId,
      kind: 'members',
      requestNumber: latestMembersRequest
    };
    if (!cookieAccountId && fallbackAccountId !== started.accountId) {
      fallbackAccountId = started.accountId;
      if (refreshAccountId()) notify();
    }
    return started;
  }

  function memberPairs(payload) {
    if (!isRecord(payload) || !Array.isArray(payload.items)) return null;
    var pairs = [];
    payload.items.forEach(function (item) {
      if (!isRecord(item) || !has(item, 'email') || typeof item.email !== 'string') return;
      var email = item.email.trim();
      if (!email) return;
      [has(item, 'id') ? item.id : null, has(item, 'account_user_id') ? item.account_user_id : null]
        .forEach(function (candidate) {
        if (typeof candidate !== 'string' || !candidate) return;
        pairs.push({ email: email, userId: candidate });
      });
    });
    return pairs;
  }

  function consumeMembers(target, payload) {
    var pairs = memberPairs(payload);
    if (pairs === null) return;
    if (refreshAccountId()) notify();
    updateAliases(target.accountId, pairs);
  }

  function consumePayload(target, payload) {
    if (destroyed || !target) return;
    if (target.kind === 'members') {
      consumeMembers(target, payload);
      return;
    }
    var values = policyValues(payload);
    if (values) appendPolicy(target.accountId, target.userId, values);
  }

  function fetchTarget(args) {
    var input = args[0];
    var init = args[1];
    var url = null;
    if (typeof input === 'string') url = input;
    else if (win.URL && input instanceof win.URL) url = input.href;
    else if (input && typeof input.url === 'string') url = input.url;
    if (url === null) return null;
    var method = 'GET';
    if (init !== null && (typeof init === 'object' || typeof init === 'function') &&
        init.method !== null && init.method !== undefined) {
      method = String(init.method);
    } else if (input && typeof input.method === 'string') {
      method = input.method;
    }
    return makeTarget(method.toUpperCase(), url);
  }

  function observeFetch(target, response) {
    if (destroyed) return;
    try {
      if (!response || response.status < 200 || response.status >= 300) return;
      var cloned = response.clone();
      Promise.resolve(cloned.json()).then(function (payload) {
        consumePayload(target, payload);
      }, function () {}).catch(function () {});
    } catch (_) {
      // A response clone or JSON parse failure is intentionally invisible to the page.
    }
  }

  function installFetchHook() {
    if (!win || typeof win.fetch !== 'function') return;
    nativeFetch = win.fetch;
    fetchWrapper = function () {
      if (destroyed) return nativeFetch.apply(this, arguments);
      var target = null;
      try {
        target = fetchTarget(arguments);
      } catch (_) {}
      var returned = nativeFetch.apply(this, arguments);
      try {
        target = beginMembersRequest(target);
      } catch (_) {
        target = null;
      }
      if (target) {
        try {
          Promise.resolve(returned).then(function (response) {
            observeFetch(target, response);
          }, function () {}).catch(function () {});
        } catch (_) {}
      }
      return returned;
    };
    try {
      win.fetch = fetchWrapper;
    } catch (_) {
      fetchWrapper = null;
    }
  }

  function removeXhrState(xhr, state) {
    var actual = state || xhrStates.get(xhr);
    if (!actual) return;
    if (actual.listener) {
      try {
        xhr.removeEventListener('loadend', actual.listener);
      } catch (_) {}
    }
    if (xhrStates.get(xhr) === actual) xhrStates.delete(xhr);
    pendingXhrs.delete(xhr);
  }

  function observeXhr(xhr, state) {
    removeXhrState(xhr, state);
    if (destroyed) return;
    try {
      if (xhr.status < 200 || xhr.status >= 300) return;
      var responseType = xhr.responseType || '';
      if (responseType !== '' && responseType !== 'text' && responseType !== 'json') return;
      var payload = responseType === 'json' ? xhr.response : JSON.parse(xhr.responseText);
      consumePayload(state.target, payload);
    } catch (_) {
      // XHR response access and parsing are best-effort only.
    }
  }

  function installXhrHook() {
    if (!win || !win.XMLHttpRequest || !win.XMLHttpRequest.prototype) return;
    xhrPrototype = win.XMLHttpRequest.prototype;
    nativeXhrOpen = xhrPrototype.open;
    nativeXhrSend = xhrPrototype.send;
    if (typeof nativeXhrOpen !== 'function' || typeof nativeXhrSend !== 'function') return;

    xhrOpenWrapper = function () {
      var xhr = this;
      if (destroyed) return nativeXhrOpen.apply(xhr, arguments);
      removeXhrState(xhr);
      var target = null;
      try {
        target = makeTarget(String(arguments[0]).toUpperCase(), arguments[1]);
      } catch (_) {}
      var returned = nativeXhrOpen.apply(xhr, arguments);
      if (target && !destroyed) {
        try {
          var state = { listener: null, target: target };
          xhrStates.set(xhr, state);
        } catch (_) {}
      }
      return returned;
    };

    xhrSendWrapper = function () {
      var xhr = this;
      var state = xhrStates.get(xhr);
      if (!state || destroyed) return nativeXhrSend.apply(xhr, arguments);
      removeXhrState(xhr, state);
      xhrStates.set(xhr, state);
      try {
        state.target = beginMembersRequest(state.target);
      } catch (_) {
        removeXhrState(xhr, state);
        return nativeXhrSend.apply(xhr, arguments);
      }
      state.listener = function () {
        observeXhr(xhr, state);
      };
      try {
        xhr.addEventListener('loadend', state.listener);
        pendingXhrs.add(xhr);
      } catch (_) {
        state.listener = null;
      }
      try {
        return nativeXhrSend.apply(xhr, arguments);
      } catch (error) {
        removeXhrState(xhr, state);
        throw error;
      }
    };

    var openInstalled = false;
    var sendInstalled = false;
    try {
      xhrPrototype.open = xhrOpenWrapper;
      openInstalled = xhrPrototype.open === xhrOpenWrapper;
    } catch (_) {}
    try {
      xhrPrototype.send = xhrSendWrapper;
      sendInstalled = xhrPrototype.send === xhrSendWrapper;
    } catch (_) {}
    if (!openInstalled || !sendInstalled) {
      if (openInstalled && xhrPrototype.open === xhrOpenWrapper) {
        try { xhrPrototype.open = nativeXhrOpen; } catch (_) {}
      }
      if (sendInstalled && xhrPrototype.send === xhrSendWrapper) {
        try { xhrPrototype.send = nativeXhrSend; } catch (_) {}
      }
      xhrOpenWrapper = null;
      xhrSendWrapper = null;
    }
  }

  function isMembersPath() {
    try {
      return /(?:^|\/)members(?:\/|$)/i.test(win.location.pathname);
    } catch (_) {
      return false;
    }
  }

  function refreshOnAccountEvent() {
    if (refreshAccountId()) notify();
  }

  function onStorage(event) {
    if (!event || event.key === null || event.key === HISTORY_KEY || event.key === MEMBERS_KEY) {
      refreshAccountId();
      notify();
    }
  }

  if (!win || !doc) {
    return {
      getSnapshot: function () {
        return { accountId: null, entries: [], storageError: '本地历史不可用' };
      },
      clearCurrentHistory: function () { return Promise.resolve(false); },
      destroy: function () {}
    };
  }

  refreshAccountId();
  installFetchHook();
  installXhrHook();
  win.addEventListener('focus', refreshOnAccountEvent);
  win.addEventListener('pageshow', refreshOnAccountEvent);
  win.addEventListener('popstate', refreshOnAccountEvent);
  win.addEventListener('storage', onStorage);
  intervalId = win.setInterval(function () {
    if (isMembersPath()) refreshOnAccountEvent();
  }, 1000);
  notify();

  return {
    getSnapshot: function () {
      return snapshot();
    },
    clearCurrentHistory: function () {
      var accountId = snapshot().accountId;
      return accountId ? clearHistoryFor(accountId) : Promise.resolve(false);
    },
    destroy: function () {
      if (destroyed) return;
      destroyed = true;
      win.removeEventListener('focus', refreshOnAccountEvent);
      win.removeEventListener('pageshow', refreshOnAccountEvent);
      win.removeEventListener('popstate', refreshOnAccountEvent);
      win.removeEventListener('storage', onStorage);
      if (intervalId !== null) win.clearInterval(intervalId);
      pendingXhrs.forEach(function (xhr) { removeXhrState(xhr); });
      if (fetchWrapper && win.fetch === fetchWrapper) {
        try { win.fetch = nativeFetch; } catch (_) {}
      }
      if (xhrPrototype && xhrOpenWrapper && xhrPrototype.open === xhrOpenWrapper) {
        try { xhrPrototype.open = nativeXhrOpen; } catch (_) {}
      }
      if (xhrPrototype && xhrSendWrapper && xhrPrototype.send === xhrSendWrapper) {
        try { xhrPrototype.send = nativeXhrSend; } catch (_) {}
      }
    }
  };
}

function mountSeatHistoryPanel(options) {
    'use strict';
    options = options || {};
    var currentSnapshot = { accountId: null, entries: [], storageError: null };
    var isOpen = false;
    var isClearing = false;
    var clearError = null;
    var destroyed = false;
    var lastTop = -1;
    var lastRight = -1;
    var rafId = null;
    var lastBodySignature = null;
    var lastRenderedAccountId = null;
    var bodyDirty = true;

    // Clean up stale instances if any exist
    var oldHosts = document.querySelectorAll('[data-seat-history-btn]');
    for (var h = 0; h < oldHosts.length; h++) {
        oldHosts[h].remove();
    }
    var oldPanelHosts = document.querySelectorAll('[data-seat-history-panel]');
    for (var p = 0; p < oldPanelHosts.length; p++) {
        oldPanelHosts[p].remove();
    }
    var ICONS = {
        contacts: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 2v2m1.915 17a6 6 0 1 0-12 0M8 2v2"/><circle cx="12" cy="11" r="4"/><rect width="18" height="18" x="3" y="3" rx="2"/></svg>',
        close: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
    };
    var THEME_CSS = `
        :host {
            --cg-sh-bg-popover: #ffffff; --cg-sh-bg-secondary: #f7f7f8;
            --cg-sh-bg-hover: rgba(0, 0, 0, 0.05); --cg-sh-bg-active: rgba(0, 0, 0, 0.08);
            --cg-sh-border: rgba(0, 0, 0, 0.12); --cg-sh-border-secondary: rgba(0, 0, 0, 0.06);
            --cg-sh-text-primary: #0d0d0d; --cg-sh-text-secondary: #5d5d5d; --cg-sh-text-muted: #8e8e8e;
            --cg-sh-focus-ring: #0d0d0d; --cg-sh-tag-bg: rgba(0, 0, 0, 0.04);
            --cg-sh-shadow: 0 10px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1), 0 0 0 1px rgba(0,0,0,0.06);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
        }
        :host([data-theme="dark"]) {
            --cg-sh-bg-popover: #212121; --cg-sh-bg-secondary: #2f2f2f;
            --cg-sh-bg-hover: rgba(255, 255, 255, 0.08); --cg-sh-bg-active: rgba(255, 255, 255, 0.12);
            --cg-sh-border: rgba(255, 255, 255, 0.15); --cg-sh-border-secondary: rgba(255, 255, 255, 0.08);
            --cg-sh-text-primary: #ececec; --cg-sh-text-secondary: #b4b4b4; --cg-sh-text-muted: #737373;
            --cg-sh-focus-ring: #ececec; --cg-sh-tag-bg: rgba(255, 255, 255, 0.06);
            --cg-sh-shadow: 0 10px 25px -5px rgba(0,0,0,0.5), 0 8px 10px -6px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.1);
        }
    `;

    function el(tag, cls, text, parent, attrs) {
        var node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text !== undefined && text !== null) node.textContent = text;
        if (attrs) {
            for (var k in attrs) {
                if (k === 'hidden') node.hidden = Boolean(attrs[k]);
                else if (k === 'disabled') node.disabled = Boolean(attrs[k]);
                else node.setAttribute(k, attrs[k]);
            }
        }
        if (parent) parent.appendChild(node);
        return node;
    }
    // 1. Button Host inside native header action group
    var btnHost = document.createElement('div');
    btnHost.id = '__chatgpt_team_seat_history_btn_host__';
    btnHost.setAttribute('data-seat-history-btn', '');
    btnHost.style.display = 'none';

    var btnShadow = btnHost.attachShadow({ mode: 'open' });
    var btnStyle = document.createElement('style');
    btnStyle.textContent = THEME_CSS + `
        :host { display: inline-flex; align-items: center; justify-content: center; vertical-align: middle; position: relative; box-sizing: border-box; flex-shrink: 0; line-height: 0; margin: 0; padding: 0; }
        .cg-sh-btn {
            width: 36px; height: 36px; min-width: 36px; min-height: 36px; padding: 0; margin: 0; box-sizing: border-box; flex-shrink: 0;
            display: inline-flex; align-items: center; justify-content: center; border-radius: 50%;
            border: 1px solid var(--border-light, var(--cg-sh-border)); background: transparent;
            color: var(--text-secondary, var(--cg-sh-text-secondary)); cursor: pointer; outline: none; user-select: none; -webkit-user-select: none;
            transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease, transform 0.1s ease;
        }
        .cg-sh-btn:hover { background-color: var(--main-surface-secondary, var(--cg-sh-bg-hover)); color: var(--text-primary, var(--cg-sh-text-primary)); border-color: var(--border-light, var(--cg-sh-border)); }
        .cg-sh-btn:active { background-color: var(--cg-sh-bg-active); transform: scale(0.96); }
        .cg-sh-btn:focus-visible { outline: 2px solid var(--cg-sh-focus-ring); outline-offset: 2px; }
        .cg-sh-btn[data-open="true"] { background-color: var(--main-surface-secondary, var(--cg-sh-bg-hover)); color: var(--text-primary, var(--cg-sh-text-primary)); border-color: var(--border-light, var(--cg-sh-border)); }
        .cg-sh-btn[hidden] { display: none !important; }
        .cg-sh-icon-slot { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; line-height: 0; color: currentColor; }
        .cg-sh-icon-slot svg { display: block; width: 18px; height: 18px; }
        @media (pointer: coarse) { .cg-sh-btn { min-width: 44px; min-height: 44px; } }
        @media (prefers-reduced-motion: reduce) {
            .cg-sh-btn { transition: none !important; }
        }`;
    btnShadow.appendChild(btnStyle);
    var btn = el('button', 'cg-sh-btn', null, btnShadow, {
        type: 'button', id: 'cg-sh-trigger-btn', 'aria-label': '席位阈值历史',
        title: '席位阈值历史', 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
        hidden: true
    });
    var iconSlot = el('span', 'cg-sh-icon-slot', null, btn);
    iconSlot.innerHTML = ICONS.contacts;
    // 2. Portalled Popover Host in document.body
    var panelHost = document.createElement('div');
    panelHost.id = '__chatgpt_team_seat_history_panel_host__';
    panelHost.setAttribute('data-seat-history-panel', '');
    (document.body || document.documentElement).appendChild(panelHost);

    var panelShadow = panelHost.attachShadow({ mode: 'open' });
    var panelStyle = document.createElement('style');
    panelStyle.textContent = THEME_CSS + `
        :host { position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647; pointer-events: none; }
        .cg-sh-popover {
            position: fixed; pointer-events: auto; width: 440px; max-width: calc(100vw - 24px); box-sizing: border-box;
            background: var(--main-surface-primary, var(--cg-sh-bg-popover)); border: 1px solid var(--border-light, var(--cg-sh-border));
            border-radius: 12px; box-shadow: var(--cg-sh-shadow); color: var(--text-primary, var(--cg-sh-text-primary));
            display: flex; flex-direction: column; user-select: none; overflow: hidden;
        }
        .cg-sh-popover[hidden] { display: none !important; }
        @keyframes cg-sh-enter { from { opacity: 0; transform: translateY(-4px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
        .cg-sh-popover:not([hidden]) { animation: cg-sh-enter 0.15s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
        .cg-sh-header { padding: 12px 14px 10px; border-bottom: 1px solid var(--border-light, var(--cg-sh-border-secondary)); display: flex; flex-direction: column; gap: 8px; flex-shrink: 0; }
        .cg-sh-header-main { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .cg-sh-title-group { display: flex; align-items: center; gap: 8px; }
        .cg-sh-title { font-size: 14px; font-weight: 600; color: var(--text-primary, var(--cg-sh-text-primary)); line-height: 1.2; }
        .cg-sh-count-badge {
            font-size: 11px; font-weight: 500; padding: 2px 6px; border-radius: 4px;
            background: var(--main-surface-secondary, var(--cg-sh-bg-secondary)); color: var(--text-secondary, var(--cg-sh-text-secondary));
            border: 1px solid var(--border-light, var(--cg-sh-border-secondary)); font-variant-numeric: tabular-nums;
        }
        .cg-sh-actions { display: flex; align-items: center; gap: 6px; }
        .cg-sh-clear-btn {
            font-size: 11px; padding: 3px 8px; border-radius: 6px; border: 1px solid var(--border-light, var(--cg-sh-border-secondary));
            background: transparent; color: var(--text-secondary, var(--cg-sh-text-secondary)); cursor: pointer; outline: none; user-select: none;
            transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease;
        }
        .cg-sh-clear-btn:hover:not(:disabled) { background-color: rgba(239, 68, 68, 0.08); color: #ef4444; border-color: rgba(239, 68, 68, 0.2); }
        .cg-sh-clear-btn:active:not(:disabled) { transform: scale(0.96); }
        .cg-sh-clear-btn:focus-visible { outline: 2px solid var(--cg-sh-focus-ring); outline-offset: 1px; }
        .cg-sh-clear-btn:disabled { opacity: 0.45; cursor: not-allowed; }
        .cg-sh-close-btn {
            display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 6px;
            border: none; background: transparent; color: var(--text-secondary, var(--cg-sh-text-muted)); cursor: pointer; padding: 0;
            outline: none; transition: background-color 0.15s ease, color 0.15s ease;
        }
        .cg-sh-close-btn:hover { background-color: var(--main-surface-secondary, var(--cg-sh-bg-hover)); color: var(--text-primary, var(--cg-sh-text-primary)); }
        .cg-sh-close-btn:focus-visible { outline: 2px solid var(--cg-sh-focus-ring); outline-offset: 1px; }
        .cg-sh-workspace-bar { display: flex; align-items: center; gap: 6px; font-size: 11px; }
        .cg-sh-ws-label { color: var(--text-secondary, var(--cg-sh-text-muted)); flex-shrink: 0; }
        .cg-sh-ws-id {
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 11px;
            color: var(--text-primary, var(--cg-sh-text-secondary)); background: var(--main-surface-secondary, var(--cg-sh-bg-secondary));
            padding: 1px 6px; border-radius: 4px; border: 1px solid var(--border-light, var(--cg-sh-border-secondary));
            user-select: text; -webkit-user-select: text; cursor: text; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .cg-sh-error-bar { font-size: 11px; color: #ef4444; background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.2); border-radius: 6px; padding: 4px 8px; line-height: 1.3; }
        .cg-sh-body { padding: 12px 14px; flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
        .cg-sh-body::-webkit-scrollbar { width: 6px; }
        .cg-sh-body::-webkit-scrollbar-thumb { background: rgba(128, 128, 128, 0.25); border-radius: 3px; }
        .cg-sh-body::-webkit-scrollbar-thumb:hover { background: rgba(128, 128, 128, 0.4); }
        .cg-sh-empty { padding: 24px 12px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 6px; }
        .cg-sh-empty-title { font-size: 13px; font-weight: 500; color: var(--text-primary, var(--cg-sh-text-primary)); }
        .cg-sh-empty-sub { font-size: 11px; color: var(--text-secondary, var(--cg-sh-text-muted)); line-height: 1.4; }
        .cg-sh-member-card { background: var(--main-surface-secondary, var(--cg-sh-bg-secondary)); border: 1px solid var(--border-light, var(--cg-sh-border-secondary)); border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
        .cg-sh-member-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
        .cg-sh-member-meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .cg-sh-member-email { font-size: 13px; font-weight: 600; color: var(--text-primary, var(--cg-sh-text-primary)); word-break: break-all; user-select: text; -webkit-user-select: text; cursor: text; }
        .cg-sh-member-email.pending { color: var(--text-secondary, var(--cg-sh-text-muted)); font-weight: normal; }
        .cg-sh-member-id { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 11px; color: var(--text-secondary, var(--cg-sh-text-muted)); word-break: break-all; user-select: text; -webkit-user-select: text; cursor: text; }
        .cg-sh-history-badge { font-size: 10.5px; color: var(--text-secondary, var(--cg-sh-text-muted)); flex-shrink: 0; padding: 1px 5px; border-radius: 4px; background: var(--cg-sh-tag-bg); font-variant-numeric: tabular-nums; }
        .cg-sh-history-list { display: flex; flex-direction: column; gap: 6px; }
        .cg-sh-history-item { background: var(--main-surface-primary, var(--cg-sh-bg-popover)); border: 1px solid var(--border-light, var(--cg-sh-border-secondary)); border-radius: 6px; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
        .cg-sh-item-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 11px; }
        .cg-sh-item-time { color: var(--text-secondary, var(--cg-sh-text-muted)); font-variant-numeric: tabular-nums; }
        .cg-sh-null-tag { font-size: 10px; padding: 1px 5px; border-radius: 3px; background: var(--cg-sh-tag-bg); color: var(--text-secondary, var(--cg-sh-text-muted)); }
        .cg-sh-null-desc { font-size: 11px; color: var(--text-secondary, var(--cg-sh-text-muted)); line-height: 1.4; }
        .cg-sh-fields-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 5px 12px; }
        .cg-sh-field { display: flex; flex-direction: column; gap: 1px; }
        .cg-sh-field-label { font-size: 10px; color: var(--text-secondary, var(--cg-sh-text-muted)); }
        .cg-sh-field-val { font-size: 12px; font-weight: 500; color: var(--text-primary, var(--cg-sh-text-primary)); font-variant-numeric: tabular-nums; word-break: break-all; user-select: text; -webkit-user-select: text; }
        .cg-sh-field-val.null-val { color: var(--text-secondary, var(--cg-sh-text-muted)); font-weight: normal; }
        .cg-sh-footer { padding: 8px 14px; font-size: 10.5px; color: var(--text-secondary, var(--cg-sh-text-muted)); border-top: 1px solid var(--border-light, var(--cg-sh-border-secondary)); background: var(--main-surface-primary, var(--cg-sh-bg-popover)); line-height: 1.4; flex-shrink: 0; }
        @media (prefers-reduced-motion: reduce) {
            .cg-sh-popover:not([hidden]) { animation: none !important; }
            .cg-sh-clear-btn, .cg-sh-close-btn { transition: none !important; }
        }`;
    panelShadow.appendChild(panelStyle);

    // Build popover DOM
    var popover = el('div', 'cg-sh-popover', null, panelShadow, {
        id: 'cg-sh-popover', role: 'dialog', 'aria-labelledby': 'cg-sh-title', 'aria-modal': 'false', hidden: true
    });
    if ('ariaControlsElements' in btn) {
        try {
            btn.ariaControlsElements = [popover];
        } catch (_) {}
    }

    var headerEl = el('div', 'cg-sh-header', null, popover);
    var headerMain = el('div', 'cg-sh-header-main', null, headerEl);
    var titleGroup = el('div', 'cg-sh-title-group', null, headerMain);
    var titleEl = el('span', 'cg-sh-title', '席位阈值历史', titleGroup, { id: 'cg-sh-title' });
    var countBadge = el('span', 'cg-sh-count-badge', '0 位成员', titleGroup);
    var actionsEl = el('div', 'cg-sh-actions', null, headerMain);
    var clearBtn = el('button', 'cg-sh-clear-btn', '清空当前记录', actionsEl, {
        type: 'button', title: '清空当前工作空间的历史记录', disabled: true
    });

    var closeBtn = el('button', 'cg-sh-close-btn', null, actionsEl, {
        type: 'button', 'aria-label': '关闭', title: '关闭'
    });
    closeBtn.innerHTML = ICONS.close;
    var wsBar = el('div', 'cg-sh-workspace-bar', null, headerEl);
    el('span', 'cg-sh-ws-label', '工作空间', wsBar);
    var wsIdEl = el('span', 'cg-sh-ws-id', '未识别', wsBar);
    var errorBar = el('div', 'cg-sh-error-bar', null, headerEl, {
        role: 'alert', 'aria-live': 'polite', hidden: true
    });
    var bodyEl = el('div', 'cg-sh-body', null, popover);
    el('div', 'cg-sh-footer', '仅记录页面操作返回的变化，历史保存在本浏览器。', popover);
    // Helpers
    function isMembersRoute() {
        try {
            return /^\/admin\/members(?:\/|$)/i.test(window.location.pathname || '');
        } catch (_) {
            return false;
        }
    }

    function isElementVisible(node) {
        if (!node || !node.isConnected) return false;
        if (typeof node.checkVisibility === 'function') {
            try {
                if (!node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
            } catch (_) {
                if (!node.checkVisibility()) return false;
            }
        }
        var r = node.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        try {
            var s = window.getComputedStyle(node);
            if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false;
        } catch (_) {}
        return r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
    }

    function abbreviateId(id) {
        if (!id || typeof id !== 'string') return '未识别';
        return id.length <= 16 ? id : id.slice(0, 8) + '…' + id.slice(-6);
    }
    function formatDateTime(val) {
        if (val === undefined || val === null || val === '') return '--';
        try {
            var d = new Date(val);
            if (!isNaN(d.getTime())) {
                var p = function (n) { return String(n).padStart(2, '0'); };
                return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
                       p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
            }
        } catch (_) {}
        return String(val);
    }

    function formatFieldValue(val, isDate) {
        if (val === undefined || val === '') return '--';
        if (val === null) return 'null';
        return isDate ? formatDateTime(val) : String(val);
    }
    // Theme Management
    var darkMedia = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    function getExplicitTheme(node) {
        if (!node) return null;
        var dt = node.getAttribute('data-theme');
        if (dt === 'dark' || dt === 'light') return dt;
        if (node.classList.contains('dark')) return 'dark';
        if (node.classList.contains('light')) return 'light';
        return null;
    }

    function updateTheme() {
        var theme = getExplicitTheme(document.documentElement) ||
                    getExplicitTheme(document.body) ||
                    (darkMedia && darkMedia.matches ? 'dark' : 'light');
        btnHost.setAttribute('data-theme', theme);
        panelHost.setAttribute('data-theme', theme);
    }
    updateTheme();
    if (darkMedia) darkMedia.addEventListener('change', updateTheme);

    var themeObserver = new MutationObserver(updateTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    if (document.body) {
        themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    }

    // Toolbar anchor search: locate visible native invite button in members view
    function locateAnchor() {
        if (!isMembersRoute()) return null;
        var buttons = document.querySelectorAll('button');
        var fallbackMatch = null;

        for (var i = 0; i < buttons.length; i++) {
            var b = buttons[i];
            if (b === btn) continue;
            if (btnHost.contains(b) || panelHost.contains(b)) continue;
            if (b.closest('nav, aside, table, article, dialog, [role="dialog"]')) continue;
            if (!isElementVisible(b)) continue;

            var text = (b.textContent || '').trim().replace(/\s+/g, ' ');
            var isInvite = (text.indexOf('邀请') >= 0 && text.indexOf('成员') >= 0) ||
                           (text.indexOf('邀請') >= 0 && text.indexOf('成員') >= 0) ||
                           /invite\s+members?/i.test(text);
            if (!isInvite) continue;

            var parent = b.parentElement;
            if (!parent || parent === document.body || parent === document.documentElement) continue;

            var pStyle = null;
            try { pStyle = window.getComputedStyle(parent); } catch (_) {}
            var isFlex = (pStyle && (pStyle.display === 'flex' || pStyle.display === 'inline-flex')) ||
                         (parent.className && parent.className.indexOf('flex') >= 0);
            if (!isFlex) continue;

            var hasSiblingAction = false;
            for (var s = 0; s < parent.children.length; s++) {
                var sib = parent.children[s];
                if (sib === b || sib === btnHost) continue;
                if (sib.tagName === 'BUTTON' || (sib.getAttribute && sib.getAttribute('role') === 'button')) {
                    if (isElementVisible(sib)) {
                        hasSiblingAction = true;
                        break;
                    }
                }
            }

            var match = { inviteButton: b, container: parent };
            if (hasSiblingAction) {
                return match;
            }
            if (!fallbackMatch) {
                fallbackMatch = match;
            }
        }
        return fallbackMatch;
    }

    // Toggle Popover
    function togglePopover(force, returnFocus) {
        if (destroyed) return;
        var next = typeof force === 'boolean' ? force : !isOpen;
        if (isOpen === next) return;
        isOpen = next;

        btn.setAttribute('aria-expanded', String(next));
        btn.setAttribute('data-open', String(next));
        iconSlot.innerHTML = next ? ICONS.close : ICONS.contacts;
        btn.setAttribute('aria-label', next ? '关闭席位阈值历史' : '席位阈值历史');
        btn.setAttribute('title', next ? '关闭席位阈值历史' : '席位阈值历史');

        if (next) {
            if (typeof options.getSnapshot === 'function') {
                try {
                    var fresh = options.getSnapshot();
                    if (fresh && typeof fresh === 'object') {
                        currentSnapshot = fresh;
                    }
                } catch (_) {}
            }
            popover.hidden = false;
            render();
            updatePosition();
            try { closeBtn.focus(); } catch (_) {}
        } else {
            popover.hidden = true;
            if (returnFocus && !btn.hidden && btn.isConnected) {
                try { btn.focus(); } catch (_) {}
            }
        }
    }

    // Event Handlers
    function onBtnClick(e) { e.stopPropagation(); togglePopover(); }
    function onCloseClick(e) { e.stopPropagation(); togglePopover(false, true); }
    function onPointerDown(e) {
        if (!isOpen) return;
        var path = e.composedPath ? e.composedPath() : [];
        if (!path.includes(btnHost) && !path.includes(panelHost)) togglePopover(false, false);
    }
    function onKeyDown(e) {
        if (e.key === 'Escape' && isOpen) {
            e.stopPropagation();
            togglePopover(false, true);
        }
    }

    function onClearClick(e) {
        e.stopPropagation();
        if (destroyed || isClearing) return;
        var targetAccountId = currentSnapshot.accountId;
        if (!targetAccountId) return;

        var confirmed = window.confirm('确定要清空当前工作空间的历史记录吗？\n其他工作空间的历史和邮箱映射将保留。');
        if (!confirmed || destroyed) return;

        // Verify fresh snapshot.accountId unchanged before clearing
        if (typeof options.getSnapshot === 'function') {
            try {
                var freshBefore = options.getSnapshot();
                if (freshBefore && typeof freshBefore === 'object') {
                    currentSnapshot = freshBefore;
                }
            } catch (_) {}
        }
        if (currentSnapshot.accountId !== targetAccountId) {
            render();
            return;
        }

        isClearing = true;
        clearError = null;
        clearBtn.disabled = true;
        clearBtn.textContent = '清空中…';

        Promise.resolve().then(function () {
            if (typeof options.onClearCurrent === 'function') {
                return options.onClearCurrent();
            }
            return false;
        }).then(function (res) {
            if (destroyed) return;
            if (res === false) {
                clearError = '清空失败，请稍后重试';
                return;
            }
            if (typeof options.getSnapshot === 'function') {
                try {
                    var fresh = options.getSnapshot();
                    if (fresh && typeof fresh === 'object') currentSnapshot = fresh;
                } catch (_) {}
            }
        }).catch(function (err) {
            if (destroyed) return;
            clearError = (err && err.message) ? err.message : '清空失败，请稍后重试';
        }).finally(function () {
            if (destroyed) return;
            isClearing = false;
            clearBtn.textContent = '清空当前记录';
            render();
        });
    }

    btn.addEventListener('click', onBtnClick);
    closeBtn.addEventListener('click', onCloseClick);
    clearBtn.addEventListener('click', onClearClick);
    document.addEventListener('pointerdown', onPointerDown, { passive: true });
    window.addEventListener('keydown', onKeyDown);

    // Positioning
    function updatePosition() {
        if (destroyed) return;
        var anchor = locateAnchor();
        if (!anchor) {
            btnHost.style.display = 'none';
            btn.hidden = true;
            if (isOpen) togglePopover(false, false);
            lastTop = -1;
            lastRight = -1;
            return;
        }

        var inviteButton = anchor.inviteButton;
        var container = anchor.container;
        if (inviteButton.previousElementSibling !== btnHost) {
            container.insertBefore(btnHost, inviteButton);
        }
        btnHost.style.display = '';
        btn.hidden = false;
        if (isOpen) {
            var btnRect = btn.getBoundingClientRect();
            if (!isElementVisible(btnHost) || btnRect.width <= 0 || btnRect.height <= 0 ||
                btnRect.bottom <= 0 || btnRect.top >= window.innerHeight ||
                btnRect.right <= 0 || btnRect.left >= window.innerWidth) {
                togglePopover(false, false);
                return;
            }

            var popWidth = Math.min(440, Math.max(0, window.innerWidth - 24));
            var right = window.innerWidth - btnRect.right;
            var maxRight = Math.max(12, window.innerWidth - popWidth - 12);
            var clampedRight = Math.min(Math.max(right, 12), maxRight);

            var spaceBelow = window.innerHeight - btnRect.bottom - 16;
            var spaceAbove = btnRect.top - 16;
            var flipAbove = spaceBelow < 180 && spaceAbove > spaceBelow;

            var top = -1;
            var bottom = -1;
            var maxPopHeight = 0;

            if (flipAbove) {
                bottom = window.innerHeight - btnRect.top + 8;
                maxPopHeight = Math.min(560, Math.max(80, spaceAbove - 8));
                popover.style.top = 'auto';
                popover.style.bottom = bottom + 'px';
            } else {
                top = btnRect.bottom + 8;
                maxPopHeight = Math.min(560, Math.max(80, spaceBelow - 8));
                popover.style.bottom = 'auto';
                popover.style.top = top + 'px';
            }

            popover.style.right = clampedRight + 'px';
            popover.style.maxHeight = maxPopHeight + 'px';
            lastTop = flipAbove ? -bottom : top;
            lastRight = clampedRight;
        }
    }

    function schedulePositionUpdate() {
        if (destroyed || rafId) return;
        rafId = requestAnimationFrame(function () {
            rafId = null;
            if (destroyed) return;
            updatePosition();
        });
    }
    window.addEventListener('resize', schedulePositionUpdate, { passive: true });
    window.addEventListener('scroll', schedulePositionUpdate, { capture: true, passive: true });
    window.addEventListener('popstate', schedulePositionUpdate, { passive: true });

    var domObserver = new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
            var m = mutations[i];
            if (m.target === btnHost || m.target === panelHost ||
                btnHost.contains(m.target) || panelHost.contains(m.target)) {
                continue;
            }
            schedulePositionUpdate();
            break;
        }
    });
    domObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });

    var pollIntervalId = setInterval(schedulePositionUpdate, 1200);
    // Rendering
    function renderField(label, value, isNull, parent, title) {
        var field = el('div', 'cg-sh-field', null, parent);
        var labelEl = el('span', 'cg-sh-field-label', label, field);
        if (title) {
            labelEl.title = title;
        }
        el('span', 'cg-sh-field-val' + (isNull ? ' null-val' : ''), value, field);
        return field;
    }

    function render() {
        if (destroyed) return;
        var accountId = currentSnapshot.accountId;
        var entries = Array.isArray(currentSnapshot.entries) ? currentSnapshot.entries : [];
        var storageError = currentSnapshot.storageError;

        countBadge.textContent = entries.length + ' 位成员';
        wsIdEl.textContent = abbreviateId(accountId);
        wsIdEl.title = accountId || '等待识别工作空间';
        clearBtn.disabled = isClearing || !accountId || entries.length === 0;

        var displayError = clearError || storageError;
        if (displayError) {
            errorBar.textContent = displayError;
            errorBar.hidden = false;
        } else {
            errorBar.textContent = '';
            errorBar.hidden = true;
        }

        var currentSignature = '';
        try {
            currentSignature = JSON.stringify({ a: accountId, e: entries });
        } catch (_) {
            currentSignature = String(accountId) + ':' + entries.length;
        }

        if (currentSignature !== lastBodySignature) {
            bodyDirty = true;
        }

        if (!isOpen) {
            return;
        }

        if (!bodyDirty && currentSignature === lastBodySignature) {
            return;
        }

        var prevScroll = (accountId && accountId === lastRenderedAccountId) ? bodyEl.scrollTop : 0;

        while (bodyEl.firstChild) {
            bodyEl.removeChild(bodyEl.firstChild);
        }

        if (!accountId) {
            var emptyWaited = el('div', 'cg-sh-empty', null, bodyEl);
            el('span', 'cg-sh-empty-title', '等待识别工作空间', emptyWaited);
            el('span', 'cg-sh-empty-sub', '仅记录页面操作返回的变化，历史保存在本浏览器。', emptyWaited);
            lastBodySignature = currentSignature;
            lastRenderedAccountId = accountId;
            bodyDirty = false;
            return;
        }

        if (entries.length === 0) {
            var emptyNone = el('div', 'cg-sh-empty', null, bodyEl);
            el('span', 'cg-sh-empty-title', '当前工作空间暂无记录', emptyNone);
            el('span', 'cg-sh-empty-sub', '仅记录页面操作返回的变化，历史保存在本浏览器。', emptyNone);
            lastBodySignature = currentSignature;
            lastRenderedAccountId = accountId;
            bodyDirty = false;
            return;
        }

        for (var eIndex = 0; eIndex < entries.length; eIndex++) {
            var entry = entries[eIndex];
            var card = el('div', 'cg-sh-member-card', null, bodyEl);
            var cardHeader = el('div', 'cg-sh-member-header', null, card);
            var meta = el('div', 'cg-sh-member-meta', null, cardHeader);

            el('div', entry.email ? 'cg-sh-member-email' : 'cg-sh-member-email pending',
               entry.email || '邮箱待匹配', meta);
            el('div', 'cg-sh-member-id', entry.userId || '--', meta);
            var historyItems = Array.isArray(entry.history) ? entry.history : [];
            el('span', 'cg-sh-history-badge', historyItems.length + ' 条记录', cardHeader);

            var listEl = el('div', 'cg-sh-history-list', null, card);
            // entry history is oldest -> newest, display newest first
            for (var hIndex = historyItems.length - 1; hIndex >= 0; hIndex--) {
                var item = historyItems[hIndex];
                var itemCard = el('div', 'cg-sh-history-item', null, listEl);
                var itemHdr = el('div', 'cg-sh-item-header', null, itemCard);

                el('span', 'cg-sh-item-time', '记录时间：' + formatDateTime(item.capturedAt), itemHdr);
                var isAllNoticeNull = (item.vacancyOrdinal == null) &&
                                      (item.freeVacancyThreshold == null) &&
                                      (item.billingStartsAt == null) &&
                                      (item.expiresAt == null);

                if (isAllNoticeNull) {
                    el('span', 'cg-sh-null-tag', '空策略字段 (null)', itemHdr);
                    el('div', 'cg-sh-null-desc', '接口返回空策略字段（null），无法据此判断计费情况。', itemCard);
                }
                var grid = el('div', 'cg-sh-fields-grid', null, itemCard);
                renderField('vacancy_ordinal', formatFieldValue(item.vacancyOrdinal, false), item.vacancyOrdinal === null, grid);
                renderField('free_vacancy_threshold', formatFieldValue(item.freeVacancyThreshold, false), item.freeVacancyThreshold === null, grid);
                renderField('开始时间', formatFieldValue(item.billingStartsAt, true), item.billingStartsAt === null, grid, 'billing_starts_at');
                renderField('结束时间', formatFieldValue(item.expiresAt, true), item.expiresAt === null, grid, 'expires_at');
            }
        }

        lastBodySignature = currentSignature;
        lastRenderedAccountId = accountId;
        bodyDirty = false;

        if (prevScroll > 0) {
            bodyEl.scrollTop = prevScroll;
        }
    }

    render();
    schedulePositionUpdate();

    return {
        update: function (nextSnapshot) {
            if (destroyed || !nextSnapshot || typeof nextSnapshot !== 'object') return;
            var accountChanged = nextSnapshot.accountId !== currentSnapshot.accountId;
            currentSnapshot = nextSnapshot;
            clearError = null;

            if (accountChanged && isOpen) {
                togglePopover(false, false);
            }
            render();
            schedulePositionUpdate();
        },
        destroy: function () {
            if (destroyed) return;
            destroyed = true;
            if (pollIntervalId) clearInterval(pollIntervalId);
            if (rafId) cancelAnimationFrame(rafId);
            domObserver.disconnect();
            themeObserver.disconnect();
            if (darkMedia) darkMedia.removeEventListener('change', updateTheme);
            btn.removeEventListener('click', onBtnClick);
            closeBtn.removeEventListener('click', onCloseClick);
            clearBtn.removeEventListener('click', onClearClick);
            document.removeEventListener('pointerdown', onPointerDown);
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('resize', schedulePositionUpdate);
            window.removeEventListener('scroll', schedulePositionUpdate, { capture: true });
            window.removeEventListener('popstate', schedulePositionUpdate);
            btnHost.remove();
            panelHost.remove();
        }
    };
}

function startNoticeHiding() {
    const TARGET_HEADING = "工作区有成员达到使用上限";
    const TARGET_DESC = "开启自动充值，系统会自动补充额度，避免今后再次中断。";
    const TARGET_CTA = "开启自动充值";

    const HIDE_ATTR = "data-chatgpt-team-hide";
    const STYLE_ID = "__chatgpt_team_assistant_style__";

    // Inject minimal scoped stylesheet once
    if (!document.getElementById(STYLE_ID)) {
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = `[${HIDE_ATTR}="true"] { display: none !important; }`;
        (document.head || document.documentElement).appendChild(style);
    }

    // Strip all whitespace for robust text comparison
    function norm(str) {
        return (str || "").replace(/\s+/g, "").trim();
    }

    // Chat and user-content containers where notices never appear
    const EXCLUDE_CONTAINERS_SELECTOR = [
        "[data-message-author-role]",
        "[data-testid^='conversation-turn']",
        "article",
        ".markdown",
        ".prose",
        "pre",
        "code",
        "textarea",
        "input",
        "[contenteditable]",
        "script",
        "style",
        "template",
        "noscript"
    ].join(",");

    function isUnderExcluded(el) {
        return el.closest(EXCLUDE_CONTAINERS_SELECTOR) !== null;
    }

    // Broad containers that must never be hidden as a unit
    function isBroadContainer(el) {
        if (!el || el === document.body || el === document.documentElement) return true;
        if (el.id === "root" || el.id === "__next") return true;
        const tag = el.tagName.toLowerCase();
        if (tag === "body" || tag === "html" || tag === "main" || tag === "dialog" || tag === "nav" || tag === "form") {
            return true;
        }
        const role = el.getAttribute("role");
        if (role === "dialog" || role === "main" || role === "application") {
            return true;
        }
        const cls = typeof el.className === "string" ? el.className : "";
        if (cls.includes("@container/main") || cls.includes("scroll-root")) {
            return true;
        }
        return false;
    }

    const UNRELATED_CONTROLS_SELECTOR = [
        "table", "nav", "form", "article",
        "[data-message-author-role]", "[data-testid^='conversation-turn']",
        "input", "select", "textarea", "[contenteditable]",
        "[role='switch']", "[role='checkbox']", "[role='combobox']"
    ].join(",");

    // Check if an ancestor contains only the notice texts (heading, desc, optional CTA)
    function isElementPureNotice(el) {
        if (!el || !el.isConnected || isBroadContainer(el)) return false;
        if (isUnderExcluded(el)) return false;

        // Reject containers holding interactive form elements, tables, navigation, or chat turns
        if (el.querySelector(UNRELATED_CONTROLS_SELECTOR)) {
            return false;
        }

        // Any action element inside must strictly match the expected CTA text
        const actionElements = el.querySelectorAll("button, a, [role='button']");
        for (const action of actionElements) {
            if (norm(action.textContent) !== TARGET_CTA) {
                return false;
            }
        }

        const text = norm(el.textContent);
        if (!text || text.length > 500) return false;
        if (!text.includes(TARGET_HEADING) || !text.includes(TARGET_DESC)) return false;

        // Strip heading, description, and optional CTA
        let remaining = text.replace(TARGET_HEADING, "").replace(TARGET_DESC, "");
        if (remaining.includes(TARGET_CTA)) {
            remaining = remaining.replace(TARGET_CTA, "");
        }

        return remaining.length === 0;
    }

    // Find the outermost pure container for a matched heading
    function findOutermostNoticeContainer(headingEl) {
        let curr = headingEl.parentElement;
        let best = null;
        let depth = 0;

        while (curr && depth < 6) {
            if (isBroadContainer(curr)) break;

            if (isElementPureNotice(curr)) {
                best = curr;
            } else if (best) {
                // Once we reached a pure boundary and the next parent is no longer pure,
                // we have found the outermost notice container.
                break;
            }

            curr = curr.parentElement;
            depth++;
        }

        return best;
    }

    // Track active hidden elements to safely verify React re-use / unhiding
    const hiddenElements = new Set();

    function markHidden(el) {
        if (!el) return;
        if (el.getAttribute(HIDE_ATTR) !== "true") {
            el.setAttribute(HIDE_ATTR, "true");
        }
        hiddenElements.add(el);
    }

    function unmarkHidden(el) {
        if (!el) return;
        el.removeAttribute(HIDE_ATTR);
        hiddenElements.delete(el);
    }

    function verifyHiddenElements() {
        for (const el of hiddenElements) {
            if (!el.isConnected) {
                hiddenElements.delete(el);
                continue;
            }
            if (!isElementPureNotice(el)) {
                unmarkHidden(el);
            }
        }
    }

    function scan() {
        // Re-validate previously hidden elements in case React reused their nodes
        verifyHiddenElements();

        // Search for potential heading elements
        const candidates = document.querySelectorAll("p, h1, h2, h3, h4, h5, h6, [role='heading'], div.font-semibold");
        for (const el of candidates) {
            if (isUnderExcluded(el)) continue;

            const text = norm(el.textContent);
            if (text !== TARGET_HEADING) continue;

            const container = findOutermostNoticeContainer(el);
            if (container) {
                markHidden(container);
            }
        }
    }

    // Debounced observer for SPA navigation and DOM changes
    let debounceTimer = null;
    function scheduleScan() {
        if (debounceTimer) return;
        debounceTimer = setTimeout(() => {
            debounceTimer = null;
            scan();
        }, 100);
    }

    // Run initial scan
    scan();

    // Observe subtree additions/removals and characterData updates without self-triggering attribute loops
    const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            const targetEl = m.target.nodeType === Node.ELEMENT_NODE ? m.target : m.target.parentElement;
            if (targetEl && targetEl.closest(EXCLUDE_CONTAINERS_SELECTOR)) {
                continue;
            }
            scheduleScan();
            break;
        }
    });

    observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true
    });
}

/* Headless, read-only usage controller. This fragment deliberately has no exports. */
function createTeamUsageController(onChange) {
  'use strict';

  var DAY_MS = 86400000;
  var WEEK_SECONDS = 7 * 24 * 60 * 60;
  var MAX_RANGE_DAYS = 366;
  var MAX_CYCLE_SECONDS = MAX_RANGE_DAYS * 24 * 60 * 60;
  var TOKEN_MAX_AGE_MS = 9 * 60 * 1000;
  var REQUEST_TIMEOUT_MS = 18000;
  var state = emptySnapshot();
  var lastReady = null;
  var restoreAfterCancel = null;
  var inFlight = null;
  var token = null;
  var tokenExpiresAt = 0;
  var generation = 0;
  var destroyed = false;
  var lastAccount = readAccountId();
  var syncingAccount = false;
  var accountWatch = null;

  /* User-supplied reference rates in USD per 1M tokens, not verified billing data. */
  var REFERENCE_RATES = {
    'gpt-5.6-sol': [5, 0.5, 30, 2.5],
    'gpt-5.6-terra': [2, 0.2, 12, 2.5],
    'gpt-5.6-luna': [0.2, 0.02, 1.2, 2.5],
    'gpt-5.5': [5, 0.5, 30, 2.5],
    'gpt-5.4': [2.5, 0.25, 15, 2],
    'gpt-5.4-mini': [0.75, 0.075, 4.5, 2]
  };
  var TOKEN_KEYS = [
    'text_total_tokens', 'total_text_tokens', 'uncached_text_input_tokens',
    'cached_text_input_tokens', 'text_output_tokens', 'output_tokens',
    'uncached_image_input_tokens', 'cached_image_input_tokens', 'image_input_tokens',
    'image_output_tokens', 'output_image_tokens'
  ];

  function emptySnapshot() {
    return {
      status: 'idle', error: null, accountId: null, accountMode: null,
      viewMode: 'personal', range: { startDate: '', endDate: '' },
      quota: emptyQuota(), summary: emptySummary(), models: [], daily: [],
      clients: [], modelActivity: [], notices: [], updatedAt: null
    };
  }

  function emptyQuota() {
    return {
      available: false, usedRatio: null, remaining: null, limit: null,
      resetAt: null, durationSeconds: null, cycleStartDate: null,
      cycleEndDate: null, estimatedFullCycleUsd: null,
      estimatedRemainingUsd: null
    };
  }

  function emptySummary() {
    return {
      tokens: null, uncachedInputTokens: null, cachedInputTokens: null,
      outputTokens: null, turns: null, threads: null, credits: null,
      estimatedUsd: null, activeMembersPeak: null
    };
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function emit() {
    if (destroyed || typeof onChange !== 'function') return;
    try { onChange(clone(state)); } catch (_) { /* A UI callback must not affect collection. */ }
  }

  function setState(next) {
    if (destroyed) return;
    state = next;
    emit();
  }

  function addNotice(list, text) {
    if (list.indexOf(text) === -1) list.push(text);
  }

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function finiteNumber(value) {
    if (typeof value === 'number') return isFinite(value) && value >= 0 ? value : null;
    if (typeof value !== 'string' || !value.trim()) return null;
    var parsed = Number(value);
    return isFinite(parsed) && parsed >= 0 ? parsed : null;
  }

  function finiteOrNull(value) {
    return typeof value === 'number' && isFinite(value) ? value : null;
  }

  function numericInfo(object, keys) {
    var present = false;
    if (!isObject(object)) return { present: false, value: null };
    for (var i = 0; i < keys.length; i += 1) {
      if (!Object.prototype.hasOwnProperty.call(object, keys[i])) continue;
      present = true;
      var value = finiteNumber(object[keys[i]]);
      if (value !== null) return { present: true, value: value };
    }
    return { present: present, value: null };
  }

  function numberFrom(object, keys) {
    return numericInfo(object, keys).value;
  }

  function boundedNumberFrom(object, keys, maximum) {
    if (!isObject(object)) return null;
    for (var i = 0; i < keys.length; i += 1) {
      if (!Object.prototype.hasOwnProperty.call(object, keys[i])) continue;
      var value = finiteNumber(object[keys[i]]);
      if (value !== null && value <= maximum) return value;
    }
    return null;
  }

  function hasAny(object, keys) {
    if (!isObject(object)) return false;
    for (var i = 0; i < keys.length; i += 1) {
      if (Object.prototype.hasOwnProperty.call(object, keys[i])) return true;
    }
    return false;
  }

  function sumAll(values) {
    if (!values.length) return null;
    var total = 0;
    for (var i = 0; i < values.length; i += 1) {
      if (values[i] === null || typeof values[i] !== 'number' || !isFinite(values[i])) return null;
      total += values[i];
    }
    return finiteOrNull(total);
  }

  function maxKnown(values) {
    var result = null;
    for (var i = 0; i < values.length; i += 1) {
      if (typeof values[i] === 'number' && isFinite(values[i]) &&
          (result === null || values[i] > result)) result = values[i];
    }
    return result;
  }

  function readAccountId() {
    if (typeof document === 'undefined' || typeof document.cookie !== 'string') return null;
    var match = /(?:^|;\s*)_account=([^;]*)/.exec(document.cookie);
    if (!match || !match[1]) return null;
    try {
      var value = decodeURIComponent(match[1]).trim();
      if (value.length >= 2 && ((value[0] === '"' && value[value.length - 1] === '"') ||
          (value[0] === "'" && value[value.length - 1] === "'"))) value = value.slice(1, -1).trim();
      return value && value.length <= 160 && !/[\x00-\x1f\x7f@]/.test(value) ? value : null;
    } catch (_) {
      return null;
    }
  }

  function resetForAccount(current) {
    lastAccount = current;
    generation += 1;
    if (inFlight) inFlight.abort();
    inFlight = null;
    token = null;
    tokenExpiresAt = 0;
    lastReady = null;
    restoreAfterCancel = null;
    state = emptySnapshot();
    state.accountId = current;
  }

  function syncAccount() {
    if (destroyed || syncingAccount) return false;
    syncingAccount = true;
    try {
      var current = readAccountId();
      if (current === lastAccount) return false;
      resetForAccount(current);
      emit();
      return true;
    } finally {
      syncingAccount = false;
    }
  }

  function accountRefreshHandler() {
    if (destroyed) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    try { syncAccount(); } catch (_) { /* Lifecycle hooks are isolated. */ }
  }

  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('focus', accountRefreshHandler);
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', accountRefreshHandler);
    }
  }
  if (typeof setInterval === 'function') {
    accountWatch = setInterval(function () {
      if (destroyed || !(state.status === 'ready' || state.status === 'loading' || token)) return;
      try { syncAccount(); } catch (_) { /* Cookie-only watcher stays isolated. */ }
    }, 1000);
  }

  function staleError() {
    var error = new Error('工作区已切换');
    error.stale = true;
    return error;
  }

  function requestError(status, message, noActiveWorkspace) {
    var error = new Error(message || '请求失败');
    error.status = status;
    error.noActiveWorkspace = !!noActiveWorkspace;
    return error;
  }

  function abortError() {
    var error = requestError(0, '请求已取消');
    error.aborted = true;
    return error;
  }

  function isCurrent(captured, mine, signal) {
    if (destroyed || (signal && signal.aborted)) return false;
    if (syncAccount()) return false;
    return lastAccount === captured && (mine === undefined || mine === generation) && !(signal && signal.aborted);
  }

  function assertCurrent(captured, mine, signal) {
    if (signal && signal.aborted) throw abortError();
    if (!isCurrent(captured, mine, signal)) throw staleError();
  }

  function utcDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    var year = Number(value.slice(0, 4));
    var month = Number(value.slice(5, 7));
    var day = Number(value.slice(8, 10));
    var date = new Date(Date.UTC(year, month - 1, day));
    return isFinite(date.getTime()) && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day ? date : null;
  }

  function dateString(date) {
    return date && isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
  }

  function todayUtc() {
    var now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }

  function lastDays(days) {
    var end = todayUtc();
    return { startDate: dateString(new Date(end.getTime() - (days - 1) * DAY_MS)), endDate: dateString(end) };
  }

  function defaultRange() {
    return lastDays(7);
  }

  function parseRange(startDate, endDate) {
    var start = utcDate(startDate);
    var end = utcDate(endDate);
    if (!start || !end || end < start || ((end - start) / DAY_MS) + 1 > MAX_RANGE_DAYS) return null;
    return { startDate: startDate, endDate: endDate };
  }

  function explicitRange(options) {
    var hasStart = Object.prototype.hasOwnProperty.call(options, 'startDate');
    var hasEnd = Object.prototype.hasOwnProperty.call(options, 'endDate');
    if (!hasStart && !hasEnd) return { supplied: false, range: null };
    if (hasStart && hasEnd && options.startDate === undefined && options.endDate === undefined) {
      return { supplied: false, range: null };
    }
    if (!hasStart || !hasEnd) return { supplied: true, range: null };
    return { supplied: true, range: parseRange(options.startDate, options.endDate) };
  }

  function exclusiveEnd(range) {
    var end = utcDate(range.endDate);
    return end ? dateString(new Date(end.getTime() + DAY_MS)) : null;
  }

  function usageUrl(path, range, extra) {
    var query = new URLSearchParams();
    var end = exclusiveEnd(range);
    if (!end) return path;
    query.set('start_date', range.startDate);
    query.set('end_date', end);
    query.set('group_by', 'day');
    if (isObject(extra)) Object.keys(extra).forEach(function (key) { query.set(key, String(extra[key])); });
    return path + '?' + query.toString();
  }

  function dateFromUnknown(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) return null;
    var date = value.slice(0, 10);
    if (!utcDate(date)) return null;
    if (value.length === 10) return date;
    return isFinite(new Date(value).getTime()) ? date : null;
  }

  function isoTime(value) {
    var normalized;
    if (typeof value === 'number') {
      if (!isFinite(value) || value < 0) return null;
      normalized = value;
    } else if (typeof value === 'string') {
      var text = value.trim();
      if (!text) return null;
      if (/^\d+(?:\.\d+)?$/.test(text)) normalized = Number(text);
      else normalized = text;
    } else {
      return null;
    }
    if (typeof normalized === 'number') {
      if (!isFinite(normalized) || normalized < 0) return null;
      if (normalized < 100000000000) normalized *= 1000;
    }
    var date = new Date(normalized);
    return isFinite(date.getTime()) ? date.toISOString() : null;
  }

  function timeFrom(object, keys) {
    if (!isObject(object)) return null;
    for (var i = 0; i < keys.length; i += 1) {
      if (!Object.prototype.hasOwnProperty.call(object, keys[i])) continue;
      var time = isoTime(object[keys[i]]);
      if (time) return time;
    }
    return null;
  }

  function tokenExpiry(accessToken) {
    var expiry = Date.now() + TOKEN_MAX_AGE_MS;
    var parts = accessToken.split('.');
    if (parts.length !== 3) return expiry;
    try {
      var payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (payload && typeof payload.exp === 'number' && isFinite(payload.exp)) {
        expiry = Math.min(expiry, Math.max(Date.now(), payload.exp * 1000 - 10000));
      }
    } catch (_) { /* The session access token need not be a JWT. */ }
    return expiry;
  }

  function statusMessage(status) {
    if (status === 401) return '会话已失效（HTTP 401）';
    if (status === 403) return '没有查看此使用情况的权限（HTTP 403）';
    if (status === 400) return '请求范围不可用（HTTP 400）';
    if (status >= 500) return '服务暂时不可用（HTTP ' + status + '）';
    return '使用情况请求失败（HTTP ' + status + '）';
  }

  async function fetchJSON(url, signal, captured, mine, withAuthorization) {
    assertCurrent(captured, mine, signal);
    var controller = new AbortController();
    var abort = function () { controller.abort(); };
    if (signal.aborted) throw abortError();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      signal.removeEventListener('abort', abort);
      throw abortError();
    }
    var timedOut = false;
    var timeout = setTimeout(function () { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
    try {
      var headers = { Accept: 'application/json' };
      if (withAuthorization) headers.Authorization = 'Bearer ' + await getToken(signal, captured, mine, false);
      assertCurrent(captured, mine, signal);
      if (controller.signal.aborted) {
        if (timedOut) throw requestError(0, '请求超时，请重试');
        throw abortError();
      }
      var response = await fetch(url, {
        method: 'GET', headers: headers, credentials: 'include', cache: 'no-store', signal: controller.signal
      });
      var text = await response.text();
      var data = null;
      try { data = text ? JSON.parse(text) : null; } catch (_) { /* Error details are not exposed. */ }
      if (!response.ok) {
        var noActive = response.status === 400 && /no active workspace/i.test(text || '');
        throw requestError(response.status, statusMessage(response.status), noActive);
      }
      if (!isObject(data) && !Array.isArray(data)) throw requestError(response.status, '服务返回了无效数据');
      assertCurrent(captured, mine, signal);
      return data;
    } catch (error) {
      if (error && (error.stale || error.status || error.aborted)) throw error;
      if (signal.aborted) throw abortError();
      if (timedOut) throw requestError(0, '请求超时，请重试');
      if (controller.signal.aborted) throw abortError();
      throw requestError(0, '网络请求失败');
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
    }
  }

  async function getToken(signal, captured, mine, force) {
    assertCurrent(captured, mine, signal);
    if (!force && token && Date.now() < tokenExpiresAt) return token;
    var result;
    try {
      result = await fetchJSON('/api/auth/session', signal, captured, mine, false);
    } catch (error) {
      if (error) error.sessionRequest = true;
      throw error;
    }
    assertCurrent(captured, mine, signal);
    var accessToken = isObject(result) && typeof result.accessToken === 'string' ? result.accessToken :
      isObject(result) && isObject(result.data) && typeof result.data.accessToken === 'string' ? result.data.accessToken : null;
    if (!accessToken) {
      throw requestError(0, '无法建立会话');
    }
    token = accessToken;
    tokenExpiresAt = tokenExpiry(token);
    return token;
  }

  async function apiGet(url, signal, captured, mine) {
    try {
      return await fetchJSON(url, signal, captured, mine, true);
    } catch (error) {
      if (!error || error.status !== 401 || error.sessionRequest) throw error;
      token = null;
      tokenExpiresAt = 0;
      await getToken(signal, captured, mine, true);
      try {
        return await fetchJSON(url, signal, captured, mine, true);
      } catch (retryError) {
        if (retryError && retryError.status === 401) {
          token = null;
          tokenExpiresAt = 0;
        }
        throw retryError;
      }
    }
  }

  function quotaWindow(payload) {
    var roots = [];
    var keys = ['rate_limit', 'rateLimit', 'rate_limits', 'rateLimits', 'limits'];
    if (!isObject(payload)) return null;
    keys.forEach(function (key) { if (payload[key] !== undefined) roots.push(payload[key]); });
    var primary = [];
    var secondary = [];
    var windowKeys = ['limit_window_seconds', 'window_seconds', 'duration_seconds', 'reset_at', 'resetAt',
      'resets_at', 'end_at', 'window_end', 'limit', 'max', 'capacity', 'credit_limit', 'remaining',
      'remaining_amount', 'remaining_credits', 'used_ratio', 'usedRatio', 'fraction_used', 'used_percent',
      'usedPercent', 'used', 'usage', 'used_credits'];
    function looksLikeWindow(value) {
      return hasAny(value, windowKeys);
    }
    function add(value, isSecondary) {
      var target = isSecondary ? secondary : primary;
      if (Array.isArray(value)) {
        value.forEach(function (item) { if (isObject(item)) target.push({ raw: item, secondary: isSecondary }); });
      } else if (isObject(value) && looksLikeWindow(value)) {
        target.push({ raw: value, secondary: isSecondary });
      }
    }
    roots.forEach(function (root) {
      if (Array.isArray(root)) add(root, false);
      if (!isObject(root)) return;
      if (looksLikeWindow(root)) add(root, false);
      add(root.primary_window, false);
      add(root.primaryWindow, false);
      add(root.windows, false);
      add(root.secondary_window, true);
      add(root.secondaryWindow, true);
    });
    var candidates = primary.concat(secondary);
    if (!candidates.length) return null;
    var best = null;
    var distance = Infinity;
    candidates.forEach(function (candidate) {
      var duration = numberFrom(candidate.raw, ['limit_window_seconds', 'window_seconds', 'duration_seconds']);
      if (duration !== null && duration > 0 && Math.abs(duration - WEEK_SECONDS) < distance) {
        best = candidate;
        distance = Math.abs(duration - WEEK_SECONDS);
      }
    });
    if (best) return best;
    var primaryHasDuration = primary.some(function (candidate) {
      var duration = numberFrom(candidate.raw, ['limit_window_seconds', 'window_seconds', 'duration_seconds']);
      return duration !== null && duration > 0;
    });
    return !primaryHasDuration && secondary.length ? secondary[0] : primary[0] || secondary[0];
  }

  function normalizeQuota(payload, notices) {
    var picked = quotaWindow(payload);
    if (!picked) return emptyQuota();
    var raw = picked.raw;
    var quota = emptyQuota();
    quota.available = true;
    if (picked.secondary) addNotice(notices, '正在使用备用配额窗口。');
    quota.durationSeconds = numberFrom(raw, ['limit_window_seconds', 'window_seconds', 'duration_seconds']);
    if (quota.durationSeconds !== null && quota.durationSeconds > MAX_CYCLE_SECONDS) quota.durationSeconds = null;
    quota.resetAt = timeFrom(raw, ['reset_at', 'resetAt', 'resets_at', 'end_at', 'window_end']);
    quota.limit = numberFrom(raw, ['limit', 'max', 'capacity', 'credit_limit']);
    quota.remaining = numberFrom(raw, ['remaining', 'remaining_amount', 'remaining_credits']);
    var ratioKeys = ['used_ratio', 'usedRatio', 'fraction_used'];
    var percentKeys = ['used_percent', 'usedPercent'];
    var ratio = boundedNumberFrom(raw, ratioKeys, 1);
    var ratioSpecified = hasAny(raw, ratioKeys);
    var percentSpecified = hasAny(raw, percentKeys);
    if (ratio === null && !ratioSpecified) {
      var percent = boundedNumberFrom(raw, percentKeys, 100);
      ratio = percent === null ? null : percent / 100;
    }
    if (ratio === null && !ratioSpecified && !percentSpecified && quota.limit !== null && quota.limit > 0) {
      var used = numberFrom(raw, ['used', 'usage', 'used_credits']);
      if (used !== null && used <= quota.limit) ratio = used / quota.limit;
      else if (quota.remaining !== null && quota.remaining <= quota.limit) ratio = 1 - quota.remaining / quota.limit;
    }
    quota.usedRatio = ratio !== null && ratio >= 0 && ratio <= 1 ? ratio : null;
    if (quota.limit !== null && quota.remaining !== null && quota.remaining > quota.limit) quota.remaining = null;
    if (quota.remaining === null && quota.limit !== null && quota.usedRatio !== null) {
      quota.remaining = finiteOrNull(quota.limit * (1 - quota.usedRatio));
    }
    if (quota.resetAt && quota.durationSeconds !== null && quota.durationSeconds > 0 &&
        quota.durationSeconds <= MAX_CYCLE_SECONDS) {
      var resetMs = new Date(quota.resetAt).getTime();
      var start = dateString(new Date(resetMs - quota.durationSeconds * 1000));
      var end = dateString(new Date(resetMs));
      if (start && end) {
        quota.cycleStartDate = start;
        quota.cycleEndDate = end;
      }
    }
    if (!quota.cycleStartDate) addNotice(notices, '配额周期信息不完整，日期范围默认最近 7 天。');
    return quota;
  }

  function extractRows(payload) {
    if (Array.isArray(payload)) return payload;
    if (!isObject(payload)) return [];
    var keys = ['data', 'items', 'results', 'daily', 'daily_usage', 'dailyWorkspaceUsageCounts',
      'daily_workspace_usage_counts', 'workspace_usage_counts'];
    for (var i = 0; i < keys.length; i += 1) {
      var value = payload[keys[i]];
      if (Array.isArray(value)) return value;
      if (!isObject(value)) continue;
      for (var j = 0; j < keys.length; j += 1) if (Array.isArray(value[keys[j]])) return value[keys[j]];
    }
    return [];
  }

  function safeModelName(raw) {
    var value = raw && (raw.model || raw.model_id || raw.model_name || raw.name || raw.id);
    if (typeof value !== 'string') return 'unknown';
    value = value.trim();
    return value && value.length <= 100 && !/[\x00-\x1f\x7f]/.test(value) && !/@|:\/\//.test(value) ? value : 'unknown';
  }

  function safeSpeed(raw) {
    var value = raw && raw.speed;
    return typeof value === 'string' && /^[a-z0-9._-]{1,32}$/i.test(value) ? value.toLowerCase() : 'standard';
  }

  function hasTokenFields(raw) {
    return hasAny(raw, TOKEN_KEYS);
  }

  function rawMetrics(raw, isImageModel) {
    raw = isObject(raw) ? raw : {};
    var textTotalInfo = numericInfo(raw, ['text_total_tokens', 'total_text_tokens']);
    var textUncachedInfo = numericInfo(raw, ['uncached_text_input_tokens']);
    var textCachedInfo = numericInfo(raw, ['cached_text_input_tokens']);
    var textOutputInfo = numericInfo(raw, ['text_output_tokens']);
    var genericOutputInfo = numericInfo(raw, ['output_tokens']);
    var imageUncachedInfo = numericInfo(raw, ['uncached_image_input_tokens']);
    var imageCachedInfo = numericInfo(raw, ['cached_image_input_tokens']);
    var imageInputInfo = numericInfo(raw, ['image_input_tokens']);
    var imageOutputInfo = numericInfo(raw, ['image_output_tokens', 'output_image_tokens']);
    var imageInfos = [imageUncachedInfo, imageCachedInfo, imageInputInfo, imageOutputInfo];
    var imagePlaceholdersOnly = imageInfos.some(function (info) { return info.present; }) && imageInfos.every(function (info) {
      return !info.present || info.value === 0;
    });
    var hasImage = !!isImageModel || (!imagePlaceholdersOnly && imageInfos.some(function (info) { return info.present; }));
    var textOutput = textOutputInfo.present ? textOutputInfo.value : (hasImage ? null : genericOutputInfo.value);
    var completeText = textUncachedInfo.value !== null && textCachedInfo.value !== null && textOutput !== null;
    var textTotal = textTotalInfo.present ? textTotalInfo.value :
      (completeText ? finiteOrNull(textUncachedInfo.value + textCachedInfo.value + textOutput) : null);
    var imageInputTotal = null;
    if (imageUncachedInfo.present) {
      imageInputTotal = imageUncachedInfo.value !== null && imageCachedInfo.value !== null ?
        finiteOrNull(imageUncachedInfo.value + imageCachedInfo.value) : null;
    } else if (imageInputInfo.present && !imageCachedInfo.present) {
      imageInputTotal = imageInputInfo.value;
    }
    var invalid = false;
    [textTotalInfo, textUncachedInfo, textCachedInfo, textOutputInfo, genericOutputInfo,
      imageUncachedInfo, imageCachedInfo, imageInputInfo, imageOutputInfo].forEach(function (info) {
      if (info.present && info.value === null) invalid = true;
    });
    if (!hasImage && textTotalInfo.value !== null && completeText &&
        textTotalInfo.value !== textUncachedInfo.value + textCachedInfo.value + textOutput) invalid = true;
    var ambiguousImage = hasImage && (imageInputTotal === null || imageOutputInfo.value === null ||
      genericOutputInfo.present || (textOutput !== null && textOutput !== 0) ||
      (imageUncachedInfo.present && imageCachedInfo.value === null) ||
      (!imageUncachedInfo.present && imageCachedInfo.present));
    var total = null;
    if (!hasImage) total = textTotal;
    else if (textTotal !== null && imageInputTotal !== null && imageOutputInfo.value !== null) {
      total = finiteOrNull(textTotal + imageInputTotal + imageOutputInfo.value);
    } else if (textTotal === null && completeText && imageInputTotal !== null && imageOutputInfo.value !== null) {
      total = finiteOrNull(textUncachedInfo.value + textCachedInfo.value + textOutput + imageInputTotal + imageOutputInfo.value);
    } else if (textUncachedInfo.value === null && textCachedInfo.value === null && textOutput === null &&
        imageInputTotal !== null && imageOutputInfo.value !== null) {
      total = finiteOrNull(imageInputTotal + imageOutputInfo.value);
    }
    return {
      present: hasTokenFields(raw), invalid: invalid, hasImage: hasImage, incompleteImage: ambiguousImage,
      tokens: total,
      uncachedInputTokens: hasImage ? (textUncachedInfo.value !== null && imageUncachedInfo.value !== null ?
        finiteOrNull(textUncachedInfo.value + imageUncachedInfo.value) : null) : textUncachedInfo.value,
      cachedInputTokens: hasImage ? (textCachedInfo.value !== null && imageCachedInfo.value !== null ?
        finiteOrNull(textCachedInfo.value + imageCachedInfo.value) : null) : textCachedInfo.value,
      outputTokens: hasImage ? (textOutput !== null && imageOutputInfo.value !== null ?
        finiteOrNull(textOutput + imageOutputInfo.value) : null) : textOutput,
      textUncached: textUncachedInfo.value, textCached: textCachedInfo.value, textOutput: textOutput,
      imageUncached: imageUncachedInfo.value, imageCached: imageCachedInfo.value,
      imageOutput: imageOutputInfo.value
    };
  }

  function priceFor(name, speed) {
    var key = name.toLowerCase();
    if (key === 'codex-auto-review') key = 'gpt-5.6-luna';
    if (key === 'gpt-image-2' || key === 'image2') return { image: true, family: key, fallback: false, multiplier: 1 };
    if (Object.prototype.hasOwnProperty.call(REFERENCE_RATES, key)) {
      return { image: false, family: key, fallback: false, multiplier: speed === 'fast' ? REFERENCE_RATES[key][3] : 1 };
    }
    return { image: false, family: 'gpt-5.5', fallback: true, multiplier: speed === 'fast' ? REFERENCE_RATES['gpt-5.5'][3] : 1 };
  }

  function moneyFor(metrics, pricing) {
    if (metrics.invalid) return null;
    if (pricing.image) {
      if (metrics.incompleteImage || metrics.imageUncached === null || metrics.imageCached === null ||
          metrics.imageOutput === null || (metrics.textUncached === null) !== (metrics.textCached === null)) return null;
      return finiteOrNull(((metrics.textUncached === null ? 0 : metrics.textUncached * 5 + metrics.textCached * 1.25) +
        metrics.imageUncached * 8 + metrics.imageCached * 2 + metrics.imageOutput * 30) / 1000000);
    }
    if (metrics.hasImage || metrics.textUncached === null || metrics.textCached === null || metrics.textOutput === null) return null;
    var rate = REFERENCE_RATES[pricing.family];
    return finiteOrNull((metrics.textUncached * rate[0] + metrics.textCached * rate[1] + metrics.textOutput * rate[2]) *
      pricing.multiplier / 1000000);
  }

  function calculationFor(metrics, pricing, estimated) {
    if (estimated === null) return metrics.hasImage ? '图像或文本令牌明细不完整，未估算费用' : '文本令牌明细不完整，未估算费用';
    if (pricing.image) {
      var text = metrics.textUncached === null ? '' : '文本：输入=' + metrics.textUncached + '×$5/M，缓存=' +
        metrics.textCached + '×$1.25/M；';
      return text + '图像：输入=' + metrics.imageUncached + '×$8/M，缓存=' + metrics.imageCached + '×$2/M，输出=' +
        metrics.imageOutput + '×$30/M；按参考费率估算，非实际账单';
    }
    var rate = REFERENCE_RATES[pricing.family];
    return '文本：输入=' + metrics.textUncached + '×$' + rate[0] + '/M，缓存=' + metrics.textCached + '×$' +
      rate[1] + '/M，输出=' + metrics.textOutput + '×$' + rate[2] + '/M；' + pricing.family +
      (pricing.multiplier !== 1 ? '，快速×' + pricing.multiplier : '') +
      (pricing.fallback ? '（未知模型回退）' : '') + '；按参考费率估算，非实际账单';
  }

  function tokenModel(raw, notices) {
    var name = safeModelName(raw);
    var speed = safeSpeed(raw);
    var pricing = priceFor(name, speed);
    var metrics = rawMetrics(raw, pricing.image);
    if (name.toLowerCase() === 'codex-auto-review') addNotice(notices, 'codex-auto-review 按用户指定映射为 gpt-5.6-luna。');
    if (pricing.fallback) addNotice(notices, '未知文本模型按 gpt-5.5 参考费率显示，非实际账单。');
    var estimated = moneyFor(metrics, pricing);
    if (estimated !== null) addNotice(notices, '费用按参考费率估算，非实际账单。');
    return {
      name: name, speed: speed, tokens: metrics.tokens,
      uncachedInputTokens: metrics.uncachedInputTokens, cachedInputTokens: metrics.cachedInputTokens,
      outputTokens: metrics.outputTokens, estimatedUsd: estimated, estimatedAllocation: false,
      fallbackPricing: pricing.fallback, incompleteImage: metrics.incompleteImage,
      calculation: calculationFor(metrics, pricing, estimated)
    };
  }

  function activityRow(raw) {
    var turns = numberFrom(raw, ['turns', 'turn_count', 'conversation_turns']);
    var threads = numberFrom(raw, ['threads', 'thread_count']);
    var credits = numberFrom(raw, ['credits', 'credit_count']);
    var users = numberFrom(raw, ['users', 'active_users', 'active_members']);
    if (turns === null && threads === null && credits === null && users === null) return null;
    return { name: safeModelName(raw), speed: safeSpeed(raw), turns: turns, threads: threads, credits: credits, users: users };
  }

  function activityIsAllZero(activity) {
    return activity && activity.turns === 0 && activity.threads === 0 && activity.credits === 0 && activity.users === 0;
  }

  function hasUncoveredActivity(activities, tokenModels) {
    return activities.some(function (activity) {
      if (activityIsAllZero(activity)) return false;
      return !tokenModels.some(function (model) {
        return model.name === activity.name && model.speed === activity.speed;
      });
    });
  }

  function rawModelValues(row) {
    var total = isObject(row.totals) ? row.totals : isObject(row.total) ? row.total : null;
    var sources = [row, total];
    var keys = ['models', 'model_usage', 'usage_by_model', 'breakdown'];
    for (var s = 0; s < sources.length; s += 1) {
      if (!isObject(sources[s])) continue;
      for (var k = 0; k < keys.length; k += 1) {
        var value = sources[sources.length === 1 ? 0 : s][keys[k]];
        if (Array.isArray(value) && value.length) return value.filter(isObject);
        if (isObject(value)) {
          var list = [];
          Object.keys(value).forEach(function (name) {
            if (!isObject(value[name])) return;
            var copy = Object.assign({}, value[name]);
            if (!copy.name && !copy.model && !copy.model_id) copy.name = name;
            list.push(copy);
          });
          if (list.length) return list;
        }
      }
    }
    return (row.model || row.model_id || row.model_name) ? [row] : [];
  }

  function splitModelRows(row, notices) {
    var tokens = [];
    var activities = [];
    rawModelValues(row).forEach(function (raw) {
      if (hasTokenFields(raw)) tokens.push(tokenModel(raw, notices));
      var activity = activityRow(raw);
      if (activity) activities.push(activity);
    });
    return { tokens: tokens, activities: activities, coverageIncomplete: hasUncoveredActivity(activities, tokens) };
  }

  function totalSource(row) {
    return isObject(row.totals) ? row.totals : isObject(row.total) ? row.total : row;
  }

  function arrayFromDay(row, key) {
    var total = totalSource(row);
    if (Array.isArray(row[key]) && row[key].length) return row[key].filter(isObject);
    return isObject(total) && Array.isArray(total[key]) ? total[key].filter(isObject) : [];
  }

  function aggregateField(rows, field) {
    return sumAll(rows.map(function (row) { return row[field]; }));
  }

  function costForModels(models, unseen) {
    if (unseen || !models.length) return null;
    return sumAll(models.map(function (model) { return model.estimatedUsd; }));
  }

  function differsWhenKnown(left, right) {
    return left !== null && (right === null || left !== right);
  }

  function buildRecord(row, notices) {
    var date = dateFromUnknown(row.date || row.day || row.usage_date || row.timestamp);
    if (!date) return null;
    var totals = totalSource(row);
    var direct = rawMetrics(totals);
    var split = splitModelRows(row, notices);
    var aggregateTokens = aggregateField(split.tokens, 'tokens');
    var aggregateUncached = aggregateField(split.tokens, 'uncachedInputTokens');
    var aggregateCached = aggregateField(split.tokens, 'cachedInputTokens');
    var aggregateOutput = aggregateField(split.tokens, 'outputTokens');
    var unseen = false;
    if (direct.present) {
      unseen = !split.tokens.length || direct.invalid || direct.tokens === null ||
        aggregateTokens === null || aggregateTokens !== direct.tokens ||
        differsWhenKnown(direct.uncachedInputTokens, aggregateUncached) ||
        differsWhenKnown(direct.cachedInputTokens, aggregateCached) ||
        differsWhenKnown(direct.outputTokens, aggregateOutput);
    }
    var coverageIncomplete = split.coverageIncomplete || unseen;
    if (coverageIncomplete) addNotice(notices, '模型令牌覆盖不完整；费用和模型汇总保持不可用。');
    if (unseen) split.tokens.forEach(function (model) {
      model.estimatedUsd = null;
      model.calculation = '日汇总与模型令牌不一致，未汇总费用';
    });
    var day = {
      date: date,
      tokens: direct.present ? direct.tokens : aggregateTokens,
      uncachedInputTokens: direct.uncachedInputTokens !== null ? direct.uncachedInputTokens : aggregateUncached,
      cachedInputTokens: direct.cachedInputTokens !== null ? direct.cachedInputTokens : aggregateCached,
      outputTokens: direct.outputTokens !== null ? direct.outputTokens : aggregateOutput,
      turns: numberFrom(totals, ['turns', 'turn_count', 'conversation_turns']),
      threads: numberFrom(totals, ['threads', 'thread_count']),
      credits: numberFrom(totals, ['credits', 'credit_count']),
      estimatedUsd: costForModels(split.tokens, unseen || coverageIncomplete),
      models: split.tokens
    };
    if (day.turns === null) day.turns = aggregateField(split.activities, 'turns');
    if (day.threads === null) day.threads = aggregateField(split.activities, 'threads');
    if (day.credits === null) day.credits = aggregateField(split.activities, 'credits');
    return {
      day: day, tokenModels: split.tokens, activities: split.activities,
      clients: arrayFromDay(row, 'clients'), directPresent: direct.present,
      hasImage: direct.hasImage, users: numberFrom(totals, ['users', 'active_users', 'active_members']),
      unseen: unseen, directInvalid: direct.invalid, coverageIncomplete: coverageIncomplete
    };
  }

  function normalizeRecords(payload, range, notices) {
    var selected = Object.create(null);
    extractRows(payload).forEach(function (row) {
      if (!isObject(row)) return;
      var record = buildRecord(row, notices);
      if (!record || record.day.date < range.startDate || record.day.date > range.endDate) return;
      if (selected[record.day.date]) {
        addNotice(notices, '已忽略重复日期汇总，避免重复计数。');
        return;
      }
      selected[record.day.date] = record;
    });
    return Object.keys(selected).sort().map(function (date) { return selected[date]; });
  }

  function mergeActivityRows(primary, secondary) {
    var map = Object.create(null);
    function put(row) {
      var key = row.name + '\u0000' + row.speed;
      if (!map[key]) map[key] = { name: row.name, speed: row.speed, turns: null, threads: null, credits: null, users: null };
      var target = map[key];
      ['turns', 'threads', 'credits', 'users'].forEach(function (field) {
        if (target[field] === null && row[field] !== null) target[field] = row[field];
      });
    }
    primary.forEach(put);
    secondary.forEach(put);
    return Object.keys(map).sort().map(function (key) { return map[key]; });
  }

  function largestRemainder(total, weights) {
    if (total === null || Math.round(total) !== total) return null;
    var weightTotal = weights.reduce(function (sum, value) { return sum + value; }, 0);
    if (!(weightTotal > 0)) return null;
    var parts = weights.map(function (weight, index) {
      var exact = total * weight / weightTotal;
      return { index: index, value: Math.floor(exact), remainder: exact - Math.floor(exact) };
    });
    var remaining = total - parts.reduce(function (sum, part) { return sum + part.value; }, 0);
    parts.sort(function (a, b) { return b.remainder - a.remainder || a.index - b.index; });
    for (var i = 0; i < remaining; i += 1) parts[i].value += 1;
    parts.sort(function (a, b) { return a.index - b.index; });
    return parts.map(function (part) { return part.value; });
  }

  function allocatedModel(activity, uncached, cached, output, notices) {
    var name = activity.name;
    var speed = activity.speed || 'standard';
    var pricing = priceFor(name, speed);
    var metrics = {
      invalid: false, hasImage: false, incompleteImage: false, textUncached: uncached,
      textCached: cached, textOutput: output, imageUncached: null, imageCached: null, imageOutput: null
    };
    var estimate = moneyFor(metrics, pricing);
    if (pricing.fallback) addNotice(notices, '未知文本模型按 gpt-5.5 参考费率显示，非实际账单。');
    if (name.toLowerCase() === 'codex-auto-review') addNotice(notices, 'codex-auto-review 按用户指定映射为 gpt-5.6-luna。');
    return {
      name: name, speed: speed, tokens: uncached + cached + output,
      uncachedInputTokens: uncached, cachedInputTokens: cached, outputTokens: output,
      estimatedUsd: estimate, estimatedAllocation: true, fallbackPricing: pricing.fallback,
      incompleteImage: false,
      calculation: '按积分与参考混合费率分配总令牌；按参考费率估算，非实际账单'
    };
  }

  function allocatePersonalModels(day, activities, notices, hasImage, directInvalid) {
    if (directInvalid || hasImage || day.models.length || day.tokens === null || Math.round(day.tokens) !== day.tokens ||
        day.uncachedInputTokens === null || day.cachedInputTokens === null ||
        day.outputTokens === null) return false;
    var total = day.uncachedInputTokens + day.cachedInputTokens + day.outputTokens;
    if (!(total > 0) || !isFinite(total) || total !== day.tokens) return false;
    var candidates = activities.filter(function (activity) {
      return activity.credits !== null && activity.credits > 0 && !priceFor(activity.name, activity.speed).image;
    });
    if (!candidates.length || candidates.length !== activities.length) return false;
    var weights = candidates.map(function (activity) {
      var pricing = priceFor(activity.name, activity.speed);
      var rates = REFERENCE_RATES[pricing.family];
      var blended = (day.uncachedInputTokens * rates[0] + day.cachedInputTokens * rates[1] +
        day.outputTokens * rates[2]) / total * pricing.multiplier;
      return blended > 0 ? activity.credits / blended : 0;
    });
    var uncached = largestRemainder(day.uncachedInputTokens, weights);
    var cached = largestRemainder(day.cachedInputTokens, weights);
    var output = largestRemainder(day.outputTokens, weights);
    if (!uncached || !cached || !output) return false;
    day.models = candidates.map(function (activity, index) {
      return allocatedModel(activity, uncached[index], cached[index], output[index], notices);
    });
    day.estimatedUsd = costForModels(day.models, false);
    addNotice(notices, '缺少按模型令牌明细；按积分和参考费率分配，非实际账单。');
    return true;
  }

  function mergePersonalFallback(breakdown, counts, notices) {
    var byDate = Object.create(null);
    breakdown.forEach(function (record) { byDate[record.day.date] = { breakdown: record, counts: null }; });
    counts.forEach(function (record) {
      if (!byDate[record.day.date]) byDate[record.day.date] = { breakdown: null, counts: record };
      else byDate[record.day.date].counts = record;
    });
    return Object.keys(byDate).sort().map(function (date) {
      var pair = byDate[date];
      var count = pair.counts;
      var detail = pair.breakdown;
      var base = count || detail;
      var exactModels = detail && detail.tokenModels.length ? detail.tokenModels : (count ? count.tokenModels : []);
      var activities = mergeActivityRows(count ? count.activities : [], detail ? detail.activities : []);
      var countDay = count && count.day;
      var detailDay = detail && detail.day;
      function pick(field) {
        return countDay && countDay[field] !== null ? countDay[field] : detailDay ? detailDay[field] : null;
      }
      var dailyHasTotals = !!((count && count.directPresent) || (detail && detail.directPresent));
      var directInvalid = !!((count && count.directInvalid) || (detail && detail.directInvalid));
      var tokens = pick('tokens');
      var exactTotal = aggregateField(exactModels, 'tokens');
      var unseen = dailyHasTotals && (!exactModels.length || tokens === null || exactTotal === null || exactTotal !== tokens ||
        differsWhenKnown(pick('uncachedInputTokens'), aggregateField(exactModels, 'uncachedInputTokens')) ||
        differsWhenKnown(pick('cachedInputTokens'), aggregateField(exactModels, 'cachedInputTokens')) ||
        differsWhenKnown(pick('outputTokens'), aggregateField(exactModels, 'outputTokens')));
      var allocationEligible = !exactModels.length && dailyHasTotals && tokens !== null && !directInvalid;
      var day = {
        date: date, tokens: tokens, uncachedInputTokens: pick('uncachedInputTokens'),
        cachedInputTokens: pick('cachedInputTokens'), outputTokens: pick('outputTokens'),
        turns: pick('turns'), threads: pick('threads'), credits: pick('credits'),
        estimatedUsd: costForModels(exactModels, unseen), models: exactModels.slice()
      };
      if (unseen) day.models.forEach(function (model) {
        model.estimatedUsd = null;
        model.calculation = '日汇总与模型令牌不一致，未汇总费用';
      });
      if (day.turns === null) day.turns = aggregateField(activities, 'turns');
      if (day.threads === null) day.threads = aggregateField(activities, 'threads');
      if (day.credits === null) day.credits = aggregateField(activities, 'credits');
      var allocated = false;
      if (allocationEligible) {
        allocated = allocatePersonalModels(day, activities, notices, !!((count && count.hasImage) || (detail && detail.hasImage)), directInvalid);
        if (!allocated) {
          addNotice(notices, '缺少可安全分配的模型明细；费用保持不可用。');
        }
      }
      var coverageIncomplete = unseen || directInvalid || !!((count && count.coverageIncomplete) || (detail && detail.coverageIncomplete));
      if (allocated) coverageIncomplete = false;
      if (coverageIncomplete) day.estimatedUsd = null;
      return {
        day: day, tokenModels: day.models, activities: activities,
        clients: count && count.clients.length ? count.clients : detail ? detail.clients : [],
        directPresent: dailyHasTotals, hasImage: !!((count && count.hasImage) || (detail && detail.hasImage)),
        users: count && count.users !== null ? count.users : detail ? detail.users : null,
        unseen: unseen, directInvalid: directInvalid, coverageIncomplete: coverageIncomplete, base: base
      };
    });
  }

  function aggregateModels(records) {
    var groups = Object.create(null);
    var coverageIncomplete = records.some(function (record) { return record.coverageIncomplete; });
    records.forEach(function (record) {
      record.day.models.forEach(function (model) {
        var key = model.name + '\u0000' + model.speed;
        if (!groups[key]) groups[key] = [];
        groups[key].push(model);
      });
    });
    return Object.keys(groups).sort().map(function (key) {
      var rows = groups[key];
      var first = rows[0];
      return {
        name: first.name, speed: first.speed, tokens: coverageIncomplete ? null : aggregateField(rows, 'tokens'),
        uncachedInputTokens: coverageIncomplete ? null : aggregateField(rows, 'uncachedInputTokens'),
        cachedInputTokens: coverageIncomplete ? null : aggregateField(rows, 'cachedInputTokens'),
        outputTokens: coverageIncomplete ? null : aggregateField(rows, 'outputTokens'),
        estimatedUsd: coverageIncomplete ? null : sumAll(rows.map(function (row) { return row.estimatedUsd; })),
        estimatedAllocation: rows.some(function (row) { return row.estimatedAllocation; }),
        fallbackPricing: rows.some(function (row) { return row.fallbackPricing; }),
        incompleteImage: rows.some(function (row) { return row.incompleteImage; }),
        calculation: first.calculation
      };
    });
  }

  function aggregateActivity(records) {
    var groups = Object.create(null);
    records.forEach(function (record) {
      record.activities.forEach(function (activity) {
        if (!groups[activity.name]) groups[activity.name] = [];
        groups[activity.name].push(activity);
      });
    });
    return Object.keys(groups).sort().map(function (name) {
      var rows = groups[name];
      return {
        name: rows[0].name, turns: aggregateField(rows, 'turns'), threads: aggregateField(rows, 'threads'),
        credits: aggregateField(rows, 'credits'), activeMembersPeak: maxKnown(rows.map(function (row) { return row.users; }))
      };
    });
  }

  function safeClientName(raw) {
    var value = raw && (raw.client_id || raw.name || raw.id);
    if (typeof value !== 'string') return 'unknown';
    value = value.trim();
    if (!value || value.length > 80 || /[\x00-\x1f\x7f]/.test(value) ||
        !/^[a-z][a-z0-9 ._-]*$/i.test(value)) return 'unknown';
    return value;
  }

  function aggregateClients(records) {
    var groups = Object.create(null);
    records.forEach(function (record) {
      record.clients.forEach(function (raw) {
        var name = safeClientName(raw);
        if (!groups[name]) groups[name] = [];
        groups[name].push(raw);
      });
    });
    return Object.keys(groups).sort().map(function (name) {
      var rows = groups[name];
      return {
        name: name, tokens: sumAll(rows.map(function (row) { return rawMetrics(row).tokens; })),
        turns: sumAll(rows.map(function (row) { return numberFrom(row, ['turns', 'turn_count']); })),
        threads: sumAll(rows.map(function (row) { return numberFrom(row, ['threads', 'thread_count']); })),
        credits: sumAll(rows.map(function (row) { return numberFrom(row, ['credits', 'credit_count']); }))
      };
    });
  }

  function summarize(records) {
    var days = records.map(function (record) { return record.day; });
    return {
      tokens: aggregateField(days, 'tokens'), uncachedInputTokens: aggregateField(days, 'uncachedInputTokens'),
      cachedInputTokens: aggregateField(days, 'cachedInputTokens'), outputTokens: aggregateField(days, 'outputTokens'),
      turns: aggregateField(days, 'turns'), threads: aggregateField(days, 'threads'), credits: aggregateField(days, 'credits'),
      estimatedUsd: sumAll(days.map(function (day) { return day.estimatedUsd; })),
      activeMembersPeak: maxKnown(records.map(function (record) { return record.users; }).concat(records.reduce(function (all, record) {
        return all.concat(record.activities.map(function (activity) { return activity.users; }));
      }, [])))
    };
  }

  function validSnapshot(snapshot) {
    return snapshot && snapshot.status === 'ready' && snapshot.range &&
      typeof snapshot.range.startDate === 'string' && typeof snapshot.range.endDate === 'string';
  }

  function cycleRange(quota, notices) {
    if (!quota.cycleStartDate || !quota.resetAt || quota.durationSeconds === null || quota.durationSeconds <= 0) return null;
    var reset = new Date(quota.resetAt).getTime();
    if (!isFinite(reset)) return null;
    var end = new Date(Math.min(Date.now(), reset));
    var range = parseRange(quota.cycleStartDate, dateString(new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()))));
    if (!range) {
      addNotice(notices, '确认的配额周期不可安全查询，已改用最近 7 天。');
      return null;
    }
    return range;
  }

  function fillCycleEstimate(snapshot) {
    snapshot.quota.estimatedFullCycleUsd = null;
    snapshot.quota.estimatedRemainingUsd = null;
    addNotice(snapshot.notices, '日汇总无法精确对齐配额周期，未折算周期费用。');
  }

  function selectedRange(options, quota, notices) {
    var supplied = explicitRange(options);
    if (supplied.supplied) return supplied.range;
    if (!options.preset || options.preset === '7d') return defaultRange();
    if (options.preset === '30d') return lastDays(30);
    if (options.preset === 'cycle' || options.preset === 'current-cycle') {
      var cycle = cycleRange(quota, notices);
      if (cycle) return cycle;
      addNotice(notices, '未确认配额周期，已显示最近 7 天。');
      return defaultRange();
    }
    return null;
  }

  function loadingRange(options) {
    var supplied = explicitRange(options);
    if (supplied.supplied) return supplied.range || { startDate: '', endDate: '' };
    return options.preset === '30d' ? lastDays(30) : defaultRange();
  }

  async function load(options) {
    if (destroyed) return null;
    options = isObject(options) ? options : {};
    syncAccount();
    var captured = lastAccount;
    var view = options.viewMode === 'team' ? 'team' : options.viewMode === 'personal' ? 'personal' : state.viewMode;
    var supplied = explicitRange(options);
    var validPreset = !options.preset || options.preset === 'cycle' || options.preset === 'current-cycle' ||
      options.preset === '7d' || options.preset === '30d';
    if ((supplied.supplied && !supplied.range) || !validPreset) {
      generation += 1;
      if (inFlight) inFlight.abort();
      inFlight = null;
      restoreAfterCancel = null;
      setState(Object.assign(emptySnapshot(), {
        status: 'error', error: '日期必须成对为有效 YYYY-MM-DD，且最多 366 天。', accountId: captured, viewMode: view
      }));
      return clone(state);
    }
    if (view === 'team' && !captured) {
      generation += 1;
      if (inFlight) inFlight.abort();
      inFlight = null;
      restoreAfterCancel = null;
      setState(Object.assign(emptySnapshot(), {
        status: 'error', error: '未确认当前工作区，无法读取团队使用情况。', accountId: null, viewMode: 'team'
      }));
      return clone(state);
    }
    generation += 1;
    var mine = generation;
    if (inFlight) inFlight.abort();
    var controller = new AbortController();
    inFlight = controller;
    restoreAfterCancel = lastReady && lastReady.accountId === captured ? clone(lastReady) : null;
    setState(Object.assign(emptySnapshot(), {
      status: 'loading', accountId: captured, viewMode: view, range: loadingRange(options), notices: ['统计可能有延迟。']
    }));
    try {
      var notices = ['统计可能有延迟。'];
      var quota = emptyQuota();
      try {
        var quotaPayload = await apiGet('/backend-api/wham/usage', controller.signal, captured, mine);
        assertCurrent(captured, mine, controller.signal);
        quota = normalizeQuota(quotaPayload, notices);
      } catch (quotaError) {
        if (quotaError && (quotaError.stale || quotaError.aborted || quotaError.sessionRequest || quotaError.status === 401 ||
            controller.signal.aborted || mine !== generation)) throw quotaError;
        addNotice(notices, '配额信息不可用；仍显示可读取的用量。');
      }
      var range = selectedRange(options, quota, notices);
      if (!range) throw requestError(0, '日期范围不可用。');
      var endpoint = view === 'team' ?
        usageUrl('/backend-api/wham/analytics/daily-workspace-usage-counts', range) :
        usageUrl('/backend-api/wham/usage/daily-workspace-user-token-usage-breakdown', range);
      var payload = null;
      var fallback = false;
      try {
        payload = await apiGet(endpoint, controller.signal, captured, mine);
      } catch (error) {
        if (view !== 'personal' || !error.noActiveWorkspace) throw error;
        fallback = true;
      }
      assertCurrent(captured, mine, controller.signal);
      var records;
      var accountMode;
      if (fallback) {
        var personalPayload = await apiGet(usageUrl('/backend-api/wham/usage/daily-token-usage-breakdown', range),
          controller.signal, captured, mine);
        var countPayload = null;
        try {
          countPayload = await apiGet(usageUrl('/backend-api/wham/analytics/daily-workspace-usage-counts', range, { workspace_user: 'true' }),
            controller.signal, captured, mine);
        } catch (countError) {
          if (countError && (countError.stale || countError.aborted)) throw countError;
          addNotice(notices, '个人活动汇总不可用；缺失的回合、线程或积分保持不可用。');
        }
        assertCurrent(captured, mine, controller.signal);
        records = mergePersonalFallback(normalizeRecords(personalPayload, range, notices),
          countPayload ? normalizeRecords(countPayload, range, notices) : [], notices);
        accountMode = 'personal';
        addNotice(notices, '未检测到活动工作区；仅显示个人使用情况。');
      } else {
        records = normalizeRecords(payload, range, notices);
        accountMode = 'team';
      }
      var snapshot = {
        status: 'ready', error: null, accountId: captured, accountMode: accountMode, viewMode: view, range: range,
        quota: quota, summary: summarize(records), models: aggregateModels(records),
        daily: records.map(function (record) { return record.day; }), clients: aggregateClients(records),
        modelActivity: aggregateActivity(records), notices: notices, updatedAt: new Date().toISOString()
      };
      if (view === 'team' && !records.length) addNotice(snapshot.notices, '团队端点未返回可显示的汇总数据；未用个人数据替代。');
      var confirmedCycle = cycleRange(quota, snapshot.notices);
      var isCycle = confirmedCycle && confirmedCycle.startDate === range.startDate && confirmedCycle.endDate === range.endDate;
      if (view === 'personal' && isCycle) fillCycleEstimate(snapshot);
      else if (view === 'personal' && quota.cycleStartDate) {
        addNotice(snapshot.notices, '自定义日期未用于配额周期费用折算。');
      }
      assertCurrent(captured, mine, controller.signal);
      lastReady = clone(snapshot);
      restoreAfterCancel = null;
      setState(snapshot);
      return getSnapshot();
    } catch (error) {
      if (error && error.stale) return getSnapshot();
      if (mine !== generation || controller.signal.aborted || (error && error.aborted)) return getSnapshot();
      var personalUnavailable = view === 'team' && (error && error.noActiveWorkspace || lastReady && lastReady.accountMode === 'personal');
      setState(Object.assign(emptySnapshot(), {
        status: 'error', error: error && error.message ? error.message : '无法读取使用情况。', accountId: captured,
        accountMode: personalUnavailable ? 'personal' : null, viewMode: view, range: loadingRange(options),
        notices: personalUnavailable ? ['个人帐户没有可用的团队汇总；未用零值替代。', '统计可能有延迟。'] : ['统计可能有延迟。']
      }));
      return getSnapshot();
    } finally {
      if (inFlight === controller) inFlight = null;
    }
  }

  function setViewMode(mode) {
    if (mode !== 'personal' && mode !== 'team') return getSnapshot();
    syncAccount();
    var prior = lastReady && lastReady.accountId === lastAccount ? lastReady : null;
    return prior ? load({ viewMode: mode, startDate: prior.range.startDate, endDate: prior.range.endDate }) : load({ viewMode: mode });
  }

  function cancel() {
    if (destroyed) return;
    syncAccount();
    generation += 1;
    if (inFlight) inFlight.abort();
    inFlight = null;
    if (state.status !== 'loading') return;
    if (restoreAfterCancel && restoreAfterCancel.accountId === lastAccount) {
      setState(clone(restoreAfterCancel));
    } else {
      var idle = emptySnapshot();
      idle.accountId = lastAccount;
      idle.viewMode = state.viewMode;
      setState(idle);
    }
    restoreAfterCancel = null;
  }

  function getSnapshot() {
    syncAccount();
    return clone(state);
  }

  function exportData(snapshot) {
    return {
      status: snapshot.status, viewMode: snapshot.viewMode, range: snapshot.range, quota: snapshot.quota,
      summary: snapshot.summary, models: snapshot.models, daily: snapshot.daily, clients: snapshot.clients,
      modelActivity: snapshot.modelActivity, notices: snapshot.notices, updatedAt: snapshot.updatedAt
    };
  }

  function csvCell(value) {
    var text = value === null || value === undefined ? '' : String(value);
    text = text.replace(/[\r\n]+/g, ' ');
    if (/^[ \t]*[=+\-@]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }

  function buildExport(format) {
    if (destroyed) return null;
    syncAccount();
    if (!validSnapshot(state) || state.accountId !== lastAccount || (format !== 'csv' && format !== 'json')) return null;
    var data = exportData(state);
    var filename = 'team-usage-' + state.range.endDate;
    if (format === 'json') return { filename: filename + '.json', mime: 'application/json', text: JSON.stringify(data, null, 2) };
    var header = ['section', 'viewMode', 'startDate', 'endDate', 'date', 'name', 'speed', 'tokens', 'uncachedInputTokens',
      'cachedInputTokens', 'outputTokens', 'turns', 'threads', 'credits', 'estimatedUsd', 'activeMembersPeak',
      'estimatedAllocation', 'fallbackPricing', 'incompleteImage'];
    var lines = [header];
    function row(section, date, name, values) {
      var modelRow = section === 'daily-model' || section === 'model-total';
      lines.push([section, state.viewMode, state.range.startDate, state.range.endDate, date || '', name || '', modelRow ? values.speed : '',
        values.tokens, values.uncachedInputTokens, values.cachedInputTokens, values.outputTokens,
        values.turns, values.threads, values.credits, values.estimatedUsd, values.activeMembersPeak,
        modelRow ? values.estimatedAllocation : '', modelRow ? values.fallbackPricing : '', modelRow ? values.incompleteImage : '']);
    }
    state.daily.forEach(function (day) {
      row('daily', day.date, '', day);
      day.models.forEach(function (model) { row('daily-model', day.date, model.name, model); });
    });
    state.models.forEach(function (model) { row('model-total', '', model.name, model); });
    state.clients.forEach(function (client) { row('client', '', client.name, client); });
    state.modelActivity.forEach(function (activity) { row('model-activity', '', activity.name, activity); });
    return {
      filename: filename + '.csv', mime: 'text/csv;charset=utf-8',
      text: lines.map(function (line) { return line.map(csvCell).join(','); }).join('\r\n')
    };
  }

  function destroy() {
    if (destroyed) return;
    generation += 1;
    if (inFlight) inFlight.abort();
    inFlight = null;
    token = null;
    tokenExpiresAt = 0;
    lastReady = null;
    restoreAfterCancel = null;
    state = emptySnapshot();
    if (accountWatch !== null && typeof clearInterval === 'function') clearInterval(accountWatch);
    accountWatch = null;
    destroyed = true;
    onChange = null;
    if (typeof window !== 'undefined' && window.removeEventListener) {
      window.removeEventListener('focus', accountRefreshHandler);
      if (typeof document !== 'undefined' && document.removeEventListener) {
        document.removeEventListener('visibilitychange', accountRefreshHandler);
      }
    }
  }

  return {
    getSnapshot: getSnapshot, load: load, setViewMode: setViewMode,
    cancel: cancel, destroy: destroy, buildExport: buildExport
  };
}

function mountTeamUsagePanel(options) {
  'use strict';
  options = options || {};

  let destroyed = false;
  const activeTimers = new Set();
  const activeRafs = new Set();

  function safeSetTimeout(fn, delay) {
    if (destroyed) return null;
    const id = setTimeout(() => {
      activeTimers.delete(id);
      if (!destroyed) fn();
    }, delay);
    activeTimers.add(id);
    return id;
  }

  function safeRequestAnimationFrame(fn) {
    if (destroyed) return null;
    const id = requestAnimationFrame(() => {
      activeRafs.delete(id);
      if (!destroyed) fn();
    });
    activeRafs.add(id);
    return id;
  }

  function clearAllAsync() {
    activeTimers.forEach((id) => clearTimeout(id));
    activeTimers.clear();
    activeRafs.forEach((id) => cancelAnimationFrame(id));
    activeRafs.clear();
  }

  const activeObjectUrls = new Set();
  let modalGeneration = 0;

  let genericErrorMessage = null;
  function safeInvoke(fn, ...args) {
    if (destroyed || typeof fn !== 'function') return Promise.resolve(null);
    return Promise.resolve()
      .then(() => {
        if (destroyed) return null;
        return fn(...args);
      })
      .catch(() => {
        if (destroyed) return null;
        genericErrorMessage = '操作失败，请稍后重试';
        if (isModalOpen) renderModalContent();
        return null;
      });
  }

  function invokeLoad(params) {
    if (destroyed || !isModalOpen) return Promise.resolve(null);
    const gen = modalGeneration;
    genericErrorMessage = null;
    return Promise.resolve()
      .then(() => {
        if (destroyed || !isModalOpen || modalGeneration !== gen) return null;
        if (typeof options.onLoad !== 'function') return null;
        return options.onLoad(params);
      })
      .catch(() => {
        if (destroyed || !isModalOpen || modalGeneration !== gen) return null;
        genericErrorMessage = '操作失败，请稍后重试';
        renderModalContent();
        return null;
      });
  }

  function invokeSetView(mode) {
    if (destroyed || !isModalOpen) return Promise.resolve(null);
    const gen = modalGeneration;
    genericErrorMessage = null;
    return Promise.resolve()
      .then(() => {
        if (destroyed || !isModalOpen || modalGeneration !== gen) return null;
        if (typeof options.onSetView !== 'function') return null;
        return options.onSetView(mode);
      })
      .catch(() => {
        if (destroyed || !isModalOpen || modalGeneration !== gen) return null;
        genericErrorMessage = '操作失败，请稍后重试';
        renderModalContent();
        return null;
      });
  }

  // Default snapshot state
  let snapshot = (typeof options.getSnapshot === 'function' && options.getSnapshot()) || {
    status: 'idle',
    error: null,
    accountId: null,
    accountMode: null,
    viewMode: 'personal',
    range: { startDate: '', endDate: '' },
    quota: null,
    summary: {},
    models: [],
    daily: [],
    clients: [],
    modelActivity: [],
    notices: [],
    updatedAt: null
  };

  let currentActiveAccount = (snapshot && snapshot.accountId !== undefined) ? snapshot.accountId : null;
  let initialAccountObserved = (snapshot && snapshot.accountId !== null && snapshot.accountId !== undefined);
  let isModalOpen = false;
  let lastFocusedTrigger = null;
  const expandedDates = new Set();
  let lastRenderedSignature = null;
  let lastRenderedAccount = null;
  let lastRenderedRange = null;

  let localStartDate = '';
  let localEndDate = '';
  let dateInputDirty = false;

  // SVG Icons (Lucide style, currentColor, stroke-width=2)
  const SVG_BANKNOTE = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="20" height="12" x="2" y="6" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/></svg>';
  const SVG_CLOSE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>';
  const SVG_REFRESH = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5"/></svg>';
  const SVG_CHEVRON_RIGHT = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>';
  const SVG_CHEVRON_DOWN = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
  const SVG_DOWNLOAD = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>';

  // Formatters
  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function formatNum(val, fallback) {
    fallback = fallback !== undefined ? fallback : '—';
    if (val === null || val === undefined || val === '') return fallback;
    const n = Number(val);
    if (!Number.isFinite(n)) return fallback;
    return n.toLocaleString('en-US');
  }

  function formatUsd(val, fallback) {
    fallback = fallback !== undefined ? fallback : '—';
    if (val === null || val === undefined || val === '') return fallback;
    const n = Number(val);
    if (!Number.isFinite(n)) return fallback;
    return '$' + (n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(3) : n.toFixed(4));
  }

  function formatDateTime(val) {
    if (!val) return '—';
    try {
      const d = new Date(val);
      if (isNaN(d.getTime())) return String(val);
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    } catch (_) {
      return String(val);
    }
  }

  function formatDate(val) {
    if (!val) return '—';
    if (typeof val === 'string') {
      const m = val.trim().match(/^(\d{4}-\d{2}-\d{2})/);
      if (m) return m[1];
    }
    try {
      const d = new Date(val);
      if (isNaN(d.getTime())) return String(val);
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    } catch (_) {
      return String(val);
    }
  }

  function getUtcDateStr(daysAgo) {
    daysAgo = daysAgo || 0;
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - daysAgo);
    return d.toISOString().slice(0, 10);
  }

  // Safe DOM builder
  function el(tag, cls, text, parent, attrs) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null && text !== '') node.textContent = String(text);
    if (attrs) {
      for (const k in attrs) {
        if (attrs[k] !== undefined && attrs[k] !== null) node.setAttribute(k, String(attrs[k]));
      }
    }
    if (parent) parent.appendChild(node);
    return node;
  }

  // Clean stale modal hosts
  const oldHost = document.getElementById('cg-team-usage-host');
  if (oldHost && oldHost.parentNode) {
    oldHost.parentNode.removeChild(oldHost);
  }

  // Shadow DOM host for modal dialog
  const host = document.createElement('div');
  host.id = 'cg-team-usage-host';
  host.style.position = 'absolute';
  host.style.top = '0';
  host.style.left = '0';
  host.style.zIndex = '99999';
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });

  // Native ChatGPT neutral theme tokens and styles
  const styleEl = document.createElement('style');
  styleEl.textContent = `
    *, *::before, *::after { box-sizing: border-box; }
    :host {
      color-scheme: light;
      --main-surface-primary: #ffffff;
      --main-surface-secondary: #f7f7f8;
      --main-surface-tertiary: #ececf1;
      --text-primary: #0d0d0d;
      --text-secondary: #5d5d5d;
      --text-tertiary: #8e8e8e;
      --border-light: rgba(0, 0, 0, 0.1);
      --border-medium: rgba(0, 0, 0, 0.2);
      --hover-bg: rgba(0, 0, 0, 0.05);
      --badge-bg: rgba(0, 0, 0, 0.06);
      --accent-pill: #0d0d0d;
      --accent-pill-text: #ffffff;
      --error-bg: #fef2f2;
      --error-text: #b91c1c;
      --error-border: #fca5a5;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 13px;
      line-height: 1.5;
      color: var(--text-primary);
      -webkit-font-smoothing: antialiased;
    }
    :host(.dark) {
      color-scheme: dark;
      --main-surface-primary: #212121;
      --main-surface-secondary: #2f2f2f;
      --main-surface-tertiary: #424242;
      --text-primary: #ececec;
      --text-secondary: #b4b4b4;
      --text-tertiary: #8e8e8e;
      --border-light: rgba(255, 255, 255, 0.12);
      --border-medium: rgba(255, 255, 255, 0.25);
      --hover-bg: rgba(255, 255, 255, 0.08);
      --badge-bg: rgba(255, 255, 255, 0.1);
      --accent-pill: #ececec;
      --accent-pill-text: #171717;
      --error-bg: #451a1a;
      --error-text: #fca5a5;
      --error-border: #7f1d1d;
    }
    button:focus-visible, input:focus-visible, [tabindex]:focus-visible {
      outline: 2px solid var(--border-medium);
      outline-offset: 1px;
    }
    dialog.modal-backdrop {
      color-scheme: inherit;
      position: fixed; inset: 0;
      width: 100vw; height: 100vh;
      max-width: 100vw; max-height: 100vh;
      margin: 0; padding: 16px;
      border: none;
      background: rgba(0, 0, 0, 0.52);
      backdrop-filter: blur(2px);
      display: none; align-items: center; justify-content: center;
      box-sizing: border-box;
      color: inherit;
    }
    dialog.modal-backdrop[open] {
      display: flex;
      animation: fadeIn 0.15s ease-out;
    }
    dialog.modal-backdrop::backdrop {
      background: transparent;
    }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    @keyframes slideUp { from { opacity: 0; transform: translateY(8px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
    .modal-dialog {
      position: relative; width: 100%; max-width: 1100px;
      max-height: calc(100dvh - 36px);
      display: flex; flex-direction: column;
      background: var(--main-surface-primary);
      color: var(--text-primary);
      border: 1px solid var(--border-light);
      border-radius: 12px;
      box-shadow: 0 20px 25px -5px rgba(0,0,0,0.28), 0 8px 10px -6px rgba(0,0,0,0.28);
      animation: slideUp 0.18s cubic-bezier(0.16, 1, 0.3, 1);
      overflow: hidden;
    }
    .modal-header {
      padding: 16px 20px 12px;
      border-bottom: 1px solid var(--border-light);
      background: var(--main-surface-primary);
      flex-shrink: 0;
    }
    .title-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
    .title-wrap { display: flex; align-items: center; gap: 8px; }
    .title-wrap h2 { margin: 0; font-size: 16px; font-weight: 600; line-height: 1.3; }
    .subtitle-note { font-size: 12px; color: var(--text-secondary); line-height: 1.4; }
    .btn-close {
      display: inline-flex; align-items: center; justify-content: center;
      width: 36px; height: 36px; min-width: 36px; min-height: 36px;
      border-radius: 6px; border: none; background: transparent;
      color: var(--text-secondary); cursor: pointer;
      transition: background-color 0.12s, color 0.12s;
    }
    .btn-close:hover { background: var(--hover-bg); color: var(--text-primary); }
    .controls-row {
      display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
      gap: 12px; margin-top: 12px; padding-top: 12px;
      border-top: 1px dashed var(--border-light);
    }
    .controls-left, .controls-right { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .segmented-group {
      display: inline-flex; align-items: center; padding: 2px;
      background: var(--main-surface-secondary);
      border: 1px solid var(--border-light);
      border-radius: 8px;
    }
    .segmented-btn {
      padding: 6px 14px; font-size: 12px; font-weight: 500;
      border-radius: 6px; border: none; background: transparent;
      color: var(--text-secondary); cursor: pointer;
      transition: background-color 0.12s, color 0.12s;
      min-height: 36px;
    }
    .segmented-btn.active {
      background: var(--main-surface-primary);
      color: var(--text-primary);
      box-shadow: 0 1px 2px rgba(0,0,0,0.08);
      font-weight: 600;
    }
    .segmented-btn:disabled { opacity: 0.45; cursor: not-allowed; }
    .btn-preset {
      padding: 6px 12px; font-size: 12px; border-radius: 6px;
      border: 1px solid var(--border-light);
      background: var(--main-surface-secondary);
      color: var(--text-primary); cursor: pointer;
      transition: background-color 0.12s; min-height: 36px;
    }
    .btn-preset:hover:not(:disabled) { background: var(--hover-bg); }
    .btn-preset:disabled { opacity: 0.5; cursor: not-allowed; }
    .date-group { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-secondary); }
    .date-input {
      height: 36px; min-height: 36px; padding: 4px 10px; font-size: 12px; font-family: inherit;
      background: var(--main-surface-secondary); color: var(--text-primary);
      border: 1px solid var(--border-light); border-radius: 6px; outline: none;
    }
    .date-input:focus { border-color: var(--border-medium); }
    .btn-apply {
      padding: 6px 14px; height: 36px; min-height: 36px; font-size: 12px; font-weight: 500;
      background: var(--accent-pill); color: var(--accent-pill-text);
      border: none; border-radius: 6px; cursor: pointer; transition: opacity 0.12s;
    }
    .btn-apply:hover:not(:disabled) { opacity: 0.9; }
    .btn-apply:disabled { opacity: 0.5; cursor: not-allowed; }
    .loading-bar-wrap {
      height: 3px; width: 100%; background: var(--main-surface-secondary);
      overflow: hidden; position: relative; margin-bottom: 12px; border-radius: 2px;
    }
    .loading-bar-inner {
      position: absolute; height: 100%; background: var(--text-secondary);
      width: 35%; animation: loadingAnim 1.2s infinite ease-in-out;
    }
    @keyframes loadingAnim { 0% { left: -35%; } 100% { left: 100%; } }
    .modal-body {
      padding: 16px 20px; overflow-y: auto; flex: 1 1 auto; scrollbar-width: thin;
      min-height: 0;
    }
    .error-banner {
      padding: 10px 14px; margin-bottom: 14px;
      background: var(--error-bg); color: var(--error-text);
      border: 1px solid var(--error-border); border-radius: 8px;
      font-size: 13px; display: flex; align-items: center; justify-content: space-between;
    }
    .section-title {
      font-size: 13px; font-weight: 600; color: var(--text-secondary);
      margin: 16px 0 8px; display: flex; align-items: center; gap: 6px;
    }
    .kpi-grid {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
      gap: 10px; margin-bottom: 16px;
    }
    .kpi-card {
      background: var(--main-surface-secondary);
      border: 1px solid var(--border-light);
      border-radius: 8px; padding: 10px 12px;
      display: flex; flex-direction: column; justify-content: space-between;
    }
    .kpi-label { font-size: 12px; color: var(--text-secondary); margin-bottom: 4px; }
    .kpi-value {
      font-size: 18px; font-weight: 600; color: var(--text-primary);
      font-variant-numeric: tabular-nums; line-height: 1.2;
    }
    .kpi-sub { font-size: 11px; color: var(--text-tertiary); margin-top: 4px; line-height: 1.3; }
    .quota-bar {
      height: 6px; width: 100%; background: var(--main-surface-tertiary);
      border-radius: 3px; overflow: hidden; margin: 6px 0;
    }
    .quota-fill {
      height: 100%; background: var(--text-primary); border-radius: 3px;
      transition: width 0.25s ease;
    }
    .table-wrap {
      border: 1px solid var(--border-light); border-radius: 8px;
      overflow-x: auto; margin-bottom: 16px; background: var(--main-surface-primary);
    }
    .data-table { width: 100%; border-collapse: collapse; font-size: 12px; text-align: left; }
    .data-table th {
      background: var(--main-surface-secondary); color: var(--text-secondary);
      font-weight: 500; padding: 8px 10px; border-bottom: 1px solid var(--border-light);
      white-space: nowrap;
    }
    .data-table td {
      padding: 8px 10px; border-bottom: 1px solid var(--border-light);
      color: var(--text-primary); font-variant-numeric: tabular-nums;
    }
    .data-table tr:last-child td { border-bottom: none; }
    .data-table tr:hover td { background: var(--hover-bg); }
    .badge {
      display: inline-flex; align-items: center; padding: 2px 6px;
      font-size: 10px; font-weight: 500; border-radius: 4px;
      background: var(--badge-bg); color: var(--text-secondary); margin-left: 4px;
    }
    .daily-row-btn {
      display: flex; align-items: center; justify-content: space-between;
      width: 100%; min-height: 36px; padding: 8px 10px; background: transparent;
      border: none; border-bottom: 1px solid var(--border-light);
      color: var(--text-primary); font-size: 12px; cursor: pointer;
      text-align: left; font-family: inherit; transition: background-color 0.12s;
    }
    .daily-row-btn:hover { background: var(--hover-bg); }
    .daily-row-left { display: flex; align-items: center; gap: 8px; font-weight: 500; }
    .daily-row-right { display: flex; align-items: center; gap: 16px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
    .daily-subpanel {
      padding: 8px 12px 12px 32px; background: var(--main-surface-secondary);
      border-bottom: 1px solid var(--border-light);
    }
    .notices-box {
      padding: 10px 12px; background: var(--main-surface-secondary);
      border: 1px dashed var(--border-light); border-radius: 8px;
      margin-top: 12px; font-size: 11px; color: var(--text-secondary); line-height: 1.5;
    }
    .notices-box ul { margin: 4px 0 0 16px; padding: 0; }
    .modal-footer {
      padding: 12px 20px; border-top: 1px solid var(--border-light);
      display: flex; align-items: center; justify-content: space-between;
      flex-shrink: 0; background: var(--main-surface-primary);
      font-size: 12px; color: var(--text-tertiary);
    }
    .footer-actions { display: flex; align-items: center; gap: 8px; }
    .btn-action {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 6px 14px; min-height: 36px; font-size: 12px; font-weight: 500;
      border-radius: 6px; border: 1px solid var(--border-light);
      background: var(--main-surface-secondary); color: var(--text-primary);
      cursor: pointer; transition: background-color 0.12s; font-family: inherit;
    }
    .btn-action:hover:not(:disabled) { background: var(--hover-bg); }
    .btn-action:disabled { opacity: 0.5; cursor: not-allowed; }
    @media (pointer: coarse) {
      .btn-close { width: 44px; height: 44px; min-width: 44px; min-height: 44px; }
      .segmented-btn, .btn-preset, .btn-apply, .btn-action, .date-input, .daily-row-btn {
        min-height: 44px;
      }
    }
    @media (max-width: 640px) {
      .controls-row { flex-direction: column; align-items: stretch; gap: 10px; }
      .controls-left, .controls-right { width: 100%; justify-content: space-between; }
      .date-group { width: 100%; flex-direction: column; align-items: stretch; }
      .date-input { width: 100%; }
      .modal-dialog { max-height: 100dvh; border-radius: 0; }
      .modal-backdrop { padding: 0; }
      .modal-footer { flex-direction: column; align-items: stretch; gap: 10px; }
      .footer-actions { width: 100%; flex-wrap: wrap; justify-content: flex-end; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.001ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.001ms !important;
      }
    }
  `;
  shadow.appendChild(styleEl);

  // Cached matchMedia for dark color scheme
  const darkMedia = (typeof window !== 'undefined' && window.matchMedia)
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

  function explicitTheme(node) {
    if (!node) return null;
    const dt = (typeof node.getAttribute === 'function' ? node.getAttribute('data-theme') : null) || '';
    const dtLower = dt.trim().toLowerCase();
    if (dtLower === 'dark') return true;
    if (dtLower === 'light') return false;
    const cl = node.classList;
    if (cl) {
      if (cl.contains('dark')) return true;
      if (cl.contains('light')) return false;
    }
    return null;
  }

  function resolveIsDark() {
    const htmlTheme = explicitTheme(document.documentElement);
    if (htmlTheme !== null) return htmlTheme;
    const bodyTheme = explicitTheme(document.body);
    if (bodyTheme !== null) return bodyTheme;
    return Boolean(darkMedia && darkMedia.matches);
  }

  // Sync theme with native ChatGPT
  function syncTheme() {
    if (destroyed) return;
    const isDark = resolveIsDark();
    if (isDark) host.classList.add('dark');
    else host.classList.remove('dark');
  }

  const themeObserver = new MutationObserver(() => syncTheme());
  try {
    if (document.documentElement) {
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    }
    if (document.body) {
      themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    }
  } catch (_) {}

  function handleMediaChange() {
    syncTheme();
  }

  if (darkMedia) {
    if (typeof darkMedia.addEventListener === 'function') {
      darkMedia.addEventListener('change', handleMediaChange);
    } else if (typeof darkMedia.addListener === 'function') {
      darkMedia.addListener(handleMediaChange);
    }
  }

  syncTheme();

  // Native dialog container
  const backdropEl = el('dialog', 'modal-backdrop', null, shadow, {
    'aria-labelledby': 'cg-tu-title'
  });

  const dialogEl = el('div', 'modal-dialog', null, backdropEl, {
    role: 'region',
    'aria-labelledby': 'cg-tu-title'
  });

  // Modal Header
  const headerEl = el('div', 'modal-header', null, dialogEl);
  const titleRow = el('div', 'title-row', null, headerEl);
  const titleWrap = el('div', 'title-wrap', null, titleRow);

  const titleIconSpan = el('span', null, null, titleWrap);
  titleIconSpan.innerHTML = SVG_BANKNOTE;
  titleIconSpan.style.display = 'inline-flex';
  titleIconSpan.style.color = 'var(--text-primary)';

  el('h2', null, 'Team额度统计', titleWrap, { id: 'cg-tu-title' });

  const btnClose = el('button', 'btn-close', null, titleRow, {
    type: 'button',
    'aria-label': '关闭',
    title: '关闭 (Esc)'
  });
  btnClose.innerHTML = SVG_CLOSE;

  el('div', 'subtitle-note', '按参考费率估算，非实际账单 · 数据可能有延迟', headerEl);

  // Controls Row: ViewMode + Presets + Custom Range
  const controlsRow = el('div', 'controls-row', null, headerEl);
  const controlsLeft = el('div', 'controls-left', null, controlsRow);
  const controlsRight = el('div', 'controls-right', null, controlsRow);

  // Segmented control: Personal vs Team
  const segGroup = el('div', 'segmented-group', null, controlsLeft);
  const btnViewPersonal = el('button', 'segmented-btn active', '个人用量', segGroup, {
    type: 'button',
    'aria-pressed': 'true'
  });
  const btnViewTeam = el('button', 'segmented-btn', '团队用量', segGroup, {
    type: 'button',
    'aria-pressed': 'false'
  });

  // Presets
  const btnPresetCycle = el('button', 'btn-preset', '本周期', controlsLeft, { type: 'button' });
  const btnPreset7d = el('button', 'btn-preset', '近7天', controlsLeft, { type: 'button' });
  const btnPreset30d = el('button', 'btn-preset', '近30天', controlsLeft, { type: 'button' });

  // Custom date range
  const dateGroup = el('div', 'date-group', null, controlsRight);
  el('span', null, '开始', dateGroup);
  const inputStartDate = el('input', 'date-input', null, dateGroup, {
    type: 'date',
    'aria-label': '开始日期'
  });
  el('span', null, '结束', dateGroup);
  const inputEndDate = el('input', 'date-input', null, dateGroup, {
    type: 'date',
    'aria-label': '结束日期'
  });
  const btnApplyDates = el('button', 'btn-apply', '查询', controlsRight, { type: 'button' });

  // Loading Progress Bar
  const loadingBarWrap = el('div', 'loading-bar-wrap', null, headerEl);
  el('div', 'loading-bar-inner', null, loadingBarWrap);
  loadingBarWrap.style.display = 'none';

  // Scrollable Body
  const modalBodyEl = el('div', 'modal-body', null, dialogEl);

  // Modal Footer
  const footerEl = el('div', 'modal-footer', null, dialogEl);
  const footerStatusText = el('span', null, '数据可能有延迟', footerEl);
  const footerActions = el('div', 'footer-actions', null, footerEl);

  const btnRefresh = el('button', 'btn-action', null, footerActions, { type: 'button' });
  btnRefresh.innerHTML = SVG_REFRESH + '<span>刷新</span>';

  const btnExportCsv = el('button', 'btn-action', null, footerActions, { type: 'button' });
  btnExportCsv.innerHTML = SVG_DOWNLOAD + '<span>导出 CSV</span>';

  const btnExportJson = el('button', 'btn-action', null, footerActions, { type: 'button' });
  btnExportJson.innerHTML = SVG_DOWNLOAD + '<span>导出 JSON</span>';

  const btnCloseBottom = el('button', 'btn-action', '关闭', footerActions, { type: 'button' });

  // Event Handlers for Header Controls
  btnViewPersonal.addEventListener('click', () => {
    if (snapshot.status === 'loading') return;
    if (snapshot.viewMode !== 'personal') {
      genericErrorMessage = null;
      invokeSetView('personal');
    }
  });

  btnViewTeam.addEventListener('click', () => {
    if (snapshot.status === 'loading') return;
    if (snapshot.viewMode !== 'team') {
      genericErrorMessage = null;
      invokeSetView('team');
    }
  });

  btnPresetCycle.addEventListener('click', () => {
    if (snapshot.status === 'loading') return;
    dateInputDirty = false;
    genericErrorMessage = null;
    invokeLoad({ preset: 'cycle', viewMode: snapshot.viewMode || 'personal' });
  });

  btnPreset7d.addEventListener('click', () => {
    if (snapshot.status === 'loading') return;
    dateInputDirty = false;
    genericErrorMessage = null;
    invokeLoad({ preset: '7d', viewMode: snapshot.viewMode || 'personal' });
  });

  btnPreset30d.addEventListener('click', () => {
    if (snapshot.status === 'loading') return;
    dateInputDirty = false;
    genericErrorMessage = null;
    invokeLoad({ preset: '30d', viewMode: snapshot.viewMode || 'personal' });
  });

  inputStartDate.addEventListener('input', () => {
    localStartDate = inputStartDate.value;
    dateInputDirty = true;
  });

  inputEndDate.addEventListener('input', () => {
    localEndDate = inputEndDate.value;
    dateInputDirty = true;
  });

  btnApplyDates.addEventListener('click', () => {
    if (snapshot.status === 'loading') return;
    if (!localStartDate || !localEndDate || localStartDate > localEndDate) {
      genericErrorMessage = '请选择有效的起止日期（开始日期不能晚于结束日期）';
      renderModalContent();
      return;
    }
    dateInputDirty = false;
    genericErrorMessage = null;
    invokeLoad({
      startDate: localStartDate,
      endDate: localEndDate,
      viewMode: snapshot.viewMode || 'personal'
    });
  });

  function handleRetryOrRefresh() {
    if (snapshot.status === 'loading') return;
    genericErrorMessage = null;
    const vm = snapshot.viewMode || 'personal';
    if (localStartDate && localEndDate && dateInputDirty) {
      invokeLoad({
        startDate: localStartDate,
        endDate: localEndDate,
        viewMode: vm
      });
    } else if (snapshot.range && snapshot.range.startDate && snapshot.range.endDate) {
      invokeLoad({
        startDate: snapshot.range.startDate,
        endDate: snapshot.range.endDate,
        viewMode: vm
      });
    } else {
      invokeLoad({
        preset: 'cycle',
        viewMode: vm
      });
    }
  }

  btnRefresh.addEventListener('click', handleRetryOrRefresh);

  function triggerDownload(format) {
    if (destroyed || typeof options.onExport !== 'function') return;
    if (snapshot.status === 'loading') return;
    Promise.resolve()
      .then(() => options.onExport(format))
      .then((res) => {
        if (destroyed || !res || !res.text) return;
        const blob = new Blob([res.text], { type: res.mime || 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        activeObjectUrls.add(url);
        const a = document.createElement('a');
        a.href = url;
        a.download = res.filename || ('team-usage.' + format);
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        safeSetTimeout(() => {
          try { URL.revokeObjectURL(url); } catch (_) {}
          activeObjectUrls.delete(url);
        }, 60000);
      })
      .catch(() => {
        if (destroyed) return;
        genericErrorMessage = '导出数据失败，请重试';
        if (isModalOpen) renderModalContent();
      });
  }

  btnExportCsv.addEventListener('click', () => triggerDownload('csv'));
  btnExportJson.addEventListener('click', () => triggerDownload('json'));

  btnClose.addEventListener('click', () => closeModal(true));
  btnCloseBottom.addEventListener('click', () => closeModal(true));

  // Close when clicking outside on backdrop or pressing escape/cancel
  backdropEl.addEventListener('pointerdown', (e) => {
    if (e.target === backdropEl) {
      closeModal(true);
    }
  });

  backdropEl.addEventListener('cancel', (e) => {
    e.preventDefault();
    closeModal(true);
  });

  backdropEl.addEventListener('close', () => {
    if (isModalOpen) {
      closeModal(false);
    }
  });

  dialogEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeModal(true);
    }
  });

  // Modal open & close
  function openModal() {
    if (destroyed || isModalOpen) return;

    // Refresh latest snapshot from getter before setting isModalOpen
    if (typeof options.getSnapshot === 'function') {
      try {
        const latest = options.getSnapshot();
        if (latest && typeof latest === 'object') {
          snapshot = latest;
          if (latest.accountId !== undefined) {
            currentActiveAccount = latest.accountId;
          }
        }
      } catch (_) {}
    }

    if (destroyed || isModalOpen) return;

    modalGeneration++;
    isModalOpen = true;
    syncTheme();

    try {
      if (typeof backdropEl.showModal === 'function') {
        if (!backdropEl.open) backdropEl.showModal();
      } else {
        backdropEl.setAttribute('open', '');
      }
    } catch (_) {
      backdropEl.setAttribute('open', '');
    }

    // Check if initial fetch needed
    if (!snapshot || snapshot.status === 'idle') {
      invokeLoad({ preset: 'cycle', viewMode: (snapshot && snapshot.viewMode) || 'personal' });
    }

    renderModalContent();

    safeRequestAnimationFrame(() => {
      try { btnClose.focus(); } catch (_) {}
    });
  }

  function closeModal(restoreFocus = false) {
    if (!isModalOpen) return;
    modalGeneration++;
    isModalOpen = false;

    try {
      if (typeof backdropEl.close === 'function') {
        if (backdropEl.open) backdropEl.close();
      } else {
        backdropEl.removeAttribute('open');
      }
    } catch (_) {
      backdropEl.removeAttribute('open');
    }

    if (snapshot && snapshot.status === 'loading') {
      safeInvoke(options.onCancel);
    }

    if (restoreFocus && lastFocusedTrigger) {
      const trigger = lastFocusedTrigger;
      lastFocusedTrigger = null;
      safeRequestAnimationFrame(() => {
        try {
          if (typeof trigger.focus === 'function' && document.contains(trigger)) {
            trigger.focus();
          }
        } catch (_) {}
      });
    } else {
      lastFocusedTrigger = null;
    }
  }

  // Render Body Content (preserves scroll position and date input focus)
  function renderModalContent() {
    const isLoading = snapshot.status === 'loading';
    loadingBarWrap.style.display = isLoading ? 'block' : 'none';

    // Update Header buttons state
    const isPersonalMode = (snapshot.viewMode || 'personal') === 'personal';
    btnViewPersonal.classList.toggle('active', isPersonalMode);
    btnViewPersonal.setAttribute('aria-pressed', isPersonalMode ? 'true' : 'false');
    btnViewTeam.classList.toggle('active', !isPersonalMode);
    btnViewTeam.setAttribute('aria-pressed', !isPersonalMode ? 'true' : 'false');

    // Disable controls while loading
    btnViewPersonal.disabled = isLoading;
    btnViewTeam.disabled = (snapshot.accountMode === 'personal') || isLoading;
    btnViewTeam.title = snapshot.accountMode === 'personal' ? '当前非团队工作空间' : '';

    btnPresetCycle.disabled = isLoading;
    btnPreset7d.disabled = isLoading;
    btnPreset30d.disabled = isLoading;
    inputStartDate.disabled = isLoading;
    inputEndDate.disabled = isLoading;
    btnApplyDates.disabled = isLoading;
    btnRefresh.disabled = isLoading;

    const hasData = (Array.isArray(snapshot.models) && snapshot.models.length > 0) ||
      (Array.isArray(snapshot.daily) && snapshot.daily.length > 0) ||
      (snapshot.summary && (snapshot.summary.tokens !== null && snapshot.summary.tokens !== undefined && Number.isFinite(Number(snapshot.summary.tokens))));
    const isExportReady = !isLoading && snapshot.status !== 'error' && snapshot.status !== 'idle' && hasData;

    btnExportCsv.disabled = !isExportReady;
    btnExportJson.disabled = !isExportReady;

    // Footer update time (always updates)
    if (snapshot.updatedAt) {
      footerStatusText.textContent = '数据更新于 ' + formatDateTime(snapshot.updatedAt) + ' · 数据可能有延迟';
    } else {
      footerStatusText.textContent = '按参考费率估算，非实际账单 · 数据可能有延迟';
    }

    // Preserve unsent date edits
    const activeEl = shadow.activeElement;
    if (!dateInputDirty && activeEl !== inputStartDate && activeEl !== inputEndDate) {
      if (snapshot.range && snapshot.range.startDate) {
        inputStartDate.value = localStartDate = formatDate(snapshot.range.startDate);
        inputEndDate.value = localEndDate = formatDate(snapshot.range.endDate || '');
      } else if (!localStartDate) {
        inputStartDate.value = localStartDate = getUtcDateStr(6);
        inputEndDate.value = localEndDate = getUtcDateStr(0);
      }
    }

    // Check body cache signature to avoid rebuilding DOM on status-only / unchanged updates
    const displayError = snapshot.error || genericErrorMessage;
    const currentSig = JSON.stringify({
      status: snapshot.status === 'error' ? 'error' : 'normal',
      error: displayError || null,
      accountId: snapshot.accountId || null,
      viewMode: snapshot.viewMode || 'personal',
      range: snapshot.range || null,
      quota: snapshot.quota || null,
      summary: snapshot.summary || null,
      models: snapshot.models || [],
      daily: snapshot.daily || [],
      clients: snapshot.clients || [],
      modelActivity: snapshot.modelActivity || [],
      notices: snapshot.notices || []
    });

    if (lastRenderedSignature === currentSig) {
      return;
    }

    // Preserve scroll position if same account and range
    const sameAccountAndRange = (lastRenderedAccount === snapshot.accountId) &&
      (JSON.stringify(lastRenderedRange) === JSON.stringify(snapshot.range));
    const scrollPos = sameAccountAndRange ? modalBodyEl.scrollTop : 0;

    // Prune expanded dates not in current daily list
    const currentDailyDates = new Set();
    if (Array.isArray(snapshot.daily)) {
      snapshot.daily.forEach((d) => {
        if (d && d.date) currentDailyDates.add(formatDate(d.date));
      });
    }
    expandedDates.forEach((d) => {
      if (!currentDailyDates.has(d)) expandedDates.delete(d);
    });

    modalBodyEl.textContent = '';

    // Error banner
    if (snapshot.status === 'error' || displayError) {
      const errBox = el('div', 'error-banner', null, modalBodyEl);
      el('span', null, '获取额度用量数据失败: ' + (displayError || '网络或接口异常'), errBox);
      const btnRetry = el('button', 'btn-preset', '重试', errBox, { type: 'button' });
      btnRetry.disabled = isLoading;
      btnRetry.addEventListener('click', handleRetryOrRefresh);
    }

    // Personal Quota Section (if available)
    const quota = snapshot.quota;
    if (quota && quota.available && isPersonalMode) {
      el('div', 'section-title', '个人配额使用状态', modalBodyEl);
      const quotaGrid = el('div', 'kpi-grid', null, modalBodyEl);

      // Used Ratio Card
      const cardUsed = el('div', 'kpi-card', null, quotaGrid);
      el('div', 'kpi-label', '已用额度比例', cardUsed);
      const hasRatio = quota.usedRatio !== null && quota.usedRatio !== undefined && Number.isFinite(Number(quota.usedRatio));
      const ratioText = hasRatio
        ? (Number(quota.usedRatio) * 100).toFixed(1) + '%'
        : '—';
      el('div', 'kpi-value', ratioText, cardUsed);

      if (hasRatio) {
        const qBar = el('div', 'quota-bar', null, cardUsed);
        const qFill = el('div', 'quota-fill', null, qBar);
        const ratioClamped = Math.max(0, Math.min(100, Number(quota.usedRatio) * 100));
        qFill.style.width = ratioClamped + '%';
      }

      const remText = '剩余 ' + formatNum(quota.remaining) + ' / 配额 ' + formatNum(quota.limit);
      el('div', 'kpi-sub', remText, cardUsed);

      // Reset Card
      const cardReset = el('div', 'kpi-card', null, quotaGrid);
      el('div', 'kpi-label', '配额重置时间', cardReset);
      el('div', 'kpi-value', formatDateTime(quota.resetAt), cardReset);
      const cycleSub = '周期: ' + formatDate(quota.cycleStartDate) + ' ~ ' + formatDate(quota.cycleEndDate);
      el('div', 'kpi-sub', cycleSub, cardReset);

      // Reference cost conversion (if provided)
      if (quota.estimatedFullCycleUsd !== null || quota.estimatedRemainingUsd !== null) {
        const cardRef = el('div', 'kpi-card', null, quotaGrid);
        el('div', 'kpi-label', '参考费用折算（非余额）', cardRef);
        el('div', 'kpi-value', '剩余估算 ' + formatUsd(quota.estimatedRemainingUsd), cardRef);
        el('div', 'kpi-sub', '全周期参考估算 ' + formatUsd(quota.estimatedFullCycleUsd), cardRef);
      }
    }

    // Summary KPIs Section
    const sum = snapshot.summary || {};
    el('div', 'section-title', isPersonalMode ? '用量总览 (个人)' : '用量总览 (团队)', modalBodyEl);

    const kpiGrid = el('div', 'kpi-grid', null, modalBodyEl);

    // Total Tokens Card
    const cardTokens = el('div', 'kpi-card', null, kpiGrid);
    el('div', 'kpi-label', 'Token 总计', cardTokens);
    el('div', 'kpi-value', formatNum(sum.tokens), cardTokens);
    const tokenSub = '未缓存 ' + formatNum(sum.uncachedInputTokens) + ' · 缓存 ' + formatNum(sum.cachedInputTokens) + ' · 输出 ' + formatNum(sum.outputTokens);
    el('div', 'kpi-sub', tokenSub, cardTokens);

    // Reference USD Card
    const cardCost = el('div', 'kpi-card', null, kpiGrid);
    el('div', 'kpi-label', '参考费用估算 (USD)', cardCost);
    el('div', 'kpi-value', formatUsd(sum.estimatedUsd), cardCost);
    el('div', 'kpi-sub', '按参考费率估算，非实际账单', cardCost);

    // Activity Card
    const cardAct = el('div', 'kpi-card', null, kpiGrid);
    el('div', 'kpi-label', '交互统计', cardAct);
    const actTurns = sum.turns !== null && sum.turns !== undefined && Number.isFinite(Number(sum.turns)) ? formatNum(sum.turns) + ' 轮对话' : '—';
    el('div', 'kpi-value', actTurns, cardAct);
    let actSub = '会话: ' + formatNum(sum.threads);
    if (sum.credits !== null && sum.credits !== undefined && Number.isFinite(Number(sum.credits))) actSub += ' · 积分: ' + formatNum(sum.credits);
    el('div', 'kpi-sub', actSub, cardAct);

    // Team peak active members (if team mode or present)
    if (!isPersonalMode && sum.activeMembersPeak !== null && sum.activeMembersPeak !== undefined && Number.isFinite(Number(sum.activeMembersPeak))) {
      const cardPeak = el('div', 'kpi-card', null, kpiGrid);
      el('div', 'kpi-label', '日活成员峰值', cardPeak);
      el('div', 'kpi-value', formatNum(sum.activeMembersPeak) + ' 人', cardPeak);
      el('div', 'kpi-sub', '单日活跃成员峰值', cardPeak);
    }

    // Models Breakdown Table
    const models = Array.isArray(snapshot.models) ? snapshot.models : [];
    el('div', 'section-title', '模型明细用量 (' + models.length + ')', modalBodyEl);

    if (models.length === 0) {
      const emptyBox = el('div', 'kpi-card', null, modalBodyEl);
      el('div', 'kpi-sub', '当前时间区间内暂无模型用量记录', emptyBox);
    } else {
      const tableWrap = el('div', 'table-wrap', null, modalBodyEl);
      const tbl = el('table', 'data-table', null, tableWrap);
      const thead = el('thead', null, null, tbl);
      const hRow = el('tr', null, null, thead);
      el('th', null, '模型名称', hRow);
      el('th', null, '总 Token', hRow);
      el('th', null, '未缓存输入', hRow);
      el('th', null, '缓存输入', hRow);
      el('th', null, '输出', hRow);
      el('th', null, '参考费用', hRow);
      el('th', null, '状态/说明', hRow);

      const tbody = el('tbody', null, null, tbl);
      for (let i = 0; i < models.length; i++) {
        const m = models[i];
        const row = el('tr', null, null, tbody);

        const tdName = el('td', null, null, row);
        el('strong', null, m.name || '未知模型', tdName);
        if (m.speed) el('span', 'badge', m.speed, tdName);

        el('td', null, formatNum(m.tokens), row);
        el('td', null, formatNum(m.uncachedInputTokens), row);
        el('td', null, formatNum(m.cachedInputTokens), row);
        el('td', null, formatNum(m.outputTokens), row);
        el('td', null, formatUsd(m.estimatedUsd), row);

        const tdStatus = el('td', null, null, row);
        if (m.estimatedAllocation) {
          el('span', 'badge', '估算分摊', tdStatus, { title: '按积分占比与参考费率分摊，非实测模型拆分' });
        }
        if (m.fallbackPricing) {
          el('span', 'badge', '参考兜底价', tdStatus, { title: '未匹配到确切定价，使用参考兜底价' });
        }
        if (m.incompleteImage) {
          el('span', 'badge', '图像字段不完整', tdStatus, { title: '部分图像用量字段不完整' });
        }
        if (m.calculation) {
          tdStatus.title = m.calculation;
          if (!m.estimatedAllocation && !m.fallbackPricing && !m.incompleteImage) {
            el('span', null, m.calculation, tdStatus);
          }
        }
      }
    }

    // Daily Breakdown List (Collapsible rows, reverse newest first)
    const daily = Array.isArray(snapshot.daily) ? snapshot.daily.slice() : [];
    daily.sort((a, b) => {
      const dateA = a && a.date ? String(a.date) : '';
      const dateB = b && b.date ? String(b.date) : '';
      return dateB.localeCompare(dateA);
    });

    if (daily.length > 0) {
      el('div', 'section-title', '每日用量明细 (' + daily.length + ' 天)', modalBodyEl);
      const dailyWrap = el('div', 'table-wrap', null, modalBodyEl);

      for (let d = 0; d < daily.length; d++) {
        const day = daily[d];
        const dateStr = formatDate(day.date) || '未知日期';
        const isExpanded = expandedDates.has(dateStr);

        const rowBtn = el('button', 'daily-row-btn', null, dailyWrap, {
          type: 'button',
          'aria-expanded': isExpanded ? 'true' : 'false'
        });

        const rLeft = el('div', 'daily-row-left', null, rowBtn);
        const iconSpan = el('span', null, null, rLeft);
        iconSpan.innerHTML = isExpanded ? SVG_CHEVRON_DOWN : SVG_CHEVRON_RIGHT;
        el('span', null, dateStr, rLeft);

        const rRight = el('div', 'daily-row-right', null, rowBtn);
        el('span', null, formatNum(day.tokens) + ' Tokens', rRight);
        el('span', null, formatNum(day.turns) + ' 轮', rRight);
        el('span', null, formatUsd(day.estimatedUsd), rRight);

        // Subpanel
        const subpanel = el('div', 'daily-subpanel', null, dailyWrap);
        subpanel.style.display = isExpanded ? 'block' : 'none';

        if (Array.isArray(day.models) && day.models.length > 0) {
          const subTable = el('table', 'data-table', null, subpanel);
          const stHead = el('thead', null, null, subTable);
          const stHRow = el('tr', null, null, stHead);
          el('th', null, '模型', stHRow);
          el('th', null, 'Tokens', stHRow);
          el('th', null, '输入(未缓存/缓存)', stHRow);
          el('th', null, '输出', stHRow);
          el('th', null, '参考费用', stHRow);

          const stBody = el('tbody', null, null, subTable);
          for (let mIdx = 0; mIdx < day.models.length; mIdx++) {
            const dm = day.models[mIdx];
            const dRow = el('tr', null, null, stBody);
            el('td', null, dm.name || '—', dRow);
            el('td', null, formatNum(dm.tokens), dRow);
            const inText = formatNum(dm.uncachedInputTokens) + ' / ' + formatNum(dm.cachedInputTokens);
            el('td', null, inText, dRow);
            el('td', null, formatNum(dm.outputTokens), dRow);
            el('td', null, formatUsd(dm.estimatedUsd), dRow);
          }
        } else {
          el('div', 'kpi-sub', '当天无模型拆分数据', subpanel);
        }

        // Accordion click toggle
        rowBtn.addEventListener('click', () => {
          if (expandedDates.has(dateStr)) {
            expandedDates.delete(dateStr);
            subpanel.style.display = 'none';
            iconSpan.innerHTML = SVG_CHEVRON_RIGHT;
            rowBtn.setAttribute('aria-expanded', 'false');
          } else {
            expandedDates.add(dateStr);
            subpanel.style.display = 'block';
            iconSpan.innerHTML = SVG_CHEVRON_DOWN;
            rowBtn.setAttribute('aria-expanded', 'true');
          }
        });
      }
    }

    // Clients & Model Activity (conditional when team mode)
    if (!isPersonalMode) {
      const clients = Array.isArray(snapshot.clients) ? snapshot.clients : [];
      if (clients.length > 0) {
        el('div', 'section-title', '活跃客户端 (' + clients.length + ')', modalBodyEl);
        const clWrap = el('div', 'table-wrap', null, modalBodyEl);
        const clTable = el('table', 'data-table', null, clWrap);
        const clHead = el('thead', null, null, clTable);
        const clHRow = el('tr', null, null, clHead);
        el('th', null, '客户端名称', clHRow);
        el('th', null, '总 Token', clHRow);
        el('th', null, '对话数 (Turns)', clHRow);
        el('th', null, '会话数 (Threads)', clHRow);

        const clBody = el('tbody', null, null, clTable);
        for (let c = 0; c < clients.length; c++) {
          const client = clients[c];
          const row = el('tr', null, null, clBody);
          el('td', null, client.name || '未知客户端', row);
          el('td', null, formatNum(client.tokens), row);
          el('td', null, formatNum(client.turns), row);
          el('td', null, formatNum(client.threads), row);
        }
      }

      const activity = Array.isArray(snapshot.modelActivity) ? snapshot.modelActivity : [];
      if (activity.length > 0) {
        el('div', 'section-title', '模型活动度统计 (' + activity.length + ')', modalBodyEl);
        const actWrap = el('div', 'table-wrap', null, modalBodyEl);
        const actTable = el('table', 'data-table', null, actWrap);
        const actHead = el('thead', null, null, actTable);
        const actHRow = el('tr', null, null, actHead);
        el('th', null, '模型', actHRow);
        el('th', null, '对话数', actHRow);
        el('th', null, '会话数', actHRow);
        el('th', null, '日活成员峰值', actHRow);

        const actBody = el('tbody', null, null, actTable);
        for (let a = 0; a < activity.length; a++) {
          const item = activity[a];
          const row = el('tr', null, null, actBody);
          el('td', null, item.name || '—', row);
          el('td', null, formatNum(item.turns), row);
          el('td', null, formatNum(item.threads), row);
          el('td', null, (item.activeMembersPeak !== null && item.activeMembersPeak !== undefined && Number.isFinite(Number(item.activeMembersPeak))) ? formatNum(item.activeMembersPeak) + ' 人' : '—', row);
        }
      }
    }

    // Notices box
    const notices = Array.isArray(snapshot.notices) ? snapshot.notices : [];
    if (notices.length > 0) {
      const nBox = el('div', 'notices-box', null, modalBodyEl);
      el('strong', null, '提示与说明:', nBox);
      const ul = el('ul', null, null, nBox);
      for (let n = 0; n < notices.length; n++) {
        el('li', null, notices[n], ul);
      }
    }

    // Restore scroll
    modalBodyEl.scrollTop = scrollPos;

    lastRenderedSignature = currentSig;
    lastRenderedAccount = snapshot.accountId || null;
    lastRenderedRange = snapshot.range ? { ...snapshot.range } : null;
  }

  // Account / Profile Menu Injection & Coordination
  let currentMenuItem = null;
  let currentPersItem = null;
  let currentSettItem = null;
  let persKeyHandler = null;
  let settKeyHandler = null;

  function isElementVisible(node) {
    if (!node || !node.isConnected) return false;
    if (typeof node.checkVisibility === 'function') {
      return node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    const rect = node.getBoundingClientRect();
    return (rect.width > 0 && rect.height > 0) || node.offsetParent !== null;
  }

  function isPersLabel(text) {
    const t = (text || '').trim().toLowerCase();
    return t === '个性化' || t === '個性化' || t === 'personalization' || t === 'personalisation';
  }

  function isSettLabel(text) {
    const t = (text || '').trim().toLowerCase();
    return t === '设置' || t === '設置' || t === 'settings';
  }

  function injectMenuItem(menu, persItem, settItem) {
    const parent = settItem.parentElement;
    if (!parent) return;

    cleanupMenuItem();

    const item = document.createElement('div');
    item.setAttribute('role', 'menuitem');
    item.setAttribute('data-cg-team-usage-item', 'true');
    item.setAttribute('aria-label', 'Team额度统计');
    item.tabIndex = -1;

    if (settItem.className) {
      item.className = settItem.className;
    } else {
      item.className = 'group __menu-item gap-1.5';
    }

    item.style.cursor = 'pointer';
    item.style.userSelect = 'none';

    const iconDiv = document.createElement('div');
    iconDiv.className = 'relative flex items-center justify-center [opacity:var(--menu-item-icon-opacity,1)] icon';
    iconDiv.style.width = '20px';
    iconDiv.style.height = '20px';
    iconDiv.style.flexShrink = '0';
    iconDiv.innerHTML = SVG_BANKNOTE;

    const textDiv = document.createElement('div');
    textDiv.className = 'grow truncate';
    textDiv.textContent = 'Team额度统计';

    item.appendChild(iconDiv);
    item.appendChild(textDiv);

    function setHighlight(on) {
      if (on) {
        item.setAttribute('data-highlighted', '');
        item.style.backgroundColor = 'var(--main-surface-secondary, rgba(128,128,128,0.12))';
      } else {
        item.removeAttribute('data-highlighted');
        item.style.backgroundColor = '';
      }
    }

    item.addEventListener('pointerenter', () => setHighlight(true));
    item.addEventListener('pointerleave', () => setHighlight(false));
    item.addEventListener('focus', () => setHighlight(true));
    item.addEventListener('blur', () => setHighlight(false));

    let isClickPending = false;

    item.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (destroyed || isClickPending || isModalOpen) return;
      isClickPending = true;

      const profileBtn = document.querySelector('[data-testid="accounts-profile-button"]');
      lastFocusedTrigger = profileBtn || item;

      // Close menu cleanly via synthetic Escape on menu
      try {
        menu.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true
        }));
      } catch (_) {}

      let frames = 0;
      const maxFrames = 15;

      function checkAndOpen() {
        if (destroyed) {
          isClickPending = false;
          return;
        }
        frames++;

        const isMenuStillVisible = isElementVisible(menu);

        if (!isMenuStillVisible) {
          isClickPending = false;
          openModal();
          return;
        }

        // At frame 8, if still visible, attempt pointerdown/up/click on profile trigger only if aria-expanded="true"
        if (frames === 8) {
          const trigger = document.querySelector('[data-testid="accounts-profile-button"]');
          if (trigger && trigger.getAttribute('aria-expanded') === 'true') {
            try {
              if (typeof trigger.focus === 'function') trigger.focus();
              trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
              trigger.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
              trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            } catch (_) {}
          }
        }

        if (frames < maxFrames) {
          safeRequestAnimationFrame(checkAndOpen);
        } else {
          isClickPending = false;
          // Do NOT show modal while old Radix modal remains visibly open
          if (!isElementVisible(menu)) {
            openModal();
          }
        }
      }

      safeRequestAnimationFrame(checkAndOpen);
    });

    item.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        if (typeof settItem.focus === 'function') settItem.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        if (typeof persItem.focus === 'function') persItem.focus();
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        item.click();
      } else if (e.key === 'Escape') {
        menu.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true
        }));
      } else if (e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) {
          if (typeof persItem.focus === 'function') persItem.focus();
        } else {
          if (typeof settItem.focus === 'function') settItem.focus();
        }
      }
    });

    // Keyboard bridge between native items
    persKeyHandler = (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        item.focus();
      }
    };
    settKeyHandler = (e) => {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        item.focus();
      }
    };
    persItem.addEventListener('keydown', persKeyHandler);
    settItem.addEventListener('keydown', settKeyHandler);

    parent.insertBefore(item, settItem);

    currentMenuItem = item;
    currentPersItem = persItem;
    currentSettItem = settItem;
  }

  function findMatchingPairInMenu(menu) {
    if (!isElementVisible(menu)) return null;

    const items = menu.querySelectorAll('[role="menuitem"]');
    let persItem = null;
    let settItem = null;

    for (let j = 0; j < items.length; j++) {
      const it = items[j];
      if (!isElementVisible(it)) continue;
      const text = (it.innerText || it.textContent || '').trim();
      if (!persItem && isPersLabel(text)) {
        persItem = it;
      } else if (!settItem && isSettLabel(text)) {
        settItem = it;
      }
    }

    if (persItem && settItem) {
      if (persItem.parentElement && persItem.parentElement === settItem.parentElement) {
        const pos = persItem.compareDocumentPosition(settItem);
        if (pos & Node.DOCUMENT_POSITION_FOLLOWING) {
          return { persItem, settItem };
        }
      }
    }
    return null;
  }

  function scanForAccountMenu() {
    if (destroyed) return;

    if (currentMenuItem && currentMenuItem.isConnected && document.body.contains(currentMenuItem)) {
      if (currentPersItem && currentPersItem.isConnected && currentSettItem && currentSettItem.isConnected &&
          currentMenuItem.parentElement === currentSettItem.parentElement) {
        return;
      }
      cleanupMenuItem();
    } else if (currentMenuItem) {
      cleanupMenuItem();
    }

    const menus = document.querySelectorAll('[role="menu"]');
    for (let i = 0; i < menus.length; i++) {
      const menu = menus[i];
      if (menu.querySelector('[data-cg-team-usage-item="true"]')) {
        return;
      }
      const pair = findMatchingPairInMenu(menu);
      if (pair) {
        injectMenuItem(menu, pair.persItem, pair.settItem);
        break;
      }
    }
  }

  function cleanupMenuItem() {
    if (currentPersItem && persKeyHandler) {
      try { currentPersItem.removeEventListener('keydown', persKeyHandler); } catch (_) {}
    }
    if (currentSettItem && settKeyHandler) {
      try { currentSettItem.removeEventListener('keydown', settKeyHandler); } catch (_) {}
    }
    if (currentMenuItem && currentMenuItem.parentNode) {
      try { currentMenuItem.parentNode.removeChild(currentMenuItem); } catch (_) {}
    }
    currentMenuItem = null;
    currentPersItem = null;
    currentSettItem = null;
    persKeyHandler = null;
    settKeyHandler = null;
  }

  // Scoped MutationObserver for account menu detection
  let rAfQueued = false;
  function scheduleScan() {
    if (destroyed || rAfQueued) return;
    rAfQueued = true;
    safeRequestAnimationFrame(() => {
      rAfQueued = false;
      if (!destroyed) scanForAccountMenu();
    });
  }

  const observer = new MutationObserver((mutations) => {
    if (destroyed) return;
    let relevant = false;

    for (let i = 0; i < mutations.length; i++) {
      const m = mutations[i];
      const target = m.target;

      if (target === host || (host && host.contains(target))) continue;

      if (target.nodeType === 1) {
        const el = target;
        if (el.closest('form, [data-message-id], .prose, .markdown, textarea, [contenteditable="true"]')) {
          continue;
        }
        if (el.getAttribute('role') === 'menu' || el.closest('[role="menu"], [data-radix-popper-content-wrapper]')) {
          relevant = true;
          break;
        }
      }

      const added = m.addedNodes;
      for (let j = 0; j < added.length; j++) {
        const node = added[j];
        if (node.nodeType === 1) {
          if (node.hasAttribute('data-cg-team-usage-item')) continue;
          const role = node.getAttribute('role');
          if (role === 'menu' || role === 'menuitem' || node.hasAttribute('data-radix-popper-content-wrapper') ||
              (node.querySelector && node.querySelector('[role="menu"], [role="menuitem"]'))) {
            relevant = true;
            break;
          }
        }
      }
      if (relevant) break;

      const removed = m.removedNodes;
      for (let j = 0; j < removed.length; j++) {
        const node = removed[j];
        if (node.nodeType === 1) {
          if (node === currentMenuItem || (node.contains && currentMenuItem && node.contains(currentMenuItem))) {
            relevant = true;
            break;
          }
          const role = node.getAttribute('role');
          if (role === 'menu' || role === 'menuitem' || node.hasAttribute('data-radix-popper-content-wrapper')) {
            relevant = true;
            break;
          }
        }
      }
      if (relevant) break;
    }

    if (relevant) scheduleScan();
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Initial check
  scheduleScan();

  // Route & Account Switch Listeners
  function handleRouteChange() {
    if (isModalOpen) closeModal(false);
  }
  window.addEventListener('popstate', handleRouteChange);

  // Return Controller
  return {
    update(nextSnapshot) {
      if (destroyed || !nextSnapshot || typeof nextSnapshot !== 'object') return;

      const nextAcc = (nextSnapshot.accountId !== undefined) ? nextSnapshot.accountId : null;
      if (!initialAccountObserved) {
        currentActiveAccount = nextAcc;
        if (nextAcc !== null) {
          initialAccountObserved = true;
        }
      } else if (nextAcc !== currentActiveAccount) {
        currentActiveAccount = nextAcc;
        dateInputDirty = false;
        expandedDates.clear();
        localStartDate = '';
        localEndDate = '';
        lastRenderedSignature = null;
        if (isModalOpen) {
          closeModal(false);
        }
      }

      snapshot = nextSnapshot;

      if (isModalOpen) {
        renderModalContent();
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      modalGeneration++;
      clearAllAsync();

      if (isModalOpen) {
        closeModal(false);
      }

      activeObjectUrls.forEach((url) => {
        try { URL.revokeObjectURL(url); } catch (_) {}
      });
      activeObjectUrls.clear();

      themeObserver.disconnect();
      if (darkMedia) {
        if (typeof darkMedia.removeEventListener === 'function') {
          darkMedia.removeEventListener('change', handleMediaChange);
        } else if (typeof darkMedia.removeListener === 'function') {
          darkMedia.removeListener(handleMediaChange);
        }
      }

      observer.disconnect();
      cleanupMenuItem();
      window.removeEventListener('popstate', handleRouteChange);

      if (host && host.parentNode) {
        host.parentNode.removeChild(host);
      }
    }
  };
}

function createTeamBillingController(onChange) {
  var TIMEOUT_MS = 18000;
  var MISSING_ACCOUNT = '无法确认当前工作空间，请先切换到要查询的空间';
  var NOTICE = '当前接口只返回历史发票，未提供下一期账单预估；可前往官方账单管理页查看。';
  var win = typeof window === 'undefined' ? null : window;
  var doc = typeof document === 'undefined' ? null : document;
  var destroyed = false;
  var generation = 0;
  var active = null;
  var accountWatcher = null;
  var emitting = false;
  var emitPending = false;
  var state = makeState('idle', null, accountCookie(), [], false, null, '');

  function makeState(status, error, accountId, history, hasMore, manageUrl, notice) {
    return {
      status: status,
      error: error,
      accountId: accountId,
      upcomingAvailable: false,
      notice: notice,
      history: copyHistory(history),
      hasMore: hasMore === true,
      manageUrl: manageUrl,
      updatedAt: new Date().toISOString()
    };
  }

  function copyHistory(history) {
    return history.map(function (invoice) {
      return {
        createdAt: invoice.createdAt,
        periodStart: invoice.periodStart,
        periodEnd: invoice.periodEnd,
        status: invoice.status,
        currency: invoice.currency,
        totalText: invoice.totalText,
        amountDueText: invoice.amountDueText,
        amountPaidText: invoice.amountPaidText
      };
    });
  }

  function snapshot() {
    return {
      status: state.status,
      error: state.error,
      accountId: state.accountId,
      upcomingAvailable: false,
      notice: state.notice,
      history: copyHistory(state.history),
      hasMore: state.hasMore,
      manageUrl: state.manageUrl,
      updatedAt: state.updatedAt
    };
  }

  function shouldWatchAccount() {
    return state.status === 'loading' || state.status === 'ready' || state.history.length > 0;
  }

  function syncAccountWatcher() {
    if (!destroyed && shouldWatchAccount() && accountWatcher === null && win && typeof win.setInterval === 'function') {
      // Detection-only cleanup for account changes in a focused SPA; this never polls an API.
      accountWatcher = win.setInterval(accountAwareness, 1000);
    } else if ((destroyed || !shouldWatchAccount()) && accountWatcher !== null) {
      if (win && typeof win.clearInterval === 'function') win.clearInterval(accountWatcher);
      accountWatcher = null;
    }
  }

  function setState(nextState) {
    state = nextState;
    syncAccountWatcher();
  }

  function emit() {
    if (destroyed || typeof onChange !== 'function') return;
    if (emitting) {
      emitPending = true;
      return;
    }
    emitting = true;
    do {
      emitPending = false;
      try {
        onChange(snapshot());
      } catch (ignored) {
        // A consumer callback cannot affect requests or controller state.
      }
    } while (!destroyed && emitPending);
    emitting = false;
  }

  function accountCookie() {
    if (!doc || typeof doc.cookie !== 'string') return null;
    var parts = doc.cookie.split(';');
    for (var index = 0; index < parts.length; index += 1) {
      var splitAt = parts[index].indexOf('=');
      var name = (splitAt < 0 ? parts[index] : parts[index].slice(0, splitAt)).trim();
      if (name !== '_account') continue;
      var value;
      try {
        value = decodeURIComponent(splitAt < 0 ? '' : parts[index].slice(splitAt + 1)).trim();
      } catch (ignored) {
        return null;
      }
      while (value.length >= 2 && ((value[0] === '"' && value[value.length - 1] === '"') || (value[0] === "'" && value[value.length - 1] === "'"))) {
        value = value.slice(1, -1).trim();
      }
      if (!value || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) return null;
      try {
        encodeURIComponent(value);
      } catch (ignoredEncoding) {
        return null;
      }
      return value;
    }
    return null;
  }

  function stopActive() {
    if (!active) return;
    var request = active;
    active = null;
    if (request.timer) clearTimeout(request.timer);
    try {
      request.controller.abort();
    } catch (ignored) {
      // The request may already be complete.
    }
  }

  function resetForAccountChange() {
    generation += 1;
    stopActive();
    setState(makeState('idle', null, accountCookie(), [], false, null, ''));
    emit();
  }

  function stillCurrent(accountId, requestGeneration) {
    if (destroyed || requestGeneration !== generation) return false;
    if (accountCookie() === accountId) return true;
    resetForAccountChange();
    return false;
  }

  function getSnapshot() {
    if (!destroyed && accountCookie() !== state.accountId) resetForAccountChange();
    return snapshot();
  }

  function currencyCode(value) {
    if (typeof value !== 'string' || !/^[A-Za-z]{3}$/.test(value)) return null;
    if (typeof Intl !== 'object' || typeof Intl.NumberFormat !== 'function') return null;
    var code = value.toUpperCase();
    try {
      if (typeof Intl.supportedValuesOf === 'function' && code !== 'ISK' && code !== 'UGX' && Intl.supportedValuesOf('currency').indexOf(code) === -1) return null;
      new Intl.NumberFormat('zh-CN', { style: 'currency', currency: code });
      return code;
    } catch (ignored) {
      return null;
    }
  }

  function money(value, currency) {
    if (!currency || !Number.isSafeInteger(value)) return null;
    try {
      var formatter = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: currency, currencyDisplay: 'code' });
      var digits = currency === 'ISK' || currency === 'UGX' ? 2 : formatter.resolvedOptions().maximumFractionDigits;
      return formatter.format(value / Math.pow(10, digits));
    } catch (ignored) {
      return null;
    }
  }

  function epoch(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return { iso: null, seconds: null };
    var date = new Date(value * 1000);
    return Number.isFinite(date.getTime()) ? { iso: date.toISOString(), seconds: value } : { iso: null, seconds: null };
  }

  function statusOf(value) {
    var status = typeof value === 'string' ? value.toLowerCase() : '';
    return /^(draft|open|paid|uncollectible|void)$/.test(status) ? status : 'unknown';
  }

  function parseInvoice(row) {
    var created = epoch(row.created);
    var currency = currencyCode(row.currency);
    return {
      seconds: created.seconds,
      value: {
        createdAt: created.iso,
        periodStart: epoch(row.period_start).iso,
        periodEnd: epoch(row.period_end).iso,
        status: statusOf(row.status),
        currency: currency,
        totalText: money(row.total, currency),
        amountDueText: money(row.amount_due, currency),
        amountPaidText: money(row.amount_paid, currency)
      }
    };
  }

  function parseHistory(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.data)) throw { type: 'json' };
    var rows = payload.data;
    var invoices = [];
    rows.forEach(function (row) {
      if (row && typeof row === 'object' && row.object === 'invoice') invoices.push(parseInvoice(row));
    });
    invoices.sort(function (left, right) {
      if (left.seconds === null) return right.seconds === null ? 0 : 1;
      if (right.seconds === null) return -1;
      return right.seconds - left.seconds;
    });
    return {
      history: invoices.slice(0, 10).map(function (entry) { return entry.value; }),
      hasMore: payload.has_more === true,
      unsupportedOnly: !!(rows.length && !invoices.length)
    };
  }

  function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    var prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function accountMatches(payload, accountId) {
    if (!isPlainObject(payload) || !isPlainObject(payload.accounts)) return false;
    var records = payload.accounts;
    if (Object.prototype.hasOwnProperty.call(records, accountId)) {
      var exactRecord = records[accountId];
      if (isPlainObject(exactRecord)) {
        var exactAccount = exactRecord.account;
        if (!isPlainObject(exactAccount) || !Object.prototype.hasOwnProperty.call(exactAccount, 'account_id') || exactAccount.account_id === accountId) return true;
      }
    }
    var keys = Object.keys(records);
    for (var index = 0; index < keys.length; index += 1) {
      var record = records[keys[index]];
      if (isPlainObject(record) && isPlainObject(record.account) && record.account.account_id === accountId) return true;
    }
    return false;
  }

  async function getJson(url, options) {
    var response = await fetch(url, options);
    if (!response || response.status < 200 || response.status >= 300) throw { type: 'http', status: response ? response.status : 0 };
    try {
      return await response.json();
    } catch (ignored) {
      throw { type: 'json' };
    }
  }

  function requestError(error, timedOut) {
    if (timedOut) return '请求超时（18 秒），请稍后重试';
    if (error && error.type === 'http') {
      if (error.status === 401) return '登录或会话已失效，请重新登录后重试';
      if (error.status === 403) return '无权限访问当前工作空间的账单记录';
      if (error.status === 429) return '请求过于频繁，请稍后重试';
      return '账单数据请求失败（HTTP ' + error.status + '）';
    }
    return error && error.type === 'json' ? '账单数据格式无效' : '无法加载账单数据，请稍后重试';
  }

  function fail(accountId, requestGeneration, message) {
    if (!stillCurrent(accountId, requestGeneration)) return;
    setState(makeState('error', message, accountId, [], false, null, ''));
    emit();
  }

  async function runLoad(accountId, requestGeneration, request) {
    var token = '';
    var headers = null;
    try {
      if (!stillCurrent(accountId, requestGeneration)) return getSnapshot();
      var session = await getJson('/api/auth/session', {
        method: 'GET', credentials: 'include', cache: 'no-store',
        headers: { Accept: 'application/json' }, signal: request.controller.signal
      });
      if (!stillCurrent(accountId, requestGeneration)) return getSnapshot();
      token = session && typeof session.accessToken === 'string' ? session.accessToken.trim() : '';
      if (!token || /[\r\n]/.test(token)) {
        fail(accountId, requestGeneration, '登录或会话已失效，请重新登录后重试');
        return getSnapshot();
      }
      headers = { Accept: 'application/json', Authorization: 'Bearer ' + token };
      var accounts = await getJson('/backend-api/accounts/check/v4-2023-04-27', {
        method: 'GET', credentials: 'include', cache: 'no-store', headers: headers, signal: request.controller.signal
      });
      if (!stillCurrent(accountId, requestGeneration)) return getSnapshot();
      if (!accountMatches(accounts, accountId)) {
        fail(accountId, requestGeneration, '无法验证当前工作空间访问权限');
        return getSnapshot();
      }
      var invoices = await getJson('/backend-api/invoices?limit=10&account_id=' + encodeURIComponent(accountId), {
        method: 'GET', credentials: 'include', cache: 'no-store', headers: headers, signal: request.controller.signal
      });
      if (!stillCurrent(accountId, requestGeneration)) return getSnapshot();
      var parsed = parseHistory(invoices);
      setState(makeState('ready', null, accountId, parsed.history, parsed.hasMore,
        typeof location === 'object' && location.origin ? location.origin + '/account/manage?account_id=' + encodeURIComponent(accountId) : null,
        NOTICE + (parsed.unsupportedOnly ? ' 当前接口未返回可识别的历史发票记录。' : '')));
      emit();
    } catch (error) {
      if (destroyed || requestGeneration !== generation || !stillCurrent(accountId, requestGeneration)) return getSnapshot();
      if (request.timedOut) fail(accountId, requestGeneration, requestError(error, true));
      else if (error && error.name === 'AbortError') {
        setState(makeState('idle', null, accountCookie(), [], false, null, ''));
        emit();
      } else fail(accountId, requestGeneration, requestError(error, false));
    } finally {
      token = '';
      if (headers) delete headers.Authorization;
      headers = null;
      if (active && active.generation === requestGeneration) {
        if (active.timer) clearTimeout(active.timer);
        active = null;
      }
    }
    return getSnapshot();
  }

  function load() {
    if (destroyed) return Promise.resolve(snapshot());
    generation += 1;
    stopActive();
    var requestGeneration = generation;
    var accountId = accountCookie();
    if (!accountId) {
      setState(makeState('error', MISSING_ACCOUNT, null, [], false, null, ''));
      emit();
      return Promise.resolve(snapshot());
    }
    if (typeof fetch !== 'function' || typeof AbortController === 'undefined') {
      setState(makeState('error', '当前环境无法加载账单数据，请稍后重试', accountId, [], false, null, ''));
      emit();
      return Promise.resolve(snapshot());
    }
    var request = { generation: requestGeneration, controller: new AbortController(), timer: null, timedOut: false };
    active = request;
    request.timer = setTimeout(function () {
      if (!destroyed && active && active.generation === requestGeneration) {
        active.timedOut = true;
        try { active.controller.abort(); } catch (ignored) {}
      }
    }, TIMEOUT_MS);
    setState(makeState('loading', null, accountId, [], false, null, ''));
    emit();
    return runLoad(accountId, requestGeneration, request);
  }

  function cancel() {
    if (destroyed || state.status !== 'loading') return snapshot();
    generation += 1;
    stopActive();
    var currentAccountId = accountCookie();
    var idleAccountId = currentAccountId === state.accountId ? state.accountId : currentAccountId;
    setState(makeState('idle', null, idleAccountId, [], false, null, ''));
    emit();
    return snapshot();
  }

  function accountAwareness() {
    if (!destroyed && accountCookie() !== state.accountId) resetForAccountChange();
  }

  if (win && typeof win.addEventListener === 'function') win.addEventListener('focus', accountAwareness);
  if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', accountAwareness);

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    generation += 1;
    stopActive();
    if (win && typeof win.removeEventListener === 'function') win.removeEventListener('focus', accountAwareness);
    if (doc && typeof doc.removeEventListener === 'function') doc.removeEventListener('visibilitychange', accountAwareness);
    setState(makeState('idle', null, null, [], false, null, ''));
  }

  return { getSnapshot: getSnapshot, load: load, cancel: cancel, destroy: destroy };
}

/**
 * Team 助手 - 账单查询 UI 模块 (mountTeamBillingPanel)
 * 提供“查看下月账单”按钮与原生 <dialog> 弹窗，呈现历史发票及官方账单管理入口。
 */
function mountTeamBillingPanel(options) {
    'use strict';
    options = options || {};

    function defaultSnapshot() {
        return {
            status: 'idle',
            error: null,
            accountId: null,
            upcomingAvailable: false,
            notice: '',
            history: [],
            hasMore: false,
            manageUrl: null,
            updatedAt: null
        };
    }

    var currentSnapshot = defaultSnapshot();
    var currentAccountId = null;
    var hasBoundAccount = false;
    var isOpen = false;
    var isLoading = false;
    var destroyed = false;
    var queryGeneration = 0;
    var lastRenderSig = '';
    var rafId = null, pollTimerId = null, routePollId = null;

    // 清理已存在的同类 host，避免 SPA 重复注入
    try {
        var oldB = document.querySelectorAll('[data-team-billing-btn]');
        for (var i = 0; i < oldB.length; i++) oldB[i].remove();
        var oldP = document.querySelectorAll('[data-team-billing-panel]');
        for (var j = 0; j < oldP.length; j++) oldP[j].remove();
    } catch (_) {}

    var btnHost = document.createElement('div');
    btnHost.setAttribute('data-team-billing-btn', '');
    btnHost.style.display = 'none';

    var panelHost = document.createElement('div');
    panelHost.setAttribute('data-team-billing-panel', '');
    (document.body || document.documentElement).appendChild(panelHost);

    var btnShadow = btnHost.attachShadow({ mode: 'open' });
    var panelShadow = panelHost.attachShadow({ mode: 'open' });

    var CSS_VARS = `
        :host {
            color-scheme: light;
            --tb-bg: #ffffff; --tb-bg-sec: #f7f7f8; --tb-bg-hover: rgba(0,0,0,0.05); --tb-bg-active: rgba(0,0,0,0.08);
            --tb-border: rgba(0,0,0,0.12); --tb-border-subtle: rgba(0,0,0,0.07);
            --tb-text: #0d0d0d; --tb-text-sec: #5d5d5d; --tb-text-mut: #8e8e8e; --tb-ring: #0d0d0d;
            --tb-card-bg: #f8f9fa; --tb-table-th: #f7f7f8; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        }
        :host([data-theme="dark"]) {
            color-scheme: dark;
            --tb-bg: #212121; --tb-bg-sec: #2f2f2f; --tb-bg-hover: rgba(255,255,255,0.08); --tb-bg-active: rgba(255,255,255,0.12);
            --tb-border: rgba(255,255,255,0.15); --tb-border-subtle: rgba(255,255,255,0.08);
            --tb-text: #ececec; --tb-text-sec: #b4b4b4; --tb-text-mut: #737373; --tb-ring: #ececec;
            --tb-card-bg: #282828; --tb-table-th: #282828;
        }
        @media (prefers-reduced-motion: reduce) {
            * { transition: none !important; animation: none !important; transform: none !important; }
        }
    `;

    var btnStyle = document.createElement('style');
    btnStyle.textContent = CSS_VARS + `
        :host { display: inline-flex; align-items: center; margin: 0; padding: 0; line-height: 0; flex-shrink: 0; }
        .cg-tb-btn {
            height: 44px; padding: 0 16px; margin: 0; box-sizing: border-box; display: inline-flex; align-items: center;
            justify-content: center; border-radius: 9999px; border: 1px solid var(--border-light, var(--tb-border));
            background: transparent; color: var(--text-primary, var(--tb-text)); font-family: inherit; font-size: 14px;
            font-weight: 500; cursor: pointer; outline: none; user-select: none; white-space: nowrap;
            transition: background-color 0.15s ease, border-color 0.15s ease;
        }
        .cg-tb-btn:hover { background: var(--main-surface-secondary, var(--tb-bg-hover)); border-color: var(--border-light, var(--tb-border)); }
        .cg-tb-btn:active { background: var(--tb-bg-active); transform: scale(0.99); }
        .cg-tb-btn:focus-visible { outline: 2px solid var(--tb-ring); outline-offset: 2px; }
    `;
    btnShadow.appendChild(btnStyle);

    var triggerBtn = document.createElement('button');
    triggerBtn.type = 'button';
    triggerBtn.className = 'cg-tb-btn';
    triggerBtn.textContent = '查看下月账单';
    triggerBtn.setAttribute('aria-haspopup', 'dialog');
    triggerBtn.setAttribute('aria-expanded', 'false');
    triggerBtn.addEventListener('click', onTriggerClick);
    btnShadow.appendChild(triggerBtn);

    var panelStyle = document.createElement('style');
    panelStyle.textContent = CSS_VARS + `
        .cg-tb-dialog {
            position: fixed; inset: 0; margin: auto; padding: 0; width: 720px; max-width: calc(100vw - 32px);
            max-height: calc(100vh - 48px); max-height: calc(100dvh - 48px); border: 1px solid var(--border-light, var(--tb-border));
            border-radius: 16px; background: var(--main-surface-primary, var(--tb-bg)); color: var(--text-primary, var(--tb-text));
            box-shadow: 0 20px 48px -10px rgba(0,0,0,0.35), 0 0 0 1px rgba(0,0,0,0.06);
            display: flex; flex-direction: column; outline: none; overflow: hidden; box-sizing: border-box; z-index: 2147483647;
        }
        .cg-tb-dialog:not([open]) { display: none; }
        .cg-tb-dialog::backdrop { background: rgba(0,0,0,0.52); backdrop-filter: blur(2px); -webkit-backdrop-filter: blur(2px); }
        .cg-tb-header { padding: 20px 24px 16px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--tb-border-subtle); flex-shrink: 0; }
        .cg-tb-title { margin: 0; font-size: 17px; font-weight: 600; color: var(--text-primary, var(--tb-text)); line-height: 1.3; }
        .cg-tb-close { background: transparent; border: none; color: var(--text-secondary, var(--tb-text-sec)); cursor: pointer; padding: 6px; margin: -6px; min-width: 36px; min-height: 36px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; outline: none; }
        .cg-tb-close:hover { background: var(--tb-bg-hover); color: var(--text-primary, var(--tb-text)); }
        .cg-tb-close:focus-visible { outline: 2px solid var(--tb-ring); }
        @media (pointer: coarse) { .cg-tb-close { min-width: 44px; min-height: 44px; } }
        .cg-tb-body { padding: 20px 24px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 20px; min-height: 0; }
        .cg-tb-card { padding: 14px 16px; background: var(--tb-card-bg); border: 1px solid var(--tb-border-subtle); border-radius: 10px; display: flex; flex-direction: column; gap: 6px; }
        .cg-tb-card-head { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; color: var(--text-primary, var(--tb-text)); }
        .cg-tb-dot { width: 8px; height: 8px; border-radius: 50%; background: #f59e0b; flex-shrink: 0; }
        .cg-tb-card-desc { margin: 0; font-size: 13px; color: var(--text-secondary, var(--tb-text-sec)); line-height: 1.5; }
        .cg-tb-sec-title { margin: 0 0 10px 0; font-size: 14px; font-weight: 600; color: var(--text-primary, var(--tb-text)); }
        .cg-tb-tbl-wrap { border: 1px solid var(--tb-border-subtle); border-radius: 10px; overflow-x: auto; background: var(--main-surface-primary, var(--tb-bg)); }
        .cg-tb-tbl { width: 100%; border-collapse: collapse; font-size: 13px; text-align: left; line-height: 1.4; }
        .cg-tb-tbl th { background: var(--tb-table-th); color: var(--text-secondary, var(--tb-text-sec)); font-weight: 500; padding: 10px 14px; border-bottom: 1px solid var(--tb-border-subtle); white-space: nowrap; }
        .cg-tb-tbl td { padding: 12px 14px; border-bottom: 1px solid var(--tb-border-subtle); color: var(--text-primary, var(--tb-text)); white-space: nowrap; }
        .cg-tb-tbl tr:last-child td { border-bottom: none; }
        .cg-tb-tbl tr:hover td { background: var(--tb-bg-hover); }
        .cg-tb-num { font-variant-numeric: tabular-nums; }
        .cg-tb-sub { font-size: 11.5px; color: var(--tb-text-mut); margin-top: 2px; }
        .cg-tb-badge { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 9999px; font-size: 11.5px; font-weight: 500; }
        .cg-tb-badge.paid { background: rgba(34,197,94,0.12); color: #15803d; border: 1px solid rgba(34,197,94,0.25); }
        :host([data-theme="dark"]) .cg-tb-badge.paid { background: rgba(34,197,94,0.18); color: #4ade80; border: 1px solid rgba(34,197,94,0.32); }
        .cg-tb-badge.open { background: rgba(234,179,8,0.12); color: #a16207; border: 1px solid rgba(234,179,8,0.25); }
        :host([data-theme="dark"]) .cg-tb-badge.open { background: rgba(234,179,8,0.18); color: #facc15; border: 1px solid rgba(234,179,8,0.32); }
        .cg-tb-badge.other { background: var(--tb-bg-sec); color: var(--tb-text-sec); border: 1px solid var(--tb-border-subtle); }
        .cg-tb-state { padding: 32px 16px; text-align: center; color: var(--tb-text-sec); font-size: 13.5px; display: flex; flex-direction: column; align-items: center; gap: 12px; }
        .cg-tb-tip { font-size: 12.5px; color: var(--tb-text-mut); margin-top: 8px; }
        .cg-tb-footer { padding: 14px 24px; border-top: 1px solid var(--tb-border-subtle); display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; background: var(--main-surface-primary, var(--tb-bg)); flex-shrink: 0; }
        .cg-tb-foot-info { font-size: 12px; color: var(--tb-text-mut); }
        .cg-tb-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-left: auto; }
        .cg-tb-act-btn { height: 36px; padding: 0 14px; box-sizing: border-box; border-radius: 9999px; font-size: 13px; font-weight: 500; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; outline: none; text-decoration: none; white-space: nowrap; }
        .cg-tb-act-btn.sec { border: 1px solid var(--border-light, var(--tb-border)); background: transparent; color: var(--text-primary, var(--tb-text)); }
        .cg-tb-act-btn.sec:hover { background: var(--tb-bg-hover); }
        .cg-tb-act-btn.sec:focus-visible { outline: 2px solid var(--tb-ring); outline-offset: 1px; }
        .cg-tb-act-btn.pri { border: 1px solid transparent; background: var(--text-primary, var(--tb-text)); color: var(--main-surface-primary, var(--tb-bg)); }
        .cg-tb-act-btn.pri:hover { opacity: 0.9; }
        .cg-tb-act-btn.pri:focus-visible { outline: 2px solid var(--tb-ring); outline-offset: 1px; }
        @media (max-width: 640px) {
            .cg-tb-header, .cg-tb-body, .cg-tb-footer { padding-left: 16px; padding-right: 16px; }
        }
    `;
    panelShadow.appendChild(panelStyle);

    var dialog = document.createElement('dialog');
    dialog.className = 'cg-tb-dialog';
    dialog.setAttribute('aria-labelledby', 'cg-tb-title');
    panelShadow.appendChild(dialog);

    if ('ariaControlsElements' in triggerBtn) {
        try { triggerBtn.ariaControlsElements = [dialog]; } catch (_) {}
    }

    // 坐标判断确保仅在点击背景遮罩区（而非内层白底/边距）时关闭
    dialog.addEventListener('click', function(e) {
        if (e.target !== dialog) return;
        var rect = dialog.getBoundingClientRect();
        var isInDialog = (
            rect.top <= e.clientY && e.clientY <= rect.bottom &&
            rect.left <= e.clientX && e.clientX <= rect.right
        );
        if (!isInDialog) {
            closeDialog(true);
        }
    });
    dialog.addEventListener('cancel', function(e) {
        e.preventDefault();
        closeDialog(true);
    });
    dialog.addEventListener('close', function() {
        if (isOpen) closeDialog(false);
    });

    // 稳定 DOM Shell（避免状态更新时销毁重绘导致焦点丢失）
    function el(tag, cls, text) {
        var node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    var headerEl = el('div', 'cg-tb-header');
    var titleEl = el('h2', 'cg-tb-title', '下月账单查询');
    titleEl.id = 'cg-tb-title';
    headerEl.appendChild(titleEl);

    var closeBtn = el('button', 'cg-tb-close');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', '关闭');
    closeBtn.title = '关闭';
    closeBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
    closeBtn.addEventListener('click', function() { closeDialog(true); });
    headerEl.appendChild(closeBtn);
    dialog.appendChild(headerEl);

    var bodyEl = el('div', 'cg-tb-body');

    var noticeCard = el('div', 'cg-tb-card');
    var noticeHead = el('div', 'cg-tb-card-head');
    noticeHead.appendChild(el('span', 'cg-tb-dot'));
    noticeHead.appendChild(el('span', null, '下一期账单：暂不可用'));
    noticeCard.appendChild(noticeHead);
    var noticeDesc = el('p', 'cg-tb-card-desc');
    noticeCard.appendChild(noticeDesc);
    bodyEl.appendChild(noticeCard);

    var stateContainer = el('div');
    bodyEl.appendChild(stateContainer);
    dialog.appendChild(bodyEl);

    var footerEl = el('div', 'cg-tb-footer');
    var footInfo = el('div', 'cg-tb-foot-info');
    footerEl.appendChild(footInfo);

    var actionsEl = el('div', 'cg-tb-actions');
    var manageLink = el('a', 'cg-tb-act-btn pri', '打开官方账单管理 ↗');
    manageLink.target = '_blank';
    manageLink.rel = 'noopener noreferrer';
    manageLink.style.display = 'none';
    actionsEl.appendChild(manageLink);

    var closeActionBtn = el('button', 'cg-tb-act-btn sec', '关闭');
    closeActionBtn.type = 'button';
    closeActionBtn.addEventListener('click', function() { closeDialog(true); });
    actionsEl.appendChild(closeActionBtn);
    footerEl.appendChild(actionsEl);
    dialog.appendChild(footerEl);

    // 主题解析：优先级 html 明确主题 > body 明确主题 > 系统 media
    var darkMedia = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    function explicitTheme(node) {
        if (!node) return null;
        try {
            var attr = node.getAttribute('data-theme');
            if (attr === 'dark' || attr === 'light') return attr;
            if (node.classList.contains('dark')) return 'dark';
            if (node.classList.contains('light')) return 'light';
        } catch (_) {}
        return null;
    }

    function updateTheme() {
        var mode = explicitTheme(document.documentElement) ||
                   explicitTheme(document.body) ||
                   (darkMedia && darkMedia.matches ? 'dark' : 'light');
        btnHost.setAttribute('data-theme', mode);
        panelHost.setAttribute('data-theme', mode);
    }
    updateTheme();

    var themeObserver = new MutationObserver(updateTheme);
    if (document.documentElement) themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    if (document.body) themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    if (darkMedia && darkMedia.addEventListener) darkMedia.addEventListener('change', updateTheme);

    function isBillingRoute() {
        try { return /^\/admin\/billing(?:\/|$)/i.test(window.location.pathname || ''); } catch (_) { return false; }
    }

    function isElementVisible(elNode) {
        if (!elNode || !elNode.isConnected) return false;
        try {
            if (typeof elNode.checkVisibility === 'function') {
                if (!elNode.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
            }
            var rect = elNode.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return false;
            var style = window.getComputedStyle(elNode);
            return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        } catch (_) { return false; }
    }

    function locateManageButton() {
        if (!isBillingRoute()) return null;
        var buttons = document.querySelectorAll('button');
        for (var i = 0; i < buttons.length; i++) {
            var b = buttons[i];
            if (b === triggerBtn || btnHost.contains(b) || panelHost.contains(b)) continue;
            if (b.closest('nav, aside, table, article, dialog, [role="dialog"]')) continue;
            if (!isElementVisible(b)) continue;

            var text = (b.textContent || '').trim().replace(/\s+/g, ' ');
            if (text !== '管理席位' && text !== '管理席次' && !/^manage\s+seats$/i.test(text)) continue;

            var parent = b.parentElement;
            if (!parent || parent === document.body || parent === document.documentElement) continue;

            var pStyle = null;
            try { pStyle = window.getComputedStyle(parent); } catch (_) {}
            var isFlex = (pStyle && (pStyle.display === 'flex' || pStyle.display === 'inline-flex')) ||
                         (parent.className && parent.className.indexOf('flex') >= 0);
            if (!isFlex) continue;

            return { manageButton: b, container: parent };
        }
        return null;
    }

    function schedulePositionUpdate() {
        if (destroyed) return;
        if (rafId) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(updatePosition);
    }

    function updatePosition() {
        rafId = null;
        if (destroyed) return;
        var anchor = locateManageButton();
        if (!anchor) {
            btnHost.style.display = 'none';
            triggerBtn.hidden = true;
            if (isOpen) closeDialog(false);
            return;
        }
        if (anchor.manageButton.previousElementSibling !== btnHost) {
            anchor.container.insertBefore(btnHost, anchor.manageButton);
        }
        btnHost.style.display = '';
        triggerBtn.hidden = false;
    }

    function formatDate(val) {
        if (!val) return '—';
        try {
            var d = new Date(val);
            if (isNaN(d.getTime())) return String(val);
            return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        } catch (_) { return String(val); }
    }

    function formatPeriod(s, e) {
        var ds = formatDate(s), de = formatDate(e);
        if (ds === '—' && de === '—') return '—';
        return (ds !== '—' && de !== '—') ? (ds + ' ~ ' + de) : (ds !== '—' ? ds : de);
    }

    function getStatusMeta(status) {
        switch ((status || '').toLowerCase()) {
            case 'paid': return { label: '已支付', cls: 'paid' };
            case 'open': return { label: '待支付', cls: 'open' };
            case 'draft': return { label: '草稿', cls: 'other' };
            case 'void': return { label: '已作废', cls: 'other' };
            case 'uncollectible': return { label: '未结', cls: 'other' };
            default: return { label: '未知', cls: 'other' };
        }
    }

    function validateManageUrl(url, accountId) {
        if (!url || typeof url !== 'string' || !accountId || typeof accountId !== 'string') return null;
        try {
            var parsed = new URL(url, window.location.origin);
            if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
            if (parsed.origin !== window.location.origin) return null;
            if (!/^\/account\/manage(?:\/|$)/i.test(parsed.pathname)) return null;
            var urlAccountId = parsed.searchParams.get('account_id');
            if (!urlAccountId || urlAccountId !== accountId) return null;
            return parsed.href;
        } catch (_) { return null; }
    }

    // 账号一致性与快照合并 helper
    function applySnapshot(nextSnap) {
        if (!nextSnap || typeof nextSnap !== 'object') return;
        var nextId = (typeof nextSnap.accountId === 'string' && nextSnap.accountId.trim() !== '') ? nextSnap.accountId : null;

        if (!hasBoundAccount) {
            if (nextId !== null) {
                currentAccountId = nextId;
                hasBoundAccount = true;
            }
        } else {
            // 已绑定账号后，任何变更（包含 nonnull -> null）均代表账号切换，清除并静默关闭
            if (nextId !== currentAccountId) {
                currentAccountId = nextId;
                currentSnapshot = Object.assign({}, defaultSnapshot(), nextSnap);
                queryGeneration++;
                lastRenderSig = '';
                if (isOpen) closeDialog(false);
                return;
            }
        }

        currentSnapshot = Object.assign({}, currentSnapshot, nextSnap);
        if (isOpen) render();
    }

    function render(force) {
        var st = currentSnapshot.status || 'idle';
        titleEl.textContent = (st === 'loading') ? '正在查询…' : '下月账单查询';
        noticeDesc.textContent = currentSnapshot.notice || '当前接口只返回已有发票，未提供下一期账单预估。以下为最近历史记录，可前往官方账单管理页查看。';

        var safeManageUrl = validateManageUrl(currentSnapshot.manageUrl, currentAccountId);
        if (safeManageUrl) {
            manageLink.href = safeManageUrl;
            manageLink.style.display = '';
        } else {
            manageLink.style.display = 'none';
            manageLink.removeAttribute('href');
        }

        footInfo.textContent = currentSnapshot.updatedAt ? ('更新于 ' + formatDate(currentSnapshot.updatedAt)) : '';

        var sig = st + '|' + (currentSnapshot.updatedAt || '') + '|' + (currentSnapshot.history ? currentSnapshot.history.length : 0) + '|' + (currentSnapshot.error || '') + '|' + (currentSnapshot.hasMore ? 1 : 0);
        if (!force && sig === lastRenderSig) return;
        lastRenderSig = sig;

        while (stateContainer.firstChild) stateContainer.removeChild(stateContainer.firstChild);

        if (st === 'loading') {
            var loadingBox = el('div', 'cg-tb-state', '正在查询账单与发票信息…');
            loadingBox.setAttribute('role', 'status');
            loadingBox.setAttribute('aria-live', 'polite');
            stateContainer.appendChild(loadingBox);
        } else if (st === 'error') {
            var errorBox = el('div', 'cg-tb-state');
            errorBox.setAttribute('role', 'alert');
            errorBox.appendChild(el('span', null, currentSnapshot.error || '获取账单信息失败，请稍后重试'));
            var retryBtn = el('button', 'cg-tb-act-btn sec', '重试');
            retryBtn.type = 'button';
            retryBtn.addEventListener('click', function() { loadData(); });
            errorBox.appendChild(retryBtn);
            stateContainer.appendChild(errorBox);
        } else {
            var historySec = el('div');
            historySec.appendChild(el('h3', 'cg-tb-sec-title', '最近历史发票'));

            var items = Array.isArray(currentSnapshot.history) ? currentSnapshot.history : [];
            if (items.length === 0) {
                historySec.appendChild(el('div', 'cg-tb-state', '暂无历史发票记录'));
            } else {
                var tblWrap = el('div', 'cg-tb-tbl-wrap');
                var table = el('table', 'cg-tb-tbl');
                var thead = document.createElement('thead');
                thead.innerHTML = '<tr><th>开票时间</th><th>账期</th><th style="text-align:right">金额</th><th style="text-align:center">状态</th></tr>';
                table.appendChild(thead);

                var tbody = document.createElement('tbody');
                for (var k = 0; k < items.length; k++) {
                    var item = items[k] || {};
                    var tr = document.createElement('tr');
                    tr.appendChild(el('td', 'cg-tb-num', formatDate(item.createdAt)));
                    tr.appendChild(el('td', 'cg-tb-num', formatPeriod(item.periodStart, item.periodEnd)));

                    var tdAmt = el('td', 'cg-tb-num');
                    tdAmt.style.textAlign = 'right';
                    var totalTxt = (typeof item.totalText === 'string' && item.totalText.trim() !== '') ? item.totalText : '—';
                    tdAmt.appendChild(document.createTextNode(totalTxt));
                    if (typeof item.amountPaidText === 'string' && item.amountPaidText.trim() !== '' && item.amountPaidText !== totalTxt) {
                        tdAmt.appendChild(el('div', 'cg-tb-sub', '已付: ' + item.amountPaidText));
                    }
                    tr.appendChild(tdAmt);

                    var tdSt = el('td', null);
                    tdSt.style.textAlign = 'center';
                    var meta = getStatusMeta(item.status);
                    tdSt.appendChild(el('span', 'cg-tb-badge ' + meta.cls, meta.label));
                    tr.appendChild(tdSt);

                    tbody.appendChild(tr);
                }
                table.appendChild(tbody);
                tblWrap.appendChild(table);
                historySec.appendChild(tblWrap);

                if (currentSnapshot.hasMore) {
                    historySec.appendChild(el('div', 'cg-tb-tip', '仅展示最近记录，更多发票请前往官方账单管理页面查看。'));
                }
            }
            stateContainer.appendChild(historySec);
        }
    }

    function onTriggerClick(e) {
        e.stopPropagation();
        if (destroyed) return;
        openDialog();
    }

    function openDialog() {
        if (destroyed || isOpen) return;
        if (!locateManageButton()) return;

        // 打开前先同步外部 snapshot，避免回调在刚打开时触发误关
        if (typeof options.getSnapshot === 'function') {
            try {
                var initialSnap = options.getSnapshot();
                if (initialSnap && typeof initialSnap === 'object') {
                    applySnapshot(initialSnap);
                }
            } catch (_) {}
        }

        isOpen = true;
        triggerBtn.setAttribute('aria-expanded', 'true');
        updateTheme();
        render(true);

        try { dialog.showModal(); } catch (_) { dialog.setAttribute('open', ''); }

        startAccountPoll();
        loadData();
    }

    function closeDialog(userIntent) {
        if (!isOpen) return;
        isOpen = false;
        triggerBtn.setAttribute('aria-expanded', 'false');
        queryGeneration++;
        stopAccountPoll();

        if (isLoading) {
            isLoading = false;
            if (typeof options.onCancel === 'function') {
                try { options.onCancel(); } catch (_) {}
            }
        }

        try {
            if (typeof dialog.close === 'function' && dialog.open) {
                dialog.close();
            } else {
                dialog.removeAttribute('open');
            }
        } catch (_) {}

        if (userIntent && triggerBtn && triggerBtn.isConnected && !triggerBtn.hidden) {
            try { triggerBtn.focus(); } catch (_) {}
        }
    }

    function loadData() {
        if (destroyed || !isOpen || isLoading || typeof options.onLoad !== 'function') return;
        var gen = ++queryGeneration;
        isLoading = true;
        currentSnapshot.status = 'loading';
        render();

        Promise.resolve().then(function() {
            if (destroyed || !isOpen || gen !== queryGeneration) return;
            return options.onLoad();
        }).then(function(res) {
            if (destroyed || !isOpen || gen !== queryGeneration) return;
            isLoading = false;
            if (typeof options.getSnapshot === 'function') {
                try {
                    var fresh = options.getSnapshot();
                    if (fresh && typeof fresh === 'object') {
                        applySnapshot(fresh);
                        return;
                    }
                } catch (_) {}
            }
            if (res && typeof res === 'object') {
                applySnapshot(res);
            } else {
                render();
            }
        }).catch(function() {
            if (destroyed || !isOpen || gen !== queryGeneration) return;
            isLoading = false;
            currentSnapshot.status = 'error';
            currentSnapshot.error = '获取账单信息失败，请稍后重试';
            render();
        });
    }

    function startAccountPoll() {
        stopAccountPoll();
        pollTimerId = setInterval(function() {
            if (destroyed || !isOpen || typeof options.getSnapshot !== 'function') return;
            try {
                var fresh = options.getSnapshot();
                if (fresh && typeof fresh === 'object') {
                    applySnapshot(fresh);
                }
            } catch (_) {}
        }, 1000);
    }

    function stopAccountPoll() {
        if (pollTimerId) { clearInterval(pollTimerId); pollTimerId = null; }
    }

    var domObserver = new MutationObserver(function(mutations) {
        for (var i = 0; i < mutations.length; i++) {
            var m = mutations[i];
            if (m.target === btnHost || m.target === panelHost ||
                btnHost.contains(m.target) || panelHost.contains(m.target)) continue;
            schedulePositionUpdate();
            break;
        }
    });

    var observeRoot = document.body || document.documentElement;
    if (observeRoot) domObserver.observe(observeRoot, { childList: true, subtree: true });

    routePollId = setInterval(schedulePositionUpdate, 1500);
    window.addEventListener('resize', schedulePositionUpdate);
    window.addEventListener('scroll', schedulePositionUpdate, true);
    window.addEventListener('popstate', schedulePositionUpdate);

    schedulePositionUpdate();

    return {
        update: function(snapshot) {
            if (destroyed || !snapshot || typeof snapshot !== 'object') return;
            applySnapshot(snapshot);
        },
        destroy: function() {
            if (destroyed) return;
            closeDialog(false);
            destroyed = true;

            if (routePollId) clearInterval(routePollId);
            stopAccountPoll();
            if (rafId) cancelAnimationFrame(rafId);

            domObserver.disconnect();
            themeObserver.disconnect();
            if (darkMedia && darkMedia.removeEventListener) darkMedia.removeEventListener('change', updateTheme);

            window.removeEventListener('resize', schedulePositionUpdate);
            window.removeEventListener('scroll', schedulePositionUpdate, true);
            window.removeEventListener('popstate', schedulePositionUpdate);

            btnHost.remove();
            panelHost.remove();
        }
    };
}

let view = null;
let usageView = null;
let billingView = null;
let usageController = null;
let billingController = null;
const monitor = createSeatHistoryMonitor(snapshot => {
    if (view) view.update(snapshot);
});
let mounted = false;
function mountWhenReady() {
    if (mounted || !document.body) return;
    mounted = true;

    try {
        startNoticeHiding();
    } catch (_) {
        console.warn('[Team 助手] 用量提醒隐藏初始化失败');
    }

    try {
        view = mountSeatHistoryPanel({
            getSnapshot: monitor.getSnapshot,
            onClearCurrent: monitor.clearCurrentHistory
        });
        view.update(monitor.getSnapshot());
    } catch (_) {
        console.warn('[Team 助手] 席位历史初始化失败');
    }

    try {
        usageController = createTeamUsageController(snapshot => {
            if (usageView) usageView.update(snapshot);
        });
        usageView = mountTeamUsagePanel({
            getSnapshot: usageController.getSnapshot,
            onLoad: usageController.load,
            onSetView: usageController.setViewMode,
            onCancel: usageController.cancel,
            onExport: usageController.buildExport
        });
        usageView.update(usageController.getSnapshot());
    } catch (_) {
        if (usageController) usageController.destroy();
        usageController = null;
        usageView = null;
        console.warn('[Team 助手] 用量统计初始化失败');
    }

    try {
        billingController = createTeamBillingController(snapshot => {
            if (billingView) billingView.update(snapshot);
        });
        billingView = mountTeamBillingPanel({
            getSnapshot: billingController.getSnapshot,
            onLoad: billingController.load,
            onCancel: billingController.cancel
        });
        billingView.update(billingController.getSnapshot());
    } catch (_) {
        if (billingController) billingController.destroy();
        billingController = null;
        billingView = null;
        console.warn('[Team 助手] 历史账单初始化失败');
    }
}
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountWhenReady, { once: true });
} else {
    mountWhenReady();
}
})();
