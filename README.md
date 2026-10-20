# Twitch Ad Block

A userscript that removes ads from Twitch.

## Install

To install the script, build it and add it to a userscript manager:

1. Install [Bun](https://bun.sh/) and a userscript manager such as
   [Tampermonkey](https://www.tampermonkey.net/).
2. Build the script:

   ```sh
   bun install
   bun run build
   ```

3. In the userscript manager, add `dist/twitch-ad-block.user.js` as a new script.
4. Reload any open Twitch tabs.

## What to expect

- During an ad break, the player shows the stream, usually at the same quality.
- The first break after you open a channel can play at lower quality.

## Report a problem

If an ad plays or the stream stalls, press Ctrl+Shift+L in that tab right away. The tab downloads a
log of what the script did, and you can attach it to an issue. The log includes the channels you
watched, your browser version, and a few raw Twitch playlists with their session IDs.

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
