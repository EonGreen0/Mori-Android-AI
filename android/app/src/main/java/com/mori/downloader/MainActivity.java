package com.mori.downloader;
 
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import java.io.File;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.net.URLDecoder;
import android.os.Environment;
import android.media.MediaScannerConnection;
import android.media.MediaMetadataRetriever;
import android.media.ThumbnailUtils;
import android.util.Size;
import android.provider.MediaStore;
import android.graphics.Matrix;
import androidx.core.content.FileProvider;
import android.graphics.Bitmap;
import android.util.Base64;
import android.util.Log;
import android.webkit.MimeTypeMap;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
 
import okhttp3.Cookie;
import okhttp3.CookieJar;
import okhttp3.Headers;
import okhttp3.HttpUrl;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.json.JSONObject;
import org.json.JSONArray;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import android.os.Handler;
import android.os.Looper;

public class MainActivity extends BridgeActivity {

    static {
        try {
            System.loadLibrary("morisec");
        } catch (Throwable ignored) {}
    }

    public static native String getEngineSecurityKeyNative(Context context, String challenge);

    private static final CookieJar memoryCookieJar = new CookieJar() {
        private final HashMap<String, List<Cookie>> cookieStore = new HashMap<>();

        @Override
        public void saveFromResponse(HttpUrl url, List<Cookie> cookies) {
            cookieStore.put(url.host(), cookies);
        }

        @Override
        public List<Cookie> loadForRequest(HttpUrl url) {
            List<Cookie> cookies = cookieStore.get(url.host());
            return cookies != null ? cookies : new ArrayList<>();
        }
    };

    private static final OkHttpClient sharedClient = new OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(120, TimeUnit.SECONDS)
            .followRedirects(true)
            .followSslRedirects(true)
            .cookieJar(memoryCookieJar)
            .build();

    private final ExecutorService executor = Executors.newCachedThreadPool();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private static final String MORI_SYNC_TEST_HOST = "mori-sync-gateway-test.pages.dev";
    private static final String MORI_SYNC_KEY_ALIAS = "mori.personal.sync.v1";
    private static final String MORI_SYNC_PREFS = "MoriSyncCredential";
    private static final String MORI_SYNC_PREF_CIPHERTEXT = "ciphertext";
    private static final String MORI_SYNC_PREF_IV = "iv";
    private static final String MORI_AI_KEY_ALIAS = "mori.ai.api-key.v1";
    private static final String MORI_AI_PREFS = "MoriAiCredential";
    private static final String MORI_AI_PREF_CIPHERTEXT = "ciphertext";
    private static final String MORI_AI_PREF_IV = "iv";
    private static final String MORI_AI_PREF_ALLOWED_ORIGIN = "allowed_origin";
    private static final OkHttpClient syncReadOnlyClient = new OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .followRedirects(false)
            .followSslRedirects(false)
            .build();
    private static final OkHttpClient aiClient = new OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(120, TimeUnit.SECONDS)
            .writeTimeout(120, TimeUnit.SECONDS)
            .followRedirects(false)
            .followSslRedirects(false)
            .build();

    private static boolean isValidSyncToken(String token) {
        return token != null
                && token.length() >= 20
                && token.length() <= 512
                && token.matches("^[A-Za-z0-9_+\\/=-]+$");
    }

    private static boolean isValidAiApiKey(String key) {
        if (key == null) return false;
        String value = key.trim();
        if (value.length() < 8 || value.length() > 4096) return false;
        for (int i = 0; i < value.length(); i++) {
            char ch = value.charAt(i);
            if (ch == '\r' || ch == '\n' || ch == 0) return false;
        }
        return true;
    }

    private SecretKey getOrCreateSyncCredentialKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        java.security.Key existing = keyStore.getKey(MORI_SYNC_KEY_ALIAS, null);
        if (existing instanceof SecretKey) return (SecretKey) existing;

        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(
                MORI_SYNC_KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build();
        generator.init(spec);
        return generator.generateKey();
    }

    private SecretKey getOrCreateAiCredentialKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        java.security.Key existing = keyStore.getKey(MORI_AI_KEY_ALIAS, null);
        if (existing instanceof SecretKey) return (SecretKey) existing;

        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(
                MORI_AI_KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build();
        generator.init(spec);
        return generator.generateKey();
    }

