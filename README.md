# MindCanvas

A private, local-first infinite canvas for visual thinking. Open `index.html` in a modern browser to start drawing.

Features: pen, brush, highlighter, text, eraser, movable lasso selections, smooth pan/zoom, local persistence, snapshots, and PNG/JPG/SVG/PDF/JSON exports. Sharing is opt-in and remains a local configuration until a sharing service is connected.

## Mobile and offline

MindCanvas is an installable PWA. Serve the project over HTTPS (or `localhost` during development), then use the browser's **Install app** / **Add to Home Screen** option. The app shell works offline after its first successful visit; canvas content remains in the device's browser storage.

## Optional local encryption

Choose **Encrypt** in the app to protect local canvas data with a passphrase. MindCanvas derives an AES-256-GCM key using PBKDF2-SHA-256 with a unique random salt and 600,000 iterations; the passphrase and derived key are never persisted. If the passphrase is forgotten, the encrypted data cannot be recovered.

Press **?** in the app for the full keyboard-shortcut reference.
