use std::collections::HashMap;
use base64::{
    engine::general_purpose::{
        STANDARD as BASE64_STANDARD,
        STANDARD_NO_PAD as BASE64_STANDARD_NO_PAD,
        URL_SAFE as BASE64_URL_SAFE,
        URL_SAFE_NO_PAD as BASE64_URL_SAFE_NO_PAD,
    },
    Engine as _,
};
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};

mod download_target;
#[cfg(target_os = "windows")]
mod clipboard_image;

const DOUYIN_LOGIN_URL: &str = "https://www.douyin.com/";

#[cfg(desktop)]
fn douyin_profile_dir() -> std::path::PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("Mori")
        .join("DouyinProfileV3")
}

#[cfg(desktop)]
fn douyin_edge_user_data_dir() -> std::path::PathBuf {
    douyin_profile_dir().join("EBWebView")
}

#[cfg(desktop)]
fn find_microsoft_edge() -> Option<std::path::PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(base) = std::env::var("PROGRAMFILES(X86)") {
        candidates.push(std::path::PathBuf::from(base).join("Microsoft/Edge/Application/msedge.exe"));
    }
    if let Ok(base) = std::env::var("PROGRAMFILES") {
        candidates.push(std::path::PathBuf::from(base).join("Microsoft/Edge/Application/msedge.exe"));
    }
    if let Some(base) = dirs::data_local_dir() {
        candidates.push(base.join("Microsoft/Edge/Application/msedge.exe"));
    }
    candidates.into_iter().find(|path| path.is_file())
}

#[cfg(desktop)]
fn douyin_login_marker() -> std::path::PathBuf {
    douyin_profile_dir().join("mori-login-ok")
}

#[cfg(desktop)]
fn set_douyin_login_marker(logged_in: bool) -> Result<(), String> {
    let marker = douyin_login_marker();
    if logged_in {
        if let Some(parent) = marker.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Could not create Douyin profile directory: {e}"))?;
        }
        std::fs::write(marker, b"ok")
            .map_err(|e| format!("Could not save Douyin login state: {e}"))?;
    } else if marker.exists() {
        std::fs::remove_file(marker)
            .map_err(|e| format!("Could not clear Douyin login state: {e}"))?;
    }
    Ok(())
}

#[cfg(desktop)]
fn douyin_cookie_names_indicate_login<I, S>(names: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    names.into_iter().any(|name| {
        matches!(
            name.as_ref().to_ascii_lowercase().as_str(),
            "sessionid" | "sessionid_ss" | "sid_guard" | "sid_tt"
        )
    })
}

#[cfg(desktop)]
fn douyin_window_logged_in(window: &tauri::WebviewWindow) -> bool {
    if let Ok(cookies) = window.cookies() {
        if douyin_cookie_names_indicate_login(cookies.iter().map(|cookie| cookie.name())) {
            return true;
        }
    }
    let url = match tauri::Url::parse("https://www.douyin.com/") {
        Ok(url) => url,
        Err(_) => return false,
    };
    match window.cookies_for_url(url) {
        Ok(cookies) => douyin_cookie_names_indicate_login(cookies.iter().map(|cookie| cookie.name())),
        Err(_) => false,
    }
}

async fn tauri_douyin_webview_login_legacy(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(desktop)]
    {
        if let Some(window) = app.get_webview_window("douyin-login") {
            let logged_in = douyin_window_logged_in(&window);
            if logged_in {
                let _ = set_douyin_login_marker(true);
            } else if let Ok(login_url) = tauri::Url::parse(DOUYIN_LOGIN_URL) {
                let _ = window.navigate(login_url);
            }
            let _ = window.show();
            let _ = window.set_focus();
            return Ok(serde_json::json!({
                "opened": true,
                "loggedIn": logged_in
            }));
        }

        let profile_dir = douyin_profile_dir();
        std::fs::create_dir_all(&profile_dir)
            .map_err(|e| format!("Could not create Douyin profile directory: {e}"))?;
        let url = tauri::Url::parse(DOUYIN_LOGIN_URL)
            .map_err(|e| format!("Invalid Douyin login URL: {e}"))?;
        let login_helper = r#"
(() => {
  if (window.__moriDouyinLoginHelper) return;
  window.__moriDouyinLoginHelper = true;
  const run = () => {
    const text = (document.body?.innerText || '').trim();
    const hasLoginUi = /扫码登录|密码登录|验证码登录|手机号登录|登录抖音/.test(text) ||
      !!document.querySelector('canvas, img[src*="qr" i], [class*="qrcode" i], [class*="qr-code" i]');

    // If the SSO page is blocked into a tiny challenge/blank shell, fall back to the
    // regular Douyin page using the same real WebView2 profile. The homepage can then
    // open its own first-party login modal.
    if (!hasLoginUi && location.hostname === 'sso.douyin.com' &&
        (text.length < 120 || /please wait|waf|challenge/i.test(text))) {
      setTimeout(() => {
        const latest = (document.body?.innerText || '').trim();
        if (!/扫码登录|密码登录|验证码登录|手机号登录|登录抖音/.test(latest)) {
          location.replace('https://www.douyin.com/');
        }
      }, 5500);
    }

    // On the normal homepage, open the official login modal automatically so the user
    // does not have to hunt for a small login button.
    if (location.hostname === 'www.douyin.com') {
      let attempts = 0;
      const timer = setInterval(() => {
        attempts += 1;
        const candidates = Array.from(document.querySelectorAll('button, a, div, span'));
        const target = candidates.find((el) => {
          const label = (el.textContent || '').trim();
          const rect = el.getBoundingClientRect?.();
          return (label === '登录' || label === '立即登录') && rect && rect.width > 0 && rect.height > 0;
        });
        if (target) {
          target.click();
          clearInterval(timer);
        } else if (attempts >= 12) {
          clearInterval(timer);
        }
      }, 650);
    }

    // Never leave the user staring at an unexplained blank spinner forever.
    setTimeout(() => {
      if (!document.body || document.getElementById('mori-douyin-load-help')) return;
      const latest = (document.body.innerText || '').trim();
      const ready = /扫码登录|密码登录|验证码登录|手机号登录|登录抖音/.test(latest) ||
        !!document.querySelector('canvas, img[src*="qr" i], [class*="qrcode" i], [class*="qr-code" i]');
      if (ready) return;
      const help = document.createElement('div');
      help.id = 'mori-douyin-load-help';
      help.style.cssText = 'position:fixed;z-index:2147483647;left:18px;right:18px;bottom:18px;padding:14px 16px;border-radius:12px;background:rgba(18,18,18,.94);color:#fff;font:14px/1.5 system-ui;box-shadow:0 10px 35px rgba(0,0,0,.35)';
      help.innerHTML = '<strong>Mori：抖音登录页加载较慢</strong><div style="margin-top:5px;opacity:.78">可以先刷新；如果仍然空白，切换到抖音主页再打开登录。</div><div style="display:flex;gap:8px;margin-top:10px"><button id="mori-douyin-reload" style="padding:7px 12px">刷新</button><button id="mori-douyin-home" style="padding:7px 12px">打开抖音主页</button></div>';
      document.body.appendChild(help);
      document.getElementById('mori-douyin-reload')?.addEventListener('click', () => location.reload());
      document.getElementById('mori-douyin-home')?.addEventListener('click', () => location.replace('https://www.douyin.com/'));
    }, 12000);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true });
  else run();
})();
"#;
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "douyin-login",
            tauri::WebviewUrl::External(url),
        )
        .title("Mori · Douyin Login")
        .inner_size(980.0, 760.0)
        .min_inner_size(720.0, 560.0)
        .data_directory(profile_dir)
        .initialization_script(login_helper)
        .on_page_load(|window, _payload| {
            if douyin_window_logged_in(&window) {
                let _ = set_douyin_login_marker(true);
                // Login is complete. Close the dedicated Douyin window immediately so
                // a post-login redirect/refresh loop cannot trap keyboard focus away
                // from Mori's main window.
                let _ = window.close();
            }
        })
        .build()
        .map_err(|e| format!("Could not open Douyin login window: {e}"))?;
        let _ = window.set_focus();
        Ok(serde_json::json!({ "opened": true, "loggedIn": false }))
    }

    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("Douyin browser login is currently available on desktop only.".to_string())
    }
}

#[tauri::command]
async fn tauri_douyin_login(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(desktop)]
    {
        // Close the old embedded login window if it is still around. Douyin currently
        // returns risk-control error 4031 for QR login inside WebView2, so login now
        // happens in a real Edge window using Mori's dedicated browser profile.
        if let Some(window) = app.get_webview_window("douyin-login") {
            let _ = window.close();
        }

        let profile_dir = douyin_profile_dir();
        let edge_data_dir = douyin_edge_user_data_dir();
        std::fs::create_dir_all(&edge_data_dir)
            .map_err(|e| format!("Could not create Douyin Edge profile: {e}"))?;
        let edge = if let Some(edge) = find_microsoft_edge() {
            edge
        } else {
            return tauri_douyin_webview_login_legacy(app).await;
        };

        let user_data_arg = format!("--user-data-dir={}", edge_data_dir.to_string_lossy());
        std::process::Command::new(&edge)
            .arg(user_data_arg)
            .arg("--profile-directory=Default")
            .arg("--no-first-run")
            .arg("--no-default-browser-check")
            .arg("--disable-background-mode")
            .arg("--new-window")
            .arg(DOUYIN_LOGIN_URL)
            .spawn()
            .map_err(|e| format!("Could not open Microsoft Edge for Douyin login: {e}"))?;

        Ok(serde_json::json!({
            "opened": true,
            "loggedIn": douyin_login_marker().exists(),
            "browser": "Microsoft Edge",
            "profile": profile_dir.to_string_lossy()
        }))
    }

    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("Douyin browser login is currently available on desktop only.".to_string())
    }
}

#[tauri::command]
async fn tauri_douyin_auth_status(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(desktop)]
    {
        let profile_dir = douyin_profile_dir();
        if !profile_dir.exists() {
            return Ok(serde_json::json!({ "loggedIn": false, "profileExists": false }));
        }
        if let Some(window) = app.get_webview_window("douyin-login") {
            let logged_in = douyin_window_logged_in(&window);
            if logged_in {
                let _ = set_douyin_login_marker(true);
            }
            return Ok(serde_json::json!({
                "loggedIn": logged_in || douyin_login_marker().exists(),
                "profileExists": true
            }));
        }

        // Avoid loading Douyin in a hidden browser just to check auth state.
        // The real login window writes this local marker after a logged-in navigation.
        Ok(serde_json::json!({
            "loggedIn": douyin_login_marker().exists(),
            "profileExists": true
        }))
    }

    #[cfg(not(desktop))]
    {
        let _ = app;
        Ok(serde_json::json!({ "loggedIn": false, "profileExists": false, "supported": false }))
    }
}

