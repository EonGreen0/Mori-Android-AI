# Mori Planner Sync

This folder contains the local-first synchronization layer for Planner.

## Boundaries

- Planner UI remains in `public/js/modules/planner.js`.
- Sync modules must not depend on Cloudflare-specific APIs.
- Device-local file references (`path`, `uri`, local thumbnails) must not enter shared state.
- A backend-neutral transport boundary exists, but no real Cloudflare/backend implementation is enabled yet.

## Modules

- `database.js` — owns the versioned `mori_sync_v1` IndexedDB schema and store upgrades.
- `model.js` — shared schema primitives and validation for project/node/edge/asset entities.
- `plannerAdapter.js` — split Planner Board into shared state + device-local state, and merge them back.
- `assetCatalog.js` — SHA-256 asset identity, source/display metadata, and 2048px-class display variant generation.
- `assetStore.js` — durable shared Asset metadata plus device-local asset bindings.
- `mutations.js` — diff two shared snapshots into project/node/edge/asset upsert/delete operations.
- `compaction.js` — safely coalesce repeated unsent operations before transport while respecting retry barriers.
- `device.js` — non-secret stable local device id.
- `outbox.js` — durable mutation queue, checkpoint metadata, sealing, retry/error state, and compacted transport-batch preparation.
- `remoteAssetState.js` — backend-specific local cache of metadata/display/original presence, keyed by transport + Asset.
- `transport.js` — backend-neutral capability contract and response normalization.
- `cloudflareTransport.js` — concrete HTTP transport for the Mori Cloudflare Worker; access tokens are supplied by callback rather than localStorage.
- `syncEngine.js` — sealed Outbox push lifecycle plus paged pull / merge / reconciliation orchestration.
- `remoteMerge.js` — durable remote-shadow application, three-way field merge, tombstones, conflict records, graph cleanup, and reconciliation mutation generation.
- `remoteMergeStore.js` — atomically commits remote shadow/cursor/local checkpoint/reconciliation Outbox after local Planner persistence succeeds.
- `assetTransfer.js` — display Asset state refresh, upload/download, and hash verification through a transport.
- `plannerJournal.js` — builds shared Planner snapshots, attaches referenced Asset metadata, stages local mutations, and advances the local checkpoint.

## Current integration

Planner staging is behind the local feature flag:

`mori_planner_sync_capture_v1 = "1"`

The flag is off by default. With the flag off, `saveBoard()` behaves as before and only saves the Planner Board to localStorage.

## Current shared/local split

Shared:

- project id/title
- project-level Planner content such as `importCount` and `commentFontSize`
- nodes and edges
- image `assetId` / portable `sha256:` file keys when available
- referenced Asset metadata: source hash/MIME/dimensions/byte size and display hash/MIME/dimensions/byte size

Device-local:

- viewport (`zoom`, `panX`, `panY`)
- `readOnly`
- image `path`, `uri`, `thumbnail`
- path-based `fileKey`
- Asset binding (`path`, `uri`, local thumbnail, local filename)

## Outbox compaction rules

- Repeated unattempted upserts for the same entity collapse to the latest payload.
- An upsert followed by a delete collapses to the final delete when the entity may already exist remotely.
- A locally-created entity that is also deleted before any send attempt may collapse to no network operation, but only when its base absence is known from an existing checkpoint.
- The first local snapshot uses an unknown base state; it does not assume the remote is empty.
- Any operation already sealed for transport or with `attempts > 0` is a hard compaction barrier because the server may receive, or may already have applied, that exact `opId` independently of newer edits.
- `preparePlannerOutboxBatch()` is read-only and returns compacted entries plus their raw `sourceOpIds`.
- Before network I/O, `sealPreparedPlannerOutboxBatch()` atomically replaces each compacted source chain with one durable representative record and removes safe local no-op chains.
- A sealed record keeps the representative `opId` stable across crashes, retries, and lost acknowledgements. Newer local edits cannot be compacted across it.

## Transport boundary

Transport implementations are backend-neutral. Planner and Outbox code must not contain Worker URLs, D1/R2 concepts, auth headers, local filesystem paths, or provider-specific object keys.

Current capabilities:

- `mutations` — push sealed mutations and explicitly acknowledge individual `opId` values.
- `changes` — fetch remote changes using an opaque cursor. The engine persists that cursor only after all fetched pages are merged and the resulting Planner state has been saved locally.
- `asset-state` — query remote metadata/display/original presence.
- `asset-display-upload` — upload verified display bytes.
- `asset-display-download` — retrieve display bytes, which are re-hashed before use.

Remote Asset state is keyed by `transportId + assetId`, so changing backend never changes the Asset's content identity.

## Transport lifecycle

1. Prepare a compacted batch from the durable Outbox.
2. Seal the batch in IndexedDB before any request leaves the device.
3. Mark the sealed `opId` as attempted immediately before sending.
4. Send that exact mutation to the server using `opId` for idempotency.
5. On acknowledgement, remove the sealed `opId` from the Outbox.
6. On timeout/crash/lost acknowledgement, leave it sealed and retry the same `opId` later.

## Remote merge lifecycle

Remote merge keeps a transport-specific `Remote Shadow`: the last server state that this device has successfully applied. Pull uses three inputs:

