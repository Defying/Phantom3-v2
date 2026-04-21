#!/usr/bin/env bash
set -euo pipefail

ROOT="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_OUTPUT="$ROOT/runtime/mullvad/wireguard.conf"
DEFAULT_ENV_FILE="$ROOT/runtime/mullvad/compose.env"
DEFAULT_CONTAINER_PATH="/run/mullvad/wireguard.conf"

SOURCE_PATH=""
SELECT_NAME=""
OUTPUT_PATH="$DEFAULT_OUTPUT"
ENV_FILE="$DEFAULT_ENV_FILE"
CONTAINER_PATH="$DEFAULT_CONTAINER_PATH"
FORCE=0

usage() {
  cat <<'USAGE'
Usage: ./scripts/prepare-mullvad-wireguard-config.sh --source <path> [options]

Select a single Mullvad WireGuard config from a vendor zip, an extracted directory,
or a direct .conf path, then copy it into ./runtime/mullvad/ for container mounts.

Options:
  --source <path>           Required. Path to a .zip bundle, extracted directory, or .conf file
  --select <basename>       Basename of the .conf file to use when the source has multiple choices
  --output <path>           Output file path (default: ./runtime/mullvad/wireguard.conf)
  --env-file <path>         Path-only Compose env file to write (default: ./runtime/mullvad/compose.env)
  --container-path <path>   Container mount target path (default: /run/mullvad/wireguard.conf)
  --force                   Overwrite an existing output file
  -h, --help                Show this help
USAGE
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

resolve_path() {
  case "$1" in
    /*)
      printf '%s\n' "$1"
      ;;
    ~/*)
      printf '%s\n' "$HOME/${1#~/}"
      ;;
    *)
      printf '%s\n' "$PWD/$1"
      ;;
  esac
}

compose_path() {
  case "$1" in
    "$ROOT"/*)
      printf './%s\n' "${1#"$ROOT/"}"
      ;;
    *)
      printf '%s\n' "$1"
      ;;
  esac
}

pick_candidate() {
  local -a candidates=("$@")

  ((${#candidates[@]} > 0)) || die "no .conf files found in $SOURCE_PATH"

  if [[ -n "$SELECT_NAME" ]]; then
    local -a matches=()
    local candidate candidate_name
    for candidate in "${candidates[@]}"; do
      candidate_name="$(basename -- "$candidate")"
      if [[ "$candidate" == "$SELECT_NAME" || "$candidate_name" == "$SELECT_NAME" ]]; then
        matches+=("$candidate")
      fi
    done

    if ((${#matches[@]} == 0)); then
      die "could not find $SELECT_NAME in $SOURCE_PATH"
    fi

    if ((${#matches[@]} > 1)); then
      printf 'error: %s matched multiple config files in %s:\n' "$SELECT_NAME" "$SOURCE_PATH" >&2
      printf '  - %s\n' "${matches[@]}" >&2
      exit 1
    fi

    printf '%s\n' "${matches[0]}"
    return 0
  fi

  if ((${#candidates[@]} > 1)); then
    printf 'error: multiple .conf files found in %s. Re-run with --select <basename>.\n' "$SOURCE_PATH" >&2
    printf 'Available options:\n' >&2
    local candidate
    for candidate in "${candidates[@]}"; do
      printf '  - %s\n' "$(basename -- "$candidate")" >&2
    done
    exit 1
  fi

  printf '%s\n' "${candidates[0]}"
}

parse_args() {
  while (($# > 0)); do
    case "$1" in
      --source)
        (($# >= 2)) || die "--source requires a value"
        SOURCE_PATH="$(resolve_path "$2")"
        shift 2
        ;;
      --select)
        (($# >= 2)) || die "--select requires a value"
        SELECT_NAME="$2"
        shift 2
        ;;
      --output)
        (($# >= 2)) || die "--output requires a value"
        OUTPUT_PATH="$(resolve_path "$2")"
        shift 2
        ;;
      --env-file)
        (($# >= 2)) || die "--env-file requires a value"
        ENV_FILE="$(resolve_path "$2")"
        shift 2
        ;;
      --container-path)
        (($# >= 2)) || die "--container-path requires a value"
        CONTAINER_PATH="$2"
        shift 2
        ;;
      --force)
        FORCE=1
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        die "unknown option: $1"
        ;;
    esac
  done

  [[ -n "$SOURCE_PATH" ]] || die "--source is required"
  [[ -e "$SOURCE_PATH" ]] || die "source path not found: $SOURCE_PATH"
}

main() {
  parse_args "$@"

  require_command basename
  require_command chmod
  require_command cp
  require_command dirname
  require_command find
  require_command mkdir
  require_command mktemp
  require_command mv

  local source_kind selected selection_label host_path
  local -a candidates=()

  case "$SOURCE_PATH" in
    *.zip)
      require_command unzip
      source_kind=zip
      while IFS= read -r candidate; do
        candidates+=("$candidate")
      done < <(unzip -Z1 "$SOURCE_PATH" | awk '/\.conf$/ { print }')
      selected="$(pick_candidate "${candidates[@]}")"
      selection_label="$(basename -- "$selected")"
      ;;
    *.conf)
      source_kind=conf
      selected="$SOURCE_PATH"
      selection_label="$(basename -- "$SOURCE_PATH")"
      ;;
    *)
      if [[ -d "$SOURCE_PATH" ]]; then
        source_kind=directory
        while IFS= read -r candidate; do
          candidates+=("$candidate")
        done < <(find "$SOURCE_PATH" -type f -name '*.conf' | sort)
        selected="$(pick_candidate "${candidates[@]}")"
        selection_label="$(basename -- "$selected")"
      else
        die "unsupported source type: $SOURCE_PATH"
      fi
      ;;
  esac

  mkdir -p "$(dirname -- "$OUTPUT_PATH")" "$(dirname -- "$ENV_FILE")"
  chmod 700 "$(dirname -- "$OUTPUT_PATH")" || true

  if [[ -e "$OUTPUT_PATH" && "$FORCE" != '1' ]]; then
    die "output file already exists: $OUTPUT_PATH (re-run with --force to overwrite)"
  fi

  local tmp_file
  tmp_file="$(mktemp "$(dirname -- "$OUTPUT_PATH")/.wireguard.XXXXXX")"
  trap 'rm -f "$tmp_file"' EXIT
  chmod 600 "$tmp_file"

  case "$source_kind" in
    zip)
      unzip -p "$SOURCE_PATH" "$selected" > "$tmp_file"
      ;;
    conf|directory)
      cp "$selected" "$tmp_file"
      ;;
  esac

  mv -f "$tmp_file" "$OUTPUT_PATH"
  chmod 600 "$OUTPUT_PATH"
  trap - EXIT

  host_path="$(compose_path "$OUTPUT_PATH")"
  umask 077
  cat > "$ENV_FILE" <<ENVFILE
# Generated by scripts/prepare-mullvad-wireguard-config.sh
# Paths only. Do not put secret values in this file.
PHANTOM3_V2_MULLVAD_WIREGUARD_HOST_PATH=$host_path
PHANTOM3_V2_MULLVAD_WIREGUARD_CONTAINER_PATH=$CONTAINER_PATH
ENVFILE
  chmod 600 "$ENV_FILE"

  printf 'Prepared Mullvad WireGuard config for container runtime use.\n'
  printf 'Selected config: %s\n' "$selection_label"
  printf 'Runtime file: %s\n' "$OUTPUT_PATH"
  printf 'Compose env: %s\n' "$ENV_FILE"
  printf 'Mount target: %s\n' "$CONTAINER_PATH"
  printf 'Next step: copy examples/mullvad/mount-snippet.example.yml into the proxy/VPN sidecar and mount the runtime file read-only.\n'
}

main "$@"
