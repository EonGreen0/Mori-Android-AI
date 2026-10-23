import { cloneJson, normalizeRevision, validateSyncEnvelope } from "./model.js";

export const PLANNER_MUTATION_OPERATIONS = Object.freeze({
  UPSERT: "upsert",
  DELETE: "delete",
});

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value)
    .sort()
    .reduce((output, key) => {
      output[key] = stableValue(value[key]);
      return output;
    }, {});
}

export function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

export function syncValuesEqual(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function randomSuffix() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createPlannerMutation({
  projectId,
  entityType,
  entityId,
  operation,
  payload = null,
  baseRevision = 0,
  baseExists = null,
  deviceId = "local",
  timestamp = Date.now(),
  opId = "",
} = {}) {
  if (!projectId || !entityType || !entityId) {
    throw new Error("Planner mutation requires projectId, entityType, and entityId");
  }
  if (!Object.values(PLANNER_MUTATION_OPERATIONS).includes(operation)) {
    throw new Error(`Unsupported planner mutation operation: ${String(operation)}`);
  }

  return {
    opId: opId || `op_${randomSuffix()}`,
    projectId,
    entityType,
    entityId,
    operation,
    baseRevision: normalizeRevision(baseRevision),
    baseExists: baseExists === true ? true : baseExists === false ? false : null,
    deviceId: String(deviceId || "local"),
    clientTimestamp: Number(timestamp) || Date.now(),
    payload: operation === PLANNER_MUTATION_OPERATIONS.DELETE ? null : cloneJson(payload),
  };
}

function mapById(items) {
  const map = new Map();
  (Array.isArray(items) ? items : []).forEach((item) => {
    if (item?.id) map.set(item.id, item);
  });
  return map;
}

function diffEntityCollection({
  previous,
  next,
  previousKnown,
  entityType,
  projectId,
  deviceId,
  timestamp,
  idFactory,
}) {
  const mutations = [];
  const before = mapById(previous);
  const after = mapById(next);
  const entityIds = new Set([...before.keys(), ...after.keys()]);

  entityIds.forEach((entityId) => {
    const previousValue = before.get(entityId);
    const nextValue = after.get(entityId);
    if (!nextValue) {
      mutations.push(
        createPlannerMutation({
          projectId,
          entityType,
          entityId,
          operation: PLANNER_MUTATION_OPERATIONS.DELETE,
          baseRevision: previousValue?.revision,
          baseExists: true,
          deviceId,
          timestamp,
          opId: idFactory?.(entityType, entityId, "delete"),
        }),
      );
      return;
    }
    if (!previousValue || !syncValuesEqual(previousValue, nextValue)) {
      mutations.push(
        createPlannerMutation({
          projectId,
          entityType,
          entityId,
          operation: PLANNER_MUTATION_OPERATIONS.UPSERT,
          payload: nextValue,
          baseRevision: previousValue?.revision,
          baseExists: previousValue ? true : previousKnown ? false : null,
          deviceId,
          timestamp,
          opId: idFactory?.(entityType, entityId, "upsert"),
        }),
      );
    }
  });

  return mutations;
}

export function diffPlannerSyncEnvelopes(previous, next, options = {}) {
  const nextValidation = validateSyncEnvelope(next);
  if (!nextValidation.valid) {
    throw new Error(`Invalid next planner sync envelope: ${nextValidation.errors.join("; ")}`);
  }

  if (previous) {
    const previousValidation = validateSyncEnvelope(previous);
    if (!previousValidation.valid) {
      throw new Error(
        `Invalid previous planner sync envelope: ${previousValidation.errors.join("; ")}`,
      );
    }
    if (previous.project.id !== next.project.id) {
      throw new Error("Cannot diff planner snapshots from different projects");
    }
  }

  const projectId = next.project.id;
  const deviceId = options.deviceId || "local";
  const timestamp = Number(options.timestamp) || Date.now();
  const idFactory = options.idFactory;
  const mutations = [];

  if (!previous || !syncValuesEqual(previous.project, next.project)) {
    mutations.push(
      createPlannerMutation({
        projectId,
        entityType: "project",
        entityId: projectId,
        operation: PLANNER_MUTATION_OPERATIONS.UPSERT,
        payload: next.project,
        baseRevision: previous?.project?.revision,
        baseExists: previous ? true : null,
        deviceId,
        timestamp,
        opId: idFactory?.("project", projectId, "upsert"),
      }),
    );
  }

  mutations.push(
    ...diffEntityCollection({
      previous: previous?.nodes,
      next: next.nodes,
      previousKnown: Boolean(previous),
      entityType: "node",
      projectId,
      deviceId,
      timestamp,
      idFactory,
    }),
  );
  mutations.push(
    ...diffEntityCollection({
      previous: previous?.edges,
      next: next.edges,
      previousKnown: Boolean(previous),
      entityType: "edge",
      projectId,
      deviceId,
      timestamp,
      idFactory,
    }),
  );
  mutations.push(
    ...diffEntityCollection({
      previous: previous?.assets,
      next: Array.isArray(next.assets) ? next.assets : [],
      previousKnown: Boolean(previous),
      entityType: "asset",
      projectId,
      deviceId,
      timestamp,
      idFactory,
    }),
  );

  return mutations;
}
