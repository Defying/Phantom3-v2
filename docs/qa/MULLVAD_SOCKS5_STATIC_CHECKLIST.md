# Mullvad SOCKS5 container-only static checklist

Use this when reviewing the container-only Mullvad proxy path without starting a host VPN or enabling live trading.

Commit tested: `__________________`
Operator: `__________________`
Date: `__________________`

## 1) Secret hygiene

- [ ] Mullvad WireGuard `.conf` files live only under `./runtime/mullvad/` or another ignored local path
- [ ] `git check-ignore -v runtime/mullvad/wireguard.conf` reports that the runtime secret path is ignored
- [ ] no Mullvad config archive, extracted `.conf`, or private material appears in `git status`
- [ ] `PHANTOM3_V2_ENV_FILE` points at a local env file for real runs, not a committed secret file

## 2) Static verification

- [ ] `npm run verify:mullvad-config-safety` passes
- [ ] `npm run verify:mullvad-socks5` passes
- [ ] `docker compose -f docker-compose.mullvad-socks5.example.yml --env-file .env.mullvad-socks5.example config -q` passes
- [ ] `npm run verify:paper-safe` still passes
- [ ] the Mullvad compose example stays paper-only and does not introduce live credentials

## 3) Compose and transport wiring

- [ ] `mullvad-socks5` drops capabilities instead of requesting `NET_ADMIN`
- [ ] the Mullvad service exposes SOCKS5 only to the Compose network, not to the host
- [ ] the Mullvad service mounts exactly one WireGuard config as a read-only secret
- [ ] the app service sets `PHANTOM3_V2_POLYMARKET_PROXY_URL=socks5h://mullvad-socks5:1080`
- [ ] the app service does **not** set `ALL_PROXY`, `HTTP_PROXY`, or `HTTPS_PROXY`
- [ ] the app service does **not** use `network_mode: host` or `network_mode: service:mullvad-socks5`

## 4) Safety assertions

- [ ] validation stayed static or `docker compose config`-only, with no host-local VPN startup
- [ ] the dashboard remains intended for localhost, LAN, or a trusted private tunnel only
- [ ] no live-trading enablement or live credentials were introduced
- [ ] the proxy path is described as container-only egress, not geoblock bypass

Notes:

```text

```
