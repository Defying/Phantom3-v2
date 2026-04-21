#!/usr/bin/env bash
set -euo pipefail

ROOT="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_PATH="$ROOT/scripts/phantom3-runtime.sh"
LAUNCHD_TEMPLATE="$ROOT/scripts/launchd/io.phantom3.v2.paper-runtime.plist.template"
LAUNCHD_LABEL="io.phantom3.v2.paper-runtime"
DEFAULT_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

ACTIVE_ENV_FILE=""
PHANTOM3_V2_HOST=""
PHANTOM3_V2_PORT=""
PHANTOM3_V2_PUBLIC_BASE_URL=""
PHANTOM3_V2_DATA_DIR=""
PHANTOM3_V2_LOG_DIR=""
RUNTIME_PID_FILE=""
RUNTIME_LOG_FILE=""
LAUNCHD_STDOUT_FILE=""
LAUNCHD_STDERR_FILE=""
LOCAL_STATUS_BASE_URL=""

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<EOF
Usage: $(basename "$0") <command> [options]

Commands:
  preflight        Install deps if needed, run type-check, build the dashboard, verify paper-safe docs
  run              Run the API in the foreground (good for launchd or manual debugging)
  start            Start the runtime in the background and wait for /api/health
  stop [--force]   Stop the background runtime recorded in ${RUNTIME_PID_FILE:-<log-dir>/runtime.pid}
  restart          Stop then start the background runtime
  status           Show pid, endpoint health, and runtime summary
  logs [-f]        Tail runtime logs
  launchd-print    Render a launchd plist for the current repo and environment
  help             Show this help

Options:
  --skip-install   Do not run npm install automatically when node_modules is missing
  --skip-build     Do not rebuild the dashboard before run/start
  --force          Escalate stop from SIGTERM to SIGKILL after the grace period
  -f, --follow     Follow logs after printing the tail

Environment:
  PHANTOM3_V2_ENV_FILE can point at a non-default env file. Default: $ROOT/.env
EOF
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
      printf '%s\n' "$ROOT/$1"
      ;;
  esac
}

status_host() {
  case "$1" in
    ''|0.0.0.0|::|[::])
      printf '127.0.0.1\n'
      ;;
    *)
      printf '%s\n' "$1"
      ;;
  esac
}

load_env() {
  ACTIVE_ENV_FILE="${PHANTOM3_V2_ENV_FILE:-$ROOT/.env}"
  if [ -f "$ACTIVE_ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$ACTIVE_ENV_FILE"
    set +a
  fi

  PHANTOM3_V2_HOST="${PHANTOM3_V2_HOST:-127.0.0.1}"
  PHANTOM3_V2_PORT="${PHANTOM3_V2_PORT:-4317}"
  PHANTOM3_V2_PUBLIC_BASE_URL="${PHANTOM3_V2_PUBLIC_BASE_URL:-http://127.0.0.1:${PHANTOM3_V2_PORT}}"
  PHANTOM3_V2_DATA_DIR="$(resolve_path "${PHANTOM3_V2_DATA_DIR:-./data}")"
  PHANTOM3_V2_LOG_DIR="$(resolve_path "${PHANTOM3_V2_LOG_DIR:-./logs}")"
  RUNTIME_PID_FILE="$(resolve_path "${PHANTOM3_V2_RUNTIME_PID_FILE:-$PHANTOM3_V2_LOG_DIR/runtime.pid}")"
  RUNTIME_LOG_FILE="$(resolve_path "${PHANTOM3_V2_RUNTIME_LOG_FILE:-$PHANTOM3_V2_LOG_DIR/runtime.log}")"
  LAUNCHD_STDOUT_FILE="$(resolve_path "${PHANTOM3_V2_RUNTIME_STDOUT_FILE:-$PHANTOM3_V2_LOG_DIR/launchd.stdout.log}")"
  LAUNCHD_STDERR_FILE="$(resolve_path "${PHANTOM3_V2_RUNTIME_STDERR_FILE:-$PHANTOM3_V2_LOG_DIR/launchd.stderr.log}")"
  LOCAL_STATUS_BASE_URL="http://$(status_host "$PHANTOM3_V2_HOST"):$PHANTOM3_V2_PORT"

  export PHANTOM3_V2_HOST
  export PHANTOM3_V2_PORT
  export PHANTOM3_V2_PUBLIC_BASE_URL
  export PHANTOM3_V2_DATA_DIR
  export PHANTOM3_V2_LOG_DIR
}

ensure_dirs() {
  mkdir -p "$PHANTOM3_V2_DATA_DIR" "$PHANTOM3_V2_LOG_DIR"
}

require_safe_token() {
  if [ -z "${PHANTOM3_V2_CONTROL_TOKEN:-}" ]; then
    die "PHANTOM3_V2_CONTROL_TOKEN is not set. Copy .env.example to .env and set a fresh token first."
  fi

  if [ "${PHANTOM3_V2_CONTROL_TOKEN}" = 'replace_me_with_a_long_random_token' ]; then
    die "PHANTOM3_V2_CONTROL_TOKEN is still using the example value in $ACTIVE_ENV_FILE"
  fi

  if [ "${#PHANTOM3_V2_CONTROL_TOKEN}" -lt 16 ]; then
    die "PHANTOM3_V2_CONTROL_TOKEN must be at least 16 characters"
  fi
}

read_pid_file() {
  if [ ! -f "$RUNTIME_PID_FILE" ]; then
    return 1
  fi

  local pid
  pid="$(tr -d '[:space:]' < "$RUNTIME_PID_FILE")"
  case "$pid" in
    ''|*[!0-9]*)
      return 1
      ;;
    *)
      printf '%s\n' "$pid"
      ;;
  esac
}

