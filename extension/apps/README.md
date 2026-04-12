# Plugins (`extension/apps/`)

Each plugin lives in its own directory: `extension/apps/<plugin-id>/`.

Plugins target the host capability interface defined in
`extension/lib/host/host-interface.js` (typedef) and implemented in
`extension/lib/host/host-chrome-extension.js` (chrome extension host).
A plugin is a self-contained bundle of:

- a `manifest.json` describing what it provides and what it needs
- a `handlers.js` that registers service-worker message handlers
- one or more `templates/*.json` SmartClient configs for its UI
- optional assets (icons, fixtures, rootfs scripts)

## Layout

```
extension/apps/<plugin-id>/
├── manifest.json
├── handlers.js
├── templates/
│   ├── dashboard.json
│   └── ...
├── assets/
│   └── icon.svg
└── rootfs/                    (optional — for plugins that need a CheerpX rootfs)
    ├── apt-packages.txt
    ├── pip-requirements.txt
    └── mount-hook.sh
```

## Discovery

The platform discovers installed plugins via `extension/apps/index.json`:

```json
{
  "plugins": ["hello-runtime", "horsebread"]
}
```

`extension/lib/plugin-loader.js` reads this file at service-worker startup,
fetches each plugin's `manifest.json`, validates it, and dynamic-imports
its `handlers.js` to call `register(handlers)` on the dispatch table.

The reference plugin `hello-runtime/` is checked in to this repo and
exists in `index.json` by default. Other plugins are added by the plugin's
own assemble script when it copies its source into `extension/apps/<id>/`.

## Privacy / public-history rule

`extension/apps/*` is gitignored, with exceptions for:

- `apps/README.md` (this file)
- `apps/index.json` (the plugin discovery list)
- `apps/hello-runtime/` (the reference plugin)

Private plugins (e.g., `horsebread`) live in their own private repos and
are assembled into `apps/<id>/` at build time. They never land in
agentidev's public git history. See the horsebread plan at
`/home/bigale/repos/horsebread/plans/horsebread-agentidev-plugin.md` for
the canonical pattern (the `scripts/assemble.sh` build script + `git
archive` for rootfs tarballs).

## Manifest schema

See `extension/lib/plugin-manifest.js` for the validator. Minimum:

```json
{
  "id": "hello-runtime",
  "name": "Hello Runtime",
  "version": "0.1.0",
  "description": "Demo plugin exercising the three host runtimes",
  "modes": ["hello-runtime"],
  "templates": {
    "dashboard": "templates/dashboard.json"
  },
  "handlers": "handlers.js",
  "requires": {
    "hostCapabilities": ["message"],
    "runtimes": ["cheerpj", "cheerpx", "bsh"]
  }
}
```

Optional fields: `assets.icon`, `rootfs.*`, `dataSources`.