#[tauri::command]
async fn tauri_douyin_verify_login(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(desktop)]
    {
        if douyin_login_marker().exists() {
            return Ok(serde_json::json!({
                "loggedIn": true,
                "profileBusy": false
            }));
        }

        let profile_dir = douyin_profile_dir();
        if !profile_dir.exists() {
            return Ok(serde_json::json!({
                "loggedIn": false,
                "profileBusy": false,
                "profileExists": false
            }));
        }

        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let label = format!("douyin-login-verify-{stamp}");
        let url = tauri::Url::parse("https://www.douyin.com/")
            .map_err(|e| format!("Invalid Douyin verification URL: {e}"))?;
        let window = match tauri::WebviewWindowBuilder::new(
            &app,
            label,
            tauri::WebviewUrl::External(url),
        )
        .visible(false)
        .skip_taskbar(true)
        .inner_size(2.0, 2.0)
        .data_directory(profile_dir)
        .build()
        {
            Ok(window) => window,
            Err(error) => {
                return Ok(serde_json::json!({
                    "loggedIn": false,
                    "profileBusy": true,
                    "message": format!("Close the Mori Douyin Edge window, then check again: {error}")
                }));
            }
        };

        std::thread::sleep(std::time::Duration::from_millis(650));
        let logged_in = douyin_window_logged_in(&window);
        if logged_in {
            let _ = set_douyin_login_marker(true);
        }
        let _ = window.close();
        Ok(serde_json::json!({
            "loggedIn": logged_in,
            "profileBusy": false,
            "profileExists": true
        }))
    }

    #[cfg(not(desktop))]
    {
        let _ = app;
        Ok(serde_json::json!({
            "loggedIn": false,
            "profileBusy": false,
            "supported": false
        }))
    }
}

#[tauri::command]
async fn tauri_douyin_logout(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(desktop)]
    {
        let profile_dir = douyin_profile_dir();
        std::fs::create_dir_all(&profile_dir)
            .map_err(|e| format!("Could not access Douyin profile directory: {e}"))?;
        let window = if let Some(window) = app.get_webview_window("douyin-login") {
            window
        } else {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();
            let label = format!("douyin-logout-{stamp}");
            let url = tauri::Url::parse("https://www.douyin.com/")
                .map_err(|e| format!("Invalid Douyin logout URL: {e}"))?;
            tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::External(url))
                .visible(false)
                .skip_taskbar(true)
                .inner_size(2.0, 2.0)
                .data_directory(profile_dir)
                .build()
                .map_err(|e| format!("Could not open Douyin logout session: {e}"))?
        };

        std::thread::sleep(std::time::Duration::from_millis(700));
        if let Ok(cookies) = window.cookies() {
            for cookie in cookies {
                let _ = window.delete_cookie(cookie);
            }
        }
        let _ = window.eval("try { localStorage.clear(); sessionStorage.clear(); } catch (_) {}");
        std::thread::sleep(std::time::Duration::from_millis(120));
        let _ = window.close();
        let _ = set_douyin_login_marker(false);
        Ok(serde_json::json!({ "loggedIn": false }))
    }

    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("Douyin browser logout is currently available on desktop only.".to_string())
    }
}

#[tauri::command]
async fn tauri_http_request(
    url: String,
    method: Option<String>,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .http1_only()
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
        .redirect(reqwest::redirect::Policy::limited(10))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let m = method.unwrap_or_else(|| "GET".to_string()).to_uppercase();
    let mut req = match m.as_str() {
        "POST" => client.post(&url),
        "PUT" => client.put(&url),
        "DELETE" => client.delete(&url),
        _ => client.get(&url),
    };

    if let Some(hdrs) = &headers {
        for (k, v) in hdrs {
            req = req.header(k, v);
        }
    }

    if let Some(b) = &body {
        req = req.body(b.clone());
    }

    let (status, text, res_headers, final_url) = match req.send().await {
        Ok(res) => {
            let u = res.url().to_string();
            let s = res.status().as_u16();
            let mut hdrs = HashMap::new();
            for (k, v) in res.headers() {
                if let Ok(v_str) = v.to_str() {
                    hdrs.insert(k.as_str().to_string(), v_str.to_string());
                }
            }
            let t = res.text().await.unwrap_or_default();
            (s, t, hdrs, u)
        }
        Err(_) => {
            // Reqwest network error, attempt curl fallback
            if let Ok(curl_res) = run_curl_fallback(&url, &m, headers.as_ref(), body.as_deref()) {
                return Ok(curl_res);
            }
            return Err("Network request failed".to_string());
        }
    };

    let is_challenge_or_blocked = status == 403 || status == 429 || (status >= 400 && text.trim().starts_with('<'));
    if is_challenge_or_blocked {
        if let Ok(curl_res) = run_curl_fallback(&url, &m, headers.as_ref(), body.as_deref()) {
            let curl_status = curl_res["status"].as_u64().unwrap_or(0);
            let curl_data = curl_res["data"].as_str().unwrap_or("");
            if curl_status == 200 || !curl_data.trim().starts_with("<!DOCTYPE") {
                return Ok(curl_res);
            }
        }
    }

    Ok(serde_json::json!({
        "status": status,
        "headers": res_headers,
        "data": text,
        "url": final_url
    }))
}

fn extract_douyin_waf_challenge(html: &str) -> Option<String> {
    for marker in ["cs=\"", "cs='"] {
        if let Some(start) = html.find(marker) {
            let value_start = start + marker.len();
            let quote = marker.chars().last()?;
            let rest = &html[value_start..];
            if let Some(end) = rest.find(quote) {
                return Some(rest[..end].to_string());
            }
        }
    }
    None
}

fn decode_douyin_base64(value: &str, label: &str) -> Result<Vec<u8>, String> {
    let raw = value.trim();
    for engine in [
        &BASE64_STANDARD,
        &BASE64_STANDARD_NO_PAD,
        &BASE64_URL_SAFE,
        &BASE64_URL_SAFE_NO_PAD,
    ] {
        if let Ok(decoded) = engine.decode(raw.as_bytes()) {
            return Ok(decoded);
        }
    }

    // Some challenge payloads omit '=' padding even when using the standard alphabet.
    // Normalizing the length gives us one final tolerant decode path without changing
    // the challenge bytes themselves.
    let mut padded = raw.to_string();
    while padded.len() % 4 != 0 {
        padded.push('=');
    }
    BASE64_STANDARD
        .decode(padded.as_bytes())
        .or_else(|_| BASE64_URL_SAFE.decode(padded.as_bytes()))
        .map_err(|e| format!("Douyin WAF {label} base64 decode failed: {e}"))
}

fn solve_douyin_waf_cookie(html: &str) -> Result<(String, u32), String> {
    let encoded = extract_douyin_waf_challenge(html)
        .ok_or_else(|| "Douyin WAF challenge payload not found".to_string())?;
    let decoded = decode_douyin_base64(&encoded, "challenge")?;
    let mut challenge: serde_json::Value = serde_json::from_slice(&decoded)
        .map_err(|e| format!("Douyin WAF challenge JSON decode failed: {e}"))?;

    let prefix_b64 = challenge
        .pointer("/v/a")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "Douyin WAF prefix missing".to_string())?;
    let target_b64 = challenge
        .pointer("/v/c")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "Douyin WAF target missing".to_string())?;

    let prefix = decode_douyin_base64(prefix_b64, "prefix")?;
    let target = decode_douyin_base64(target_b64, "target")?;

    let mut seeded = Sha256::new();
    seeded.update(&prefix);
    let mut found = None;
    for nonce in 0u32..=1_000_000 {
        let mut hasher = seeded.clone();
        hasher.update(nonce.to_string().as_bytes());
        let digest = hasher.finalize();
        if digest.as_slice() == target.as_slice() {
            found = Some(nonce);
            break;
        }
    }

    let nonce = found.ok_or_else(|| "Douyin WAF proof-of-work solution not found".to_string())?;
    challenge["d"] = serde_json::Value::String(BASE64_STANDARD.encode(nonce.to_string().as_bytes()));
    let cookie_payload = serde_json::to_vec(&challenge)
        .map_err(|e| format!("Douyin WAF cookie serialization failed: {e}"))?;
    Ok((BASE64_STANDARD.encode(cookie_payload), nonce))
}

