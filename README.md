# Home Hub plugins

Generic plugins for [Home Hub](https://github.com/slaader/homehub-core), with no household configuration or third-party dependencies.

## Included

- **UniFi Network** (`unifi`): pulls network clients and hardware through the gateway API. Nothing is installed on the router. See [setup and credential handling](plugins/unifi/README.md).

- **macOS runtimes** (`macos-runtimes`): local model runtimes, request history and bridge controls. See [setup](plugins/macos-runtimes/README.md).

## Connect a source

Use Node 22 or newer and a Home Hub 1.0 checkout. Add this source to `HOME_HUB_HOME/instance.json` under `sources.plugins` (see core `docs/storage.md`), or set `HOME_HUB_PLUGINS_DIR` to this source's `plugins` directory. Link the core package:

```sh
node <core>/scripts/plugins.mjs link --plugins <this-source>/plugins
```

Configure `plugins.unifi` and `router.adapter` in your instance's site file. Keep API keys in the hub's encrypted integration settings or a protected external key file, never in this repository.

## Tests and updates

```sh
npm test
```

Tests use a fake HTTPS gateway and dummy keys; no real router or household data is needed. The test run also scans every source, test, fixture and document for household details using the linked core's rules.

When testing several plugin sources together, provide a shared fixture with the required settings for all of them:

```sh
node <core>/scripts/run-tests.mjs --plugins <this-source> --plugins <another-source> --site <shared-fixture.json>
```

Core loads every supplied source for each test run. Without `--site`, each run uses its own source's fixture;
this source's minimal fixture cannot satisfy configuration requirements imposed by unrelated plugins.

Versioned plugin sources are updated together with core using the core update command. Keep household plugins in a separate private source; do not copy private deployment scripts, configuration or history into this repository.

## Licence

MIT, see [LICENSE](LICENSE).