pid_is_running() {
  kill -0 "$1" 2>/dev/null
}

clear_stale_pid_file() {
  local pid
  if pid="$(read_pid_file 2>/dev/null)"; then
    if ! pid_is_running "$pid"; then
      rm -f "$RUNTIME_PID_FILE"
    fi
  fi
}

curl_json() {
  require_command curl
  curl --silent --show-error --fail --max-time 2 "$LOCAL_STATUS_BASE_URL$1"
}

health_is_up() {
  curl_json '/api/health' >/dev/null 2>&1
}

print_status_json_summary() {
  local health_json="$1"
  local runtime_json="$2"

  node - "$health_json" "$runtime_json" <<'NODE'
const health = JSON.parse(process.argv[2]);
const runtime = process.argv[3] ? JSON.parse(process.argv[3]) : null;
console.log(`health: ok=${health.ok} mode=${health.mode} strategy=${health.strategyStatus} markets=${health.markets} stale=${health.marketDataStale} candidates=${health.strategyCandidates}`);
if (runtime) {
  const positions = Array.isArray(runtime.strategy?.positions) ? runtime.strategy.positions.length : 0;
  const intents = Array.isArray(runtime.strategy?.intents) ? runtime.strategy.intents.length : 0;
  const events = Array.isArray(runtime.events) ? runtime.events.length : 0;
  console.log(`state: paused=${runtime.paused} positions=${positions} intents=${intents} events=${events}`);
}
NODE
}

ensure_node_modules() {
  local skip_install="$1"

  require_command npm
  if [ -d "$ROOT/node_modules" ]; then
    return 0
  fi

  if [ "$skip_install" = '1' ]; then
    die "node_modules is missing and --skip-install was requested"
  fi

  (cd "$ROOT" && npm install)
}

build_dashboard() {
  local skip_build="$1"

  if [ "$skip_build" = '1' ]; then
    return 0
  fi

  (cd "$ROOT" && npm run build:web)
}

run_preflight() {
  local skip_install="$1"
  local skip_build="$2"

  require_safe_token
  ensure_dirs
  ensure_node_modules "$skip_install"
  (cd "$ROOT" && npm run check)
  build_dashboard "$skip_build"
  (cd "$ROOT" && npm run verify:paper-safe)

  printf 'preflight ok\n'
  printf 'env: %s\n' "$ACTIVE_ENV_FILE"
  printf 'public url: %s\n' "$PHANTOM3_V2_PUBLIC_BASE_URL"
  printf 'data dir: %s\n' "$PHANTOM3_V2_DATA_DIR"
  printf 'log dir: %s\n' "$PHANTOM3_V2_LOG_DIR"
}

run_foreground() {
  local skip_install="$1"
  local skip_build="$2"

  require_safe_token
  ensure_dirs
  ensure_node_modules "$skip_install"
  build_dashboard "$skip_build"
  cd "$ROOT"
  exec npm run start
}

