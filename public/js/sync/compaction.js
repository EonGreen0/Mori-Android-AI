import { cloneJson } from "./model.js";
import { PLANNER_MUTATION_OPERATIONS } from "./mutations.js";

function mutationKey(mutation) {
  return `${String(mutation?.projectId || "")}\u0000${String(mutation?.entityType || "")}\u0000${String(mutation?.entityId || "")}`;
}

function mutationOrder(mutation, index) {
  const queuedAt = Number(mutation?.queuedAt);
  if (Number.isFinite(queuedAt) && queuedAt > 0) return [queuedAt, index];
  const timestamp = Number(mutation?.clientTimestamp);
  return [Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0, index];
}

function compareOrdered(left, right) {
  if (left.order[0] !== right.order[0]) return left.order[0] - right.order[0];
  return left.order[1] - right.order[1];
}

function normalizeBaseExists(value) {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

function compactSegment(segment) {
  const first = segment.items[0];
  const last = segment.items[segment.items.length - 1];
  const sourceOpIds = segment.items.map((item) => item.opId).filter(Boolean);

  if (
    segment.items.length > 0 &&
    normalizeBaseExists(first.baseExists) === false &&
    last.operation === PLANNER_MUTATION_OPERATIONS.DELETE
  ) {
    return {
      entry: null,
      discardOpIds: sourceOpIds,
    };
  }

  const mutation = cloneJson(last);
  mutation.baseRevision = Number(first.baseRevision) || 0;
  mutation.baseExists = normalizeBaseExists(first.baseExists);
  if (Number(first.queuedAt) > 0) mutation.queuedAt = Number(first.queuedAt);

  return {
    entry: {
      mutation,
      sourceOpIds,
      compacted: sourceOpIds.length > 1,
    },
    discardOpIds: [],
  };
}

/**
 * Coalesce unsent Planner mutations without changing their final server-visible state.
 *
 * Mutations that have already been sealed for transport or attempted are hard barriers:
 * they are never merged with later operations because the server may receive (or may
 * already have applied) that exact opId independently of newer local edits.
 */
export function compactPlannerMutations(mutations) {
  const ordered = (Array.isArray(mutations) ? mutations : [])
    .filter((mutation) => mutation?.opId && mutation?.projectId && mutation?.entityType && mutation?.entityId)
    .map((mutation, index) => ({
      mutation,
      index,
      order: mutationOrder(mutation, index),
    }))
    .sort(compareOrdered);

  const openSegments = new Map();
  const segments = [];

  const flush = (key) => {
    const segment = openSegments.get(key);
    if (!segment) return;
    segments.push(segment);
    openSegments.delete(key);
  };

  ordered.forEach(({ mutation, index, order }) => {
    const key = mutationKey(mutation);
    const transportBarrier =
      Number(mutation.attempts || 0) > 0 || Number(mutation.sealedAt || 0) > 0;

    if (transportBarrier) {
      flush(key);
      segments.push({
        key,
        firstIndex: index,
        firstOrder: order,
        items: [mutation],
        attemptedBarrier: true,
      });
      return;
    }

    let segment = openSegments.get(key);
    if (!segment) {
      segment = {
        key,
        firstIndex: index,
        firstOrder: order,
        items: [],
        attemptedBarrier: false,
      };
      openSegments.set(key, segment);
    }
    segment.items.push(mutation);
  });

  openSegments.forEach((segment) => segments.push(segment));
  segments.sort((left, right) => {
    if (left.firstOrder[0] !== right.firstOrder[0]) return left.firstOrder[0] - right.firstOrder[0];
    return left.firstOrder[1] - right.firstOrder[1];
  });

  const entries = [];
  const discardOpIds = [];

  segments.forEach((segment) => {
    if (segment.attemptedBarrier) {
      const mutation = cloneJson(segment.items[0]);
      entries.push({
        mutation,
        sourceOpIds: mutation.opId ? [mutation.opId] : [],
        compacted: false,
      });
      return;
    }

    const compacted = compactSegment(segment);
    if (compacted.entry) entries.push(compacted.entry);
    discardOpIds.push(...compacted.discardOpIds);
  });

  return {
    entries,
    discardOpIds,
    inputCount: ordered.length,
    outputCount: entries.length,
  };
}