- `base` — previous durable Remote Shadow;
- `local` — current Planner shared snapshot;
- `remote` — Remote Shadow after applying newly pulled revisions.

Rules:

- Different fields changed on different devices merge automatically.
- If both sides changed the same field relative to the same base, the latest remote/server revision wins that field and a local conflict record is retained.
- Remote node/edge tombstones dominate stale local copies and remain in the Remote Shadow, preventing a later stale Planner snapshot from silently resurrecting deleted entities.
- A local delete wins when the remote entity is semantically unchanged from the base; a concurrent remote update wins and is recorded as a delete-vs-update conflict.
- Edges whose endpoints no longer exist are removed; group `memberIds` are pruned when members are deleted.
- If a merged state contains local fields that the latest server entity does not contain, reconciliation mutations are generated against the latest remote revision so the server and other devices converge to the merged result.
- Pull is blocked while this project still has pending Outbox operations. Ambiguous in-flight operations must be drained/resolved before a remote merge begins.
- After network pages return, Outbox is checked again. If a local edit arrived while Pull was in flight, the stale merge is abandoned without advancing the durable cursor.
- All available change pages are fetched before merge. `hasMore` without cursor advancement is treated as a transport error.
- The merged Planner is persisted first. Only after that succeeds are Remote Shadow, cursor, local checkpoint, shared Asset metadata, and reconciliation mutations committed atomically in IndexedDB.
- Conflict records are retained as a rolling local history (currently the most recent 50), rather than disappearing after the next conflict-free Pull.
- Remote project deletion is intentionally not enabled yet because the current single-project Planner UI has no safe delete/restore UX.

Planner exposes a narrow bridge for future sync orchestration: `getPlannerSyncSnapshot()` waits for queued local Journal staging and returns shared + device-local state plus a local generation token. `applyPlannerMergedSharedState()` accepts that token as `expectedGeneration`, refuses to overwrite the board if it changed while Pull was in flight, and writes a successful remote merge without re-capturing it as a fresh local Journal mutation.

## Asset lifecycle

- Asset identity is `sha256:<original-bytes-hash>` and remains stable even when the display copy is transcoded.
- `source` describes the original image; `display` describes the sync/viewing variant. Their hashes may differ.
- Large raster images are represented by a display WebP capped by the configured maximum side (currently 2048px in normal Planner packaging).
- Shared Asset records never contain filesystem paths.
- `assetBindings` are device-local and map the shared `assetId` to this device's `path` / `uri` / local thumbnail.
- Importing an external Planner image catalogs it immediately. Exporting a `.mori` package also backfills Asset records for older image nodes.
- `.mori` v1 stays compatible: legacy manifest fields remain, while new `source` and `display` metadata are additive.

## Current runtime verification

Desktop Chromium now exercises the real IndexedDB stores through fake in-memory transports and verifies:

- partial acknowledgements only remove confirmed operations;
- rejected/offline operations remain durable and retry with the same sealed `opId`;
- failed local Planner persistence does not advance Remote Shadow or cursor;
- different-field concurrent edits merge and create exactly the reconciliation mutation needed to converge the server;
- a pending Outbox blocks pull before the transport is contacted;
- a local edit that arrives during an in-flight Pull aborts the stale merge and leaves the durable cursor unchanged;
- same-field conflicts converge deterministically to the latest remote revision and are stored locally;
- remote tombstones delete local entities and continue blocking stale resurrection on later pulls;
- paged remote pulls can advance an opaque cursor only after successful merge/application;
- Asset state transitions from missing → uploaded → present, then downloads with SHA-256 verification;
- IndexedDB upgrades through v3 and keeps backend-specific remote state separate from local filesystem bindings.

## Cloudflare implementation status

A concrete `CloudflareTransport` now implements the backend-neutral client contract, and `/cloudflare` contains the matching Worker + D1 migration + R2 display-asset implementation.

Current server invariants:

- applied mutations increment one monotonic per-project revision and append one `change_log` row;
- immutable `opId` receipts make retries idempotent;
- reusing an `opId` for different mutation identity is rejected;
- tombstoned entity IDs cannot be resurrected by later UPSERTs using the same ID;
- stale/repeated operations against a tombstone are acknowledged as `superseded` without consuming another revision;
- R2 display objects are content-addressed from `display.hash` and uploads are re-hashed before storage;
- Worker authentication uses a bearer token supplied from client secure storage through `getAccessToken()`; secrets are not stored by the transport.

Real Cloudflare resources have not been created and no production deployment or user-data upload has happened yet.

## Next steps

1. Add a platform display-byte provider so Asset transfer can regenerate/read previews from Windows and Android bindings without provider code knowing local paths.
2. Add device pairing/auth credentials without placing secrets in localStorage.
3. Run the IndexedDB/transport/remote-merge suite inside the Android WebView, not only desktop Chromium.
4. Create real D1/R2/Worker resources, apply migrations, configure `MORI_SYNC_TOKEN`, and deploy the tested backend.
5. Run Windows ↔ Android end-to-end sync against the real Worker before enabling Android edits by default.
6. Keep original-file cloud upload opt-in; this backend currently handles Planner display assets only.
