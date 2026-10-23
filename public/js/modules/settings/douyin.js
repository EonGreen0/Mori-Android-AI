import { t } from "../../i18n/index.js";
import { showToast } from "../../utils/index.js";

function getInvoke() {
  return (
    window.__TAURI__?.core?.invoke ||
    window.__TAURI_INTERNALS__?.invoke ||
    window.__TAURI__?.invoke ||
    null
  );
}

function setAuthUi(state) {
  const statusEl = document.getElementById("douyinAuthStatus");
  const logoutBtn = document.getElementById("douyinLogoutBtn");
  const verifyBtn = document.getElementById("douyinVerifyBtn");
  if (!statusEl) return;

  statusEl.dataset.state = state;
  if (state === "logged-in") {
    statusEl.textContent = t("douyin-status-logged-in");
    logoutBtn?.classList.remove("hidden");
    verifyBtn?.classList.add("hidden");
  } else if (state === "checking") {
    statusEl.textContent = t("douyin-status-checking");
    logoutBtn?.classList.add("hidden");
  } else if (state === "waiting") {
    statusEl.textContent = t("douyin-status-waiting");
    logoutBtn?.classList.add("hidden");
    verifyBtn?.classList.remove("hidden");
  } else if (state === "unsupported") {
    statusEl.textContent = t("douyin-status-desktop-only");
    logoutBtn?.classList.add("hidden");
    verifyBtn?.classList.add("hidden");
  } else {
    statusEl.textContent = t("douyin-status-not-logged-in");
    logoutBtn?.classList.add("hidden");
    verifyBtn?.classList.add("hidden");
  }
}

export async function refreshDouyinAuthStatus({ quiet = true } = {}) {
  const invoke = getInvoke();
  const loginBtn = document.getElementById("douyinLoginBtn");
  const hint = document.getElementById("douyinAuthHint");
  if (!loginBtn) return false;

  const isDesktop = document.documentElement.classList.contains("is-desktop");
  if (!invoke || !isDesktop) {
    setAuthUi("unsupported");
    loginBtn.classList.add("is-disabled");
    hint?.classList.add("hidden");
    return false;
  }

  loginBtn.classList.remove("is-disabled");
  setAuthUi("checking");
  try {
    const status = await invoke("tauri_douyin_auth_status", {});
    const loggedIn = status?.loggedIn === true;
    setAuthUi(loggedIn ? "logged-in" : "not-logged-in");
    return loggedIn;
  } catch (error) {
    console.warn("[Mori] Could not read Douyin login state:", error);
    setAuthUi("not-logged-in");
    if (!quiet) showToast(t("douyin-status-check-failed"));
    return false;
  }
}

async function verifyDouyinLogin({ quiet = false } = {}) {
  const invoke = getInvoke();
  if (!invoke) return false;
  setAuthUi("checking");
  try {
    const result = await invoke("tauri_douyin_verify_login", {});
    if (result?.loggedIn === true) {
      setAuthUi("logged-in");
      if (!quiet) showToast(t("douyin-login-success"));
      return true;
    }
    setAuthUi("waiting");
    if (!quiet) {
      showToast(
        result?.profileBusy
          ? t("douyin-login-profile-busy")
          : t("douyin-login-not-detected"),
      );
    }
    return false;
  } catch (error) {
    console.warn("[Mori] Could not verify Douyin login:", error);
    setAuthUi("waiting");
    if (!quiet) showToast(t("douyin-status-check-failed"));
    return false;
  }
}

export function initDouyinAuthSettings() {
  const loginBtn = document.getElementById("douyinLoginBtn");
  const verifyBtn = document.getElementById("douyinVerifyBtn");
  const logoutBtn = document.getElementById("douyinLogoutBtn");
  if (!loginBtn) return;

  loginBtn.addEventListener("click", async () => {
    if (loginBtn.classList.contains("is-disabled")) return;
    const invoke = getInvoke();
    if (!invoke) return;

    setAuthUi("waiting");
    try {
      const result = await invoke("tauri_douyin_login", {});
      if (result?.loggedIn) {
        setAuthUi("logged-in");
      } else {
        setAuthUi("waiting");
      }
      showToast(t("douyin-login-opened"));
    } catch (error) {
      console.warn("[Mori] Could not open Edge for Douyin login:", error);
      setAuthUi("not-logged-in");
      showToast(t("douyin-login-open-failed"));
    }
  });

  verifyBtn?.addEventListener("click", () => verifyDouyinLogin({ quiet: false }));

  logoutBtn?.addEventListener("click", async () => {
    const invoke = getInvoke();
    if (!invoke) return;
    setAuthUi("checking");
    try {
      await invoke("tauri_douyin_logout", {});
      setAuthUi("not-logged-in");
      showToast(t("douyin-logout-success"));
    } catch (error) {
      console.warn("[Mori] Could not clear Douyin login state:", error);
      showToast(t("douyin-logout-failed"));
      await refreshDouyinAuthStatus({ quiet: true });
    }
  });

  // Deliberately no focus/visibility polling. Login happens in a real Edge window;
  // the user explicitly asks Mori to verify after closing that dedicated window.
  refreshDouyinAuthStatus({ quiet: true });
}
