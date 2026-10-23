import { cloneJson, createSyncEnvelope, isPlainObject, validateSyncEnvelope } from "./model.js";
import {
  createPlannerMutation,
  PLANNER_MUTATION_OPERATIONS,
  syncValuesEqual,
} from "./mutations.js";

export const PLANNER_REMOTE_SHADOW_VERSION = 1;

const SUPPORTED_ENTITY_TYPES = new Set(["project", "node", "edge", "asset"]);
const COLLECTION_NAMES = Object.freeze({
  node: "nodes",
  edge: "edges",
  asset: "assets",
});
const MISSING = Symbol("mori-sync-missing");

function isMissing(value) {
  return value === MISSING;
}

function cloneMaybe(value) {
  return isMissing(value) ? MISSING : cloneJson(value);
}

function conflictValue(value) {
  if (isMissing(value)) return { present: false };
  return { present: true, value: cloneJson(value) };
}

function equalMaybe(left, right) {
  if (isMissing(left) || isMissing(right)) return left === right;
  return syncValuesEqual(left, right);
}

function normalizeRevisionStrict(value) {
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision <= 0) {
    throw new Error(`Remote change requires a positive integer revision: ${String(value)}`);
  }
  return revision;
}

function normalizeRemoteChange(change, projectId) {
  const entityType = String(change?.entityType || "");
  const entityId = String(change?.entityId || "");
  const operation = String(change?.operation || "");
  const revision = normalizeRevisionStrict(change?.revision);

  if (!SUPPORTED_ENTITY_TYPES.has(entityType)) {
    throw new Error(`Unsupported remote entity type: ${entityType}`);
  }
  if (!entityId) throw new Error("Remote change requires entityId");
  if (![PLANNER_MUTATION_OPERATIONS.UPSERT, PLANNER_MUTATION_OPERATIONS.DELETE].includes(operation)) {
    throw new Error(`Unsupported remote operation: ${operation}`);
  }
  if (change?.projectId && String(change.projectId) !== projectId) {
    throw new Error(`Remote change belongs to another project: ${String(change.projectId)}`);
  }
  if (entityType === "project" && entityId !== projectId) {
    throw new Error("Remote project entity id must match projectId");
  }

  let payload = null;
  if (operation === PLANNER_MUTATION_OPERATIONS.UPSERT) {
    if (!isPlainObject(change?.payload)) throw new Error("Remote upsert requires an object payload");
    payload = cloneJson(change.payload);
    if (entityType === "project") {
      if (payload.id !== projectId) throw new Error("Remote project payload id must match projectId");
    } else if (payload.id !== entityId) {
      throw new Error(`Remote ${entityType} payload id must match entityId`);
    }
  }

  return {
    projectId,
    entityType,
    entityId,
    operation,
    revision,
    payload,
    serverTimestamp: Number(change?.serverTimestamp) || 0,
    deletedAt: change?.deletedAt ?? null,
    opId: String(change?.opId || ""),
    deviceId: String(change?.deviceId || ""),
  };
}

export function createPlannerRemoteShadow(projectId) {
  const id = String(projectId || "").trim();
  if (!id) throw new Error("Remote shadow requires projectId");
  return {
    version: PLANNER_REMOTE_SHADOW_VERSION,
    projectId: id,
    appliedRevision: 0,
    records: {
      project: null,
      nodes: {},
      edges: {},
      assets: {},
    },
  };
}

export function validatePlannerRemoteShadow(value, projectId = "") {
  const errors = [];
  if (!isPlainObject(value)) return { valid: false, errors: ["Remote shadow must be an object"] };
  if (value.version !== PLANNER_REMOTE_SHADOW_VERSION) {
    errors.push(`Unsupported remote shadow version: ${String(value.version)}`);
  }
  if (!value.projectId) errors.push("Remote shadow projectId is required");
  if (projectId && value.projectId !== projectId) errors.push("Remote shadow projectId mismatch");
  if (!isPlainObject(value.records)) errors.push("Remote shadow records are required");
  for (const name of ["nodes", "edges", "assets"]) {
    if (!isPlainObject(value.records?.[name])) errors.push(`Remote shadow ${name} map is required`);
  }
  return { valid: errors.length === 0, errors };
}

function getRecord(shadow, entityType, entityId) {
  if (entityType === "project") return shadow.records.project;
  return shadow.records[COLLECTION_NAMES[entityType]]?.[entityId] || null;
}

function setRecord(shadow, entityType, entityId, record) {
  if (entityType === "project") {
    shadow.records.project = record;
    return;
  }
  shadow.records[COLLECTION_NAMES[entityType]][entityId] = record;
}

