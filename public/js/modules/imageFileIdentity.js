export function fileAssignmentKey(file) {
  const identity = String(file?.assetId || file?.path || file?.uri || "").trim();
  if (identity) {
    if (identity.length <= 512) return `file:${identity}`;
    let hash = 2166136261;
    for (let index = 0; index < identity.length; index++) {
      hash ^= identity.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `file:digest-${(hash >>> 0).toString(16)}`;
  }
  return `file:${String(file?.title || "image")}:${Number(file?.savedAt) || 0}`;
}
