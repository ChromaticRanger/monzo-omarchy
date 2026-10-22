#!/usr/bin/env bash
# Install from a local clone (the alternative to `omarchy plugin add <url>`).
#
# Copies the plugin into Omarchy's plugin dir (a copy, not a symlink: the
# shell's inotify hot-reload does not follow symlinks), links the CLI onto
# your PATH for convenience, and enables the widget.
#
#   ./install.sh              install / update and enable
#   ./install.sh --no-enable  install / update only
set -euo pipefail
repo="$(dirname "$(readlink -f "$0")")"
id="$(sed -n 's/^ *"id": *"\([^"]*\)".*/\1/p' "$repo/manifest.json" | head -1)"
[[ -n $id ]] || { echo "could not read id from manifest.json" >&2; exit 1; }
dest="$HOME/.config/omarchy/plugins/$id"

mkdir -p "$dest/bin" "$dest/cli" "$HOME/.local/bin"
cp -f "$repo"/{manifest.json,Panel.qml,Model.js,LICENSE} "$dest/"
cp -f "$repo/bin/monzo-omarchy" "$dest/bin/"
cp -f "$repo/cli/monzo-omarchy.ts" "$dest/cli/"
chmod +x "$dest/bin/monzo-omarchy"
ln -sfn "$dest/bin/monzo-omarchy" "$HOME/.local/bin/monzo-omarchy"
echo "Plugin installed to $dest"
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
echo "If you updated an existing install, run: omarchy-restart-shell"
