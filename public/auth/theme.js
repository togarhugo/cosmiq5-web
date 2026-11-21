/* Light / dark theme for Dive Manager (also used by the sign-in pages). Loaded in <head> so the right theme is set before anything is painted.
 * The choice is remembered on this device; until you choose, the phone's own light / dark setting is followed.
 * Any element with the attribute data-theme-switch becomes the switch: left = light, right = dark. */
(function () {
  "use strict";
  var KEY = "theme", root = document.documentElement;
  function saved() { try { var v = localStorage.getItem(KEY); return v === "light" || v === "dark" ? v : null; } catch (e) { return null; } }
  var mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  function system() { return mq && mq.matches ? "dark" : "light"; }
  function apply(t) {
    root.setAttribute("data-theme", t);
    var m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute("content", t === "dark" ? "#0d1117" : "#007bff");
    var sw = document.querySelectorAll(".theme-switch"); for (var i = 0; i < sw.length; i++) sw[i].setAttribute("aria-checked", t === "dark" ? "true" : "false");
  }
  apply(saved() || system());
  if (mq && mq.addEventListener) mq.addEventListener("change", function () { if (!saved()) apply(system()); });
  function set(t) { try { localStorage.setItem(KEY, t); } catch (e) {} apply(t); try { document.dispatchEvent(new CustomEvent("themechange", { detail: t })); } catch (e) {} }
  window.Theme = { get: function () { return root.getAttribute("data-theme"); }, set: set, toggle: function () { set(window.Theme.get() === "dark" ? "light" : "dark"); } };

  var CSS = ".theme-switch{position:relative;display:inline-block;width:62px;height:32px;min-height:32px;min-width:0;padding:0;border:0;border-radius:16px;cursor:pointer;background:#f1c40f;box-shadow:inset 0 1px 3px rgba(0,0,0,.25);transition:background .25s;-webkit-tap-highlight-color:transparent;vertical-align:middle}" +
    ".theme-switch[aria-checked=true]{background:#3b4a63}" +
    ".theme-switch svg{position:absolute;top:7px;width:18px;height:18px;pointer-events:none}" +
    ".theme-switch .ts-sun{left:7px;color:#7a5b00}.theme-switch .ts-moon{right:7px;color:#cbd5e1}" +
    ".theme-switch .ts-knob{position:absolute;top:3px;left:3px;width:26px;height:26px;border-radius:50%;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.35);transition:transform .25s}" +
    ".theme-switch[aria-checked=true] .ts-knob{transform:translateX(30px);background:#e6edf3}" +
    ".theme-switch:focus-visible{outline:3px solid #74c0fc;outline-offset:2px}" +
    "@media (prefers-reduced-motion:reduce){.theme-switch,.theme-switch .ts-knob{transition:none}}";
  var SUN = '<svg class="ts-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2" fill="currentColor"/><path d="M12 2.5v2.3M12 19.2v2.3M2.5 12h2.3M19.2 12h2.3M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6"/></svg>';
  var MOON = '<svg class="ts-moon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a8.6 8.6 0 1 0 11.1 11.1z"/></svg>';
  function mount() {
    if (!document.getElementById("theme-switch-css")) { var st = document.createElement("style"); st.id = "theme-switch-css"; st.textContent = CSS; document.head.appendChild(st); }
    var slots = document.querySelectorAll("[data-theme-switch]");
    for (var i = 0; i < slots.length; i++) {
      if (slots[i].firstChild) continue;
      var b = document.createElement("button"); b.type = "button"; b.className = "theme-switch"; b.setAttribute("role", "switch"); b.setAttribute("aria-label", "Dark mode");
      b.setAttribute("aria-checked", window.Theme.get() === "dark" ? "true" : "false"); b.title = "Light (left) / dark (right)";
      b.innerHTML = SUN + MOON + '<span class="ts-knob"></span>'; b.addEventListener("click", function () { window.Theme.toggle(); });
      slots[i].appendChild(b);
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
})();
