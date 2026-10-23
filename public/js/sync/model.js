// Shared sync primitives for Mori planner.
// This module is intentionally storage/transport agnostic: no localStorage,
// IndexedDB, Cloudflare, Tauri, or Capacitor dependencies belong here.

export const PLANNER_SYNC_SCHEMA_VERSION = 1;

export const PLANNER_ENTITY_TYPES = Object.freeze({
  PROJECT: "project",
  NODE: "node",
  EDGE: "edge",
  ASSET: "asset",
});

export function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeRevision(value) {
  const revision = Number(value);
  return Number.isInteger(revision) && revision >= 0 ? revision : 0;
}

export function createSyncEnvelope({ project, nodes = [], edges = [], assets = [] } = {}) {
  if (!isPlainObject(project) || !project.id) {
    throw new Error("Planner sync project requires a stable id");
  }

  return {
    schemaVersion: PLANNER_SYNC_SCHEMA_VERSION,
    project: cloneJson(project),
    nodes: Array.isArray(nodes) ? cloneJson(nodes) : [],
    edges: Array.isArray(edges) ? cloneJson(edges) : [],
    assets: Array.isArray(assets) ? cloneJson(assets) : [],
  };
}

export function validateSyncEnvelope(value) {
  const errors = [];
  if (!isPlainObject(value)) return { valid: false, errors: ["Envelope must be an object"] };

  if (value.schemaVersion !== PLANNER_SYNC_SCHEMA_VERSION) {
    errors.push(`Unsupported schemaVersion: ${String(value.schemaVersion)}`);
  }
  if (!isPlainObject(value.project) || !value.project.id) {
    errors.push("project.id is required");
  }
  if (!Array.isArray(value.nodes)) errors.push("nodes must be an array");
  if (!Array.isArray(value.edges)) errors.push("edges must be an array");
  if (value.assets !== undefined && !Array.isArray(value.assets)) errors.push("assets must be an array");

  const nodeIds = new Set();
  if (Array.isArray(value.nodes)) {
    value.nodes.forEach((node, index) => {
      if (!isPlainObject(node) || !node.id) {
        errors.push(`nodes[${index}].id is required`);
        return;
      }
      if (nodeIds.has(node.id)) errors.push(`Duplicate node id: ${node.id}`);
      nodeIds.add(node.id);
    });
  }

  const assetIds = new Set();
  if (Array.isArray(value.assets)) {
    value.assets.forEach((asset, index) => {
      if (!isPlainObject(asset) || !asset.id) {
        errors.push(`assets[${index}].id is required`);
        return;
      }
      if (assetIds.has(asset.id)) errors.push(`Duplicate asset id: ${asset.id}`);
      assetIds.add(asset.id);
      if (!String(asset.id).startsWith("sha256:")) {
        errors.push(`assets[${index}].id must be sha256-based`);
      }
      if (!isPlainObject(asset.source) || asset.source.hash !== asset.id) {
        errors.push(`assets[${index}].source.hash must match asset id`);
      }
      if (!isPlainObject(asset.display) || !String(asset.display.hash || "").startsWith("sha256:")) {
        errors.push(`assets[${index}].display.hash is required`);
      }
    });
  }

  const edgeIds = new Set();
  if (Array.isArray(value.edges)) {
    value.edges.forEach((edge, index) => {
      if (!isPlainObject(edge) || !edge.id) {
        errors.push(`edges[${index}].id is required`);
        return;
      }
      if (edgeIds.has(edge.id)) errors.push(`Duplicate edge id: ${edge.id}`);
      edgeIds.add(edge.id);
      if (!edge.from || !edge.to) errors.push(`edges[${index}] requires from/to`);
    });
  }

  return { valid: errors.length === 0, errors };
}