wait_for_health() {
  local pid="$1"
  local attempt

  for attempt in $(seq 1 30); do
    if health_is_up; then
      return 0
    fi

    if ! pid_is_running "$pid"; then
      return 1
    fi

    sleep 1
  done

  return 1
}

print_log_hint() {
  printf 'log: %s\n' "$RUNTIME_LOG_FILE"
}

show_status() {
  clear_stale_pid_file

  local pid=''
  if pid="$(read_pid_file 2>/dev/null)"; then
    if pid_is_running "$pid"; then
      printf 'runtime: running (pid %s)\n' "$pid"
    else
      printf 'runtime: pid file exists but process is gone\n'
    fi
  else
    printf 'runtime: no background pid file\n'
  fi

  printf 'env: %s\n' "$ACTIVE_ENV_FILE"
  printf 'public url: %s\n' "$PHANTOM3_V2_PUBLIC_BASE_URL"
  printf 'local status url: %s\n' "$LOCAL_STATUS_BASE_URL"
  printf 'data dir: %s\n' "$PHANTOM3_V2_DATA_DIR"
  printf 'log dir: %s\n' "$PHANTOM3_V2_LOG_DIR"
  print_log_hint

  local health_json=''
  local runtime_json=''
  if health_json="$(curl_json '/api/health' 2>/dev/null)"; then
    printf 'endpoint: reachable\n'
    runtime_json="$(curl_json '/api/runtime' 2>/dev/null || true)"
    print_status_json_summary "$health_json" "$runtime_json"
    return 0
  fi

  printf 'endpoint: not reachable\n'
  if [ -n "$pid" ] && pid_is_running "$pid"; then
    printf 'process: pid %s is alive, but /api/health did not answer yet\n' "$pid"
  else
    printf 'process: not running under this helper, or pid file is stale\n'
  fi
  return 1
}

start_runtime() {
  local skip_install="$1"
  local skip_build="$2"

  require_safe_token
  ensure_dirs
  clear_stale_pid_file

  if health_is_up; then
    printf 'runtime already responds at %s\n' "$LOCAL_STATUS_BASE_URL"
    show_status
    return 0
  fi

  local pid=''
  if pid="$(read_pid_file 2>/dev/null)"; then
    if pid_is_running "$pid"; then
      die "runtime already has a recorded background pid ($pid). Use status or stop first."
    fi
    rm -f "$RUNTIME_PID_FILE"
  fi

  ensure_node_modules "$skip_install"
  build_dashboard "$skip_build"

  local -a run_args=(run --skip-install --skip-build)
  : >> "$RUNTIME_LOG_FILE"
  "$SCRIPT_PATH" "${run_args[@]}" >> "$RUNTIME_LOG_FILE" 2>&1 &
  pid=$!
  printf '%s\n' "$pid" > "$RUNTIME_PID_FILE"

  if ! wait_for_health "$pid"; then
    rm -f "$RUNTIME_PID_FILE"
    printf 'runtime failed to become healthy within 30s\n' >&2
    print_log_hint >&2
    tail -n 40 "$RUNTIME_LOG_FILE" >&2 || true
    exit 1
  fi

  printf 'runtime started (pid %s)\n' "$pid"
  show_status
}

stop_runtime() {
  local force="$1"
  clear_stale_pid_file

  local pid=''
  if ! pid="$(read_pid_file 2>/dev/null)"; then
    if health_is_up; then
      die "runtime is answering on $LOCAL_STATUS_BASE_URL but no helper pid file exists. It may be managed by launchd or another shell."
    fi
    printf 'runtime is not running under this helper\n'
    return 0
  fi

  if ! pid_is_running "$pid"; then
    rm -f "$RUNTIME_PID_FILE"
    printf 'runtime was already stopped\n'
    return 0
  fi

  kill -TERM "$pid"
  local attempt
  for attempt in $(seq 1 20); do
    if ! pid_is_running "$pid"; then
      rm -f "$RUNTIME_PID_FILE"
      printf 'runtime stopped\n'
      return 0
    fi
    sleep 1
  done

  if [ "$force" = '1' ]; then
    kill -KILL "$pid"
    rm -f "$RUNTIME_PID_FILE"
    printf 'runtime force-stopped\n'
    return 0
  fi

  die "runtime did not stop after 20s. Re-run stop --force if you want SIGKILL."
}

