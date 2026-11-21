(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const boxes = Array.from($("boxes").querySelectorAll("input"));
  const err = (m) => { $("err").textContent = m || ""; };
  const value = () => boxes.map((b) => b.value).join("");
  let busy = false;

  function setDigits(str, from) {                       // fill boxes starting at `from`, return index after the last filled
    let i = from;
    for (const ch of str.replace(/\D/g, "")) { if (i >= boxes.length) break; boxes[i].value = ch; boxes[i].classList.add("filled"); i++; }
    return i;
  }
  function clearAll() { boxes.forEach((b) => { b.value = ""; b.classList.remove("filled"); }); boxes[0].focus(); }
  function maybeSubmit() { if (value().length === 6 && !busy) $("form").requestSubmit ? $("form").requestSubmit() : submit(); }

  boxes.forEach((box, i) => {
    box.addEventListener("input", () => {
      err(""); $("boxes").classList.remove("bad");
      const digits = box.value.replace(/\D/g, "");
      if (!digits) { box.value = ""; box.classList.remove("filled"); return; }
      box.value = digits[0]; box.classList.add("filled");
      const next = digits.length > 1 ? setDigits(digits.slice(1), i + 1) : i + 1;   // several digits at once (autofill / fast typing)
      (boxes[Math.min(next, boxes.length - 1)]).focus();
      maybeSubmit();
    });
    box.addEventListener("keydown", (e) => {
      if (e.key === "Backspace" && !box.value && i > 0) { boxes[i - 1].value = ""; boxes[i - 1].classList.remove("filled"); boxes[i - 1].focus(); e.preventDefault(); }
      else if (e.key === "ArrowLeft" && i > 0) { boxes[i - 1].focus(); e.preventDefault(); }
      else if (e.key === "ArrowRight" && i < boxes.length - 1) { boxes[i + 1].focus(); e.preventDefault(); }
    });
    box.addEventListener("focus", () => box.select());
    box.addEventListener("paste", (e) => {
      e.preventDefault(); err("");
      const text = (e.clipboardData || window.clipboardData).getData("text");
      if (!/\d/.test(text)) return;
      const next = setDigits(text, text.replace(/\D/g, "").length >= 6 ? 0 : i);
      boxes[Math.min(next, boxes.length - 1)].focus(); maybeSubmit();
    });
  });

  async function submit() {
    if (busy) return;
    const code = value();
    if (code.length !== 6) { err("Enter all 6 digits."); (boxes.find((b) => !b.value) || boxes[0]).focus(); return; }
    busy = true; $("go").disabled = true; const label = $("go").textContent; $("go").textContent = "Verifying\u2026";
    try {
      const r = await fetch("/auth/mfa", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
      let data = {}; try { data = await r.json(); } catch (e) {}
      if (r.ok) { location.replace("/"); return; }
      if (data.restart) { err(data.error); setTimeout(() => location.replace("/auth/login"), 1800); return; }
      err(data.error || "Verification failed.");
      $("boxes").classList.add("bad"); clearAll();
    } catch (e) { err("Could not reach the server. Check your connection and try again."); }
    finally { busy = false; $("go").disabled = false; $("go").textContent = label; }
  }
  $("form").addEventListener("submit", (e) => { e.preventDefault(); submit(); });
  boxes[0].focus();
})();
