# Security Policy

## Secrets

Never include the following in commits, issues, screenshots, or logs:

- AI API keys
- Cloudflare API tokens
- `MORI_SYNC_TOKEN`
- Android signing passwords or keystores
- personal media, album packages, or Planner data

AI API keys are encrypted with Android Keystore. Sync tokens and signing material are intentionally excluded from this repository.

## AI endpoint boundary

The Android native bridge:

- requires HTTPS on port 443;
- binds the API key to the host authorized when it was saved;
- rejects requests to a different host;
- rejects private and local network targets;
- disables redirects;
- limits the number of images and request body size.

## Reporting

For a security issue, contact the repository owner privately. Do not open a public issue containing credentials or private user data.