#[cfg(desktop)]
fn safe_frame_stem(value: &str) -> String {
    let mut result = value
        .chars()
        .map(|ch| {
            if matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || ch.is_control() {
                '_'
            } else {
                ch
            }
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string();
    if result.is_empty() {
        result = "Douyin_Frame".to_string();
    }
    result.chars().take(48).collect()
}

#[tauri::command]
async fn tauri_douyin_open_frame_picker(
    app: tauri::AppHandle,
    url: String,
    title: Option<String>,
) -> Result<serde_json::Value, String> {
    #[cfg(desktop)]
    {
        if !douyin_login_marker().exists() {
            return Err("Please sign in to Douyin first.".to_string());
        }

        let page_url = tauri::Url::parse(url.trim())
            .map_err(|e| format!("Invalid Douyin frame-picker URL: {e}"))?;
        if let Some(existing) = app.get_webview_window("douyin-frame-picker") {
            let _ = existing.close();
        }

        let source_url = url.trim().to_string();
        let frame_title = title.unwrap_or_else(|| "Douyin".to_string());
        let profile_dir = douyin_profile_dir();
        std::fs::create_dir_all(&profile_dir)
            .map_err(|e| format!("Could not access Douyin browser profile: {e}"))?;

        let init_script = r#"
(() => {
  window.__moriFrameAction = null;
  window.__moriFrameSavedCount = 0;
  const install = () => {
    if (!document.body || document.getElementById('__moriFrameBar')) return;
    const bar = document.createElement('div');
    bar.id = '__moriFrameBar';
    bar.innerHTML = `
      <div style="font-weight:800;white-space:nowrap">Mori 取帧</div>
      <button id="__moriFrameCapture" type="button">收藏当前帧</button>
      <span id="__moriFrameStatus">播放视频并拖到想要的画面</span>
      <button id="__moriFrameClose" type="button" aria-label="关闭">×</button>`;
    Object.assign(bar.style, {
      position:'fixed', top:'14px', left:'50%', transform:'translateX(-50%)',
      zIndex:'2147483647', display:'flex', alignItems:'center', gap:'10px',
      padding:'10px 12px', borderRadius:'14px', background:'rgba(20,20,20,.92)',
      color:'#fff', fontFamily:'system-ui,-apple-system,Segoe UI,sans-serif',
      fontSize:'13px', boxShadow:'0 10px 32px rgba(0,0,0,.35)', backdropFilter:'blur(12px)'
    });
    const capture = bar.querySelector('#__moriFrameCapture');
    const close = bar.querySelector('#__moriFrameClose');
    const status = bar.querySelector('#__moriFrameStatus');
    [capture, close].forEach((button) => Object.assign(button.style, {
      border:'0', borderRadius:'10px', padding:'8px 11px', cursor:'pointer', fontWeight:'700'
    }));
    capture.style.background = '#fff';
    capture.style.color = '#111';
    close.style.background = 'transparent';
    close.style.color = '#fff';
    close.style.fontSize = '18px';
    close.style.padding = '4px 7px';
    status.style.opacity = '.72';
    status.style.whiteSpace = 'nowrap';
    capture.addEventListener('click', () => {
      if (window.__moriFrameAction) return;
      window.__moriFrameAction = { type:'capture', at: Date.now() };
      capture.disabled = true;
      status.textContent = '正在收藏当前帧…';
    });
    close.addEventListener('click', () => {
      window.__moriFrameAction = { type:'close', at: Date.now() };
    });
    window.__moriFrameFeedback = (ok, message) => {
      capture.disabled = false;
      status.textContent = message || (ok ? '已收藏' : '截取失败');
      if (ok) window.__moriFrameSavedCount += 1;
    };
    document.body.appendChild(bar);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once:true });
  } else {
    install();
  }
  setInterval(install, 1200);
})();
"#;

        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "douyin-frame-picker",
            tauri::WebviewUrl::External(page_url),
        )
        .title("Mori · 抖音取帧")
        .inner_size(1180.0, 820.0)
        .min_inner_size(760.0, 560.0)
        .data_directory(profile_dir)
        .initialization_script(init_script)
        .build()
        .map_err(|e| format!("Could not open Douyin frame picker: {e}"))?;

        let worker_window = window.clone();
        let worker_app = app.clone();
        std::thread::spawn(move || {
            loop {
                if worker_app.get_webview_window("douyin-frame-picker").is_none() {
                    break;
                }

                let (tx, rx) = std::sync::mpsc::channel::<String>();
                let action_script = "(() => { const action = window.__moriFrameAction || null; window.__moriFrameAction = null; return action; })()";
                if worker_window
                    .eval_with_callback(action_script, move |value| {
                        let _ = tx.send(value);
                    })
                    .is_ok()
                {
                    if let Ok(raw) = rx.recv_timeout(std::time::Duration::from_millis(900)) {
                        let action = serde_json::from_str::<serde_json::Value>(&raw)
                            .ok()
                            .and_then(|value| {
                                if let Some(inner) = value.as_str() {
                                    serde_json::from_str::<serde_json::Value>(inner).ok()
                                } else {
                                    Some(value)
                                }
                            });
                        match action
                            .as_ref()
                            .and_then(|value| value.get("type"))
                            .and_then(|value| value.as_str())
                        {
                            Some("close") => {
                                let _ = worker_window.close();
                                break;
                            }
                            Some("capture") => {
                                let (capture_tx, capture_rx) = std::sync::mpsc::channel::<String>();
                                let capture_script = r#"
(() => {
  try {
    const videos = Array.from(document.querySelectorAll('video'))
      .filter((video) => video.videoWidth > 0 && video.videoHeight > 0 && video.readyState >= 2)
      .map((video) => {
        const rect = video.getBoundingClientRect();
        const visibleW = Math.max(0, Math.min(innerWidth, rect.right) - Math.max(0, rect.left));
        const visibleH = Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top));
        return { video, score: visibleW * visibleH };
      })
      .filter((entry) => entry.score > 1000)
      .sort((a, b) => b.score - a.score);
    const video = videos[0]?.video;
    if (!video) return { ok:false, error:'video_not_ready' };
    const maxSide = 1920;
    const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const ctx = canvas.getContext('2d', { alpha:false });
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/webp', .9);
    return {
      ok:true,
      dataUrl,
      currentTime:Number(video.currentTime || 0),
      duration:Number(video.duration || 0),
      width:canvas.width,
      height:canvas.height
    };
  } catch (error) {
    return { ok:false, error:String(error?.message || error || 'capture_failed') };
  }
})()
"#;
                                if worker_window
                                    .eval_with_callback(capture_script, move |value| {
                                        let _ = capture_tx.send(value);
                                    })
                                    .is_ok()
                                {
                                    if let Ok(raw_capture) = capture_rx.recv_timeout(std::time::Duration::from_secs(4)) {
                                        let captured = serde_json::from_str::<serde_json::Value>(&raw_capture)
                                            .ok()
                                            .and_then(|value| {
                                                if let Some(inner) = value.as_str() {
                                                    serde_json::from_str::<serde_json::Value>(inner).ok()
                                                } else {
                                                    Some(value)
                                                }
                                            })
                                            .unwrap_or_else(|| serde_json::json!({"ok":false,"error":"capture_decode_failed"}));
                                        if captured.get("ok").and_then(|value| value.as_bool()) == Some(true) {
                                            let data_url = captured
                                                .get("dataUrl")
                                                .and_then(|value| value.as_str())
                                                .unwrap_or("");
                                            let encoded = data_url.split_once(',').map(|(_, value)| value).unwrap_or("");
                                            if let Ok(bytes) = BASE64_STANDARD.decode(encoded.as_bytes()) {
                                                let download_dir = dirs::download_dir()
                                                    .unwrap_or_else(|| std::path::PathBuf::from("."));
                                                let target_dir = download_dir.join("Mori").join("Frames");
                                                if std::fs::create_dir_all(&target_dir).is_ok() {
                                                    let timestamp = std::time::SystemTime::now()
                                                        .duration_since(std::time::UNIX_EPOCH)
                                                        .unwrap_or_default()
                                                        .as_millis();
                                                    let frame_time = captured
                                                        .get("currentTime")
                                                        .and_then(|value| value.as_f64())
                                                        .unwrap_or(0.0);
                                                    let filename = format!(
                                                        "{}_{}_{}.webp",
                                                        safe_frame_stem(&frame_title),
                                                        timestamp,
                                                        (frame_time * 1000.0).round() as u64
                                                    );
                                                    let target_file = target_dir.join(filename);
                                                    if std::fs::write(&target_file, bytes).is_ok() {
                                                        let payload = serde_json::json!({
                                                            "sourceUrl": source_url,
                                                            "title": frame_title,
                                                            "path": target_file.to_string_lossy().to_string(),
                                                            "uri": target_file.to_string_lossy().to_string(),
                                                            "frameTime": frame_time,
                                                            "savedAt": timestamp,
                                                            "width": captured.get("width").cloned().unwrap_or(serde_json::Value::Null),
                                                            "height": captured.get("height").cloned().unwrap_or(serde_json::Value::Null)
                                                        });
                                                        let _ = worker_app.emit("mori-douyin-frame-saved", payload);
                                                        let _ = worker_window.eval("window.__moriFrameFeedback?.(true, '已收藏当前帧');");
                                                        std::thread::sleep(std::time::Duration::from_millis(220));
                                                        continue;
                                                    }
                                                }
                                            }
                                        }
                                        let error_text = captured
                                            .get("error")
                                            .and_then(|value| value.as_str())
                                            .unwrap_or("capture_failed")
                                            .replace('\\', "\\\\")
                                            .replace('\'', "\\'");
                                        let _ = worker_window.eval(format!(
                                            "window.__moriFrameFeedback?.(false, '截取失败：{}');",
                                            error_text
                                        ));
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(280));
            }
        });

        let _ = window.set_focus();
        Ok(serde_json::json!({ "status": true, "label": "douyin-frame-picker" }))
    }

    #[cfg(not(desktop))]
    {
        let _ = app;
        let _ = url;
        let _ = title;
        Err("Douyin web frame picker is currently available on desktop only.".to_string())
    }
}

#[tauri::command]
async fn tauri_douyin_page_detail(
    app: tauri::AppHandle,
    aweme_id: String,
) -> Result<serde_json::Value, String> {
    #[cfg(desktop)]
    {
        let aweme_id = aweme_id.trim().to_string();
        if aweme_id.len() < 15
            || aweme_id.len() > 22
            || !aweme_id.chars().all(|ch| ch.is_ascii_digit())
        {
            return Err("Invalid Douyin aweme id for page channel.".to_string());
        }

        if !douyin_login_marker().exists() {
            return Ok(serde_json::json!({
                "status": 0,
                "loggedIn": false,
                "loginRequired": true,
                "diagnostic": "page_channel_login_required"
            }));
        }

        let profile_dir = douyin_profile_dir();
        std::fs::create_dir_all(&profile_dir)
            .map_err(|e| format!("Could not access Douyin page-channel profile: {e}"))?;
        let page_url = tauri::Url::parse(&format!("https://www.douyin.com/video/{aweme_id}"))
            .map_err(|e| format!("Invalid Douyin page-channel URL: {e}"))?;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let label = format!("douyin-page-channel-{stamp}");

        // Keep this WebView clean: unlike the older browser fallback we intentionally
        // do not inject fetch/XHR wrappers before page scripts. Douyin's own security
        // SDK must be allowed to initialize and decorate the request itself.
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            label,
            tauri::WebviewUrl::External(page_url),
        )
        .visible(false)
        .skip_taskbar(true)
        .inner_size(2.0, 2.0)
        .data_directory(profile_dir)
        .build()
        .map_err(|e| format!("Douyin page-channel window failed: {e}"))?;

        // Give the real Douyin page enough time to install its current security SDK.
        std::thread::sleep(std::time::Duration::from_millis(3800));

        let id_json = serde_json::to_string(&aweme_id)
            .map_err(|e| format!("Could not encode Douyin aweme id: {e}"))?;
        let start_script = format!(
            r#"
(() => {{
  const awemeId = {id_json};
  if (!window.__moriDouyinPageDetail || window.__moriDouyinPageDetail.id !== awemeId) {{
    window.__moriDouyinPageDetail = {{ id: awemeId, done: false, startedAt: Date.now() }};
    (async () => {{
      try {{
        const api = new URL('/aweme/v1/web/aweme/detail/', location.origin);
        api.searchParams.set('device_platform', 'webapp');
        api.searchParams.set('aid', '6383');
        api.searchParams.set('channel', 'channel_pc_web');
        api.searchParams.set('aweme_id', awemeId);
        api.searchParams.set('request_source', '600');
        api.searchParams.set('origin_type', 'quick_player');
        const response = await window.fetch(api.toString(), {{
          method: 'GET',
          credentials: 'include',
          headers: {{
            'Accept': 'application/json, text/plain, */*'
          }}
        }});
        const text = await response.text();
        window.__moriDouyinPageDetail = {{
          id: awemeId,
          done: true,
          ok: response.ok,
          status: response.status,
          url: response.url || api.toString(),
          text
        }};
      }} catch (error) {{
        window.__moriDouyinPageDetail = {{
          id: awemeId,
          done: true,
          ok: false,
          status: 0,
          error: String(error?.message || error || 'page channel fetch failed')
        }};
      }}
    }})();
  }}
  return {{
    started: true,
    href: location.href,
    readyState: document.readyState,
    title: document.title || ''
  }};
}})()
"#
        );

        let (start_tx, start_rx) = std::sync::mpsc::channel::<String>();
        let _ = window.eval_with_callback(start_script, move |value| {
            let _ = start_tx.send(value);
        });
        let _ = start_rx.recv_timeout(std::time::Duration::from_secs(2));

        let mut latest = serde_json::json!({ "done": false });
        for _ in 0..20 {
            let (tx, rx) = std::sync::mpsc::channel::<String>();
            if window
                .eval_with_callback(
                    "(() => window.__moriDouyinPageDetail || ({ done: false }))()",
                    move |value| {
                        let _ = tx.send(value);
                    },
                )
                .is_ok()
            {
                if let Ok(raw) = rx.recv_timeout(std::time::Duration::from_secs(2)) {
                    let parsed = serde_json::from_str::<serde_json::Value>(&raw)
                        .unwrap_or_else(|_| serde_json::Value::String(raw));
                    latest = if let Some(inner) = parsed.as_str() {
                        serde_json::from_str::<serde_json::Value>(inner)
                            .unwrap_or_else(|_| parsed.clone())
                    } else {
                        parsed
                    };
                    if latest
                        .get("done")
                        .and_then(|value| value.as_bool())
                        .unwrap_or(false)
                    {
                        break;
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(550));
        }

        let logged_in = douyin_window_logged_in(&window);
        if logged_in {
            let _ = set_douyin_login_marker(true);
        }
        let _ = window.close();

        let done = latest
            .get("done")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        if !done {
            return Ok(serde_json::json!({
                "status": 0,
                "loggedIn": logged_in,
                "diagnostic": "page_channel_timeout"
            }));
        }

        let status = latest
            .get("status")
            .and_then(|value| value.as_u64())
            .unwrap_or(0) as u16;
        let body = latest
            .get("text")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let parsed_body = serde_json::from_str::<serde_json::Value>(body).ok();
        let diagnostic = if status == 200 && parsed_body.is_some() {
            "page_channel_success"
        } else if status == 403 {
            "page_channel_argus_403"
        } else if status == 200 && body.is_empty() {
            "page_channel_empty_200"
        } else {
            "page_channel_failed"
        };

        Ok(serde_json::json!({
            "status": status,
            "loggedIn": logged_in,
            "url": latest.get("url").and_then(|value| value.as_str()).unwrap_or(""),
            "data": parsed_body,
            "bodyLength": body.len(),
            "error": latest.get("error").and_then(|value| value.as_str()).unwrap_or(""),
            "diagnostic": diagnostic
        }))
    }

    #[cfg(not(desktop))]
    {
        let _ = app;
        let _ = aweme_id;
        Err("Douyin page channel is currently available on desktop only.".to_string())
    }
}

#[tauri::command]
async fn tauri_douyin_browser_request(
    app: tauri::AppHandle,
    url: String,
) -> Result<serde_json::Value, String> {
    #[cfg(desktop)]
    {
        let external_url = url
            .parse()
            .map_err(|e| format!("Invalid Douyin browser fallback URL: {e}"))?;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let label = format!("douyin-probe-{stamp}");
        let init_script = r#"
(() => {
  if (window.__moriDouyinProbeInstalled) return;
  window.__moriDouyinProbeInstalled = true;
  window.__moriDouyinCapture = null;
  window.__moriDouyinLastApiUrl = '';
  window.__moriDouyinMediaUrls = [];

  const rememberMediaUrl = (value) => {
    try {
      const raw = String(value?.url || value || '');
      if (!/^https?:\/\//i.test(raw)) return;
      const lower = raw.toLowerCase();
      const looksLikeMedia =
        /douyinvod|bytevcloud|douyin.*vod|\/video\/tos\/|\.mp4(?:\?|$)|mime_type=video/.test(lower);
      const looksLikeImage = /\.(?:jpg|jpeg|png|webp)(?:\?|$)|image\/|~tplv-/.test(lower);
      if (!looksLikeMedia || looksLikeImage) return;
      if (!window.__moriDouyinMediaUrls.includes(raw)) {
        window.__moriDouyinMediaUrls.push(raw);
        if (window.__moriDouyinMediaUrls.length > 40) window.__moriDouyinMediaUrls.shift();
      }
    } catch (_) {}
  };

  const collectPerformanceMedia = () => {
    try {
      performance.getEntriesByType('resource').forEach((entry) => {
        if (entry?.initiatorType === 'video' || entry?.initiatorType === 'audio' ||
            /douyinvod|bytevcloud|\.mp4(?:\?|$)/i.test(entry?.name || '')) {
          rememberMediaUrl(entry.name);
        }
      });
    } catch (_) {}
  };
  setInterval(collectPerformanceMedia, 750);

  const isTarget = (value) => {
    const text = String(value || '');
    return text.includes('/web/api/v2/aweme/iteminfo/') ||
      text.includes('/aweme/v1/web/aweme/detail/') ||
      text.includes('/aweme/v1/aweme/detail/');
  };
  const remember = (text, requestUrl) => {
    try {
      const parsed = typeof text === 'string' ? JSON.parse(text) : text;
      if (!parsed || typeof parsed !== 'object') return;
      if (parsed.item_list || parsed.aweme_detail || parsed.aweme_list || parsed.data) {
        window.__moriDouyinCapture = parsed;
        window.__moriDouyinLastApiUrl = String(requestUrl || '');
      }
    } catch (_) {}
  };

  try {
    const nativeFetch = window.fetch;
    if (nativeFetch) {
      window.fetch = async function(...args) {
        const response = await nativeFetch.apply(this, args);
        const requestUrl = args?.[0]?.url || args?.[0] || '';
        rememberMediaUrl(requestUrl);
        if (isTarget(requestUrl)) {
          response.clone().text().then((text) => remember(text, requestUrl)).catch(() => {});
        }
        return response;
      };
    }
  } catch (_) {}

  try {
    const nativeOpen = XMLHttpRequest.prototype.open;
    const nativeSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, requestUrl, ...rest) {
      this.__moriRequestUrl = requestUrl;
      rememberMediaUrl(requestUrl);
      return nativeOpen.call(this, method, requestUrl, ...rest);
    };
    XMLHttpRequest.prototype.send = function(...args) {
      if (isTarget(this.__moriRequestUrl)) {
        this.addEventListener('load', () => {
          remember(this.responseText, this.__moriRequestUrl);
        }, { once: true });
      }
      return nativeSend.apply(this, args);
    };
  } catch (_) {}
})();
"#;

        let profile_dir = douyin_profile_dir();
        std::fs::create_dir_all(&profile_dir)
            .map_err(|e| format!("Could not access Douyin browser profile: {e}"))?;
        let native_media_urls = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let native_media_urls_for_handler = native_media_urls.clone();
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            label,
            tauri::WebviewUrl::External(external_url),
        )
        .visible(false)
        .skip_taskbar(true)
        // Keep a normal desktop viewport even while hidden. Douyin photo posts lazily
        // mount carousel images based on viewport size; a 2x2 probe misses them.
        .inner_size(1200.0, 820.0)
        .data_directory(profile_dir)
        .initialization_script(init_script)
        .on_web_resource_request(move |request, response| {
            let raw = request.uri().to_string();
            if !raw.starts_with("http://") && !raw.starts_with("https://") {
                return;
            }
            let lower = raw.to_ascii_lowercase();
            let content_type = response
                .headers()
                .get("content-type")
                .and_then(|value| value.to_str().ok())
                .unwrap_or("")
                .to_ascii_lowercase();
            let has_range = request.headers().contains_key("range");
            let looks_like_media = has_range
                || content_type.starts_with("video/")
                || content_type.starts_with("audio/")
                || content_type.contains("mp4")
                || content_type.contains("octet-stream")
                || lower.contains("douyinvod")
                || lower.contains("bytevcloud")
                || lower.contains("bytecdn")
                || lower.contains("/video/tos/")
                || lower.contains("mime_type=video")
                || lower.contains("mime_type=audio")
                || lower.contains("media_type=video")
                || lower.contains("media_type=audio")
                || lower.contains(".mp4")
                || lower.contains(".m4a")
                || lower.contains(".m4s");
            let looks_like_image = content_type.starts_with("image/")
                || lower.contains(".jpg")
                || lower.contains(".jpeg")
                || lower.contains(".png")
                || lower.contains(".webp")
                || lower.contains("~tplv-");
            if !looks_like_media || looks_like_image {
                return;
            }
            if let Ok(mut urls) = native_media_urls_for_handler.lock() {
                if !urls.iter().any(|existing| existing == &raw) {
                    urls.push(raw);
                    if urls.len() > 80 {
                        urls.remove(0);
                    }
                }
            }
        })
        .build()
        .map_err(|e| format!("Douyin browser fallback window failed: {e}"))?;

        std::thread::sleep(std::time::Duration::from_millis(1400));
        let mut latest = serde_json::json!({ "kind": "pending" });
        let mut saw_api_capture = false;
        for _ in 0..18 {
            let (tx, rx) = std::sync::mpsc::channel::<String>();
            let script = r#"
(() => {
  const video = document.querySelector('video');
  try {
    if (video) {
      video.muted = true;
      video.playsInline = true;
      if (video.paused) video.play().catch(() => {});
    }
  } catch (_) {}
  try {
    performance.getEntriesByType('resource').forEach((entry) => {
      const raw = String(entry?.name || '');
      const lower = raw.toLowerCase();
      if (/^https?:\/\//i.test(raw) &&
          (/douyinvod|bytevcloud|douyin.*vod|\/video\/tos\/|\.mp4(?:\?|$)|mime_type=video/.test(lower)) &&
          !/\.(?:jpg|jpeg|png|webp)(?:\?|$)|image\/|~tplv-/.test(lower) &&
          !window.__moriDouyinMediaUrls.includes(raw)) {
        window.__moriDouyinMediaUrls.push(raw);
      }
    });
  } catch (_) {}
  const mediaUrls = (window.__moriDouyinMediaUrls || []).slice(-40);
  const imageUrls = [];
  const rememberImage = (raw, width = 0, height = 0) => {
    const value = String(raw || '');
    if (!/^https?:\/\//i.test(value)) return;
    const lower = value.toLowerCase();
    if (/avatar|emoji|logo|qrcode|favicon|user-head|aweme-avatar/.test(lower)) return;
    if (width && height && (width < 220 || height < 220)) return;
    if (!/douyinpic|byteimg|imagex|tplv|\.jpe?g(?:\?|$)|\.png(?:\?|$)|\.webp(?:\?|$)/i.test(value)) return;
    if (!imageUrls.includes(value)) imageUrls.push(value);
  };
  try {
    Array.from(document.images || []).forEach((img) => {
      rememberImage(
        img.currentSrc || img.src,
        Number(img.naturalWidth || img.width || 0),
        Number(img.naturalHeight || img.height || 0)
      );
    });
    rememberImage(document.querySelector('meta[property="og:image"]')?.content || '');
  } catch (_) {}
  const imagePost = /\/(?:note|slides)\//i.test(location.pathname || '') ||
    !!document.querySelector('[class*="note" i] [class*="slide" i], [class*="image" i][class*="swiper" i]');
  try {
    const directSources = [
      video?.currentSrc,
      video?.src,
      ...Array.from(video?.querySelectorAll?.('source') || []).map((source) => source.src),
    ];
    directSources.forEach((raw) => {
      const value = String(raw || '');
      if (/^https?:\/\//i.test(value) && !mediaUrls.includes(value)) mediaUrls.push(value);
    });
  } catch (_) {}
  const capture = window.__moriDouyinCapture;
  if (capture) {
    return {
      kind: 'api',
      data: capture,
      apiUrl: window.__moriDouyinLastApiUrl || '',
      mediaUrls,
      imageUrls,
      imagePost,
      href: location.href,
      title: document.title || ''
    };
  }
  const videoUrl = video?.currentSrc || video?.src || '';
  if (videoUrl && !videoUrl.startsWith('blob:')) {
    return {
      kind: 'dom',
      videoUrl,
      mediaUrls,
      imageUrls,
      imagePost,
      poster: video?.poster || document.querySelector('meta[property="og:image"]')?.content || '',
      title: document.querySelector('meta[property="og:title"]')?.content || document.title || '',
      href: location.href
    };
  }
  return {
    kind: 'pending',
    mediaUrls,
    imageUrls,
    imagePost,
    href: location.href,
    title: document.title || '',
    body: (document.body?.innerText || '').slice(0, 180)
  };
})()
"#;
            if window
                .eval_with_callback(script, move |value| {
                    let _ = tx.send(value);
                })
                .is_ok()
            {
                if let Ok(raw) = rx.recv_timeout(std::time::Duration::from_secs(2)) {
                    let parsed = serde_json::from_str::<serde_json::Value>(&raw)
                        .unwrap_or_else(|_| serde_json::Value::String(raw));
                    latest = if let Some(inner) = parsed.as_str() {
                        serde_json::from_str::<serde_json::Value>(inner)
                            .unwrap_or_else(|_| parsed.clone())
                    } else {
                        parsed
                    };
                    let kind = latest
                        .get("kind")
                        .and_then(|value| value.as_str())
                        .unwrap_or("pending");
                    let media_count = latest
                        .get("mediaUrls")
                        .and_then(|value| value.as_array())
                        .map(|values| values.len())
                        .unwrap_or(0);
                    let image_count = latest
                        .get("imageUrls")
                        .and_then(|value| value.as_array())
                        .map(|values| values.len())
                        .unwrap_or(0);
                    let native_media_count = native_media_urls
                        .lock()
                        .map(|urls| urls.len())
                        .unwrap_or(0);
                    if kind == "api" {
                        saw_api_capture = true;
                        // Photo posts can finish as soon as the API/DOM exposes their
                        // image collection. Video posts still stay alive until media CDN
                        // requests appear so the legacy fallback has something usable.
                        if image_count > 0 || media_count + native_media_count > 0 {
                            break;
                        }
                    } else if image_count > 0
                        && latest
                            .get("imagePost")
                            .and_then(|value| value.as_bool())
                            .unwrap_or(false)
                    {
                        break;
                    } else if kind == "dom" && media_count + native_media_count > 0 {
                        break;
                    } else if kind == "dom" && !saw_api_capture {
                        // A direct non-blob currentSrc is useful even if no API payload
                        // was captured, but give ResourceTiming one extra polling cycle
                        // to collect sibling renditions first.
                        saw_api_capture = true;
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(900));
        }
        let logged_in = douyin_window_logged_in(&window);
        if logged_in {
            let _ = set_douyin_login_marker(true);
        }
        let native_urls = native_media_urls
            .lock()
            .map(|urls| urls.clone())
            .unwrap_or_default();
        if let Some(object) = latest.as_object_mut() {
            let mut merged_media_urls = object
                .get("mediaUrls")
                .and_then(|value| value.as_array())
                .cloned()
                .unwrap_or_default();
            for url in native_urls {
                if !merged_media_urls
                    .iter()
                    .any(|value| value.as_str() == Some(url.as_str()))
                {
                    merged_media_urls.push(serde_json::Value::String(url));
                }
            }
            object.insert(
                "mediaUrls".to_string(),
                serde_json::Value::Array(merged_media_urls),
            );
            object.insert(
                "loggedIn".to_string(),
                serde_json::Value::Bool(logged_in),
            );
        }
        let _ = window.close();
        Ok(latest)
    }

    #[cfg(not(desktop))]
    {
        let _ = app;
        let _ = url;
        Err("Douyin browser fallback is only available on desktop.".to_string())
    }
}

#[tauri::command]
async fn tauri_douyin_ssr_request(url: String) -> Result<serde_json::Value, String> {
    const MOBILE_UA: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1";
    let client = reqwest::Client::builder()
        .http1_only()
        .redirect(reqwest::redirect::Policy::limited(10))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let first = client
        .get(&url)
        .header(reqwest::header::USER_AGENT, MOBILE_UA)
        .header(reqwest::header::ACCEPT, "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
        .header(reqwest::header::REFERER, "https://www.iesdouyin.com/")
        .send()
        .await
        .map_err(|e| format!("Douyin SSR request failed: {e}"))?;
    let mut status = first.status().as_u16();
    let mut final_url = first.url().to_string();
    let mut body = first.text().await.unwrap_or_default();
    let mut waf_solved = false;
    let mut waf_nonce: Option<u32> = None;

    if body.contains("_wafchallengeid") && body.contains("WAFJS") {
        let (cookie_value, nonce) = solve_douyin_waf_cookie(&body)?;
        let second = client
            .get(&final_url)
            .header(reqwest::header::USER_AGENT, MOBILE_UA)
            .header(reqwest::header::ACCEPT, "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
            .header(reqwest::header::REFERER, "https://www.iesdouyin.com/")
            .header(reqwest::header::COOKIE, format!("_wafchallengeid={cookie_value}"))
            .send()
            .await
            .map_err(|e| format!("Douyin SSR post-challenge request failed: {e}"))?;
        status = second.status().as_u16();
        final_url = second.url().to_string();
        body = second.text().await.unwrap_or_default();
        waf_solved = true;
        waf_nonce = Some(nonce);
    }

    Ok(serde_json::json!({
        "status": status,
        "data": body,
        "url": final_url,
        "wafSolved": waf_solved,
        "wafNonce": waf_nonce
    }))
}

fn mp4_has_video_track(path: &std::path::Path) -> bool {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(_) => return false,
    };

    // ISO BMFF/MP4 track handlers use an `hdlr` box whose handler_type is
    // four bytes later after version/flags + pre_defined. A real video track
    // therefore contains: hdlr .... .... vide. This is deliberately stricter
    // than merely searching for the word "video" in metadata.
    bytes.windows(4).enumerate().any(|(index, window)| {
        window == b"hdlr"
            && index + 16 <= bytes.len()
            && &bytes[index + 12..index + 16] == b"vide"
    })
}

#[tauri::command]
async fn tauri_download_file(
    url: String,
    fallback_urls: Option<Vec<String>>,
    expect_video: Option<bool>,
    filename: String,
    folder: Option<String>,
    headers: Option<HashMap<String, String>>,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .http1_only()
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
        .redirect(reqwest::redirect::Policy::limited(10))
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    let download_dir = dirs::download_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    let mut target_dir = download_dir.join("Mori");

    if let Some(f) = folder {
        let trimmed = f.trim();
        if !trimmed.is_empty() {
            if trimmed.starts_with("Mori/") || trimmed.starts_with("Mori\\") {
                target_dir = download_dir.join(trimmed);
            } else if trimmed != "Mori" {
                target_dir = target_dir.join(trimmed);
            }
        }
    }

    std::fs::create_dir_all(&target_dir).map_err(|e| format!("Directory error: {}", e))?;
    let (stem, ext) = {
        let p = std::path::Path::new(&filename);
        let s = p.file_stem().and_then(|s| s.to_str()).unwrap_or("Mori_Media");
        let e = p.extension().and_then(|s| s.to_str()).unwrap_or("mp4").to_lowercase();
        (s.to_string(), e)
    };
    let mut reserved_target = download_target::DownloadTarget::reserve(&target_dir, &stem, &ext)
        .map_err(|e| format!("Could not reserve download path: {e}"))?;

    let mut candidate_urls = Vec::new();
    candidate_urls.push(url.clone());
    if let Some(fallbacks) = fallback_urls {
        for candidate in fallbacks {
            let trimmed = candidate.trim();
            if !trimmed.is_empty() && !candidate_urls.iter().any(|existing| existing == trimmed) {
                candidate_urls.push(trimmed.to_string());
            }
        }
    }

    let require_video_track = expect_video.unwrap_or(false);
    let candidate_count = candidate_urls.len();
    let mut invalid_video_candidates = 0usize;
    let mut selected_url = None;

    for candidate_url in candidate_urls {
        reserved_target
            .reset()
            .map_err(|e| format!("Could not prepare download path: {e}"))?;
        let mut req = client.get(&candidate_url);
        if let Some(hdrs) = &headers {
            for (k, v) in hdrs {
                req = req.header(k, v);
            }
        }

        let mut download_succeeded = false;
        if let Ok(response) = req.send().await {
            if response.status().is_success() {
                if let Ok(bytes) = response.bytes().await {
                    if !bytes.is_empty() && reserved_target.write_bytes(&bytes).is_ok() {
                        download_succeeded = true;
                    }
                }
            }
        }

        // Fallback to curl if reqwest download was blocked (e.g. CDN/WAF behavior).
        if !download_succeeded {
            let mut cmd = std::process::Command::new("curl");
            cmd.args([
                "--http1.1",
                "-L",
                "-s",
                "-o",
                reserved_target.path().to_str().unwrap_or(""),
                &candidate_url,
            ]);
            if let Some(hdrs) = &headers {
                for (k, v) in hdrs {
                    cmd.arg("-H").arg(format!("{}: {}", k, v));
                }
            }
            if let Ok(out) = cmd.output() {
                if out.status.success() && reserved_target.has_bytes() {
                    download_succeeded = true;
                }
            }
        }

        if !download_succeeded {
            continue;
        }

        if require_video_track && !mp4_has_video_track(reserved_target.path()) {
            invalid_video_candidates += 1;
            continue;
        }

        selected_url = Some(candidate_url);
        break;
    }

    let selected_url = match selected_url {
        Some(url) => url,
        None if invalid_video_candidates > 0 => {
            return Err(format!(
                "Douyin tried {candidate_count} media candidates; {invalid_video_candidates} downloaded successfully but contained no video track."
            ));
        }
        None => {
            return Err("Download failed via native and fallback engines.".to_string());
        }
    };
    let target_file = reserved_target.commit();

    Ok(serde_json::json!({
        "status": true,
        "path": target_file.to_string_lossy(),
        "uri": format!("file://{}", target_file.to_string_lossy()),
        "selectedUrl": selected_url
    }))
}


#[tauri::command]
async fn tauri_read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    let mut clean_path = path.as_str();
    if clean_path.starts_with("file:///") {
        clean_path = &clean_path[7..]; // keep leading slash e.g. /Users/...
    } else if clean_path.starts_with("file://") {
        clean_path = &clean_path[7..];
    }

    // Try direct read first
    if let Ok(bytes) = std::fs::read(clean_path) {
        return Ok(bytes);
    }
    if let Ok(bytes) = std::fs::read(clean_path.trim_start_matches('/')) {
        return Ok(bytes);
    }

    // Strip Android prefix if present
    let stripped = clean_path
        .replace("storage/emulated/0/", "")
        .replace("/storage/emulated/0/", "");
    
    if let Ok(bytes) = std::fs::read(&stripped) {
        return Ok(bytes);
    }

    // Fallback: resolve relative to user's Downloads directory
    let download_dir = dirs::download_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    let rel_path = stripped.trim_start_matches('/');
    
    let target = if rel_path.starts_with("Downloads/") || rel_path.starts_with("downloads/") {
        let parent = download_dir.parent().unwrap_or(&download_dir);
        parent.join(rel_path)
    } else if rel_path.starts_with("Mori/") {
        download_dir.join(rel_path)
    } else {
        download_dir.join("Mori").join(rel_path)
    };

    if let Ok(bytes) = std::fs::read(&target) {
        return Ok(bytes);
    }

    std::fs::read(&target).map_err(|e| {
        format!(
            "Read file error (path: '{}', resolved target: '{}'): {}",
            clean_path,
            target.display(),
            e
        )
    })
}

#[tauri::command]
async fn tauri_fetch_bytes(
    url: String,
    headers: Option<HashMap<String, String>>,
) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .http1_only()
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
        .redirect(reqwest::redirect::Policy::limited(10))
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;

    let mut req = client.get(&url);

    if let Some(hdrs) = headers {
        for (k, v) in hdrs {
            req = req.header(k, v);
        }
    }

    let res = req.send().await.map_err(|e| format!("HTTP request failed: {}", e))?;
    if !res.status().is_success() {
        return Err(format!("HTTP error status: {}", res.status()));
    }

    let bytes = res.bytes().await.map_err(|e| format!("Body read failed: {}", e))?;
    Ok(bytes.to_vec())
}

#[tauri::command]
async fn tauri_save_bytes_file(
    bytes: Vec<u8>,
    filename: String,
    folder: Option<String>,
) -> Result<String, String> {
    let download_dir = dirs::download_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    let mut target_dir = download_dir.join("Mori");

    if let Some(f) = folder {
        let trimmed = f.trim();
        if !trimmed.is_empty() {
            if trimmed.starts_with("Mori/") || trimmed.starts_with("Mori\\") {
                target_dir = download_dir.join(trimmed);
            } else if trimmed != "Mori" {
                target_dir = target_dir.join(trimmed);
            }
        }
    }

    std::fs::create_dir_all(&target_dir).map_err(|e| format!("Directory error: {}", e))?;
    let (stem, ext) = {
        let p = std::path::Path::new(&filename);
        let s = p.file_stem().and_then(|s| s.to_str()).unwrap_or("Mori_Document");
        let e = p.extension().and_then(|s| s.to_str()).unwrap_or("pdf").to_lowercase();
        (s.to_string(), e)
    };
    let normalized_filename = format!("{}.{}", stem, ext);
    let mut target_file = target_dir.join(&normalized_filename);

    if target_file.exists() {
        let mut counter = 1;
        loop {
            let candidate = target_dir.join(format!("{}_{}.{}", stem, counter, ext));
            if !candidate.exists() {
                target_file = candidate;
                break;
            }
            counter += 1;
        }
    }

    std::fs::write(&target_file, bytes).map_err(|e| format!("Write error: {}", e))?;
    Ok(target_file.to_string_lossy().to_string())
}

#[tauri::command]
async fn tauri_clipboard_image_sequence() -> Result<u32, String> {
    #[cfg(target_os = "windows")]
    { return Ok(clipboard_image::sequence()); }
    #[cfg(not(target_os = "windows"))]
    { Err("System frame snipping is available on Windows only.".into()) }
}

#[tauri::command]
async fn tauri_save_clipboard_frame(previous_sequence: Option<u32>) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || save_clipboard_frame(previous_sequence))
        .await.map_err(|e| format!("clipboard_worker: {e}"))?
}

fn save_clipboard_frame(previous_sequence: Option<u32>) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "windows")]
    {
        let bytes = match clipboard_image::read(previous_sequence)? {
            clipboard_image::Snapshot::Busy => return Ok(serde_json::json!({ "saved": false, "reason": "clipboard_busy" })),
            clipboard_image::Snapshot::Unchanged => return Ok(serde_json::json!({ "saved": false, "reason": "unchanged" })),
            clipboard_image::Snapshot::NoImage => return Ok(serde_json::json!({ "saved": false, "reason": "no_image" })),
            clipboard_image::Snapshot::Image(bytes) => bytes,
        };
        let hash = Sha256::digest(&bytes).iter().map(|byte| format!("{byte:02x}")).collect::<String>();
        let ext = "png";
        let content_type = "image/png";
        let download_dir = dirs::download_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
        let target_dir = download_dir.join("Mori").join("Frames");
        std::fs::create_dir_all(&target_dir).map_err(|e| format!("Directory error: {e}"))?;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let mut target = download_target::DownloadTarget::reserve(&target_dir, &format!("Mori_Snip_{stamp}"), ext)
            .map_err(|e| format!("Reserve error: {e}"))?;
        target.write_bytes(&bytes).map_err(|e| format!("Write error: {e}"))?;
        let target_file = target.commit();
        return Ok(serde_json::json!({
            "saved": true,
            "path": target_file.to_string_lossy().to_string(),
            "uri": target_file.to_string_lossy().to_string(),
            "hash": hash,
            "contentType": content_type
        }));
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = previous_sequence;
        Ok(serde_json::json!({ "saved": false, "reason": "unsupported" }))
    }
}