function activeRecordValue(record) {
  return record && record.deleted !== true ? record.value : MISSING;
}

export function applyPlannerRemoteChanges(shadowInput, changes, options = {}) {
  const projectId = String(options.projectId || shadowInput?.projectId || "").trim();
  if (!projectId) throw new Error("Applying remote changes requires projectId");

  const base = shadowInput || createPlannerRemoteShadow(projectId);
  const validation = validatePlannerRemoteShadow(base, projectId);
  if (!validation.valid) {
    throw new Error(`Invalid remote shadow: ${validation.errors.join("; ")}`);
  }

  const shadow = cloneJson(base);
  const normalized = (Array.isArray(changes) ? changes : [])
    .map((change) => normalizeRemoteChange(change, projectId))
    .sort((left, right) => left.revision - right.revision);

  const seenRevisions = new Set();
  const applied = [];
  const ignored = [];

  for (const change of normalized) {
    if (seenRevisions.has(change.revision)) {
      throw new Error(`Duplicate remote revision in one pull: ${change.revision}`);
    }
    seenRevisions.add(change.revision);

    if (change.revision <= Number(shadow.appliedRevision || 0)) {
      ignored.push(change);
      continue;
    }

    const record = {
      entityType: change.entityType,
      entityId: change.entityId,
      revision: change.revision,
      deleted: change.operation === PLANNER_MUTATION_OPERATIONS.DELETE,
      deletedAt:
        change.operation === PLANNER_MUTATION_OPERATIONS.DELETE
          ? change.deletedAt ?? change.serverTimestamp ?? null
          : null,
      value:
        change.operation === PLANNER_MUTATION_OPERATIONS.UPSERT
          ? cloneJson(change.payload)
          : null,
      opId: change.opId,
      deviceId: change.deviceId,
      serverTimestamp: change.serverTimestamp,
    };

    setRecord(shadow, change.entityType, change.entityId, record);
    shadow.appliedRevision = change.revision;
    applied.push(change);
  }

  return { shadow, applied, ignored };
}

function activeCollection(shadow, entityType) {
  const records = shadow.records[COLLECTION_NAMES[entityType]] || {};
  return Object.values(records)
    .filter((record) => record && record.deleted !== true && record.value)
    .map((record) => cloneJson(record.value))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

export function materializePlannerRemoteShadow(shadow, { fallbackProject = null } = {}) {
  const validation = validatePlannerRemoteShadow(shadow);
  if (!validation.valid) {
    throw new Error(`Invalid remote shadow: ${validation.errors.join("; ")}`);
  }

  const projectRecord = shadow.records.project;
  if (projectRecord?.deleted) {
    throw new Error("Remote project deletion is not supported by the current Planner UI");
  }
  const project = projectRecord?.value || fallbackProject;
  if (!project) throw new Error("Remote shadow has no project metadata");

  return createSyncEnvelope({
    project,
    nodes: activeCollection(shadow, "node"),
    edges: activeCollection(shadow, "edge"),
    assets: activeCollection(shadow, "asset"),
  });
}

function mergeScalarOrObject(base, local, remote, context, path) {
  if (equalMaybe(local, remote)) return cloneMaybe(local);
  if (equalMaybe(local, base)) return cloneMaybe(remote);
  if (equalMaybe(remote, base)) return cloneMaybe(local);

  const localObject = !isMissing(local) && isPlainObject(local);
  const remoteObject = !isMissing(remote) && isPlainObject(remote);
  const baseObject = !isMissing(base) && isPlainObject(base);
  if (localObject && remoteObject && (baseObject || isMissing(base))) {
    const result = {};
    const keys = new Set([
      ...(baseObject ? Object.keys(base) : []),
      ...Object.keys(local),
      ...Object.keys(remote),
    ]);
    for (const key of keys) {
      const next = mergeScalarOrObject(
        baseObject && Object.prototype.hasOwnProperty.call(base, key) ? base[key] : MISSING,
        Object.prototype.hasOwnProperty.call(local, key) ? local[key] : MISSING,
        Object.prototype.hasOwnProperty.call(remote, key) ? remote[key] : MISSING,
        context,
        path ? `${path}.${key}` : key,
      );
      if (!isMissing(next)) result[key] = next;
    }
    return result;
  }

  context.conflicts.push({
    kind: "field-conflict",
    entityType: context.entityType,
    entityId: context.entityId,
    path: path || "<entity>",
    resolution: "remote",
    remoteRevision: Number(context.remoteRevision) || 0,
    base: conflictValue(base),
    local: conflictValue(local),
    remote: conflictValue(remote),
  });
  return cloneMaybe(remote);
}

function mapValuesById(items) {
  const map = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.id) map.set(item.id, item);
  }
  return map;
}

