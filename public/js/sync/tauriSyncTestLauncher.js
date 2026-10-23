function tauriInvoke() {
  return window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke || null;
}

// A developer-only launcher. Importing this module never creates a transport,
// reads a Planner Board, or schedules any sync work.
export async function installTauriSyncTestLauncher() {
  const invoke = tauriInvoke();
  if (!invoke) return;
  let available = false;
  try {
    available = await invoke("tauri_sync_available");
  } catch (_) {
    return;
  }
  if (!available) return;

  const menu = document.getElementById("settingsMainMenu");
  if (!menu || menu.querySelector("[data-mori-sync-test-launcher]")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.moriSyncTestLauncher = "";
  button.textContent = "打开合成同步诊断（测试版）";
  button.style.cssText = "display:block;margin:16px auto;padding:10px 16px;cursor:pointer";
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await invoke("tauri_open_sync_diagnostic");
    } catch (error) {
      button.textContent = `无法打开同步诊断：${String(error?.message || error)}`;
    } finally {
      button.disabled = false;
    }
  });
  menu.append(button);
  const shadow = document.createElement("button");
  shadow.type = "button";
  shadow.dataset.moriShadowSyncLauncher = "";
  shadow.textContent = "打开 Planner Shadow Sync（测试版）";
  shadow.style.cssText = "display:block;margin:16px auto;padding:10px 16px;cursor:pointer";
  shadow.addEventListener("click", async () => {
    shadow.disabled = true;
    try {
      await invoke("tauri_open_shadow_sync");
    } catch (error) {
      shadow.textContent = `无法打开 Shadow Sync：${String(error?.message || error)}`;
    } finally {
      shadow.disabled = false;
    }
  });
  menu.append(shadow);
}
