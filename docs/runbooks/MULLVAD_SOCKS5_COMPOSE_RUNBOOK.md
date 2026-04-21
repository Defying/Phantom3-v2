# Mullvad SOCKS5 Compose runbook

This runbook covers the **container-only** Mullvad SOCKS5 path for Phantom3 v2.

It routes only the bot or application traffic that you **explicitly** point at the proxy. It does **not** change the host machine's default route, browser traffic, shell traffic, or unrelated containers.

## Scope and intent

Use this path when you want Docker Compose to keep Phantom3 venue egress inside a containerized Mullvad plus SOCKS5 stack.

Hard boundaries:
- use **Docker Compose** as the deployment path
- prepare and mount exactly **one** Mullvad `ca-mtr-wg-*.conf` file as a read-only local secret input
- keep host networking unchanged
- keep localhost and other private/internal traffic off the proxy path
- keep the runtime paper-only and live-disarmed

Do **not** use this runbook to:
- enable a host-level VPN
- export host-wide proxy variables in your shell profile, LaunchAgent, or system settings
- treat exit-region selection as permission to ignore venue rules, geoblocks, sanctions screening, KYC, or terms of service

## 1. Select one Mullvad config from the bundle

The provided bundle currently contains multiple region-matched WireGuard configs, for example `ca-mtr-wg-001.conf` through other `ca-mtr-wg-*.conf` files. Pick **one** file for the stack.

Prepare it into the gitignored runtime directory:

```bash
./scripts/prepare-mullvad-wireguard-config.sh --source /path/to/mullvad_bundle.zip --select ca-mtr-wg-001.conf
```

Operator rules:
- choose one `ca-mtr-wg-*.conf` file, not the whole bundle
- keep the file out of the repo and out of container images
- mount it read-only
- if you want a different exit later, swap to a different single file and recreate the affected services

## 2. Render the compose topology

Use the base app file plus the Mullvad overlay:

```bash
docker compose \
  -f docker-compose.example.yml \
  -f docker-compose.mullvad.example.yml \
  --env-file ./runtime/mullvad/compose.env \
  config
```

For static verification only, you can also render the combined model with:

```bash
docker compose \
  -f docker-compose.mullvad-socks5.example.yml \
  --env-file .env.mullvad-socks5.example \
  config -q
```

## 3. Start the stack

```bash
docker compose \
  -f docker-compose.example.yml \
  -f docker-compose.mullvad.example.yml \
  --env-file ./runtime/mullvad/compose.env \
  up -d
```

Do not start an ad hoc host WireGuard session as part of this flow. The point is to keep the egress path inside the container stack.

## 4. Validate the traffic boundary

After startup, confirm the Compose plan and service health:

```bash
docker compose \
  -f docker-compose.example.yml \
  -f docker-compose.mullvad.example.yml \
  --env-file ./runtime/mullvad/compose.env \
  ps
```

Check that the application container uses the scoped Polymarket proxy setting, not host-global proxy variables:

```bash
docker compose \
  -f docker-compose.example.yml \
  -f docker-compose.mullvad.example.yml \
  --env-file ./runtime/mullvad/compose.env \
  exec phantom3-v2 \
  env | grep -E 'PHANTOM3_V2_POLYMARKET_PROXY_URL|PHANTOM3_V2_POLYMARKET_OPERATOR_ELIGIBILITY|(^|_)(HTTP|HTTPS|ALL)_PROXY='
```

Expected shape:
- `PHANTOM3_V2_POLYMARKET_PROXY_URL=socks5h://mullvad-socks5:1080`
- `PHANTOM3_V2_POLYMARKET_OPERATOR_ELIGIBILITY=<your reviewed value>`
- no broad `ALL_PROXY`, `HTTP_PROXY`, or `HTTPS_PROXY` exports

Also confirm the paper runtime remains healthy and paper-only.

If the Mullvad service is unhealthy, authentication fails, or the chosen config is rejected, stop the proxied application container and investigate the container stack. Do not switch to host-level VPN changes.

## Secret handling and safety notes

- never commit Mullvad `.conf` files, private keys, or inline secret values
- never bake the selected `.conf` into an image layer
- keep the config mounted read-only from local operator-controlled storage
- review `docker compose ... config` output before `up -d`
- keep paper-safe guardrails intact, this path is about network routing, not trading readiness

## Compliance and geoblock limitations

Network path changes do not change legal, venue, or account obligations.

Treat these as hard limits:
- venue geoblocks and account restrictions still apply
- sanctions, KYC, and terms-of-service obligations still apply
- a successful connection from a given exit does not prove that usage is allowed
- if compliance requirements or venue policy are unclear, stop and get a decision before proceeding

## Rotating to a different Mullvad config

To rotate exits, prepare a different single `ca-mtr-wg-*.conf`, update `runtime/mullvad/wireguard.conf`, then recreate the affected services:

```bash
docker compose \
  -f docker-compose.example.yml \
  -f docker-compose.mullvad.example.yml \
  --env-file ./runtime/mullvad/compose.env \
  up -d --force-recreate mullvad-socks5 phantom3-v2
```

Keep the same rules during rotation: one config at a time, read-only mount, no host-level VPN changes.