function mergeCollection(entityType, baseShadow, localItems, remoteShadow, conflicts) {
  const baseRecords = baseShadow.records[COLLECTION_NAMES[entityType]] || {};
  const remoteRecords = remoteShadow.records[COLLECTION_NAMES[entityType]] || {};
  const localMap = mapValuesById(localItems);
  const ids = new Set([...Object.keys(baseRecords), ...Object.keys(remoteRecords), ...localMap.keys()]);
  const result = [];

  for (const entityId of ids) {
    const baseRecord = baseRecords[entityId] || null;
    const remoteRecord = remoteRecords[entityId] || null;
    const baseValue = activeRecordValue(baseRecord);
    const localValue = localMap.has(entityId) ? localMap.get(entityId) : MISSING;

    if (!remoteRecord) {
      if (!isMissing(localValue)) result.push(cloneJson(localValue));
      continue;
    }

    if (remoteRecord.deleted) {
      if (!isMissing(localValue) && !equalMaybe(localValue, baseValue)) {
        conflicts.push({
          kind: "remote-delete",
          entityType,
          entityId,
          path: "<entity>",
          resolution: "remote-delete",
          remoteRevision: remoteRecord.revision,
          base: conflictValue(baseValue),
          local: conflictValue(localValue),
          remote: { present: false },
        });
      }
      continue;
    }

    const remoteValue = remoteRecord.value;
    if (isMissing(localValue)) {
      if (!isMissing(baseValue) && equalMaybe(remoteValue, baseValue)) {
        // Local deletion with no concurrent remote semantic change.
        continue;
      }
      if (!isMissing(baseValue)) {
        conflicts.push({
          kind: "delete-vs-update",
          entityType,
          entityId,
          path: "<entity>",
          resolution: "remote",
          remoteRevision: remoteRecord.revision,
          base: conflictValue(baseValue),
          local: { present: false },
          remote: conflictValue(remoteValue),
        });
      }
      result.push(cloneJson(remoteValue));
      continue;
    }

    const merged = mergeScalarOrObject(
      baseValue,
      localValue,
      remoteValue,
      {
        conflicts,
        entityType,
        entityId,
        remoteRevision: remoteRecord.revision,
      },
      "",
    );
    if (!isMissing(merged)) result.push(merged);
  }

  return result;
}

function sanitizeMergedGraph(nodes, edges, conflicts) {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const sanitizedNodes = nodes.map((node) => {
    if (node?.type !== "group" || !Array.isArray(node.memberIds)) return node;
    const memberIds = node.memberIds.filter((memberId) => nodeIds.has(memberId));
    if (memberIds.length === node.memberIds.length) return node;
    conflicts.push({
      kind: "group-membership-pruned",
      entityType: "node",
      entityId: node.id,
      path: "memberIds",
      resolution: "remove-missing-members",
      remoteRevision: 0,
      removedMemberIds: node.memberIds.filter((memberId) => !nodeIds.has(memberId)),
    });
    return { ...node, memberIds };
  });

  const sanitizedEdges = [];
  for (const edge of edges) {
    if (nodeIds.has(edge.from) && nodeIds.has(edge.to)) {
      sanitizedEdges.push(edge);
      continue;
    }
    conflicts.push({
      kind: "dangling-edge-pruned",
      entityType: "edge",
      entityId: edge.id,
      path: "<entity>",
      resolution: "delete",
      remoteRevision: 0,
      from: edge.from,
      to: edge.to,
    });
  }
  return { nodes: sanitizedNodes, edges: sanitizedEdges };
}

export function mergePlannerRemoteState({ baseShadow, localShared, remoteShadow } = {}) {
  const localValidation = validateSyncEnvelope(localShared);
  if (!localValidation.valid) {
    throw new Error(`Invalid local Planner sync envelope: ${localValidation.errors.join("; ")}`);
  }
  const projectId = localShared.project.id;
  for (const shadow of [baseShadow, remoteShadow]) {
    const validation = validatePlannerRemoteShadow(shadow, projectId);
    if (!validation.valid) throw new Error(`Invalid remote shadow: ${validation.errors.join("; ")}`);
  }
  if (remoteShadow.records.project?.deleted) {
    throw new Error("Remote project deletion is not supported by the current Planner UI");
  }

  const conflicts = [];
  const baseProject = activeRecordValue(baseShadow.records.project);
  const remoteProject = activeRecordValue(remoteShadow.records.project);
  const mergedProject = isMissing(remoteProject)
    ? cloneJson(localShared.project)
    : mergeScalarOrObject(
        baseProject,
        localShared.project,
        remoteProject,
        {
          conflicts,
          entityType: "project",
          entityId: projectId,
          remoteRevision: remoteShadow.records.project?.revision || 0,
        },
        "",
      );

  const mergedNodes = mergeCollection("node", baseShadow, localShared.nodes, remoteShadow, conflicts);
  const mergedEdges = mergeCollection("edge", baseShadow, localShared.edges, remoteShadow, conflicts);
  const mergedAssets = mergeCollection(
    "asset",
    baseShadow,
    localShared.assets || [],
    remoteShadow,
    conflicts,
  );
  const graph = sanitizeMergedGraph(mergedNodes, mergedEdges, conflicts);

  const merged = createSyncEnvelope({
    project: mergedProject,
    nodes: graph.nodes,
    edges: graph.edges,
    assets: mergedAssets,
  });

  return { merged, conflicts };
}

