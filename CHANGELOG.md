# Changelog

All notable changes to MP3 Playlist Editor are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), with versions in the form
v<major>.<minor> (two-digit minor) to match the Git tags and Docker image tags. Versioning
restarted at v1.00; earlier changes (as "Tracklist" 0.0.1 to 0.5.1) are in
[docs/HISTORY-before-1.00.md](docs/HISTORY-before-1.00.md).

## [Unreleased]

## [1.00] - 2026-11-07

First release in the house style. Includes everything in the earlier history, plus:

### Added
- About dialog with the version, copyright, MIT licence and a link to the GitHub repository.
- Sign-in lockout: 10 wrong passwords from one address within 15 minutes blocks further tries
  for 15 minutes.
- Sign-in sessions are saved in the data folder, so restarting or updating the container no
  longer signs everyone out.
- Basic security headers (no framing, no MIME sniffing, same-origin referrer).
- `GET /healthz` and a Docker health check.
- Favicon, home-screen icon and a multi-size app icon.
- Restoring a backup asks Merge, Replace all or Cancel in a proper dialog.
- `.m3u` exports include each track's length when it's known.
- `.dockerignore`, ESLint config (`npm run lint`), `package-lock.json` and OCI labels on the
  image.

### Changed
- Renamed from Tracklist to MP3 Playlist Editor. Repository `MP3-Playlist-Editor`, Docker image
  `jason4bury/mp3-playlist-editor`.
- The password moves from `docker-compose.yml` to `.env`. The app refuses to start while
  `APP_PASSWORD` is empty or still `changeme`; set `DISABLE_LOGIN=true` to run without a login
  screen on purpose.
- Data location: `DATA_HOST_DIR` replaces `CONFIGS`. Leave it blank to use the
  `mp3-playlist-editor-data` Docker volume.
- "Replace all" on restore moves your current playlists to Recently deleted instead of dropping
  them (and leaving their audio on disk for ever).
- Large MP3 drops are uploaded in batches of 20 files, and uploads are written to disk rather
  than held in memory, so a big drop can't run the container out of RAM.
- Docker image pinned to Node.js 22.23.4 and built from `package-lock.json` with `npm ci`.
- Dependencies updated: multer 2, archiver 8, Express 4.22.3. `npm audit` is clean.
- The audio `.zip` stores the MP3s without recompressing them, so it builds faster.
- Backups are named `mp3-playlist-editor-backup-<date>.json`.

### Fixed
- Cover art was deleted from disk the first time a track was edited, added, removed or
  reordered after uploading it, leaving a broken image and no art in exported MP3s.
- Exports (`.txt`, `.m3u`, `.json`, `.cue` and the audio `.zip`) failed for any playlist whose
  name had a character outside Latin-1, such as an en dash or an emoji.
- A backup file could make the app delete files and folders outside its data folder: playlist
  and track ids from the file were used as folder and file names unchecked. Ids are now
  checked everywhere, and unsafe ones are replaced.
- Two playlists restored with the same id shared one audio folder, so editing one deleted the
  other's MP3s.
- Typing in a track and switching playlist (or renaming, copying, deleting or exporting) within
  half a second lost the edit, and could save the old playlist's tracks over the new one,
  deleting its audio.
- A damaged `playlists.json` was treated as empty, so the next save wiped every playlist. Saves
  are now atomic, the previous version is kept as `playlists.json.bak` and used if the main file
  can't be read.
- Playlists named `__proto__`, `constructor`, `toString` and similar couldn't be created, or
  showed up as playlists that didn't exist.
- The browser could mark a track as having audio by sending a made-up file name.
- Discarding an unassigned file could delete a file outside the playlist's folder.
- Cross-playlist search included playlists in Recently deleted.
- Streaming: "last N bytes" range requests started from the beginning of the file.
- Find & replace treated `$&`, `$1` and similar in the replacement as special patterns.
- Restores larger than 2 MB were rejected.
- The sidebar footer buttons were dark grey on dark blue in the light theme.
- The "Missing audio only" checkbox sat far from its label, and "Import file..." didn't line up
  with the buttons next to it.
- At 125% and 150% scaling the playlist title jumped to the far right when the header buttons
  wrapped.
- The dark theme hid the paste box label and the drag handles, and dialogs' close buttons were
  invisible in the light theme.