#[tauri::command]
async fn tauri_start_screen_snip() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use windows::core::{w, PCWSTR};
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        // Mori is an unpackaged desktop app: the MSIX redirect protocol is unavailable.
        // Keep the interactive clipboard route, explicitly requesting rectangle selection.
        let result = unsafe {
            ShellExecuteW(None, w!("open"), w!("ms-screenclip:?clippingMode=Rectangle"),
                PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL)
        };
        let code = result.0 as isize;
        if code <= 32 { return Err(format!("snip_launch: Windows error {code}")); }
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("System frame snipping is currently available on Windows only.".to_string())
    }
}

#[cfg(target_os = "windows")]
fn read_windows_clipboard_history() -> Result<serde_json::Value, String> {
    use windows::ApplicationModel::DataTransfer::{
        Clipboard,
        ClipboardHistoryItemsResultStatus,
    };

    let enabled = Clipboard::IsHistoryEnabled().map_err(|e| e.to_string())?;
    if !enabled {
        return Ok(serde_json::json!({
            "enabled": false,
            "status": "disabled",
            "items": []
        }));
    }

    let result = Clipboard::GetHistoryItemsAsync()
        .map_err(|e| e.to_string())?
        .get()
        .map_err(|e| e.to_string())?;
    let status = result.Status().map_err(|e| e.to_string())?;

    if status != ClipboardHistoryItemsResultStatus::Success {
        let status_text = if status == ClipboardHistoryItemsResultStatus::AccessDenied {
            "access-denied"
        } else if status == ClipboardHistoryItemsResultStatus::ClipboardHistoryDisabled {
            "disabled"
        } else {
            "unavailable"
        };
        return Ok(serde_json::json!({
            "enabled": enabled,
            "status": status_text,
            "items": []
        }));
    }

    let items = result.Items().map_err(|e| e.to_string())?;
    let size = items.Size().map_err(|e| e.to_string())?;
    let mut output = Vec::new();

    for index in 0..size.min(100) {
        let item = match items.GetAt(index) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let content = match item.Content() {
            Ok(value) => value,
            Err(_) => continue,
        };
        let text = match content.GetTextAsync() {
            Ok(operation) => match operation.get() {
                Ok(value) => value.to_string(),
                Err(_) => continue,
            },
            Err(_) => continue,
        };
        let trimmed = text.trim();
        if trimmed.is_empty() {
            continue;
        }

        output.push(serde_json::json!({
            "id": item.Id().map(|v| v.to_string()).unwrap_or_default(),
            "text": trimmed
        }));
    }

    Ok(serde_json::json!({
        "enabled": true,
        "status": "success",
        "items": output
    }))
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn tauri_get_clipboard_history(
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let _ = sender.send(read_windows_clipboard_history());
    })
    .map_err(|e| e.to_string())?;

    receiver
        .recv_timeout(std::time::Duration::from_secs(8))
        .map_err(|_| "Clipboard history request timed out".to_string())?
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
async fn tauri_get_clipboard_history() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "enabled": false,
        "status": "unsupported",
        "items": []
    }))
}

