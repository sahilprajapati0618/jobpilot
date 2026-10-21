// Shared helpers for every JobPilot page: language (English / हिंदी / Hinglish), dark/light theme,
// translation of [data-t] elements, toasts, and a small fetch wrapper.
(function () {
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };

  let dict = { en: {} };
  let lang = store.get("jobpilot-lang") || "en";
  const listeners = [];

  const JP = {
    get lang() { return lang; },

    // Registers this page's translations and wires up [data-lang] buttons.
    initI18n(translations, onChange) {
      dict = translations;
      if (!dict[lang]) lang = "en";
      if (onChange) listeners.push(onChange);
      document.querySelectorAll("[data-lang]").forEach((b) =>
        b.addEventListener("click", () => JP.setLang(b.dataset.lang)),
      );
      JP.applyI18n();
    },

    setLang(next) {
      if (!dict[next]) return;
      lang = next;
      store.set("jobpilot-lang", lang);
      JP.applyI18n();
      listeners.forEach((fn) => fn(lang));
    },

    t(key, vars = {}) {
      const s = (dict[lang] && dict[lang][key]) ?? dict.en[key] ?? key;
      return String(s).replace(/\{(\w+)\}/g, (_, v) => (vars[v] ?? ""));
    },

    applyI18n(root = document) {
      document.documentElement.lang = lang === "hi" ? "hi" : "en";
      root.querySelectorAll("[data-t]").forEach((el) => (el.textContent = JP.t(el.dataset.t)));
      root.querySelectorAll("[data-th]").forEach((el) => (el.innerHTML = JP.t(el.dataset.th))); // trusted, page-defined markup
      root.querySelectorAll("[data-tp]").forEach((el) => (el.placeholder = JP.t(el.dataset.tp)));
      root.querySelectorAll("[data-ta]").forEach((el) => el.setAttribute("aria-label", JP.t(el.dataset.ta)));
      document.querySelectorAll("[data-lang]").forEach((b) => b.classList.toggle("on", b.dataset.lang === lang));
    },

    // Theme: saved choice, else OS preference. The <head> sets it early to avoid a flash.
    get theme() { return document.documentElement.dataset.theme; },
    toggleTheme() {
      const next = JP.theme === "light" ? "dark" : "light";
      document.documentElement.dataset.theme = next;
      store.set("jobpilot-theme", next);
      JP.syncThemeButtons();
    },
    syncThemeButtons() {
      document.querySelectorAll("[data-theme-toggle]").forEach((b) => (b.textContent = JP.theme === "light" ? "🌙" : "☀️"));
    },

    esc(s) {
      return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    },

    toast(msg) {
      let el = document.getElementById("toast");
      if (!el) {
        el = document.createElement("div");
        el.id = "toast";
        el.className = "toast";
        el.setAttribute("role", "status");
        document.body.appendChild(el);
      }
      el.textContent = msg;
      el.classList.add("show");
      clearTimeout(JP._toastTimer);
      JP._toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
    },

    // JSON fetch that throws Error{message, code, status} on failure.
    async api(path, opts = {}) {
      const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { code: data.code, status: res.status });
      return data;
    },

    // Error text in the current language when the server sent a known code.
    errMsg(err) {
      if (err && err.code && dict.en["err_" + err.code]) return JP.t("err_" + err.code);
      return (err && err.message) || JP.t("error");
    },
  };

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("[data-theme-toggle]").forEach((b) => b.addEventListener("click", JP.toggleTheme));
    JP.syncThemeButtons();
  });

  window.JP = JP;
})();
