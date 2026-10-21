#!/usr/bin/env bash
# Copies the plugin into Omarchy's plugin dir (a copy, not a symlink: the
# shell's inotify hot-reload does not follow symlinks) and links the CLI.
set -euo pipefail
repo="$(dirname "$(readlink -f "$0")")"
id="chromaticranger.monzo"
dest="$HOME/.config/omarchy/plugins/$id"
mkdir -p "$dest" "$HOME/.local/bin"
cp -f "$repo"/plugin/* "$dest/"
ln -sfn "$repo/bin/monzo-omarchy" "$HOME/.local/bin/monzo-omarchy"
echo "Plugin copied to $dest"
echo "CLI linked at ~/.local/bin/monzo-omarchy"

# Make the shell notice the plugin, then enable it once (no-op if already on).
if command -v omarchy-shell >/dev/null; then
  omarchy-shell shell rescanPlugins >/dev/null
  for _ in $(seq 20); do
    omarchy-shell shell listPlugins 2>/dev/null | grep -q "\"$id\"" && break
    sleep 0.25
  done
  if [[ ${1:-} != --no-enable ]] && ! grep -q "\"$id\"" "$HOME/.config/omarchy/shell.json" 2>/dev/null; then
    omarchy plugin enable "$id"
  fi
fi