#[tauri::command]
async fn tauri_open_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
#[derive(Default)]
struct FrameFloaterState {
    expanded: bool,
    compact_position: Option<tauri::PhysicalPosition<i32>>,
}

#[cfg(target_os = "windows")]
fn size_frame_floater(window: &tauri::WebviewWindow) -> Result<(), String> {
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE,
        DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongW, SetWindowLongW, SetWindowPos, GWL_EXSTYLE, GWL_STYLE, SWP_FRAMECHANGED,
        SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOZORDER, WS_CAPTION, WS_MAXIMIZEBOX,
        WS_MINIMIZEBOX, WS_POPUP, WS_SYSMENU, WS_THICKFRAME, WS_EX_CLIENTEDGE,
        WS_EX_DLGMODALFRAME, WS_EX_STATICEDGE, WS_EX_WINDOWEDGE,
    };

    window.set_shadow(false).map_err(|e| e.to_string())?;
    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let expanded = window.app_handle().state::<std::sync::Mutex<FrameFloaterState>>()
        .lock().map_err(|e| e.to_string())?.expanded;
    let (width, height): (f64, f64) = if expanded { (340.0, 560.0) } else { (58.0, 26.0) };
    let (width, height) = if let Ok(Some(monitor)) = window.current_monitor() {
        let area = monitor.work_area();
        (width.min(area.size.width as f64 / scale), height.min(area.size.height as f64 / scale))
    } else { (width, height) };
    unsafe {
        // Tao keeps the hidden caption styles even for undecorated windows.
        // A real popup avoids Windows enforcing a caption-sized minimum.
        let caption = WS_CAPTION | WS_SYSMENU | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX;
        let style = (GetWindowLongW(hwnd, GWL_STYLE) as u32 & !caption.0) | WS_POPUP.0;
        SetWindowLongW(hwnd, GWL_STYLE, style as i32);
        let edges = WS_EX_CLIENTEDGE | WS_EX_DLGMODALFRAME | WS_EX_STATICEDGE | WS_EX_WINDOWEDGE;
        let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 & !edges.0;
        SetWindowLongW(hwnd, GWL_EXSTYLE, ex_style as i32);
        // The capsule owns its rounded shape. Suppress Windows 11's separate
        // outline/corner layer; older Windows versions can ignore these options.
        let _ = DwmSetWindowAttribute(
            hwnd, DWMWA_BORDER_COLOR,
            &DWMWA_COLOR_NONE as *const _ as *const std::ffi::c_void,
            std::mem::size_of_val(&DWMWA_COLOR_NONE) as u32,
        );
        let _ = DwmSetWindowAttribute(
            hwnd, DWMWA_WINDOW_CORNER_PREFERENCE,
            &DWMWCP_DONOTROUND as *const _ as *const std::ffi::c_void,
            std::mem::size_of_val(&DWMWCP_DONOTROUND) as u32,
        );
        SetWindowPos(
            hwnd,
            None,
            0,
            0,
            (width * scale).round() as i32,
            (height * scale).round() as i32,
            SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOZORDER,
        ).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn create_frame_floater(app: &tauri::AppHandle) -> Result<(), String> {
    if app.get_webview_window("frame-floater").is_some() {
        return Ok(());
    }
    let window = tauri::WebviewWindowBuilder::new(
        app,
        "frame-floater",
        tauri::WebviewUrl::App("frame-floater.html".into()),
    )
    .title("Mori · 收藏帧")
    .inner_size(58.0, 26.0)
    .min_inner_size(58.0, 26.0)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .build()
    .map_err(|e| format!("Could not create frame floater: {e}"))?;

    window.show().map_err(|e| e.to_string())?;
    size_frame_floater(&window)?;

    if let Ok(Some(monitor)) = app.primary_monitor() {
        let size = monitor.size();
        let pos = monitor.position();
        if let Ok(window_size) = window.outer_size() {
            let margin = (12.0 * monitor.scale_factor()).round() as i32;
            let x = pos.x + size.width as i32 - window_size.width as i32 - margin;
            let y = pos.y + (size.height as i32 - window_size.height as i32) / 2;
            let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn register_frame_capture_hotkey(app: tauri::AppHandle) {
    std::thread::spawn(move || unsafe {
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            RegisterHotKey, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, VK_F,
        };
        use windows::Win32::UI::WindowsAndMessaging::{GetMessageW, MSG, WM_HOTKEY};

        const HOTKEY_ID: i32 = 0x4D46;
        if let Err(error) = RegisterHotKey(
            None,
            HOTKEY_ID,
            MOD_CONTROL | MOD_SHIFT | MOD_NOREPEAT,
            VK_F.0 as u32,
        ) {
            log::warn!("Could not register Mori frame hotkey Ctrl+Shift+F: {error}");
            return;
        }

        let mut message = MSG::default();
        loop {
            let result = GetMessageW(&mut message, None, 0, 0);
            if result.0 <= 0 {
                break;
            }
            if message.message == WM_HOTKEY && message.wParam.0 as i32 == HOTKEY_ID {
                let _ = app.emit(
                    "mori-global-frame-request",
                    serde_json::json!({ "source": "hotkey" }),
                );
            }
        }
    });
}

#[tauri::command]
async fn tauri_move_frame_floater(
    window: tauri::WebviewWindow,
    position: Option<tauri::PhysicalPosition<i32>>,
) -> Result<serde_json::Value, String> {
    if window.label() != "frame-floater" {
        return Err("Only the frame floater can move itself".into());
    }
    if let Some(position) = position {
        #[cfg(target_os = "windows")]
        {
            let previous = window.outer_position().map_err(|e| e.to_string())?;
            let state = window.app_handle().state::<std::sync::Mutex<FrameFloaterState>>();
            let mut state = state.lock().map_err(|e| e.to_string())?;
            if state.expanded {
                if let Some(anchor) = state.compact_position.as_mut() {
                    anchor.x += position.x - previous.x;
                    anchor.y += position.y - previous.y;
                }
            }
        }
        window.set_position(position).map_err(|e| e.to_string())?;
    }
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let scale_factor = window.scale_factor().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "x": position.x,
        "y": position.y,
        "scaleFactor": scale_factor
    }))
}

