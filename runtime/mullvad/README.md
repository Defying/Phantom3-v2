# runtime/mullvad

This directory is a gitignored drop zone for local Mullvad WireGuard inputs.

Safe uses:
- temporary copy of a vendor zip
- extracted `.conf` files
- generated `wireguard.conf` created by `./scripts/prepare-mullvad-wireguard-config.sh`
- generated `compose.env` with mount paths only, never secret values

Everything here stays untracked except this README and `.gitignore`.
Do not rename this directory into a tracked location.