show_logs() {
  local follow="$1"

  if [ ! -f "$RUNTIME_LOG_FILE" ]; then
    die "log file not found: $RUNTIME_LOG_FILE"
  fi

  if [ "$follow" = '1' ]; then
    tail -n 80 -f "$RUNTIME_LOG_FILE"
  else
    tail -n 80 "$RUNTIME_LOG_FILE"
  fi
}

launchd_print() {
  require_command node
  [ -f "$LAUNCHD_TEMPLATE" ] || die "launchd template not found: $LAUNCHD_TEMPLATE"

  local path_value="$PATH"
  if [ -n "$path_value" ]; then
    path_value="$path_value:$DEFAULT_PATH"
  else
    path_value="$DEFAULT_PATH"
  fi

  LAUNCHD_TEMPLATE="$LAUNCHD_TEMPLATE" \
  SCRIPT_PATH="$SCRIPT_PATH" \
  REPO_ROOT="$ROOT" \
  ENV_FILE="$ACTIVE_ENV_FILE" \
  PATH_VALUE="$path_value" \
  LAUNCHD_LABEL="$LAUNCHD_LABEL" \
  LAUNCHD_STDOUT_FILE="$LAUNCHD_STDOUT_FILE" \
  LAUNCHD_STDERR_FILE="$LAUNCHD_STDERR_FILE" \
  node <<'NODE'
const fs = require('fs');
const template = fs.readFileSync(process.env.LAUNCHD_TEMPLATE, 'utf8');
const xmlEscape = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');
const replacements = {
  LAUNCHD_LABEL: process.env.LAUNCHD_LABEL,
  SCRIPT_PATH: process.env.SCRIPT_PATH,
  REPO_ROOT: process.env.REPO_ROOT,
  ENV_FILE: process.env.ENV_FILE,
  PATH_VALUE: process.env.PATH_VALUE,
  LAUNCHD_STDOUT_FILE: process.env.LAUNCHD_STDOUT_FILE,
  LAUNCHD_STDERR_FILE: process.env.LAUNCHD_STDERR_FILE
};
let rendered = template;
for (const [key, value] of Object.entries(replacements)) {
  rendered = rendered.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), xmlEscape(value));
}
process.stdout.write(rendered);
NODE
}

parse_runtime_flags() {
  local skip_install='0'
  local skip_build='0'

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --skip-install)
        skip_install='1'
        ;;
      --skip-build)
        skip_build='1'
        ;;
      *)
        die "unknown option: $1"
        ;;
    esac
    shift
  done

  printf '%s %s\n' "$skip_install" "$skip_build"
}

main() {
  local command="${1:-help}"
  shift || true

  load_env

  case "$command" in
    preflight)
      # shellcheck disable=SC2086
      set -- $(parse_runtime_flags "$@")
      run_preflight "$1" "$2"
      ;;
    run)
      # shellcheck disable=SC2086
      set -- $(parse_runtime_flags "$@")
      run_foreground "$1" "$2"
      ;;
    start)
      # shellcheck disable=SC2086
      set -- $(parse_runtime_flags "$@")
      start_runtime "$1" "$2"
      ;;
    stop)
      local force='0'
      if [ "${1:-}" = '--force' ]; then
        force='1'
        shift
      fi
      [ "$#" -eq 0 ] || die "unknown option: $1"
      stop_runtime "$force"
      ;;
    restart)
      # shellcheck disable=SC2086
      set -- $(parse_runtime_flags "$@")
      stop_runtime '0' || true
      start_runtime "$1" "$2"
      ;;
    status)
      [ "$#" -eq 0 ] || die "status does not accept extra arguments"
      show_status
      ;;
    logs)
      local follow='0'
      case "${1:-}" in
        '' ) ;;
        -f|--follow)
          follow='1'
          shift
          ;;
        *)
          die "unknown option: $1"
          ;;
      esac
      [ "$#" -eq 0 ] || die "logs accepts only -f/--follow"
      show_logs "$follow"
      ;;
    launchd-print)
      [ "$#" -eq 0 ] || die "launchd-print does not accept extra arguments"
      launchd_print
      ;;
    help|-h|--help)
      usage
      ;;
    *)
      die "unknown command: $command"
      ;;
  esac
}

main "$@"