#[tauri::command]
async fn tauri_expand_frame_floater(window: tauri::WebviewWindow, expanded: bool) -> Result<(), String> {
    if window.label() != "frame-floater" { return Err("Only the frame floater can resize itself".into()); }
    #[cfg(target_os = "windows")]
    {
        let position = window.outer_position().map_err(|e| e.to_string())?;
        let old_size = window.outer_size().map_err(|e| e.to_string())?;
        let state = window.app_handle().state::<std::sync::Mutex<FrameFloaterState>>();
        let anchor = {
            let mut state = state.lock().map_err(|e| e.to_string())?;
            if state.expanded == expanded { return Ok(()); }
            if expanded { state.compact_position = Some(position); }
            state.expanded = expanded;
            state.compact_position.unwrap_or(position)
        };
        if let Err(error) = size_frame_floater(&window) {
            state.lock().map_err(|e| e.to_string())?.expanded = !expanded;
            let _ = size_frame_floater(&window);
            return Err(error);
        }
        let size = window.outer_size().map_err(|e| e.to_string())?;
        let mut next = if expanded {
            tauri::PhysicalPosition::new(position.x + old_size.width as i32 - size.width as i32, position.y)
        } else { anchor };
        if let Ok(Some(monitor)) = window.current_monitor() {
            let area = monitor.work_area();
            next.x = next.x.clamp(area.position.x, area.position.x + area.size.width.saturating_sub(size.width) as i32);
            next.y = next.y.clamp(area.position.y, area.position.y + area.size.height.saturating_sub(size.height) as i32);
        }
        window.set_position(next).map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    { let _ = expanded; Err("Favorites panel is available on Windows".into()) }
}

#[tauri::command]
async fn tauri_favorites_request(window: tauri::WebviewWindow, app: tauri::AppHandle, request: serde_json::Value) -> Result<(), String> {
    if window.label() != "frame-floater" { return Err("Only the favorites panel can send requests".into()); }
    if request.to_string().len() > 32 * 1024 { return Err("Favorites request is too large".into()); }
    if app.get_webview_window("main").is_none() { return Err("请先打开Mori主窗口".into()); }
    app.emit_to("main", "mori-favorites-request", request).map_err(|e| e.to_string())
}

#[tauri::command]
async fn tauri_favorites_response(window: tauri::WebviewWindow, app: tauri::AppHandle, response: serde_json::Value) -> Result<(), String> {
    if window.label() != "main" { return Err("Only the main window owns favorites".into()); }
    app.emit_to("frame-floater", "mori-favorites-response", response).map_err(|e| e.to_string())
}

#[tauri::command]
async fn tauri_favorites_changed(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    if window.label() != "main" { return Err("Only the main window owns favorites".into()); }
    app.emit_to("frame-floater", "mori-favorites-changed", ()).map_err(|e| e.to_string())
}

#[tauri::command]
async fn tauri_request_global_frame_capture(app: tauri::AppHandle) -> Result<(), String> {
    app.emit(
        "mori-global-frame-request",
        serde_json::json!({ "source": "floater" }),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn tauri_set_frame_floater_visible(
    app: tauri::AppHandle,
    visible: bool,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        if app.get_webview_window("frame-floater").is_none() && visible {
            create_frame_floater(&app)?;
        }
        if let Some(window) = app.get_webview_window("frame-floater") {
            if visible {
                window.show().map_err(|e| e.to_string())?;
                size_frame_floater(&window)?;
            } else {
                window.hide().map_err(|e| e.to_string())?;
            }
        }
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        let _ = visible;
        Ok(())
    }
}

#[tauri::command]
async fn tauri_get_folder_size(folder: Option<String>) -> Result<u64, String> {
    let download_dir = dirs::download_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    let mut target_dir = download_dir.join("Mori");

    if let Some(f) = folder {
        let trimmed = f.trim();
        if !trimmed.is_empty() {
            if trimmed.starts_with("Mori/") || trimmed.starts_with("Mori\\") {
                target_dir = download_dir.join(trimmed);
            } else if trimmed != "Mori" {
                target_dir = target_dir.join(trimmed);
            }
        }
    }

    fn dir_size(path: &std::path::Path) -> u64 {
        let mut total = 0;
        if let Ok(entries) = std::fs::read_dir(path) {
            for entry in entries.flatten() {
                if let Ok(meta) = entry.metadata() {
                    if meta.is_file() {
                        total += meta.len();
                    } else if meta.is_dir() {
                        total += dir_size(&entry.path());
                    }
                }
            }
        }
        total
    }

    Ok(dir_size(&target_dir))
}

mod engine_sec;

#[cfg(target_os = "windows")]
mod sync_test_credential;
mod sync_authenticated_request;
#[cfg(target_os = "windows")]
mod sync_shadow_backup;

#[tauri::command]
fn tauri_sync_available() -> bool {
    #[cfg(target_os = "windows")]
    {
        return sync_test_credential::available();
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

#[tauri::command]
fn tauri_sync_credential_store(window: tauri::WebviewWindow, token: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        if window.label() != "main" {
            return Err("Sync credential can only be changed from the main window".into());
        }
        return sync_test_credential::store_sync_token(token.trim());
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window, token);
        Err("Personal sync credential storage is unavailable on this platform".into())
    }
}

#[tauri::command]
fn tauri_sync_credential_clear(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        if window.label() != "main" {
            return Err("Sync credential can only be changed from the main window".into());
        }
        return sync_test_credential::clear_sync_token();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
        Err("Personal sync credential storage is unavailable on this platform".into())
    }
}

#[tauri::command]
fn tauri_sync_credential_copy(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        if window.label() != "main" {
            return Err("Sync credential can only be copied from the main window".into());
        }
        return sync_test_credential::copy_sync_token_to_clipboard();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
        Err("Personal sync credential storage is unavailable on this platform".into())
    }
}

