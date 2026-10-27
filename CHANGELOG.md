# Changelog

## 4.9.7 — 2026-10-27

- Add a per-photo AI identify action beside the original-link action in the mobile album preview.
- Support horizontal drag and swipe between previous and next album photos with directional transitions.
- Cache single-photo AI results under the same image identity used by Planner, avoiding duplicate model requests.
- Rework AI Planner into a planning layer over existing analysis: pose groups now include consolidated camera settings, composition, pose and lighting notes.
- Keep actionable Add Text, Add Group and Add Album Photos controls visible after clearing a mobile plan.
- Remove images, generated groups and AI summary notes from the linked Planner project when an album source link is deleted.

## 4.9.6 — 2026-10-27

- Let users choose whether downloaded images stay in the Mori private cache or are also written to the phone gallery.
- Default the download choice to the Mori cache, keeping link images out of system gallery views unless explicitly requested.
- Add an iOS-style action sheet with spring transitions and haptic feedback for download destinations and album link actions.
- Add per-link deletion inside albums, including associated cache images, history entries, favorites and album assignments.
- Attempt MediaStore and shared-storage deletion for gallery copies; keep the link removal and show a manual-cleanup notice when Android denies permission.

## 4.9.5 — 2026-10-27

- Show live AI image-analysis progress in an Android foreground notification.
- Use Android 16 progress-centric notifications and short critical text on supported devices, with an ongoing notification fallback on older Android and OEM launchers.
- Include the current image number, total image count and filename while album or Planner analysis runs.
- Show localized preparing, cancelling, complete, cancelled and failed states with Simplified Chinese, Traditional Chinese and English output.

## 4.9.4 — 2026-10-23

- Add long-press album management with rename, merge and delete.
- Preserve downloaded history and original images when deleting an album grouping.
- Make AI Plan feedback explicit when no images or AI configuration is available.
- Automatically copy a read-only Planner to an editable local copy before AI layout.
- Add tests for album long-press editing and read-only AI Planner copying.

## 4.9.3 — 2026-10-23

- Restrict AI analysis sheet closing to dragging the white top handle.
- Keep downward movement inside the parameter sheet as normal scrolling.
- Add `EonGreen0` as the Android AI edition developer in the app and project metadata.
- Preserve `coflyn/Mori` as the upstream open-source project.

## 4.9.1 — 2026-10-23

- Add two-finger pinch zoom and zoom controls to editable Android plans.
- Add AI Plan: analyze plan images, group them by pose and arrange them into labeled group boxes.
- Keep user-created notes and groups when replacing a previous AI layout.

## 4.9.0 — 2026-10-23

- Keep AI pose categories inside the original album as filter chips.
- Add per-image AI analysis badges and swipe-up analysis sheets.
- Add manual extracted-link assignment to existing or new albums.
- Make local Android planner projects editable.

## 4.8.3 — 2026-10-23

- Add fixed pose taxonomy, shot type and recommended photography settings.
- Show detailed per-image AI results before saving classifications.

## 4.8.2 — 2026-10-23

- Add a maintainable Xiaohongshu short-link and SSR parser.
- Preserve `xsec_token`, parse images/videos and support OpenGraph fallback.

## 4.8.1 — 2026-10-23

- Add Android system gallery multi-select import.
- Persist imported images and assign them to the active album.

## 4.8.0 — 2026-10-23

- Add OpenAI-compatible multimodal AI settings.
- Store AI API keys in Android Keystore.
- Add AI image analysis cache and non-destructive album suggestions.
