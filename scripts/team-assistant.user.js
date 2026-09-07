// ==UserScript==
// @name         Team 助手
// @namespace    https://github.com/zjm54321/chatgpt-scripts
// @version      v2026.09.07-2
// @description  隐藏指定用量提醒，在成员页查看本地席位阈值历史；不修改额度或计费设置。
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
    var oldBtnHost = document.getElementById('__chatgpt_team_seat_history_btn_host__');
    if (oldBtnHost) oldBtnHost.remove();
    var oldPanelHost = document.getElementById('__chatgpt_team_seat_history_panel_host__');
    if (oldPanelHost) oldPanelHost.remove();
    var ICONS = {
        plus: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
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
        :host { display: inline-flex; align-items: center; justify-content: center; vertical-align: middle; position: relative; box-sizing: border-box; }
        .cg-sh-btn {
            width: 36px; height: 36px; min-width: 36px; min-height: 36px; padding: 0; margin: 0; box-sizing: border-box;
            display: inline-flex; align-items: center; justify-content: center; border-radius: 8px;
            border: 1px solid var(--border-light, var(--cg-sh-border-secondary)); background: transparent;
            color: var(--text-secondary, var(--cg-sh-text-secondary)); cursor: pointer; outline: none; user-select: none;
            transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease, transform 0.1s ease;
        }
        .cg-sh-btn:hover { background-color: var(--main-surface-secondary, var(--cg-sh-bg-hover)); color: var(--text-primary, var(--cg-sh-text-primary)); border-color: var(--border-light, var(--cg-sh-border)); }
        .cg-sh-btn:active { background-color: var(--cg-sh-bg-active); transform: scale(0.96); }
        .cg-sh-btn:focus-visible { outline: 2px solid var(--cg-sh-focus-ring); outline-offset: 2px; }
        .cg-sh-btn[data-open="true"] { background-color: var(--main-surface-secondary, var(--cg-sh-bg-hover)); color: var(--text-primary, var(--cg-sh-text-primary)); border-color: var(--border-light, var(--cg-sh-border)); }
        .cg-sh-btn[hidden] { display: none !important; }
        .cg-sh-icon-slot { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; }
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
    iconSlot.innerHTML = ICONS.plus;
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

    // Header anchoring search
    function locateAnchor() {
        if (!isMembersRoute()) return null;
        var headings = document.querySelectorAll('h1, h2, h3');
        for (var i = 0; i < headings.length; i++) {
            var h = headings[i];
            if (h.closest('nav, aside, table, article, dialog')) continue;

            var text = (h.textContent || '').trim();
            if (text !== '成员' && !/^members$/i.test(text)) continue;
            var current = h.parentElement;
            var depth = 0;
            var headerRow = null;
            var titleContainer = null;

            while (current && depth < 6) {
                if (current === document.body || current === document.documentElement) break;
                var style = null;
                try { style = window.getComputedStyle(current); } catch (_) {}
                var isFlex = style && (style.display === 'flex' || style.display === 'inline-flex');
                var isJustifyBetween = style && (style.justifyContent === 'space-between' ||
                    (current.className && current.className.indexOf('justify-between') >= 0));
                if (isFlex && isJustifyBetween) {
                    headerRow = current;
                    break;
                }
                titleContainer = current;
                current = current.parentElement;
                depth++;
            }

            if (!headerRow || !isElementVisible(headerRow)) continue;
            // Find right-hand action container Child D
            var targetContainer = null;
            for (var c = 0; c < headerRow.children.length; c++) {
                var ch = headerRow.children[c];
                if (ch === titleContainer || ch.contains(h) || ch === btnHost) continue;
                if (ch.tagName !== 'DIV') continue;
                targetContainer = ch;
                break;
            }
            if (!targetContainer) targetContainer = headerRow;
            return { headerRow: headerRow, targetContainer: targetContainer };
        }
        return null;
    }

    // Toggle Popover
    function togglePopover(force, returnFocus) {
        if (destroyed) return;
        var next = typeof force === 'boolean' ? force : !isOpen;
        if (isOpen === next) return;
        isOpen = next;

        btn.setAttribute('aria-expanded', String(next));
        btn.setAttribute('data-open', String(next));
        iconSlot.innerHTML = next ? ICONS.close : ICONS.plus;
        btn.setAttribute('aria-label', next ? '关闭席位阈值历史' : '席位阈值历史');

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

        var targetContainer = anchor.targetContainer;
        if (targetContainer && targetContainer !== btnHost && btnHost.parentElement !== targetContainer) {
            targetContainer.appendChild(btnHost);
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

let view = null;
const monitor = createSeatHistoryMonitor(snapshot => {
    if (view) view.update(snapshot);
});
let mounted = false;
function mountWhenReady() {
    if (mounted || !document.body) return;
    mounted = true;
    startNoticeHiding();
    view = mountSeatHistoryPanel({
        getSnapshot: monitor.getSnapshot,
        onClearCurrent: monitor.clearCurrentHistory
    });
    view.update(monitor.getSnapshot());
}
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountWhenReady, { once: true });
} else {
    mountWhenReady();
}
})();
