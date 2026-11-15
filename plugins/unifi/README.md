# unifi: the router census from the UniFi Network API

The hub itself asks a UniFi gateway (a Dream Router, Dream Machine, Cloud Gateway, …) which clients are on the network
and in what state its own UniFi devices are, over the gateway's **UniFi Network integration API** with an **API
key**. The plugin only sends read requests; the key’s permissions depend on the gateway and its creating account. Nothing is installed on the router or on any other host, and no scheduled job is needed: the plugin provides the
router adapter `unifi-api` (core `docs/plugins.md` → The router adapter), and core shows what it returns on the router
tile, the router page (`GET /api/router`) and the inventory.

It does what core's off-box collector `scripts/collect-router-unifi.py` (integration-API backend) does, with the same
mapping, but pulled by the hub instead of pushed as a file. With this plugin in use, that collector is not needed.

**Read-only.** It sends `GET` requests only, to these paths and no others:

| Path (under `/proxy/network/integration/v1`) | What for |
|---|---|
| `/sites` | the UniFi site: the configured one, else the first listed |
| `/sites/{id}/clients?offset=…&limit=200` | the network clients (paged; at most 500, three pages) |
| `/sites/{id}/devices?offset=…&limit=200` | the gateway, switches and access points (at most 50) |
| `/info` | the Network application version |

It never changes anything on the gateway.

## What it reports

| Observation field | From |
|---|---|
| `clients[]` | each client with a MAC address and an address inside `site.json → lanCidrs` (else the /24 around the gateway, else the private ranges): `type: WIRED` → `Ethernet`, presence `reachable`; `WIRELESS` → `Wi-Fi · 2.4 GHz` / `5 GHz` / `6 GHz` (from its band field) or `Wi-Fi`, presence `associated`; anything else (VPN, …) → `Unknown`, `reachable`. Name, uplink device name and `connectedAt` come along |
| `clientCounts` | wired, wireless and other, as counted above |
| `hardware[]` | name, model, state (`ONLINE`, `OFFLINE`, …), firmware and address of each UniFi device |
| `model`, `firmware`, `routerMac` | the gateway: the device at the configured address, else the first with a gateway model (UDR, UDM, UCG, UXG), else the first device. On Linux the MAC the gateway uses on the LAN is taken from `/proc/net/arp` when it is there |
| `softwareVersion` | the Network application version (`/info`) |
| `knownClients` | every client seen in the last 90 days (at most 500): core's "known" count |

Core validates and bounds all of it (`normalizeRouter`): at most 500 clients, 50 devices, only addresses in your networks.

## Turning it on

1. **Create the API key.** In the UniFi Network app: *Settings → Control Plane → Integrations → Create API key*. Give it
   a name ("Home Hub") and copy the key: it is shown once. Use the least-privileged account and permissions
   supported by your installed Network version. The integration API also has write operations, so do not assume
   an ordinary key is read-only. This plugin enforces GET-only access independently of those permissions.
2. **Find the certificate fingerprint.** The gateway's certificate is self-signed, so the plugin trusts it by its
   SHA-256 fingerprint. On the hub's computer:

   ```sh
   node <plugin source>/plugins/unifi/scripts/fingerprint.mjs 10.0.0.1
   # {"host":"10.0.0.1","port":443,"fingerprint":"3f…"}
   ```

   or `openssl s_client -connect 10.0.0.1:443 </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256`.
   Only the TLS handshake happens; nothing else is sent. Check it once from a second computer, or against what your
   browser shows for the gateway, before you trust it.
3. **Configure** `site.json`:

   ```json
   "router": {"adapter": "unifi-api"},
   "plugins": {"unifi": {"host": "10.0.0.1", "fingerprint": "3f…"}}
   ```