function collectionRecordMap(shadow, entityType) {
  return shadow.records[COLLECTION_NAMES[entityType]] || {};
}

function appendReconciliationForCollection({
  mutations,
  remoteShadow,
  mergedItems,
  entityType,
  projectId,
  deviceId,
  timestamp,
  idFactory,
}) {
  const remoteRecords = collectionRecordMap(remoteShadow, entityType);
  const mergedMap = mapValuesById(mergedItems);
  const ids = new Set([...Object.keys(remoteRecords), ...mergedMap.keys()]);

  for (const entityId of ids) {
    const remoteRecord = remoteRecords[entityId] || null;
    const mergedValue = mergedMap.has(entityId) ? mergedMap.get(entityId) : MISSING;
    const remoteValue = activeRecordValue(remoteRecord);

    if (isMissing(mergedValue)) {
      if (remoteRecord && !remoteRecord.deleted) {
        mutations.push(
          createPlannerMutation({
            projectId,
            entityType,
            entityId,
            operation: PLANNER_MUTATION_OPERATIONS.DELETE,
            baseRevision: remoteRecord.revision,
            baseExists: true,
            deviceId,
            timestamp,
            opId: idFactory?.(entityType, entityId, "delete"),
          }),
        );
      }
      continue;
    }

    if (!isMissing(remoteValue) && syncValuesEqual(remoteValue, mergedValue)) continue;

    mutations.push(
      createPlannerMutation({
        projectId,
        entityType,
        entityId,
        operation: PLANNER_MUTATION_OPERATIONS.UPSERT,
        payload: mergedValue,
        baseRevision: Number(remoteRecord?.revision) || 0,
        baseExists: remoteRecord ? remoteRecord.deleted !== true : false,
        deviceId,
        timestamp,
        opId: idFactory?.(entityType, entityId, "upsert"),
      }),
    );
  }
}

export function buildPlannerReconciliationMutations({
  remoteShadow,
  merged,
  deviceId = "local",
  timestamp = Date.now(),
  idFactory,
} = {}) {
  const validation = validateSyncEnvelope(merged);
  if (!validation.valid) {
    throw new Error(`Invalid merged Planner sync envelope: ${validation.errors.join("; ")}`);
  }
  const shadowValidation = validatePlannerRemoteShadow(remoteShadow, merged.project.id);
  if (!shadowValidation.valid) {
    throw new Error(`Invalid remote shadow: ${shadowValidation.errors.join("; ")}`);
  }

  const projectId = merged.project.id;
  const mutations = [];
  const remoteProject = remoteShadow.records.project;
  if (!remoteProject || remoteProject.deleted || !syncValuesEqual(remoteProject.value, merged.project)) {
    mutations.push(
      createPlannerMutation({
        projectId,
        entityType: "project",
        entityId: projectId,
        operation: PLANNER_MUTATION_OPERATIONS.UPSERT,
        payload: merged.project,
        baseRevision: Number(remoteProject?.revision) || 0,
        baseExists: Boolean(remoteProject && !remoteProject.deleted),
        deviceId,
        timestamp,
        opId: idFactory?.("project", projectId, "upsert"),
      }),
    );
  }

  appendReconciliationForCollection({
    mutations,
    remoteShadow,
    mergedItems: merged.nodes,
    entityType: "node",
    projectId,
    deviceId,
    timestamp,
    idFactory,
  });
  appendReconciliationForCollection({
    mutations,
    remoteShadow,
    mergedItems: merged.edges,
    entityType: "edge",
    projectId,
    deviceId,
    timestamp,
    idFactory,
  });
  appendReconciliationForCollection({
    mutations,
    remoteShadow,
    mergedItems: merged.assets || [],
    entityType: "asset",
    projectId,
    deviceId,
    timestamp,
    idFactory,
  });

  return mutations;
}
