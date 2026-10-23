# Contributing

1. Create a branch from `main`.
2. Install dependencies with `npm ci`.
3. Run `npm test` before committing.
4. For Android changes, also run:

   ```powershell
   npm run build:android
   ```

5. Do not commit APKs, signing keys, API keys, `node_modules`, `.tooling`, build outputs, or user data.

AI changes must:

- preserve structured JSON validation;
- keep API keys outside the WebView;
- avoid destructive album or Planner operations without confirmation;
- add or update automated tests for new behavior.
