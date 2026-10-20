# Changeover

A userscript that removes ads from Twitch.

## Install

To install the script:

1. Install a userscript manager: [Violentmonkey](https://violentmonkey.github.io/) or
   [Tampermonkey](https://www.tampermonkey.net/).
2. Open
   [changeover.user.js](https://github.com/jackboykin/changeover/releases/latest/download/changeover.user.js).
   The manager shows an install page. Click **Install**.
3. Reload any open Twitch tabs.

In Chrome and other Chromium browsers, also turn on **Allow User Scripts** on the manager's
extension details page.

The manager checks for new releases and updates the script itself.

## What to expect

- During an ad break, the player shows the stream, usually at the same quality.
- The first break after you open a channel can play at lower quality.

## Report a problem

If an ad plays or the stream stalls, press Ctrl+Shift+L in that tab right away. The tab downloads a
log of what the script did, and you can attach it to an issue. The log includes the channels you
watched and your browser version.

## How it works

Twitch marks an ad break inside the stream's playlist. When the script sees the marker, it requests
the same channel as an embedded player, a pop-out player, and the Android app, and serves the
player the first ad-free playlist. The web players carry source quality, and the Android app is
the fallback at lower quality. If all three are mid-ad, the script serves the original playlist and
answers each ad segment with empty video.

A backup can arrive in another format than the stream: Twitch serves HEVC as fMP4 and AVC as
MPEG-TS. The player can't follow that change inside one rendition, so the script switches the player
to its own rendition in the backup's format for the break, and back after. If the player has no such
rendition, the script reloads the player when the break ends, which keeps audio in sync. After any
break, the script restarts playback if it stops moving.

## Development

To build the script, install [Bun](https://bun.sh/) and run the build. It writes
`dist/changeover.user.js`:

```sh
bun install
bun run build
```

To check a change, run the tests, type checker, linter, and formatter:

```sh
bun test
bun run typecheck
bun run lint
bun run format
```

To summarize a downloaded log, run the analyzer on it:

```sh
bun run scripts/analyze-trace.ts TRACE_FILE
```

`TRACE_FILE` is the path to the log.

To publish a release, set `version` in `package.json`, commit, then push a matching tag. The
release workflow tests and builds the script and attaches it to a GitHub release. Userscript managers
update only when the version goes up.

```sh
git tag vVERSION
git push origin vVERSION
```

`VERSION` is the new `version` from `package.json`.
