# Contributing

Thanks for helping improve `deck_neo`.

## Before opening a change

- Search the existing issues before filing a new one.
- Keep changes focused on the Stream Deck Neo, Claude Code, Codex CLI, tmux, or the documented macOS setup.
- Open an issue first for behavior changes or expanded hardware support.
- Use the security process below for vulnerabilities; do not report them in a public issue.

## Local setup and checks

Use Node 20.19 or newer, then run:

```sh
npm ci
npm test
npm run build
```

Tests use fake device and system adapters; they do not require physical hardware.

For hardware-facing changes, include the following in the pull request:

- macOS version;
- Stream Deck model;
- whether the Elgato Stream Deck app was running;
- the manual behavior you exercised on the device.

## Pull requests

- Keep each change focused and explain the user-visible effect.
- Add or update tests when behavior changes.
- Update the relevant guide when setup or integration behavior changes.
- Run the full test and build commands before pushing.
- Do not include session files, logs, absolute home-directory paths, credentials, or real project and employer names.

## Security reports

Follow [SECURITY.md](SECURITY.md) for private vulnerability reporting.
