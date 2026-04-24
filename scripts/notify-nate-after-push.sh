#!/bin/zsh
set -u

git_pid="${1:-}"
remote_name="${2:-origin}"
refs_file="${3:-}"

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
git_common_dir=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0
cd "$repo_root" || exit 0
notify_script="$repo_root/scripts/notify-nate-commit.sh"
state_file="$git_common_dir/notify-nate-pushed.log"
branch_filter=$(git config --local --get notify.nateBranches 2>/dev/null || true)

normalize_branch_name() {
  local ref="$1"
  case "$ref" in
    refs/heads/*) print -r -- "${ref#refs/heads/}" ;;
    refs/remotes/*) print -r -- "${ref#refs/remotes/}" ;;
    refs/tags/*) print -r -- "${ref#refs/tags/}" ;;
    refs/*) print -r -- "${ref#refs/}" ;;
    *) print -r -- "$ref" ;;
  esac
}

should_notify_branch() {
  local branch_name="$1"
  local allowed_csv="$2"
  local old_ifs="$IFS"

  [[ -z "$allowed_csv" ]] && return 0

  IFS=','
  for allowed in $allowed_csv; do
    allowed="${allowed## }"
    allowed="${allowed%% }"
    [[ -z "$allowed" ]] && continue
    if [[ "$branch_name" == "$allowed" ]]; then
      IFS="$old_ifs"
      return 0
    fi
  done
  IFS="$old_ifs"
  return 1
}

cleanup() {
  [[ -n "$refs_file" ]] && rm -f "$refs_file"
}
trap cleanup EXIT

[[ -x "$notify_script" ]] || exit 0
[[ -n "$refs_file" && -f "$refs_file" ]] || exit 0

wait_for_push_to_finish() {
  local pid="$1"
  local waited=0
  while kill -0 "$pid" >/dev/null 2>&1; do
    sleep 1
    waited=$((waited + 1))
    if (( waited >= 600 )); then
      return 1
    fi
  done
  return 0
}

remote_ref_matches() {
  local remote="$1"
  local remote_ref="$2"
  local expected_sha="$3"
  local tries=0
  local current_sha=""

  while (( tries < 10 )); do
    current_sha=$(git ls-remote "$remote" "$remote_ref" 2>/dev/null | awk 'NR==1{print $1}')
    if [[ -n "$current_sha" && "$current_sha" == "$expected_sha" ]]; then
      return 0
    fi
    tries=$((tries + 1))
    sleep 1
  done

  return 1
}

commit_range_for_ref() {
  local local_sha="$1"
  local remote_sha="$2"

  if [[ "$remote_sha" == "0000000000000000000000000000000000000000" ]]; then
    git rev-list --reverse "$local_sha" --not --remotes="$remote_name" 2>/dev/null
  else
    git rev-list --reverse "$local_sha" "^$remote_sha" 2>/dev/null
  fi
}

already_notified() {
  local commit_sha="$1"
  local branch_name="$2"
  local key="$commit_sha"
  [[ -n "$branch_name" ]] && key="$commit_sha|$branch_name"
  [[ -f "$state_file" ]] && grep -qx "$key" "$state_file" 2>/dev/null
}

mark_notified() {
  local commit_sha="$1"
  local branch_name="$2"
  local key="$commit_sha"
  [[ -n "$branch_name" ]] && key="$commit_sha|$branch_name"
  touch "$state_file"
  print -r -- "$key" >> "$state_file"
}

if [[ "${WRAITH_NOTIFY_SKIP_WAIT:-0}" != "1" ]]; then
  [[ -n "$git_pid" ]] || exit 0
  wait_for_push_to_finish "$git_pid" || exit 0
fi

typeset -A seen_commits
typeset -a queued_items

while read -r local_ref local_sha remote_ref remote_sha; do
  [[ -n "${local_ref:-}" ]] || continue
  [[ "$local_sha" != "0000000000000000000000000000000000000000" ]] || continue

  if [[ "${WRAITH_NOTIFY_SKIP_REMOTE_CHECK:-0}" != "1" ]]; then
    remote_ref_matches "$remote_name" "$remote_ref" "$local_sha" || continue
  fi

  branch_name=$(normalize_branch_name "$remote_ref")
  should_notify_branch "$branch_name" "$branch_filter" || continue

  while read -r commit_sha; do
    [[ -n "$commit_sha" ]] || continue
    item_key="$commit_sha|$branch_name"
    [[ -n "${seen_commits[$item_key]:-}" ]] && continue
    seen_commits[$item_key]=1
    queued_items+=("$commit_sha|$branch_name")
  done < <(commit_range_for_ref "$local_sha" "$remote_sha")
done < "$refs_file"

for item in "${queued_items[@]}"; do
  commit_sha="${item%%|*}"
  branch_name="${item#*|}"
  [[ "$branch_name" == "$commit_sha" ]] && branch_name=""
  already_notified "$commit_sha" "$branch_name" && continue
  if "$notify_script" "$commit_sha" "$branch_name"; then
    mark_notified "$commit_sha" "$branch_name"
  fi
done

exit 0
