# macOS runtimes

Optional runtime bridge for llama-swap, oMLX, mlx-serve and mflux GPU jobs. Supplies core's runtime cards and LLM & Diffusion request history; it does not replace that page. No section means no sockets, polling or storage. All devices must exist in core `devices[]`.

Minimal site section (the JSON key includes a hyphen):

```json
{"plugins":{"macos-runtimes":{
  "sockets":{"mac":"/Users/alice/.local/share/home-hub-runtime/private/bridge.sock"},
  "hosts":{"mac":{"agent":{"omlx":{"base":"http://127.0.0.1:8000"},"actions":[]}}},
  "agents":{"bridge":{"mac":{"target":"~/.local/share/home-hub-runtime","label":"com.example.runtime-bridge"}}}
}}}
```

`hosts` keys are device IDs. Each bridge device needs a socket and host entry. Optional host fields: name, role, hardware (`cpu`, `memoryBytes`, `gpu`), os (`name`, `version`), runtimes (subset of `llama-swap`, `omlx`, `mlx-serve`, `mflux`), actions. Values are strictly checked by `server/config.mjs`; no settings are required when the plugin is absent, so the manifest has no unconditional `config.required`.

An agent profile accepts `llamaSwap`, `omlx`, `mlxServe`, `jobs`, `pids`, `actions`. Runtime `base` is a loopback HTTP origin. llamaSwap also needs an absolute `configPath`; optional `flavor: "v268"` selects that API variant. oMLX `admin: true` enables admin telemetry. `jobs.toolDir` is relative to the device user's home; `pids` maps runtime IDs to process-match regular expressions. Actions default to none: explicitly allow `unload-all`, `unload-model`, `warm` (llama-swap) or `unload-audio` (mlx-serve). Services are allowlisted under `controls.<device>` as `{id,name,label,impact}`; only those launchd user agents can be started, stopped or restarted.

Install the runtimes yourself. Replace the example home path with the runtime owner's actual path. `agents.bridge.<device>` requires `target` and `label`; `node`, `logs` and `env` are optional (core's host-agent documentation). The hub's socket path must reach the installed bridge's `private/bridge.sock`, directly on the same Mac or through a tunnel on another device.

On that Mac, link the public source to core with `node /path/to/core/scripts/plugins.mjs link --plugins /path/to/public-source/plugins`. Select that source and the site file explicitly, or use a `HOME_HUB_HOME` instance that lists the source in `instance.json → sources.plugins`. Then run:

```sh
export HOME_HUB_PLUGINS_DIR=/path/to/public-source/plugins
export HOME_HUB_SITE_CONFIG=/path/to/site.json
node /path/to/core/scripts/install-host-agent.mjs --plugin macos-runtimes --agent bridge --device mac --dry-run
node /path/to/core/scripts/install-host-agent.mjs --plugin macos-runtimes --agent bridge --device mac
```

Core copies the import closure and `config/bridge.json` under the configured target and writes the launchd user agent to the runtime owner's `~/Library/LaunchAgents/`. The bridge creates `<target>/private/bridge.sock` when it starts. Run as the runtime owner, never root. For a remote device relay that Unix socket through SSH to the configured hub socket; the plugin installs no tunnel. Restrict socket directories and SSH access to trusted users: socket access authorizes controls. The bridge requires an owner-only socket directory (0700), refuses unsafe ancestors or an existing live socket, sets the socket to 0600 and has no TCP listener. Do not put it directly in a shared directory such as /tmp. Runtime APIs must be accessible locally without credentials; authenticated runtime transport is a follow-up. Never put credentials in site configuration or agent environment.

Hub state lives under its plugin data directory (epoch 1); bridge queue and action audit live under the installed agent's data directory. One hub must own a bridge's history cursor. Use a separate bridge instance when two hubs need independent history.

Signed-in reads: `GET /api/macos-runtimes`, `GET /api/macos-runtimes/controls`. Controls require `macos-runtimes:control`: POST `/api/macos-runtimes/action` with `{host,action,model?,requestId}`; POST `/api/macos-runtimes/controls/action` with `{host,id,action,requestId}`. Here `host` is the device ID retained by the controller protocol; requestId is a UUID. Disabling the integration stops new reads and actions. An in-flight operation may finish.

## Scope and follow-ups

Compute's runtime controllers, normalization, history store and GPU job parsing are generalized here with independent routes, integration, scope and storage. Fixed household bridge slots and old pages are excluded. No other household plugin is imported.

Model-audit is generalizable as a separate report-import and review plugin, but is not a macOS runtime reader: it consumes a saved audit and persists cleanup decisions. Follow-up: define a device-neutral report schema and producer, explicit input location and isolated review storage before copying its UI.

Benchmarks serves recorded image/music suites and generated media. MLX references describe benchmark results rather than a reusable runtime adapter. Follow-up: an empty configurable suite catalog and generic import/media pipeline; do not publish existing result datasets or deployment paths. Neither plugin is included in this change.
