/* Account tab: turn email + password + authenticator login on/off. Password is stretched in the browser. */
"use strict";
const Account = (() => {
  const $ = (id) => document.getElementById(id);
  let info = null, pw = "";
  const msg = (t, bad) => { const el = $("accMsg"); el.textContent = t || ""; el.style.color = bad ? "#c92a2a" : "#2b8a3e"; };
  async function api(method, path, body) {
    const r = await fetch(path, { method, credentials: "same-origin", redirect: "error", headers: { "content-type": "application/json" }, body: method === "GET" ? undefined : JSON.stringify(body || {}) });
    let data = {}; try { data = await r.json(); } catch (e) {}
    if (!r.ok) throw Object.assign(new Error(data.error || "Request failed (" + r.status + ")"), { status: r.status });
    return data;
  }
  const show = (id, on) => { $(id).style.display = on ? "" : "none"; };
  function steps(which) { for (const s of ["accStep1", "accStep2", "accRemove"]) show(s, s === which); show("accSetup", !!which); if (which) show("accChange", false); }

  async function load() {
    try { info = await api("GET", "/api/account"); } catch (e) { msg(e.status === 401 ? "Signed out: reload the page." : "Could not load account: " + e.message, true); return; }
    $("accVia").textContent = "Signed in as " + info.email + " via " + (info.via === "google" ? "Google" : "email + authenticator");
    $("accPwIcon").textContent = info.password ? "✓" : "○";
    $("accPwState").textContent = info.password ? "(on)" : "(off)";
    $("accSetupBtn").textContent = info.password ? "Reset authenticator" : "Set up email login";
    show("accChangeBtn", info.password);
    show("accRemoveBtn", info.password);
    show("accCurWrap", info.password);
  }

  function reset() { for (const id of ["accPw1", "accPw2", "accCur", "accCode", "accRmCode"]) $(id).value = ""; pw = ""; $("accQr").innerHTML = ""; $("accSecret").textContent = ""; steps(null); show("accChange", false); }

  async function next() {
    const a = $("accPw1").value, b = $("accPw2").value;
    if (a.length < 12) return msg("Use at least 12 characters.", true);
    if (a !== b) return msg("The two passwords don't match.", true);
    if (a.toLowerCase().includes(info.email.split("@")[0].toLowerCase())) return msg("Don't put your email name in the password.", true);
    if (info.password && !/^\d{6}$/.test($("accCur").value)) return msg("Enter your current 6-digit authenticator code.", true);
    msg("");
    try {
      const r = await api("POST", "/api/account/mfa/start");
      pw = a;
      const q = qrcode(0, "M"); q.addData(r.uri); q.make();
      $("accQr").innerHTML = q.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
      $("accSecret").textContent = r.secret.match(/.{1,4}/g).join(" ");
      steps("accStep2"); $("accCode").focus();
    } catch (e) { msg(e.message, true); }
  }

  async function finish() {
    const code = $("accCode").value.trim();
    if (!/^\d{6}$/.test(code)) return msg("Enter the 6-digit code from the app.", true);
    const btn = $("accFinish"); btn.disabled = true; btn.textContent = "Securing password…";
    try {
      const salt = CosmiqKdf.randomSalt(), iter = info.kdfIter;
      const key = await CosmiqKdf.deriveKey(pw, salt, iter, info.email);
      await api("POST", "/api/account/password", { salt, iter, key, code, currentCode: info.password ? $("accCur").value.trim() : undefined });
      reset(); await load(); msg("Email login is on. At the login page enter your email, password and the 6-digit code.");
    } catch (e) { msg(e.message, true); }
    finally { btn.disabled = false; btn.textContent = "Turn on email login"; }
  }

  async function remove() {
    const code = $("accRmCode").value.trim();
    if (!/^\d{6}$/.test(code)) return msg("Enter the 6-digit code.", true);
    try { await api("DELETE", "/api/account/password", { code }); reset(); await load(); msg("Email login removed. Google sign-in still works."); }
    catch (e) { msg(e.message, true); }
  }

  /** Change the password only: current password + current authenticator code, same authenticator. */
  async function changePw() {
    const cur = $("pwCur").value, n1 = $("pwNew1").value, n2 = $("pwNew2").value, code = $("pwCode").value.trim();
    if (!cur) return msg("Enter your current password.", true);
    if (n1.length < 12) return msg("The new password needs at least 12 characters.", true);
    if (n1 !== n2) return msg("The two new passwords don't match.", true);
    if (n1 === cur) return msg("The new password must be different from the current one.", true);
    if (n1.toLowerCase().includes(info.email.split("@")[0].toLowerCase())) return msg("Don't put your email name in the password.", true);
    if (!/^\d{6}$/.test(code)) return msg("Enter the 6-digit code from your authenticator app.", true);
    const btn = $("pwChangeGo"); btn.disabled = true; btn.textContent = "Securing password\u2026"; msg("");
    try {
      const pre = await fetch("/auth/prelogin", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: info.email }) }).then((r) => r.json());
      const currentKey = await CosmiqKdf.deriveKey(cur, pre.salt, pre.iter, info.email);
      const salt = CosmiqKdf.randomSalt(), iter = info.kdfIter, key = await CosmiqKdf.deriveKey(n1, salt, iter, info.email);
      await api("POST", "/api/account/password/change", { salt, iter, key, currentKey, currentCode: code });
      for (const id of ["pwCur", "pwNew1", "pwNew2", "pwCode"]) $(id).value = "";
      show("accChange", false); msg("Password changed. Use the new one next time you sign in with email.");
      if (window.toast) window.toast("Password changed", "ok");
    } catch (e) { msg(e.message, true); }
    finally { btn.disabled = false; btn.textContent = "Change password"; }
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("accChangeBtn").addEventListener("click", () => { msg(""); steps(null); show("accChange", true); $("pwCur").focus(); });
    $("pwChangeCancel").addEventListener("click", () => { for (const id of ["pwCur", "pwNew1", "pwNew2", "pwCode"]) $(id).value = ""; show("accChange", false); msg(""); });
    $("pwChangeGo").addEventListener("click", changePw);
    $("accSetupBtn").addEventListener("click", () => { msg(""); steps("accStep1"); });
    $("accRemoveBtn").addEventListener("click", () => { msg(""); steps("accRemove"); });
    $("accCancel").addEventListener("click", () => { msg(""); reset(); });
    $("accNext").addEventListener("click", next);
    $("accFinish").addEventListener("click", finish);
    $("accRmGo").addEventListener("click", remove);
  });
  return { load };
})();