4. **Give the hub the key**, one of:
   - **Administration → Integrations → UniFi Network API → Settings → API key** (preferred). It is a write-only field:
     core encrypts it in `private/integrations.json` (0600) with the instance secret box; the API answers only
     `{set: true}`, and clearing it is its own
     action; each change is a line in the access audit, without the value.
   - **A file** in the instance's private directory: `"keyFile": "unifi/api-key"` in `plugins.unifi`, then

     ```sh
     install -d -m 700 ~/home-hub/private/unifi
     (umask 077; read -rs KEY && printf '%s\n' "$KEY" > ~/home-hub/private/unifi/api-key)
     ```

     The file must be a regular file, mode 0600 and owned by the user the hub runs as; otherwise the pull fails with `key-permissions`. Symlinks at the file and paths escaping the private directory are refused. Reads are capped at 1024 bytes (`key-invalid` above that limit); the key itself is at most 512 characters.
     The field on the Integrations page wins over the file when both are set.
5. Restart the hub (the site file is read at start) and press **Test now** on the integration's card. The router tile
   and page fill within a minute.

The key is never in `site.json`, git, a log line, an error, an observation or an API answer: errors are short codes.

## Configuration: `site.json → plugins.unifi`

| Field | Default | Meaning |
|---|---|---|
| `host` | (required) | The gateway: an IPv4 address or a host name, nothing else (no scheme, port or path) |
| `port` | `443` | Its HTTPS port |
| `site` | the first site | The UniFi site, by its `internalReference` (`default`), name or id |
| `fingerprint` | none | SHA-256 of the gateway's certificate, 64 hex characters (colons allowed). Without it the certificate must verify against the system's certificate authorities and the host name, which a self-signed UniFi certificate does not (`certificate-untrusted`). Verification is never turned off |
| `keyFile` | none | The key file, relative to the instance's private directory (`HOME_HUB_PRIVATE_DIR`, `<home>/private`); no leading `/`, no `..` |
| `intervalSeconds` | `60` | How often the gateway is read, 30 to 3600 |
| `staleAfterSeconds` | 3 × interval, at least 180 | When a census counts as stale on the router page, 60 to 86400, not shorter than the interval |
| `timeoutSeconds` | `10` | Deadline for each request (connect, handshake and answer), 1 to 60 |

An unknown field or a wrong value stops the start with the field's name. Without a `plugins.unifi` section the plugin
loads but stays inert: it provides no adapter and contacts nothing. `router.adapter` must be `unifi-api` (or unset) for
core to use it; when it names another adapter (the included file adapter `unifi`, say), the plugin does not poll and its
card says so.

## How it reads

- A poller reads the gateway every `intervalSeconds`, while the integration is on and this adapter is the one in use.
  Core's `read()` gets the last observation at once and, when the last attempt is older than the interval, starts a
  pull in the background: the hub never waits for the router, and it never reads it more often than the interval
  (**Test now** reads at once).
- A failed pull reports `status: "unavailable"` with an error code, and keeps the last good census with its own
  `observedAt`, so the page shows how old it is. The codes: `key-missing`, `key-invalid`, `key-permissions`,
  `unauthorized` (401), `forbidden` (403), `rate-limited` (429), `http-<status>`, `certificate-changed` (the pin does not
  match), `certificate-untrusted` (no pin, not verifiable), `timeout`, `unreachable`, `response-too-large`,
  `invalid-response`, `no-site`, `internal-error`, and `integration-off`.
- Bounds: one deadline per request, at most 1 MiB per answer, one request per connection, at most 3 pages of clients.
- **Trust:** with a pin, the TLS handshake finishes and the certificate's fingerprint is compared first; only on a match
  is the request, with the key in its `X-API-KEY` header, written on that connection. A gateway that presents another
  certificate never sees the key.
- The last observation is kept in the plugin's data directory (`<data>/plugins/unifi/observation.json`, 0600), so a
  restart starts from it. It holds the census, never the key.

## The integration card

*Administration → Integrations → UniFi Network API* (`unifi.api`, kind `router`): its health from the last pull (no
network call), where it is configured, the switch, **Test now** (a real pull) and the write-only key. Turned off, the hub
asks the gateway nothing and the router reports the last census as unavailable (`integration-off`). Where the census
comes from is core's provenance for `/api/router`: kind `plugin`, source `unifi-api`. Core's own card `router.adapter`
stays the switch for the whole router feed. Either switch being off prevents polling and cancels an in-flight pull;
no partial response is published. The dashboard and core router page use the same selected feed.
