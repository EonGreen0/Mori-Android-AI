use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticatedRequest {
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body_base64: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticatedResponse {
    status: u16,
    headers: HashMap<String, String>,
    body_base64: String,
}

pub async fn send(request: AuthenticatedRequest) -> Result<AuthenticatedResponse, String> {
    #[cfg(target_os = "windows")]
    {
        use base64::Engine;
        use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION};
        const ORIGIN: &str = "https://mori-sync-gateway-test.pages.dev";
        const MAX_BYTES: usize = 16 * 1024 * 1024;

        let url = reqwest::Url::parse(&request.url).map_err(|_| "Invalid sync URL")?;
        if url.origin().ascii_serialization() != ORIGIN
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || !url.path().starts_with("/v1/")
        {
            return Err("Sync request destination is not allowed".into());
        }
        let method = match request.method.as_str() {
            "GET" => reqwest::Method::GET,
            "POST" => reqwest::Method::POST,
            "PUT" => reqwest::Method::PUT,
            _ => return Err("Sync request method is not allowed".into()),
        };
        let body = base64::engine::general_purpose::STANDARD
            .decode(&request.body_base64)
            .map_err(|_| "Invalid sync request body")?;
        if body.len() > MAX_BYTES || request.body_base64.len() > 4 * MAX_BYTES / 3 + 4 {
            return Err("Sync request body is too large".into());
        }
        if method == reqwest::Method::GET && !body.is_empty() {
            return Err("GET sync request must not have a body".into());
        }
        let mut headers = HeaderMap::new();
        for (name, value) in request.headers {
            if !matches!(name.to_ascii_lowercase().as_str(), "accept" | "content-type" | "x-mori-display-hash") {
                return Err("Sync request header is not allowed".into());
            }
            let name = HeaderName::from_bytes(name.as_bytes()).map_err(|_| "Invalid sync request header")?;
            let value = HeaderValue::from_str(&value).map_err(|_| "Invalid sync request header value")?;
            headers.insert(name, value);
        }
        let token = super::sync_test_credential::read_sync_token()?;
        let bearer = HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| "Invalid native sync credential")?;
        headers.insert(AUTHORIZATION, bearer);
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "Could not initialize native sync request")?;
        let response = client.request(method, url)
            .headers(headers)
            .body(body)
            .send()
            .await
            .map_err(|_| "Native sync request failed")?;
        if response.status().is_redirection() {
            return Err("Sync request redirect is not allowed".into());
        }
        let status = response.status().as_u16();
        let mut response_headers = HashMap::new();
        for name in ["content-type", "x-mori-display-ref", "x-mori-display-hash"] {
            if let Some(value) = response.headers().get(name).and_then(|value| value.to_str().ok()) {
                response_headers.insert(name.to_string(), value.to_string());
            }
        }
        if response.content_length().is_some_and(|length| length > MAX_BYTES as u64) {
            return Err("Sync response is too large".into());
        }
        let bytes = response.bytes().await.map_err(|_| "Could not read sync response")?;
        if bytes.len() > MAX_BYTES {
            return Err("Sync response is too large".into());
        }
        Ok(AuthenticatedResponse {
            status,
            headers: response_headers,
            body_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        })
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = request;
        Err("Native sync diagnostic is unavailable in this build".into())
    }
}