    private String readStoredAiApiKey() throws Exception {
        SharedPreferences prefs = getSharedPreferences(MORI_AI_PREFS, Context.MODE_PRIVATE);
        String ciphertextText = prefs.getString(MORI_AI_PREF_CIPHERTEXT, "");
        String ivText = prefs.getString(MORI_AI_PREF_IV, "");
        if (ciphertextText.isEmpty() || ivText.isEmpty()) return null;

        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        java.security.Key key = keyStore.getKey(MORI_AI_KEY_ALIAS, null);
        if (!(key instanceof SecretKey)) return null;

        byte[] ciphertext = Base64.decode(ciphertextText, Base64.NO_WRAP);
        byte[] iv = Base64.decode(ivText, Base64.NO_WRAP);
        if (ciphertext.length == 0 || ciphertext.length > 8192 || iv.length != 12) return null;
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, (SecretKey) key, new GCMParameterSpec(128, iv));
        String apiKey = new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
        return isValidAiApiKey(apiKey) ? apiKey : null;
    }

    private String aiEndpointOrigin(String baseUrl) throws Exception {
        Uri uri = Uri.parse((baseUrl != null ? baseUrl : "").trim());
        String host = uri.getHost();
        int port = uri.getPort();
        if (!"https".equalsIgnoreCase(uri.getScheme())
                || host == null || host.isEmpty()
                || uri.getUserInfo() != null
                || uri.getFragment() != null
                || uri.getQuery() != null
                || (port != -1 && port != 443)) {
            throw new SecurityException("AI endpoint must be a public HTTPS URL on port 443");
        }
        return host.toLowerCase(java.util.Locale.ROOT) + ":443";
    }

    private void storeAiApiKey(String apiKey, String baseUrl) throws Exception {
        String value = apiKey != null ? apiKey.trim() : "";
        if (!isValidAiApiKey(value)) throw new IllegalArgumentException("AI API key format is invalid");
        String allowedOrigin = aiEndpointOrigin(baseUrl);
        SecretKey key = getOrCreateAiCredentialKey();
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key);
        byte[] ciphertext = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        byte[] iv = cipher.getIV();
        getSharedPreferences(MORI_AI_PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(MORI_AI_PREF_CIPHERTEXT, Base64.encodeToString(ciphertext, Base64.NO_WRAP))
                .putString(MORI_AI_PREF_IV, Base64.encodeToString(iv, Base64.NO_WRAP))
                .putString(MORI_AI_PREF_ALLOWED_ORIGIN, allowedOrigin)
                .commit();
        java.util.Arrays.fill(ciphertext, (byte) 0);
        java.util.Arrays.fill(value.getBytes(StandardCharsets.UTF_8), (byte) 0);
    }

    private String readStoredAiOrigin() {
        return getSharedPreferences(MORI_AI_PREFS, Context.MODE_PRIVATE)
                .getString(MORI_AI_PREF_ALLOWED_ORIGIN, "");
    }

    private void authorizeAiEndpoint(String baseUrl) throws Exception {
        if (readStoredAiApiKey() == null) throw new IllegalStateException("AI API key is unavailable");
        getSharedPreferences(MORI_AI_PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(MORI_AI_PREF_ALLOWED_ORIGIN, aiEndpointOrigin(baseUrl))
                .commit();
    }

    private void clearAiApiKey() throws Exception {
        getSharedPreferences(MORI_AI_PREFS, Context.MODE_PRIVATE).edit().clear().commit();
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (keyStore.containsAlias(MORI_AI_KEY_ALIAS)) keyStore.deleteEntry(MORI_AI_KEY_ALIAS);
    }

    private String readStoredSyncToken() throws Exception {
        SharedPreferences prefs = getSharedPreferences(MORI_SYNC_PREFS, Context.MODE_PRIVATE);
        String ciphertextText = prefs.getString(MORI_SYNC_PREF_CIPHERTEXT, "");
        String ivText = prefs.getString(MORI_SYNC_PREF_IV, "");
        if (ciphertextText.isEmpty() || ivText.isEmpty()) return null;

        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        java.security.Key key = keyStore.getKey(MORI_SYNC_KEY_ALIAS, null);
        if (!(key instanceof SecretKey)) return null;

        byte[] ciphertext = Base64.decode(ciphertextText, Base64.NO_WRAP);
        byte[] iv = Base64.decode(ivText, Base64.NO_WRAP);
        if (ciphertext.length == 0 || ciphertext.length > 2048 || iv.length != 12) return null;
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, (SecretKey) key, new GCMParameterSpec(128, iv));
        String token = new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
        return isValidSyncToken(token) ? token : null;
    }

    private void storeSyncToken(String token) throws Exception {
        String value = token != null ? token.trim() : "";
        if (!isValidSyncToken(value)) throw new IllegalArgumentException("Personal sync credential format is invalid");
        SecretKey key = getOrCreateSyncCredentialKey();
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key);
        byte[] ciphertext = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        byte[] iv = cipher.getIV();
        getSharedPreferences(MORI_SYNC_PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(MORI_SYNC_PREF_CIPHERTEXT, Base64.encodeToString(ciphertext, Base64.NO_WRAP))
                .putString(MORI_SYNC_PREF_IV, Base64.encodeToString(iv, Base64.NO_WRAP))
                .commit();
        java.util.Arrays.fill(ciphertext, (byte) 0);
    }

    private void clearSyncToken() throws Exception {
        getSharedPreferences(MORI_SYNC_PREFS, Context.MODE_PRIVATE).edit().clear().commit();
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (keyStore.containsAlias(MORI_SYNC_KEY_ALIAS)) keyStore.deleteEntry(MORI_SYNC_KEY_ALIAS);
    }

    public class MoriMainBridge {
        @JavascriptInterface
        public String getEngineSecurityKey(String challenge) {
            try {
                return getEngineSecurityKeyNative(MainActivity.this, challenge);
            } catch (Throwable e) {
                return "UNAUTHORIZED_CLONE";
            }
        }

        @JavascriptInterface
        public String getScrapersBinaryBase64() {
            try (InputStream is = getAssets().open("public/js/scrapers.bin")) {
                ByteArrayOutputStream buffer = new ByteArrayOutputStream();
                int nRead;
                byte[] data = new byte[16384];
                while ((nRead = is.read(data, 0, data.length)) != -1) {
                    buffer.write(data, 0, nRead);
                }
                return Base64.encodeToString(buffer.toByteArray(), Base64.NO_WRAP);
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public void httpRequestAsync(String optionsJson, String reqId) {
            executor.execute(() -> {
                String result;
                try {
                    result = httpRequest(optionsJson);
                } catch (Throwable t) {
                    String msg = t.getMessage() != null ? t.getMessage().replace("\"", "'") : t.getClass().getSimpleName();
                    result = "{\"status\":0,\"data\":\"\",\"error\":\"" + msg + "\"}";
                }
                final String finalResult = result;
                mainHandler.post(() -> {
                    try {
                        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
                        if (webView != null) {
                            String js = "if (window.__moriNativeCallbacks && window.__moriNativeCallbacks['" + reqId + "']) { " +
                                        "  window.__moriNativeCallbacks['" + reqId + "'](" + JSONObject.quote(finalResult) + "); " +
                                        "  delete window.__moriNativeCallbacks['" + reqId + "']; " +
                                        "} else if (window.__moriShareCallbacks && window.__moriShareCallbacks['" + reqId + "']) { " +
                                        "  window.__moriShareCallbacks['" + reqId + "'](" + JSONObject.quote(finalResult) + "); " +
                                        "  delete window.__moriShareCallbacks['" + reqId + "']; " +
                                        "}";
                            webView.evaluateJavascript(js, null);
                        }
                    } catch (Exception e) {
                        Log.e("MoriMain", "httpRequestAsync callback error: " + e.getMessage());
                    }
                });
            });
        }

        @JavascriptInterface
        public String httpRequest(String optionsJson) {
            try {
                JSONObject opts = new JSONObject(optionsJson);
                String url        = opts.getString("url");
                String method     = opts.optString("method", "GET").toUpperCase();
                JSONObject hdrsIn = opts.optJSONObject("headers");
                String body       = opts.optString("data", null);
                JSONObject params = opts.optJSONObject("params");
                String respType   = opts.optString("responseType", "text");

                if (params != null && params.length() > 0) {
                    StringBuilder sb = new StringBuilder(url.contains("?") ? url + "&" : url + "?");
                    Iterator<String> keys = params.keys();
                    while (keys.hasNext()) {
                        String k = keys.next();
                        sb.append(Uri.encode(k)).append("=").append(Uri.encode(params.getString(k)));
                        if (keys.hasNext()) sb.append("&");
                    }
                    url = sb.toString();
                }

                OkHttpClient client = sharedClient;

                Headers.Builder hb = new Headers.Builder();
                if (hdrsIn != null) {
                    Iterator<String> keys = hdrsIn.keys();
                    while (keys.hasNext()) {
                        String k = keys.next();
                        String v = hdrsIn.optString(k, "");
                        try {
                            hb.set(k, v);
                        } catch (Exception ignored) {}
                    }
                }

                Request.Builder rb = new Request.Builder().url(url).headers(hb.build());
                if ("POST".equals(method) || "PUT".equals(method) || "PATCH".equals(method)) {
                    String ct = hdrsIn != null ? hdrsIn.optString("Content-Type", "") : "";
                    if (ct.isEmpty() && hdrsIn != null) {
                        ct = hdrsIn.optString("content-type", "");
                    }
                    if (ct.isEmpty()) {
                        ct = (body != null && (body.trim().startsWith("{") || body.trim().startsWith("[")))
                                ? "application/json; charset=utf-8"
                                : "application/x-www-form-urlencoded; charset=utf-8";
                    }
                    RequestBody rb2 = body != null
                            ? RequestBody.create(body, MediaType.parse(ct))
                            : RequestBody.create("", MediaType.parse(ct));
                    if ("PUT".equals(method)) rb = rb.put(rb2);
                    else if ("PATCH".equals(method)) rb = rb.patch(rb2);
                    else rb = rb.post(rb2);
                } else if ("DELETE".equals(method)) {
                    rb = rb.delete();
                } else if ("HEAD".equals(method)) {
                    rb = rb.head();
                } else {
                    rb = rb.get();
                }

                Response res = client.newCall(rb.build()).execute();

                JSONObject resHeaders = new JSONObject();
                for (String name : res.headers().names()) {
                    resHeaders.put(name.toLowerCase(), res.header(name));
                }

                String resData;
                if ("arraybuffer".equals(respType) || "blob".equals(respType)) {
                    byte[] bytes = res.body() != null ? res.body().bytes() : new byte[0];
                    resData = Base64.encodeToString(bytes, Base64.NO_WRAP);
                } else {
                    resData = res.body() != null ? res.body().string() : "";
                }

                JSONObject result = new JSONObject();
                result.put("status", res.code());
                result.put("headers", resHeaders);
                result.put("data", resData);
                result.put("url", res.request().url().toString());
                return result.toString();

            } catch (Throwable e) {
                Log.e("MoriMain", "httpRequest error: " + e.getMessage());
                String msg = e.getMessage() != null ? e.getMessage().replace("\"", "'") : e.getClass().getSimpleName();
                return "{\"status\":0,\"data\":\"\",\"error\":\"" + msg + "\"}";
            }
        }

        @JavascriptInterface
        public boolean syncCredentialAvailable() {
            try {
                return readStoredSyncToken() != null;
            } catch (Throwable ignored) {
                return false;
            }
        }

        @JavascriptInterface
        public boolean syncCredentialStore(String token) {
            try {
                storeSyncToken(token);
                return true;
            } catch (Throwable error) {
                Log.e("MoriSyncCredential", "store failed: " + error.getMessage());
                return false;
            }
        }

        @JavascriptInterface
        public boolean syncCredentialClear() {
            try {
                clearSyncToken();
                return true;
            } catch (Throwable error) {
                Log.e("MoriSyncCredential", "clear failed: " + error.getMessage());
                return false;
            }
        }

        @JavascriptInterface
        public boolean aiCredentialAvailable() {
            try {
                return readStoredAiApiKey() != null;
            } catch (Throwable ignored) {
                return false;
            }
        }

        @JavascriptInterface
        public boolean aiCredentialStore(String apiKey, String baseUrl) {
            try {
                storeAiApiKey(apiKey, baseUrl);
                return true;
            } catch (Throwable error) {
                Log.e("MoriAiCredential", "store failed: " + error.getMessage());
                return false;
            }
        }

        @JavascriptInterface
        public boolean aiEndpointAuthorize(String baseUrl) {
            try {
                authorizeAiEndpoint(baseUrl);
                return true;
            } catch (Throwable error) {
                Log.e("MoriAiCredential", "endpoint authorization failed: " + error.getMessage());
                return false;
            }
        }

        @JavascriptInterface
        public boolean aiCredentialClear() {
            try {
                clearAiApiKey();
                return true;
            } catch (Throwable error) {
                Log.e("MoriAiCredential", "clear failed: " + error.getMessage());
                return false;
            }
        }

        @JavascriptInterface
        public void aiRequestAsync(String optionsJson, String reqId) {
            executor.execute(() -> {
                String result;
                try {
                    result = aiRequest(optionsJson);
                } catch (Throwable error) {
                    try {
                        JSONObject failure = new JSONObject();
                        failure.put("status", 0);
                        failure.put("data", "");
                        failure.put("error", error.getMessage() != null ? error.getMessage() : error.getClass().getSimpleName());
                        result = failure.toString();
                    } catch (Throwable ignored) {
                        result = "{\"status\":0,\"data\":\"\",\"error\":\"AI request failed\"}";
                    }
                }
                final String finalResult = result;
                mainHandler.post(() -> {
                    try {
                        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
                        if (webView == null) return;
                        String safeReqId = reqId != null ? reqId.replaceAll("[^A-Za-z0-9_-]", "") : "";
                        String js = "if (window.__moriAiCallbacks && window.__moriAiCallbacks['" + safeReqId + "']) { " +
                                "window.__moriAiCallbacks['" + safeReqId + "'](" + JSONObject.quote(finalResult) + "); " +
                                "delete window.__moriAiCallbacks['" + safeReqId + "']; }";
                        webView.evaluateJavascript(js, null);
                    } catch (Throwable error) {
                        Log.e("MoriAi", "callback error: " + error.getMessage());
                    }
                });
            });
        }

        private String aiRequest(String optionsJson) throws Exception {
            String apiKey = readStoredAiApiKey();
            if (apiKey == null) throw new IllegalStateException("AI API key is unavailable");
            JSONObject options = new JSONObject(optionsJson);
            String rawBaseUrl = options.optString("baseUrl", "").trim();
            String model = options.optString("model", "").trim();
            String prompt = options.optString("prompt", "").trim();
            if (rawBaseUrl.isEmpty() || rawBaseUrl.length() > 2048
                    || model.isEmpty() || model.length() > 200
                    || prompt.isEmpty() || prompt.length() > 65536) {
                throw new SecurityException("AI request configuration is invalid");
            }

            String endpoint = rawBaseUrl;
            while (endpoint.endsWith("/")) endpoint = endpoint.substring(0, endpoint.length() - 1);
            if (!endpoint.endsWith("/chat/completions")) endpoint += "/chat/completions";
            Uri uri = Uri.parse(endpoint);
            String host = uri.getHost();
            if (!"https".equalsIgnoreCase(uri.getScheme())
                    || host == null || host.isEmpty()
                    || uri.getUserInfo() != null
                    || uri.getFragment() != null
                    || uri.getQuery() != null
                    || (uri.getPort() != -1 && uri.getPort() != 443)) {
                throw new SecurityException("AI endpoint must be a public HTTPS URL on port 443");
            }
            String allowedOrigin = readStoredAiOrigin();
            String requestOrigin = host.toLowerCase(java.util.Locale.ROOT) + ":443";
            if (allowedOrigin.isEmpty() || !allowedOrigin.equals(requestOrigin)) {
                throw new SecurityException("AI endpoint is not authorized for the stored API key");
            }
            for (java.net.InetAddress address : java.net.InetAddress.getAllByName(host)) {
                if (address.isAnyLocalAddress() || address.isLoopbackAddress()
                        || address.isLinkLocalAddress() || address.isSiteLocalAddress()
                        || address.isMulticastAddress()) {
                    throw new SecurityException("AI endpoint cannot resolve to a private or local address");
                }
            }

            JSONArray dataUrls = options.optJSONArray("imageDataUrls");
            if (dataUrls == null) dataUrls = new JSONArray();
            if (dataUrls.length() > 8) throw new SecurityException("AI request has too many images");
            long totalImageCharacters = 0;
            for (int i = 0; i < dataUrls.length(); i++) {
                String value = dataUrls.optString(i, "");
                if (!value.startsWith("data:image/") || value.length() > 5 * 1024 * 1024) {
                    throw new SecurityException("AI request contains an invalid image");
                }
                totalImageCharacters += value.length();
            }
            if (totalImageCharacters > 20L * 1024L * 1024L) {
                throw new SecurityException("AI request images are too large");
            }

            JSONArray messages = new JSONArray();
            JSONObject system = new JSONObject();
            system.put("role", "system");
            system.put("content", "You are Mori's visual archivist. Follow the requested JSON schema exactly. Do not include markdown fences or commentary.");
            messages.put(system);

            JSONObject user = new JSONObject();
            user.put("role", "user");
            JSONArray content = new JSONArray();
            JSONObject text = new JSONObject();
            text.put("type", "text");
            text.put("text", prompt);
            content.put(text);
            for (int i = 0; i < dataUrls.length(); i++) {
                JSONObject image = new JSONObject();
                image.put("type", "image_url");
                JSONObject imageUrl = new JSONObject();
                imageUrl.put("url", dataUrls.getString(i));
                image.put("image_url", imageUrl);
                content.put(image);
            }
            user.put("content", content);
            messages.put(user);

            JSONObject body = new JSONObject();
            body.put("model", model);
            body.put("messages", messages);
            body.put("stream", false);

            Headers.Builder headers = new Headers.Builder();
            headers.set("Authorization", "Bearer " + apiKey);
            headers.set("Content-Type", "application/json; charset=utf-8");
            headers.set("Accept", "application/json");
            RequestBody requestBody = RequestBody.create(
                    body.toString(), MediaType.parse("application/json; charset=utf-8"));
            Request request = new Request.Builder()
                    .url(endpoint)
                    .headers(headers.build())
                    .post(requestBody)
                    .build();
            try (Response response = aiClient.newCall(request).execute()) {
                if (response.isRedirect()) throw new SecurityException("AI endpoint redirect is not allowed");
                String responseData = response.body() != null
                        ? response.peekBody(2L * 1024L * 1024L).string()
                        : "";
                JSONObject result = new JSONObject();
                result.put("status", response.code());
                result.put("data", responseData);
                return result.toString();
            }
        }

        @JavascriptInterface
        public boolean syncReadOnlyAvailable() {
            return syncCredentialAvailable();
        }

        @JavascriptInterface
        public void syncReadOnlyRequestAsync(String optionsJson, String reqId) {
            executor.execute(() -> {
                String result;
                try {
                    result = syncReadOnlyRequest(optionsJson);
                } catch (Throwable t) {
                    String msg = t.getMessage() != null ? t.getMessage().replace("\"", "'") : t.getClass().getSimpleName();
                    result = "{\"status\":0,\"data\":\"\",\"error\":\"" + msg + "\"}";
                }
                final String finalResult = result;
                mainHandler.post(() -> {
                    try {
                        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
                        if (webView != null) {
                            String safeReqId = reqId != null ? reqId.replaceAll("[^A-Za-z0-9_-]", "") : "";
                            String js = "if (window.__moriSyncReadOnlyCallbacks && window.__moriSyncReadOnlyCallbacks['" + safeReqId + "']) { " +
                                    "window.__moriSyncReadOnlyCallbacks['" + safeReqId + "'](" + JSONObject.quote(finalResult) + "); " +
                                    "delete window.__moriSyncReadOnlyCallbacks['" + safeReqId + "']; }";
                            webView.evaluateJavascript(js, null);
                        }
                    } catch (Exception e) {
                        Log.e("MoriSyncReadOnly", "callback error: " + e.getMessage());
                    }
                });
            });
        }

        private String syncReadOnlyRequest(String optionsJson) throws Exception {
            String token = readStoredSyncToken();
            if (token == null) throw new IllegalStateException("Android sync credential is unavailable");
            JSONObject opts = new JSONObject(optionsJson);
            String rawUrl = opts.getString("url");
            String method = opts.optString("method", "GET").toUpperCase();
            String responseType = opts.optString("responseType", "text");
            if (!"GET".equals(method)) throw new SecurityException("Android read-only sync only allows GET");
            if (!"text".equals(responseType) && !"base64".equals(responseType)) {
                throw new SecurityException("Android sync response type is not allowed");
            }
            Uri uri = Uri.parse(rawUrl);
            String path = uri.getPath();
            int port = uri.getPort();
            if (!"https".equalsIgnoreCase(uri.getScheme())
                    || !MORI_SYNC_TEST_HOST.equalsIgnoreCase(uri.getHost())
                    || (port != -1 && port != 443)
                    || uri.getUserInfo() != null
                    || uri.getFragment() != null
                    || path == null
                    || !path.startsWith("/v1/")) {
                throw new SecurityException("Android sync request destination is not allowed");
            }
            Headers.Builder headers = new Headers.Builder();
            JSONObject hdrsIn = opts.optJSONObject("headers");
            if (hdrsIn != null) {
                Iterator<String> keys = hdrsIn.keys();
                while (keys.hasNext()) {
                    String name = keys.next();
                    String lower = name.toLowerCase();
                    if (!"accept".equals(lower) && !"content-type".equals(lower)) {
                        throw new SecurityException("Android sync request header is not allowed");
                    }
                    headers.set(name, hdrsIn.optString(name, ""));
                }
            }
            headers.set("Authorization", "Bearer " + token);
            Request request = new Request.Builder().url(rawUrl).headers(headers.build()).get().build();
            try (Response response = syncReadOnlyClient.newCall(request).execute()) {
                if (response.isRedirect()) throw new SecurityException("Android sync redirect is not allowed");
                JSONObject result = new JSONObject();
                result.put("status", response.code());
                JSONObject responseHeaders = new JSONObject();
                String contentType = response.header("content-type");
                if (contentType != null) responseHeaders.put("content-type", contentType);
                String displayRef = response.header("x-mori-display-ref");
                if (displayRef != null) responseHeaders.put("x-mori-display-ref", displayRef);
                result.put("headers", responseHeaders);
                if ("base64".equals(responseType)) {
                    byte[] bytes = response.body() != null ? response.body().bytes() : new byte[0];
                    result.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
                    result.put("encoding", "base64");
                } else {
                    result.put("data", response.body() != null ? response.body().string() : "");
                    result.put("encoding", "text");
                }
                return result.toString();
            }
        }

        @JavascriptInterface
        public boolean syncPlannerWriteAvailable() {
            return syncReadOnlyAvailable();
        }

        @JavascriptInterface
        public void syncPlannerWriteRequestAsync(String optionsJson, String reqId) {
            executor.execute(() -> {
                String result;
                try {
                    result = syncPlannerWriteRequest(optionsJson);
                } catch (Throwable t) {
                    String msg = t.getMessage() != null ? t.getMessage().replace("\"", "'") : t.getClass().getSimpleName();
                    result = "{\"status\":0,\"data\":\"\",\"error\":\"" + msg + "\"}";
                }
                final String finalResult = result;
                mainHandler.post(() -> {
                    try {
                        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
                        if (webView != null) {
                            String safeReqId = reqId != null ? reqId.replaceAll("[^A-Za-z0-9_-]", "") : "";
                            String js = "if (window.__moriSyncReadOnlyCallbacks && window.__moriSyncReadOnlyCallbacks['" + safeReqId + "']) { " +
                                    "window.__moriSyncReadOnlyCallbacks['" + safeReqId + "'](" + JSONObject.quote(finalResult) + "); " +
                                    "delete window.__moriSyncReadOnlyCallbacks['" + safeReqId + "']; }";
                            webView.evaluateJavascript(js, null);
                        }
                    } catch (Exception e) {
                        Log.e("MoriSyncPlannerWrite", "callback error: " + e.getMessage());
                    }
                });
            });
        }

        private String syncPlannerWriteRequest(String optionsJson) throws Exception {
            String token = readStoredSyncToken();
            if (token == null) throw new IllegalStateException("Android sync credential is unavailable");
            JSONObject opts = new JSONObject(optionsJson);
            String rawUrl = opts.getString("url");
            String method = opts.optString("method", "POST").toUpperCase();
            String data = opts.optString("data", "");
            if (!"POST".equals(method)) throw new SecurityException("Android planner-write sync only allows POST");
            if (data.isEmpty() || data.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 131072) {
                throw new SecurityException("Android planner-write sync body is invalid");
            }

            Uri uri = Uri.parse(rawUrl);
            int port = uri.getPort();
            List<String> segments = uri.getPathSegments();
            if (!"https".equalsIgnoreCase(uri.getScheme())
                    || !MORI_SYNC_TEST_HOST.equalsIgnoreCase(uri.getHost())
                    || (port != -1 && port != 443)
                    || uri.getUserInfo() != null
                    || uri.getFragment() != null
                    || uri.getQuery() != null
                    || segments.size() != 4
                    || !"v1".equals(segments.get(0))
                    || !"projects".equals(segments.get(1))
                    || !"mutations".equals(segments.get(3))) {
                throw new SecurityException("Android planner-write sync destination is not allowed");
            }
            String projectId = segments.get(2);
            if (projectId.isEmpty() || projectId.length() > 256) {
                throw new SecurityException("Android planner-write sync projectId is invalid");
            }

            JSONObject body = new JSONObject(data);
            String deviceId = body.optString("deviceId", "");
            org.json.JSONArray mutations = body.optJSONArray("mutations");
            if (deviceId.isEmpty() || deviceId.length() > 256 || mutations == null
                    || mutations.length() < 1 || mutations.length() > 200) {
                throw new SecurityException("Android planner-write sync batch size is invalid");
            }

            int groupCount = 0;
            int deleteCount = 0;
            int nodeDeleteCount = 0;
            int nonGroupUpsertCount = 0;
            for (int i = 0; i < mutations.length(); i++) {
                JSONObject mutation = mutations.getJSONObject(i);
                String entityId = mutation.optString("entityId", "");
                String entityType = mutation.optString("entityType", "");
                String operation = mutation.optString("operation", "");
                if (!projectId.equals(mutation.optString("projectId", "")) || entityId.isEmpty()) {
                    throw new SecurityException("Android planner-write sync mutation is not allowed");
                }

                if ("delete".equals(operation)) {
                    if (!("node".equals(entityType) || "edge".equals(entityType) || "asset".equals(entityType))
                            || !mutation.has("payload") || !mutation.isNull("payload")) {
                        throw new SecurityException("Android planner delete mutation is invalid");
                    }
                    deleteCount += 1;
                    if ("node".equals(entityType)) nodeDeleteCount += 1;
                    continue;
                }

                JSONObject payload = mutation.optJSONObject("payload");
                String nodeType = payload != null ? payload.optString("type", "") : "";
                boolean textNode = "text".equals(nodeType);
                boolean imageNode = "image".equals(nodeType);
                boolean groupNode = "group".equals(nodeType);
                if (!"node".equals(entityType)
                        || !"upsert".equals(operation)
                        || payload == null
                        || (!textNode && !imageNode && !groupNode)
                        || !entityId.equals(payload.optString("id", ""))
                        || payload.has("path")
                        || payload.has("uri")
                        || payload.has("thumbnail")
                        || payload.has("fileKey")) {
                    throw new SecurityException("Android planner-write sync mutation is not allowed");
                }
                if (textNode) {
                    nonGroupUpsertCount += 1;
                    if (payload.has("assetId") || payload.has("memberIds")) {
                        throw new SecurityException("Android text node payload is invalid");
                    }
                }
                if (imageNode) {
                    nonGroupUpsertCount += 1;
                    if (payload.has("memberIds")) {
                        throw new SecurityException("Android image node payload is invalid");
                    }
                    String assetId = payload.optString("assetId", "");
                    if (!assetId.matches("^sha256:[0-9a-fA-F]{64}$")) {
                        throw new SecurityException("Android image node requires a portable assetId");
                    }
                }
                if (groupNode) {
                    groupCount += 1;
                    if (payload.has("assetId") || payload.optJSONArray("memberIds") == null) {
                        throw new SecurityException("Android group node payload is invalid");
                    }
                }
            }
            if (deleteCount > 0) {
                if (nodeDeleteCount != 1 || nonGroupUpsertCount != 0) {
                    throw new SecurityException("Android delete batch must contain exactly one node delete and only cascade companions");
                }
            } else if (mutations.length() > 1 && groupCount != 1) {
                throw new SecurityException("Android planner-write batch must contain exactly one group");
            }

            Headers.Builder headers = new Headers.Builder();
            JSONObject hdrsIn = opts.optJSONObject("headers");
            if (hdrsIn != null) {
                Iterator<String> keys = hdrsIn.keys();
                while (keys.hasNext()) {
                    String name = keys.next();
                    String lower = name.toLowerCase();
                    if (!"accept".equals(lower) && !"content-type".equals(lower)) {
                        throw new SecurityException("Android sync request header is not allowed");
                    }
                }
            }
            headers.set("Authorization", "Bearer " + token);
            headers.set("Content-Type", "application/json; charset=utf-8");
            RequestBody requestBody = RequestBody.create(data, MediaType.parse("application/json; charset=utf-8"));
            Request request = new Request.Builder().url(rawUrl).headers(headers.build()).post(requestBody).build();
            try (Response response = syncReadOnlyClient.newCall(request).execute()) {
                if (response.isRedirect()) throw new SecurityException("Android sync redirect is not allowed");
                String responseData = response.body() != null ? response.body().string() : "";
                JSONObject result = new JSONObject();
                result.put("status", response.code());
                JSONObject responseHeaders = new JSONObject();
                String contentType = response.header("content-type");
                if (contentType != null) responseHeaders.put("content-type", contentType);
                result.put("headers", responseHeaders);
                result.put("data", responseData);
                return result.toString();
            }
        }

        @JavascriptInterface
        public String getPendingHistoryList() {
            try {
                SharedPreferences prefs = getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE);
                return prefs.getString("mori_pending_share_history_list", "[]");
            } catch (Exception e) {
                return "[]";
            }
        }

        @JavascriptInterface
        public void clearPendingHistoryList() {
            try {
                SharedPreferences prefs = getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE);
                prefs.edit().remove("mori_pending_share_history_list").commit();
            } catch (Exception ignored) {}
        }

        @JavascriptInterface
        public void saveSetting(String key, String value) {
            try {
                if (key == null || value == null) return;
                SharedPreferences prefs = getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE);
                prefs.edit().putString(key, value).commit();
            } catch (Exception ignored) {}
        }

        @JavascriptInterface
        public void startDownloadService(String title) {
            try {
                Intent intent = new Intent(MainActivity.this, DownloadForegroundService.class);
                intent.putExtra("title", title != null ? title : "Downloading Media...");
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                    startForegroundService(intent);
                } else {
                    startService(intent);
                }
            } catch (Exception e) {
                e.printStackTrace();
            }
        }

        @JavascriptInterface
        public void stopDownloadService() {
            try {
                Intent intent = new Intent(MainActivity.this, DownloadForegroundService.class);
                stopService(intent);
            } catch (Exception e) {
                e.printStackTrace();
            }
        }

        @JavascriptInterface
        public void showCompleteNotification(String title, String path) {
            try {
                android.app.NotificationManager nm = (android.app.NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                if (nm == null) return;
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                    android.app.NotificationChannel ch = new android.app.NotificationChannel(
                            "mori_download_complete", "Mori Downloads", android.app.NotificationManager.IMPORTANCE_DEFAULT);
                    nm.createNotificationChannel(ch);
                }
                androidx.core.app.NotificationCompat.Builder b = new androidx.core.app.NotificationCompat.Builder(MainActivity.this, "mori_download_complete")
                        .setSmallIcon(android.R.drawable.stat_sys_download_done)
                        .setContentTitle("Download Complete ✓")
                        .setContentText((title != null ? title : "Media") + (path != null ? " · " + path : ""))
                        .setPriority(androidx.core.app.NotificationCompat.PRIORITY_DEFAULT)
                        .setAutoCancel(true);
                nm.notify((int) System.currentTimeMillis(), b.build());
            } catch (Exception e) {
                e.printStackTrace();
            }
        }

        @JavascriptInterface
        public void showFailedNotification(String title, String error) {
            try {
                android.app.NotificationManager nm = (android.app.NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                if (nm == null) return;
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                    android.app.NotificationChannel ch = new android.app.NotificationChannel(
                            "mori_download_complete", "Mori Downloads", android.app.NotificationManager.IMPORTANCE_DEFAULT);
                    nm.createNotificationChannel(ch);
                }
                androidx.core.app.NotificationCompat.Builder b = new androidx.core.app.NotificationCompat.Builder(MainActivity.this, "mori_download_complete")
                        .setSmallIcon(android.R.drawable.stat_notify_error)
                        .setContentTitle("Download Failed")
                        .setContentText((title != null ? title : "Media") + ": " + (error != null ? error : "Failed"))
                        .setPriority(androidx.core.app.NotificationCompat.PRIORITY_DEFAULT)
                        .setAutoCancel(true);
                nm.notify((int) System.currentTimeMillis(), b.build());
            } catch (Exception e) {
                e.printStackTrace();
            }
        }

        @JavascriptInterface
        public void scanMediaFile(String rawPath) {
            try {
                if (rawPath == null || rawPath.isEmpty()) return;
                String cleanPath = rawPath;
                if (cleanPath.startsWith("file://")) {
                    cleanPath = cleanPath.substring(7);
                }
                cleanPath = URLDecoder.decode(cleanPath, "UTF-8");
                File f = new File(cleanPath);
                if (!f.isAbsolute()) {
                    f = new File(Environment.getExternalStorageDirectory(), cleanPath.replaceFirst("^/+", ""));
                }
                if (!f.exists()) {
                    File d1 = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), cleanPath.replaceFirst("^/+", ""));
                    if (d1.exists()) f = d1;
                }
                if (!f.exists()) {
                    File d2 = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MOVIES), cleanPath.replaceFirst("^/+", ""));
                    if (d2.exists()) f = d2;
                }
                if (!f.exists()) {
                    File d3 = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), cleanPath.replaceFirst("^/+", ""));
                    if (d3.exists()) f = d3;
                }
                if (f.exists()) {
                    f.setLastModified(System.currentTimeMillis());
                    String name = f.getName().toLowerCase();
                    String mimeType = null;
                    int dot = name.lastIndexOf('.');
                    if (dot > 0 && dot < name.length() - 1) {
                        mimeType = MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substring(dot + 1));
                    }
                    if (mimeType == null) {
                        if (name.endsWith(".mp4") || name.endsWith(".mov") || name.endsWith(".webm") || name.endsWith(".mkv")) mimeType = "video/mp4";
                        else if (name.endsWith(".mp3") || name.endsWith(".m4a")) mimeType = "audio/mpeg";
                        else if (name.endsWith(".jpg") || name.endsWith(".jpeg") || name.endsWith(".png") || name.endsWith(".webp")) mimeType = "image/jpeg";
                    }
                    final String finalMime = mimeType;
                    MediaScannerConnection.scanFile(
                        getApplicationContext(),
                        new String[]{ f.getAbsolutePath() },
                        finalMime != null ? new String[]{ finalMime } : null,
                        (scannedPath, uri) -> {
                            Log.d("MoriMainBridge", "MediaScanner indexed: " + scannedPath + " -> " + uri);
                        }
                    );
                }
            } catch (Exception e) {
                e.printStackTrace();
            }
        }

        private Bitmap extractBestFrame(MediaMetadataRetriever retriever) {
            Bitmap bitmap = null;
            long timeUs = 2000000;
            try {
                String durStr = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);
                if (durStr != null) {
                    long durMs = Long.parseLong(durStr);
                    if (durMs > 0) {
                        timeUs = (durMs / 2) * 1000;
                    }
                }
            } catch (Throwable ignored) {}

            int videoWidth = 0;
            int videoHeight = 0;
            int rotation = 0;
            try {
                String wStr = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH);
                String hStr = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT);
                String rotStr = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION);
                if (wStr != null) videoWidth = Integer.parseInt(wStr);
                if (hStr != null) videoHeight = Integer.parseInt(hStr);
                if (rotStr != null) rotation = Integer.parseInt(rotStr);
            } catch (Throwable ignored) {}

            boolean isTargetPortrait;
            if (rotation == 90 || rotation == 270) {
                isTargetPortrait = (videoWidth >= videoHeight);
            } else {
                isTargetPortrait = (videoHeight >= videoWidth);
            }

            int dstWidth = 512;
            int dstHeight = 512;
            if (videoWidth > 0 && videoHeight > 0) {
                int maxDim = 512;
                if (videoWidth >= videoHeight) {
                    dstWidth = maxDim;
                    dstHeight = Math.max(1, (videoHeight * maxDim) / videoWidth);
                } else {
                    dstHeight = maxDim;
                    dstWidth = Math.max(1, (videoWidth * maxDim) / videoHeight);
                }
            }

            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O_MR1) {
                try {
                    bitmap = retriever.getScaledFrameAtTime(timeUs, MediaMetadataRetriever.OPTION_CLOSEST, dstWidth, dstHeight);
                } catch (Throwable ignored) {}
            }
            if (bitmap == null) {
                try {
                    bitmap = retriever.getFrameAtTime(timeUs, MediaMetadataRetriever.OPTION_CLOSEST);
                } catch (Throwable ignored) {}
            }
            if (bitmap == null) {
                try {
                    bitmap = retriever.getFrameAtTime();
                } catch (Throwable ignored) {}
            }

            if (bitmap != null) {
                boolean isBitmapPortrait = bitmap.getHeight() >= bitmap.getWidth();

                if (isTargetPortrait != isBitmapPortrait) {
                    int rotToApply = (rotation != 0) ? rotation : 90;
                    try {
                        Matrix matrix = new Matrix();
                        matrix.postRotate(rotToApply);
                        Bitmap rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.getWidth(), bitmap.getHeight(), matrix, true);
                        if (rotated != bitmap) {
                            bitmap.recycle();
                            bitmap = rotated;
                        }
                    } catch (Throwable ignored) {}
                } else if (rotation == 180) {
                    try {
                        Matrix matrix = new Matrix();
                        matrix.postRotate(180);
                        Bitmap rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.getWidth(), bitmap.getHeight(), matrix, true);
                        if (rotated != bitmap) {
                            bitmap.recycle();
                            bitmap = rotated;
                        }
                    } catch (Throwable ignored) {}
                }

                if (bitmap.getWidth() > 120 || bitmap.getHeight() > 120) {
                    int bw = bitmap.getWidth();
                    int bh = bitmap.getHeight();
                    int scaledW, scaledH;
                    if (bw >= bh) {
                        scaledW = 120;
                        scaledH = Math.max(1, (bh * 120) / bw);
                    } else {
                        scaledH = 120;
                        scaledW = Math.max(1, (bw * 120) / bh);
                    }
                    try {
                        Bitmap scaled = Bitmap.createScaledBitmap(bitmap, scaledW, scaledH, true);
                        if (scaled != bitmap) {
                            bitmap.recycle();
                            bitmap = scaled;
                        }
                    } catch (Throwable ignored) {}
                }
            }
            return bitmap;
        }

        @JavascriptInterface
        public String getVideoThumbnail(String rawPath) {
            try {
                if (rawPath == null || rawPath.isEmpty()) return null;
                Bitmap bitmap = null;

                if (rawPath.startsWith("content://")) {
                    Uri contentUri = Uri.parse(rawPath);
                    MediaMetadataRetriever retriever = new MediaMetadataRetriever();
                    try {
                        retriever.setDataSource(getApplicationContext(), contentUri);
                        bitmap = extractBestFrame(retriever);
                    } catch (Throwable ignored) {
                        bitmap = null;
                    } finally {
                        try { retriever.release(); } catch (Throwable ignored) {}
                    }

                    if (bitmap == null && android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
                        try {
                            bitmap = getApplicationContext().getContentResolver().loadThumbnail(
                                contentUri, new Size(120, 120), null);
                        } catch (Throwable ignored) {}
                    }
                } else {
                    String cleanPath = rawPath;
                    if (cleanPath.startsWith("file://")) {
                        cleanPath = cleanPath.substring(7);
                    }
                    cleanPath = URLDecoder.decode(cleanPath, "UTF-8");
                    File f = new File(cleanPath);
                    if (!f.isAbsolute()) {
                        f = new File(Environment.getExternalStorageDirectory(), cleanPath.replaceFirst("^/+", ""));
                    }
                    if (!f.exists()) {
                        File d1 = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), cleanPath.replaceFirst("^/+", ""));
                        if (d1.exists()) f = d1;
                    }
                    if (!f.exists()) {
                        File d2 = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MOVIES), cleanPath.replaceFirst("^/+", ""));
                        if (d2.exists()) f = d2;
                    }
                    if (!f.exists()) {
                        File d3 = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), cleanPath.replaceFirst("^/+", ""));
                        if (d3.exists()) f = d3;
                    }

                    if (f.exists()) {
                        MediaMetadataRetriever retriever = new MediaMetadataRetriever();
                        try {
                            retriever.setDataSource(f.getAbsolutePath());
                            bitmap = extractBestFrame(retriever);
                        } catch (Throwable ignored) {
                            bitmap = null;
                        } finally {
                            try { retriever.release(); } catch (Throwable ignored) {}
                        }

                        if (bitmap == null) {
                            try {
                                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
                                    bitmap = ThumbnailUtils.createVideoThumbnail(f, new Size(120, 120), null);
                                } else {
                                    bitmap = ThumbnailUtils.createVideoThumbnail(f.getAbsolutePath(), MediaStore.Images.Thumbnails.MICRO_KIND);
                                }
                            } catch (Throwable ignored) {
                                bitmap = null;
                            }
                        }
                    }
                }

                if (bitmap != null) {
                    if (bitmap.getWidth() > 120 || bitmap.getHeight() > 120) {
                        float scale = 120.0f / Math.max(bitmap.getWidth(), bitmap.getHeight());
                        int sw = Math.max(1, Math.round(bitmap.getWidth() * scale));
                        int sh = Math.max(1, Math.round(bitmap.getHeight() * scale));
                        Bitmap scaled = Bitmap.createScaledBitmap(bitmap, sw, sh, true);
                        if (scaled != bitmap) {
                            bitmap.recycle();
                            bitmap = scaled;
                        }
                    }
                    ByteArrayOutputStream baos = new ByteArrayOutputStream();
                    bitmap.compress(Bitmap.CompressFormat.JPEG, 60, baos);
                    byte[] bytes = baos.toByteArray();
                    bitmap.recycle();
                    return "data:image/jpeg;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP);
                }
            } catch (Exception e) {
                e.printStackTrace();
            }
            return null;
        }

        @JavascriptInterface
        public boolean openFile(String rawPath) {
            try {
                if (rawPath == null || rawPath.isEmpty()) return false;
                String cleanPath = rawPath;
                if (cleanPath.startsWith("file://")) {
                    cleanPath = cleanPath.substring(7);
                }
                cleanPath = URLDecoder.decode(cleanPath, "UTF-8");
                File f = new File(cleanPath);
                if (!f.isAbsolute()) {
                    f = new File(Environment.getExternalStorageDirectory(), cleanPath.replaceFirst("^/+", ""));
                }
                if (!f.exists()) {
                    File d1 = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), cleanPath.replaceFirst("^/+", ""));
                    if (d1.exists()) f = d1;
                }
                if (!f.exists()) {
                    File d2 = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MOVIES), cleanPath.replaceFirst("^/+", ""));
                    if (d2.exists()) f = d2;
                }
                if (!f.exists()) {
                    File d3 = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), cleanPath.replaceFirst("^/+", ""));
                    if (d3.exists()) f = d3;
                }
                if (f.exists()) {
                    Uri fileUri;
                    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.N) {
                        fileUri = FileProvider.getUriForFile(
                            MainActivity.this,
                            getApplicationContext().getPackageName() + ".fileprovider",
                            f
                        );
                    } else {
                        fileUri = Uri.fromFile(f);
                    }
                    String mime = null;
                    String name = f.getName().toLowerCase();
                    int dot = name.lastIndexOf('.');
                    if (dot > 0 && dot < name.length() - 1) {
                        mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substring(dot + 1));
                    }
                    if (mime == null) {
                        if (name.endsWith(".mp4") || name.endsWith(".mov") || name.endsWith(".webm") || name.endsWith(".mkv")) mime = "video/mp4";
                        else if (name.endsWith(".mp3") || name.endsWith(".m4a")) mime = "audio/mpeg";
                        else if (name.endsWith(".jpg") || name.endsWith(".jpeg") || name.endsWith(".png") || name.endsWith(".webp")) mime = "image/jpeg";
                        else mime = "*/*";
                    }
                    Intent intent = new Intent(Intent.ACTION_VIEW);
                    intent.setDataAndType(fileUri, mime);
                    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(intent);
                    return true;
                }
            } catch (Exception e) {
                e.printStackTrace();
            }
            return false;
        }
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        WebView webView = getBridge().getWebView();
        if (webView != null) {
            webView.addJavascriptInterface(new MoriMainBridge(), "MoriMainBridge");
            WebSettings settings = webView.getSettings();
            settings.setAllowFileAccess(true);
            settings.setAllowContentAccess(true);
            settings.setAllowFileAccessFromFileURLs(true);
            settings.setAllowUniversalAccessFromFileURLs(true);
            settings.setMediaPlaybackRequiresUserGesture(false);
            // Mori already has its own Small / Medium / Large text-size setting.
            // Keep WebView at 100% so Android's system font scale is not applied a second time.
            settings.setTextZoom(100);

            webView.setWebViewClient(new BridgeWebViewClient(getBridge()) {
                @Override
                public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                    String url = request.getUrl().toString();
                    if (url.startsWith("whatsapp://") || url.contains("wa.me") || url.contains("api.whatsapp.com")) {
                        try {
                            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                            startActivity(intent);
                            return true;
                        } catch (Exception e) {
                            return super.shouldOverrideUrlLoading(view, request);
                        }
                    }
                    return super.shouldOverrideUrlLoading(view, request);
                }

                @Override
                public boolean shouldOverrideUrlLoading(WebView view, String url) {
                    if (url != null && (url.startsWith("whatsapp://") || url.contains("wa.me") || url.contains("api.whatsapp.com"))) {
                        try {
                            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                            startActivity(intent);
                            return true;
                        } catch (Exception e) {
                            return super.shouldOverrideUrlLoading(view, url);
                        }
                    }
                    return super.shouldOverrideUrlLoading(view, url);
                }
            });
        }

        handleIntent(getIntent());
        requestNotificationPermission();
    }

    private void requestNotificationPermission() {
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 101);
            }
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().postDelayed(new Runnable() {
                @Override
                public void run() {
                    getBridge().getWebView().evaluateJavascript(
                        "if (typeof window.checkAndMergePendingHistory === 'function') window.checkAndMergePendingHistory();", null);
                }
            }, 300);
        }
    }

    private void handleIntent(Intent intent) {
        String action = intent.getAction();
        String type = intent.getType();

        if (Intent.ACTION_SEND.equals(action) && type != null) {
            if ("text/plain".equals(type)) {
                String sharedText = intent.getStringExtra(Intent.EXTRA_TEXT);
                if (sharedText != null) {
                    final String escapedText = sharedText.replace("'", "\\'").replace("\"", "\\\"").replace("\n", " ");
                    getBridge().getWebView().postDelayed(new Runnable() {
                        @Override
                        public void run() {
                            getBridge().getWebView().evaluateJavascript("window.moriShareText = '" + escapedText + "';", null);
                            getBridge().triggerWindowJSEvent("moriShareIntent", "{ \"text\": \"" + escapedText + "\" }");
                        }
                    }, 1000);
                }
            }
        }
    }
}
