# Troubleshooting

## Extension Won't Load

**"Service worker registration failed. Status code: 3"**
- A plugin handler file is missing. Check `extension/apps/_loaded.js` for imports that reference non-existent files.
- Common: horsebread plugin was registered but its files are gitignored. Remove the import.

**Dashboard shows "Setup Required"**
- Run `node scripts/setup.mjs` to create the forge junction/symlink.
- SmartClient SDK is bundled (27MB) — if missing, re-clone the repo.

## Bridge Connection

**Dashboard shows "Disconnected"**
- Start the bridge: `npm run bridge`
- If on Windows: check that no WSL2 bridge is running on the same port.
- Bridge conflict detection: if port 9876 is in use, the bridge exits with guidance.

**"PORT 9876 ALREADY IN USE — another bridge is running"**
- On Windows: a WSL2 bridge may be forwarding via localhost. Stop it with `npm run bridge:stop` in WSL2.
- On Linux: `npm run bridge:stop` then retry.

## Ollama

**"No API key for provider: ollama"**
- Older versions of the agent code didn't pass `getApiKey` correctly. Pull latest and rebuild: `node scripts/bundle-pi.mjs`

**403 from Ollama**
- Chrome extensions have `chrome-extension://` origins which Ollama blocks by default.
- Fix: set `OLLAMA_ORIGINS=*` in the systemd service override:
```bash
sudo mkdir -p /etc/systemd/system/ollama.service.d
echo -e '[Service]\nEnvironment="OLLAMA_ORIGINS=*"' | sudo tee /etc/systemd/system/ollama.service.d/override.conf
sudo systemctl daemon-reload && sudo systemctl restart ollama
```

## CheerpX

**Commands hang (sqlite3, python import)**
- Root cause: entropy starvation. CheerpX has no hardware entropy sources, so `getrandom()` blocks forever.
- Python fix: `PYTHONHASHSEED=0` is auto-injected for all python3 commands (bypasses hash randomization).
- sqlite3 CLI: no fix available (C-level getrandom). Use Python's sqlite3 module instead.
- General fix: the spawn queue has a 30s timeout + Ctrl+C. Hung commands don't block subsequent ones.

**Spawn queue jammed (all commands timeout)**
- One command is still blocking. Reload the CheerpX tab to clear the queue.
- The spawn timeout (30s) should prevent this — if it doesn't, the tab needs reloading.

**What works in CheerpX:**
- `/bin/echo`, `/bin/ls`, `/bin/cp`, `/bin/cat` — ~200ms
- `python3 -c "print(42)"` — ~1.3s (no imports)
- `python3` with PYTHONHASHSEED=0: json, csv, re, sqlite3, hashlib — 1-2s each
- File upload via DataDevice — ~100ms

**What hangs:**
- `sqlite3` binary (any invocation)
- `python3 import openpyxl` (OpenSSL C-level getrandom)
- `apt-get` anything (no network + entropy starvation)

## Windows

**Symlinks don't work**
- Windows needs junctions instead of symlinks. Run `node scripts/setup.mjs` which creates junctions automatically.

**npx spawn errors (EINVAL or ENOENT)**
- Node.js CVE-2024-27980 blocks direct .cmd spawn. The bridge uses `shell: true` on Windows.

**Session browser opens but script doesn't use it**
- Check the session status shows "ready" (not blank). The `state` vs `status` field name was fixed — pull latest.
- CDP endpoint uses `127.0.0.1` not `localhost` (IPv6 resolution issue).

**Trace zip fails**
- Windows doesn't have `zip` command. The bridge uses PowerShell `Compress-Archive` on Windows.

**Script paths doubled (examples/examples/...)**
- Relative `originalPath` in script library. Fixed in latest — scripts dir resolution checks `SCRIPTS_DIR` first.

## SmartClient Dashboard

**Buttons inside SectionStack don't work**
- Renderer only walks `members`, not `sections[].items[]`. Use VLayout + Label dividers instead.

**Form values not reaching handlers**
- `_payloadFrom` checks `getSelectedRecord` before `getValues`. DynamicForm has both — the form version is preferred for non-ListGrid sources. Pull latest renderer.js.

**Timestamp columns show raw integers**
- Add `_formatter: 'timestamp'` to the field definition in the grid config.

## Agent

**Agent says "No API key for provider: ollama"**
- `getApiKey` must be a constructor option on Agent, not an initialState field. Pull latest agent-setup.js.
- The model object needs `apiKey: 'ollama'` even though Ollama doesn't validate it.

**Streaming text appears only at the end**
- Agent subscribe events use `message_update` type (not `text_delta`). Text is on `event.partial.content[0].text`. Pull latest agent-ui.js.

**Import map CSP error in console**
- Harmless warning. We use `pi-bundle.js` (pre-built), not import maps. The inline `<script type="importmap">` was removed.

**WebLLM model doesn't load**
- Requires WebGPU (Chrome 113+). Check `navigator.gpu` in the console.
- First load downloads ~2GB. Check network tab for download progress.
- Discrete GPU recommended. Integrated GPUs may be too slow.
