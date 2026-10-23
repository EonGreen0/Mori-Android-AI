# Android AI Organizer

The Android build can analyze local album images with a user-supplied multimodal model. AI categories remain inside the original user album instead of creating unrelated top-level albums.

## Provider contract

The first implementation supports an OpenAI-compatible Chat Completions endpoint:

- HTTPS only, port 443.
- `Authorization: Bearer <API key>`.
- Base URL examples: `https://api.openai.com/v1` or a compatible gateway.
- The model must accept OpenAI-style `text` and `image_url` content parts.
- Response content must be available at `choices[0].message.content`.

The API key is encrypted with an AES-GCM key in Android Keystore. It is never stored in `localStorage`, a Mori album package, sync data, or logs. The native bridge binds the key to the HTTPS host authorized when saving it and rejects requests to a different host.

## User flow

1. Open Settings -> General -> AI Organizer.
2. Enter the API base URL, multimodal model ID, and API key.
3. Select `zh-Hans`, `zh-Hant`, or `en` for generated titles, categories, and tags.
4. Save and run Test Connection.
5. Open an album and choose AI analyze and organize.
6. Review each image's pose, shot type, recommended camera settings and practical suggestions.
7. Choose Save analysis and categories or cancel.

The current run analyzes at most 60 images to make request cost predictable. It sends a compressed preview with a maximum side of 768 px. Analysis results are cached in the local `mori_ai_v1` IndexedDB database by image hash, model, output language, and prompt version.

## Pose and photography analysis

Every image is classified into one of these fixed pose codes:

`standing`, `sitting`, `squatting`, `kneeling`, `lying`, `walking`, `running`, `jumping`, `leaning`, `portrait`, `interaction`, `no_person`, `other`.

The result also includes shot type, composition, pose advice, color/retouch direction and recommended camera settings:

- full-frame equivalent focal length range;
- aperture range;
- shutter speed;
- ISO range;
- camera height and angle;
- light direction and quality;
- actionable suggestions.

These camera values are recommendations for recreating the visual result. They are not reported as original EXIF metadata.

## In-album organization

- The user's album remains the main album. For example, a `Flower field shoot` album keeps that name and all source links.
- Pose categories become filter chips inside that album, such as `Standing 3`, `Sitting 2` and `Walking 1`.
- Each analyzed image displays a pose badge in the album.
- Tapping an image opens the full-screen preview. Swipe up, or tap the AI hint, to inspect that image's complete analysis.
- Analysis is stored per image, so multiple links in one album can contain different poses.
- Confirming analysis does not create top-level pose albums and does not delete existing album membership.
- A failed image is skipped and reported; authentication failures stop the run.

AI output is treated as untrusted data. The app validates types and length limits and creates album IDs locally.
