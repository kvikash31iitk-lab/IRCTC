// ==UserScript==
// @name         IRCTC Helper Prefill
// @namespace    local.irctc.helper
// @version      1.0.9
// @description  Fetches a saved preset from your local IRCTC Helper app and fills visible passenger/contact fields after you log in.
// @match        https://www.irctc.co.in/*
// @downloadURL  http://127.0.0.1:5000/tampermonkey/irctc-helper.user.js
// @updateURL    http://127.0.0.1:5000/tampermonkey/irctc-helper.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      127.0.0.1
// @connect      localhost
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
      await sleep(300);
      await setPrimeAutocomplete(SELECTORS.to, preset.to_station, root);
      await sleep(300);
      await setJourneyDate(preset.journey_date, root);
      await sleep(300);
      await setPrimeDropdown(SELECTORS.classDropdown, mapClassLabel(preset.travel_class), root);
      await sleep(300);
      await setPrimeDropdown(SELECTORS.quotaDropdown, mapQuotaLabel(preset.quota), root);
    };

    await applyFields(getSearchPanelRoot());

    const retryRoot = getSearchPanelRoot();
    await sleep(500);

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

    const bookButtons = [...document.querySelectorAll("button, a")].filter((node) => {
      return visible(node) && normalize(node.textContent).includes("book now");
    });

    for (const button of bookButtons) {
      let current = button;
      for (let depth = 0; current && depth < 10; depth += 1) {
        if (normalize(current.textContent).includes(target)) {
          return current;
        }
        current = current.parentElement;
      }
    }

    const headings = [...document.querySelectorAll(".train-heading strong, .train-heading, strong, div, span")]
      .filter(visible);
    for (const heading of headings) {
      if (!normalize(heading.textContent).includes(`(${target})`) && !normalize(heading.textContent).includes(target)) {
        continue;
      }

      let current = heading;
      for (let depth = 0; current && depth < 10; depth += 1) {
        const hasBookNow = [...current.querySelectorAll("button, a")].some((node) =>
          visible(node) && normalize(node.textContent).includes("book now")
        );
        if (hasBookNow) {
          return current;
        }
        current = current.parentElement;
      }
    }

    return null;
  }

  async function findTrainCard(trainNumber) {
    const startingY = window.scrollY;
    let previousHeight = -1;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const card = findTrainCardInDom(trainNumber);
      if (card) {
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        await sleep(500);
        return card;
      }

      const height = document.body.scrollHeight;
      if (height === previousHeight) {
        break;
      }

      previousHeight = height;
      window.scrollBy({ top: Math.max(window.innerHeight * 0.85, 600), behavior: "smooth" });
      await sleep(900);
    }

    window.scrollTo({ top: startingY, behavior: "smooth" });
    await sleep(300);
    return findTrainCardInDom(trainNumber);
  }

  async function clickPreferredClass(card, preset) {
    if (!card || !preset?.travel_class) {
      return false;
    }

    const targets = classSearchTokens(preset.travel_class);
    const candidates = [...card.querySelectorAll("button, a, div, span, label, li")]
      .filter(visible)
      .map((node) => {
        const text = normalize(node.textContent);
        const matches = targets.filter((target) => text === target || text.startsWith(target) || text.includes(target));
        const excluded =
          text.includes("book now") ||
          text.includes("other dates") ||
          text.includes("cnf probability") ||
          text.includes("train schedule");

        return {
          node,
          text,
          matches,
          excluded,
          hasRefresh: text.includes("refresh"),
        };
      })
      .filter((item) => item.matches.length > 0 && !item.excluded)
      .sort((left, right) => {
        if (left.hasRefresh !== right.hasRefresh) {
          return left.hasRefresh ? -1 : 1;
        }

        const leftExact = left.matches.some((target) => left.text === target) ? 0 : 1;
        const rightExact = right.matches.some((target) => right.text === target) ? 0 : 1;
        if (leftExact !== rightExact) {
          return leftExact - rightExact;
        }

        if (left.text.length !== right.text.length) {
          return left.text.length - right.text.length;
        }

        return left.matches[0].length - right.matches[0].length;
      });

    for (const match of candidates) {
      const clickTargets = collectClassClickTargets(match.node, card, targets);
      for (const clickTarget of clickTargets) {
        triggerUiClick(clickTarget);
        await sleep(700);
        const refreshedCard = findTrainCardInDom(preset.train_number) || card;
        if (isTrainCardActivated(refreshedCard, preset)) {
          return true;
        }
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

  function findRefreshTargetsForClass(card, preset) {
    if (!card || !preset?.travel_class) {
      return [];
    }

    const targets = classSearchTokens(preset.travel_class);
    const matchingNodes = [...card.querySelectorAll("button, a, div, span, label, li")]
      .filter(visible)
      .filter((node) => {
        const text = normalize(node.textContent);
        return text && targets.some((target) => text.includes(target));
      });

    const refreshTargets = [];
    for (const node of matchingNodes) {
      let current = node;
      for (let depth = 0; current && current !== card && depth < 5; depth += 1) {
        const exactRefreshLink = [
          ...current.querySelectorAll("div.pre-avl[tabindex='0'] div.col-xs-12.link, div.pre-avl .col-xs-12.link, div.col-xs-12.link"),
        ].find((child) => {
          return visible(child) && normalize(child.textContent).includes("refresh");
        });

        const exactPreAvl = [
          ...current.querySelectorAll("div.pre-avl[tabindex='0'], div[tabindex='0'].pre-avl"),
        ].find(visible);

        if (exactRefreshLink) {
          refreshTargets.push(exactRefreshLink);
        }

        if (exactPreAvl) {
          refreshTargets.push(exactPreAvl);
        }

        const innerRefresh = [
          ...current.querySelectorAll("button, a, div, span, i, svg"),
        ].find((child) => {
          if (!visible(child)) {
            return false;
          }

          const text = normalize(child.textContent);
          const classText = normalize(child.className);
          return (
            text.includes("refresh") ||
            classText.includes("refresh") ||
            classText.includes("sync") ||
            classText.includes("reload")
          );
        });

        if (innerRefresh) {
          refreshTargets.push(resolveClickable(innerRefresh, current));
        }

        if (normalize(current.textContent).includes("refresh")) {
          refreshTargets.push(resolveClickable(current, card));
        }

        current = current.parentElement;
      }
    }

    return uniqueElements(refreshTargets);
  }

  async function clickPreferredRefresh(card, preset) {
    const refreshTargets = findRefreshTargetsForClass(card, preset);
    for (const target of refreshTargets) {
      const focusTarget =
        target.closest?.("div.pre-avl[tabindex='0'], div[tabindex='0'].pre-avl") ||
        (target.getAttribute?.("tabindex") === "0" ? target : null);

      if (focusTarget) {
        triggerFocusableActivation(focusTarget);
        await sleep(180);
      }

      triggerUiClick(target);
      await sleep(900);
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

  async function handleTrainListPage(preset) {
    if (!window.location.pathname.includes("/nget/booking/train-list")) {
      return false;
    }

    const card = await findTrainCard(preset.train_number);
    if (!card) {
      showBanner(`Train ${preset.train_number || ""} not found on this results page.`, "error");
      return false;
    }

    closeOpenOverlays();
    await sleep(200);
    let activated = await clickPreferredClass(card, preset);
    if (!activated) {
      activated = await clickPreferredRefresh(card, preset);
    }

    if (!activated) {
      showBanner(`Could not select ${mapClassLabel(preset.travel_class)} for train ${preset.train_number}.`, "error");
      return false;
    }

    await sleep(1200);
    const availabilityClicked = await clickAvailabilityChoice(findTrainCardInDom(preset.train_number) || card, preset, 3500);
    if (availabilityClicked) {
      await sleep(900);
    }

    const refreshedCard = findTrainCardInDom(preset.train_number) || card;
    const bookNowButton = await waitForBookNowButton(refreshedCard, 6000);
    if (bookNowButton) {
      bookNowButton.scrollIntoView({ behavior: "smooth", block: "center" });
      triggerUiClick(bookNowButton);
      showBanner(`Opened Book Now for train ${preset.train_number}.`);
      return true;
    }

    if (clickBookNow(refreshedCard)) {
      showBanner(`Opened Book Now for train ${preset.train_number}.`);
      return true;
    }

    showBanner(`Book Now did not activate for train ${preset.train_number}.`, "error");
    return false;
  }

  function getBookNowButton(card, options = {}) {
    if (!card) {
      return null;
    }

    const { allowDisabled = false } = options;

    return [...card.querySelectorAll("button, a, div, span")].find((node) => {
      if (!visible(node)) {
        return false;
      }

      const text = normalize(node.textContent);
      const disabled =
        node.disabled ||
        node.getAttribute("aria-disabled") === "true" ||
        normalize(node.className).includes("disabled") ||
        normalize(node.className).includes("disable-book");
      return text.includes("book now") && (allowDisabled || !disabled);
    });
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
      statusNode,
      dateNode,
      choice,
      resolveClickable(choice, card),
      choice.closest("button, a, [role='button']"),
      choice.parentElement,
    ]);
  }

  async function clickAvailabilityChoice(card, preset, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const currentCard = findTrainCardInDom(preset.train_number) || card;
      if (getBookNowButton(currentCard)) {
        return true;
      }

      const choice = findAvailabilityChoice(currentCard, preset);
      if (choice) {
        const targets = buildAvailabilityClickTargets(choice, currentCard);

        for (const target of targets) {
          if (!target) {
            continue;
          }

          triggerUiClick(target);
          await sleep(700);

          const refreshedCard = findTrainCardInDom(preset.train_number) || currentCard;
          if (getBookNowButton(refreshedCard)) {
            return true;
          }
        }
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

  function hasVisibleTextMatch(matcher, selector = "button, a, div, span, strong, p") {
    return [...document.querySelectorAll(selector)].some((node) => {
      return visible(node) && matcher(normalize(node.textContent));
    });
  }

  function isLoggedIn() {
    const loginVisible = hasVisibleTextMatch((text) => {
      return text.includes("login / register") || text.includes("login/register");
    });

    const loggedInVisible = hasVisibleTextMatch((text) => {
      return text.includes("welcome ") || text.includes("my account");
    });

    return loggedInVisible && !loginVisible;
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
    const { forcePick = false, promptIfMissing = false } = options;
    let presetId = forcePick ? null : getActivePresetId();
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
      await sleep(500);
      setNativeValue(findElement(SELECTORS.mobile), preset.mobile_number);
      setNativeValue(findElement(SELECTORS.email), preset.email);

      (preset.passengers || []).forEach((passenger, index) => {
        fillPassenger(passenger, index + 1);
      });

      await sleep(400);
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

  function startHomePageLoginFlow() {
    homeFlowStarted = false;
    clearActivePresetId();
    stopLoginWatcher();

    const maybeStart = () => {
      if (!isTrainSearchPage()) {
        stopLoginWatcher();
        return;
      }

      if (!isLoggedIn() || homeFlowStarted) {
        return;
      }

      homeFlowStarted = true;
      stopLoginWatcher();
      window.setTimeout(() => {
        runPrefill({ forcePick: true });
      }, 500);
    };

    maybeStart();
    if (!homeFlowStarted) {
      loginWatcherId = window.setInterval(maybeStart, 1000);
    }
  }

  GM_registerMenuCommand("Choose IRCTC preset", choosePreset);
  GM_registerMenuCommand("Fill current page", () => runPrefill({ promptIfMissing: true }));

  window.addEventListener("load", () => {
    migrateLegacyPresetStorage();

    if (isTrainSearchPage()) {
      window.setTimeout(startHomePageLoginFlow, 1800);
      return;
    }

    if (isTrainListPage()) {
      window.setTimeout(() => runPrefill({ promptIfMissing: true }), 2500);
    }
  });
})();
