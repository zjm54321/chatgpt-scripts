// ==UserScript==
// @name         Team 助手
// @namespace    https://github.com/zjm54321/chatgpt-scripts
// @version      v2026.09.07-1
// @description  仅隐藏工作区用量上限与自动充值提醒，不修改额度或计费设置。
// @author       zjm54321
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        none
// @run-at       document-idle
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
})();
