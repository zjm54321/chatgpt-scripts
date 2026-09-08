// ==UserScript==
// @name         Team 助手
// @namespace    https://github.com/zjm54321/chatgpt-scripts
// @version      v2026.09.08-1
// @description  官方下期账单读取、用量额度统计与席位历史提醒；不修改额度或计费设置。
// @author       zjm54321
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @match        https://pay.openai.com/*
// @grant        none
// @run-at       document-start
// @noframes
// @homepageURL  https://github.com/zjm54321/chatgpt-scripts
// @supportURL   https://github.com/zjm54321/chatgpt-scripts/issues
// @downloadURL  https://raw.githubusercontent.com/zjm54321/chatgpt-scripts/main/scripts/team-assistant.user.js
// @updateURL    https://raw.githubusercontent.com/zjm54321/chatgpt-scripts/main/scripts/team-assistant.user.js
// ==/UserScript==

(() => { "use strict";
if(location.origin==='https://pay.openai.com') { if(window.top!==window.self || window.__CHATGPT_TEAM_BILLING_READER__) return; window.__CHATGPT_TEAM_BILLING_READER__=true; runOfficialBillingReader(); return; }
if(location.origin!=='https://chatgpt.com' && location.origin!=='https://chat.openai.com') return;
if(window.__CHATGPT_TEAM_ASSISTANT__)return;window.__CHATGPT_TEAM_ASSISTANT__=true;
function createSeatHistoryMonitor(onChange, onPolicyNotice) {
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

  function notifyPolicy(accountId, userId, capturedAt, values) {
    if (destroyed || typeof onPolicyNotice !== 'function') return;
    refreshAccountId();
    if (activeAccountId !== accountId) return;
    try {
      onPolicyNotice({
        accountId: accountId,
        userId: userId,
        capturedAt: capturedAt,
        policy: {
          vacancyOrdinal: values.vacancyOrdinal,
          freeVacancyThreshold: values.freeVacancyThreshold,
          billingStartsAt: values.billingStartsAt,
          expiresAt: values.expiresAt
        },
        saved: true
      });
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

  function appendPolicy(accountId, userId, values, shouldNotifyPolicy) {
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

      var capturedAt = new Date().toISOString();
      history.push({
        capturedAt: capturedAt,
        vacancyOrdinal: values.vacancyOrdinal,
        freeVacancyThreshold: values.freeVacancyThreshold,
        billingStartsAt: values.billingStartsAt,
        expiresAt: values.expiresAt
      });
      defineOwn(records, key, { accountId: accountId, userId: userId, history: history });
      return { ok: saveStoredObject(HISTORY_KEY, records), changed: true, capturedAt: capturedAt };
    }).then(function (result) {
      if (!result.ok) notify();
      else if (result.changed) {
        notify();
        if (shouldNotifyPolicy && !destroyed) notifyPolicy(accountId, userId, result.capturedAt, values);
      }
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
    if (values) appendPolicy(target.accountId, target.userId, values, payload.policy_notice !== null);
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
        iconSlot.innerHTML = ICONS.contacts;
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


function mountSeatPolicyToast(options) {
    'use strict';
    options = options || {};

    var destroyed = false;
    var isVisible = false;
    var isHovered = false;
    var isFocused = false;
    var burstCount = 0;
    var hideTimeoutId = null;
    var hideFallbackTimer = null;
    var seenKeys = [];
    var HIDE_DELAY = 6000;

    // Clean up any existing stale toast host instances
    var oldHosts = document.querySelectorAll('[data-seat-toast]');
    for (var h = 0; h < oldHosts.length; h++) {
        oldHosts[h].remove();
    }

    var ICONS = {
        close: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
    };

    var THEME_CSS = `
        :host {
            --cg-st-bg: #ffffff;
            --cg-st-bg-hover: rgba(0, 0, 0, 0.05);
            --cg-st-border: rgba(0, 0, 0, 0.12);
            --cg-st-text-primary: #0d0d0d;
            --cg-st-text-secondary: #5d5d5d;
            --cg-st-text-muted: #8e8e8e;
            --cg-st-tag-bg: rgba(0, 0, 0, 0.05);
            --cg-st-shadow: 0 10px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1), 0 0 0 1px rgba(0,0,0,0.06);
            --cg-st-focus-ring: #0d0d0d;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            -webkit-font-smoothing: antialiased;
            -moz-osx-font-smoothing: grayscale;
            position: fixed;
            bottom: 24px;
            right: 24px;
            z-index: 2147483646;
            pointer-events: none;
        }
        :host([data-theme="dark"]) {
            --cg-st-bg: #212121;
            --cg-st-bg-hover: rgba(255, 255, 255, 0.08);
            --cg-st-border: rgba(255, 255, 255, 0.15);
            --cg-st-text-primary: #ececec;
            --cg-st-text-secondary: #b4b4b4;
            --cg-st-text-muted: #737373;
            --cg-st-tag-bg: rgba(255, 255, 255, 0.06);
            --cg-st-shadow: 0 10px 25px -5px rgba(0,0,0,0.5), 0 8px 10px -6px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.1);
            --cg-st-focus-ring: #ececec;
        }
        .cg-st-card {
            pointer-events: auto;
            width: 320px;
            max-width: calc(100vw - 32px);
            box-sizing: border-box;
            background: var(--main-surface-primary, var(--cg-st-bg));
            border: 1px solid var(--border-light, var(--cg-st-border));
            border-radius: 10px;
            box-shadow: var(--cg-st-shadow);
            color: var(--text-primary, var(--cg-st-text-primary));
            padding: 12px 14px;
            display: flex;
            flex-direction: column;
            gap: 6px;
            opacity: 0;
            transform: translateY(8px);
            transition: opacity 0.2s cubic-bezier(0.16, 1, 0.3, 1), transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
            user-select: none;
        }
        .cg-st-card.is-visible {
            opacity: 1;
            transform: translateY(0);
        }
        .cg-st-card[hidden] {
            display: none !important;
        }
        @media (prefers-reduced-motion: reduce) {
            .cg-st-card {
                transition: none !important;
            }
            .cg-st-close-btn {
                transition: none !important;
            }
        }
        .cg-st-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
        }
        .cg-st-title-group {
            display: flex;
            align-items: center;
            gap: 6px;
            min-width: 0;
        }
        .cg-st-title {
            font-size: 13px;
            font-weight: 600;
            color: var(--text-primary, var(--cg-st-text-primary));
            line-height: 1.3;
        }
        .cg-st-burst-badge {
            font-size: 10px;
            font-weight: 500;
            padding: 1px 5px;
            border-radius: 4px;
            background: var(--cg-st-tag-bg);
            color: var(--text-secondary, var(--cg-st-text-secondary));
            font-variant-numeric: tabular-nums;
        }
        .cg-st-close-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 36px;
            height: 36px;
            min-width: 36px;
            min-height: 36px;
            border-radius: 6px;
            border: none;
            background: transparent;
            color: var(--text-secondary, var(--cg-st-text-muted));
            cursor: pointer;
            padding: 0;
            outline: none;
            transition: background-color 0.15s ease, color 0.15s ease;
            flex-shrink: 0;
        }
        .cg-st-close-btn:hover {
            background-color: var(--main-surface-secondary, var(--cg-st-bg-hover));
            color: var(--text-primary, var(--cg-st-text-primary));
        }
        .cg-st-close-btn:focus-visible {
            outline: 2px solid var(--cg-st-focus-ring);
            outline-offset: 1px;
        }
        @media (pointer: coarse) {
            .cg-st-close-btn {
                width: 44px;
                height: 44px;
                min-width: 44px;
                min-height: 44px;
            }
        }
        .cg-st-body {
            font-size: 12px;
            color: var(--text-secondary, var(--cg-st-text-secondary));
            line-height: 1.4;
            word-break: break-word;
        }
        .cg-st-meta-row {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin-top: 2px;
        }
        .cg-st-pill {
            display: inline-flex;
            align-items: center;
            gap: 3px;
            font-size: 11px;
            font-variant-numeric: tabular-nums;
            padding: 2px 6px;
            border-radius: 4px;
            background: var(--cg-st-tag-bg);
            color: var(--text-secondary, var(--cg-st-text-secondary));
            max-width: 100%;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .cg-st-pill-k {
            font-weight: 400;
            opacity: 0.85;
        }
        .cg-st-pill-v {
            font-weight: 600;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
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

    var toastHost = document.createElement('div');
    toastHost.id = '__chatgpt_team_seat_toast_host__';
    toastHost.setAttribute('data-seat-toast', '');
    (document.body || document.documentElement).appendChild(toastHost);

    var shadow = toastHost.attachShadow({ mode: 'open' });
    var styleNode = document.createElement('style');
    styleNode.textContent = THEME_CSS;
    shadow.appendChild(styleNode);

    var card = el('div', 'cg-st-card', null, shadow, {
        role: 'status',
        'aria-live': 'polite',
        hidden: true
    });

    var header = el('div', 'cg-st-header', null, card);
    var titleGroup = el('div', 'cg-st-title-group', null, header);
    var titleEl = el('span', 'cg-st-title', '检测到席位策略变化', titleGroup);
    var burstBadge = el('span', 'cg-st-burst-badge', null, titleGroup, { hidden: true });

    var closeBtn = el('button', 'cg-st-close-btn', null, header, {
        type: 'button',
        'aria-label': '关闭提示',
        title: '关闭提示'
    });
    closeBtn.innerHTML = ICONS.close;

    var bodyText = el('div', 'cg-st-body', '已记录当前工作空间的新席位策略。', card);
    var metaRow = el('div', 'cg-st-meta-row', null, card);

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
        if (destroyed) return;
        var theme = getExplicitTheme(document.documentElement) ||
                    getExplicitTheme(document.body) ||
                    (darkMedia && darkMedia.matches ? 'dark' : 'light');
        toastHost.setAttribute('data-theme', theme);
    }
    updateTheme();
    if (darkMedia) darkMedia.addEventListener('change', updateTheme);

    var themeObserver = new MutationObserver(updateTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    if (document.body) {
        themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    }

    // Auto-hide timing & Pause logic
    function isCardHovered() {
        try {
            return card.matches(':hover');
        } catch (_) {
            return isHovered;
        }
    }

    function isCardFocused() {
        try {
            return card.contains(shadow.activeElement);
        } catch (_) {
            return isFocused;
        }
    }

    function shouldPause() {
        return isCardHovered() || isCardFocused();
    }

    function finishHide() {
        if (hideFallbackTimer) {
            clearTimeout(hideFallbackTimer);
            hideFallbackTimer = null;
        }
        if (!isVisible) {
            card.hidden = true;
            while (metaRow.firstChild) {
                metaRow.removeChild(metaRow.firstChild);
            }
        }
    }

    function hideToast() {
        if (destroyed || !isVisible) return;
        isVisible = false;
        burstCount = 0;
        clearTimeout(hideTimeoutId);
        hideTimeoutId = null;
        card.classList.remove('is-visible');

        var isReducedMotion = Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        if (isReducedMotion) {
            finishHide();
        } else {
            if (hideFallbackTimer) clearTimeout(hideFallbackTimer);
            hideFallbackTimer = setTimeout(finishHide, 220);
        }
    }

    function startAutoHide() {
        if (destroyed || !isVisible || shouldPause()) return;
        clearTimeout(hideTimeoutId);
        hideTimeoutId = setTimeout(function () {
            if (!destroyed && !shouldPause()) {
                hideToast();
            }
        }, HIDE_DELAY);
    }

    function pauseAutoHide() {
        clearTimeout(hideTimeoutId);
        hideTimeoutId = null;
    }

    card.addEventListener('pointerenter', function () {
        isHovered = true;
        pauseAutoHide();
    });
    card.addEventListener('pointerleave', function () {
        isHovered = false;
        if (!shouldPause() && isVisible) {
            startAutoHide();
        }
    });
    card.addEventListener('focusin', function () {
        isFocused = true;
        pauseAutoHide();
    });
    card.addEventListener('focusout', function () {
        Promise.resolve().then(function () {
            if (destroyed) return;
            isFocused = isCardFocused();
            if (!shouldPause() && isVisible) {
                startAutoHide();
            }
        });
    });

    card.addEventListener('transitionend', function (e) {
        if (e.target === card && !isVisible) {
            finishHide();
        }
    });

    closeBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        isHovered = false;
        isFocused = false;
        try { closeBtn.blur(); } catch (_) {}
        hideToast();
    });

    function makeKey(ev) {
        if (!ev || typeof ev !== 'object') return '';
        var pol = ev.policy || {};
        return [
            ev.accountId || '',
            ev.userId || '',
            ev.capturedAt || '',
            pol.vacancyOrdinal != null ? pol.vacancyOrdinal : '',
            pol.freeVacancyThreshold != null ? pol.freeVacancyThreshold : '',
            pol.billingStartsAt || '',
            pol.expiresAt || ''
        ].join('|');
    }

    function show(event) {
        if (destroyed || !event || typeof event !== 'object') return;
        if (event.saved !== true || typeof event.accountId !== 'string' || !event.accountId) return;

        // Verify event matches current account if options.getAccountId / options.currentAccountId is available
        var getAccFn = typeof options.getAccountId === 'function' ? options.getAccountId :
                       typeof options.currentAccountId === 'function' ? options.currentAccountId : null;
        if (getAccFn) {
            try {
                var currentAcc = getAccFn();
                if (typeof currentAcc !== 'string' || !currentAcc || currentAcc !== event.accountId) {
                    return;
                }
            } catch (_) {
                return;
            }
        }

        // Deduplication: defensively deduplicate identical 4-tuples within small bounded memory
        var key = makeKey(event);
        if (key && seenKeys.indexOf(key) >= 0) {
            return;
        }
        if (key) {
            seenKeys.push(key);
            if (seenKeys.length > 50) {
                seenKeys.shift();
            }
        }

        if (hideFallbackTimer) {
            clearTimeout(hideFallbackTimer);
            hideFallbackTimer = null;
        }

        var policy = event.policy || {};

        // Update body content and metadata pills
        bodyText.textContent = '已记录当前工作空间的新席位策略。';

        while (metaRow.firstChild) {
            metaRow.removeChild(metaRow.firstChild);
        }

        if (policy.vacancyOrdinal !== undefined && policy.vacancyOrdinal !== null) {
            var pill1 = el('span', 'cg-st-pill', null, metaRow);
            el('span', 'cg-st-pill-k', 'vacancy_ordinal:', pill1);
            el('span', 'cg-st-pill-v', String(policy.vacancyOrdinal), pill1);
        }
        if (policy.freeVacancyThreshold !== undefined && policy.freeVacancyThreshold !== null) {
            var pill2 = el('span', 'cg-st-pill', null, metaRow);
            el('span', 'cg-st-pill-k', 'free_vacancy_threshold:', pill2);
            el('span', 'cg-st-pill-v', String(policy.freeVacancyThreshold), pill2);
        }

        // Burst handling: if already showing, increment badge
        if (isVisible) {
            burstCount++;
            burstBadge.textContent = '+' + burstCount;
            burstBadge.hidden = false;
        } else {
            burstCount = 0;
            burstBadge.textContent = '';
            burstBadge.hidden = true;
            card.hidden = false;
            // Force reflow for enter transition
            void card.offsetWidth;
            card.classList.add('is-visible');
            isVisible = true;
        }

        if (!shouldPause()) {
            startAutoHide();
        }
    }

    function clear() {
        if (destroyed) return;
        isVisible = false;
        burstCount = 0;
        isHovered = false;
        isFocused = false;
        clearTimeout(hideTimeoutId);
        hideTimeoutId = null;
        if (hideFallbackTimer) {
            clearTimeout(hideFallbackTimer);
            hideFallbackTimer = null;
        }
        card.classList.remove('is-visible');
        card.hidden = true;
        bodyText.textContent = '';
        while (metaRow.firstChild) {
            metaRow.removeChild(metaRow.firstChild);
        }
    }

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        clearTimeout(hideTimeoutId);
        hideTimeoutId = null;
        if (hideFallbackTimer) {
            clearTimeout(hideFallbackTimer);
            hideFallbackTimer = null;
        }
        if (themeObserver) themeObserver.disconnect();
        if (darkMedia) darkMedia.removeEventListener('change', updateTheme);
        toastHost.remove();
    }

    return {
        show: show,
        clear: clear,
        destroy: destroy
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

  /* User-supplied reference rates in USD per 1M tokens, except Astra's confirmed standard rates (2026-09-08). */
  var REFERENCE_RATES = {
    'gpt-5.6-sol': [5, 0.5, 30, 2.5],
    'gpt-5.6-terra': [2, 0.2, 12, 2.5],
    'gpt-5.6-luna': [0.2, 0.02, 1.2, 2.5],
    'gpt-5.5': [5, 0.5, 30, 2.5],
    'gpt-5.4': [2.5, 0.25, 15, 2],
    'gpt-5.4-mini': [0.75, 0.075, 4.5, 2],
    // Official: https://developers.openai.com/api/docs/models/gpt-6-astra (2026-09-08).
    'gpt-6-astra': [10, 1, 50, 2]
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

  function pricingSpeed(name, speed) {
    return name.toLowerCase() === 'gpt-6-astra' && speed === 'priority' ? 'fast' : speed;
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
    speed = key === 'gpt-6-astra' && speed === 'priority' ? 'fast' : speed;
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
    if (pricing.family === 'gpt-6-astra') {
      return '文本：输入=' + metrics.textUncached + '×$10/M，缓存=' + metrics.textCached + '×$1/M，输出=' +
        metrics.textOutput + '×$50/M；GPT-6 Astra 官网标准短上下文费率，快速×2（如适用）；超过 272000 输入的长上下文及 $12.50/M 缓存写入未分列，实际费用可能不同。';
    }
    return '文本：输入=' + metrics.textUncached + '×$' + rate[0] + '/M，缓存=' + metrics.textCached + '×$' +
      rate[1] + '/M，输出=' + metrics.textOutput + '×$' + rate[2] + '/M；' + pricing.family +
      (pricing.multiplier !== 1 ? '，快速×' + pricing.multiplier : '') +
      (pricing.fallback ? '（未知模型回退）' : '') + '；按参考费率估算，非实际账单';
  }

  function tokenModel(raw, notices) {
    var name = safeModelName(raw);
    var speed = pricingSpeed(name, safeSpeed(raw));
    var pricing = priceFor(name, speed);
    var metrics = rawMetrics(raw, pricing.image);
    if (pricing.family === 'gpt-6-astra') {
      addNotice(notices, 'GPT-6 Astra 按官网标准短上下文费率估算；日汇总不能区分长上下文及缓存写入，实际费用可能不同。');
    }
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
    var name = safeModelName(raw);
    return { name: name, speed: pricingSpeed(name, safeSpeed(raw)), turns: turns, threads: threads, credits: credits, users: users };
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
      if (safeModelName(raw).toLowerCase() === 'gpt-6-astra') {
        addNotice(notices, 'GPT-6 Astra 按官网标准短上下文费率估算；日汇总不能区分长上下文及缓存写入，实际费用可能不同。');
      }
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
    if (pricing.family === 'gpt-6-astra') {
      addNotice(notices, 'GPT-6 Astra 按官网标准短上下文费率估算；日汇总不能区分长上下文及缓存写入，实际费用可能不同。');
    }
    if (pricing.fallback) addNotice(notices, '未知文本模型按 gpt-5.5 参考费率显示，非实际账单。');
    if (name.toLowerCase() === 'codex-auto-review') addNotice(notices, 'codex-auto-review 按用户指定映射为 gpt-5.6-luna。');
    return {
      name: name, speed: speed, tokens: uncached + cached + output,
      uncachedInputTokens: uncached, cachedInputTokens: cached, outputTokens: output,
      estimatedUsd: estimate, estimatedAllocation: true, fallbackPricing: pricing.fallback,
      incompleteImage: false,
      calculation: pricing.family === 'gpt-6-astra'
        ? '按积分与参考混合费率分配总令牌；' + calculationFor(metrics, pricing, estimate)
        : '按积分与参考混合费率分配总令牌；按参考费率估算，非实际账单'
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


/**
 * Codex Quota Compass - Original UI Restoration
 * Faithful verbatim restoration of original CodexQuotaCompass visual shell, CSS,
 * layout, icons, sections, tables, graphs, and copy style.
 *
 * Integrated via controller API: mountTeamUsagePanel(options) -> { update(snapshot), destroy() }
 */

function mountTeamUsagePanel(options = {}) {
  const CONFIG = {
    DAY_MS: 24 * 60 * 60 * 1000,
    MAX_RANGE_DAYS: 366,
    TARGET_WINDOW_SECONDS: 7 * 24 * 60 * 60,
    TOKEN_CACHE_FALLBACK_MS: 9 * 60 * 1000,
    USE_UTC_DAY: true,
    EPS: 1e-9,
  };

  const SVG_BANKNOTE = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="20" height="12" x="2" y="6" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/></svg>';
  const GPT_IMAGE_2_PRICING_URL = 'https://platform.openai.com/docs/pricing';

  let destroyed = false;
  let isModalOpen = false;
  let modalGeneration = 0;
  let lastFocusedTrigger = null;
  let currentActiveAccount = null;
  let initialAccountObserved = false;

  let dateInputDirty = false;
  let localStartDate = '';
  let localEndDate = '';

  const activeTimers = new Set();
  const activeAnimFrames = new Set();
  const activeObjectUrls = new Set();

  function safeSetTimeout(fn, ms) {
    if (destroyed) return null;
    const id = setTimeout(() => {
      activeTimers.delete(id);
      if (!destroyed) fn();
    }, ms);
    activeTimers.add(id);
    return id;
  }

  function safeRequestAnimationFrame(fn) {
    if (destroyed) return null;
    const id = requestAnimationFrame(() => {
      activeAnimFrames.delete(id);
      if (!destroyed) fn();
    });
    activeAnimFrames.add(id);
    return id;
  }

  function clearAllAsync() {
    activeTimers.forEach((id) => clearTimeout(id));
    activeTimers.clear();
    activeAnimFrames.forEach((id) => cancelAnimationFrame(id));
    activeAnimFrames.clear();
  }

  // Clean stale modal hosts
  const oldHost = document.getElementById('codex-compass-ultimate-host');
  if (oldHost && oldHost.parentNode) {
    try { oldHost.parentNode.removeChild(oldHost); } catch (_) {}
  }

  const host = document.createElement('div');
  host.id = 'codex-compass-ultimate-host';
  host.style.display = 'none'; // Default closed host in body
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });

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

  const darkMedia = (typeof window !== 'undefined' && typeof window.matchMedia === 'function')
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

  function resolveIsDark() {
    const htmlTheme = explicitTheme(document.documentElement);
    if (htmlTheme !== null) return htmlTheme;
    const bodyTheme = explicitTheme(document.body);
    if (bodyTheme !== null) return bodyTheme;
    return Boolean(darkMedia && darkMedia.matches);
  }

  function syncTheme() {
    if (destroyed) return;
    const isDark = resolveIsDark();
    if (isDark) host.classList.add('dark');
    else host.classList.remove('dark');
  }

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

  const themeObserver = new MutationObserver(() => syncTheme());
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
  if (document.body) {
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme'] });
  }
  syncTheme();

  const showPanelHost = () => {
    syncTheme();
    host.style.display = 'block';
  };
  const hidePanel = () => {
    host.style.display = 'none';
  };
  const createHostAndShadow = () => shadow;
  const panelHost = () => host;
  const toggleButton = () => null;

  // Verbatim 1440-line original CSS
  const css = `
    :host {
      --bg-backdrop: rgba(15, 23, 42, 0.48);
      --bg-modal: #ffffff;
      --bg-header: #ffffff;
      --bg-subtle: #f8fafc;
      --bg-card: #ffffff;
      --bg-card-hover: #f8fafc;
      --bg-input: #ffffff;
      --bg-table-header: #f8fafc;
      --bg-table-row-hover: #f8fafc;
      --bg-table-zebra: #fafbfc;
      --bg-table-footer: #f8fafc;
      --bg-details: #f8fafc;
      --bg-details-card: #ffffff;
      --bg-tag: #f1f5f9;
      --bg-pre: #f8fafc;

      --border: #e2e8f0;
      --border-subtle: #f1f5f9;
      --border-strong: #cbd5e1;
      --border-focus: #10a37f;

      --text-primary: #0f172a;
      --text-secondary: #475569;
      --text-muted: #94a3b8;
      --text-inverse: #ffffff;

      --brand-green: #10a37f;
      --brand-green-hover: #0d8c6d;
      --brand-green-active: #097056;
      --brand-green-subtle: #ecfdf5;
      --brand-green-border: #a7f3d0;
      --brand-green-text: #047857;

      --accent-blue: #2563eb;
      --accent-blue-subtle: #eff6ff;
      --accent-blue-border: #bfdbfe;
      --accent-blue-text: #1d4ed8;

      --accent-purple: #7c3aed;
      --accent-purple-subtle: #f5f3ff;
      --accent-purple-border: #ddd6fe;
      --accent-purple-text: #6d28d9;

      --accent-emerald: #059669;
      --accent-emerald-subtle: #ecfdf5;

      --accent-amber: #d97706;
      --accent-amber-subtle: #fffbeb;
      --accent-amber-border: #fde68a;
      --accent-amber-text: #b45309;

      --accent-red: #dc2626;
      --accent-red-subtle: #fef2f2;
      --accent-red-border: #fecaca;
      --accent-red-text: #991b1b;

      --track-bg: #f1f5f9;
      --scrollbar-thumb: #cbd5e1;
      --scrollbar-thumb-hover: #94a3b8;

      --shadow-modal: 0 25px 50px -12px rgba(0, 0, 0, 0.25), 0 0 0 1px rgba(0, 0, 0, 0.06);
      --shadow-card: 0 1px 3px 0 rgba(0, 0, 0, 0.05), 0 1px 2px -1px rgba(0, 0, 0, 0.05);

      --radius-modal: 16px;
      --radius-card: 12px;
      --radius-btn: 8px;
      --radius-pill: 9999px;

      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: block;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
      font-size: 13px;
      line-height: 1.5;
      color: var(--text-primary);
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    @media (prefers-color-scheme: dark) {
      :host {
        --bg-backdrop: rgba(0, 0, 0, 0.72);
        --bg-modal: #1e1e24;
        --bg-header: #22222a;
        --bg-subtle: #17171c;
        --bg-card: #23232b;
        --bg-card-hover: #2b2b35;
        --bg-input: #17171c;
        --bg-table-header: #1b1b22;
        --bg-table-row-hover: #272732;
        --bg-table-zebra: #202028;
        --bg-table-footer: #1b1b22;
        --bg-details: #18181f;
        --bg-details-card: #23232b;
        --bg-tag: #2a2a34;
        --bg-pre: #141418;

        --border: #33333f;
        --border-subtle: #282832;
        --border-strong: #4a4a58;
        --border-focus: #10a37f;

        --text-primary: #f1f5f9;
        --text-secondary: #cbd5e1;
        --text-muted: #8892a4;
        --text-inverse: #0f172a;

        --brand-green: #10a37f;
        --brand-green-hover: #1ab890;
        --brand-green-active: #0d8c6d;
        --brand-green-subtle: rgba(16, 163, 127, 0.16);
        --brand-green-border: rgba(16, 163, 127, 0.42);
        --brand-green-text: #34d399;

        --accent-blue: #3b82f6;
        --accent-blue-subtle: rgba(59, 130, 246, 0.16);
        --accent-blue-border: rgba(59, 130, 246, 0.42);
        --accent-blue-text: #93c5fd;

        --accent-purple: #a78bfa;
        --accent-purple-subtle: rgba(167, 139, 250, 0.16);
        --accent-purple-border: rgba(167, 139, 250, 0.42);
        --accent-purple-text: #c4b5fd;

        --accent-emerald: #34d399;
        --accent-emerald-subtle: rgba(52, 211, 153, 0.15);

        --accent-amber: #fbbf24;
        --accent-amber-subtle: rgba(251, 191, 36, 0.16);
        --accent-amber-border: rgba(251, 191, 36, 0.42);
        --accent-amber-text: #fde68a;

        --accent-red: #f87171;
        --accent-red-subtle: rgba(248, 113, 113, 0.16);
        --accent-red-border: rgba(248, 113, 113, 0.42);
        --accent-red-text: #fca5a5;

        --track-bg: #141418;
        --scrollbar-thumb: #3e3e4e;
        --scrollbar-thumb-hover: #58586c;

        --shadow-modal: 0 25px 50px -12px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.08);
        --shadow-card: 0 1px 3px 0 rgba(0, 0, 0, 0.35), 0 1px 2px -1px rgba(0, 0, 0, 0.25);
      }
    }

    * { box-sizing: border-box; }

    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: var(--bg-backdrop);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: max(14px, env(safe-area-inset-top, 14px)) max(14px, env(safe-area-inset-right, 14px)) max(14px, env(safe-area-inset-bottom, 14px)) max(14px, env(safe-area-inset-left, 14px));
      animation: backdropFadeIn 0.2s ease-out;
      overflow: hidden;
    }
    @keyframes backdropFadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .modal-card {
      display: flex;
      flex-direction: column;
      width: clamp(320px, 94vw, 1560px);
      max-width: 95vw;
      max-height: 88vh;
      max-height: min(88vh, 88dvh);
      background: var(--bg-modal);
      border: 1px solid var(--border);
      border-radius: var(--radius-modal);
      box-shadow: var(--shadow-modal);
      overflow: hidden;
      animation: modalSlideUp 0.22s cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes modalSlideUp {
      from { opacity: 0; transform: translateY(14px) scale(0.985); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 22px;
      background: var(--bg-header);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    .header-left {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
      min-width: 0;
    }
    .header-title {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      min-width: 0;
      font-size: 16px;
      font-weight: 700;
      letter-spacing: -0.01em;
      color: var(--text-primary);
    }
    .header-icon { font-size: 18px; line-height: 1; }
    .title-text { font-size: 16px; font-weight: 700; color: var(--text-primary); }

    .header-delay-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 9px;
      border-radius: var(--radius-pill);
      font-size: 11px;
      font-weight: 600;
      background: var(--accent-amber-subtle);
      color: var(--accent-amber-text);
      border: 1px solid var(--accent-amber-border);
      line-height: 1.3;
      white-space: nowrap;
    }
    .delay-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--accent-amber);
      flex-shrink: 0;
    }

    .version, .mode-badge, .model-pill, .speed-pill, .estimate-pill, .client-label {
      display: inline-flex;
      align-items: center;
      border-radius: var(--radius-pill);
      font-size: 11px;
      font-weight: 600;
      white-space: nowrap;
      line-height: 1.2;
    }
    .version {
      padding: 2px 7px;
      color: var(--text-secondary);
      background: var(--bg-tag);
      border: 1px solid var(--border);
    }
    .mode-badge {
      padding: 2px 8px;
      color: var(--accent-blue-text);
      background: var(--accent-blue-subtle);
      border: 1px solid var(--accent-blue-border);
    }
    .mode-badge.personal {
      color: var(--brand-green-text);
      background: var(--brand-green-subtle);
      border-color: var(--brand-green-border);
    }

    .view-switch {
      display: inline-flex;
      padding: 3px;
      background: var(--bg-tag);
      border: 1px solid var(--border);
      border-radius: 8px;
      gap: 3px;
    }
    .view-switch-btn {
      min-height: 28px;
      padding: 0 12px;
      color: var(--text-secondary);
      background: transparent;
      border: 0;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s ease;
    }
    .view-switch-btn:hover:not(:disabled) {
      color: var(--text-primary);
    }
    .view-switch-btn.active {
      color: var(--brand-green-text);
      background: var(--bg-modal);
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
    }
    .view-switch-btn:disabled {
      color: var(--text-muted);
      cursor: not-allowed;
    }

    .close-btn {
      width: 36px;
      height: 36px;
      min-width: 36px;
      min-height: 36px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      color: var(--text-secondary);
      background: transparent;
      border: 0;
      border-radius: 8px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 600;
      transition: background 0.15s ease, color 0.15s ease;
    }
    .close-btn:hover {
      color: var(--text-primary);
      background: var(--bg-card-hover);
    }
    .close-btn:active {
      transform: scale(0.96);
    }

    .range-bar {
      padding: 14px 22px;
      background: var(--bg-subtle);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    .date-fields {
      display: grid;
      grid-template-columns: 1fr 1fr auto;
      gap: 12px;
      align-items: end;
    }
    .field-group { min-width: 0; }
    .field-group label {
      display: block;
      margin-bottom: 4px;
      color: var(--text-secondary);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.02em;
    }
    input[type='date'] {
      display: block;
      width: 100%;
      height: 38px;
      min-height: 38px;
      padding: 0 10px;
      color: var(--text-primary);
      background: var(--bg-input);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-btn);
      font-family: inherit;
      font-size: 12px;
      outline: none;
      color-scheme: light;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }
    @media (prefers-color-scheme: dark) {
      input[type='date'] {
        color-scheme: dark;
      }
    }
    input[type='date']:focus {
      border-color: var(--brand-green);
      box-shadow: 0 0 0 3px var(--brand-green-subtle);
    }

    button { font-family: inherit; }
    .primary-btn {
      height: 38px;
      min-height: 38px;
      padding: 0 20px;
      color: #ffffff;
      background: var(--brand-green);
      border: 1px solid var(--brand-green);
      border-radius: var(--radius-btn);
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: all 0.15s ease;
      white-space: nowrap;
    }
    .primary-btn:hover {
      background: var(--brand-green-hover);
      border-color: var(--brand-green-hover);
      box-shadow: 0 2px 8px rgba(16, 163, 127, 0.25);
    }
    .primary-btn:active {
      transform: scale(0.97);
      background: var(--brand-green-active);
    }
    .primary-btn:disabled, .mini-btn:disabled, .footer-btn:disabled {
      opacity: 0.55;
      cursor: not-allowed;
      transform: none;
      box-shadow: none;
    }

    .presets-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 10px;
    }
    .presets {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .preset-label {
      color: var(--text-muted);
      font-size: 11px;
      font-weight: 500;
    }
    .mini-btn {
      height: 28px;
      min-height: 28px;
      padding: 0 10px;
      color: var(--text-secondary);
      background: var(--bg-card);
      border: 1px solid var(--border-strong);
      border-radius: 6px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s ease;
    }
    .mini-btn:hover {
      color: var(--text-primary);
      background: var(--bg-card-hover);
      border-color: var(--text-muted);
    }
    .mini-btn:active {
      transform: scale(0.96);
    }
    .cycle-hint {
      color: var(--text-muted);
      font-size: 11px;
    }

    .panel-body {
      flex: 1;
      min-height: 0;
      padding: clamp(14px, 2vw, 22px);
      overflow-y: auto;
      background: var(--bg-modal);
      position: relative;
    }
    .panel-body::-webkit-scrollbar, .table-box::-webkit-scrollbar, pre::-webkit-scrollbar {
      width: 6px;
      height: 6px;
    }
    .panel-body::-webkit-scrollbar-track, .table-box::-webkit-scrollbar-track, pre::-webkit-scrollbar-track {
      background: transparent;
    }
    .panel-body::-webkit-scrollbar-thumb, .table-box::-webkit-scrollbar-thumb, pre::-webkit-scrollbar-thumb {
      background: var(--scrollbar-thumb);
      border-radius: var(--radius-pill);
    }
    .panel-body::-webkit-scrollbar-thumb:hover, .table-box::-webkit-scrollbar-thumb:hover, pre::-webkit-scrollbar-thumb:hover {
      background: var(--scrollbar-thumb-hover);
    }

    /* Two-Column Continuous Stream Layout (Academic Paper Style) */
    .two-column-layout {
      display: flex;
      flex-direction: column;
      gap: 16px;
      width: 100%;
      min-width: 0;
    }

    .column-left,
    .column-right {
      display: flex;
      flex-direction: column;
      gap: 16px;
      min-width: 0;
      width: 100%;
    }

    .kpi-grid-left {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      min-width: 0;
    }

    .kpi-grid-right {
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-width: 0;
    }

    .kpi-grid-right > .summary-card {
      height: 100%;
    }

    .notice-wrap {
      width: 100%;
      min-width: 0;
    }

    .quota-card, .summary-card, .section {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-card);
      box-shadow: var(--shadow-card);
    }
    .quota-card {
      padding: 16px 18px;
      margin: 0;
    }
    .card-top, .section-title-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .eyebrow-wrap {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .quota-icon { font-size: 14px; line-height: 1; }
    .eyebrow {
      color: var(--text-secondary);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .quota-name {
      color: var(--text-muted);
      font-size: 11px;
      font-weight: 500;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .progress-track {
      height: 10px;
      margin: 11px 0 9px;
      overflow: hidden;
      background: var(--track-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius-pill);
    }
    .progress-fill {
      height: 100%;
      border-radius: inherit;
      transition: width 0.4s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .progress-fill.ok { background: linear-gradient(90deg, #10b981, #34d399); }
    .progress-fill.warn { background: linear-gradient(90deg, #f59e0b, #fbbf24); }
    .progress-fill.danger { background: linear-gradient(90deg, #ef4444, #f87171); }
    .quota-stats {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
      color: var(--text-secondary);
      font-size: 12px;
    }
    .quota-stat-item strong {
      color: var(--text-primary);
    }
    .quota-stat-divider {
      color: var(--border-strong);
    }

    /* Redesigned Prominent Quota Estimate Cards */
    .quota-estimate-cards {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      margin: 12px 0 10px;
    }
    .quota-estimate-card {
      padding: 12px 14px;
      background: var(--bg-subtle);
      border: 1px solid var(--border);
      border-radius: var(--radius-btn);
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .estimate-card-label {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-secondary);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 4px;
    }
    .estimate-tag {
      font-size: 9px;
      font-weight: 700;
      padding: 1px 5px;
      border-radius: 3px;
      background: var(--brand-green-subtle);
      color: var(--brand-green-text);
      border: 1px solid var(--brand-green-border);
    }
    .estimate-card-value {
      font-size: 20px;
      font-weight: 800;
      color: var(--text-primary);
      margin: 4px 0 2px;
      font-variant-numeric: tabular-nums;
      letter-spacing: -0.02em;
    }
    .quota-estimate-card.remaining .estimate-card-value {
      color: var(--accent-emerald);
    }
    .estimate-card-hint {
      font-size: 10px;
      color: var(--text-muted);
      line-height: 1.3;
    }
    .quota-estimate-unavailable {
      display: flex;
      align-items: flex-start;
      gap: 6px;
      padding: 10px 12px;
      background: var(--bg-subtle);
      border: 1px solid var(--border);
      border-radius: 6px;
      font-size: 11px;
      color: var(--text-muted);
      margin: 10px 0 8px;
      line-height: 1.45;
    }
    .quota-notice-box {
      display: flex;
      align-items: flex-start;
      gap: 6px;
      padding: 8px 12px;
      background: var(--accent-blue-subtle);
      border: 1px solid var(--accent-blue-border);
      border-radius: 6px;
      font-size: 11px;
      color: var(--accent-blue-text);
      line-height: 1.45;
      margin-top: 10px;
    }
    .quota-notice-icon {
      font-size: 13px;
      line-height: 1.2;
      flex-shrink: 0;
    }

    .summary-card {
      min-width: 0;
      min-height: 110px;
      padding: 14px 16px;
      margin: 0;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }
    .summary-card:hover {
      border-color: var(--border-strong);
      box-shadow: 0 4px 8px -1px rgba(0, 0, 0, 0.08);
    }
    .card-header-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .card-label {
      color: var(--text-secondary);
      font-size: 11px;
      font-weight: 600;
    }
    .card-badge {
      font-size: 10px;
      font-weight: 600;
      padding: 1px 6px;
      border-radius: 4px;
    }
    .card-badge.tokens { background: var(--accent-purple-subtle); color: var(--accent-purple-text); }
    .card-badge.cost { background: var(--brand-green-subtle); color: var(--brand-green-text); }
    .card-badge.activity { background: var(--accent-blue-subtle); color: var(--accent-blue-text); }

    .card-value {
      margin: 6px 0 4px;
      overflow: hidden;
      color: var(--text-primary);
      font-size: clamp(20px, 2.2vw, 24px);
      font-weight: 750;
      letter-spacing: -0.02em;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }
    .cost-value { color: var(--accent-emerald); }
    .card-unit { font-size: 13px; font-weight: 500; color: var(--text-secondary); margin-left: 2px; }
    .card-sub {
      color: var(--text-secondary);
      font-size: 11px;
      line-height: 1.5;
    }
    .sub-dot {
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      margin-right: 4px;
      vertical-align: middle;
    }
    .sub-dot.uncached { background: var(--text-muted); }
    .sub-dot.cached { background: var(--accent-blue); }

    .mini-bars {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-top: 6px;
    }
    .mini-bar-item {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .mini-bar-name {
      width: 64px;
      font-size: 10px;
      color: var(--text-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .mini-bar {
      flex: 1;
      height: 5px;
      overflow: hidden;
      background: var(--track-bg);
      border-radius: var(--radius-pill);
    }
    .mini-bar span {
      display: block;
      height: 100%;
      border-radius: inherit;
      background: var(--accent-purple);
    }

    .section {
      margin: 0;
      padding: 16px 18px;
    }
    .section-title-row { margin-bottom: 12px; }
    .section-title {
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--text-primary);
      font-size: 13px;
      font-weight: 700;
    }
    .section-icon { font-size: 14px; line-height: 1; }
    .section-note {
      color: var(--text-muted);
      font-size: 11px;
      text-align: right;
    }
    .section-footnote {
      color: var(--text-muted);
      font-size: 11px;
      margin-top: 8px;
      line-height: 1.4;
    }

    .table-box {
      overflow-x: auto;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg-card);
      -webkit-overflow-scrolling: touch;
    }
    table {
      width: 100%;
      min-width: 540px;
      border-collapse: collapse;
      color: var(--text-primary);
      font-size: 12px;
      text-align: left;
    }
    th {
      position: sticky;
      top: 0;
      z-index: 1;
      padding: 10px 12px;
      color: var(--text-secondary);
      background: var(--bg-table-header);
      border-bottom: 1px solid var(--border);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.02em;
      white-space: nowrap;
    }
    th.num-th { text-align: right; }
    td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--border-subtle);
      vertical-align: middle;
      white-space: nowrap;
      color: var(--text-primary);
    }
    tbody tr:last-child td { border-bottom: none; }
    tbody tr:hover { background: var(--bg-table-row-hover); }
    tfoot tr {
      background: var(--bg-table-footer);
      border-top: 2px solid var(--border);
    }
    tfoot td {
      padding: 10px 12px;
      font-weight: 600;
      color: var(--text-primary);
    }
    .num {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-variant-numeric: tabular-nums;
      font-size: 12px;
      text-align: right;
    }
    .money {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-variant-numeric: tabular-nums;
      color: var(--accent-emerald);
      font-weight: 600;
      text-align: right;
    }

    .model-cell {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .model-color-indicator {
      width: 3px;
      height: 16px;
      border-radius: 2px;
      flex-shrink: 0;
    }
    .model-pill {
      max-width: 150px;
      padding: 2px 7px;
      overflow: hidden;
      color: var(--accent-purple-text);
      background: var(--accent-purple-subtle);
      border: 1px solid var(--accent-purple-border);
      text-overflow: ellipsis;
      vertical-align: middle;
    }
    .speed-pill {
      padding: 1px 5px;
      color: var(--accent-amber-text);
      background: var(--accent-amber-subtle);
      border: 1px solid var(--accent-amber-border);
      font-size: 10px;
    }
    .estimate-pill {
      padding: 1px 5px;
      color: var(--accent-blue-text);
      background: var(--accent-blue-subtle);
      border: 1px solid var(--accent-blue-border);
      font-size: 10px;
    }
    .fallback { color: var(--accent-amber); }
    .client-label {
      padding: 2px 8px;
      color: var(--text-secondary);
      background: var(--bg-tag);
      border: 1px solid var(--border-strong);
    }
    .user-name {
      display: block;
      max-width: 180px;
      overflow: hidden;
      text-overflow: ellipsis;
      font-weight: 500;
      color: var(--text-primary);
    }
    .user-email {
      display: block;
      max-width: 180px;
      overflow: hidden;
      color: var(--text-muted);
      font-size: 11px;
      text-overflow: ellipsis;
      margin-top: 1px;
    }

    .date-cell {
      display: flex;
      align-items: center;
      gap: 6px;
      font-weight: 500;
    }
    .expand-icon {
      display: inline-block;
      font-size: 9px;
      color: var(--text-muted);
      transition: transform 0.15s ease;
      line-height: 1;
    }
    .daily-row { cursor: pointer; user-select: none; }
    .daily-row.is-open {
      background: var(--bg-table-row-hover);
      font-weight: 500;
    }
    .daily-row.is-open .expand-icon {
      color: var(--brand-green);
    }
    .details-row td {
      padding: 0;
      white-space: normal;
      background: var(--bg-details);
    }
    .day-details {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
      gap: 8px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
    }
    .day-model {
      min-width: 0;
      padding: 8px 10px;
      border: 1px solid var(--border);
      border-left: 3px solid var(--accent-purple);
      background: var(--bg-details-card);
      border-radius: 6px;
      font-size: 11px;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
    }
    .day-model-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 3px;
    }
    .day-model-header strong {
      font-size: 12px;
      color: var(--text-primary);
    }
    .speed-tag {
      font-size: 10px;
      color: var(--text-muted);
      background: var(--bg-tag);
      padding: 1px 4px;
      border-radius: 3px;
    }
    .day-model-body {
      display: flex;
      align-items: center;
      justify-content: space-between;
      color: var(--text-secondary);
    }

    .notice {
      margin: 0;
      padding: 12px 14px;
      border: 1px solid var(--accent-blue-border);
      border-radius: 8px;
      color: var(--accent-blue-text);
      background: var(--accent-blue-subtle);
      font-size: 12px;
      line-height: 1.5;
    }
    .error-banner {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      margin-bottom: 14px;
      padding: 12px 16px;
      color: var(--accent-red-text);
      background: var(--accent-red-subtle);
      border: 1px solid var(--accent-red-border);
      border-radius: 8px;
      font-size: 12px;
      line-height: 1.5;
    }
    .error-icon {
      font-size: 16px;
      line-height: 1.2;
      flex-shrink: 0;
    }
    .error-body {
      flex: 1;
      min-width: 0;
    }
    .error-title {
      font-weight: 700;
      margin-bottom: 2px;
    }
    .error-text {
      word-break: break-word;
      white-space: pre-wrap;
    }
    .empty {
      padding: 24px 16px;
      color: var(--text-muted);
      font-size: 12px;
      text-align: center;
      line-height: 1.5;
    }
    .empty-state {
      padding: 48px 24px;
      text-align: center;
    }
    .empty-icon {
      font-size: 38px;
      margin-bottom: 12px;
      opacity: 0.65;
    }
    .empty-title {
      font-size: 15px;
      font-weight: 700;
      color: var(--text-primary);
      margin-bottom: 6px;
    }
    .empty-desc {
      font-size: 12px;
      color: var(--text-muted);
      max-width: 320px;
      margin: 0 auto;
      line-height: 1.5;
    }

    .loading-wrap {
      display: flex;
      flex-direction: column;
      gap: 14px;
      padding: 4px 0 10px;
    }
    .skeleton-layout {
      width: 100%;
    }
    .skeleton {
      background: linear-gradient(90deg, #f1f5f9 25%, #e2e8f0 37%, #f1f5f9 63%);
      background-size: 400% 100%;
      animation: skeletonShimmer 1.4s ease infinite;
      border-radius: var(--radius-card);
      border: 1px solid var(--border);
    }
    @media (prefers-color-scheme: dark) {
      .skeleton {
        background: linear-gradient(90deg, #23232b 25%, #2d2d38 37%, #23232b 63%);
        background-size: 400% 100%;
        border-color: var(--border);
      }
    }
    @keyframes skeletonShimmer {
      0% { background-position: 100% 50%; }
      100% { background-position: 0 50%; }
    }
    .card-sk { height: 110px; min-height: 110px; }
    .quota-sk { height: 125px; min-height: 125px; }
    .table-sk-sm { height: 175px; min-height: 175px; }
    .table-sk-lg { height: 250px; min-height: 250px; }

    .loading-text {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      color: var(--text-secondary);
      font-size: 12px;
      margin-top: 4px;
    }

    .content-loading-overlay {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      z-index: 10;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding-top: 12px;
      pointer-events: none;
      background: transparent;
    }
    .content-loading-overlay[hidden] {
      display: none !important;
    }
    .loading-progress-line {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 2.5px;
      background: linear-gradient(90deg, transparent, var(--brand-green), transparent);
      background-size: 200% 100%;
      animation: progressSlide 1.2s infinite linear;
    }
    @keyframes progressSlide {
      0% { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }
    .content-loading-status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 14px;
      border: 1px solid var(--brand-green-border);
      border-radius: var(--radius-pill);
      background: var(--bg-card);
      color: var(--brand-green-text);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
      font-size: 12px;
      font-weight: 600;
      animation: statusFadeIn 0.2s ease-out;
    }
    @keyframes statusFadeIn {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .spinner {
      width: 14px;
      height: 14px;
      border: 2px solid var(--brand-green-border);
      border-top-color: var(--brand-green);
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }
    .btn-spinner {
      display: inline-block;
      width: 12px;
      height: 12px;
      border: 2px solid rgba(255, 255, 255, 0.4);
      border-top-color: #ffffff;
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
      vertical-align: middle;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .footer {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-top: 18px;
      padding-top: 14px;
      border-top: 1px solid var(--border);
    }
    .export-group {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .footer-btn {
      height: 36px;
      min-height: 36px;
      padding: 0 14px;
      background: var(--bg-card);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-btn);
      color: var(--text-secondary);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      transition: all 0.15s ease;
    }
    .footer-btn:hover {
      color: var(--text-primary);
      background: var(--bg-card-hover);
      border-color: var(--text-muted);
    }
    .footer-btn:active {
      transform: scale(0.97);
    }
    .footer-btn.refresh {
      background: var(--brand-green);
      color: #ffffff;
      border-color: var(--brand-green);
      font-weight: 600;
    }
    .footer-btn.refresh:hover {
      background: var(--brand-green-hover);
      border-color: var(--brand-green-hover);
    }

    .raw-json {
      width: 100%;
      margin-top: 6px;
      color: var(--text-muted);
      font-size: 11px;
    }
    .raw-json summary {
      color: var(--text-secondary);
      cursor: pointer;
      font-weight: 500;
      user-select: none;
    }
    pre {
      max-height: 250px;
      margin: 8px 0 0;
      padding: 10px 12px;
      overflow: auto;
      color: var(--text-secondary);
      background: var(--bg-pre);
      border: 1px solid var(--border);
      border-radius: 8px;
      font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      white-space: pre;
    }

    button:focus-visible,
    input:focus-visible,
    summary:focus-visible {
      outline: 2px solid var(--brand-green);
      outline-offset: 2px;
    }

    @media (prefers-reduced-motion: reduce) {
      *,
      ::before,
      ::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
        scroll-behavior: auto !important;
      }
    }

    /* Breakpoint: Wide Screens (>= 1100px) - Academic Paper Continuous Two-Column Layout */
    @media (min-width: 1100px) {
      .two-column-layout {
        display: grid;
        grid-template-columns: minmax(0, 1.02fr) minmax(0, 0.98fr);
        gap: 20px;
        align-items: start;
      }
      .column-left {
        border-right: 1px solid var(--border-subtle);
        padding-right: 20px;
      }
      .range-bar {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: 16px;
        flex-wrap: wrap;
      }
      .date-fields {
        display: flex;
        align-items: flex-end;
        gap: 10px;
        flex: 1 1 auto;
      }
      .field-group {
        width: 165px;
      }
      .presets-row {
        margin-top: 0;
        gap: 12px;
        flex: 0 0 auto;
      }
    }

    /* Breakpoint 1: Medium Screens (<= 900px) */
    @media (max-width: 900px) {
      .range-bar {
        padding: 12px 18px;
      }
      .panel-body {
        padding: 16px 18px;
      }
    }

    /* Breakpoint 2: Small Screens / Mobile (<= 640px) */
    @media (max-width: 640px) {
      .modal-backdrop {
        padding: max(8px, env(safe-area-inset-top, 8px)) max(8px, env(safe-area-inset-right, 8px)) max(8px, env(safe-area-inset-bottom, 8px)) max(8px, env(safe-area-inset-left, 8px));
      }
      .modal-card {
        width: 100%;
        max-height: 94vh;
        max-height: min(94vh, 94dvh);
        border-radius: 12px;
      }
      .header {
        padding: 12px 14px;
        gap: 8px;
      }
      .header-title {
        font-size: 15px;
      }
      .title-text {
        font-size: 15px;
      }
      .header-delay-pill {
        font-size: 10px;
        padding: 2px 7px;
      }
      .range-bar {
        padding: 12px 14px;
      }
      .date-fields {
        grid-template-columns: 1fr;
        gap: 8px;
      }
      .primary-btn {
        width: 100%;
        min-height: 42px;
        font-size: 14px;
      }
      .presets-row {
        flex-direction: column;
        align-items: stretch;
        gap: 8px;
      }
      .presets {
        flex-wrap: wrap;
        justify-content: flex-start;
      }
      .mini-btn {
        min-height: 36px;
        padding: 0 12px;
        font-size: 12px;
      }
      .view-switch {
        width: 100%;
        display: flex;
      }
      .view-switch-btn {
        flex: 1;
        min-height: 36px;
        font-size: 12px;
      }
      .kpi-grid-left,
      .quota-estimate-cards {
        grid-template-columns: 1fr;
        gap: 10px;
      }
      .summary-card {
        min-height: auto;
        padding: 14px;
      }
      .panel-body {
        padding: 14px;
      }
      .section {
        padding: 14px;
      }
      .footer {
        flex-direction: column;
        align-items: stretch;
        gap: 10px;
      }
      .export-group {
        width: 100%;
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      .export-group .footer-btn {
        width: 100%;
        min-height: 40px;
      }
      .footer-btn.refresh {
        width: 100%;
        min-height: 42px;
        font-size: 13px;
      }
    }

    /* Breakpoint 3: Extra Narrow Screens (<= 420px) */
    @media (max-width: 420px) {
      .modal-backdrop {
        padding: 4px;
      }
      .modal-card {
        max-height: 98vh;
        max-height: min(98vh, 98dvh);
        border-radius: 10px;
      }
      .header {
        padding: 10px 12px;
      }
      .title-text {
        font-size: 14px;
      }
      .range-bar {
        padding: 10px 12px;
      }
      .panel-body {
        padding: 12px 10px 18px;
      }
      .section {
        padding: 12px 10px;
      }
      th, td {
        padding: 8px 9px;
        font-size: 11px;
      }
      .model-pill {
        max-width: 110px;
        font-size: 10px;
      }
      .card-value,
      .estimate-card-value {
        font-size: 19px;
      }
      .day-details {
        grid-template-columns: 1fr;
        padding: 8px 10px;
      }
    }
  `;


  const HTML_ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPE[ch]);
  const asArray = (value) => (Array.isArray(value) ? value : []);
  const hasOwn = (obj, key) => Boolean(obj && Object.prototype.hasOwnProperty.call(obj, key));
  const n = (value) => {
    if (typeof value === 'string') value = value.replace(/,/g, '').trim();
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, n(value)));
  const trimFixed = (value, digits = 2) => n(value).toFixed(digits).replace(/\.?0+$/, '');
  const pad2 = (value) => String(value).padStart(2, '0');

  const isUnavailable = (value) => {
    if (value === null || value === undefined || value === '') return true;
    if (typeof value === 'boolean') return true;
    if (typeof value === 'string') {
      const cleaned = value.replace(/,/g, '').trim();
      if (!cleaned) return true;
      return !Number.isFinite(Number(cleaned));
    }
    return !Number.isFinite(Number(value));
  };

  const fmtNum = (value) => {
    if (isUnavailable(value)) return '—';
    const number = typeof value === 'string' ? Number(value.replace(/,/g, '').trim()) : Number(value);
    const absolute = Math.abs(number);
    const sign = number < 0 ? '-' : '';
    if (absolute >= 1e12) return `${sign}${trimFixed(absolute / 1e12)}T`;
    if (absolute >= 1e9) return `${sign}${trimFixed(absolute / 1e9)}B`;
    if (absolute >= 1e6) return `${sign}${trimFixed(absolute / 1e6)}M`;
    if (absolute >= 1e3) return `${sign}${trimFixed(absolute / 1e3)}K`;
    return number.toLocaleString('en-US');
  };

  const fmtFullNum = (value) => {
    if (isUnavailable(value)) return '—';
    const number = typeof value === 'string' ? Number(value.replace(/,/g, '').trim()) : Number(value);
    return number.toLocaleString('en-US');
  };

  const fmtUsd = (value) => {
    if (isUnavailable(value)) return '—';
    const number = typeof value === 'string' ? Number(value.replace(/,/g, '').trim()) : Number(value);
    return `$${number.toFixed(2)}`;
  };

  const fmtTurns = (value) => {
    if (isUnavailable(value)) return '—';
    const number = typeof value === 'string' ? Number(value.replace(/,/g, '').trim()) : Number(value);
    return Math.abs(number - Math.round(number)) < 1e-9
      ? String(Math.round(number))
      : number.toFixed(1);
  };

  const hasNumericField = (obj, key) =>
    hasOwn(obj, key) && obj[key] !== null && obj[key] !== undefined && typeof obj[key] !== 'boolean' && Number.isFinite(Number(obj[key]));

  const formatPercentFromRatio = (ratio) => {
    const percent = clamp(ratio) * 100;
    return `${percent >= 10 ? percent.toFixed(1) : percent.toFixed(2)}%`;
  };

  const formatDuration = (seconds) => {
    const days = n(seconds) / 86400;
    if (!days) return '当前配额周期';
    return days >= 1 ? `${trimFixed(days, 1)} 天周期` : `${trimFixed(n(seconds) / 3600, 1)} 小时周期`;
  };

  const toEpochMs = (value) => {
    if (typeof value === 'string') {
      const numeric = Number(value.trim());
      if (Number.isFinite(numeric) && numeric > 0) return numeric > 1e12 ? numeric : numeric * 1000;
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : NaN;
    }
    const numeric = n(value);
    return numeric ? (numeric > 1e12 ? numeric : numeric * 1000) : NaN;
  };

  const formatDateTime = (ms) => {
    const date = new Date(ms);
    if (!Number.isFinite(date.getTime())) return '—';
    return date.toLocaleString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  };

  const dateKeyFromMs = (ms) => {
    const date = new Date(ms);
    if (!Number.isFinite(date.getTime())) return '';
    if (CONFIG.USE_UTC_DAY) return date.toISOString().slice(0, 10);
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  };

  const dayStartMs = (dateKey) => {
    const [year, month, day] = String(dateKey || '').slice(0, 10).split('-').map(Number);
    if (!year || !month || !day) return NaN;
    return CONFIG.USE_UTC_DAY ? Date.UTC(year, month - 1, day) : new Date(year, month - 1, day).getTime();
  };

  const addDays = (dateKey, days) => {
    const ms = dayStartMs(dateKey);
    return Number.isFinite(ms) ? dateKeyFromMs(ms + days * CONFIG.DAY_MS) : '';
  };

  const validateRange = (startDate, endDate) => {
    if (!startDate || !endDate) throw new Error('请同时选择开始日期和结束日期。');
    const startMs = dayStartMs(startDate);
    const endMs = dayStartMs(endDate);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) throw new Error('日期格式无效。');
    if (startMs > endMs) throw new Error('开始日期不能晚于结束日期。');
    if (Math.floor((endMs - startMs) / CONFIG.DAY_MS) + 1 > CONFIG.MAX_RANGE_DAYS) {
      throw new Error(`单次查询范围不能超过 ${CONFIG.MAX_RANGE_DAYS} 天。`);
    }
  };

  const usedRatioFromWindow = (window) => {
    if (!window || window.available === false) return 0;
    for (const key of ['used_ratio', 'usedRatio', 'fraction_used']) {
      if (hasOwn(window, key) && window[key] !== null && window[key] !== undefined && typeof window[key] !== 'boolean' && Number.isFinite(Number(window[key]))) {
        return clamp(Number(window[key]));
      }
    }
    for (const key of ['used_percent', 'usedPercent']) {
      if (hasOwn(window, key) && window[key] !== null && window[key] !== undefined && typeof window[key] !== 'boolean' && Number.isFinite(Number(window[key]))) {
        return clamp(Number(window[key]) / 100);
      }
    }
    const limit = window.limit ?? window.credit_limit ?? window.credits_limit ?? window.max;
    const used = window.used ?? window.used_credits ?? window.consumed ?? window.consumed_credits;
    const remaining = window.remaining ?? window.remaining_credits;
    if (limit && Number.isFinite(Number(limit)) && Number(limit) > 0) {
      if (used !== null && used !== undefined && typeof used !== 'boolean' && Number.isFinite(Number(used))) {
        return clamp(Number(used) / Number(limit));
      }
      if (remaining !== null && remaining !== undefined && typeof remaining !== 'boolean' && Number.isFinite(Number(remaining))) {
        return clamp((Number(limit) - Number(remaining)) / Number(limit));
      }
    }
    return 0;
  };

  const usedPercentTextFromWindow = (window) => {
    if (!window || window.available === false) return '未知';
    for (const key of ['used_percent', 'usedPercent']) {
      if (hasOwn(window, key) && window[key] !== null && window[key] !== undefined && typeof window[key] !== 'boolean' && Number.isFinite(Number(window[key]))) {
        return `${trimFixed(Number(window[key]))}%`;
      }
    }
    const hasRatio = ['used_ratio', 'usedRatio', 'fraction_used'].some((k) => hasOwn(window, k) && window[k] !== null && window[k] !== undefined && typeof window[k] !== 'boolean' && Number.isFinite(Number(window[k])));
    if (hasRatio) {
      const ratio = usedRatioFromWindow(window);
      return formatPercentFromRatio(ratio);
    }
    return '未知';
  };

  const quotaValue = (window, keys) => {
    for (const key of keys) {
      if (window && Object.prototype.hasOwnProperty.call(window, key) && window[key] !== null && window[key] !== undefined) {
        if (typeof window[key] === 'boolean') continue;
        return window[key];
      }
    }
    return null;
  };

  const getWindowDurationSeconds = (window) => {
    if (!window) return 0;
    for (const key of ['limit_window_seconds', 'window_seconds', 'duration_seconds']) {
      if (hasOwn(window, key) && window[key] !== null && window[key] !== undefined && typeof window[key] !== 'boolean' && Number.isFinite(Number(window[key])) && Number(window[key]) > 0) {
        return Number(window[key]);
      }
    }
    return 0;
  };

  const personalCycleCostEstimate = () => null;
  const isCodexAutoReviewModel = (name) => String(name || '').trim().toLowerCase() === 'codex-auto-review';
  const isImageModel = (name) => { const m = String(name || '').trim().toLowerCase(); return m === 'gpt-image-2' || m === 'image2'; };
  const getModelDisplayName = (item = {}) => String(item.model || item.model_id || item.model_name || item.name || item.id || 'unknown').trim();
  const normalizeSpeed = (value, fallback = 'standard') => String(value || fallback).trim().toLowerCase();
  const estimateModelUsd = (row = {}) => row?.estimatedUsd !== undefined ? row.estimatedUsd : null;
  const formatModelCostCalculation = (row = {}) => {
    if (row && typeof row.calculation === 'string' && row.calculation.trim()) {
      return row.calculation;
    }
    return row?.estimatedUsd !== null && row?.estimatedUsd !== undefined ? `预估: ${fmtUsd(row.estimatedUsd)}` : '';
  };

  const tokenTotal = (obj = {}) => {
    if (!obj || typeof obj !== 'object') return null;
    if (hasOwn(obj, 'tokens')) {
      if (obj.tokens === null || obj.tokens === undefined) return null;
      const parsed = Number(obj.tokens);
      return Number.isFinite(parsed) ? parsed : null;
    }
    if (hasOwn(obj, 'text_total_tokens')) {
      if (obj.text_total_tokens === null || obj.text_total_tokens === undefined) return null;
      const parsed = Number(obj.text_total_tokens);
      return Number.isFinite(parsed) ? parsed : null;
    }
    const uncached = obj.uncachedInputTokens ?? obj.uncached_text_input_tokens;
    const cached = obj.cachedInputTokens ?? obj.cached_text_input_tokens;
    const output = obj.outputTokens ?? obj.output_tokens ?? obj.text_output_tokens;
    const uNum = Number(uncached);
    const cNum = Number(cached);
    const oNum = Number(output);
    if (Number.isFinite(uNum) && Number.isFinite(cNum) && Number.isFinite(oNum)) {
      return uNum + cNum + oNum;
    }
    return null;
  };

  let snapshot = (typeof options.getSnapshot === 'function' ? options.getSnapshot() : null) || {};

  const state = {
    shadowRoot: shadow,
    shadowEventsBound: false,
    loading: false,
    error: '',
    accountMode: null,
    viewMode: 'personal',
    selectedStartDate: '',
    selectedEndDate: '',
    quotaWindow: null,
    cycleStartMs: NaN,
    cycleEndMs: NaN,
    expandedDates: new Set(),
  };

  const syncStateFromSnapshot = () => {
    state.loading = (snapshot.status === 'loading');
    state.error = snapshot.error || '';
    state.accountMode = snapshot.accountMode || null;
    state.viewMode = snapshot.viewMode || 'personal';

    const newStart = snapshot.range?.startDate || '';
    const newEnd = snapshot.range?.endDate || '';
    if (newStart !== state.selectedStartDate || newEnd !== state.selectedEndDate) {
      dateInputDirty = false;
      localStartDate = newStart;
      localEndDate = newEnd;
      state.selectedStartDate = newStart;
      state.selectedEndDate = newEnd;
    }

    // ALWAYS reset cycle start/end to NaN before mapping every snapshot
    state.cycleStartMs = NaN;
    state.cycleEndMs = NaN;

    if (snapshot.quota && typeof snapshot.quota === 'object') {
      const q = snapshot.quota;
      const isAvail = q.available !== false;
      state.quotaWindow = {
        _window_name: '配额窗口',
        available: q.available,
        duration_seconds: q.durationSeconds,
        limit_window_seconds: q.durationSeconds,
        usedRatio: isAvail && q.usedRatio !== undefined && q.usedRatio !== null ? q.usedRatio : null,
        used_ratio: isAvail && q.usedRatio !== undefined && q.usedRatio !== null ? q.usedRatio : null,
        remaining: isAvail && q.remaining !== undefined && q.remaining !== null && Number.isFinite(Number(q.remaining)) ? Number(q.remaining) : null,
        limit: isAvail && q.limit !== undefined && q.limit !== null && Number.isFinite(Number(q.limit)) ? Number(q.limit) : null,
        resetAt: q.resetAt || null,
        reset_at: q.resetAt || null,
        cycleStartDate: q.cycleStartDate || null,
        cycleEndDate: q.cycleEndDate || null,
      };

      if (q.cycleStartDate) {
        state.cycleStartMs = dayStartMs(q.cycleStartDate);
      } else if (q.resetAt && q.durationSeconds) {
        const resetMs = toEpochMs(q.resetAt);
        if (Number.isFinite(resetMs)) {
          state.cycleStartMs = resetMs - (q.durationSeconds * 1000);
        }
      }

      if (q.cycleEndDate) {
        state.cycleEndMs = dayStartMs(q.cycleEndDate);
      } else if (q.resetAt) {
        state.cycleEndMs = toEpochMs(q.resetAt);
      }
    } else {
      state.quotaWindow = null;
    }
  };

  syncStateFromSnapshot();

  const sanitizeSnapshotForDebug = (snap) => {
    if (!snap || typeof snap !== 'object') return {};
    const safe = {};
    const allowed = [
      'status', 'error', 'accountMode', 'viewMode', 'range',
      'quota', 'summary', 'models', 'daily', 'clients',
      'modelActivity', 'notices', 'updatedAt'
    ];
    for (const key of allowed) {
      if (hasOwn(snap, key)) {
        safe[key] = snap[key];
      }
    }
    return safe;
  };

  const hasVisibleData = () => {
    if (!snapshot) return false;
    if (Array.isArray(snapshot.daily) && snapshot.daily.length > 0) return true;
    if (Array.isArray(snapshot.models) && snapshot.models.length > 0) return true;
    if (snapshot.summary && (snapshot.summary.tokens !== null || snapshot.summary.turns !== null || snapshot.summary.estimatedUsd !== null)) {
      if (Number(snapshot.summary.tokens) >= 0 || Number(snapshot.summary.turns) >= 0 || Number(snapshot.summary.estimatedUsd) >= 0) return true;
    }
    return false;
  };

  const getVisibleData = () => {
    const isTeamView = state.viewMode === 'team';

    const modelRows = asArray(snapshot.models).map((m) => ({
      name: m.name,
      speed: m.speed || 'standard',
      tokens: m.tokens !== undefined ? m.tokens : null,
      uncachedInputTokens: m.uncachedInputTokens !== undefined ? m.uncachedInputTokens : null,
      cachedInputTokens: m.cachedInputTokens !== undefined ? m.cachedInputTokens : null,
      outputTokens: m.outputTokens !== undefined ? m.outputTokens : null,
      estimatedUsd: m.estimatedUsd !== undefined ? m.estimatedUsd : null,
      hasEstimatedAllocation: Boolean(m.estimatedAllocation),
      hasRateFallback: Boolean(m.fallbackPricing),
      usesFallbackPricing: Boolean(m.fallbackPricing),
      hasImageFieldFallback: Boolean(m.incompleteImage),
      calculation: m.calculation || null,
    }));

    const modelSummary = {
      rows: modelRows,
      hasEstimatedAllocation: modelRows.some((r) => r.hasEstimatedAllocation),
      hasFallbackPricing: modelRows.some((r) => r.usesFallbackPricing),
    };

    const dailyBreakdown = asArray(snapshot.daily).map((d) => {
      const dayModels = asArray(d.models).map((m) => ({
        name: m.name,
        model: m.name,
        speed: m.speed || 'standard',
        tokens: m.tokens !== undefined ? m.tokens : null,
        uncachedInputTokens: m.uncachedInputTokens !== undefined ? m.uncachedInputTokens : null,
        cachedInputTokens: m.cachedInputTokens !== undefined ? m.cachedInputTokens : null,
        outputTokens: m.outputTokens !== undefined ? m.outputTokens : null,
        estimatedUsd: m.estimatedUsd !== undefined ? m.estimatedUsd : null,
        calculation: m.calculation || null,
        hasEstimatedAllocation: Boolean(m.estimatedAllocation),
        hasRateFallback: Boolean(m.fallbackPricing),
        usesFallbackPricing: Boolean(m.fallbackPricing),
        hasImageFieldFallback: Boolean(m.incompleteImage),
      }));

      const dateStr = d.date || '';
      const sortTs = dayStartMs(dateStr) || 0;
      const hasTeamTokenModels = dayModels.length > 0 && dayModels.some((m) => (m.tokens !== null && m.tokens !== undefined && Number.isFinite(Number(m.tokens))));

      return {
        _sortTs: sortTs,
        _dateKey: dateStr,
        _displayDate: dateStr,
        _tokenModels: dayModels,
        _hasTeamTokenModels: hasTeamTokenModels,
        _estimatedUsd: d.estimatedUsd !== undefined ? d.estimatedUsd : null,
        tokens: d.tokens !== undefined ? d.tokens : null,
        uncachedInputTokens: d.uncachedInputTokens !== undefined ? d.uncachedInputTokens : null,
        cachedInputTokens: d.cachedInputTokens !== undefined ? d.cachedInputTokens : null,
        outputTokens: d.outputTokens !== undefined ? d.outputTokens : null,
        turns: d.turns !== undefined ? d.turns : null,
        threads: d.threads !== undefined ? d.threads : null,
        credits: d.credits !== undefined ? d.credits : null,
        totals: {
          tokens: d.tokens !== undefined ? d.tokens : null,
          turns: d.turns !== undefined ? d.turns : null,
          threads: d.threads !== undefined ? d.threads : null,
        },
      };
    });

    const summary = {
      tokens: snapshot.summary?.tokens !== undefined ? snapshot.summary.tokens : null,
      uncachedInputTokens: snapshot.summary?.uncachedInputTokens !== undefined ? snapshot.summary.uncachedInputTokens : null,
      cachedInputTokens: snapshot.summary?.cachedInputTokens !== undefined ? snapshot.summary.cachedInputTokens : null,
      outputTokens: snapshot.summary?.outputTokens !== undefined ? snapshot.summary.outputTokens : null,
      turns: snapshot.summary?.turns !== undefined ? snapshot.summary.turns : null,
      threads: snapshot.summary?.threads !== undefined ? snapshot.summary.threads : null,
      credits: snapshot.summary?.credits !== undefined ? snapshot.summary.credits : null,
      estimatedUsd: snapshot.summary?.estimatedUsd !== undefined ? snapshot.summary.estimatedUsd : null,
      activeMembersPeak: snapshot.summary?.activeMembersPeak !== undefined ? snapshot.summary.activeMembersPeak : null,
      activeMemberDays: null,
    };

    const clientStats = asArray(snapshot.clients).map((c) => ({
      name: c.name || '未知',
      tokens: c.tokens !== undefined ? c.tokens : null,
      turns: c.turns !== undefined ? c.turns : null,
      credits: c.credits !== undefined ? c.credits : null,
    }));

    const teamModelActivity = asArray(snapshot.modelActivity).map((ma) => ({
      name: ma.name,
      turns: ma.turns !== undefined ? ma.turns : null,
      threads: ma.threads !== undefined ? ma.threads : null,
      credits: ma.credits !== undefined ? ma.credits : null,
      activeMembersPeak: ma.activeMembersPeak !== undefined ? ma.activeMembersPeak : null,
    }));

    return {
      generatedAt: snapshot.updatedAt || new Date().toISOString(),
      accountMode: state.accountMode,
      viewMode: state.viewMode,
      selectedRange: snapshot.range || { startDate: '', endDate: '' },
      quota: snapshot.quota,
      summary,
      currentUserSummary: isTeamView ? null : summary,
      currentUserModelSummary: modelSummary,
      teamModelSummary: isTeamView ? modelSummary : null,
      teamModelActivity,
      clientStats,
      dailyBreakdown,
    };
  };

  // Exact verbatim render routines
  const renderQuotaCard = () => {
    const window = state.quotaWindow;
    const ratio = usedRatioFromWindow(window);
    const percent = usedPercentTextFromWindow(window);
    const className = ratio >= .85 ? 'danger' : ratio >= .6 ? 'warn' : 'ok';
    const remaining = quotaValue(window, ['remaining', 'remaining_credits', 'available', 'available_credits']);
    const hasUsedPercentOrRatio = ['used_ratio', 'usedRatio', 'fraction_used', 'used_percent', 'usedPercent']
      .some((key) => hasNumericField(window, key));
    const remainingText = remaining !== null
      ? `剩余: <strong>${escapeHtml(fmtNum(remaining))}</strong>`
      : hasUsedPercentOrRatio
        ? `剩余约 <strong>${escapeHtml(formatPercentFromRatio(1 - ratio))}</strong>（配额比例）`
        : '剩余配额比例: <strong>未知</strong>';
    const reset = quotaValue(window, ['reset_at', 'resetAt', 'resets_at', 'end_at', 'window_end']);
    const cycleEstimate = personalCycleCostEstimate();
    const estimateCardsHtml = cycleEstimate
      ? `
        <div class="quota-estimate-cards">
          <div class="quota-estimate-card">
            <div class="estimate-card-label">预计完整周期额度 <span class="estimate-tag">估算</span></div>
            <div class="estimate-card-value">${fmtUsd(cycleEstimate.fullCycleUsd)}</div>
            <div class="estimate-card-hint">当前周期个人总配额预估</div>
          </div>
          <div class="quota-estimate-card remaining">
            <div class="estimate-card-label">预计剩余额度 <span class="estimate-tag">估算</span></div>
            <div class="estimate-card-value">${fmtUsd(cycleEstimate.remainingUsd)}</div>
            <div class="estimate-card-hint">当前可用余额额度预估</div>
          </div>
        </div>`
      : `
        <div class="quota-estimate-unavailable">
          <span>ℹ️ 预计完整周期额度暂不可用：需当前周期有效个人模型费用及配额使用比例；自定义日期区间不参与该估算。</span>
        </div>`;
    return `
      <section class="quota-card">
        <div class="card-top">
          <div class="eyebrow-wrap">
            <span class="quota-icon">⚡</span>
            <span class="eyebrow">个人配额概览</span>
          </div>
          <span class="quota-name">${escapeHtml(window?._window_name || '配额窗口')} · ${escapeHtml(formatDuration(getWindowDurationSeconds(window)))}</span>
        </div>
        <div class="progress-track">
          <div class="progress-fill ${className}" style="width:${Math.round(ratio * 1000) / 10}%"></div>
        </div>
        <div class="quota-stats">
          <span class="quota-stat-item"><strong>${escapeHtml(percent)}</strong> 已使用</span>
          <span class="quota-stat-divider">·</span>
          <span class="quota-stat-item">${remainingText}</span>
          <span class="quota-stat-divider">·</span>
          <span class="quota-stat-item">重置时间: <strong>${escapeHtml(reset ? formatDateTime(toEpochMs(reset)) : '—')}</strong></span>
        </div>
        ${estimateCardsHtml}
        <div class="quota-notice-box">
          <span class="quota-notice-icon">💡</span>
          <span>配额使用比例为实时更新，而用量费用数据存在延迟，因此估算并非完全准确。</span>
        </div>
      </section>`;
  };
  const renderViewQuota = (isTeamView) => isTeamView ? '' : renderQuotaCard();
  const renderMiniBars = (modelStats) => {
    if (!modelStats.rows.length) return '<div class="card-sub">暂无模型 Token 数据</div>';
    const validUsdValues = modelStats.rows
      .map((r) => r.estimatedUsd)
      .filter((v) => v !== null && v !== undefined && Number.isFinite(Number(v)));
    const max = validUsdValues.length ? Math.max(...validUsdValues, CONFIG.EPS) : 0;
    return `
      <div class="mini-bars" title="各模型预估费用占比">
        ${modelStats.rows.slice(0, 3).map((row) => {
          const hasVal = row.estimatedUsd !== null && row.estimatedUsd !== undefined && Number.isFinite(Number(row.estimatedUsd));
          const pct = (hasVal && max > 0) ? Math.max(4, Math.min(100, (Number(row.estimatedUsd) / max) * 100)) : 0;
          const costText = hasVal ? fmtUsd(row.estimatedUsd) : '不可用';
          return `
          <div class="mini-bar-item">
            <span class="mini-bar-name" title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</span>
            <div class="mini-bar" title="${escapeHtml(`${row.name}: ${costText}`)}">
              <span style="width:${pct}%"></span>
            </div>
          </div>`;
        }).join('')}
      </div>`;
  };  const renderTokenCostKpis = (stats, modelStats, { isTeamView = false, currentUserSummary = null } = {}) => {
    const tokenCard = `
      <section class="summary-card">
        <div class="card-header-row">
          <span class="card-label">总 Token 数</span>
          <span class="card-badge tokens">用量</span>
        </div>
        <div class="card-value" title="${escapeHtml(fmtFullNum(stats.tokens))}">${fmtNum(stats.tokens)}</div>
        <div class="card-sub">
          <div><span class="sub-dot uncached"></span>未缓存: <strong>${fmtNum(stats.uncachedInputTokens)}</strong></div>
          <div><span class="sub-dot cached"></span>已缓存: <strong>${fmtNum(stats.cachedInputTokens)}</strong> · 输出: <strong>${fmtNum(stats.outputTokens)}</strong></div>
        </div>
      </section>`;
    const costCard = `
      <section class="summary-card">
        <div class="card-header-row">
          <span class="card-label">${isTeamView ? '团队预估费用' : '预估费用'}</span>
          <span class="card-badge cost">预估</span>
        </div>
        <div class="card-value cost-value">${modelStats.rows.length ? fmtUsd(isTeamView ? stats.estimatedUsd : stats.estimatedUsd) : '不可用'}</div>
        ${isTeamView ? `<div class="card-sub">工作区精确模型 Token 计价<br>当前用户对比 Token：<strong>${fmtNum(currentUserSummary?.tokens)}</strong></div>` : ''}
        ${renderMiniBars(modelStats)}
      </section>`;
    return `<div class="kpi-grid-left">${isTeamView ? `${costCard}${tokenCard}` : `${tokenCard}${costCard}`}</div>`;
  };
  const renderActivityKpi = (stats, { isTeamView = false } = {}) => `
    <div class="kpi-grid-right">
      <section class="summary-card">
        <div class="card-header-row">
          <span class="card-label">交互活跃度</span>
          <span class="card-badge activity">活跃</span>
        </div>
        <div class="card-value">${fmtTurns(stats.turns)} <span class="card-unit">轮</span></div>
        <div class="card-sub">
          <div>对话轮数: <strong>${fmtTurns(stats.turns)}</strong> 轮</div>
          <div>主题数量: <strong>${fmtTurns(stats.threads)}</strong> 个${isTeamView && stats.activeMembersPeak ? ` · 日活成员峰值: <strong>${fmtNum(stats.activeMembersPeak)}</strong>` : ''}</div>
        </div>
      </section>
    </div>`;
  const modelColors = ['#7c3aed', '#2563eb', '#10b981', '#d97706', '#dc2626', '#0891b2'];
  const renderModelTable = (modelStats, { isTeamView = false } = {}) => `
    <section class="section">
      <div class="section-title-row">
        <div class="section-title">
          <span class="section-icon">🧠</span>
          <span>${isTeamView ? '团队 · 工作区精确 Token' : '模型用量明细'}</span>
        </div>
        <div class="section-note">${isTeamView ? '工作区分析精确 Token 行' : modelStats.hasEstimatedAllocation ? '费率折算分摊' : 'Token 接口'}</div>
      </div>
      ${modelStats.rows.length ? `<div class="table-box"><table>
        <thead>
          <tr>
            <th>模型</th>
            <th class="num-th">Token 总数</th>
            <th class="num-th">未缓存输入</th>
            <th class="num-th">已缓存输入</th>
            <th class="num-th">输出</th>
            <th class="num-th">预估费用</th>
          </tr>
        </thead>
        <tbody>${modelStats.rows.map((row, index) => `
          <tr class="model-row">
            <td>
              <div class="model-cell">
                <span class="model-color-indicator" style="background:${modelColors[index % modelColors.length]}"></span>
                <span class="model-pill" title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</span>
                ${row.speed !== 'standard' ? `<span class="speed-pill">${escapeHtml(row.speed === 'fast' ? 'fast' : row.speed)}</span>` : ''}
                ${row.hasEstimatedAllocation ? `<span class="estimate-pill" title="个人模式用量已根据额度占比与混合模型费率进行折算分摊。">${row.hasRateFallback ? '兜底估算' : '折算分摊'}</span>` : ''}
              </div>
            </td>
            <td class="num" title="${escapeHtml(fmtFullNum(row.tokens))}">${fmtNum(row.tokens)}</td>
            <td class="num">${fmtNum(row.uncachedInputTokens)}</td>
            <td class="num">${fmtNum(row.cachedInputTokens)}</td>
            <td class="num">${fmtNum(row.outputTokens)}</td>
            <td class="money${row.usesFallbackPricing ? ' fallback' : ''}" title="${escapeHtml(formatModelCostCalculation(row))}">${fmtUsd(row.estimatedUsd)}${row.usesFallbackPricing ? '*' : ''}</td>
          </tr>`).join('')}
        </tbody>
      </table></div>` : '<div class="empty">所选范围内未找到模型用量明细。</div>'}
      ${modelStats.hasFallbackPricing ? '<div class="section-footnote">* 未知模型默认采用 GPT-5.5 费率进行估算。</div>' : ''}
      ${modelStats.rows.some((row) => isCodexAutoReviewModel(row.name)) ? '<div class="section-footnote">codex-auto-review 按 gpt-5.6-luna 映射估算（用户指定，非官方独立价格）。</div>' : ''}
      ${modelStats.rows.some((row) => isImageModel(row.name)) ? `<div class="section-footnote">gpt-image-2/image2 使用图像模态专用费率估算；${modelStats.rows.some((row) => row.hasImageFieldFallback) ? '按可用字段估算，缺少明确图像输出模态拆分时可能不完整。' : '已按返回的明确模态字段计费。'} 计费参考：<a href="${GPT_IMAGE_2_PRICING_URL}" target="_blank" rel="noreferrer">OpenAI API Pricing</a></div>` : ''}
      ${isTeamView ? '<div class="section-footnote">无 Token 的模型活动行仅用于团队活动统计，不参与 Token 或费用计算。</div>' : ''}
    </section>`;
  const renderTeamOverview = (stats, modelActivity) => {
    if (state.accountMode !== 'team' || state.viewMode !== 'team') return '';
    return `
      <section class="section">
        <div class="section-title-row">
          <div class="section-title">
            <span class="section-icon">👥</span>
            <span>团队汇总</span>
          </div>
        </div>
        <div class="notice">团队总计: ${fmtNum(stats.tokens)} Token · ${fmtTurns(stats.turns)} 轮对话 · ${fmtTurns(stats.threads)} 个主题。每日活跃成员峰值: <strong>${fmtNum(stats.activeMembersPeak)}</strong>；累计活跃成员日: <strong>${fmtNum(stats.activeMemberDays)}</strong>（不是去重成员数）。接口不支持按成员展开。</div>
        ${modelActivity.length ? `<div class="table-box"><table>
          <thead>
            <tr>
              <th>模型</th>
              <th class="num-th">对话轮数</th>
              <th class="num-th">主题数</th>
              <th class="num-th">日活成员峰值</th>
            </tr>
          </thead>
          <tbody>${modelActivity.map((row) => `
            <tr>
              <td><span class="model-pill">${escapeHtml(row.name)}</span></td>
              <td class="num">${fmtTurns(row.turns)}</td>
              <td class="num">${fmtTurns(row.threads)}</td>
              <td class="num">${fmtNum(row.activeMembersPeak)}</td>
            </tr>`).join('')}
          </tbody>
        </table></div>` : '<div class="section-footnote">接口未返回可展示的模型活动行。</div>'}
      </section>`;
  };
  const renderClientTable = (clients, { isTeamView = false } = {}) => `
    <section class="section">
      <div class="section-title-row">
        <div class="section-title">
          <span class="section-icon">💻</span>
          <span>客户端用量明细</span>
        </div>
        <div class="section-note">${isTeamView ? '团队工作区分析数据' : '个人工作区分析数据'}</div>
      </div>
      ${clients.length ? `<div class="table-box"><table>
        <thead>
          <tr>
            <th>客户端</th>
            <th class="num-th">Token 数</th>
            <th class="num-th">对话轮数</th>
            <th class="num-th">额度 (Credits)</th>
          </tr>
        </thead>
        <tbody>${clients.map((row) => `
          <tr>
            <td><span class="client-label" title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</span></td>
            <td class="num">${fmtNum(row.tokens)}</td>
            <td class="num">${fmtTurns(row.turns)}</td>
            <td class="num">${fmtNum(row.credits)}</td>
          </tr>`).join('')}
        </tbody>
      </table></div>` : '<div class="empty">所选范围内未查询到客户端数据。</div>'}
    </section>`;
  const renderDailyTable = (rows, stats, { isTeamView = false } = {}) => {
    const sorted = [...rows].sort((a, b) => b._sortTs - a._sortTs);
    return `
      <section class="section">
        <div class="section-title-row">
          <div class="section-title">
            <span class="section-icon">📅</span>
            <span>每日明细</span>
          </div>
          <div class="section-note">点击日期展开模型明细 · 按时间倒序</div>
        </div>
        <div class="table-box"><table>
          <thead>
            <tr>
              <th>日期</th>
              <th class="num-th">Token 数</th>
              <th class="num-th">轮数</th>
              <th class="num-th">主题数</th>
              <th class="num-th">${isTeamView ? '费用' : '预估费用'}</th>
            </tr>
          </thead>
          <tbody>${sorted.length ? sorted.map((row) => {
            const totals = row.totals || row;
            const open = state.expandedDates.has(row._dateKey);
            const models = asArray(row._tokenModels);
            return `
              <tr class="daily-row ${open ? 'is-open' : ''}" data-action="toggle-day" data-date="${escapeHtml(row._dateKey)}" role="button" tabindex="0" aria-expanded="${open}">
                <td>
                  <div class="date-cell">
                    <span class="expand-icon">${open ? '▼' : '▶'}</span>
                    <span>${escapeHtml(row._displayDate)}</span>
                  </div>
                </td>
                <td class="num" title="${escapeHtml(fmtFullNum(tokenTotal(totals)))}">${fmtNum(tokenTotal(totals))}</td>
                <td class="num">${fmtTurns(totals.turns)}</td>
                <td class="num">${fmtTurns(totals.threads)}</td>
                <td class="money">${isTeamView && !row._hasTeamTokenModels ? '不可用' : fmtUsd(row._estimatedUsd)}</td>
              </tr>
              <tr class="details-row" data-role="day-details" ${open ? '' : 'hidden'}>
                <td colspan="5">
                  <div class="day-details">
                    ${models.length ? models.map((model) => `
                      <div class="day-model">
                        <div class="day-model-header">
                          <strong>${escapeHtml(getModelDisplayName(model))}</strong>
                          <span class="speed-tag">${escapeHtml(normalizeSpeed(model.speed) === 'fast' ? 'fast' : '标准')}</span>
                        </div>
                        <div class="day-model-body">
                          <span>${fmtNum(tokenTotal(model))} Token</span>
                          <span class="money">${fmtUsd(estimateModelUsd(model))}</span>
                        </div>
                      </div>`).join('') : '<div class="empty">该日期暂无模型 Token 明细数据。</div>'}
                  </div>
                </td>
              </tr>`;
          }).join('') : '<tr><td colspan="5" class="empty">所选范围内无每日明细数据。</td></tr>'}
          </tbody>
          <tfoot>
            <tr>
              <td><strong>合计</strong></td>
              <td class="num"><strong>${fmtNum(stats.tokens)}</strong></td>
              <td class="num"><strong>${fmtTurns(stats.turns)}</strong></td>
              <td class="num"><strong>${fmtTurns(stats.threads)}</strong></td>
              <td class="money"><strong>${isTeamView && !rows.some((row) => row._hasTeamTokenModels) ? '不可用' : fmtUsd(stats.estimatedUsd)}</strong></td>
            </tr>
          </tfoot>
        </table></div>
      </section>`;
  };
  const renderLoading = () => `
    <div class="loading-wrap">
      <div class="two-column-layout skeleton-layout">
        <div class="column-left">
          <div class="kpi-grid-left">
            <div class="skeleton card-sk"></div>
            <div class="skeleton card-sk"></div>
          </div>
          <div class="skeleton table-sk-lg"></div>
        </div>
        <div class="column-right">
          <div class="skeleton quota-sk"></div>
          <div class="skeleton table-sk-lg"></div>
        </div>
      </div>
      <div class="loading-text" role="status" aria-live="polite">
        <span class="spinner"></span>
        <span>正在加载配额、用量及模型数据...</span>
      </div>
    </div>`;
  const renderContent = () => {
    const visible = getVisibleData();
    const isTeamView = visible.viewMode === 'team';
    const modelStats = isTeamView
      ? visible.teamModelSummary
      : visible.currentUserModelSummary;
    const allocationNotice = visible.viewMode === 'personal' && modelStats.hasEstimatedAllocation
      ? '<div class="notice">💡 个人模式下的模型 Token 系根据每日总额及额度占比与模型费率折算，仅供参考，非实际计费账单。</div>'
      : isTeamView
        ? '<div class="notice">💡 团队 Token、模型和费用均来自工作区分析中的精确 Token 行；无 Token 的模型活动行仅用于轮数、主题和活跃成员统计，不参与计价。费用按配置价格估算，并非实际账单。</div>'
        : '';
    const controllerNoticesHtml = asArray(snapshot?.notices).map((msg) => `<div class="notice">💡 ${escapeHtml(msg)}</div>`).join('');
    const allNotices = [allocationNotice, controllerNoticesHtml].filter(Boolean).join('');
    const quotaHtml = renderViewQuota(isTeamView);
    const tokenCostKpiHtml = renderTokenCostKpis(visible.summary, modelStats, { isTeamView, currentUserSummary: visible.currentUserSummary });
    const activityKpiHtml = isTeamView ? renderActivityKpi(visible.summary, { isTeamView: true }) : '';
    const teamOverviewHtml = isTeamView ? renderTeamOverview(visible.summary, visible.teamModelActivity) : '';
    const clientTableHtml = isTeamView ? renderClientTable(visible.clientStats, { isTeamView: true }) : '';
    const modelTableHtml = renderModelTable(modelStats, { isTeamView });
    const dailyTableHtml = renderDailyTable(visible.dailyBreakdown, visible.summary, { isTeamView });

    // Academic Paper-style Two-Column Layout:
    // Personal View:
    //   Left column: Token + Cost KPI -> Allocation Notice (if any) -> Model Breakdown Table
    //   Right column: Quota Overview Card -> Daily Breakdown Table
    // Team View:
    //   Left column: Token + Cost KPI -> Team Notice (if any) -> Team Overview Table -> Model Breakdown Table
    //   Right column: Activity KPI -> Client Breakdown Table -> Daily Breakdown Table
    if (isTeamView) {
      return `
        <div class="two-column-layout">
          <div class="column-left">
            ${tokenCostKpiHtml}
            ${allNotices ? `<div class="notice-wrap">${allNotices}</div>` : ''}
            ${teamOverviewHtml}
            ${modelTableHtml}
          </div>
          <div class="column-right">
            ${activityKpiHtml}
            ${clientTableHtml}
            ${dailyTableHtml}
          </div>
        </div>`;
    }

    return `
      <div class="two-column-layout">
        <div class="column-left">
          ${tokenCostKpiHtml}
          ${allNotices ? `<div class="notice-wrap">${allNotices}</div>` : ''}
          ${modelTableHtml}
        </div>
        <div class="column-right">
          ${quotaHtml}
          ${dailyTableHtml}
        </div>
      </div>`;
  };


  const renderPanelShell = () => {
    const shadowRoot = createHostAndShadow();
    if (shadowRoot.getElementById('modalCard')) return;
    shadowRoot.innerHTML = `
      <style>
${css}
        :host(.dark) {
          --bg-backdrop: rgba(0, 0, 0, 0.72);
          --bg-modal: #1e1e24;
          --bg-header: #22222a;
          --bg-subtle: #17171c;
          --bg-card: #23232b;
          --bg-card-hover: #2b2b35;
          --bg-input: #17171c;
          --bg-table-header: #1b1b22;
          --bg-table-row-hover: #272732;
          --bg-table-zebra: #202028;
          --bg-table-footer: #1b1b22;
          --bg-details: #18181f;
          --bg-details-card: #23232b;
          --bg-tag: #2a2a34;
          --bg-pre: #141418;

          --border: #33333f;
          --border-subtle: #282832;
          --border-strong: #4a4a58;
          --border-focus: #10a37f;

          --text-primary: #f1f5f9;
          --text-secondary: #cbd5e1;
          --text-muted: #8892a4;
          --text-inverse: #0f172a;

          --brand-green: #10a37f;
          --brand-green-hover: #1ab890;
          --brand-green-active: #0d8c6d;
          --brand-green-subtle: rgba(16, 163, 127, 0.16);
          --brand-green-border: rgba(16, 163, 127, 0.42);
          --brand-green-text: #34d399;

          --accent-blue: #3b82f6;
          --accent-blue-subtle: rgba(59, 130, 246, 0.16);
          --accent-blue-border: rgba(59, 130, 246, 0.42);
          --accent-blue-text: #93c5fd;

          --accent-purple: #a78bfa;
          --accent-purple-subtle: rgba(167, 139, 250, 0.16);
          --accent-purple-border: rgba(167, 139, 250, 0.42);
          --accent-purple-text: #c4b5fd;

          --accent-emerald: #34d399;
          --accent-emerald-subtle: rgba(52, 211, 153, 0.15);

          --accent-amber: #fbbf24;
          --accent-amber-subtle: rgba(251, 191, 36, 0.16);
          --accent-amber-border: rgba(251, 191, 36, 0.42);
          --accent-amber-text: #fde68a;

          --accent-red: #f87171;
          --accent-red-subtle: rgba(248, 113, 113, 0.16);
          --accent-red-border: rgba(248, 113, 113, 0.42);
          --accent-red-text: #fca5a5;

          --track-bg: #141418;
          --scrollbar-thumb: #3e3e4e;
          --scrollbar-thumb-hover: #58586c;

          --shadow-modal: 0 25px 50px -12px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.08);
          --shadow-card: 0 1px 3px 0 rgba(0, 0, 0, 0.35), 0 1px 2px -1px rgba(0, 0, 0, 0.25);
        }
        :host(.dark) input[type='date'] {
          color-scheme: dark;
        }
        :host(.dark) .skeleton {
          background: linear-gradient(90deg, #23232b 25%, #2d2d38 37%, #23232b 63%);
          background-size: 400% 100%;
          border-color: var(--border);
        }
      </style>
      <div class="modal-backdrop" id="modalBackdrop">
        <main class="panel modal-card" id="modalCard" role="dialog" aria-modal="true" aria-labelledby="modalTitle" tabindex="-1">
          <header class="header">
            <div class="header-left">
              <div class="header-title">
                <span class="header-icon">📊</span>
                <span class="title-text" id="modalTitle">Codex 用量追踪</span>
                <span class="version">2026.08.27-v1</span>
                <span class="mode-badge" id="modeBadge"></span>
              </div>
              <div class="header-delay-pill" title="OpenAI 用量数据统计非实时，一般约有数小时延迟">
                <span class="delay-dot"></span>
                <span class="delay-text">用量数据可能有延迟，并非实时更新</span>
              </div>
            </div>
            <button class="close-btn" id="closeBtn" title="关闭 (ESC)" aria-label="关闭">✕</button>
          </header>
          <div class="range-bar">
            <div class="date-fields">
              <div class="field-group">
                <label for="startDate">开始日期</label>
                <input id="startDate" type="date">
              </div>
              <div class="field-group">
                <label for="endDate">结束日期</label>
                <input id="endDate" type="date">
              </div>
              <button class="primary-btn" id="loadBtn"></button>
            </div>
            <div class="presets-row">
              <div class="presets">
                <span class="preset-label">快捷:</span>
                <button class="mini-btn" id="cycleBtn">本周期</button>
                <button class="mini-btn" id="sevenBtn">近 7 天</button>
                <button class="mini-btn" id="thirtyBtn">近 30 天</button>
              </div>
              <div class="view-switch" role="group" aria-label="数据视图切换">
                <button class="view-switch-btn" id="personalViewBtn">个人</button>
                <button class="view-switch-btn" id="teamViewBtn">团队</button>
              </div>
              <div class="cycle-hint" id="cycleHint"></div>
            </div>
          </div>
          <div class="panel-body" id="panelBody">
            <div id="panelError"></div>
            <div id="panelContent"></div>
            <div class="content-loading-overlay" id="contentLoadingOverlay" hidden aria-hidden="true" aria-busy="false" role="status">
              <div class="loading-progress-line"></div>
              <div class="content-loading-status"><span class="spinner"></span><span>正在更新数据...</span></div>
            </div>
            <footer class="footer">
              <div class="export-group">
                <button class="footer-btn" id="csvBtn">📥 导出 CSV</button>
                <button class="footer-btn" id="jsonBtn">📥 导出 JSON</button>
              </div>
              <button class="footer-btn refresh" id="refreshBtn">🔄 刷新数据</button>
              <details class="raw-json">
                <summary>当前汇总数据</summary>
                <pre id="rawJson"></pre>
              </details>
            </footer>
          </div>
        </main>
      </div>`;
    bindShadowEvents();
  };

  const syncContentLoadingOverlay = (overlay, isLoading, hasData) => {
    if (!overlay) return;
    const visible = Boolean(isLoading && hasData);
    overlay.hidden = !visible;
    overlay.classList.toggle('is-visible', visible);
    overlay.setAttribute('aria-hidden', String(!visible));
    overlay.setAttribute('aria-busy', String(visible));
  };

  const updatePanel = ({ replaceContent = true } = {}) => {
    renderPanelShell();
    const shadowRoot = state.shadowRoot;
    const mode = state.accountMode === 'team'
      ? (state.viewMode === 'team' ? '团队视图' : '个人视图')
      : state.accountMode === 'personal' ? '个人模式' : (snapshot.status === 'loading' ? '加载中...' : '未知');
    const isPersonalConfirmed = state.accountMode === 'personal';
    const hasData = hasVisibleData();
    const cycleHint = Number.isFinite(state.cycleStartMs)
      ? `当前周期: ${dateKeyFromMs(state.cycleStartMs)} 至 ${dateKeyFromMs(Math.min(Date.now(), state.cycleEndMs))}`
      : '周期日期将随配额用量自动加载。';
    const byId = (id) => shadowRoot.getElementById(id);
    const panelBody = byId('panelBody');
    const scrollTop = panelBody?.scrollTop || 0;
    const setDisabled = (id, disabled) => { const element = byId(id); if (element) element.disabled = disabled; };
    const modeBadge = byId('modeBadge');
    if (modeBadge) {
      modeBadge.textContent = mode;
      modeBadge.classList.toggle('personal', state.accountMode === 'personal');
    }
    const startInput = byId('startDate');
    const endInput = byId('endDate');
    if (startInput && shadowRoot.activeElement !== startInput) {
      if (!dateInputDirty) {
        startInput.value = state.selectedStartDate || '';
        localStartDate = state.selectedStartDate || '';
      } else {
        startInput.value = localStartDate;
      }
    }
    if (endInput && shadowRoot.activeElement !== endInput) {
      if (!dateInputDirty) {
        endInput.value = state.selectedEndDate || '';
        localEndDate = state.selectedEndDate || '';
      } else {
        endInput.value = localEndDate;
      }
    }
    const loadButton = byId('loadBtn');
    if (loadButton) loadButton.innerHTML = state.loading ? '<span class="btn-spinner"></span>查询中...' : '查询';
    const refreshButton = byId('refreshBtn');
    if (refreshButton) refreshButton.innerHTML = state.loading ? '<span class="btn-spinner"></span>更新中...' : '🔄 刷新数据';
    ['loadBtn', 'cycleBtn', 'sevenBtn', 'thirtyBtn', 'personalViewBtn', 'refreshBtn'].forEach((id) => setDisabled(id, state.loading));
    setDisabled('teamViewBtn', state.loading || isPersonalConfirmed);
    const personalButton = byId('personalViewBtn');
    const teamButton = byId('teamViewBtn');
    personalButton?.classList.toggle('active', state.viewMode === 'personal');
    teamButton?.classList.toggle('active', state.viewMode === 'team');
    if (teamButton) teamButton.title = isPersonalConfirmed ? '当前账号为个人账号，不支持团队视图' : '查看工作区团队汇总';
    const hint = byId('cycleHint');
    if (hint) hint.textContent = cycleHint;
    const error = byId('panelError');
    if (error) {
      error.innerHTML = state.error
        ? `<div class="error-banner" role="alert"><span class="error-icon">⚠️</span><div class="error-body"><div class="error-title">请求失败</div><div class="error-text">${escapeHtml(state.error)}</div></div></div>`
        : '';
    }
    if (replaceContent) {
      const content = byId('panelContent');
      if (content) content.innerHTML = hasData ? renderContent() : state.loading ? renderLoading() : '<div class="empty-state"><div class="empty-icon">📈</div><div class="empty-title">暂无数据</div><div class="empty-desc">请选择日期范围后点击查询获取用量明细</div></div>';
    }
    syncContentLoadingOverlay(byId('contentLoadingOverlay'), state.loading, hasData);
    ['csvBtn', 'jsonBtn'].forEach((id) => setDisabled(id, state.loading || !hasData));
    const raw = byId('rawJson');
    if (raw) raw.textContent = JSON.stringify(sanitizeSnapshotForDebug(snapshot), null, 2);
    if (panelBody && replaceContent) {
      panelBody.scrollTop = scrollTop;
      safeRequestAnimationFrame(() => {
        if (!destroyed && isModalOpen && panelBody) {
          panelBody.scrollTop = scrollTop;
        }
      });
    }
  };

  const toggleDailyDetails = (row) => {
    const date = row?.getAttribute('data-date');
    if (!date) return;
    const panelBody = row.closest('.panel-body');
    const scrollTop = panelBody?.scrollTop;
    const detailsRow = row.nextElementSibling;
    const isOpen = state.expandedDates.has(date);
    if (isOpen) state.expandedDates.delete(date);
    else state.expandedDates.add(date);
    row.classList.toggle('is-open', !isOpen);
    row.setAttribute('aria-expanded', String(!isOpen));
    const icon = row.querySelector('.expand-icon');
    if (icon) icon.textContent = isOpen ? '▶' : '▼';
    if (detailsRow?.matches('[data-role="day-details"]')) detailsRow.hidden = isOpen;
    if (panelBody && Number.isFinite(scrollTop)) {
      panelBody.scrollTop = scrollTop;
      safeRequestAnimationFrame(() => {
        if (!destroyed && isModalOpen && panelBody) {
          panelBody.scrollTop = scrollTop;
        }
      });
    }
  };

  const bindShadowEvents = () => {
    const shadowRoot = state.shadowRoot;
    if (!shadowRoot || state.shadowEventsBound) return;
    state.shadowEventsBound = true;
    const byId = (id) => shadowRoot.getElementById(id);

    shadowRoot.addEventListener('input', (e) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;
      if (target.id === 'startDate') {
        localStartDate = target.value;
        dateInputDirty = true;
      } else if (target.id === 'endDate') {
        localEndDate = target.value;
        dateInputDirty = true;
      }
    });

    shadowRoot.addEventListener('click', (e) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;
      const dailyRow = target.closest('[data-action="toggle-day"]');
      if (dailyRow) {
        toggleDailyDetails(dailyRow);
        return;
      }
      if (target.closest('#closeBtn')) {
        closeModal(true);
        return;
      }
      if (e.target === byId('modalBackdrop')) {
        closeModal(true);
        return;
      }
      if (target.closest('#personalViewBtn')) {
        if (state.viewMode !== 'personal') {
          state.expandedDates.clear();
          invokeSetView('personal');
        }
        return;
      }
      if (target.closest('#teamViewBtn')) {
        if (state.accountMode === 'personal') return;
        if (state.viewMode !== 'team') {
          state.expandedDates.clear();
          invokeSetView('team');
        }
        return;
      }
      if (target.closest('#loadBtn')) {
        const startVal = byId('startDate')?.value;
        const endVal = byId('endDate')?.value;
        try {
          validateRange(startVal, endVal);
          dateInputDirty = false;
          localStartDate = startVal;
          localEndDate = endVal;
          state.error = '';
          invokeLoad({ startDate: startVal, endDate: endVal });
        } catch (err) {
          state.error = err.message || String(err);
          updatePanel();
        }
        return;
      }
      if (target.closest('#cycleBtn')) {
        dateInputDirty = false;
        state.error = '';
        invokeLoad({ preset: 'cycle' });
        return;
      }
      if (target.closest('#sevenBtn')) {
        dateInputDirty = false;
        state.error = '';
        invokeLoad({ preset: '7d' });
        return;
      }
      if (target.closest('#thirtyBtn')) {
        dateInputDirty = false;
        state.error = '';
        invokeLoad({ preset: '30d' });
        return;
      }
      if (target.closest('#refreshBtn')) {
        dateInputDirty = false;
        state.error = '';
        if (state.selectedStartDate && state.selectedEndDate) {
          invokeLoad({ startDate: state.selectedStartDate, endDate: state.selectedEndDate });
        } else {
          invokeLoad({ preset: 'cycle' });
        }
        return;
      }
      if (target.closest('#csvBtn')) {
        triggerDownload('csv');
        return;
      }
      if (target.closest('#jsonBtn')) {
        triggerDownload('json');
        return;
      }
    });

    shadowRoot.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeModal(true);
        return;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        const target = e.target instanceof Element ? e.target : null;
        const dailyRow = target?.closest('[data-action="toggle-day"]');
        if (dailyRow) {
          e.preventDefault();
          toggleDailyDetails(dailyRow);
          return;
        }
      }
      if (e.key === 'Tab') {
        const modalCard = byId('modalCard');
        if (!modalCard) return;
        const focusable = modalCard.querySelectorAll('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])');
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && (shadowRoot.activeElement === first || document.activeElement === first)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (shadowRoot.activeElement === last || document.activeElement === last)) {
          e.preventDefault();
          first.focus();
        }
      }
    });
  };

  function normalizeLoadParams(rawParams = {}) {
    const viewMode = state.viewMode || snapshot.viewMode || 'personal';
    if (rawParams.preset === '7d' || rawParams.preset === '30d' || rawParams.preset === 'cycle') {
      return { preset: rawParams.preset, viewMode };
    }
    if (rawParams.startDate && rawParams.endDate && !rawParams.cycleDefault) {
      return { startDate: rawParams.startDate, endDate: rawParams.endDate, viewMode };
    }
    return { preset: 'cycle', viewMode };
  }

  function invokeLoad(rawParams) {
    if (destroyed || !isModalOpen) return Promise.resolve(null);
    const gen = modalGeneration;
    const params = normalizeLoadParams(rawParams);
    state.loading = true;
    state.error = '';
    updatePanel({ replaceContent: false });
    return Promise.resolve()
      .then(() => {
        if (destroyed || !isModalOpen || modalGeneration !== gen) return null;
        if (typeof options.onLoad !== 'function') return null;
        return options.onLoad(params);
      })
      .catch((err) => {
        if (destroyed || !isModalOpen || modalGeneration !== gen) return null;
        state.loading = false;
        state.error = (err && err.message) || '操作失败，请稍后重试';
        updatePanel();
        return null;
      });
  }

  function invokeSetView(mode) {
    if (destroyed || !isModalOpen) return Promise.resolve(null);
    const gen = modalGeneration;
    state.loading = true;
    state.error = '';
    // Awaits controller updates, preserve previous visible mode while loading
    updatePanel({ replaceContent: false });
    return Promise.resolve()
      .then(() => {
        if (destroyed || !isModalOpen || modalGeneration !== gen) return null;
        if (typeof options.onSetView !== 'function') return null;
        return options.onSetView(mode);
      })
      .catch((err) => {
        if (destroyed || !isModalOpen || modalGeneration !== gen) return null;
        state.loading = false;
        state.error = (err && err.message) || '操作失败，请稍后重试';
        updatePanel();
        return null;
      });
  }

  function triggerDownload(format) {
    if (destroyed || typeof options.onExport !== 'function') return;
    if (state.loading) return;
    Promise.resolve()
      .then(() => options.onExport(format))
      .then((res) => {
        if (destroyed || !res || !res.text) return;
        const blob = new Blob([res.text], { type: res.mime || (format === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8') });
        const url = URL.createObjectURL(blob);
        activeObjectUrls.add(url);
        const a = document.createElement('a');
        a.href = url;
        a.download = res.filename || (`team-usage.${format}`);
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
        state.error = '导出数据失败，请重试';
        updatePanel();
      });
  }

  function openModal() {
    if (destroyed || isModalOpen) return;
    modalGeneration++;

    // Read latest snapshot & bind account/data BEFORE setting isModalOpen & showPanelHost
    if (typeof options.getSnapshot === 'function') {
      try {
        const latest = options.getSnapshot();
        if (latest && typeof latest === 'object') {
          snapshot = latest;
          syncStateFromSnapshot();
        }
      } catch (_) {}
    }

    isModalOpen = true;
    showPanelHost();
    updatePanel();

    safeRequestAnimationFrame(() => {
      const closeBtn = state.shadowRoot?.getElementById('closeBtn');
      if (closeBtn && typeof closeBtn.focus === 'function') {
        closeBtn.focus();
      }
    });

    // If status is idle, always load cycle explicitly on open (ready cache allowed)
    if (snapshot.status === 'idle') {
      invokeLoad({ preset: 'cycle' });
    }
  }

  function closeModal(userInitiated = false) {
    if (!isModalOpen) return;
    isModalOpen = false;
    modalGeneration++;
    hidePanel();

    // Any close cancels current in-flight
    if (typeof options.onCancel === 'function' && state.loading) {
      try { options.onCancel(); } catch (_) {}
    }
    state.loading = false;

    // Refresh state from fresh snapshot if available
    if (typeof options.getSnapshot === 'function') {
      try {
        const fresh = options.getSnapshot();
        if (fresh && typeof fresh === 'object') {
          snapshot = fresh;
          syncStateFromSnapshot();
        }
      } catch (_) {}
    }

    // Only restore profile focus on USER intent
    if (userInitiated && lastFocusedTrigger && typeof lastFocusedTrigger.focus === 'function') {
      try { lastFocusedTrigger.focus(); } catch (_) {}
    }
  }

  function handleWindowKeyDown(e) {
    if (isModalOpen && e.key === 'Escape') {
      e.preventDefault();
      closeModal(true);
    }
  }
  window.addEventListener('keydown', handleWindowKeyDown);

  // Native account menu injection
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
  scheduleScan();

  function handleRouteChange() {
    if (isModalOpen) closeModal(false);
  }
  window.addEventListener('popstate', handleRouteChange);

  return {
    update(nextSnapshot) {
      if (destroyed || !nextSnapshot || typeof nextSnapshot !== 'object') return;

      const nextAcc = nextSnapshot.accountId !== undefined ? nextSnapshot.accountId : null;
      if (!initialAccountObserved) {
        currentActiveAccount = nextAcc;
        if (nextAcc !== null) {
          initialAccountObserved = true;
        }
      } else if (nextAcc !== currentActiveAccount) {
        currentActiveAccount = nextAcc;
        dateInputDirty = false;
        localStartDate = '';
        localEndDate = '';
        state.expandedDates.clear();
        if (isModalOpen) {
          closeModal(false);
        }
      }

      snapshot = nextSnapshot;
      syncStateFromSnapshot();

      // Snapshot updates during closed must not mount visible or call updatePanel
      if (isModalOpen) {
        updatePanel();
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
      window.removeEventListener('keydown', handleWindowKeyDown);

      if (host && host.parentNode) {
        try { host.parentNode.removeChild(host); } catch (_) {}
      }
    }
  };
}


function createTeamBillingController(onChange) {
  var API_TIMEOUT_MS = 18000;
  var DEADLINE_MS = 60000;
  var PAY_ORIGIN = 'https://pay.openai.com';
  var CHANNEL = 'chatgpt-scripts:official-billing';
  var VERSION = 1;
  var MISSING_ACCOUNT = '无法确认当前工作空间，请先切换到要查询的空间';
  var OFFICIAL_NOTICE = '读取自本次打开的官方账单页，预计金额可能随套餐或席位变化。';
  var HISTORY_NOTICE = '当前接口只返回历史发票；官方账单页可提供下一笔预计付款。';
  var win = typeof window === 'object' ? window : null;
  var doc = typeof document === 'object' ? document : null;
  var destroyed = false;
  var generation = 0;
  var active = null;
  var accountWatcher = null;
  var emitting = false;
  var emitPending = false;
  var state = makeState('idle', null, accountCookie(), [], false, null, '', null, null, null);

  function makeState(status, error, accountId, history, hasMore, manageUrl, notice, dateText, amountText, source) {
    return {
      status: status,
      error: error,
      accountId: accountId,
      upcomingAvailable: source === 'official-page',
      upcomingDateText: dateText,
      upcomingAmountText: amountText,
      source: source,
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
      upcomingAvailable: state.upcomingAvailable,
      upcomingDateText: state.upcomingDateText,
      upcomingAmountText: state.upcomingAmountText,
      source: state.source,
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
      accountWatcher = win.setInterval(accountAwareness, 1000);
    } else if ((destroyed || !shouldWatchAccount()) && accountWatcher !== null) {
      win.clearInterval(accountWatcher);
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
      try { onChange(snapshot()); } catch (ignored) {}
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
      try { value = decodeURIComponent(splitAt < 0 ? '' : parts[index].slice(splitAt + 1)).trim(); } catch (ignored) { return null; }
      while (value.length >= 2 && ((value[0] === '"' && value[value.length - 1] === '"') || (value[0] === "'" && value[value.length - 1] === "'"))) value = value.slice(1, -1).trim();
      if (!value || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) return null;
      try { encodeURIComponent(value); } catch (ignoredEncoding) { return null; }
      return value;
    }
    return null;
  }

  function safeManageUrl(accountId) {
    var origin = typeof location === 'object' && typeof location.origin === 'string' ? location.origin : '';
    if (origin !== 'https://chatgpt.com' && origin !== 'https://chat.openai.com') return null;
    return origin + '/account/manage?account_id=' + encodeURIComponent(accountId);
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

  function currencyCode(value) {
    if (typeof value !== 'string' || !/^[A-Za-z]{3}$/.test(value) || typeof Intl !== 'object' || typeof Intl.NumberFormat !== 'function') return null;
    var code = value.toUpperCase();
    try {
      if (typeof Intl.supportedValuesOf === 'function' && code !== 'ISK' && code !== 'UGX' && Intl.supportedValuesOf('currency').indexOf(code) === -1) return null;
      new Intl.NumberFormat('zh-CN', { style: 'currency', currency: code });
      return code;
    } catch (ignored) { return null; }
  }

  function money(value, currency) {
    if (!currency || !Number.isSafeInteger(value)) return null;
    try {
      var formatter = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: currency, currencyDisplay: 'code' });
      var digits = currency === 'ISK' || currency === 'UGX' ? 2 : formatter.resolvedOptions().maximumFractionDigits;
      return formatter.format(value / Math.pow(10, digits));
    } catch (ignored) { return null; }
  }

  function epoch(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return { iso: null, seconds: null };
    var date = new Date(value * 1000);
    return Number.isFinite(date.getTime()) ? { iso: date.toISOString(), seconds: value } : { iso: null, seconds: null };
  }

  function parseHistory(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.data)) throw { type: 'json' };
    var invoices = [];
    payload.data.forEach(function (row) {
      if (!row || typeof row !== 'object' || row.object !== 'invoice') return;
      var created = epoch(row.created);
      var currency = currencyCode(row.currency);
      var status = typeof row.status === 'string' && /^(draft|open|paid|uncollectible|void)$/i.test(row.status) ? row.status.toLowerCase() : 'unknown';
      invoices.push({ seconds: created.seconds, value: {
        createdAt: created.iso, periodStart: epoch(row.period_start).iso, periodEnd: epoch(row.period_end).iso,
        status: status, currency: currency, totalText: money(row.total, currency),
        amountDueText: money(row.amount_due, currency), amountPaidText: money(row.amount_paid, currency)
      } });
    });
    invoices.sort(function (left, right) {
      if (left.seconds === null) return right.seconds === null ? 0 : 1;
      if (right.seconds === null) return -1;
      return right.seconds - left.seconds;
    });
    return { history: invoices.slice(0, 10).map(function (entry) { return entry.value; }), hasMore: payload.has_more === true, unsupportedOnly: !!(payload.data.length && !invoices.length) };
  }

  async function getJson(url, options) {
    var response = await fetch(url, options);
    if (!response || response.status < 200 || response.status >= 300) throw { type: 'http', status: response ? response.status : 0 };
    try { return await response.json(); } catch (ignored) { throw { type: 'json' }; }
  }

  function requestError(error) {
    if (error && error.type === 'http') {
      if (error.status === 401) return '登录或会话已失效，请重新登录后重试';
      if (error.status === 403) return '无权限访问当前工作空间的账单记录';
      if (error.status === 429) return '请求过于频繁，请稍后重试';
      return '账单数据请求失败（HTTP ' + error.status + '）';
    }
    return error && error.type === 'json' ? '账单数据格式无效' : '无法加载账单数据，请稍后重试';
  }

  function createNonce() {
    var crypt = win && win.crypto;
    if (!crypt || typeof crypt.getRandomValues !== 'function') return null;
    var bytes = new Uint8Array(16);
    crypt.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (byte) { return ('0' + byte.toString(16)).slice(-2); }).join('');
  }

  function resolveRequest(request) {
    if (!request || request.resolved) return;
    request.resolved = true;
    request.resolve(snapshot());
  }

  function tellChildToStop(request) {
    if (!request || !request.navigated || !request.acked || !request.popup) return;
    try { request.popup.postMessage({ channel: CHANNEL, v: VERSION, type: 'cancel', nonce: request.nonce }, PAY_ORIGIN); } catch (ignored) {}
  }

  function detachRequest(request, closeNavigated) {
    if (!request || request.settled) return;
    request.settled = true;
    if (request.apiTimer) clearTimeout(request.apiTimer);
    if (request.deadlineTimer) clearTimeout(request.deadlineTimer);
    if (request.helloTimer) clearInterval(request.helloTimer);
    if (request.messageHandler && win) win.removeEventListener('message', request.messageHandler);
    try { request.controller.abort(); } catch (ignored) {}
    if (request.popup && (!request.navigated || closeNavigated)) {
      try { request.popup.close(); } catch (ignoredClose) {}
    }
    request.popup = null;
    if (active === request) active = null;
  }

  function stopActive() {
    if (!active) return null;
    var request = active;
    tellChildToStop(request);
    detachRequest(request, false);
    return request;
  }

  function resetForAccountChange() {
    var prior = stopActive();
    generation += 1;
    setState(makeState('idle', null, accountCookie(), [], false, null, '', null, null, null));
    emit();
    resolveRequest(prior);
  }

  function stillCurrent(request) {
    if (destroyed || request.generation !== generation || request.settled) return false;
    if (accountCookie() === request.accountId) return true;
    resetForAccountChange();
    return false;
  }

  function getSnapshot() {
    if (!destroyed && accountCookie() !== state.accountId) resetForAccountChange();
    return snapshot();
  }

  function finish(request, nextState, closeNavigated) {
    if (!stillCurrent(request)) return;
    setState(nextState);
    emit();
    detachRequest(request, closeNavigated);
    resolveRequest(request);
  }

  function finishError(request, message) {
    if (!stillCurrent(request)) return;
    var prior = state.accountId === request.accountId ? state : null;
    tellChildToStop(request);
    finish(request, makeState('error', message, request.accountId, prior ? prior.history : [], prior ? prior.hasMore : false,
      safeManageUrl(request.accountId), prior && prior.history.length ? prior.notice : '', null, null, null), false);
  }

  function validOfficialText(value, kind) {
    if (typeof value !== 'string' || value.length < 2 || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value) || !/\d/.test(value)) return false;
    var prefixes = kind === 'date'
      ? ['您的下一个账单日期是', '您的下一個帳單日期是', '您的下個帳單日期是', 'Your next invoice date', 'Your next bill date']
      : ['您的下一笔付款预计为', '您的下一筆付款預計為', '您的下筆付款預計為', 'Your next payment is estimated', 'Your next payment'];
    for (var index = 0; index < prefixes.length; index += 1) {
      if (value.slice(0, prefixes[index].length).toLowerCase() === prefixes[index].toLowerCase()) return true;
    }
    return false;
  }

  function messageFor(request, event) {
    if (!stillCurrent(request) || event.origin !== PAY_ORIGIN || event.source !== request.popup) return;
    var data = event.data;
    if (!isPlainObject(data) || data.channel !== CHANNEL || data.v !== VERSION || data.nonce !== request.nonce) return;
    if (data.type === 'ack') {
      request.acked = true;
      if (request.helloTimer) clearInterval(request.helloTimer);
      request.helloTimer = null;
      return;
    }
    if (!request.acked) return;
    if (data.type === 'result' && validOfficialText(data.dateText, 'date') && validOfficialText(data.amountText, 'amount')) {
      var prior = state.accountId === request.accountId ? state : null;
      finish(request, makeState('ready', null, request.accountId, prior ? prior.history : [], prior ? prior.hasMore : false,
        safeManageUrl(request.accountId), OFFICIAL_NOTICE, data.dateText, data.amountText, 'official-page'), true);
    } else if (data.type === 'error' || data.type === 'cancel') {
      finishError(request, '官方账单页未提供可读取的预计付款，请直接查看官方页面。');
    }
  }

  function sendHello(request) {
    if (!stillCurrent(request) || request.acked) return;
    try { request.popup.postMessage({ channel: CHANNEL, v: VERSION, type: 'hello', nonce: request.nonce }, PAY_ORIGIN); } catch (ignored) {}
  }

  function startHistory(request, headers) {
    getJson('/backend-api/invoices?limit=10&account_id=' + encodeURIComponent(request.accountId), {
      method: 'GET', credentials: 'include', cache: 'no-store', headers: headers, signal: request.controller.signal
    }).then(function (payload) {
      if (!stillCurrent(request)) return;
      var parsed = parseHistory(payload);
      if (request.settled || state.status !== 'loading') return;
      setState(makeState('loading', null, request.accountId, parsed.history, parsed.hasMore, safeManageUrl(request.accountId),
        HISTORY_NOTICE + (parsed.unsupportedOnly ? ' 当前接口未返回可识别的历史发票记录。' : ''), null, null, null));
      emit();
    }).catch(function () {
      // History is optional and must not delay or replace the official-page result.
    });
  }

  async function runLoad(request) {
    var token = '';
    var headers = null;
    try {
      if (!stillCurrent(request)) return;
      var session = await getJson('/api/auth/session', {
        method: 'GET', credentials: 'include', cache: 'no-store', headers: { Accept: 'application/json' }, signal: request.controller.signal
      });
      if (!stillCurrent(request)) return;
      token = session && typeof session.accessToken === 'string' ? session.accessToken.trim() : '';
      if (!token || /[\r\n]/.test(token)) return finishError(request, '登录或会话已失效，请重新登录后重试');
      headers = { Accept: 'application/json', Authorization: 'Bearer ' + token };
      var accounts = await getJson('/backend-api/accounts/check/v4-2023-04-27', {
        method: 'GET', credentials: 'include', cache: 'no-store', headers: headers, signal: request.controller.signal
      });
      if (!stillCurrent(request)) return;
      if (!accountMatches(accounts, request.accountId)) return finishError(request, '无法验证当前工作空间访问权限');
      if (request.apiTimer) clearTimeout(request.apiTimer);
      request.apiTimer = null;
      var manageUrl = safeManageUrl(request.accountId);
      if (!manageUrl) return finishError(request, '无法打开官方账单页，请直接查看官方页面。');
      startHistory(request, headers);
      request.messageHandler = function (event) { messageFor(request, event); };
      win.addEventListener('message', request.messageHandler);
      if (!stillCurrent(request)) return;
      try {
        request.popup.location = manageUrl;
        request.navigated = true;
      } catch (navigationError) {
        return finishError(request, '无法打开官方账单页，请直接查看官方页面。');
      }
      if (!stillCurrent(request)) return;
      sendHello(request);
      request.helloTimer = setInterval(function () { sendHello(request); }, 500);
    } catch (error) {
      if (!request.settled && stillCurrent(request)) finishError(request, requestError(error));
    } finally {
      token = '';
      if (headers) delete headers.Authorization;
      headers = null;
    }
  }

  function load() {
    if (destroyed) return Promise.resolve(snapshot());
    var startedAt = Date.now();
    var prior = stopActive();
    generation += 1;
    var accountId = accountCookie();
    if (!accountId) {
      setState(makeState('error', MISSING_ACCOUNT, null, [], false, null, '', null, null, null));
      emit();
      resolveRequest(prior);
      return Promise.resolve(snapshot());
    }
    var nonce = createNonce();
    if (!nonce || !win || typeof win.open !== 'function') {
      setState(makeState('error', '当前环境无法打开官方账单页，请稍后重试', accountId, [], false, safeManageUrl(accountId), '', null, null, null));
      emit();
      resolveRequest(prior);
      return Promise.resolve(snapshot());
    }
    var popup = win.open('about:blank', '_blank');
    if (!popup) {
      setState(makeState('error', '浏览器未允许打开官方账单页，请允许本站弹出窗口后重试。', accountId, [], false, safeManageUrl(accountId), '', null, null, null));
      emit();
      resolveRequest(prior);
      return Promise.resolve(snapshot());
    }
    if (typeof fetch !== 'function' || typeof AbortController === 'undefined') {
      try { popup.close(); } catch (ignored) {}
      setState(makeState('error', '当前环境无法加载账单数据，请稍后重试', accountId, [], false, safeManageUrl(accountId), '', null, null, null));
      emit();
      resolveRequest(prior);
      return Promise.resolve(snapshot());
    }
    var request = { generation: generation, accountId: accountId, popup: popup, navigated: false, nonce: nonce, acked: false,
      controller: new AbortController(), apiTimer: null, deadlineTimer: null, helloTimer: null, messageHandler: null, settled: false, resolved: false, resolve: null };
    request.promise = new Promise(function (resolve) { request.resolve = resolve; });
    active = request;
    request.apiTimer = setTimeout(function () {
      if (!request.settled && stillCurrent(request)) finishError(request, '请求超时（18 秒），请稍后重试');
    }, API_TIMEOUT_MS);
    request.deadlineTimer = setTimeout(function () {
      if (!request.settled && stillCurrent(request)) finishError(request, '官方页面与当前页面的连接已中断，请直接查看官方页面。');
    }, Math.max(0, DEADLINE_MS - (Date.now() - startedAt)));
    setState(makeState('loading', null, accountId, [], false, safeManageUrl(accountId), '', null, null, null));
    emit();
    runLoad(request);
    resolveRequest(prior);
    return request.promise;
  }

  function cancel() {
    if (destroyed || state.status !== 'loading') return snapshot();
    var request = stopActive();
    generation += 1;
    var currentAccountId = accountCookie();
    setState(makeState('idle', null, currentAccountId === state.accountId ? state.accountId : currentAccountId, [], false, null, '', null, null, null));
    emit();
    resolveRequest(request);
    return snapshot();
  }

  function accountAwareness() {
    if (!destroyed && accountCookie() !== state.accountId) resetForAccountChange();
  }

  if (win && typeof win.addEventListener === 'function') win.addEventListener('focus', accountAwareness);
  if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', accountAwareness);

  function destroy() {
    if (destroyed) return;
    var request = stopActive();
    destroyed = true;
    generation += 1;
    if (win) win.removeEventListener('focus', accountAwareness);
    if (doc) doc.removeEventListener('visibilitychange', accountAwareness);
    setState(makeState('idle', null, null, [], false, null, '', null, null, null));
    resolveRequest(request);
  }

  return { getSnapshot: getSnapshot, load: load, cancel: cancel, destroy: destroy };
}


/**
 * Team 助手 - 官方账单与下期预估 UI 模块 (mountTeamBillingPanel)
 * 提供“查看下月账单”原生样式按钮与原生 <dialog> 弹窗，呈现官方下期账单（下次日期与预计金额）及历史发票。
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
            upcomingDateText: null,
            upcomingAmountText: null,
            source: null,
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

    // Trigger 在 Light DOM 中渲染，直接复用页面原生管理席位按钮 class，继承原生背景色、边框、字体与悬停效果
    var btnHost = document.createElement('div');
    btnHost.setAttribute('data-team-billing-btn', '');
    btnHost.style.display = 'none';
    btnHost.style.alignItems = 'center';
    btnHost.style.margin = '0';
    btnHost.style.padding = '0';
    btnHost.style.lineHeight = '0';
    btnHost.style.flexShrink = '0';

    var triggerBtn = document.createElement('button');
    triggerBtn.type = 'button';
    triggerBtn.setAttribute('data-team-billing-trigger', '');
    triggerBtn.className = 'btn relative btn-secondary btn-large';
    triggerBtn.textContent = '查看下月账单';
    triggerBtn.setAttribute('aria-haspopup', 'dialog');
    triggerBtn.setAttribute('aria-expanded', 'false');
    triggerBtn.addEventListener('click', onTriggerClick);
    btnHost.appendChild(triggerBtn);

    // Panel 保持在独立 Shadow DOM 中，避免污染全局页面样式
    var panelHost = document.createElement('div');
    panelHost.setAttribute('data-team-billing-panel', '');
    (document.body || document.documentElement).appendChild(panelHost);

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
        .cg-tb-card { padding: 16px 18px; background: var(--tb-card-bg); border: 1px solid var(--tb-border-subtle); border-radius: 12px; display: flex; flex-direction: column; gap: 8px; }
        .cg-tb-card-head { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; color: var(--text-primary, var(--tb-text)); }
        .cg-tb-dot { width: 8px; height: 8px; border-radius: 50%; background: #f59e0b; flex-shrink: 0; }
        .cg-tb-dot.green { background: #22c55e; }
        .cg-tb-dot.blue { background: #3b82f6; }
        .cg-tb-dot.amber { background: #f59e0b; }
        .cg-tb-dot.gray { background: #8e8e8e; }
        .cg-tb-upcoming-row { display: flex; flex-direction: column; gap: 6px; margin: 4px 0; }
        .cg-tb-upcoming-date { font-size: 13.5px; color: var(--text-secondary, var(--tb-text-sec)); line-height: 1.4; }
        .cg-tb-upcoming-amount { font-size: 16px; font-weight: 600; color: var(--text-primary, var(--tb-text)); line-height: 1.4; font-variant-numeric: tabular-nums; }
        .cg-tb-card-desc { margin: 0; font-size: 12.5px; color: var(--text-secondary, var(--tb-text-sec)); line-height: 1.5; }
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

    // 坐标判断确保仅在点击背景遮罩区（而非内层卡片/边距）时关闭
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
    var noticeDot = el('span', 'cg-tb-dot');
    noticeHead.appendChild(noticeDot);
    var noticeHeadTitle = el('span', null, '下一期账单');
    noticeHead.appendChild(noticeHeadTitle);
    noticeCard.appendChild(noticeHead);

    var upcomingRow = el('div', 'cg-tb-upcoming-row');
    var upcomingDateEl = el('div', 'cg-tb-upcoming-date');
    var upcomingAmountEl = el('div', 'cg-tb-upcoming-amount');
    upcomingRow.appendChild(upcomingDateEl);
    upcomingRow.appendChild(upcomingAmountEl);
    noticeCard.appendChild(upcomingRow);

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
            if (b === triggerBtn || btnHost.contains(b) || panelHost.contains(b) || b.hasAttribute('data-team-billing-trigger')) continue;
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

        // 同步原生按钮的 className，保证原生一致的悬停态、间距与圆角
        if (anchor.manageButton.className && triggerBtn.className !== anchor.manageButton.className) {
            triggerBtn.className = anchor.manageButton.className;
        }

        if (anchor.manageButton.previousElementSibling !== btnHost) {
            anchor.container.insertBefore(btnHost, anchor.manageButton);
        }
        btnHost.style.display = 'inline-flex';
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
        titleEl.textContent = (st === 'loading') ? '正在读取官方下期账单…' : '下月账单查询';

        // 状态指示灯与主卡片内容更新
        noticeDot.className = 'cg-tb-dot';

        if (st === 'loading') {
            noticeHeadTitle.textContent = '正在读取官方下期账单…';
            noticeDot.classList.add('blue');
            upcomingRow.style.display = 'none';
            upcomingDateEl.textContent = '';
            upcomingAmountEl.textContent = '';
            noticeDesc.textContent = currentSnapshot.notice || '将打开官方账单页，只读取下次日期和预计金额。';
        } else if (currentSnapshot.upcomingAvailable === true && (currentSnapshot.upcomingDateText || currentSnapshot.upcomingAmountText)) {
            noticeHeadTitle.textContent = '下一期账单';
            noticeDot.classList.add('green');
            upcomingRow.style.display = 'flex';
            upcomingDateEl.textContent = currentSnapshot.upcomingDateText || '';
            upcomingAmountEl.textContent = currentSnapshot.upcomingAmountText || '';
            upcomingDateEl.style.display = currentSnapshot.upcomingDateText ? '' : 'none';
            upcomingAmountEl.style.display = currentSnapshot.upcomingAmountText ? '' : 'none';
            noticeDesc.textContent = currentSnapshot.notice || (currentSnapshot.source === 'official-page' ? '来自本次打开的官方账单页；预计金额可能变化' : '预计金额可能随席位调整变化。');
        } else if (st === 'error') {
            noticeHeadTitle.textContent = '暂未读取到下期账单';
            noticeDot.classList.add('amber');
            upcomingRow.style.display = 'none';
            upcomingDateEl.textContent = '';
            upcomingAmountEl.textContent = '';
            noticeDesc.textContent = currentSnapshot.notice || currentSnapshot.error || '未能读取到下期账单信息。';
        } else {
            noticeHeadTitle.textContent = '暂未读取到下期账单';
            noticeDot.classList.add('gray');
            upcomingRow.style.display = 'none';
            upcomingDateEl.textContent = '';
            upcomingAmountEl.textContent = '';
            noticeDesc.textContent = currentSnapshot.notice || '当前未读取到官方下期账单预估信息。可前往官方账单管理页查看。';
        }

        var safeManageUrl = validateManageUrl(currentSnapshot.manageUrl, currentAccountId);
        if (safeManageUrl) {
            manageLink.href = safeManageUrl;
            manageLink.style.display = '';
        } else {
            manageLink.style.display = 'none';
            manageLink.removeAttribute('href');
        }

        footInfo.textContent = currentSnapshot.updatedAt ? ('更新于 ' + formatDate(currentSnapshot.updatedAt)) : '';

        var sig = st + '|' + (currentSnapshot.updatedAt || '') + '|' + (currentSnapshot.history ? currentSnapshot.history.length : 0) + '|' + (currentSnapshot.error || '') + '|' + (currentSnapshot.hasMore ? 1 : 0) + '|' + (currentSnapshot.upcomingAvailable ? 1 : 0) + '|' + (currentSnapshot.upcomingDateText || '') + '|' + (currentSnapshot.upcomingAmountText || '');
        if (!force && sig === lastRenderSig) return;
        lastRenderSig = sig;

        while (stateContainer.firstChild) stateContainer.removeChild(stateContainer.firstChild);

        if (st === 'loading') {
            var loadingBox = el('div', 'cg-tb-state', '正在读取官方账单与历史记录…');
            loadingBox.setAttribute('role', 'status');
            loadingBox.setAttribute('aria-live', 'polite');
            stateContainer.appendChild(loadingBox);
        } else if (st === 'error') {
            var errorBox = el('div', 'cg-tb-state');
            errorBox.setAttribute('role', 'alert');
            errorBox.appendChild(el('span', null, currentSnapshot.error || '获取账单信息失败，请稍后重试'));
            var retryBtn = el('button', 'cg-tb-act-btn sec', '重试');
            retryBtn.type = 'button';
            retryBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                loadData();
            });
            errorBox.appendChild(retryBtn);

            if (safeManageUrl) {
                var errLink = el('a', 'cg-tb-act-btn pri', '前往官方账单管理 ↗');
                errLink.href = safeManageUrl;
                errLink.target = '_blank';
                errLink.rel = 'noopener noreferrer';
                errLink.style.marginTop = '8px';
                errorBox.appendChild(errLink);
            }
            stateContainer.appendChild(errorBox);
        } else {
            var historySec = el('div');
            historySec.appendChild(el('h3', 'cg-tb-sec-title', '历史发票'));

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
        render(true);

        var loadResult;
        try {
            // 同步直接调用 options.onLoad()，确保在当前用户点击手势内立即唤起弹窗预约桥接，不经任何 await/microtask/rAF
            loadResult = options.onLoad();
        } catch (err) {
            if (destroyed || !isOpen || gen !== queryGeneration) return;
            isLoading = false;
            currentSnapshot.status = 'error';
            currentSnapshot.error = (err && err.message) ? err.message : '获取账单信息失败，请稍后重试';
            render(true);
            return;
        }

        // 若同步执行中发生工作区切换导致弹窗关闭，立即中止
        if (destroyed || !isOpen || gen !== queryGeneration) {
            return;
        }

        Promise.resolve(loadResult).then(function(res) {
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
                render(true);
            }
        }).catch(function(err) {
            if (destroyed || !isOpen || gen !== queryGeneration) return;
            isLoading = false;
            currentSnapshot.status = 'error';
            currentSnapshot.error = (err && err.message) ? err.message : '获取账单信息失败，请稍后重试';
            render(true);
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


function runOfficialBillingReader() {
  var PAY_ORIGIN = 'https://pay.openai.com';
  var PARENT_ORIGINS = { 'https://chatgpt.com': true, 'https://chat.openai.com': true };
  var CHANNEL = 'chatgpt-scripts:official-billing';
  var VERSION = 1;
  var DATE_PREFIXES = ['您的下一个账单日期是', '您的下一個帳單日期是', '您的下個帳單日期是', 'Your next invoice date', 'Your next bill date'];
  var AMOUNT_PREFIXES = ['您的下一笔付款预计为', '您的下一筆付款預計為', '您的下筆付款預計為', 'Your next payment is estimated', 'Your next payment'];
  var doc = document;
  var parentWindow = null;
  var parentOrigin = null;
  var nonce = null;
  var observer = null;
  var idleTimer = null;
  var deadlineTimer = null;
  var debounceTimer = null;
  var stableTimer = null;
  var destroyed = false;
  var lastCandidate = null;

  if (location.origin !== PAY_ORIGIN || window.top !== window || !window.opener) return function () {};

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function validNonce(value) {
    return typeof value === 'string' && /^[a-f0-9]{32,128}$/i.test(value);
  }

  function clearTimers() {
    if (idleTimer) clearTimeout(idleTimer);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (debounceTimer) clearTimeout(debounceTimer);
    if (stableTimer) clearTimeout(stableTimer);
    idleTimer = deadlineTimer = debounceTimer = stableTimer = null;
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    clearTimers();
    window.removeEventListener('message', onMessage);
    window.removeEventListener('click', onUserChange, true);
    window.removeEventListener('change', onUserChange, true);
    window.removeEventListener('hashchange', onNavigation);
    window.removeEventListener('popstate', onNavigation);
    window.removeEventListener('pagehide', onNavigation);
    if (observer) observer.disconnect();
    observer = null;
    parentWindow = parentOrigin = nonce = null;
  }

  function send(type, fields) {
    if (destroyed || !parentWindow || !parentOrigin || !nonce) return;
    var message = { channel: CHANNEL, v: VERSION, type: type, nonce: nonce };
    if (fields) {
      if (fields.dateText) message.dateText = fields.dateText;
      if (fields.amountText) message.amountText = fields.amountText;
    }
    try { parentWindow.postMessage(message, parentOrigin); } catch (ignored) {}
  }

  function fail() {
    send('error');
    destroy();
  }

  function forbiddenElement(element) {
    for (var current = element; current && current.nodeType === 1; current = current.parentElement) {
      var tag = current.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'OPTION' || current.isContentEditable) return true;
      if (current.getAttribute('aria-hidden') === 'true' || current.hidden) return true;
      var style = window.getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return true;
    }
    return false;
  }

  function visibleShortText(element, prefixes) {
    if (!element || forbiddenElement(element) || !element.getClientRects().length) return null;
    var text = (element.textContent || '').trim();
    if (!text || text.length > 200 || !/\d/.test(text)) return null;
    for (var index = 0; index < prefixes.length; index += 1) {
      if (text.slice(0, prefixes[index].length).toLowerCase() === prefixes[index].toLowerCase()) return text;
    }
    return null;
  }

  function collect(prefixes) {
    var matches = [];
    var elements = doc.querySelectorAll('span, p');
    for (var index = 0; index < elements.length; index += 1) {
      var text = visibleShortText(elements[index], prefixes);
      if (text) matches.push({ element: elements[index], text: text });
    }
    return matches.filter(function (candidate, index) {
      for (var otherIndex = 0; otherIndex < matches.length; otherIndex += 1) {
        if (otherIndex !== index && matches[otherIndex].text === candidate.text && candidate.element.contains(matches[otherIndex].element)) return false;
      }
      return true;
    });
  }

  function sectionCandidate(dateElement, amountElement) {
    var dates = [];
    var current = dateElement;
    var depth;
    for (depth = 0; current && depth <= 10; depth += 1, current = current.parentElement) dates.push(current);
    current = amountElement;
    for (depth = 0; current && depth <= 10; depth += 1, current = current.parentElement) {
      if (dates.indexOf(current) === -1) continue;
      if (current.tagName !== 'DIV') return null;
      var tag = current.tagName.toLowerCase();
      var identity = (current.id + ' ' + current.className).toLowerCase();
      if (tag === 'body' || tag === 'html' || tag === 'main' || tag === 'dialog' || current.getAttribute('role') === 'main' || /(^|\s)(app|root)(\s|$)/.test(identity)) return null;
      if (!/(^|\s)Box-root(\s|$)/.test(current.className) || !/(^|\s)Flex-direction--column(\s|$)/.test(current.className)) return null;
      if (forbiddenElement(current) || !current.getClientRects().length) return null;
      var length = (current.textContent || '').trim().length;
      if (length > 0 && length <= 1000) return current;
    }
    return null;
  }

  function readCandidate() {
    var dates = collect(DATE_PREFIXES);
    var amounts = collect(AMOUNT_PREFIXES);
    if (dates.length !== 1 || amounts.length !== 1) return null;
    var section = sectionCandidate(dates[0].element, amounts[0].element);
    if (!section) return null;
    return { dateText: dates[0].text, amountText: amounts[0].text, section: section };
  }

  function sameCandidate(left, right) {
    return left && right && left.dateText === right.dateText && left.amountText === right.amountText && left.section === right.section;
  }

  function scheduleScan() {
    if (destroyed || debounceTimer || stableTimer) return;
    debounceTimer = setTimeout(function () {
      debounceTimer = null;
      scan();
    }, 100);
  }

  function scan() {
    if (destroyed || !parentWindow) return;
    var candidate;
    try { candidate = readCandidate(); } catch (ignored) { return fail(); }
    if (!candidate) {
      lastCandidate = null;
      return;
    }
    if (!lastCandidate) {
      lastCandidate = candidate;
      stableTimer = setTimeout(function () {
        stableTimer = null;
        scan();
      }, 200);
      return;
    }
    if (sameCandidate(lastCandidate, candidate)) {
      send('result', candidate);
      destroy();
    } else {
      lastCandidate = candidate;
      stableTimer = setTimeout(function () {
        stableTimer = null;
        scan();
      }, 200);
    }
  }

  function onMutation() {
    lastCandidate = null;
    if (stableTimer) {
      clearTimeout(stableTimer);
      stableTimer = null;
    }
    scheduleScan();
  }

  function onUserChange(event) {
    if (parentWindow && event.isTrusted) fail();
  }

  function onNavigation() {
    if (parentWindow) fail();
  }

  function beginCapture() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    deadlineTimer = setTimeout(fail, 60000);
    window.addEventListener('click', onUserChange, true);
    window.addEventListener('change', onUserChange, true);
    window.addEventListener('hashchange', onNavigation);
    window.addEventListener('popstate', onNavigation);
    window.addEventListener('pagehide', onNavigation);
    observer = new MutationObserver(onMutation);
    observer.observe(doc.documentElement, { childList: true, subtree: true, characterData: true });
    scan();
  }

  function onMessage(event) {
    var data = event.data;
    if (destroyed || !isObject(data) || data.channel !== CHANNEL || data.v !== VERSION || !validNonce(data.nonce)) return;
    if (!parentWindow) {
      if (data.type !== 'hello') return;
      if (!PARENT_ORIGINS[event.origin] || event.source !== window.opener) return;
      parentWindow = event.source;
      parentOrigin = event.origin;
      nonce = data.nonce;
      send('ack');
      beginCapture();
    } else if (event.origin === parentOrigin && event.source === parentWindow && data.nonce === nonce) {
      if (data.type === 'hello') send('ack');
      else if (data.type === 'cancel') destroy();
    }
  }

  window.addEventListener('message', onMessage);
  idleTimer = setTimeout(destroy, 90000);
  return destroy;
}

let view=null,seatToast=null,lastSeatAccountId=null,usageView=null,billingView=null,usageController=null,billingController=null;
const monitor=createSeatHistoryMonitor(snapshot=>{if(seatToast&&snapshot.accountId!==lastSeatAccountId)seatToast.clear();lastSeatAccountId=snapshot.accountId;if(view)view.update(snapshot);},event=>{if(seatToast)seatToast.show(event);});
let mounted=false;
function mountWhenReady(){
  if(mounted||!document.body)return;
  mounted=true;
  try { startNoticeHiding(); } catch { console.warn('[Team Assistant] Notice hiding unavailable.'); }
  try { seatToast=mountSeatPolicyToast({getAccountId:()=>monitor.getSnapshot().accountId}); } catch { console.warn('[Team Assistant] Seat policy toast unavailable.'); }
  try { view=mountSeatHistoryPanel({getSnapshot:monitor.getSnapshot,onClearCurrent:monitor.clearCurrentHistory});view.update(monitor.getSnapshot()); } catch { console.warn('[Team Assistant] Seat history panel unavailable.'); }
  try { usageController=createTeamUsageController(s=>{if(usageView)usageView.update(s)});usageView=mountTeamUsagePanel({getSnapshot:usageController.getSnapshot,onLoad:usageController.load,onSetView:usageController.setViewMode,onCancel:usageController.cancel,onExport:usageController.buildExport});usageView.update(usageController.getSnapshot()); } catch { try { if(usageController)usageController.destroy(); } catch {} usageController=null;usageView=null;console.warn('[Team Assistant] Usage panel unavailable.'); }
  try { billingController=createTeamBillingController(s=>{if(billingView)billingView.update(s)});billingView=mountTeamBillingPanel({getSnapshot:billingController.getSnapshot,onLoad:billingController.load,onCancel:billingController.cancel});billingView.update(billingController.getSnapshot()); } catch { try { if(billingController)billingController.destroy(); } catch {} billingController=null;billingView=null;console.warn('[Team Assistant] Billing panel unavailable.'); }
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mountWhenReady,{once:true});else mountWhenReady();
})();