#[tauri::command]
async fn tauri_open_sync_diagnostic(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(all(target_os = "windows", debug_assertions))]
    {
        if window.label() != "main" {
            return Err("Sync diagnostic can only be opened from the main window".into());
        }
        let app = window.app_handle();
        if let Some(existing) = app.get_webview_window("sync-diagnostic") {
            existing.set_focus().map_err(|e| e.to_string())?;
            return Ok(());
        }
        tauri::WebviewWindowBuilder::new(
            app,
            "sync-diagnostic",
            tauri::WebviewUrl::App("sync-diagnostic.html".into()),
        )
        .title("Mori Synthetic Sync Diagnostic")
        .inner_size(720.0, 660.0)
        .build()
        .map_err(|e| format!("Could not open sync diagnostic: {e}"))?;
        Ok(())
    }
    #[cfg(not(all(target_os = "windows", debug_assertions)))]
    {
        let _ = window;
        Err("Sync diagnostic is unavailable in this build".into())
    }
}

#[tauri::command]
async fn tauri_open_shadow_sync(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(all(target_os = "windows", debug_assertions))]
    {
        if window.label() != "main" {
            return Err("Shadow sync can only be opened from the main window".into());
        }
        let app = window.app_handle();
        if let Some(existing) = app.get_webview_window("shadow-sync") {
            existing.set_focus().map_err(|e| e.to_string())?;
            return Ok(());
        }
        tauri::WebviewWindowBuilder::new(
            app,
            "shadow-sync",
            tauri::WebviewUrl::App("shadow-sync.html".into()),
        )
        .title("Mori Planner Shadow Sync")
        .inner_size(760.0, 660.0)
        .build()
        .map_err(|e| format!("Could not open shadow sync: {e}"))?;
        Ok(())
    }
    #[cfg(not(all(target_os = "windows", debug_assertions)))]
    {
        let _ = window;
        Err("Shadow sync is unavailable in this build".into())
    }
}

