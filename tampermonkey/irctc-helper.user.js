// ==UserScript==
// @name         IRCTC Helper Prefill
// @namespace    local.irctc.helper
// @version      0.1.0
// @description  Fetches a saved preset from your local IRCTC Helper app and fills visible passenger/contact fields after you log in.
// @match        https://www.irctc.co.in/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

(function () {
  "use strict";

  const STORAGE_KEY = "irctc-helper-selected-preset";
  const API_BASE = "http://127.0.0.1:5000/api";

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
      ".ui-dropdown[style*='width: 100%']",
      "p-dropdown[formcontrolname='journeyClass']",
      "p-dropdown[aria-label*='Class']",
    ],
    quotaDropdown: [
      ".ui-dropdown[style*='width: 100%']",
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

  function requestJson(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        onload: (response) => {
          try {
            resolve(JSON.parse(response.responseText));
          } catch (error) {
            reject(error);
          }
        },
        onerror: reject,
      });
    });
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

  function findElement(patterns, index = 1) {
    for (const pattern of patterns) {
      const selector = pattern.replaceAll("{n}", String(index));
      const matches = [...document.querySelectorAll(selector)].filter(visible);
      if (matches.length > 0) {
        return matches[Math.min(index - 1, matches.length - 1)];
      }
    }
    return null;
  }

  function findSearchboxByOrder(orderIndex) {
    const matches = [...document.querySelectorAll("input[role='searchbox']")].filter(visible);
    return matches[orderIndex] || null;
  }

  function findDateInput() {
    const matches = [
      ...document.querySelectorAll(".ui-calendar input[type='text'], input[type='text']"),
    ].filter((node) => visible(node) && node.getAttribute("role") !== "searchbox");
    return matches[0] || null;
  }

  function findDropdownByOrder(orderIndex) {
    const matches = [...document.querySelectorAll(".ui-dropdown")].filter(visible);
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

  function findPrimeDropdown(patterns) {
    for (const selector of patterns) {
      const matches = [...document.querySelectorAll(selector)].filter(visible);
      if (matches.length > 0) {
        return matches[0];
      }
    }

    return null;
  }

  async function setPrimeAutocomplete(patterns, value) {
    let input = findElement(patterns);
    if (!input && patterns === SELECTORS.from) {
      input = findSearchboxByOrder(0);
    }
    if (!input && patterns === SELECTORS.to) {
      input = findSearchboxByOrder(1);
    }
    if (!input || !value) {
      return false;
    }

    input.focus();
    setNativeValue(input, value);
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "ArrowDown" }));
    await sleep(900);

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
      option.click();
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
      return true;
    }

    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter" }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  async function setPrimeDropdown(patterns, text) {
    if (!text) {
      return false;
    }

    let dropdown = findPrimeDropdown(patterns);
    if (!dropdown && patterns === SELECTORS.classDropdown) {
      dropdown = findDropdownByOrder(0);
    }
    if (!dropdown && patterns === SELECTORS.quotaDropdown) {
      dropdown = findDropdownByOrder(1);
    }
    if (!dropdown) {
      return false;
    }

    dropdown.click();
    await sleep(400);

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

  async function setJourneyDate(value) {
    const input = findDateInput();
    if (!input || !value) {
      return false;
    }

    const formatted = formatDate(value);
    input.focus();
    input.click();
    setNativeValue(input, formatted);
    triggerKeyboardSequence(input, "Enter");
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("blur", { bubbles: true }));
    return true;
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
    await setPrimeAutocomplete(SELECTORS.from, preset.from_station);
    await sleep(300);
    await setPrimeAutocomplete(SELECTORS.to, preset.to_station);
    await sleep(300);
    await setJourneyDate(preset.journey_date);
    await sleep(300);
    await setPrimeDropdown(SELECTORS.classDropdown, mapClassLabel(preset.travel_class));
    await sleep(300);
    await setPrimeDropdown(SELECTORS.quotaDropdown, mapQuotaLabel(preset.quota));
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

  function findTrainCard(trainNumber) {
    const target = normalize(String(trainNumber || ""));
    if (!target) {
      return null;
    }

    const headings = [...document.querySelectorAll(".train-heading strong, .train-heading")].filter(visible);
    for (const heading of headings) {
      if (!normalize(heading.textContent).includes(target)) {
        continue;
      }

      let current = heading;
      for (let depth = 0; current && depth < 8; depth += 1) {
        const hasBookNow = [...current.querySelectorAll("button, a")].some((node) =>
          normalize(node.textContent).includes("book now")
        );
        if (hasBookNow) {
          return current;
        }
        current = current.parentElement;
      }
    }

    return null;
  }

  function clickPreferredClass(card, classValue) {
    if (!card || !classValue) {
      return false;
    }

    const targets = classSearchTokens(classValue);
    const candidates = [...card.querySelectorAll("button, a, div, span")].filter(visible);
    const match = candidates.find((node) => {
      const text = normalize(node.textContent);
      return (
        targets.some((target) => text === target || text.includes(target)) &&
        !text.includes("book now") &&
        !text.includes("other dates") &&
        !text.includes("refresh")
      );
    });

    if (!match) {
      return false;
    }

    match.click();
    return true;
  }

  function clickBookNow(card) {
    if (!card) {
      return false;
    }

    const button = [...card.querySelectorAll("button, a")].find((node) => {
      const text = normalize(node.textContent);
      const disabled =
        node.disabled ||
        node.getAttribute("aria-disabled") === "true" ||
        normalize(node.className).includes("disabled") ||
        normalize(node.className).includes("disable-book");
      return !disabled && text.includes("book now");
    });

    if (!button) {
      return false;
    }

    button.click();
    return true;
  }

  async function handleTrainListPage(preset) {
    if (!window.location.pathname.includes("/nget/booking/train-list")) {
      return false;
    }

    const card = findTrainCard(preset.train_number);
    if (!card) {
      showBanner(`Train ${preset.train_number || ""} not found on this results page.`, "error");
      return false;
    }

    closeOpenOverlays();
    await sleep(200);
    clickPreferredClass(card, preset.travel_class);
    await sleep(1000);
    closeOpenOverlays();
    await sleep(200);

    if (clickBookNow(card)) {
      showBanner(`Opened Book Now for train ${preset.train_number}.`);
      return true;
    }

    showBanner(`Book Now not available for train ${preset.train_number}.`, "error");
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

  async function choosePreset() {
    const presets = await requestJson(`${API_BASE}/presets`);
    if (!Array.isArray(presets) || presets.length === 0) {
      showBanner("No presets found in your local IRCTC Helper app.", "error");
      return null;
    }

    const message = presets
      .map((preset, idx) => `${idx + 1}. ${preset.label} [${preset.preset_id}]`)
      .join("\n");
    const choice = window.prompt(
      `Pick a preset number or ID:\n\n${message}`,
      localStorage.getItem(STORAGE_KEY) || presets[0].preset_id
    );

    if (!choice) {
      return null;
    }

    const selected =
      presets.find((preset) => preset.preset_id === choice.trim()) ||
      presets[Number(choice) - 1];

    if (!selected) {
      showBanner("Preset not found.", "error");
      return null;
    }

    localStorage.setItem(STORAGE_KEY, selected.preset_id);
    showBanner(`Selected preset: ${selected.label}`);
    return selected.preset_id;
  }

  async function loadPreset() {
    let presetId = localStorage.getItem(STORAGE_KEY);
    if (!presetId) {
      presetId = await choosePreset();
    }

    if (!presetId) {
      return null;
    }

    return requestJson(`${API_BASE}/presets/${presetId}`);
  }

  async function runPrefill() {
    try {
      const preset = await loadPreset();
      if (!preset) {
        return;
      }

      if (await handleTrainListPage(preset)) {
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

  GM_registerMenuCommand("Choose IRCTC preset", choosePreset);
  GM_registerMenuCommand("Fill current page", runPrefill);

  window.addEventListener("load", () => {
    window.setTimeout(runPrefill, 2500);
  });
})();
