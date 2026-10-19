# monzo-omarchy

Omarchy 4 bar widget showing Monzo balances (personal, Flex), pots and the
last 7 days of transactions, via the Monzo Developer API (personal use only).

## Layout
- `cli/monzo-omarchy.ts` – zero-dependency TypeScript CLI run by `/usr/bin/node`
  (type stripping). Owns OAuth + API calls; writes `snapshot.json`.
- `bin/monzo-omarchy` – wrapper, symlinked to `~/.local/bin`.
- `plugin/` – Quickshell plugin `martin.monzo` (`Panel.qml`, `Model.js`).
  Renders `snapshot.json` only; never sees credentials.

## Files
- `~/.config/monzo-omarchy/config.json` – client id/secret/redirect (0600)
- `~/.local/state/monzo-omarchy/tokens.json` – access + single-use refresh token (0600)
- `~/.local/state/monzo-omarchy/snapshot.json` – data the panel draws (0600)

## Commands
`monzo-omarchy login [--reconfigure] | refresh | status | debug | logout`
(exit 0 ok, 2 needs login, 1 error)

## Install / update
    ./install.sh             # copy plugin, link CLI, rescan + enable
    omarchy-restart-shell    # needed after QML changes: the shell's hot reload
                             # re-uses the cached compiled component

## Panel keys
Click / Enter on icon opens (and refreshes) · middle-click refreshes ·
`r` refresh · `j`/`k` scroll · Esc close · Enter logs in when logged out.

## Notes
- Flex `/balance` returns the amount owed as a negative balance.
- After a login the API can fetch full history for 5 minutes, then only 90 days;
  this tool only ever asks for 7 days.
- Client: confidential, redirect `http://localhost:47821/callback`.