#[tauri::command]
async fn tauri_sync_authenticated_request(
    window: tauri::WebviewWindow,
    request: sync_authenticated_request::AuthenticatedRequest,
) -> Result<sync_authenticated_request::AuthenticatedResponse, String> {
    #[cfg(target_os = "windows")]
    {
        if !matches!(window.label(), "main" | "sync-diagnostic" | "shadow-sync") {
            return Err("Native sync requests are only available in approved sync windows".into());
        }
        sync_authenticated_request::send(request).await
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window, request);
        Err("Native sync is unavailable on this platform".into())
    }
}

#[cfg(all(target_os = "windows", debug_assertions))]
#[tauri::command]
fn tauri_sync_shadow_backup(
    window: tauri::WebviewWindow,
    raw_text: String,
) -> Result<sync_shadow_backup::ShadowBackupReceipt, String> {
    if window.label() != "shadow-sync" {
        return Err("Shadow backup is only available in the shadow-sync window".into());
    }
    sync_shadow_backup::save(&raw_text)
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn tauri_sync_manual_backup(
    window: tauri::WebviewWindow,
    raw_text: String,
) -> Result<sync_shadow_backup::ShadowBackupReceipt, String> {
    if window.label() != "main" {
        return Err("Manual sync backup is only available in the main window".into());
    }
    sync_shadow_backup::save(&raw_text)
}

#[tauri::command]
fn tauri_get_engine_key(challenge: String) -> Result<String, String> {
    engine_sec::get_key(&challenge)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_http::init())
    .invoke_handler(tauri::generate_handler![
        tauri_http_request,
        tauri_douyin_login,
        tauri_douyin_auth_status,
        tauri_douyin_verify_login,
        tauri_douyin_logout,
        tauri_douyin_ssr_request,
        tauri_douyin_page_detail,
        tauri_douyin_open_frame_picker,
        tauri_douyin_browser_request,
        tauri_download_file,
        tauri_read_file_bytes,
        tauri_fetch_bytes,
        tauri_save_bytes_file,
        tauri_clipboard_image_sequence,
        tauri_save_clipboard_frame,
        tauri_start_screen_snip,
        tauri_request_global_frame_capture,
        tauri_move_frame_floater,
        tauri_expand_frame_floater,
        tauri_favorites_request,
        tauri_favorites_response,
        tauri_favorites_changed,
        tauri_set_frame_floater_visible,
        tauri_get_clipboard_history,
        tauri_open_url,
        tauri_get_folder_size,
        tauri_get_engine_key,
        tauri_sync_available,
        tauri_sync_credential_store,
        tauri_sync_credential_clear,
        tauri_sync_credential_copy,
        tauri_open_sync_diagnostic,
        tauri_open_shadow_sync,
        tauri_sync_authenticated_request,
        #[cfg(all(target_os = "windows", debug_assertions))]
        tauri_sync_shadow_backup,
        #[cfg(target_os = "windows")]
        tauri_sync_manual_backup
    ])
    .setup(|app| {
      #[cfg(target_os = "windows")]
      {
        app.manage(std::sync::Mutex::new(FrameFloaterState::default()));
        let handle = app.handle().clone();
        if let Err(error) = create_frame_floater(&handle) {
          log::warn!("Could not create Mori frame floater: {error}");
        }
        if let Some(main_window) = app.get_webview_window("main") {
          let close_handle = app.handle().clone();
          main_window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
              if let Some(floater) = close_handle.get_webview_window("frame-floater") {
                let _ = floater.close();
              }
            }
          });
        }
        register_frame_capture_hotkey(handle);
      }
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

fn run_curl_fallback(
    url: &str,
    method: &str,
    headers: Option<&HashMap<String, String>>,
    body: Option<&str>,
) -> Result<serde_json::Value, String> {
    let mut cmd = std::process::Command::new("curl");
    cmd.args(["--http1.1", "-s", "-i", "-X", method, url]);

    if let Some(hdrs) = headers {
        for (k, v) in hdrs {
            cmd.arg("-H").arg(format!("{}: {}", k, v));
        }
    }

    if let Some(b) = body {
        cmd.arg("--data-raw").arg(b);
    }

    let output = cmd.output().map_err(|e| format!("Curl execution failed: {}", e))?;
    let raw = String::from_utf8_lossy(&output.stdout).to_string();

    let mut status = 200u16;
    let mut res_headers = HashMap::new();
    let mut body_str = raw.clone();

    if let Some(idx) = raw.rfind("\r\n\r\n") {
        let (head_section, body_part) = raw.split_at(idx);
        body_str = body_part[4..].to_string();

        let head_block = if let Some(prev_idx) = head_section.rfind("\r\n\r\n") {
            &head_section[prev_idx + 4..]
        } else {
            head_section
        };

        for line in head_block.lines() {
            if line.starts_with("HTTP/") {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 2 {
                    if let Ok(code) = parts[1].parse::<u16>() {
                        status = code;
                    }
                }
            } else if let Some((k, v)) = line.split_once(':') {
                res_headers.insert(k.trim().to_lowercase(), v.trim().to_string());
            }
        }
    } else if let Some(idx) = raw.rfind("\n\n") {
        let (head_section, body_part) = raw.split_at(idx);
        body_str = body_part[2..].to_string();
        for line in head_section.lines() {
            if line.starts_with("HTTP/") {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 2 {
                    if let Ok(code) = parts[1].parse::<u16>() {
                        status = code;
                    }
                }
            } else if let Some((k, v)) = line.split_once(':') {
                res_headers.insert(k.trim().to_lowercase(), v.trim().to_string());
            }
        }
    }

    Ok(serde_json::json!({
        "status": status,
        "headers": res_headers,
        "data": body_str
    }))
}

