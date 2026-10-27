import { t } from "../i18n/index.js";
import { showActionSheet } from "./actionSheet.js";

export const DOWNLOAD_STORAGE_MODES = Object.freeze({
  CACHE: "cache",
  GALLERY: "gallery",
});

export async function chooseDownloadDestination({ scope = "single" } = {}) {
  const selection = await showActionSheet({
    title: t(scope === "batch" ? "download-destination-batch-title" : "download-destination-title"),
    message: t("download-destination-message"),
    options: [
      {
        id: DOWNLOAD_STORAGE_MODES.CACHE,
        label: t("download-destination-cache"),
        description: t("download-destination-cache-desc"),
        icon: "cache",
        recommended: true,
      },
      {
        id: DOWNLOAD_STORAGE_MODES.GALLERY,
        label: t("download-destination-gallery"),
        description: t("download-destination-gallery-desc"),
        icon: "gallery",
      },
    ],
  });
  return Object.values(DOWNLOAD_STORAGE_MODES).includes(selection) ? selection : null;
}
