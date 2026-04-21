#!/bin/zsh
set -u

remote_to_https() {
  local remote="$1"
  if [[ -z "$remote" ]]; then
    return 1
  fi

  remote="${remote%.git}"
  if [[ "$remote" == git@github.com:* ]]; then
    print -r -- "https://github.com/${remote#git@github.com:}"
    return 0
  fi

  if [[ "$remote" == https://github.com/* ]]; then
    print -r -- "$remote"
    return 0
  fi

  return 1
}

recipient=$(git config --local --get notify.nateRecipient 2>/dev/null || true)
[[ -n "$recipient" ]] || exit 0

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
repo_name=$(basename "$repo_root")
full_hash=$(git rev-parse HEAD 2>/dev/null) || exit 0
short_hash=$(git rev-parse --short=7 HEAD 2>/dev/null) || exit 0
subject=$(git log -1 --pretty=%s 2>/dev/null) || exit 0
remote=$(git remote get-url --push origin 2>/dev/null || git remote get-url origin 2>/dev/null || true)
base_url=$(remote_to_https "$remote" 2>/dev/null || true)
commit_url=""
if [[ -n "$base_url" ]]; then
  commit_url="$base_url/commit/$full_hash"
fi

message="$repo_name $short_hash $subject"
if [[ -n "$commit_url" ]]; then
  message="$message
$commit_url"
fi

if [[ "${PHANTOM3_NOTIFY_DRY_RUN:-0}" == "1" ]]; then
  print -r -- "$message"
  exit 0
fi

/usr/bin/osascript <<'APPLESCRIPT' "$recipient" "$message"
on run argv
  set targetHandle to item 1 of argv
  set targetMessage to item 2 of argv

  tell application "Messages"
    try
      set targetService to 1st service whose service type = iMessage
      set targetBuddy to buddy targetHandle of targetService
      send targetMessage to targetBuddy
    on error
      set targetService to 1st service whose service type = SMS
      set targetBuddy to buddy targetHandle of targetService
      send targetMessage to targetBuddy
    end try
  end tell
end run
APPLESCRIPT
