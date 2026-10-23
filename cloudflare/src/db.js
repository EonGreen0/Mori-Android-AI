const ENTITY_TYPES = new Set(["project", "node", "edge", "asset"]);
const OPERATIONS = new Set(["upsert", "delete"]);

function jsonString(value) {
  return JSON.stringify(value ?? null);
}

function parseJson(value, fallback = null) {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function asRevision(value) {
  const revision = Number(value);
  return Number.isInteger(revision) && revision >= 0 ? revision : 0;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

async function mutationHash(mutation) {
  const identity = [
    mutation.projectId,
    mutation.entityType,
    mutation.entityId,
    mutation.operation,
    mutation.payload,
    mutation.baseRevision,
    mutation.deviceId,
  ];
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalValue(identity)));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function normalizeMutation(projectId, mutation) {
  const opId = String(mutation?.opId || "").trim();
  const entityType = String(mutation?.entityType || "").trim();
  const entityId = String(mutation?.entityId || "").trim();
  const operation = String(mutation?.operation || "").trim();
  const payload = operation === "delete" ? null : mutation?.payload ?? null;
  if (!opId || !entityId || !ENTITY_TYPES.has(entityType) || !OPERATIONS.has(operation)) {
    throw new Error("invalid_mutation");
  }
  if (String(mutation?.projectId || projectId) !== projectId) {
    throw new Error("project_mismatch");
  }
  if (entityType === "project" && entityId !== projectId) throw new Error("invalid_mutation");
  if (operation === "upsert" && (!payload || typeof payload !== "object" || Array.isArray(payload))) {
    throw new Error("invalid_mutation");
  }
  if (entityType === "asset" && operation === "upsert") {
    const sha256 = /^sha256:[a-f0-9]{64}$/;
    if (
      !sha256.test(entityId) ||
      payload.id !== entityId ||
      payload?.source?.hash !== entityId ||
      !sha256.test(String(payload?.display?.hash || ""))
    ) {
      throw new Error("invalid_asset");
    }
  }
  return {
    opId,
    projectId,
    entityType,
    entityId,
    operation,
    payload,
    baseRevision: asRevision(mutation?.baseRevision),
    deviceId: String(mutation?.deviceId || ""),
  };
}

async function getReceipt(db, opId) {
  return db.prepare(
    `SELECT op_id, project_id, entity_type, entity_id, operation, status, revision, mutation_hash
       FROM mutation_receipts
      WHERE op_id = ?`,
  ).bind(opId).first();
}

function receiptMatches(receipt, mutation) {
  return Boolean(
    receipt &&
    receipt.project_id === mutation.projectId &&
    receipt.entity_type === mutation.entityType &&
    receipt.entity_id === mutation.entityId &&
    receipt.operation === mutation.operation &&
    receipt.mutation_hash === mutation.mutationHash
  );
}

async function getCurrentEntity(db, mutation) {
  if (mutation.entityType === "project") {
    return db.prepare(
      `SELECT revision, deleted_at
         FROM projects
        WHERE project_id = ?`,
    ).bind(mutation.projectId).first();
  }
  return db.prepare(
    `SELECT revision, deleted_at
       FROM entities
      WHERE project_id = ? AND entity_type = ? AND entity_id = ?`,
  ).bind(mutation.projectId, mutation.entityType, mutation.entityId).first();
}

async function recordSupersededReceipt(db, mutation, revision, now) {
  await db.prepare(
    `INSERT OR IGNORE INTO mutation_receipts
      (op_id, project_id, entity_type, entity_id, operation, status, revision, mutation_hash, created_at)
     VALUES (?, ?, ?, ?, ?, 'superseded', ?, ?, ?)`,
  ).bind(
    mutation.opId,
    mutation.projectId,
    mutation.entityType,
    mutation.entityId,
    mutation.operation,
    asRevision(revision),
    mutation.mutationHash,
    now,
  ).run();
  return getReceipt(db, mutation.opId);
}

function ensureProjectStatement(db, mutation, now) {
  const initialPayload = mutation.entityType === "project" && mutation.operation === "upsert"
    ? jsonString(mutation.payload)
    : jsonString({ id: mutation.projectId, title: "" });
  return db.prepare(
    `INSERT INTO projects
      (project_id, payload_json, revision, deleted_at, created_at, updated_at)
     VALUES (?, ?, 0, NULL, ?, ?)
     ON CONFLICT(project_id) DO NOTHING`,
  ).bind(mutation.projectId, initialPayload, now, now);
}

function applyProjectStatements(db, mutation, now) {
  const deletedAt = mutation.operation === "delete" ? now : null;
  const payloadJson = mutation.operation === "delete" ? null : jsonString(mutation.payload);
  return [
    ensureProjectStatement(db, mutation, now),
    db.prepare(
      `UPDATE projects
          SET revision = revision + 1,
              payload_json = COALESCE(?, payload_json),
              deleted_at = ?,
              updated_at = ?
        WHERE project_id = ?
          AND COALESCE((SELECT MAX(revision) FROM change_log
                         WHERE project_id = ? AND entity_type = 'project'), 0) = ?`,
    ).bind(payloadJson, deletedAt, now, mutation.projectId, mutation.projectId, mutation.baseRevision),
    db.prepare(
      `INSERT INTO change_log
        (project_id, revision, entity_type, entity_id, operation, payload_json,
         device_id, op_id, server_timestamp, deleted_at)
       SELECT project_id, revision, 'project', ?, ?, ?, ?, ?, ?, ?
         FROM projects
        WHERE project_id = ? AND changes() = 1`,
    ).bind(
      mutation.entityId,
      mutation.operation,
      payloadJson,
      mutation.deviceId,
      mutation.opId,
      now,
      deletedAt,
      mutation.projectId,
    ),
    db.prepare(
      `INSERT INTO mutation_receipts
        (op_id, project_id, entity_type, entity_id, operation, status, revision, mutation_hash, created_at)
       SELECT ?, project_id, 'project', ?, ?, 'applied', revision, ?, ?
         FROM projects
        WHERE project_id = ? AND changes() = 1`,
    ).bind(mutation.opId, mutation.entityId, mutation.operation, mutation.mutationHash, now, mutation.projectId),
  ];
}

function applyEntityStatements(db, mutation, now) {
  const deletedAt = mutation.operation === "delete" ? now : null;
  const payloadJson = mutation.operation === "delete" ? null : jsonString(mutation.payload);
  return [
    ensureProjectStatement(db, mutation, now),
    db.prepare(
      `UPDATE projects
          SET revision = revision + 1,
              updated_at = ?
        WHERE project_id = ?
          AND COALESCE((SELECT revision FROM entities
                         WHERE project_id = ? AND entity_type = ? AND entity_id = ?), 0) = ?`,
    ).bind(now, mutation.projectId, mutation.projectId, mutation.entityType, mutation.entityId, mutation.baseRevision),
    db.prepare(
      `INSERT INTO entities
        (project_id, entity_type, entity_id, payload_json, revision, deleted_at, updated_at)
       SELECT ?, ?, ?, ?, revision, ?, ?
         FROM projects
        WHERE project_id = ? AND changes() = 1
       ON CONFLICT(project_id, entity_type, entity_id) DO UPDATE SET
         payload_json = excluded.payload_json,
         revision = excluded.revision,
         deleted_at = excluded.deleted_at,
         updated_at = excluded.updated_at`,
    ).bind(
      mutation.projectId,
      mutation.entityType,
      mutation.entityId,
      payloadJson,
      deletedAt,
      now,
      mutation.projectId,
    ),
    db.prepare(
      `INSERT INTO change_log
        (project_id, revision, entity_type, entity_id, operation, payload_json,
         device_id, op_id, server_timestamp, deleted_at)
       SELECT project_id, revision, ?, ?, ?, ?, ?, ?, ?, ?
         FROM projects
        WHERE project_id = ? AND changes() = 1`,
    ).bind(
      mutation.entityType,
      mutation.entityId,
      mutation.operation,
      payloadJson,
      mutation.deviceId,
      mutation.opId,
      now,
      deletedAt,
      mutation.projectId,
    ),
    db.prepare(
      `INSERT INTO mutation_receipts
        (op_id, project_id, entity_type, entity_id, operation, status, revision, mutation_hash, created_at)
       SELECT ?, project_id, ?, ?, ?, 'applied', revision, ?, ?
         FROM projects
        WHERE project_id = ? AND changes() = 1`,
    ).bind(
      mutation.opId,
      mutation.entityType,
      mutation.entityId,
      mutation.operation,
      mutation.mutationHash,
      now,
      mutation.projectId,
    ),
  ];
}

export async function applyMutation(db, projectId, rawMutation, now = Date.now()) {
  const mutation = normalizeMutation(projectId, rawMutation);
  mutation.mutationHash = await mutationHash(mutation);
  const existing = await getReceipt(db, mutation.opId);
  if (existing) {
    if (!receiptMatches(existing, mutation)) throw new Error("op_id_conflict");
    return { opId: mutation.opId, revision: asRevision(existing.revision), status: existing.status };
  }

  const current = await getCurrentEntity(db, mutation);
  if (current?.deleted_at != null) {
    const receipt = await recordSupersededReceipt(db, mutation, current.revision, now);
    if (!receiptMatches(receipt, mutation)) throw new Error("op_id_conflict");
    return {
      opId: mutation.opId,
      revision: asRevision(receipt?.revision ?? current.revision),
      status: String(receipt?.status || "superseded"),
    };
  }

  const statements = mutation.entityType === "project"
    ? applyProjectStatements(db, mutation, now)
    : applyEntityStatements(db, mutation, now);

  try {
    await db.batch(statements);
  } catch (error) {
    // A concurrent retry may have won the op_id UNIQUE race. If so, the whole
    // losing batch was rolled back and the existing receipt is authoritative.
    const racedReceipt = await getReceipt(db, mutation.opId);
    if (racedReceipt) {
      if (!receiptMatches(racedReceipt, mutation)) throw new Error("op_id_conflict");
      return {
        opId: mutation.opId,
        revision: asRevision(racedReceipt.revision),
        status: racedReceipt.status,
      };
    }
    // DELETE may have committed between the earlier read and this batch.
    // The database guard rolls back the attempted resurrection atomically.
    if (mutation.entityType !== "project" && mutation.operation === "upsert") {
      const currentAfterFailure = await getCurrentEntity(db, mutation);
      if (currentAfterFailure?.deleted_at != null) {
        const receipt = await recordSupersededReceipt(db, mutation, currentAfterFailure.revision, now);
        if (!receiptMatches(receipt, mutation)) throw new Error("op_id_conflict");
        return {
          opId: mutation.opId,
          revision: asRevision(receipt.revision),
          status: receipt.status,
        };
      }
    }
    throw error;
  }

  const receipt = await getReceipt(db, mutation.opId);
  // Every dependent write is conditional on the preceding write's changes().
  // A stale expected revision leaves entity/log/receipt untouched within the
  // same D1 batch, including when another writer wins after our initial read.
  if (!receipt) throw new Error("revision_conflict");
  return { opId: mutation.opId, revision: asRevision(receipt.revision), status: receipt.status };
}

export async function applyMutationBatch(db, projectId, rawMutations, options = {}) {
  const mutations = Array.isArray(rawMutations) ? rawMutations.slice(0, 200) : [];
  const acknowledgedOpIds = [];
  const receipts = [];
  const rejected = [];

  for (const rawMutation of mutations) {
    try {
      const receipt = await applyMutation(db, projectId, rawMutation, options.now?.() ?? Date.now());
      acknowledgedOpIds.push(receipt.opId);
      receipts.push(receipt);
    } catch (error) {
      const code = String(error?.message || "mutation_failed");
      if (["invalid_mutation", "invalid_asset", "project_mismatch", "op_id_conflict", "revision_conflict"].includes(code)) {
        const messages = {
          invalid_mutation: "Mutation shape is invalid",
          invalid_asset: "Asset identity or display hash is invalid",
          project_mismatch: "Mutation project does not match route",
          op_id_conflict: "opId is already bound to a different mutation",
          revision_conflict: "Entity changed on another device; pull and merge before retrying",
        };
        rejected.push({
          opId: String(rawMutation?.opId || ""),
          code,
          message: messages[code] || code,
          retryable: code === "revision_conflict",
        });
        continue;
      }
      throw error;
    }
  }

  const project = await db.prepare(
    `SELECT revision FROM projects WHERE project_id = ?`,
  ).bind(projectId).first();

  return {
    acknowledgedOpIds,
    rejected,
    receipts,
    cursor: String(asRevision(project?.revision)),
  };
}

export async function listProjects(db, limit = 100) {
  const pageSize = Math.max(1, Math.min(200, Number(limit) || 100));
  const rows = await db.prepare(
    `SELECT project_id, payload_json, revision, updated_at
       FROM projects
      WHERE deleted_at IS NULL AND archived_at IS NULL
      ORDER BY updated_at DESC
      LIMIT ?`,
  ).bind(pageSize).all();
  return {
    projects: (rows?.results || []).map((row) => {
      const payload = parseJson(row.payload_json, {});
      return {
        projectId: String(row.project_id || ""),
        title: String(payload?.title || ""),
        revision: asRevision(row.revision),
        updatedAt: Number(row.updated_at) || 0,
      };
    }).filter((project) => project.projectId),
  };
}

export async function pullChanges(db, projectId, cursor, limit = 200) {
  const afterRevision = Math.max(0, asRevision(cursor));
  const pageSize = Math.max(1, Math.min(500, Number(limit) || 200));
  const rows = await db.prepare(
    `SELECT revision, entity_type, entity_id, operation, payload_json,
            device_id, server_timestamp, deleted_at
       FROM change_log
      WHERE project_id = ? AND revision > ?
      ORDER BY revision ASC
      LIMIT ?`,
  ).bind(projectId, afterRevision, pageSize).all();

  const changes = (rows?.results || []).map((row) => ({
    projectId,
    revision: asRevision(row.revision),
    entityType: row.entity_type,
    entityId: row.entity_id,
    operation: row.operation,
    payload: row.operation === "delete" ? null : parseJson(row.payload_json, null),
    deviceId: String(row.device_id || ""),
    serverTimestamp: Number(row.server_timestamp) || 0,
    deletedAt: row.deleted_at == null ? null : Number(row.deleted_at),
  }));
  const nextCursor = changes.length ? String(changes[changes.length - 1].revision) : String(afterRevision);

  return {
    changes,
    cursor: nextCursor,
    hasMore: changes.length === pageSize,
  };
}

export async function findAssetMetadata(db, assetId) {
  const row = await db.prepare(
    `SELECT payload_json, revision
       FROM entities
      WHERE entity_type = 'asset' AND entity_id = ? AND deleted_at IS NULL
      ORDER BY revision DESC
      LIMIT 1`,
  ).bind(assetId).first();
  const asset = parseJson(row?.payload_json, null);
  return asset ? { asset, revision: asRevision(row?.revision) } : null;
}
