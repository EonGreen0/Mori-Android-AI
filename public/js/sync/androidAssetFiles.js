// Persistent, versioned files shared by synchronized image consumers.
// Asset/display identities already exist in the sync model; no new index is needed.
export function androidDisplayFileOptions(asset) {
  if (!asset?.id || !asset?.display?.hash) throw new Error("asset_metadata_missing");
  const key = (value) => encodeURIComponent(String(value).replace(/^sha256:/, ""));
  const ext = String(asset.display.ext || "webp").replace(/[^A-Za-z0-9]/g, "") || "webp";
  return {
    path: `Mori/Sync/Images/${key(asset.id)}/${key(asset.display.hash)}.${ext}`,
    directory: "DATA",
  };
}

export async function findAndroidDisplayFile(filesystem, asset) {
  const options = androidDisplayFileOptions(asset);
  try {
    const stat = await filesystem.stat(options);
    const size = Number(stat?.size) || 0;
    const expected = Number(asset.display.bytes) || 0;
    if (stat?.type !== "file" || size <= 0 || (expected > 0 && size !== expected)) return "";
    const result = await filesystem.getUri(options);
    return String(result?.uri || "");
  } catch {
    return "";
  }
}

export async function saveAndroidDisplayFile(filesystem, asset, bytes, base64) {
  const options = androidDisplayFileOptions(asset);
  const expected = Number(asset.display.bytes) || 0;
  if (expected > 0 && bytes.length !== expected) throw new Error("display_size_mismatch");
  // A failed/interrupted write must never be reused as a complete display file.
  const temporary = { ...options, path: `${options.path}.part` };
  await filesystem.writeFile({ ...temporary, data: base64, recursive: true });
  const written = await filesystem.stat(temporary);
  if (written?.type !== "file" || Number(written.size) !== bytes.length) {
    throw new Error("local_image_write_incomplete");
  }
  await filesystem.rename({ from: temporary.path, to: options.path, directory: options.directory });
  const result = await filesystem.getUri(options);
  const uri = String(result?.uri || "");
  if (!uri) throw new Error("local_image_uri_unavailable");
  return uri;
}

// Delete only paths generated for this display version; never recurse or use node paths.
export async function removeAndroidDisplayFile(filesystem, asset) {
  if (![asset?.id, asset?.display?.hash].every((value) => /^sha256:[a-f0-9]{64}$/i.test(String(value || "")))) {
    throw new Error("local_image_reset_invalid_asset");
  }
  const options = androidDisplayFileOptions(asset);
  let removed = 0;
  for (const path of [options.path, `${options.path}.part`]) {
    let stat;
    try {
      stat = await filesystem.stat({ ...options, path });
    } catch (error) {
      // Capacitor reports missing files with this code. Other failures must stay visible.
      if (error?.code === "OS-PLUG-FILE-0008" || /not exist|not found|missing|ENOENT/i.test(String(error?.message || error))) continue;
      throw error;
    }
    if (stat?.type !== "file") throw new Error("local_image_reset_not_a_file");
    await filesystem.deleteFile({ ...options, path });
    removed += 1;
  }
  return removed;
}
