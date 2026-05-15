(function () {
  "use strict";

  const FILTER_ID = "satfat-filter-ui";
  const BADGE_CLASS = "satfat-badge";
  const DIMMED_CLASS = "sf-dimmed";
  const COLOR_GREEN = "#2e7d32";
  const COLOR_RED = "#d47b7b";
  const mealCache = {};
  const pendingFetches = new Set();
  let strictMode = false;
  let maxGrams = null;

  function getThreshold() {
    return strictMode ? 6 : 10;
  }

  function getToken() {
    const raw = document.cookie
      .split(";")
      .find((c) => c.trim().startsWith("apiV2Auth="));
    if (!raw) return null;
    try {
      const decoded = decodeURIComponent(
        raw.trim().substring("apiV2Auth=".length)
      );
      return JSON.parse(decoded).access_token || null;
    } catch {
      return null;
    }
  }

  function getMealCards() {
    return [...document.querySelectorAll("li")].filter((li) =>
      li.querySelector('[data-test-id="product-description-wrapper"]')
    );
  }

  function getMealId(li) {
    const el = li.querySelector('[data-test-id^="product-"]');
    const testId = el && el.getAttribute("data-test-id");
    return testId ? testId.replace("product-", "") : null;
  }

  async function fetchMealData(mealId, token) {
    if (mealCache[mealId] !== undefined) return mealCache[mealId];
    if (pendingFetches.has(mealId)) return undefined;
    pendingFetches.add(mealId);
    try {
      const res = await fetch(
        `/gw/recipes/recipes/${mealId}?country=FJ&locale=en-US`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) {
        mealCache[mealId] = null;
        return null;
      }
      const data = await res.json();
      const nutrients = Array.isArray(data?.nutrition) ? data.nutrition : [];
      const satFatEntry = nutrients.find((n) =>
        n.name?.toLowerCase().includes("saturated")
      );
      const calEntry = nutrients.find((n) =>
        n.name?.toLowerCase().includes("energy") ||
        n.name?.toLowerCase().includes("calorie")
      );
      const satFat = satFatEntry ? parseFloat(satFatEntry.amount) : null;
      const calories = calEntry ? parseFloat(calEntry.amount) : null;
      const pctCal = (satFat !== null && calories && calories > 0)
        ? Math.round((satFat * 9) / calories * 100)
        : null;
      const result = { satFat, calories, pctCal };
      mealCache[mealId] = result;
      return result;
    } catch {
      mealCache[mealId] = null;
      return null;
    } finally {
      pendingFetches.delete(mealId);
    }
  }

  function badgeColor(pctCal) {
    if (pctCal === null) return "#888";
    return pctCal <= getThreshold() ? COLOR_GREEN : COLOR_RED;
  }

  function badgeText(meal) {
    if (!meal || meal.satFat === null) return null;
    const pctPart = meal.pctCal !== null ? ` · ${meal.pctCal}%` : "";
    return `${meal.satFat}g sat fat${pctPart}`;
  }

  function ensureBadge(li, meal) {
    if (!meal || meal.satFat === null) return;
    const existing = li.querySelector(`.${BADGE_CLASS}`);
    if (existing) {
      existing.style.background = badgeColor(meal.pctCal);
      existing.textContent = badgeText(meal);
      return;
    }

    const badge = document.createElement("div");
    badge.className = BADGE_CLASS;
    badge.style.background = badgeColor(meal.pctCal);
    badge.textContent = badgeText(meal);

    const quickInfo = li.querySelector('[data-test-id="quick-info-container"]');
    if (quickInfo) {
      quickInfo.parentElement.insertBefore(badge, quickInfo.nextSibling);
    }
  }

  function applyDimming(li, meal) {
    if (maxGrams !== null && meal && meal.satFat !== null && meal.satFat > maxGrams) {
      li.classList.add(DIMMED_CLASS);
    } else {
      li.classList.remove(DIMMED_CLASS);
    }
  }

  function processCard(li) {
    const id = getMealId(li);
    const meal = mealCache[id];
    ensureBadge(li, meal);
    applyDimming(li, meal);
  }

  function processAllCards() {
    let good = 0, over = 0, dimmed = 0, noData = 0;
    const threshold = getThreshold();

    getMealCards().forEach((li) => {
      const id = getMealId(li);
      const meal = mealCache[id];
      ensureBadge(li, meal);
      applyDimming(li, meal);
      if (!meal || meal.pctCal === null) {
        noData++;
      } else if (meal.pctCal <= threshold) {
        good++;
      } else {
        over++;
      }
      if (maxGrams !== null && meal && meal.satFat !== null && meal.satFat > maxGrams) {
        dimmed++;
      }
    });

    const status = document.getElementById("sf-status");
    if (status) {
      const parts = [`${good} under ${threshold}%`];
      if (over > 0) parts.push(`${over} over`);
      if (dimmed > 0) parts.push(`${dimmed} grayed`);
      if (noData > 0) parts.push(`${noData} no data`);
      status.textContent = parts.join("  |  ");
    }
  }

  function startCardObserver() {
    const token = getToken();
    let debounceTimer = null;

    const observer = new MutationObserver(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        const cards = getMealCards();
        const needsFetch = [];

        for (const li of cards) {
          const id = getMealId(li);
          if (!id) continue;

          if (mealCache[id] !== undefined) {
            processCard(li);
          } else if (token && !pendingFetches.has(id)) {
            needsFetch.push({ li, id });
          }
        }

        if (needsFetch.length > 0 && token) {
          const BATCH = 4;
          for (let i = 0; i < needsFetch.length; i += BATCH) {
            const batch = needsFetch.slice(i, i + BATCH);
            await Promise.all(
              batch.map(async ({ li, id }) => {
                await fetchMealData(id, token);
                processCard(li);
                updateLoadCount();
              })
            );
          }
        }
      }, 200);
    });

    observer.observe(document.body, { childList: true, subtree: true });
    return observer;
  }

  function updateLoadCount() {
    const loadedEl = document.getElementById("sf-loaded");
    if (!loadedEl) return;
    const cached = Object.keys(mealCache).length;
    const pending = pendingFetches.size;
    if (pending > 0) {
      loadedEl.textContent = `${cached} loaded, ${pending} pending`;
    } else {
      loadedEl.textContent = `${cached} meals`;
    }
  }

  function buildUI() {
    const existing = document.getElementById(FILTER_ID);
    if (existing) existing.remove();

    const ui = document.createElement("div");
    ui.id = FILTER_ID;
    ui.innerHTML = `
      <div class="sf-header">
        <span>Sat Fat</span>
        <span id="sf-loaded">Loading...</span>
      </div>
      <div class="sf-toggle-row">
        <label>
          <input type="checkbox" id="sf-strict">
          <span class="sf-heart">&#x2764;&#xFE0F;</span>
          <span>Heart-healthy mode</span>
        </label>
        <span class="sf-threshold-label" id="sf-threshold-label">&le;10%</span>
      </div>
      <div class="sf-gram-row">
        <span>Gray out over</span>
        <input type="number" id="sf-max-grams" min="0" step="0.5" placeholder="--">
        <span class="sf-gram-label">g sat fat</span>
      </div>
      <div class="sf-buttons">
        <button id="sf-reload">Reload</button>
      </div>
      <div id="sf-status"></div>
    `;
    document.body.appendChild(ui);

    document.getElementById("sf-strict").addEventListener("change", function () {
      strictMode = this.checked;
      document.getElementById("sf-threshold-label").textContent =
        strictMode ? "≤6%" : "≤10%";
      processAllCards();
    });

    document.getElementById("sf-max-grams").addEventListener("input", function () {
      const val = parseFloat(this.value);
      maxGrams = (this.value === "" || isNaN(val)) ? null : val;
      processAllCards();
    });

    document.getElementById("sf-reload").addEventListener("click", () => {
      Object.keys(mealCache).forEach((k) => delete mealCache[k]);
      document.querySelectorAll(`.${BADGE_CLASS}`).forEach((b) => b.remove());
      getMealCards().forEach((li) => li.classList.remove(DIMMED_CLASS));
      document.getElementById("sf-max-grams").value = "";
      maxGrams = null;
      document.getElementById("sf-status").textContent = "";
      loadInitialBatch();
    });
  }

  async function loadInitialBatch() {
    const token = getToken();
    const loadedEl = document.getElementById("sf-loaded");

    if (!token) {
      if (loadedEl) loadedEl.textContent = "Not logged in";
      return;
    }

    const cards = getMealCards();
    if (loadedEl) loadedEl.textContent = `0/${cards.length}`;

    let done = 0;
    const BATCH = 4;

    for (let i = 0; i < cards.length; i += BATCH) {
      const batch = cards.slice(i, i + BATCH);
      await Promise.all(
        batch.map(async (li) => {
          const id = getMealId(li);
          if (!id) return;
          await fetchMealData(id, token);
          done++;
          processCard(li);
          if (loadedEl) loadedEl.textContent = `${done}/${cards.length}`;
        })
      );
    }

    if (loadedEl) loadedEl.textContent = `${done} meals`;
    processAllCards();
  }

  function init() {
    buildUI();
    loadInitialBatch();
    startCardObserver();
  }

  function waitForMeals() {
    if (getMealCards().length > 0) {
      init();
      return;
    }
    const observer = new MutationObserver(() => {
      if (getMealCards().length > 0) {
        observer.disconnect();
        init();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      if (location.pathname.startsWith("/store")) {
        setTimeout(waitForMeals, 800);
      }
    }
  }).observe(document, { subtree: true, childList: true });

  waitForMeals();
})();
