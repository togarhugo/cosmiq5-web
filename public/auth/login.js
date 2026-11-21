(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const err = (m) => { $("err").textContent = m || ""; };
  async function post(path, body) {
    const r = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    let data = {}; try { data = await r.json(); } catch (e) {}
    return { ok: r.ok, status: r.status, data };
  }
  $("form").addEventListener("submit", async (ev) => {
    ev.preventDefault(); err("");
    const email = $("email").value.trim().toLowerCase(), password = $("password").value, code = $("code").value.replace(/\s/g, "");
    if (!email || !password) return err("Enter your email and password.");
    if (!/^\d{6}$/.test(code)) return err("Enter the 6-digit code from your authenticator app.");
    const btn = $("go"); btn.disabled = true; const label = btn.textContent;
    try {
      btn.textContent = "Checking…";
      const pre = await post("/auth/prelogin", { email });
      if (!pre.ok || !Number.isInteger(pre.data.iter) || pre.data.iter < CosmiqKdf.MIN_ITER || pre.data.iter > CosmiqKdf.MAX_ITER)
        throw new Error("Unexpected response from the server.");
      btn.textContent = "Securing password…";           // ~0.3-1 s of PBKDF2 on a phone
      const key = await CosmiqKdf.deriveKey(password, pre.data.salt, pre.data.iter, email);
      btn.textContent = "Signing in…";
      const res = await post("/auth/password", { email, key, code });
      if (res.ok) { location.replace("/"); return; }
      err(res.data.error || "Sign-in failed.");
      $("code").value = ""; $("password").focus();
    } catch (e) { err(e.message || "Something went wrong. Check your connection and try again."); }
    finally { btn.disabled = false; btn.textContent = label; }
  });
})();
