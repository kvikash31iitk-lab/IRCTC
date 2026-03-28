// ==UserScript==
// @name         IRCTC Helper Prefill
// @namespace    local.irctc.helper
// @version      2.8.3
// @description  Fetches a saved preset from your local IRCTC Helper app and fills visible passenger/contact fields after you log in.
// @match        https://www.irctc.co.in/*
// @downloadURL  http://127.0.0.1:5000/tampermonkey/irctc-helper.user.js
// @updateURL    http://127.0.0.1:5000/tampermonkey/irctc-helper.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      127.0.0.1
// @connect      localhost
// @connect      www.irctc.co.in
// @connect      irctc.co.in
// ==/UserScript==

(function () {
  "use strict";

  const LEGACY_STORAGE_KEY = "irctc-helper-selected-preset";
  const LAST_USED_KEY = "irctc-helper-last-used-preset";
  const SESSION_KEY = "irctc-helper-session-preset";
  const API_BASE = "http://127.0.0.1:5000/api";
  let loginWatcherId = null;
  let homeFlowStarted = false;

  const SELECTORS = {
    from: [
      "input[placeholder='From']",
      "input[role='searchbox'][aria-label*='From station']",
      "input[aria-label*='From station']",
      "input[aria-label='From']",
      "input[formcontrolname='origin']",
    ],
    to: [
      "input[placeholder='To']",
      "input[role='searchbox'][aria-label*='To station']",
      "input[aria-label*='To station']",
      "input[aria-label='To']",
      "input[formcontrolname='destination']",
    ],
    journeyDate: [
      ".ui-calendar input[type='text']",
      "input[placeholder*='DD/MM/YYYY']",
      "input[formcontrolname='journeyDate']",
    ],
    classDropdown: [
      "p-dropdown[formcontrolname='journeyClass']",
      "p-dropdown[aria-label*='Class']",
    ],
    quotaDropdown: [
      "p-dropdown[formcontrolname='quota']",
      "p-dropdown[aria-label*='Quota']",
      "p-dropdown[formcontrolname='journeyQuota']",
    ],
    mobile: [
      "input[name='mobileNo']",
      "input[formcontrolname='mobileNumber']",
      "input[placeholder*='Mobile']",
      "input[type='tel']",
    ],
    email: [
      "input[name='email']",
      "input[formcontrolname='email']",
      "input[placeholder*='Email']",
      "input[type='email']",
    ],
    passengerName: [
      "input[name='passengerName{n}']",
      "input[formcontrolname='passengerName']",
      "input[placeholder*='Passenger Name']",
    ],
    passengerAge: [
      "input[name='passengerAge{n}']",
      "input[formcontrolname='passengerAge']",
      "input[placeholder='Age']",
      "input[placeholder*='Age']",
    ],
    passengerGender: [
      "select[name='passengerGender{n}']",
      "select[formcontrolname='passengerGender']",
    ],
    passengerBerth: [
      "select[name='passengerBerthChoice{n}']",
      "select[formcontrolname='berthChoice']",
      "select[aria-label*='Berth']",
    ],
  };

  function requestJson(url, options = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: options.method || "GET",
        url,
        headers: {
          Accept: "application/json",
          ...(options.headers || {}),
        },
        onload: (response) => {
          try {
            const payload = response.responseText?.trim()
              ? JSON.parse(response.responseText)
              : null;

            if (response.status >= 400) {
              reject(new Error(payload?.error || `Request failed with status ${response.status}`));
              return;
            }

            resolve(payload);
          } catch (error) {
            reject(error);
          }
        },
        onerror: reject,
      });
    });
  }

  function getLocalStorageItem(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (_error) {
      return null;
    }
  }

  function setLocalStorageItem(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (_error) {
      // Ignore storage failures.
    }
  }

  function removeLocalStorageItem(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (_error) {
      // Ignore storage failures.
    }
  }

  function getSessionStorageItem(key) {
    try {
      return window.sessionStorage.getItem(key);
    } catch (_error) {
      return null;
    }
  }

  function setSessionStorageItem(key, value) {
    try {
      window.sessionStorage.setItem(key, value);
    } catch (_error) {
      // Ignore storage failures.
    }
  }

  function removeSessionStorageItem(key) {
    try {
      window.sessionStorage.removeItem(key);
    } catch (_error) {
      // Ignore storage failures.
    }
  }

  function migrateLegacyPresetStorage() {
    const legacyPresetId = getLocalStorageItem(LEGACY_STORAGE_KEY);
    if (!legacyPresetId) {
      return;
    }

    if (!getLocalStorageItem(LAST_USED_KEY)) {
      setLocalStorageItem(LAST_USED_KEY, legacyPresetId);
    }
    removeLocalStorageItem(LEGACY_STORAGE_KEY);
  }

  function getLastUsedPresetId() {
    return getLocalStorageItem(LAST_USED_KEY);
  }

  function getActivePresetId() {
    return getSessionStorageItem(SESSION_KEY);
  }

  function setActivePresetId(presetId) {
    if (!presetId) {
      return;
    }

    setSessionStorageItem(SESSION_KEY, presetId);
    setLocalStorageItem(LAST_USED_KEY, presetId);
  }

  function clearActivePresetId() {
    removeSessionStorageItem(SESSION_KEY);
  }

  function normalize(value) {
    return String(value ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function visible(element) {
    if (!element) {
      return false;
    }
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function queryVisible(root, selector) {
    return [...root.querySelectorAll(selector)].filter(visible);
  }

  function resolveRenderedDropdown(node) {
    if (!node) {
      return null;
    }

    if (node.matches?.(".ui-dropdown, .p-dropdown")) {
      return node;
    }

    return node.querySelector?.(".ui-dropdown, .p-dropdown") || node;
  }

  function getSearchPanelRoot() {
    const actionButton = [...document.querySelectorAll("button, a")].filter((node) => {
      if (!visible(node)) {
        return false;
      }

      const text = normalize(node.textContent);
      return text.includes("modify search") || text.includes("search trains");
    })[0];

    let current = actionButton;
    while (current) {
      const searchboxes = queryVisible(current, "input[role='searchbox']").length;
      const dateInputs = queryVisible(current, ".ui-calendar input[type='text'], input[type='text']")
        .filter((node) => node.getAttribute("role") !== "searchbox").length;
      const dropdowns = queryVisible(current, ".ui-dropdown, .p-dropdown").length;

      if (searchboxes >= 2 && dateInputs >= 1 && dropdowns >= 2) {
        return current;
      }

      current = current.parentElement;
    }

    return document;
  }

  function findElement(patterns, index = 1, root = document) {
    for (const pattern of patterns) {
      const selector = pattern.replaceAll("{n}", String(index));
      const matches = queryVisible(root, selector);
      if (matches.length > 0) {
        return matches[Math.min(index - 1, matches.length - 1)];
      }
    }
    return null;
  }

  function findSearchboxByOrder(orderIndex, root = document) {
    const matches = queryVisible(root, "input[role='searchbox']");
    return matches[orderIndex] || null;
  }

  function findDateInput(root = document) {
    const matches = queryVisible(root, ".ui-calendar input[type='text'], input[type='text']")
      .filter((node) => node.getAttribute("role") !== "searchbox");
    return matches[0] || null;
  }

  function findDropdownByOrder(orderIndex, root = document) {
    const matches = queryVisible(root, ".ui-dropdown, .p-dropdown");
    return matches[orderIndex] || null;
  }

  function stationTokens(value) {
    const raw = String(value ?? "").trim();
    if (!raw) {
      return [];
    }

    const tokens = [raw];
    const codeMatch = raw.match(/\b[A-Z]{2,5}\b/g);
    if (codeMatch) {
      tokens.push(...codeMatch);
    }

    if (raw.includes("-")) {
      tokens.push(raw.split("-")[0].trim());
      tokens.push(raw.split("-").slice(1).join("-").trim());
    }

    return [...new Set(tokens.map(normalize).filter(Boolean))];
  }

  function setNativeValue(element, value) {
    if (!element || value === undefined || value === null || value === "") {
      return false;
    }

    const descriptor = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(element),
      "value"
    );

    if (descriptor && descriptor.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }

    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new InputEvent("input", { bubbles: true, data: String(value), inputType: "insertText" }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new Event("blur", { bubbles: true }));
    return true;
  }

  function clearNativeValue(element) {
    if (!element) {
      return false;
    }

    const descriptor = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(element),
      "value"
    );

    if (descriptor && descriptor.set) {
      descriptor.set.call(element, "");
    } else {
      element.value = "";
    }

    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  async function typeNativeValue(element, value, delayMs = 28, options = {}) {
    if (!element || value === undefined || value === null || value === "") {
      return false;
    }

    const { confirmKey = null, blurAfter = false } = options;
    const text = String(value);
    const descriptor = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(element),
      "value"
    );

    element.readOnly = false;
    element.removeAttribute?.("readonly");
    element.focus();
    element.click();
    if (typeof element.select === "function") {
      element.select();
    }

    clearNativeValue(element);
    await sleep(90);

    let current = "";
    for (const char of text) {
      current += char;
      element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: char }));
      element.dispatchEvent(new KeyboardEvent("keypress", { bubbles: true, key: char }));

      if (descriptor && descriptor.set) {
        descriptor.set.call(element, current);
      } else {
        element.value = current;
      }

      element.dispatchEvent(new InputEvent("input", { bubbles: true, data: char, inputType: "insertText" }));
      element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: char }));
      await sleep(delayMs);
    }

    element.setAttribute("value", text);
    element.dispatchEvent(new Event("change", { bubbles: true }));

    if (confirmKey) {
      triggerKeyboardSequence(element, confirmKey);
    }

    if (blurAfter) {
      element.dispatchEvent(new Event("blur", { bubbles: true }));
    }

    await sleep(180);

    return normalize(textFromNode(element)) === normalize(text);
  }

  function triggerKeyboardSequence(element, key) {
    element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
    element.dispatchEvent(new KeyboardEvent("keypress", { bubbles: true, key }));
    element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key }));
  }

  function closeOpenOverlays() {
    document.body.click();
    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    document.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Escape" }));
  }

  function setSelectByText(select, text) {
    if (!select || !text) {
      return false;
    }

    const target = normalize(text);
    const option =
      [...select.options].find((item) => normalize(item.textContent) === target) ||
      [...select.options].find((item) => normalize(item.value) === target) ||
      [...select.options].find((item) => normalize(item.textContent).includes(target));

    if (!option) {
      return false;
    }

    select.value = option.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function parseJourneyDateParts(value) {
    if (!value) {
      return null;
    }

    const isoMatch = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoMatch) {
      return {
        year: Number(isoMatch[1]),
        monthIndex: Number(isoMatch[2]) - 1,
        day: Number(isoMatch[3]),
      };
    }

    const slashMatch = String(value).trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (slashMatch) {
      return {
        year: Number(slashMatch[3]),
        monthIndex: Number(slashMatch[2]) - 1,
        day: Number(slashMatch[1]),
      };
    }

    return null;
  }

  function todayIsoLocal() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function isPastJourneyDate(value) {
    const parts = parseJourneyDateParts(value);
    if (!parts) {
      return false;
    }

    const candidate = `${parts.year}-${String(parts.monthIndex + 1).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
    return candidate < todayIsoLocal();
  }

  function monthIndexFromText(value) {
    const raw = normalize(value);
    const months = [
      "jan",
      "feb",
      "mar",
      "apr",
      "may",
      "jun",
      "jul",
      "aug",
      "sep",
      "oct",
      "nov",
      "dec",
    ];

    return months.findIndex((month) => raw.includes(month));
  }

  function getDateInputContainer(input) {
    if (!input) {
      return null;
    }

    return input.closest(".ui-calendar, .p-calendar, p-calendar") || input.parentElement || null;
  }

  function getVisibleCalendarPanel() {
    const panels = [
      ...document.querySelectorAll(
        ".ui-datepicker, .p-datepicker, .p-datepicker-panel"
      ),
    ].filter((panel) => {
      if (!visible(panel)) {
        return false;
      }

      return Boolean(
        panel.querySelector?.(
          ".ui-datepicker-title, .p-datepicker-title, .ui-datepicker-month, .p-datepicker-month, table, td"
        )
      );
    });

    return panels[panels.length - 1] || null;
  }

  function getCalendarNav(panel, direction) {
    if (!panel) {
      return null;
    }

    const selectors = direction === "next"
      ? [
          ".ui-datepicker-next",
          ".p-datepicker-next",
          "button[aria-label*='Next']",
          "a[aria-label*='Next']",
          ".ui-datepicker-next-icon",
          ".p-datepicker-next-icon",
          ".pi-chevron-right",
        ]
      : [
          ".ui-datepicker-prev",
          ".p-datepicker-prev",
          "button[aria-label*='Previous']",
          "a[aria-label*='Previous']",
          "button[aria-label*='Prev']",
          "a[aria-label*='Prev']",
          ".ui-datepicker-prev-icon",
          ".p-datepicker-prev-icon",
          ".pi-chevron-left",
        ];

    for (const selector of selectors) {
      const match = [...panel.querySelectorAll(selector)].find(visible);
      if (match) {
        return resolveClickable(match, panel);
      }
    }

    return null;
  }

  async function openJourneyCalendar(root = document) {
    const input = findDateInput(root);
    if (!input) {
      return null;
    }

    const clickTargets = [
      input,
      getDateInputContainer(input),
      getDateInputContainer(input)?.querySelector?.(
        "button, .ui-datepicker-trigger, .p-datepicker-trigger, .ui-button, .p-button, .pi-calendar"
      ),
    ].filter(Boolean);

    for (const target of clickTargets) {
      triggerUiClick(target);
      await sleep(220);

      const panel = getVisibleCalendarPanel();
      if (panel) {
        return panel;
      }
    }

    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown", altKey: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "ArrowDown", altKey: true }));
    await sleep(220);
    return getVisibleCalendarPanel();
  }

  function readCalendarMonthYear(panel) {
    if (!panel) {
      return null;
    }

    const monthNode = panel.querySelector(".ui-datepicker-month, .p-datepicker-month");
    const yearNode = panel.querySelector(".ui-datepicker-year, .p-datepicker-year");
    const titleNode = panel.querySelector(".ui-datepicker-title, .p-datepicker-title");

    const monthText = textFromNode(monthNode) || textFromNode(titleNode);
    const yearText = textFromNode(yearNode) || textFromNode(titleNode);
    const monthIndex = monthIndexFromText(monthText);
    const yearMatch = yearText.match(/\b(20\d{2})\b/);

    if (monthIndex < 0 || !yearMatch) {
      return null;
    }

    return {
      monthIndex,
      year: Number(yearMatch[1]),
    };
  }

  async function moveCalendarToMonth(panel, target) {
    for (let attempt = 0; attempt < 18; attempt += 1) {
      const current = readCalendarMonthYear(panel);
      if (!current) {
        return false;
      }

      if (current.year === target.year && current.monthIndex === target.monthIndex) {
        return true;
      }

      const goNext =
        current.year < target.year ||
        (current.year === target.year && current.monthIndex < target.monthIndex);

      const nav = getCalendarNav(panel, goNext ? "next" : "prev");

      if (!nav) {
        return false;
      }

      triggerUiClick(nav);
      await sleep(320);
      panel = getVisibleCalendarPanel() || panel;

      const updated = readCalendarMonthYear(panel);
      if (
        updated &&
        updated.year === current.year &&
        updated.monthIndex === current.monthIndex
      ) {
        await sleep(320);
        panel = getVisibleCalendarPanel() || panel;
      }
    }

    return false;
  }

  function findCalendarDay(panel, targetDay) {
    if (!panel) {
      return null;
    }

    const cells = [...panel.querySelectorAll("td, a, span, button")].filter((node) => {
      if (!visible(node)) {
        return false;
      }

      const text = normalize(node.textContent);
      const disabled =
        normalize(node.className).includes("disabled") ||
        normalize(node.className).includes("unselectable") ||
        node.getAttribute("aria-disabled") === "true";

      if (disabled) {
        return false;
      }

      return text === String(targetDay);
    });

    if (cells.length === 0) {
      return null;
    }

    const preferred = cells.find((node) => node.matches?.("a, button, span")) || cells[0];
    return resolveClickable(preferred, panel);
  }

  async function tryCalendarJourneyDate(value, root = document) {
    const input = findDateInput(root);
    const target = parseJourneyDateParts(value);
    if (!input || !target) {
      return false;
    }

    let panel = await openJourneyCalendar(root);
    if (!panel) {
      return false;
    }

    if (!(await moveCalendarToMonth(panel, target))) {
      closeOpenOverlays();
      return false;
    }

    panel = getVisibleCalendarPanel() || panel;
    const day = findCalendarDay(panel, target.day);
    if (!day) {
      closeOpenOverlays();
      return false;
    }

    day.click();
    await sleep(300);
    return matchesDateValue(textFromNode(input), value);
  }

  function findPrimeDropdown(patterns, root = document) {
    for (const selector of patterns) {
      const matches = queryVisible(root, selector).map(resolveRenderedDropdown).filter(Boolean);
      if (matches.length > 0) {
        return matches[0];
      }
    }

    return null;
  }

  async function setPrimeAutocomplete(patterns, value, root = document) {
    let input = findElement(patterns, 1, root);
    if (!input && patterns === SELECTORS.from) {
      input = findSearchboxByOrder(0, root);
    }
    if (!input && patterns === SELECTORS.to) {
      input = findSearchboxByOrder(1, root);
    }
    if (!input || !value) {
      return false;
    }

    input.focus();
    input.click();
    if (typeof input.select === "function") {
      input.select();
    }
    clearNativeValue(input);
    await sleep(100);
    setNativeValue(input, value);
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "ArrowDown" }));
    await sleep(1200);

    const candidates = [
      ...document.querySelectorAll("li[role='option'], .ui-autocomplete-item, .p-autocomplete-item"),
    ].filter(visible);

    const candidateNodes = [
      ...document.querySelectorAll(
        "li[role='option'] span, .ui-autocomplete-item span, .p-autocomplete-item span"
      ),
    ].filter(visible);

    const targets = stationTokens(value);
    const option =
      candidateNodes.find((item) => {
        const text = normalize(item.textContent);
        return targets.some((target) => text.startsWith(target) || text.includes(target));
      }) ||
      candidates.find((item) => {
        const text = normalize(item.textContent);
        return targets.some((target) => text.startsWith(target) || text.includes(target));
      });

    if (option) {
      const clickable =
        option.closest("li[role='option'], .ui-autocomplete-item, .p-autocomplete-item") || option;
      clickable.click();
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
      return true;
    }

    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter" }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  async function setPrimeDropdown(patterns, text, root = document) {
    if (!text) {
      return false;
    }

    let dropdown = findPrimeDropdown(patterns, root);
    if (!dropdown && patterns === SELECTORS.classDropdown) {
      dropdown = findDropdownByOrder(0, root);
    }
    if (!dropdown && patterns === SELECTORS.quotaDropdown) {
      dropdown = findDropdownByOrder(1, root);
    }
    if (!dropdown) {
      return false;
    }

    const trigger =
      dropdown.querySelector(".ui-dropdown-trigger, .p-dropdown-trigger, .ui-dropdown-label, .p-dropdown-label") ||
      dropdown;
    trigger.click();
    await sleep(700);

    const options = [
      ...document.querySelectorAll("li[role='option'], .p-dropdown-item, .ui-dropdown-item"),
    ].filter(visible);

    const target = normalize(text);
    const option =
      options.find((item) => normalize(item.getAttribute("aria-label")).includes(target)) ||
      options.find((item) => normalize(item.textContent) === target) ||
      options.find((item) => normalize(item.textContent).includes(target));

    if (!option) {
      closeOpenOverlays();
      return false;
    }

    option.click();
    await sleep(200);
    closeOpenOverlays();
    return true;
  }

  async function setJourneyDate(value, root = document) {
    const input = findDateInput(root);
    if (!input || !value) {
      return false;
    }

    const formatted = formatDate(value);

    if (await typeNativeValue(input, formatted, 28, { confirmKey: "Enter" })) {
      await sleep(900);
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
      await sleep(220);

      if (matchesDateValue(textFromNode(input), value)) {
        return true;
      }
    }

    if (await tryCalendarJourneyDate(value, root)) {
      return true;
    }

    input.readOnly = false;
    input.removeAttribute?.("readonly");
    input.focus();
    input.click();
    if (typeof input.select === "function") {
      input.select();
    }
    clearNativeValue(input);
    await sleep(100);
    setNativeValue(input, formatted);
    input.setAttribute("value", formatted);
    triggerKeyboardSequence(input, "Enter");
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("blur", { bubbles: true }));
    await sleep(150);
    return normalize(textFromNode(input)) === normalize(formatted);
  }

  function mapClassLabel(value) {
    const raw = String(value ?? "").trim();
    const lookup = {
      "ALL CLASSES": "All Classes",
      "EA": "Anubhuti Class (EA)",
      "1A": "AC First Class (1A)",
      "EV": "Vistadome AC (EV)",
      "EC": "Exec. Chair Car (EC)",
      "2A": "AC 2 Tier (2A)",
      "FC": "First Class (FC)",
      "3A": "AC 3 Tier (3A)",
      "3E": "AC 3 Economy (3E)",
      "VC": "Vistadome Chair Car (VC)",
      "CC": "AC Chair car (CC)",
      "SL": "Sleeper (SL)",
      "VS": "Vistadome Non AC (VS)",
      "2S": "Second Sitting (2S)",
    };
    return lookup[raw.toUpperCase()] || raw;
  }

  function classSearchTokens(value) {
    const mapped = mapClassLabel(value);
    const raw = String(value ?? "").trim().toUpperCase();
    const tokens = [mapped, raw];

    const aliases = {
      "SL": ["Sleeper (SL)", "Sleeper"],
      "3A": ["AC 3 Tier (3A)", "3A"],
      "2A": ["AC 2 Tier (2A)", "2A"],
      "1A": ["AC First Class (1A)", "1A"],
      "3E": ["AC 3 Economy (3E)", "3E"],
      "CC": ["AC Chair car (CC)", "Chair car", "CC"],
      "EC": ["Exec. Chair Car (EC)", "EC"],
      "2S": ["Second Sitting (2S)", "2S"],
      "FC": ["First Class (FC)", "FC"],
      "EA": ["Anubhuti Class (EA)", "EA"],
      "VC": ["Vistadome Chair Car (VC)", "VC"],
      "EV": ["Vistadome AC (EV)", "EV"],
      "VS": ["Vistadome Non AC (VS)", "VS"],
    };

    if (aliases[raw]) {
      tokens.push(...aliases[raw]);
    }

    return [...new Set(tokens.map(normalize).filter(Boolean))];
  }

  function mapQuotaLabel(value) {
    const raw = String(value ?? "").trim();
    const lookup = {
      "GENERAL": "GENERAL",
      "LADIES": "LADIES",
      "LOWER BERTH/SR.CITIZEN": "LOWER BERTH/SR.CITIZEN",
      "PERSON WITH DISABILITY": "PERSON WITH DISABILITY",
      "PHYSICALLY HANDICAPPED": "PERSON WITH DISABILITY",
      "DUTY PASS": "DUTY PASS",
      "TATKAL": "TATKAL",
      "PREMIUM TATKAL": "PREMIUM TATKAL",
    };
    return lookup[raw.toUpperCase()] || raw;
  }

  async function fillSearchForm(preset) {
    const applyFields = async (root) => {
      await setPrimeAutocomplete(SELECTORS.from, preset.from_station, root);
      await sleep(100);
      await setPrimeAutocomplete(SELECTORS.to, preset.to_station, root);
      await sleep(100);
      await setJourneyDate(preset.journey_date, root);
      await sleep(100);
      await setPrimeDropdown(SELECTORS.classDropdown, mapClassLabel(preset.travel_class), root);
      await sleep(100);
      await setPrimeDropdown(SELECTORS.quotaDropdown, mapQuotaLabel(preset.quota), root);
    };

    await applyFields(getSearchPanelRoot());

    const retryRoot = getSearchPanelRoot();
    await sleep(200);

    if (!matchesDateValue(textFromNode(findDateInput(retryRoot)), preset.journey_date)) {
      await setJourneyDate(preset.journey_date, retryRoot);
      await sleep(300);
    }

    if (!matchesClassValue(getDropdownValue(SELECTORS.classDropdown, 0, retryRoot), preset.travel_class)) {
      await setPrimeDropdown(SELECTORS.classDropdown, mapClassLabel(preset.travel_class), retryRoot);
      await sleep(300);
    }

    if (!matchesQuotaValue(getDropdownValue(SELECTORS.quotaDropdown, 1, retryRoot), preset.quota)) {
      await setPrimeDropdown(SELECTORS.quotaDropdown, mapQuotaLabel(preset.quota), retryRoot);
    }
  }

  function textFromNode(node) {
    if (!node) {
      return "";
    }

    if (typeof node.value === "string" && node.value.trim()) {
      return node.value;
    }

    if (typeof node.getAttribute === "function") {
      const ariaLabel = node.getAttribute("aria-label");
      if (ariaLabel && ariaLabel.trim()) {
        return ariaLabel;
      }
    }

    return node.textContent || "";
  }

  function getFieldValue(patterns, searchboxIndex, root = document) {
    const primary = findElement(patterns, 1, root);
    const primaryValue = textFromNode(primary);
    if (primaryValue) {
      return primaryValue;
    }

    if (searchboxIndex === undefined) {
      return primaryValue;
    }

    return textFromNode(findSearchboxByOrder(searchboxIndex, root));
  }

  function getDropdownValue(patterns, orderIndex, root = document) {
    let dropdown = findPrimeDropdown(patterns, root);
    if (!dropdown && orderIndex !== undefined) {
      dropdown = findDropdownByOrder(orderIndex, root);
    }
    if (!dropdown) {
      return "";
    }

    const label =
      dropdown.querySelector(".ui-dropdown-label") ||
      dropdown.querySelector(".p-dropdown-label") ||
      [...dropdown.querySelectorAll("span, label, div")].find((node) => normalize(node.textContent));

    return textFromNode(label || dropdown);
  }

  function matchesAnyToken(actual, tokens) {
    const current = normalize(actual);
    if (!current) {
      return false;
    }

    return tokens.some((token) => {
      return current === token || current.includes(token) || token.includes(current);
    });
  }

  function matchesStationValue(actual, expected) {
    if (!expected) {
      return true;
    }

    const actualTokens = stationTokens(actual);
    const expectedTokens = stationTokens(expected);
    return actualTokens.some((actualToken) => matchesAnyToken(actualToken, expectedTokens));
  }

  function matchesDateValue(actual, expected) {
    const target = normalize(formatDate(expected));
    if (!target) {
      return true;
    }

    return matchesAnyToken(actual, [target]);
  }

  function matchesClassValue(actual, expected) {
    if (!expected) {
      return true;
    }

    return matchesAnyToken(actual, classSearchTokens(expected));
  }

  function matchesQuotaValue(actual, expected) {
    if (!expected) {
      return true;
    }

    return matchesAnyToken(actual, [
      normalize(mapQuotaLabel(expected)),
      normalize(expected),
    ].filter(Boolean));
  }

  function trainListFiltersMatchPreset(preset) {
    if (!window.location.pathname.includes("/nget/booking/train-list")) {
      return false;
    }

    const root = getSearchPanelRoot();
    const currentFrom = getFieldValue(SELECTORS.from, 0, root);
    const currentTo = getFieldValue(SELECTORS.to, 1, root);
    const currentDate = textFromNode(findDateInput(root));
    const currentClass = getDropdownValue(SELECTORS.classDropdown, 0, root);
    const currentQuota = getDropdownValue(SELECTORS.quotaDropdown, 1, root);

    return (
      matchesStationValue(currentFrom, preset.from_station) &&
      matchesStationValue(currentTo, preset.to_station) &&
      matchesDateValue(currentDate, preset.journey_date) &&
      matchesClassValue(currentClass, preset.travel_class) &&
      matchesQuotaValue(currentQuota, preset.quota)
    );
  }

  function presetRouteSummary(preset) {
    return [preset.from_station, preset.to_station].filter(Boolean).join(" -> ");
  }

  function currentSearchSummary(root = getSearchPanelRoot()) {
    return [
      getFieldValue(SELECTORS.from, 0, root),
      getFieldValue(SELECTORS.to, 1, root),
      textFromNode(findDateInput(root)),
      getDropdownValue(SELECTORS.classDropdown, 0, root),
      getDropdownValue(SELECTORS.quotaDropdown, 1, root),
    ].filter(Boolean).join(" | ");
  }

  function expectedSearchSummary(preset) {
    return [
      preset.from_station,
      preset.to_station,
      formatDate(preset.journey_date),
      mapClassLabel(preset.travel_class),
      mapQuotaLabel(preset.quota),
    ].filter(Boolean).join(" | ");
  }

  function findVisibleByText(textMatcher, selector = "button, a, div, span, strong") {
    return [...document.querySelectorAll(selector)].filter((node) => {
      return visible(node) && textMatcher(normalize(node.textContent));
    });
  }

  function clickActionButton(labels) {
    const targets = labels.map(normalize);
    const button = [...document.querySelectorAll("button, a")].find((node) => {
      const text = normalize(node.textContent);
      const disabled =
        node.disabled ||
        node.getAttribute("aria-disabled") === "true" ||
        normalize(node.className).includes("disabled");
      return !disabled && targets.some((target) => text.includes(target));
    });

    if (!button) {
      return false;
    }

    button.click();
    return true;
  }

  function resolveClickable(node, root = document.body) {
    if (!node) {
      return null;
    }

    let current = node;
    for (let depth = 0; current && current !== root && depth < 8; depth += 1) {
      if (
        current.matches?.("button, a, [role='button'], .ui-button, .btnDefault") ||
        typeof current.onclick === "function"
      ) {
        return current;
      }
      current = current.parentElement;
    }

    return node;
  }

  function uniqueElements(elements) {
    const seen = new Set();
    const result = [];
    for (const element of elements) {
      if (!element || seen.has(element)) {
        continue;
      }
      seen.add(element);
      result.push(element);
    }
    return result;
  }

  function triggerUiClick(element) {
    if (!element) {
      return;
    }

    element.scrollIntoView({ behavior: "smooth", block: "center" });
    const mouseEvents = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
    for (const eventName of mouseEvents) {
      try {
        element.dispatchEvent(new MouseEvent(eventName, { bubbles: true, cancelable: true, view: window }));
      } catch (_error) {
        // Ignore dispatch issues and still try the native click below.
      }
    }

    if (typeof element.click === "function") {
      element.click();
    }
  }

  function triggerFocusableActivation(element) {
    if (!element) {
      return;
    }

    try {
      element.focus?.({ preventScroll: true });
    } catch (_error) {
      element.focus?.();
    }

    for (const key of ["Enter", " "]) {
      try {
        element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key }));
        element.dispatchEvent(new KeyboardEvent("keypress", { bubbles: true, cancelable: true, key }));
        element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key }));
      } catch (_error) {
        // Ignore keyboard dispatch failures.
      }
    }
  }

  function collectClassClickTargets(node, card, targets) {
    const candidates = [];
    let current = node;

    for (let depth = 0; current && current !== card && depth < 6; depth += 1) {
      const text = normalize(current.textContent);
      if (
        visible(current) &&
        text &&
        text.length <= 80 &&
        targets.some((target) => text.includes(target))
      ) {
        candidates.push(current);
      }
      current = current.parentElement;
    }

    candidates.unshift(resolveClickable(node, card));
    return uniqueElements(candidates);
  }

  function findTrainCardInDom(trainNumber) {
    const target = normalize(String(trainNumber || ""));
    if (!target) {
      return null;
    }

    // IRCTC displays train numbers in parentheses: "TRAIN NAME (12345)"
    const bracketedTarget = `(${target})`;

    // ---- Step 1: find an anchor element via TreeWalker (DOM-structure-agnostic) ----
    // Walk every TEXT NODE in the page looking for the bracketed train number.
    // This works regardless of what element type IRCTC uses for the heading.
    let anchor = null;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.textContent && node.textContent.includes(trainNumber)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });

    let textNode;
    while ((textNode = walker.nextNode())) {
      const parentEl = textNode.parentElement;
      if (parentEl && normalize(parentEl.textContent).includes(bracketedTarget)) {
        anchor = parentEl;
        break;
      }
    }

    // Fallback: querySelector-based search if TreeWalker didn't match.
    if (!anchor) {
      const candidates = [...document.querySelectorAll("strong, span, a, p, div, b, h1, h2, h3, h4, h5, td, th")];
      for (const el of candidates) {
        const text = normalize(el.textContent);
        if (text.includes(bracketedTarget) && text.length < 300) {
          anchor = el;
          break;
        }
      }
    }

    if (!anchor) {
      console.log("[IRCTC Helper] Could not find any element containing", bracketedTarget);
      return null;
    }

    console.log("[IRCTC Helper] Found anchor for train", trainNumber, ":", anchor.tagName, anchor.className, normalize(anchor.textContent).substring(0, 80));

    // ---- Step 2: walk UP from anchor to find the card boundary ----
    // Count how many distinct train numbers appear inside each ancestor.
    // The card is the smallest ancestor that contains "book now" text AND only our train.
    let current = anchor;
    for (let depth = 0; current && current !== document.body && depth < 15; depth += 1) {
      const text = normalize(current.textContent);

      // Must still contain our train.
      if (!text.includes(bracketedTarget)) {
        current = current.parentElement;
        continue;
      }

      const hasBookNow = text.includes("book now");
      const hasRefresh = text.includes("refresh");

      if (hasBookNow || hasRefresh) {
        // Count distinct train numbers (5-digit numbers in parens) inside this container.
        const trainNumberMatches = current.textContent.match(/\(\d{4,5}\)/g) || [];
        const uniqueTrains = new Set(trainNumberMatches);

        if (uniqueTrains.size <= 1) {
          console.log("[IRCTC Helper] Card boundary found at depth", depth, ":", current.tagName, current.className?.substring?.(0, 50));
          return current;
        }

        // If this ancestor has multiple trains but includes book now,
        // keep climbing cautiously — maybe there's a tighter boundary above.
        // But if we already have 3+ trains, stop.
        if (uniqueTrains.size >= 3) {
          break;
        }
      }

      current = current.parentElement;
    }

    // ---- Step 3: fallback — return the closest ancestor that looks like a card ----
    // Even without "book now", return an ancestor that has our train + some structure.
    current = anchor;
    for (let depth = 0; current && current !== document.body && depth < 12; depth += 1) {
      const text = normalize(current.textContent);
      if (!text.includes(bracketedTarget)) {
        current = current.parentElement;
        continue;
      }

      // Accept if it has enough train-card-like content.
      if (text.includes("book now") || text.includes("refresh") || text.includes("train schedule")) {
        const trainNumberMatches = current.textContent.match(/\(\d{4,5}\)/g) || [];
        const uniqueTrains = new Set(trainNumberMatches);
        if (uniqueTrains.size <= 1) {
          console.log("[IRCTC Helper] Fallback card found at depth", depth);
          return current;
        }
      }

      current = current.parentElement;
    }

    // ---- Step 4: last resort — return the anchor's parent (narrow scope) ----
    console.log("[IRCTC Helper] Using anchor parent as last-resort card");
    return anchor.closest("app-train-avl-enq") || anchor.parentElement?.parentElement || anchor;
  }

  async function findTrainCard(trainNumber) {
    // Wait for train list results to render (IRCTC Angular takes a moment).
    for (let waitAttempt = 0; waitAttempt < 10; waitAttempt += 1) {
      const anyTrain = document.querySelector(".train-heading, strong");
      if (anyTrain && /\(\d{4,5}\)/.test(anyTrain.textContent || "")) {
        break;
      }
      await sleep(500);
    }

    // First check without scrolling — the card may already be in the DOM.
    const immediateCard = findTrainCardInDom(trainNumber);
    if (immediateCard) {
      immediateCard.scrollIntoView({ behavior: "smooth", block: "center" });
      await sleep(500);
      return immediateCard;
    }

    // Scroll down progressively to find the card.
    const startingY = window.scrollY;
    let previousScrollTop = -1;

    for (let attempt = 0; attempt < 15; attempt += 1) {
      window.scrollBy({ top: Math.max(window.innerHeight * 0.7, 500), behavior: "smooth" });
      await sleep(600);

      const card = findTrainCardInDom(trainNumber);
      if (card) {
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        await sleep(500);
        return card;
      }

      // Stop if we've hit the bottom of the page (can't scroll further).
      const currentScrollTop = window.scrollY;
      if (currentScrollTop === previousScrollTop) {
        break;
      }
      previousScrollTop = currentScrollTop;
    }

    // Scroll back and do one final check (the DOM may have updated).
    window.scrollTo({ top: startingY, behavior: "smooth" });
    await sleep(400);
    return findTrainCardInDom(trainNumber);
  }

  async function clickPreferredClass(card, preset) {
    if (!card || !preset?.travel_class) {
      return false;
    }

    const targets = classSearchTokens(preset.travel_class);
    // Only consider elements whose own text directly contains a class token.
    // Exclude broad containers that merely have a class token somewhere in their subtree
    // (those would include the pre-avl "Refresh" area and cause the wrong element to be clicked).
    const candidates = [...card.querySelectorAll("button, a, li, p, span, div")]
      .filter(visible)
      .map((node) => {
        // Use the node's own direct text, not full subtree text, to avoid matching containers.
        const ownText = normalize(
          [...node.childNodes]
            .filter((n) => n.nodeType === Node.TEXT_NODE)
            .map((n) => n.textContent)
            .join(" ")
        ) || normalize(node.textContent);

        const matches = targets.filter(
          (target) => ownText === target || ownText.startsWith(target) || ownText.includes(target)
        );

        const excluded =
          ownText.includes("book now") ||
          ownText.includes("other dates") ||
          ownText.includes("cnf probability") ||
          ownText.includes("train schedule") ||
          ownText.includes("refresh");  // Skip refresh containers — handled by clickPreAvlRefreshInCard.

        return { node, text: ownText, matches, excluded };
      })
      .filter((item) => item.matches.length > 0 && !item.excluded)
      .sort((left, right) => {
        // Prefer shorter text (closer to an exact match on the class label).
        const leftExact = left.matches.some((target) => left.text === target) ? 0 : 1;
        const rightExact = right.matches.some((target) => right.text === target) ? 0 : 1;
        if (leftExact !== rightExact) {
          return leftExact - rightExact;
        }
        return left.text.length - right.text.length;
      });

    for (const match of candidates) {
      const clickTargets = collectClassClickTargets(match.node, card, targets);
      for (const clickTarget of clickTargets) {
        triggerUiClick(clickTarget);
        await sleep(500);
        // Return true as soon as a class tile is clicked — activation is handled separately.
        return true;
      }
    }

    return false;
  }

  function isTrainCardActivated(card, preset) {
    if (!card) {
      return false;
    }

    return Boolean(findAvailabilityChoice(card, preset) || getBookNowButton(card));
  }

  function findRefreshTargetsForClass(card) {
    if (!card) {
      return [];
    }

    const refreshTargets = [];

    // Directly target pre-avl containers and their inner link divs.
    const preAvlNodes = [...card.querySelectorAll(
      "div.pre-avl[tabindex='0'], div[tabindex='0'].pre-avl, .pre-avl[tabindex='0']"
    )].filter(visible);

    for (const preAvl of preAvlNodes) {
      const innerLink = [...preAvl.querySelectorAll("div.link, .col-xs-12.link, [class*='link']")]
        .find((node) => visible(node) && normalize(node.textContent).includes("refresh"));

      if (innerLink) {
        refreshTargets.push(innerLink);
      }
      refreshTargets.push(preAvl);
    }

    // Broader fallback: any visible div/span with "link" class containing "refresh".
    const broadLinks = [...card.querySelectorAll("div.link, .link")]
      .filter((node) => visible(node) && normalize(node.textContent).includes("refresh"));
    refreshTargets.push(...broadLinks);

    return uniqueElements(refreshTargets.filter(Boolean));
  }

  // Dedicated function: finds every visible pre-avl in the card, waits for one if needed,
  // then activates it via multiple strategies: Angular zone-aware click, focus+keyboard, and direct click.
  async function clickPreAvlRefreshInCard(card, preset) {
    if (!card) {
      return false;
    }

    // Pre-avl selector — IRCTC uses div.pre-avl with tabindex="0".
    const PRE_AVL_SEL = "div.pre-avl, .pre-avl, [class*='pre-avl']";

    // Wait up to 2.5 s for a pre-avl to become visible (it appears after class-tile click).
    const waitDeadline = Date.now() + 2500;
    while (Date.now() < waitDeadline) {
      const nodes = [...card.querySelectorAll(PRE_AVL_SEL)].filter(visible);
      if (nodes.length > 0) {
        break;
      }
      await sleep(200);
    }

    const preAvlNodes = [...card.querySelectorAll(PRE_AVL_SEL)].filter(visible);

    for (const preAvl of preAvlNodes) {
      // Find the inner "Refresh" link div.
      const innerLink = [...preAvl.querySelectorAll("div.link, .col-xs-12.link, div[class*='link']")]
        .find((node) => visible(node) && normalize(node.textContent).includes("refresh"));

      const clickTarget = innerLink || preAvl;

      // Strategy A: Scroll into view + focus + Enter key (Angular's keyboard binding).
      preAvl.scrollIntoView({ behavior: "smooth", block: "center" });
      await sleep(150);
      preAvl.focus();
      for (const key of ["Enter", " "]) {
        preAvl.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, keyCode: key === "Enter" ? 13 : 32 }));
        preAvl.dispatchEvent(new KeyboardEvent("keypress", { bubbles: true, cancelable: true, key, keyCode: key === "Enter" ? 13 : 32 }));
        preAvl.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key, keyCode: key === "Enter" ? 13 : 32 }));
      }
      await sleep(300);

      // Check if keyboard activation worked.
      let refreshedCard = findTrainCardInDom(preset.train_number) || card;
      if (isTrainCardActivated(refreshedCard, preset)) {
        return true;
      }

      // Strategy B: Full mouse-event sequence on the inner link (or pre-avl itself).
      triggerUiClick(clickTarget);
      await sleep(800);

      refreshedCard = findTrainCardInDom(preset.train_number) || card;
      if (isTrainCardActivated(refreshedCard, preset)) {
        return true;
      }

      // Strategy C: Try .click() directly on the fa-repeat icon inside.
      const refreshIcon = preAvl.querySelector(".fa-repeat, .fa-refresh, [class*='fa-repeat']");
      if (refreshIcon) {
        triggerUiClick(refreshIcon);
        await sleep(800);

        refreshedCard = findTrainCardInDom(preset.train_number) || card;
        if (isTrainCardActivated(refreshedCard, preset)) {
          return true;
        }
      }

      // Strategy D: Angular zone — dispatch a click event that Angular's Zone.js will pick up.
      // Use the native HTMLElement.click() which Angular patches via Zone.js.
      if (typeof clickTarget.click === "function") {
        clickTarget.click();
        await sleep(1000);

        refreshedCard = findTrainCardInDom(preset.train_number) || card;
        if (isTrainCardActivated(refreshedCard, preset)) {
          return true;
        }
      }
    }

    return false;
  }

  async function clickPreferredRefresh(card, preset) {
    const refreshTargets = findRefreshTargetsForClass(card);
    for (const target of refreshTargets) {
      const focusTarget =
        target.closest?.("div.pre-avl[tabindex='0'], div[tabindex='0'].pre-avl") ||
        (target.getAttribute?.("tabindex") === "0" ? target : null);

      if (focusTarget) {
        focusTarget.focus();
        focusTarget.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
        focusTarget.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: "Enter" }));
        await sleep(150);
      }

      triggerUiClick(target);
      await sleep(1000);
      const refreshedCard = findTrainCardInDom(preset.train_number) || card;
      if (isTrainCardActivated(refreshedCard, preset)) {
        return true;
      }
    }

    return false;
  }

  function clickBookNow(card) {
    const button = getBookNowButton(card);

    if (!button) {
      return false;
    }

    triggerUiClick(button);
    return true;
  }

  // Verify a card element actually belongs to the expected train.
  function verifyCardBelongsToTrain(card, trainNumber) {
    if (!card || !trainNumber) {
      return false;
    }

    const target = normalize(String(trainNumber));
    const bracketedTarget = `(${target})`;

    // Check headings first (precise).
    const headings = [...card.querySelectorAll(
      ".train-heading strong, .train-heading, strong"
    )].filter(visible);
    if (headings.some((h) => normalize(h.textContent).includes(bracketedTarget))) {
      return true;
    }

    // Fallback: check the card's own top-level text for the bracketed train number.
    return normalize(card.textContent).includes(bracketedTarget);
  }

  async function handleTrainListPage(preset) {
    if (!window.location.pathname.includes("/nget/booking/train-list")) {
      return false;
    }

    const card = await findTrainCard(preset.train_number);
    if (!card) {
      showBanner(`Train ${preset.train_number || ""} not found on this results page.`, "error");
      return false;
    }

    // Safety check: verify the found card actually contains the right train number.
    if (!verifyCardBelongsToTrain(card, preset.train_number)) {
      showBanner(`Train ${preset.train_number} not found — matched card belongs to a different train.`, "error");
      return false;
    }

    closeOpenOverlays();
    await sleep(100);

    // Step 1: click the class tile to select it (may or may not load availability immediately).
    await clickPreferredClass(card, preset);
    await sleep(300);

    // Step 2: directly target any pre-avl[tabindex='0'] in the card and activate it.
    let freshCard = findTrainCardInDom(preset.train_number) || card;
    let activated = await clickPreAvlRefreshInCard(freshCard, preset);

    // Step 3: fallback — broader refresh-target search if direct pre-avl approach failed.
    if (!activated) {
      freshCard = findTrainCardInDom(preset.train_number) || card;
      activated = await clickPreferredRefresh(freshCard, preset);
    }

    // Step 4: check if card is already showing availability (e.g. pre-loaded from search params).
    if (!activated) {
      freshCard = findTrainCardInDom(preset.train_number) || card;
      activated = isTrainCardActivated(freshCard, preset);
    }

    if (!activated) {
      showBanner(`Could not activate availability for ${mapClassLabel(preset.travel_class)} on train ${preset.train_number}.`, "error");
      return false;
    }

    await sleep(400);
    const availabilityClicked = await clickAvailabilityChoice(findTrainCardInDom(preset.train_number) || card, preset, 2000);
    if (availabilityClicked) {
      await sleep(300);
    }

    const refreshedCard = findTrainCardInDom(preset.train_number) || card;
    const bookNowButton = await waitForBookNowButton(refreshedCard, 3000);
    if (bookNowButton) {
      const clicked = await clickBookNowWithRetry(bookNowButton, preset.train_number);
      if (clicked) {
        return true;
      }
    }

    // Last resort: try finding the button fresh and clicking it.
    const lastCard = findTrainCardInDom(preset.train_number) || card;
    const lastButton = getBookNowButton(lastCard);
    if (lastButton) {
      const clicked = await clickBookNowWithRetry(lastButton, preset.train_number);
      if (clicked) {
        return true;
      }
    }

    showBanner(`Book Now did not activate for train ${preset.train_number}.`, "error");
    return false;
  }

  // Click Book Now with multiple strategies and retry.
  async function clickBookNowWithRetry(button, trainNumber) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      button.scrollIntoView({ behavior: "smooth", block: "center" });
      await sleep(150);

      // Strategy 1: native .click() (Angular Zone.js patches this).
      console.log("[IRCTC Helper] Clicking Book Now, attempt", attempt + 1, ":", button.tagName, button.className);
      if (typeof button.click === "function") {
        button.click();
      }
      await sleep(400);

      // Check if navigation happened or confirmation dialog appeared.
      if (await checkBookNowSuccess()) {
        showBanner(`Opened Book Now for train ${trainNumber}.`);
        await sleep(500);
        await dismissConfirmationDialog();
        return true;
      }

      // Strategy 2: full mouse event sequence.
      triggerUiClick(button);
      await sleep(400);

      if (await checkBookNowSuccess()) {
        showBanner(`Opened Book Now for train ${trainNumber}.`);
        await sleep(500);
        await dismissConfirmationDialog();
        return true;
      }

      // Strategy 3: focus + Enter key.
      triggerFocusableActivation(button);
      await sleep(400);

      if (await checkBookNowSuccess()) {
        showBanner(`Opened Book Now for train ${trainNumber}.`);
        await sleep(500);
        await dismissConfirmationDialog();
        return true;
      }

      // Strategy 4: if button is a wrapper, try clicking child elements.
      const innerButton = button.querySelector("button, a, [role='button']");
      if (innerButton && innerButton !== button) {
        innerButton.click();
        await sleep(400);
        if (await checkBookNowSuccess()) {
          showBanner(`Opened Book Now for train ${trainNumber}.`);
          await sleep(500);
          await dismissConfirmationDialog();
          return true;
        }
      }

      // Strategy 5: walk up to find a parent <button> or <a> and click that.
      const parentClickable = button.closest("button") || button.closest("a[href]") || button.parentElement?.closest("button");
      if (parentClickable && parentClickable !== button) {
        parentClickable.click();
        await sleep(400);
        if (await checkBookNowSuccess()) {
          showBanner(`Opened Book Now for train ${trainNumber}.`);
          await sleep(500);
          await dismissConfirmationDialog();
          return true;
        }
      }
    }

    return false;
  }

  // Check if Book Now click succeeded — either page navigated or confirmation dialog appeared.
  async function checkBookNowSuccess() {
    // Check for navigation to passenger input page.
    if (window.location.pathname.includes("/nget/booking/psgninput")) {
      return true;
    }

    // Check for confirmation dialog ("Do you want to continue?").
    const yesButton = [...document.querySelectorAll("button")].find((btn) => {
      const text = normalize(btn.textContent);
      return visible(btn) && (text === "yes" || text.includes("yes"));
    });
    if (yesButton) {
      return true;
    }

    // Check for any modal/overlay that appeared.
    const modal = document.querySelector(".modal, .cdk-overlay-container .cdk-overlay-pane, .ui-dialog");
    if (modal && visible(modal) && normalize(modal.textContent).includes("continue")) {
      return true;
    }

    return false;
  }

  // IRCTC sometimes shows a confirmation dialog after clicking Book Now
  // (e.g. "You searched from NDLS but booking from ANDI...").  Auto-click "Yes".
  async function dismissConfirmationDialog() {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const yesButton = [...document.querySelectorAll("button")].find((btn) => {
        const text = normalize(btn.textContent);
        return visible(btn) && (text === "yes" || text === "ok" || text.includes("yes"));
      });

      if (yesButton) {
        triggerUiClick(yesButton);
        showBanner("Auto-confirmed booking dialog.");
        return true;
      }

      await sleep(500);
    }

    return false;
  }

  function getBookNowButton(card, options = {}) {
    if (!card) {
      return null;
    }

    const { allowDisabled = false } = options;

    const candidates = [...card.querySelectorAll("button, a, div, span")].filter((node) => {
      if (!visible(node)) {
        return false;
      }

      const text = normalize(node.textContent);
      const cls = normalize(node.className);
      const parentCls = normalize(node.parentElement?.className || "");
      const opacity = parseFloat(window.getComputedStyle(node).opacity || "1");
      const disabled =
        node.disabled ||
        node.getAttribute("aria-disabled") === "true" ||
        cls.includes("disabled") ||
        cls.includes("disable-book") ||
        parentCls.includes("disable-book") ||
        parentCls.includes("disabled") ||
        opacity < 0.6;
      return text.includes("book now") && (allowDisabled || !disabled);
    });

    if (candidates.length === 0) {
      return null;
    }

    // Prefer actual <button> or <a> elements over <div>/<span> wrappers —
    // these are the real clickable elements that Angular binds events to.
    const buttons = candidates.filter((n) => n.tagName === "BUTTON" || n.tagName === "A");
    if (buttons.length > 0) {
      // Among buttons, pick the one with shortest text (tightest match).
      buttons.sort((a, b) => normalize(a.textContent).length - normalize(b.textContent).length);
      return buttons[0];
    }

    // Fallback: shortest text match.
    candidates.sort((a, b) => normalize(a.textContent).length - normalize(b.textContent).length);
    return candidates[0];
  }

  async function waitForBookNowButton(card, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const button = getBookNowButton(card);
      if (button) {
        return button;
      }

      await sleep(250);
    }

    return getBookNowButton(card);
  }

  function findAvailabilityChoice(card, preset) {
    if (!card) {
      return null;
    }

    const targetDate = normalize(formatAvailabilityDate(preset.journey_date));
    const statusKeywords = ["available", "rac", "wl", "regret"];
    const candidates = [...card.querySelectorAll("button, a, div, span, strong, p")].filter((node) => {
      if (!visible(node)) {
        return false;
      }

      const text = normalize(node.textContent);
      if (!text || !text.includes(targetDate)) {
        return false;
      }

      return (
        statusKeywords.some((keyword) => text.includes(keyword)) &&
        !text.includes("book now") &&
        !text.includes("other dates") &&
        !text.includes("cnf probability") &&
        !text.includes("refresh") &&
        !text.includes("train schedule")
      );
    });

    if (candidates.length > 0) {
      candidates.sort((left, right) => normalize(left.textContent).length - normalize(right.textContent).length);
      return candidates[0];
    }

    const fallback = [...card.querySelectorAll("button, a, div, span, strong, p")].find((node) => {
      if (!visible(node)) {
        return false;
      }

      const text = normalize(node.textContent);
      return (
        !text.includes("book now") &&
        !text.includes("other dates") &&
        !text.includes("cnf probability") &&
        !text.includes("refresh") &&
        !text.includes("train schedule") &&
        statusKeywords.some((keyword) => text.includes(keyword))
      );
    });

    return fallback || null;
  }

  function buildAvailabilityClickTargets(choice, card) {
    if (!choice) {
      return [];
    }

    const statusKeywords = ["available", "rac", "wl", "regret"];
    const descendants = [...choice.querySelectorAll("strong, span, div, p")].filter(visible);
    const dateNode = descendants.find((node) => normalize(node.textContent).includes("mon,")) ||
      descendants.find((node) => /\b(?:sun|mon|tue|wed|thu|fri|sat),/i.test(node.textContent || ""));
    const statusNode = descendants.find((node) => {
      const text = normalize(node.textContent);
      return statusKeywords.some((keyword) => text.includes(keyword));
    });

    return uniqueElements([
      // Try the choice element itself first (most likely the right target).
      choice,
      // Inner elements that might have their own click handlers.
      statusNode,
      dateNode,
      // Parent elements — the actual <td> or Angular component wrapper.
      choice.closest("td"),
      choice.parentElement,
      choice.closest("button, a, [role='button'], [tabindex]"),
      resolveClickable(choice, card),
    ]);
  }

  async function clickAvailabilityChoice(card, preset, timeoutMs = 4000) {
    // Always try to click the date/availability cell first — even if a
    // Book Now button is visible, it may be greyed-out / inactive until
    // the user selects a specific date cell.
    let clicked = false;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const currentCard = findTrainCardInDom(preset.train_number) || card;
      const choice = findAvailabilityChoice(currentCard, preset);

      if (choice) {
        const targets = buildAvailabilityClickTargets(choice, currentCard);

        for (const target of targets) {
          if (!target) {
            continue;
          }

          console.log("[IRCTC Helper] Clicking availability target:", target.tagName, target.textContent?.trim().slice(0, 60));
          triggerUiClick(target);
          await sleep(700);

          const refreshedCard = findTrainCardInDom(preset.train_number) || currentCard;
          if (getBookNowButton(refreshedCard)) {
            return true;
          }
          clicked = true;
        }
      }

      // If we already clicked targets and Book Now still isn't active,
      // try once more after a brief wait.
      if (clicked) {
        await sleep(500);
        const refreshedCard2 = findTrainCardInDom(preset.train_number) || card;
        if (getBookNowButton(refreshedCard2)) {
          return true;
        }
      }

      // Also check if Book Now became active (e.g., via a prior Refresh click
      // that already loaded availability).
      const bn = getBookNowButton(findTrainCardInDom(preset.train_number) || card);
      if (bn) {
        return true;
      }

      await sleep(250);
    }

    return false;
  }


  async function handleSearchSubmission() {
    const path = window.location.pathname;

    if (path.includes("/nget/train-search")) {
      await sleep(300);
      if (clickActionButton(["Search Trains"])) {
        showBanner("Clicked Search Trains.");
        return true;
      }
    }

    if (path.includes("/nget/booking/train-list")) {
      closeOpenOverlays();
      await sleep(300);
      if (clickActionButton(["Modify Search"])) {
        showBanner("Clicked Modify Search.");
        return true;
      }
    }

    return false;
  }

  function formatDate(value) {
    if (!value) {
      return "";
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const [year, month, day] = value.split("-");
      return `${day}/${month}/${year}`;
    }

    return value;
  }

  function formatAvailabilityDate(value) {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return "";
    }

    const date = new Date(`${value}T00:00:00`);
    const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(date);
    const day = new Intl.DateTimeFormat("en-US", { day: "numeric" }).format(date);
    const month = new Intl.DateTimeFormat("en-US", { month: "short" }).format(date);
    return `${weekday}, ${day} ${month}`;
  }

  function fillPassenger(passenger, index) {
    setNativeValue(findElement(SELECTORS.passengerName, index), passenger.name);
    setNativeValue(findElement(SELECTORS.passengerAge, index), passenger.age);
    setSelectByText(findElement(SELECTORS.passengerGender, index), passenger.gender);
    setSelectByText(findElement(SELECTORS.passengerBerth, index), passenger.berth_preference);
  }

  function showBanner(message, tone = "info") {
    const existing = document.getElementById("irctc-helper-banner");
    if (existing) {
      existing.remove();
    }

    const banner = document.createElement("div");
    banner.id = "irctc-helper-banner";
    banner.textContent = message;
    banner.style.cssText = [
      "position:fixed",
      "right:16px",
      "bottom:16px",
      "z-index:999999",
      "padding:12px 16px",
      "border-radius:12px",
      "box-shadow:0 10px 24px rgba(0,0,0,.18)",
      "font:600 14px/1.4 system-ui,sans-serif",
      "color:#fff",
      tone === "error" ? "background:#b42318" : "background:#0f766e",
    ].join(";");
    document.body.appendChild(banner);
    window.setTimeout(() => banner.remove(), 5000);
  }

  async function deletePresetById(presetId) {
    const payload = await requestJson(`${API_BASE}/presets/${presetId}`, { method: "DELETE" });
    if (!payload?.ok) {
      throw new Error("Preset delete request did not succeed.");
    }

    if (getLastUsedPresetId() === presetId) {
      removeLocalStorageItem(LAST_USED_KEY);
    }

    if (getActivePresetId() === presetId) {
      clearActivePresetId();
    }

    return payload;
  }

  function presetSummary(preset) {
    const route = [preset.from_station, preset.to_station].filter(Boolean).join(" -> ");
    const details = [
      formatDate(preset.journey_date),
      preset.travel_class,
      preset.quota,
    ].filter(Boolean).join(" | ");

    return [route, details].filter(Boolean).join(" | ");
  }

  function isTrainSearchPage() {
    return window.location.pathname.includes("/nget/train-search");
  }

  function isTrainListPage() {
    return window.location.pathname.includes("/nget/booking/train-list");
  }

  function isPassengerPage() {
    return window.location.pathname.includes("/nget/booking/psgninput");
  }

  function isReviewPage() {
    return window.location.pathname.includes("/nget/booking/reviewBooking");
  }

  // ---------------------------------------------------------------------------
  // Passenger page — select passengers from IRCTC master list
  // ---------------------------------------------------------------------------

  // Type into the Name input to trigger the master-list autocomplete dropdown,
  // then click the matching passenger entry.
  // Fuzzy name match: returns true if the dropdown entry text broadly matches
  // the preset passenger name.  Case-insensitive, ignores age/gender differences,
  // and only requires that most words from the preset name appear in the entry.
  function fuzzyNameMatch(entryText, presetName) {
    const entry = normalize(entryText).replace(/\|/g, " ");
    const name  = normalize(presetName);

    // Quick win: the entry simply contains the full name.
    if (entry.includes(name)) {
      return true;
    }

    // Word-level match: if ≥ half the words in the preset name appear in the
    // entry text, treat it as a match.  This handles "Vikash Kumar" matching
    // "vikash kumar | 37 yrs | Male" as well as small typos / extra initials.
    const presetWords = name.split(/\s+/).filter((w) => w.length >= 2);
    if (presetWords.length === 0) {
      return false;
    }
    const hits = presetWords.filter((w) => entry.includes(w)).length;
    return hits >= Math.ceil(presetWords.length * 0.5) && hits >= 1;
  }

  async function selectPassengerFromMasterList(nameInput, passengerName, index) {
    if (!nameInput || !passengerName) {
      return false;
    }

    // Focus and clear.
    nameInput.scrollIntoView({ behavior: "smooth", block: "center" });
    await sleep(200);
    nameInput.focus();
    nameInput.click();
    await sleep(300);

    setNativeValue(nameInput, "");
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(200);

    // Type just the first 3-4 characters to trigger the dropdown quickly.
    // No need to type the full name — IRCTC filters as you type.
    const typePart = passengerName.slice(0, Math.min(4, passengerName.length));
    for (const char of typePart) {
      nameInput.value += char;
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
      nameInput.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: char }));
      nameInput.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: char }));
      await sleep(40);
    }

    await sleep(800);

    // Find the matching entry in the dropdown.
    const found = await waitForMasterListEntry(passengerName, 4000);
    if (found) {
      found.scrollIntoView({ behavior: "smooth", block: "center" });
      await sleep(100);
      found.click();
      triggerUiClick(found);
      console.log(`[IRCTC Helper] Selected "${passengerName}" from master list (passenger ${index}).`);
      await sleep(400);
      return true;
    }

    console.warn(`[IRCTC Helper] Master list entry not found for "${passengerName}". Falling back to manual fill.`);
    return false;
  }

  // Wait for a dropdown entry that fuzzy-matches the passenger name.
  async function waitForMasterListEntry(presetName, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const entry = findMasterListEntry(presetName);
      if (entry) {
        return entry;
      }
      await sleep(250);
    }
    return findMasterListEntry(presetName);
  }

  // Scan dropdown items for a fuzzy name match.
  // IRCTC's autocomplete uses PrimeNG which renders the dropdown in a
  // <div class="ng-trigger-overlayAnimation"> overlay appended to <body>.
  // Items inside are <li> elements.  We intentionally skip the strict
  // visible() check because overlay items can fail getBoundingClientRect
  // checks in some browsers.
  function findMasterListEntry(presetName) {
    // Cast a very wide net for any <li> on the page — the autocomplete
    // overlay items will be among them.
    const allLi = document.querySelectorAll("li");
    const matches = [];

    for (const item of allLi) {
      const text = item.textContent || "";
      // Skip items that are obviously too long (nav menus, containers).
      if (text.length > 150 || text.length < 3) {
        continue;
      }
      // Skip items that are hidden via display:none (but allow overlay items).
      const style = window.getComputedStyle(item);
      if (style.display === "none") {
        continue;
      }
      if (fuzzyNameMatch(text, presetName)) {
        matches.push(item);
      }
    }

    if (matches.length > 0) {
      // Pick the tightest (shortest text) to avoid clicking a container.
      matches.sort((a, b) => a.textContent.length - b.textContent.length);
      console.log("[IRCTC Helper] Master list match found:", matches[0].textContent.trim());
      return matches[0];
    }

    return null;
  }

  // Get the Nth passenger Name input on the psgninput page.
  function getPassengerNameInput(index) {
    // Try known IRCTC selectors first.
    const selectors = [
      "input[placeholder='Name']",
      "input[formcontrolname='passengerName']",
      "p-autoComplete input",
      ".p-autocomplete input",
      "input[role='searchbox']",
    ];

    for (const selector of selectors) {
      const all = [...document.querySelectorAll(selector)].filter(visible);
      if (all.length >= index) {
        return all[index - 1];
      }
    }

    // Fallback: use the generic findElement.
    return findElement(SELECTORS.passengerName, index);
  }

  // Add a new passenger row by clicking the "+" / "Add Passenger" button.
  async function addPassengerRow() {
    const addButtons = [...document.querySelectorAll("a, button, div, span")].filter((node) => {
      if (!visible(node)) return false;
      const text = normalize(node.textContent);
      return text.includes("add passenger") || text === "+" || text.includes("+ add");
    });

    // Prefer the tightest text match.
    addButtons.sort((a, b) => a.textContent.length - b.textContent.length);
    const btn = addButtons[0];
    if (btn) {
      btn.click();
      await sleep(500);
      return true;
    }
    return false;
  }

  async function clickLoyaltySkip() {
    // IRCTC loyalty section: "Earn Loyalty Points | Pay with Loyalty Points | Skip"
    // These are plain radio inputs with name="loyalityOperationType" (IRCTC's typo).
    //   value="1" = Earn Loyalty Points (default selected)
    //   value="2" = Pay with Loyalty Points
    //   value="3" = Skip
    const skipRadio = document.querySelector(
      'input[name="loyalityOperationType"][value="3"]'
    );
    if (skipRadio) {
      skipRadio.click();
      console.log("[IRCTC Helper] Clicked Skip loyalty radio (value=3).");
      return;
    }

    // Fallback: try any spelling variant.
    const fallback = document.querySelector(
      'input[name*="loyalit"][value="3"], input[name*="loyalty"][value="3"]'
    );
    if (fallback) {
      fallback.click();
      console.log("[IRCTC Helper] Clicked Skip loyalty radio (fallback selector).");
      return;
    }

    console.warn("[IRCTC Helper] Could not find loyalty Skip radio.");
  }

  async function handlePassengerPage(preset) {
    if (!isPassengerPage()) {
      return;
    }

    const passengers = preset.passengers || [];
    if (passengers.length === 0) {
      showBanner("No passengers in preset. Fill manually.", "error");
      return;
    }

    showBanner(`Filling ${passengers.length} passenger(s) from preset...`);
    await sleep(2000); // Let the page fully render including loyalty section.

    // FIRST: Click "Skip" for loyalty points — must happen before everything else.
    // Try up to 3 times with waits, since the loyalty section may render late.
    for (let skipAttempt = 0; skipAttempt < 3; skipAttempt += 1) {
      await clickLoyaltySkip();
      await sleep(600);
    }

    for (let i = 0; i < passengers.length; i += 1) {
      const passenger = passengers[i];
      const passengerIndex = i + 1;

      // For passengers beyond the first, we may need to add a new row.
      if (i > 0) {
        await addPassengerRow();
        await sleep(500);
      }

      // Get the Name input for this passenger row.
      const nameInput = getPassengerNameInput(passengerIndex);
      if (!nameInput) {
        console.warn(`[IRCTC Helper] Name input not found for passenger ${passengerIndex}.`);
        continue;
      }

      // Try selecting from master list first (fast + auto-fills age/gender).
      const selected = await selectPassengerFromMasterList(nameInput, passenger.name, passengerIndex);

      if (!selected) {
        // Fallback: manually fill name, age, gender.
        fillPassenger(passenger, passengerIndex);
      }

      // Set berth preference regardless (master list doesn't set this).
      await sleep(300);
      const berthSelect = findElement(SELECTORS.passengerBerth, passengerIndex);
      if (berthSelect && passenger.berth_preference) {
        setSelectByText(berthSelect, passenger.berth_preference);
      }
    }

    // Fill mobile number if present in preset.
    await sleep(300);
    if (preset.mobile_number) {
      const mobileInput = document.querySelector(
        "input[formcontrolname='mobileNumber'], input[name='mobileNumber'], " +
        "input[placeholder*='Mobile'], input[placeholder*='mobile'], input[type='tel']"
      );
      if (mobileInput && visible(mobileInput)) {
        setNativeValue(mobileInput, preset.mobile_number);
        console.log("[IRCTC Helper] Filled mobile number.");
      }
    }

    // Click Skip again just in case the first attempt didn't stick.
    await sleep(300);
    await clickLoyaltySkip();

    // Select "No, I don't want travel insurance".
    // Radio: input[name="travelInsuranceOpted-0"][value="false"]
    await sleep(500);
    const noInsuranceRadio = document.querySelector(
      'input[name="travelInsuranceOpted-0"][value="false"]'
    ) || document.querySelector(
      'input[name*="travelInsurance"][value="false"]'
    );
    if (noInsuranceRadio) {
      noInsuranceRadio.click();
      console.log("[IRCTC Helper] Selected 'No travel insurance'.");
    } else {
      // Fallback: text-based search.
      const noInsurance = [...document.querySelectorAll("label, span, div")].find((node) => {
        return visible(node) && normalize(node.textContent).includes("no, i don't want travel insurance");
      });
      if (noInsurance) {
        noInsurance.click();
        console.log("[IRCTC Helper] Selected 'No travel insurance' (fallback).");
      }
    }

    showBanner(`Filled ${passengers.length} passenger(s) from preset. Clicking Continue...`);

    // Wait for Angular to process the loyalty/insurance selections.
    await sleep(1500);
    const continueBtn = [...document.querySelectorAll("button")].find((btn) => {
      return visible(btn) && normalize(btn.textContent).trim() === "continue";
    }) || [...document.querySelectorAll("button")].find((btn) => {
      return visible(btn) && normalize(btn.textContent).includes("continue");
    });

    if (continueBtn) {
      continueBtn.scrollIntoView({ behavior: "smooth", block: "center" });
      await sleep(300);
      continueBtn.click();
      console.log("[IRCTC Helper] Clicked Continue button.");
    } else {
      showBanner("Could not find Continue button. Click it manually.", "error");
    }
  }

  // ---------------------------------------------------------------------------
  // Review Journey page — Captcha helper dialog
  // ---------------------------------------------------------------------------

  async function handleReviewPage() {
    if (!isReviewPage()) {
      return;
    }

    console.log("[IRCTC Helper] Review/Captcha page detected.");
    await sleep(1500); // Let the page render fully.

    // Find the captcha image.
    const captchaImg = document.querySelector(
      "img.captcha-img, img[alt*='captcha'], img[alt*='Captcha'], " +
      "img[src*='captcha'], img[class*='captcha'], " +
      "app-captcha img, .captcha-container img"
    ) || findCaptchaImgFallback();

    if (!captchaImg) {
      showBanner("No captcha image found on this page.", "error");
      return;
    }

    // Find the captcha input field.
    const captchaInput = document.querySelector(
      "input[placeholder*='Captcha'], input[placeholder*='captcha'], " +
      "input[formcontrolname*='captcha'], input[name*='captcha'], " +
      "input[id*='captcha'], input[class*='captcha']"
    ) || findCaptchaInputFallback();

    // Fetch captcha image via GM_xmlhttpRequest to bypass CORS,
    // so we can draw it to canvas and run OCR.
    const captchaSrc = captchaImg.src;
    let captchaDataURL = null;
    try {
      captchaDataURL = await fetchImageAsDataURL(captchaSrc);
    } catch (e) {
      console.log("[IRCTC Helper] Could not fetch captcha via GM_xmlhttpRequest:", e);
    }

    // Show our captcha dialog with the CORS-free data URL.
    showCaptchaDialog(captchaImg, captchaInput, captchaDataURL);
  }

  // Fetch an image URL as a base64 data URL using GM_xmlhttpRequest (bypasses CORS).
  function fetchImageAsDataURL(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url: url,
        responseType: "blob",
        onload: (response) => {
          try {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(response.response);
          } catch (e) {
            reject(e);
          }
        },
        onerror: reject,
      });
    });
  }

  function findCaptchaImgFallback() {
    // Look for any image near text "Enter Captcha".
    const images = [...document.querySelectorAll("img")];
    for (const img of images) {
      const parent = img.parentElement;
      if (parent && normalize(parent.textContent).includes("captcha")) {
        return img;
      }
      // Check nearby siblings.
      const siblings = parent ? [...parent.children] : [];
      for (const sib of siblings) {
        if (normalize(sib.textContent).includes("captcha")) {
          return img;
        }
      }
    }
    return null;
  }

  function findCaptchaInputFallback() {
    // Find input near the captcha text.
    const inputs = [...document.querySelectorAll("input[type='text'], input:not([type])")];
    for (const input of inputs) {
      const parent = input.closest("div, form, section");
      if (parent && normalize(parent.textContent).includes("captcha")) {
        return input;
      }
    }
    return null;
  }

  // Convert captcha <img> to a data URL via canvas so it displays in our dialog.
  function captchaToDataURL(img) {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth || img.width || 200;
      canvas.height = img.naturalHeight || img.height || 60;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      return canvas.toDataURL("image/png");
    } catch (_e) {
      // CORS may block this — fall back to original src.
      return img.src;
    }
  }

  // Basic OCR: try to read captcha characters from a canvas.
  // Returns an array of up to 5 guesses.
  function guessCaptcha(img) {
    const guesses = [];
    try {
      const canvas = document.createElement("canvas");
      const w = img.naturalWidth || img.width || 200;
      const h = img.naturalHeight || img.height || 60;
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, w, h);
      const pixels = imageData.data;

      // Convert to grayscale and threshold.
      const gray = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) {
        const r = pixels[i * 4], g = pixels[i * 4 + 1], b = pixels[i * 4 + 2];
        gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      }

      // Find threshold using Otsu's method (simplified).
      let histogram = new Array(256).fill(0);
      for (let i = 0; i < gray.length; i++) histogram[gray[i]]++;
      let total = gray.length, sum = 0;
      for (let i = 0; i < 256; i++) sum += i * histogram[i];
      let sumB = 0, wB = 0, maxVar = 0, threshold = 128;
      for (let i = 0; i < 256; i++) {
        wB += histogram[i];
        if (wB === 0) continue;
        const wF = total - wB;
        if (wF === 0) break;
        sumB += i * histogram[i];
        const mB = sumB / wB, mF = (sum - sumB) / wF;
        const variance = wB * wF * (mB - mF) * (mB - mF);
        if (variance > maxVar) { maxVar = variance; threshold = i; }
      }

      // Binary image: 1 = dark (text), 0 = light (background).
      const binary = new Uint8Array(w * h);
      for (let i = 0; i < gray.length; i++) {
        binary[i] = gray[i] < threshold ? 1 : 0;
      }

      // Find vertical character columns by counting dark pixels per column.
      const colDensity = new Array(w).fill(0);
      for (let x = 0; x < w; x++) {
        for (let y = 0; y < h; y++) {
          colDensity[x] += binary[y * w + x];
        }
      }

      // Segment characters by finding gaps in density.
      const minDensity = Math.max(2, h * 0.05);
      const segments = [];
      let inChar = false, startX = 0;
      for (let x = 0; x < w; x++) {
        if (colDensity[x] >= minDensity && !inChar) {
          inChar = true;
          startX = x;
        } else if (colDensity[x] < minDensity && inChar) {
          inChar = false;
          if (x - startX > 3) { // Ignore tiny noise.
            segments.push({ x1: startX, x2: x });
          }
        }
      }
      if (inChar && w - startX > 3) segments.push({ x1: startX, x2: w });

      console.log("[IRCTC Helper] OCR: threshold=" + threshold + ", segments=" + segments.length +
        ", dims=" + w + "x" + h + ", segments=" + JSON.stringify(segments));

      // For each segment, compute a simple feature hash and match to characters.
      const chars = segments.map((seg) => {
        const sw = seg.x2 - seg.x1;
        const charBin = [];
        for (let y = 0; y < h; y++) {
          for (let x = seg.x1; x < seg.x2; x++) {
            charBin.push(binary[y * w + x]);
          }
        }

        // Compute features: top/bottom/left/right density ratios.
        const midY = Math.floor(h / 2);
        const midX = Math.floor(sw / 2);
        let topDark = 0, botDark = 0, leftDark = 0, rightDark = 0, totalDark = 0;
        for (let y = 0; y < h; y++) {
          for (let lx = 0; lx < sw; lx++) {
            const val = binary[y * w + seg.x1 + lx];
            totalDark += val;
            if (y < midY) topDark += val; else botDark += val;
            if (lx < midX) leftDark += val; else rightDark += val;
          }
        }

        if (totalDark === 0) return "?";

        const topRatio = topDark / totalDark;
        const leftRatio = leftDark / totalDark;
        const aspect = sw / h;
        const density = totalDark / (sw * h);

        // Very basic heuristic classification.
        return classifyChar(topRatio, leftRatio, aspect, density, sw, h, binary, seg.x1, w);
      });

      const baseGuess = chars.join("");
      if (baseGuess.length >= 3 && baseGuess.length <= 8) {
        guesses.push(baseGuess);
        // Generate variations with common confusable swaps.
        const confusables = {
          "0": ["O", "o", "Q"], "O": ["0", "o"], "o": ["0", "O"],
          "1": ["l", "I", "i"], "l": ["1", "I", "i"], "I": ["1", "l", "i"],
          "5": ["S", "s"], "S": ["5", "s"], "s": ["5", "S"],
          "8": ["B"], "B": ["8"], "2": ["Z", "z"], "Z": ["2", "z"],
          "6": ["G", "b"], "G": ["6"], "9": ["g", "q"], "g": ["9", "q"],
          "r": ["n"], "n": ["r"], "E": ["F"], "F": ["E"],
          "u": ["v"], "v": ["u"], "w": ["W"], "W": ["w"],
        };
        for (let ci = 0; ci < chars.length && guesses.length < 5; ci++) {
          const ch = chars[ci];
          const swaps = confusables[ch] || [];
          for (const swap of swaps) {
            if (guesses.length >= 5) break;
            const variant = [...chars];
            variant[ci] = swap;
            const vStr = variant.join("");
            if (!guesses.includes(vStr)) guesses.push(vStr);
          }
        }
      }
    } catch (e) {
      console.log("[IRCTC Helper] Captcha OCR error:", e);
    }
    return guesses;
  }

  // Very basic character classification from density features.
  function classifyChar(topR, leftR, aspect, density, _sw, _h, _binary, _ox, _bw) {
    // This is a rough heuristic — not real OCR. It provides starting guesses.
    if (aspect < 0.3) {
      if (density > 0.4) return "l";
      if (topR > 0.6) return "1";
      return "I";
    }
    if (aspect > 0.9) {
      if (density > 0.4) return "W";
      return "M";
    }
    if (density > 0.55) {
      if (topR > 0.55) return "E";
      if (leftR > 0.55) return "B";
      return "8";
    }
    if (density < 0.15) {
      if (topR > 0.6) return "r";
      return "c";
    }
    if (topR > 0.6) {
      if (leftR > 0.55) return "P";
      if (density > 0.35) return "F";
      return "7";
    }
    if (topR < 0.35) {
      if (leftR > 0.55) return "L";
      if (density > 0.35) return "J";
      return "u";
    }
    if (leftR > 0.6) {
      if (density > 0.35) return "D";
      return "C";
    }
    if (leftR < 0.35) {
      if (density > 0.35) return "d";
      return "3";
    }
    // Middle-of-road features.
    if (density > 0.4) {
      if (topR > 0.5) return "A";
      return "H";
    }
    if (topR > 0.52) {
      if (leftR > 0.48) return "K";
      return "N";
    }
    if (aspect > 0.5) {
      if (density > 0.3) return "S";
      return "Z";
    }
    return "x";
  }

  function showCaptchaDialog(captchaImg, captchaInput, preloadedDataURL) {
    // Remove any existing dialog.
    const existing = document.getElementById("irctc-captcha-dialog");
    if (existing) existing.remove();

    // Use preloaded CORS-free data URL if available, otherwise try canvas.
    const dataURL = preloadedDataURL || captchaToDataURL(captchaImg);

    // Run OCR — we'll start with empty guesses and update async.
    let guesses = [];

    // Create overlay.
    const overlay = document.createElement("div");
    overlay.id = "irctc-captcha-dialog";
    overlay.style.cssText = [
      "position:fixed", "top:0", "left:0", "width:100%", "height:100%",
      "background:rgba(0,0,0,0.6)", "z-index:9999999",
      "display:flex", "align-items:center", "justify-content:center",
      "font-family:system-ui,sans-serif",
    ].join(";");

    const dialog = document.createElement("div");
    dialog.style.cssText = [
      "background:#fff", "border-radius:16px", "padding:24px 32px",
      "box-shadow:0 20px 60px rgba(0,0,0,0.4)", "max-width:460px", "width:92%",
      "text-align:center",
    ].join(";");

    // Title.
    const title = document.createElement("div");
    title.textContent = "🔐 Enter Captcha";
    title.style.cssText = "font-size:18px;font-weight:700;margin-bottom:12px;color:#1e293b;";
    dialog.appendChild(title);

    // Show captcha image — large, using data URL.
    const imgEl = document.createElement("img");
    imgEl.src = dataURL;
    imgEl.style.cssText = [
      "display:block", "margin:8px auto 12px", "border:2px solid #e2e8f0",
      "border-radius:8px", "padding:8px", "background:#f8fafc",
      "min-width:200px", "min-height:40px",
      "transform:scale(1.5)", "transform-origin:center", "image-rendering:auto",
    ].join(";");
    dialog.appendChild(imgEl);

    // Spacer after scaled image.
    const spacer = document.createElement("div");
    spacer.style.cssText = "height:20px;";
    dialog.appendChild(spacer);

    // Refresh captcha button.
    const refreshRow = document.createElement("div");
    refreshRow.style.cssText = "margin-bottom:12px;";
    const refreshBtn = document.createElement("button");
    refreshBtn.textContent = "🔄 New Captcha";
    refreshBtn.style.cssText = "padding:5px 12px;border:1px solid #cbd5e1;border-radius:8px;background:#f8fafc;cursor:pointer;font-size:12px;color:#475569;";
    refreshBtn.addEventListener("click", () => {
      // Click the refresh icon on the actual page.
      const refreshIcon = captchaImg.parentElement?.querySelector(".fa-repeat, .fa-refresh, [class*='refresh'], [class*='repeat']")
        || captchaImg.nextElementSibling
        || document.querySelector(".fa-repeat, .fa-refresh");
      if (refreshIcon) {
        refreshIcon.click();
        setTimeout(async () => {
          const newImg = document.querySelector(
            "img.captcha-img, img[alt*='captcha'], img[alt*='Captcha'], img[src*='captcha'], app-captcha img"
          ) || findCaptchaImgFallback();
          if (newImg) {
            // Re-fetch via GM_xmlhttpRequest for CORS-free OCR.
            try {
              const newDataURL = await fetchImageAsDataURL(newImg.src);
              imgEl.src = newDataURL;
              const ocrImg = new Image();
              ocrImg.onload = () => {
                const newGuesses = guessCaptcha(ocrImg);
                updateGuessButtons(guessContainer, newGuesses, input);
              };
              ocrImg.src = newDataURL;
            } catch (_e) {
              imgEl.src = captchaToDataURL(newImg);
              updateGuessButtons(guessContainer, guessCaptcha(newImg), input);
            }
          }
        }, 1200);
      }
    });
    refreshRow.appendChild(refreshBtn);
    dialog.appendChild(refreshRow);

    // Guess buttons.
    const guessLabel = document.createElement("div");
    guessLabel.textContent = "Best guesses (click to use):";
    guessLabel.style.cssText = "font-size:12px;color:#64748b;margin-bottom:6px;";
    dialog.appendChild(guessLabel);

    const guessContainer = document.createElement("div");
    guessContainer.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin-bottom:14px;";
    dialog.appendChild(guessContainer);

    // Input field.
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Type captcha here...";
    input.autocomplete = "off";
    input.style.cssText = [
      "width:100%", "padding:12px 16px", "font-size:22px", "font-weight:700",
      "text-align:center", "letter-spacing:4px",
      "border:2px solid #3b82f6", "border-radius:10px", "outline:none",
      "box-sizing:border-box", "margin-bottom:14px",
    ].join(";");
    dialog.appendChild(input);

    // Populate guess buttons — start with "loading" state.
    const loadingMsg = document.createElement("span");
    loadingMsg.textContent = "Reading captcha...";
    loadingMsg.style.cssText = "font-size:12px;color:#3b82f6;font-style:italic;";
    guessContainer.appendChild(loadingMsg);

    // Run OCR asynchronously — always wait for image to fully load.
    if (preloadedDataURL) {
      const ocrImg = new Image();
      ocrImg.onload = () => {
        console.log("[IRCTC Helper] OCR image loaded:", ocrImg.naturalWidth, "x", ocrImg.naturalHeight);
        const ocrGuesses = guessCaptcha(ocrImg);
        console.log("[IRCTC Helper] OCR guesses:", ocrGuesses);
        updateGuessButtons(guessContainer, ocrGuesses, input);
      };
      ocrImg.onerror = () => {
        console.log("[IRCTC Helper] OCR image failed to load.");
        updateGuessButtons(guessContainer, [], input);
      };
      ocrImg.src = preloadedDataURL;
    } else {
      // No CORS-free image — try with original (may fail due to tainted canvas).
      const fallbackGuesses = guessCaptcha(captchaImg);
      updateGuessButtons(guessContainer, fallbackGuesses, input);
    }

    // Submit button row.
    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;gap:10px;justify-content:center;";

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.cssText = "padding:10px 24px;border:1px solid #cbd5e1;border-radius:10px;background:#f1f5f9;cursor:pointer;font-size:14px;font-weight:600;color:#475569;";
    cancelBtn.addEventListener("click", () => overlay.remove());
    btnRow.appendChild(cancelBtn);

    const submitBtn = document.createElement("button");
    submitBtn.textContent = "Submit & Continue ▶";
    submitBtn.style.cssText = "padding:10px 24px;border:none;border-radius:10px;background:linear-gradient(135deg,#16a34a,#15803d);color:#fff;cursor:pointer;font-size:14px;font-weight:700;box-shadow:0 4px 12px rgba(22,163,74,.3);";
    submitBtn.addEventListener("click", () => {
      const value = input.value.trim();
      if (!value) {
        input.style.borderColor = "#ef4444";
        input.focus();
        return;
      }
      submitCaptcha(value, captchaInput, overlay);
    });
    btnRow.appendChild(submitBtn);
    dialog.appendChild(btnRow);

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // Auto-focus the input.
    setTimeout(() => input.focus(), 100);

    // Enter key submits.
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submitBtn.click();
      }
      if (e.key === "Escape") {
        overlay.remove();
      }
    });
  }

  function updateGuessButtons(container, guesses, input) {
    container.innerHTML = "";
    if (guesses.length === 0) {
      const noGuess = document.createElement("span");
      noGuess.textContent = "Could not read captcha — please type it";
      noGuess.style.cssText = "font-size:12px;color:#94a3b8;font-style:italic;";
      container.appendChild(noGuess);
      return;
    }
    for (const guess of guesses) {
      const btn = document.createElement("button");
      btn.textContent = guess;
      btn.style.cssText = [
        "padding:8px 16px", "border:2px solid #3b82f6", "border-radius:8px",
        "background:#eff6ff", "color:#1e40af", "cursor:pointer",
        "font-size:16px", "font-weight:700", "letter-spacing:2px",
        "font-family:monospace",
        "transition:all .15s",
      ].join(";");
      btn.addEventListener("mouseenter", () => {
        btn.style.background = "#3b82f6";
        btn.style.color = "#fff";
      });
      btn.addEventListener("mouseleave", () => {
        btn.style.background = "#eff6ff";
        btn.style.color = "#1e40af";
      });
      btn.addEventListener("click", () => {
        input.value = guess;
        input.focus();
        input.style.borderColor = "#3b82f6";
      });
      container.appendChild(btn);
    }
  }

  async function submitCaptcha(value, captchaInput, overlay) {
    if (captchaInput) {
      // Set the captcha value using Angular-compatible method.
      setNativeValue(captchaInput, value);
      captchaInput.focus();
      captchaInput.dispatchEvent(new Event("input", { bubbles: true }));
      captchaInput.dispatchEvent(new Event("change", { bubbles: true }));
      console.log("[IRCTC Helper] Filled captcha:", value);
    }

    overlay.remove();
    await sleep(500);

    // Click the Continue button.
    const continueBtn = [...document.querySelectorAll("button")].find((btn) => {
      return visible(btn) && normalize(btn.textContent).includes("continue");
    });

    if (continueBtn) {
      continueBtn.scrollIntoView({ behavior: "smooth", block: "center" });
      await sleep(300);
      continueBtn.click();
      showBanner("Captcha submitted. Proceeding to payment...");
      console.log("[IRCTC Helper] Clicked Continue on review page.");
    } else {
      showBanner("Captcha filled. Click Continue manually.", "error");
    }
  }

  function hasVisibleTextMatch(matcher, selector = "button, a, div, span, strong, p") {
    return [...document.querySelectorAll(selector)].some((node) => {
      return visible(node) && matcher(normalize(node.textContent));
    });
  }

  function isLoggedIn() {
    // Fast check: just look at the page body text for login indicators.
    const bodyText = normalize(document.body.textContent || "");
    const hasWelcome = bodyText.includes("welcome ") || bodyText.includes("my account");
    const hasLoginPrompt = bodyText.includes("login / register") || bodyText.includes("login/register");

    const result = hasWelcome && !hasLoginPrompt;
    console.log("[IRCTC Helper] isLoggedIn:", result, "| welcome:", hasWelcome, "| loginPrompt:", hasLoginPrompt);
    return result;
  }

  function showPresetPicker(presets, selectedId) {
    return new Promise((resolve) => {
      document.getElementById("irctc-helper-picker-overlay")?.remove();

      const overlay = document.createElement("div");
      overlay.id = "irctc-helper-picker-overlay";
      overlay.style.cssText = [
        "position:fixed",
        "inset:0",
        "z-index:999998",
        "display:flex",
        "align-items:center",
        "justify-content:center",
        "padding:20px",
        "background:rgba(15,23,42,.58)",
        "backdrop-filter:blur(3px)",
      ].join(";");

      const modal = document.createElement("div");
      modal.style.cssText = [
        "width:min(560px,100%)",
        "max-height:min(80vh,700px)",
        "overflow:auto",
        "padding:24px",
        "border-radius:20px",
        "background:#0f172a",
        "box-shadow:0 24px 64px rgba(15,23,42,.45)",
        "font:500 14px/1.5 system-ui,sans-serif",
        "color:#e5eefb",
      ].join(";");

      const title = document.createElement("div");
      title.textContent = "Choose a preset";
      title.style.cssText = "font-size:22px;font-weight:700;color:#fff;";

      const subtitle = document.createElement("div");
      subtitle.textContent = "Select the preset for this run. You can also delete presets here.";
      subtitle.style.cssText = "margin-top:6px;color:#bfd3ea;";

      const list = document.createElement("div");
      list.style.cssText = "display:grid;gap:12px;margin-top:18px;";

      let items = [...presets];

      const closePicker = (value) => {
        document.removeEventListener("keydown", handleKeyDown, true);
        overlay.remove();
        resolve(value);
      };

      const handleKeyDown = (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          closePicker(null);
          return;
        }

        if (/^[1-9]$/.test(event.key)) {
          const preset = items[Number(event.key) - 1];
          if (preset) {
            event.preventDefault();
            closePicker({ presetId: preset.preset_id });
          }
        }
      };

      const renderPresetCards = () => {
        list.innerHTML = "";

        if (items.length === 0) {
          const empty = document.createElement("div");
          empty.textContent = "No presets left. Save a new one in your local IRCTC Helper app.";
          empty.style.cssText = [
            "padding:20px",
            "border:1px dashed rgba(148,163,184,.35)",
            "border-radius:16px",
            "color:#bfd3ea",
          ].join(";");
          list.appendChild(empty);
          return;
        }

        items.forEach((preset, index) => {
          const card = document.createElement("div");
          const isLastUsed = preset.preset_id === selectedId;
          card.style.cssText = [
            "display:grid",
            "gap:12px",
            "padding:16px 18px",
            "border:1px solid rgba(148,163,184,.28)",
            "border-radius:16px",
            isLastUsed ? "background:rgba(15,118,110,.28)" : "background:rgba(30,41,59,.92)",
            isLastUsed ? "border-color:#38bdf8" : "",
          ].filter(Boolean).join(";");

          const selectButton = document.createElement("button");
          selectButton.type = "button";
          selectButton.style.cssText = [
            "width:100%",
            "display:flex",
            "flex-direction:column",
            "align-items:flex-start",
            "gap:6px",
            "padding:0",
            "border:none",
            "background:transparent",
            "color:#fff",
            "text-align:left",
            "cursor:pointer",
          ].join(";");
          selectButton.addEventListener("click", () => closePicker({ presetId: preset.preset_id }));

          const heading = document.createElement("div");
          heading.style.cssText = "display:flex;align-items:center;gap:10px;flex-wrap:wrap;";

          const hotkey = document.createElement("span");
          hotkey.textContent = `${index + 1}`;
          hotkey.style.cssText = [
            "display:inline-flex",
            "align-items:center",
            "justify-content:center",
            "min-width:24px",
            "height:24px",
            "padding:0 8px",
            "border-radius:999px",
            "background:#1d4ed8",
            "font-size:12px",
            "font-weight:700",
            "color:#fff",
          ].join(";");

          const label = document.createElement("span");
          label.textContent = preset.label || `Preset ${index + 1}`;
          label.style.cssText = "font-size:16px;font-weight:700;";

          heading.appendChild(hotkey);
          heading.appendChild(label);

          if (isLastUsed) {
            const badge = document.createElement("span");
            badge.textContent = "Last used";
            badge.style.cssText = [
              "display:inline-flex",
              "align-items:center",
              "height:24px",
              "padding:0 10px",
              "border-radius:999px",
              "background:rgba(56,189,248,.16)",
              "font-size:12px",
              "font-weight:700",
              "color:#7dd3fc",
            ].join(";");
            heading.appendChild(badge);
          }

          const summary = document.createElement("div");
          summary.textContent = presetSummary(preset) || "Saved preset";
          summary.style.cssText = "color:#dbe7f5;";

          const meta = document.createElement("div");
          meta.textContent = `ID: ${preset.preset_id}`;
          meta.style.cssText = "font-size:12px;color:#94a3b8;";

          selectButton.appendChild(heading);
          selectButton.appendChild(summary);
          selectButton.appendChild(meta);

          const footer = document.createElement("div");
          footer.style.cssText = "display:flex;justify-content:flex-end;gap:10px;";

          const deleteButton = document.createElement("button");
          deleteButton.type = "button";
          deleteButton.textContent = "Delete";
          deleteButton.style.cssText = [
            "padding:8px 12px",
            "border:1px solid rgba(248,113,113,.35)",
            "border-radius:12px",
            "background:rgba(127,29,29,.18)",
            "color:#fecaca",
            "cursor:pointer",
          ].join(";");
          deleteButton.addEventListener("click", async (event) => {
            event.preventDefault();
            event.stopPropagation();

            const confirmed = window.confirm(`Delete preset "${preset.label || preset.preset_id}"?`);
            if (!confirmed) {
              return;
            }

            deleteButton.disabled = true;
            deleteButton.textContent = "Deleting...";
            try {
              await deletePresetById(preset.preset_id);
              items = items.filter((item) => item.preset_id !== preset.preset_id);
              if (selectedId === preset.preset_id) {
                selectedId = null;
              }
              showBanner(`Deleted preset: ${preset.label || preset.preset_id}`);
              renderPresetCards();
            } catch (error) {
              showBanner(error.message || "Could not delete preset.", "error");
              deleteButton.disabled = false;
              deleteButton.textContent = "Delete";
            }
          });

          footer.appendChild(deleteButton);
          card.appendChild(selectButton);
          card.appendChild(footer);
          list.appendChild(card);
        });
      };

      document.addEventListener("keydown", handleKeyDown, true);
      renderPresetCards();

      const actions = document.createElement("div");
      actions.style.cssText = "display:flex;justify-content:flex-end;margin-top:16px;";

      const cancelButton = document.createElement("button");
      cancelButton.type = "button";
      cancelButton.textContent = "Cancel";
      cancelButton.style.cssText = [
        "padding:10px 16px",
        "border:1px solid rgba(148,163,184,.28)",
        "border-radius:12px",
        "background:transparent",
        "color:#e5eefb",
        "cursor:pointer",
      ].join(";");
      cancelButton.addEventListener("click", () => closePicker(null));

      actions.appendChild(cancelButton);
      modal.appendChild(title);
      modal.appendChild(subtitle);
      modal.appendChild(list);
      modal.appendChild(actions);
      overlay.appendChild(modal);
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) {
          closePicker(null);
        }
      });

      document.body.appendChild(overlay);
      list.querySelector("button")?.focus();
    });
  }

  async function choosePreset() {
    const presets = await requestJson(`${API_BASE}/presets`);
    if (!Array.isArray(presets) || presets.length === 0) {
      clearActivePresetId();
      showBanner("No presets found in your local IRCTC Helper app.", "error");
      return null;
    }

    const choice = await showPresetPicker(presets, getLastUsedPresetId());
    if (!choice?.presetId) {
      return null;
    }

    const selected =
      presets.find((preset) => preset.preset_id === String(choice.presetId).trim()) ||
      presets[Number(choice.presetId) - 1];

    if (!selected) {
      showBanner("Preset not found.", "error");
      return null;
    }

    setActivePresetId(selected.preset_id);
    showBanner(`Selected preset: ${selected.label}`);
    return selected.preset_id;
  }

  async function loadPreset(options = {}) {
    const { forcePick = false, promptIfMissing = false, autoFallback = false } = options;
    let presetId = forcePick ? null : getActivePresetId();

    // Auto-fallback: if no session preset, try the last-used preset from
    // localStorage so continuation pages (train-list, psgninput) work
    // automatically without requiring the user to pick again.
    if (!presetId && autoFallback) {
      presetId = getLastUsedPresetId();
    }

    // Auto-fallback to default preset if nothing else found.
    if (!presetId && autoFallback) {
      const defaultPreset = await getDefaultPreset();
      if (defaultPreset) {
        presetId = defaultPreset.preset_id;
      }
    }

    if (!presetId && (forcePick || promptIfMissing)) {
      presetId = await choosePreset();
    }

    if (!presetId) {
      return null;
    }

    try {
      const preset = await requestJson(`${API_BASE}/presets/${presetId}`);
      setActivePresetId(presetId);
      return preset;
    } catch (error) {
      if (getActivePresetId() === presetId) {
        clearActivePresetId();
      }
      throw error;
    }
  }

  async function runPrefill(options = {}) {
    try {
      const preset = await loadPreset(options);
      if (!preset) {
        return;
      }

       if (isPastJourneyDate(preset.journey_date)) {
        showBanner(
          `Preset date ${formatDate(preset.journey_date)} is before today ${formatDate(todayIsoLocal())}. Update or recreate the preset first.`,
          "error"
        );
        return;
      }

      if (isPassengerPage()) {
        await handlePassengerPage(preset);
        return;
      }

      if (isTrainListPage()) {
        if (!trainListFiltersMatchPreset(preset)) {
          const root = getSearchPanelRoot();
          showBanner(
            `Results page differs from preset. Now: ${currentSearchSummary(root)}. Expected: ${expectedSearchSummary(preset)}.`,
            "error"
          );
          return;
        }

        await handleTrainListPage(preset);
        return;
      }

      if (!isTrainSearchPage()) {
        return;
      }

      await fillSearchForm(preset);
      await sleep(150);
      setNativeValue(findElement(SELECTORS.mobile), preset.mobile_number);
      setNativeValue(findElement(SELECTORS.email), preset.email);

      (preset.passengers || []).forEach((passenger, index) => {
        fillPassenger(passenger, index + 1);
      });

      await sleep(150);
      await handleSearchSubmission();
      showBanner(`Filled fields from preset: ${preset.label}`);
    } catch (error) {
      console.error("IRCTC Helper prefill failed", error);
      showBanner("Could not load preset from http://127.0.0.1:5000. Keep the local app running.", "error");
    }
  }

  function stopLoginWatcher() {
    if (loginWatcherId) {
      window.clearInterval(loginWatcherId);
      loginWatcherId = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Default preset — auto-pick without showing the picker dialog.
  // ---------------------------------------------------------------------------

  async function getDefaultPreset() {
    try {
      const presets = await requestJson(`${API_BASE}/presets`);
      if (!Array.isArray(presets)) {
        return null;
      }
      return presets.find((p) => p.is_default) || null;
    } catch (_error) {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // GO Button + Tatkal countdown on the IRCTC home/search page.
  // ---------------------------------------------------------------------------

  let goButtonElement = null;
  let countdownIntervalId = null;

  function removeGoButton() {
    if (goButtonElement) {
      goButtonElement.remove();
      goButtonElement = null;
    }
    if (countdownIntervalId) {
      window.clearInterval(countdownIntervalId);
      countdownIntervalId = null;
    }
  }

  function getTatkalTime() {
    // Tatkal booking opens at 10:00 AM for AC classes, 11:00 AM for non-AC.
    // We use 10:00 as the default; users wanting 11:00 can adjust.
    return { hours: 10, minutes: 0, seconds: 0 };
  }

  function secondsUntilTatkal() {
    const now = new Date();
    const target = getTatkalTime();
    const tatkal = new Date(now);
    tatkal.setHours(target.hours, target.minutes, target.seconds, 0);
    const diff = (tatkal - now) / 1000;
    return diff;
  }

  function formatCountdown(totalSeconds) {
    if (totalSeconds <= 0) {
      return "00:00:00";
    }
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = Math.floor(totalSeconds % 60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  async function launchGo() {
    removeGoButton();
    homeFlowStarted = true;
    console.log("[IRCTC Helper] launchGo called.");

    try {
      // If there's a default preset, use it directly; otherwise show picker.
      const defaultPreset = await getDefaultPreset();
      console.log("[IRCTC Helper] Default preset:", defaultPreset ? defaultPreset.label : "none");
      if (defaultPreset) {
        setActivePresetId(defaultPreset.preset_id);
        showBanner(`Using default preset: ${defaultPreset.label}`);
        await runPrefill({ autoFallback: true });
      } else {
        await runPrefill({ forcePick: true });
      }
    } catch (err) {
      console.error("[IRCTC Helper] launchGo error:", err);
      showBanner("GO failed: " + (err.message || err), "error");
    }
  }

  function showGoButton() {
    if (goButtonElement) {
      return; // Already showing.
    }

    const container = document.createElement("div");
    container.id = "irctc-helper-go-panel";
    container.style.cssText = [
      "position:fixed",
      "top:12px",
      "right:16px",
      "z-index:999999",
      "display:flex",
      "flex-direction:column",
      "align-items:center",
      "gap:6px",
      "padding:14px 18px",
      "border-radius:16px",
      "background:linear-gradient(135deg,#1e293b,#0f172a)",
      "box-shadow:0 12px 32px rgba(0,0,0,.35)",
      "font-family:system-ui,sans-serif",
      "color:#e2e8f0",
    ].join(";");

    const presetLabel = document.createElement("div");
    presetLabel.id = "irctc-go-preset-label";
    presetLabel.style.cssText = "font-size:11px;color:#94a3b8;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    presetLabel.textContent = "Loading preset...";
    container.appendChild(presetLabel);

    const countdown = document.createElement("div");
    countdown.id = "irctc-go-countdown";
    countdown.style.cssText = "font-size:22px;font-weight:700;font-variant-numeric:tabular-nums;color:#38bdf8;letter-spacing:1px;";
    countdown.textContent = formatCountdown(secondsUntilTatkal());
    container.appendChild(countdown);

    const goBtn = document.createElement("button");
    goBtn.id = "irctc-go-button";
    goBtn.textContent = "▶  GO NOW";
    goBtn.style.cssText = [
      "margin-top:4px",
      "padding:10px 28px",
      "border:none",
      "border-radius:12px",
      "background:linear-gradient(135deg,#16a34a,#15803d)",
      "color:#fff",
      "font:700 15px/1 system-ui,sans-serif",
      "cursor:pointer",
      "letter-spacing:0.5px",
      "box-shadow:0 4px 12px rgba(22,163,74,.4)",
      "transition:transform .1s",
    ].join(";");
    goBtn.addEventListener("mouseenter", () => { goBtn.style.transform = "scale(1.05)"; });
    goBtn.addEventListener("mouseleave", () => { goBtn.style.transform = "scale(1)"; });
    goBtn.addEventListener("click", launchGo);
    container.appendChild(goBtn);

    const hint = document.createElement("div");
    hint.style.cssText = "font-size:10px;color:#64748b;margin-top:2px;";
    hint.textContent = "Auto-runs at 10:00:00 • or click GO";
    container.appendChild(hint);

    document.body.appendChild(container);
    goButtonElement = container;

    // Load default preset label.
    getDefaultPreset().then((preset) => {
      if (preset) {
        presetLabel.textContent = `Default: ${preset.label}`;
      } else {
        presetLabel.textContent = "No default preset — will ask";
      }
    });

    // Update countdown every second; auto-launch ONLY during the tatkal window
    // (within 2 seconds of 10:00:00), not anytime after 10:00.
    let tatkalAutoLaunched = false;
    countdownIntervalId = window.setInterval(() => {
      const remaining = secondsUntilTatkal();
      countdown.textContent = formatCountdown(remaining);

      // Only auto-launch if we're within 2 seconds of tatkal time (not hours later).
      if (remaining <= 0 && remaining > -2 && !homeFlowStarted && !tatkalAutoLaunched) {
        tatkalAutoLaunched = true;
        countdown.textContent = "LAUNCHING...";
        countdown.style.color = "#4ade80";
        launchGo();
      }

      // If past tatkal time, just show 00:00:00 and keep GO button visible.
      if (remaining <= 0) {
        countdown.textContent = "00:00:00 — Click GO";
        countdown.style.color = "#4ade80";
      }
    }, 200);
  }

  function startHomePageLoginFlow() {
    homeFlowStarted = false;
    clearActivePresetId();
    stopLoginWatcher();

    console.log("[IRCTC Helper] startHomePageLoginFlow called. isTrainSearchPage:", isTrainSearchPage());

    // Show GO button once user is logged in. Check frequently.
    const maybeShowGo = () => {
      if (!isTrainSearchPage()) {
        console.log("[IRCTC Helper] Not on search page, stopping watcher.");
        stopLoginWatcher();
        return;
      }
      if (!isLoggedIn()) {
        return; // Keep waiting.
      }
      console.log("[IRCTC Helper] User logged in! Showing GO button.");
      stopLoginWatcher();
      if (!goButtonElement && !homeFlowStarted) {
        showGoButton();
      }
    };

    maybeShowGo();
    if (!goButtonElement && !homeFlowStarted) {
      loginWatcherId = window.setInterval(maybeShowGo, 500);
    }
  }

  GM_registerMenuCommand("Choose IRCTC preset", choosePreset);
  GM_registerMenuCommand("Fill current page", () => runPrefill({ promptIfMissing: true }));
  GM_registerMenuCommand("GO NOW", launchGo);

  // --- SPA-aware page router -------------------------------------------
  // IRCTC is an Angular SPA — navigating from train-search to train-list
  // to psgninput does NOT trigger a full page reload.  We must watch for
  // URL changes and dispatch the right handler each time.

  let lastHandledPath = "";
  let routerRunning = false;

  function routePage() {
    const path = window.location.pathname;

    // Don't re-run for the same path.
    if (path === lastHandledPath) {
      return;
    }
    lastHandledPath = path;

    console.log("[IRCTC Helper] Route detected:", path);

    // Clean up GO button when leaving the search page.
    if (!isTrainSearchPage()) {
      removeGoButton();
    }

    if (isTrainSearchPage()) {
      window.setTimeout(startHomePageLoginFlow, 800);
      return;
    }

    if (isTrainListPage()) {
      window.setTimeout(() => runPrefill({ autoFallback: true, promptIfMissing: true }), 1200);
      return;
    }

    if (isPassengerPage()) {
      window.setTimeout(() => runPrefill({ autoFallback: true, promptIfMissing: true }), 1200);
      return;
    }

    if (isReviewPage()) {
      window.setTimeout(handleReviewPage, 1200);
    }
  }

  // Start the router: run once immediately (Tampermonkey runs at document-idle,
  // so window.load may have already fired), then poll for URL changes.
  function initRouter() {
    migrateLegacyPresetStorage();
    routePage();

    if (!routerRunning) {
      routerRunning = true;
      window.setInterval(routePage, 1500);
    }
  }

  // Run immediately if page already loaded, otherwise wait for load.
  if (document.readyState === "complete") {
    initRouter();
  } else {
    window.addEventListener("load", initRouter);
  }

  // Also catch Angular pushState/replaceState navigation immediately.
  const origPushState = history.pushState;
  const origReplaceState = history.replaceState;
  history.pushState = function (...args) {
    origPushState.apply(this, args);
    window.setTimeout(routePage, 500);
  };
  history.replaceState = function (...args) {
    origReplaceState.apply(this, args);
    window.setTimeout(routePage, 500);
  };
  window.addEventListener("popstate", () => window.setTimeout(routePage, 500));
})();
