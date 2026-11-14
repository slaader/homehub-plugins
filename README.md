# Home Hub plugins

Generic plugins for Home Hub 2.0, with no household configuration or third-party dependencies.

## Included

- **UniFi Network** (`unifi`): pulls network clients and hardware through the gateway API. Nothing is installed on the router. See [setup and credential handling](plugins/unifi/README.md).

## Connect a source

Use Node 22 or newer and a Home Hub 2.0 checkout. Add this source to `HOME_HUB_HOME/instance.json` under `sources.plugins` (see core `docs/storage.md`), or set `HOME_HUB_PLUGINS_DIR` to this source's `plugins` directory. Link the core package:

```sh
node <core>/scripts/plugins.mjs link --plugins <this-source>/plugins
```

Configure `plugins.unifi` and `router.adapter` in your instance's site file. Keep API keys in the hub's encrypted integration settings or a protected external key file, never in this repository.

## Tests and updates

```sh
npm test
```

Tests use a fake HTTPS gateway and dummy keys; no real router or household data is needed. The test run also scans every source, test, fixture and document for household details using the linked core's rules.

Versioned plugin sources are updated together with core using the core update command. Keep household plugins in a separate private source; do not copy private deployment scripts, configuration or history into this repository.
