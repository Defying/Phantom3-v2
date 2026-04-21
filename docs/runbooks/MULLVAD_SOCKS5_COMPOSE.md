# Mullvad SOCKS5 Compose overlay

This overlay adds a **container-only** Mullvad WireGuard plus SOCKS5 sidecar for Phantom3 v2.

It is designed so:
- the host machine keeps its normal routing
- the proxy is reachable only on the internal Compose network
- Phantom3 stays containerized
- only explicitly scoped Polymarket traffic uses the proxy

## Files

- `docker-compose.example.yml`: base Phantom3 app container
- `docker-compose.mullvad.example.yml`: optional Mullvad SOCKS5 overlay
- `docker-compose.mullvad-socks5.example.yml`: static verification model
- `docker/mullvad/wireproxy.conf`: committed sidecar config
- `runtime/mullvad/wireguard.conf`: gitignored local input created by `scripts/prepare-mullvad-wireguard-config.sh`

## Why this shape

The overlay uses `wireproxy`, a **userspace** WireGuard client that exposes a SOCKS5 proxy.

That means:
- no host-local VPN changes
- no `/dev/net/tun` mount
- no `NET_ADMIN` capability
- no accidental host-wide egress hijack

The real Mullvad `.conf` is mounted into the sidecar as a Docker secret at `/run/secrets/mullvad-wg.conf`.

## Setup

1. Prepare exactly one Mullvad WireGuard config with:

```bash
./scripts/prepare-mullvad-wireguard-config.sh --source /path/to/mullvad_bundle.zip --select ca-mtr-wg-001.conf
```

2. Start the stack with both compose files:

```bash
docker compose \
  -f docker-compose.example.yml \
  -f docker-compose.mullvad.example.yml \
  --env-file ./runtime/mullvad/compose.env \
  up -d
```

3. Keep `PHANTOM3_V2_POLYMARKET_PROXY_URL=socks5h://mullvad-socks5:1080` in your app env when you want the scoped Polymarket route enabled.

## Routing model

The current Phantom3 paper-safe bootstrap does **not** globally proxy the process.

Instead:
- `PHANTOM3_V2_POLYMARKET_PROXY_URL` scopes SOCKS5 routing only to Polymarket Gamma + CLOB reads
- dashboard, local health checks, Fastify binds, and browser traffic stay direct
- the runtime keeps a read-only `PHANTOM3_V2_POLYMARKET_OPERATOR_ELIGIBILITY` scaffold and fails closed if you mark access as `restricted`

Do **not** switch to broad `ALL_PROXY` or `HTTPS_PROXY` process-wide proxying if you want to keep the control plane and local traffic direct.

## Validation

Static validation:

```bash
npm run verify:mullvad-config-safety
npm run verify:mullvad-socks5
docker compose -f docker-compose.mullvad-socks5.example.yml --env-file .env.mullvad-socks5.example config -q
```

This validates the compose topology and proxy wiring without changing host routing.
