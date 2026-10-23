# Xiaohongshu / RedNote extraction

The Android client now uses a maintainable RedNote parser instead of relying only on the precompiled scraper core.

## Supported links

- `xiaohongshu.com/explore/...`
- `xiaohongshu.com/discovery/item/...`
- `xhslink.com/...`
- `xhslink.cn/...`
- `rednote.com/...`

Short links are requested through the Android native HTTP bridge. The parser reads the final redirected URL and preserves `xsec_token` and `xsec_source`.

## Extraction path

1. Request the note page with a desktop browser profile.
2. Parse `window.__INITIAL_STATE__` with a string-aware balanced JSON reader and normalize `undefined`/`NaN` values.
3. Read the matching `noteDetailMap` or locate the note object recursively.
4. Extract all image candidates and the highest-quality H.264/H.265 video stream, including backup URLs.
5. Retry with a mobile browser profile if the desktop page contains no media.
6. Fall back to OpenGraph metadata when SSR data is unavailable.

Xiaohongshu may still return an anti-bot verification page for some requests or regions. In that case the app reports that security verification blocked extraction rather than claiming the link is invalid.
