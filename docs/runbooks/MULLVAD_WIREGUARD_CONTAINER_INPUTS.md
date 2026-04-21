# Mullvad WireGuard container inputs

Use this flow when a container-only Mullvad sidecar or SOCKS5 proxy service needs a WireGuard config file mounted at runtime.

## Goals

- keep vendor WireGuard material out of git
- support either a Mullvad zip bundle or an already extracted `.conf` file
- give Compose a stable, read-only mount path
- avoid any host-level VPN changes

## Tracked assets in this repo

- `./scripts/prepare-mullvad-wireguard-config.sh`
- `./runtime/mullvad/.gitignore`
- `./examples/mullvad/compose.env.example`
- `./examples/mullvad/mount-snippet.example.yml`
- `./.githooks/pre-commit`

## Runtime-only paths

The script writes these local files under `./runtime/mullvad/`:

- `wireguard.conf`, the selected config copied with restrictive permissions
- `compose.env`, optional path-only env values for Compose interpolation

Those files are gitignored and the pre-commit hook rejects attempts to stage them.

## Prepare a selected config

From a vendor zip bundle:

```bash
./scripts/prepare-mullvad-wireguard-config.sh --source /path/to/mullvad-wireguard.zip --select <config-name>.conf
```

From an extracted directory:

```bash
./scripts/prepare-mullvad-wireguard-config.sh --source /path/to/extracted-configs --select <config-name>.conf
```

From a single `.conf` file:

```bash
./scripts/prepare-mullvad-wireguard-config.sh --source /path/to/<config-name>.conf
```

If the source contains more than one `.conf` file and `--select` is omitted, the script lists the available basenames and exits without copying anything.

## Mount into the proxy container

Copy the bind-mount example from `examples/mullvad/mount-snippet.example.yml` into the Mullvad sidecar or SOCKS5 proxy service. The default host path is `./runtime/mullvad/wireguard.conf` and the default container path is `/run/mullvad/wireguard.conf`.

If you need explicit env interpolation, copy `examples/mullvad/compose.env.example` or source the generated `./runtime/mullvad/compose.env`. Keep those files path-only.

## Safety notes

- Do not commit vendor zip bundles, extracted configs, or selected `.conf` files.
- Do not paste private keys, addresses, or endpoints into docs, examples, or logs.
- The helper script prints file paths and selection names only, never config contents.
- This flow is for container-scoped networking only. It does not modify the host VPN state.
