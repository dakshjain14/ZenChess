// ==UserScript==
// @name         Chess.com Zen Mode
// @namespace    https://github.com/dakshjain14/ZenChess
// @version      0.1.0
// @description  Hides ratings on chess.com until you turn it off. Locked during games.
// @match        https://www.chess.com/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      api.chess.com
// @downloadURL  https://raw.githubusercontent.com/dakshjain14/ZenChess/main/chess-zen.user.js
// @updateURL    https://raw.githubusercontent.com/dakshjain14/ZenChess/main/chess-zen.user.js
// ==/UserScript==


(function () {
  "use strict";

  // from devtools
  const RATING_SELECTORS = [
    ".cc-user-rating-white", // names, hover card, lobby
    ".rating-score-rating",
    ".game-over-stat-card-value", // popup number, backup
  ];

  // text scan areas
  const SCAN_ZONES = [
    ".player-component",
    ".user-tagline-component",
    "[class*='game-over']",
  ].join(",");

  // loose match, popup root unknown
  const GAME_OVER_ZONE = "[class*='game-over']";

  // resign btn only there mid-game
  const LIVE_GAME_HINTS = [
    ".resign-button-component",
    "[data-cy='anchor-resign-confirmation']",
  ].join(",");

  const RATING_ONLY = /^\(?\d{3,4}\)?$/;
  const RATING_CHANGE = /^[+\-\u2212]\s?\d{1,3}$/;
  const RATING_LABELED = /\b(rating|rapid|blitz|bullet|daily)\b\D{0,12}\d{3,4}/i;
  const TITLE_RATING = /\s*\(\d{3,4}\)/g;

  const HOLD_MS = 3000;
  const root = document.documentElement;

  let zenOn = GM_getValue("zenOn", true);
  root.classList.toggle("zen-on", zenOn);

  // injected at document-start, no flash
  GM_addStyle(`
    html.zen-on :is(${RATING_SELECTORS.join(",")}),
    html.zen-on [data-zen-hidden] {
      visibility: hidden !important;
    }

    /* rating card in game-over popup */
    html.zen-on .game-over-stat-card-rating,
    html.zen-on .game-over-stats-single:has(.game-over-stat-card-rating) {
      display: none !important;
    }

    #zen-toggle {
      position: fixed;
      right: 20px;
      bottom: 80px;
      z-index: 9999;
      overflow: hidden;
      padding: 14px 22px;
      border-radius: 10px;
      font: 600 16px/1 system-ui, sans-serif;
      background: #262421;
      color: #bababa;
      font: 600 14px/1 system-ui, sans-serif;
      cursor: pointer;
      user-select: none;
    }
    html.zen-on #zen-toggle { color: #81b64c; }
    #zen-toggle .zen-fill {
      position: absolute;
      inset: 0;
      width: 0;
      background: rgba(129, 182, 76, 0.25);
    }
    #zen-toggle.holding .zen-fill {
      width: 100%;
      transition: width ${HOLD_MS}ms linear;
    }
    #zen-toggle .zen-label { position: relative; }

    #zen-toast {
      position: fixed;
      right: 20px;
      bottom: 66px; /* clear the btn */
      z-index: 9999;
      max-width: 260px;
      padding: 8px 11px;
      border-radius: 6px;
      background: #262421;
      color: #e8e6e3;
      font: 13px/1.4 system-ui, sans-serif;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
      transition: opacity 0.3s;
    }
  `);

  // hiding

  function hideRatingText(zone) {
    const walker = document.createTreeWalker(zone, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.nodeValue.trim();
      if (!text || text.length > 40) continue;

      const holder = node.parentElement;
      if (!holder || holder.hasAttribute("data-zen-hidden")) continue;
      if (holder.closest("#zen-toggle, #zen-toast")) continue;

      // +N popup only, material score is +N too
      const inGameOver = holder.closest(GAME_OVER_ZONE);
      const looksLikeRating =
        RATING_ONLY.test(text) ||
        RATING_LABELED.test(text) ||
        (inGameOver && RATING_CHANGE.test(text));

      if (looksLikeRating) holder.setAttribute("data-zen-hidden", "");
    }
  }

  function scrubTitle() {
    if (!zenOn) return;
    const cleanTitle = document.title.replace(TITLE_RATING, "");
    if (cleanTitle !== document.title) document.title = cleanTitle;
  }

  let scanQueued = false;
  function queueScan() {
    if (!zenOn || scanQueued) return;
    scanQueued = true;
    // runs before paint
    requestAnimationFrame(() => {
      scanQueued = false;
      document.querySelectorAll(SCAN_ZONES).forEach(hideRatingText);
    });
  }

  new MutationObserver(() => {
    scrubTitle(); // not in rAF, bg tabs pause it
    queueScan();
    // re-renders sometimes drop it
    if (toggleButton && !toggleButton.isConnected && document.body) {
      document.body.append(toggleButton);
    }
  }).observe(root, { childList: true, subtree: true, characterData: true });

  // state

  function gameIsLive() {
    return !!document.querySelector(LIVE_GAME_HINTS);
  }

  function setZen(on) {
    zenOn = on;
    GM_setValue("zenOn", on);
    root.classList.toggle("zen-on", on);
    updateLabel();
    if (on) {
      takeSnapshot();
      scrubTitle();
      queueScan();
    } else {
      showRecap();
    }
  }

  // alt+z / menu, can't hold so block
  function requestToggle() {
    if (zenOn && gameIsLive()) {
      showToast("Game's on. Hold the Zen button for 3s if you really want out.");
      return;
    }
    setZen(!zenOn);
  }

  // recap

  function fetchRatings(username) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: "GET",
        url: `https://api.chess.com/pub/player/${encodeURIComponent(username.toLowerCase())}/stats`,
        onload: (res) => {
          try {
            resolve(pickRatings(JSON.parse(res.responseText)));
          } catch {
            resolve(null);
          }
        },
        onerror: () => resolve(null),
      });
    });
  }

  function pickRatings(stats) {
    const ratings = {};
    for (const mode of ["bullet", "blitz", "rapid", "daily"]) {
      const rating = stats[`chess_${mode}`]?.last?.rating;
      if (rating) ratings[mode] = rating;
    }
    return ratings;
  }

  async function takeSnapshot() {
    const username = GM_getValue("username", "");
    if (!username) return;
    const ratings = await fetchRatings(username);
    if (ratings) GM_setValue("snapshot", ratings);
  }

  async function showRecap() {
    const username = GM_getValue("username", "");
    const before = GM_getValue("snapshot", null);
    if (!username || !before) return;

    const after = await fetchRatings(username);
    if (!after) {
      showToast("Couldn't reach chess.com for your recap.");
      return;
    }

    const changes = Object.keys(after)
      .filter((mode) => before[mode] && after[mode] !== before[mode])
      .map((mode) => {
        const diff = after[mode] - before[mode];
        return `${mode} ${diff > 0 ? "+" : ""}${diff}`;
      });

    showToast(
      changes.length
        ? `This session: ${changes.join(", ")}`
        : "No change showing yet. The API can lag behind, check again later."
    );
  }

  // ui

  let toggleButton;
  let toastTimer;

  function showToast(message) {
    let toast = document.getElementById("zen-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "zen-toast";
      document.body.append(toast);
    }
    toast.textContent = message;
    toast.style.opacity = "1";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.style.opacity = "0"), 5000);
  }

  function updateLabel() {
    if (!toggleButton) return;
    toggleButton.querySelector(".zen-label").textContent = zenOn ? "Zen on" : "Zen off";
  }

  function buildToggle() {
    toggleButton = document.createElement("button");
    toggleButton.id = "zen-toggle";
    toggleButton.type = "button";
    toggleButton.title = "Alt+Z to toggle. Mid-game: hold 3s to turn off";
    toggleButton.innerHTML = '<span class="zen-fill"></span><span class="zen-label"></span>';
    updateLabel();

    let holdTimer = null;

    const cancelHold = () => {
      clearTimeout(holdTimer);
      holdTimer = null;
      toggleButton.classList.remove("holding");
    };

    toggleButton.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      if (!zenOn || !gameIsLive()) {
        setZen(!zenOn);
        return;
      }
      // mid-game, hold to exit
      toggleButton.classList.add("holding");
      holdTimer = setTimeout(() => {
        cancelHold();
        setZen(false);
      }, HOLD_MS);
    });

    for (const type of ["pointerup", "pointerleave", "pointercancel"]) {
      toggleButton.addEventListener(type, cancelHold);
    }

    document.body.append(toggleButton);
  }

  document.addEventListener("keydown", (event) => {
    if (!event.altKey || event.code !== "KeyZ") return;
    if (event.target.closest?.("input, textarea, [contenteditable='true']")) return;
    event.preventDefault();
    requestToggle();
  });

  GM_registerMenuCommand("Toggle Zen Mode", requestToggle);
  GM_registerMenuCommand("Set chess.com username (for recap)", () => {
    const username = prompt("Your chess.com username:", GM_getValue("username", ""));
    if (username === null) return;
    GM_setValue("username", username.trim());
    // already on, snapshot now
    if (zenOn) takeSnapshot();
  });

  if (document.body) buildToggle();
  else document.addEventListener("DOMContentLoaded", buildToggle);
})();