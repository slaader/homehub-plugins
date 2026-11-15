# Public Home Hub plugins

This is a generic plugin source, separate from household plugins and configuration. Node 22+, ES modules, zero third-party dependencies. Never install npm packages.

No household names, network addresses, home paths, credentials or private history in any file, including tests and docs. Use example.lan, 10.0.0.x and alice. Keep data and secrets outside the repository. Plugins import core only as home-hub/plugin-api or home-hub/testing.

Run the complete npm test suite before committing. Tests must pass with no skips and no actual network except local fake servers. Every file is scanned with core's leak rules. Changes to the UniFi transport require fake-gateway tests proving no credentials reach an untrusted certificate and all calls are GET.

Current suite: 57 tests in 12 files, all passing with no skips against core 1.0.0. For a combined run with other plugin sources, pass one `--site` fixture that configures every loaded source. Core loads all supplied sources in each run; this repository's minimal fixture intentionally cannot configure another source's required plugins.

Use neutral git identity Home Hub <dev@home-hub.invalid>. Releases are annotated version tags after verification. Do not publish a household source or copy its history here.
