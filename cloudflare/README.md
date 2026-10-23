# Mori Sync Cloudflare Backend

This folder contains the backend implementation for the Planner sync transport.
It is intentionally separate from Planner UI code so Cloudflare remains a replaceable transport implementation.

## Runtime bindings

The Worker expects:

- `DB` — Cloudflare D1 database.
- `ASSETS` — Cloudflare R2 bucket containing display/preview assets.
- `MORI_SYNC_TOKEN` — Worker secret used as a personal bearer token.
- `MORI_MAX_DISPLAY_BYTES` — optional preview upload limit; defaults to 12 MiB.
- `ALLOW_INSECURE_LOCAL` — local-development escape hatch only. Never enable in production.

`wrangler.example.toml` is a template only. Do not commit real resource IDs, tokens, or `.dev.vars` secrets.

## API

### Mutation push

`POST /v1/projects/:projectId/mutations`

Body:

```json
{
  "deviceId": "device_x",
  "mutations": []
}
```

Every mutation uses a globally unique `opId`. `mutation_receipts.op_id` is the idempotency boundary. Each receipt also stores a canonical request hash, so reusing an `opId` with different content is rejected. Retrying an already-applied `opId` with the same content returns acknowledgement without creating another project revision. Receipts created before migration `0002_mutation_hash.sql` lack that hash and are rejected on retry rather than acknowledged without verification.

Server rules:

- project revision increases monotonically for applied mutations;
- node/edge/asset current state is stored in `entities`;
- every applied mutation produces exactly one `change_log` revision;
- a database trigger prevents a tombstoned entity ID from being resurrected by a later UPSERT using the same ID, including concurrent DELETE/UPSERT races;
- such stale UPSERTs are recorded as `superseded` receipts and acknowledged without creating a new revision;
- reusing an `opId` for a different mutation is rejected.

### Change pull

`GET /v1/projects/:projectId/changes?cursor=<revision>&limit=200`

The cursor is currently the last applied project revision encoded as a decimal string. Clients must treat it as opaque and only persist it after local merge succeeds.

### Asset state

`POST /v1/assets/states`

Body:

```json
{ "assetIds": ["sha256:..."] }
```

Metadata presence comes from synced Asset entities in D1. Display presence comes from `R2.head()`.

### Display upload/download

- `PUT /v1/assets/:assetId/display`
- `GET /v1/assets/:assetId/display`

The upload route requires `X-Mori-Display-Hash`. The Worker recomputes SHA-256 before writing to R2. R2 keys are content-addressed from the display hash, so identical previews are naturally deduplicated.

Original media upload is intentionally not implemented yet.

## D1 schema

`migrations/0001_sync_core.sql` creates:

- `projects` — project payload and monotonically increasing revision;
- `entities` — current node/edge/asset state plus tombstones;
- `mutation_receipts` — idempotency receipts keyed by `op_id`;
- `change_log` — ordered project changes consumed by pull cursors.

A single applied mutation is written with one D1 `batch()` transaction: ensure project, increment revision, update current state, append change log, then insert the idempotency receipt. If the receipt UNIQUE constraint loses a concurrent retry race, D1 rolls the losing batch back and the Worker reads the winning receipt instead.

## Authentication

Production requests require:

```text
Authorization: Bearer <MORI_SYNC_TOKEN>
```

The token belongs in a Worker secret and in platform secure storage on clients. The client `CloudflareTransport` accepts a `getAccessToken()` callback so it never needs to read a token from localStorage.

## Deployment boundary

This folder is deployable code, but this branch does not create Cloudflare resources or upload user data. Resource creation, secret configuration, migrations, and production deployment are a separate explicit step.
