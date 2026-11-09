const express = require('express');
const multer = require('multer');
// archiver 8 is an ES module; Node.js 22.12+ can require() it.
const { ZipArchive } = require('archiver');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mp3info = require('./mp3-info');
const { createAuth } = require('./auth');
const { pkg, DISPLAY_VERSION } = require('./version');

const APP_NAME = 'MP3 Playlist Editor';
const REPO_URL = pkg.homepage;
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DATA_FILE = path.join(DATA_DIR, 'playlists.json');
const BACKUP_FILE = `${DATA_FILE}.bak`;
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
const UPLOAD_TMP_DIR = path.join(DATA_DIR, '.uploads');

// ---------- start-up checks ----------
// The app used to ship with APP_PASSWORD=changeme and would run with it. Now it refuses to start
// until a real password is set, unless the login screen is switched off on purpose.

const APP_PASSWORD = process.env.APP_PASSWORD || '';
const LOGIN_DISABLED = /^(1|true|yes)$/i.test(process.env.DISABLE_LOGIN || '');
const EXAMPLE_PASSWORDS = new Set(['changeme', 'change-me', 'change-this-password']);

if (!LOGIN_DISABLED) {
  if (!APP_PASSWORD) {
    console.error('APP_PASSWORD is not set. Set it in .env, or set DISABLE_LOGIN=true to run without a login screen.');
    process.exit(1);
  }
  if (EXAMPLE_PASSWORDS.has(APP_PASSWORD.toLowerCase())) {
    console.error(`APP_PASSWORD is still the example value "${APP_PASSWORD}". Set your own password in .env.`);
    process.exit(1);
  }
}

for (const dir of [DATA_DIR, AUDIO_DIR, UPLOAD_TMP_DIR]) fs.mkdirSync(dir, { recursive: true });
// Leftovers from uploads that were interrupted by a restart.
for (const f of fs.readdirSync(UPLOAD_TMP_DIR)) {
  try { fs.rmSync(path.join(UPLOAD_TMP_DIR, f), { force: true }); } catch { /* ignore */ }
}

const app = express();
app.disable('x-powered-by');
// Behind a reverse proxy, set TRUST_PROXY=true so the lockout sees real client addresses.
if (/^(1|true|yes)$/i.test(process.env.TRUST_PROXY || '')) app.set('trust proxy', true);

// Uploads go to a temp folder on disk, not memory, so a big batch of MP3s can't exhaust RAM.
const upload = multer({
  dest: UPLOAD_TMP_DIR,
  limits: { fileSize: 40 * 1024 * 1024, files: 300 },
});

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// Backups of a large library can be several MB.
app.use(express.json({ limit: '25mb' }));

// ---------- sign-in ----------

const auth = createAuth({ password: APP_PASSWORD, disabled: LOGIN_DISABLED, dataDir: DATA_DIR });
const PUBLIC_DIR = path.join(__dirname, 'public');

app.get('/healthz', (req, res) => res.json({ ok: true, version: DISPLAY_VERSION }));
app.get('/login', (req, res) => {
  if (!auth.enabled) return res.redirect('/');
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});
app.post('/login', auth.login);
app.post('/logout', auth.logout);
app.get('/api/auth-status', (req, res) => {
  res.json({ enabled: auth.enabled, name: APP_NAME, version: DISPLAY_VERSION, repo: REPO_URL });
});

app.use(auth.middleware);
app.use(express.static(PUBLIC_DIR));

// ---------- storage ----------
// Playlists live in one JSON file, keyed by playlist name. Each read returns an object with no
// prototype, so names such as "__proto__" or "constructor" are just names.

class StorageError extends Error {}

function parseStore(text) {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
  return Object.assign(Object.create(null), parsed);
}

function readAll() {
  if (!fs.existsSync(DATA_FILE)) return Object.create(null);
  try {
    return parseStore(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    // Never "reset" a damaged file: the next save would wipe every playlist. Fall back to the
    // copy taken before the last save, and refuse to carry on if that's unreadable too.
    console.error(`${DATA_FILE} can't be read (${e.message}); using ${BACKUP_FILE}.`);
    // Keep the damaged file for a look later; the next save replaces it.
    const damaged = `${DATA_FILE}.damaged-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try { if (!fs.readdirSync(DATA_DIR).some((f) => f.startsWith('playlists.json.damaged-'))) fs.copyFileSync(DATA_FILE, damaged); } catch { /* ignore */ }
    try {
      return parseStore(fs.readFileSync(BACKUP_FILE, 'utf8'));
    } catch {
      throw new StorageError('playlists.json is damaged and there is no usable playlists.json.bak. Restore a backup file into the data folder.');
    }
  }
}

function writeAll(data) {
  // Write to a temp file and rename it over the old one, so a crash mid-write can't leave a
  // half-written file. The previous version is kept as playlists.json.bak.
  const tmp = `${DATA_FILE}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(data, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (fs.existsSync(DATA_FILE)) {
    try { fs.copyFileSync(DATA_FILE, BACKUP_FILE); } catch (e) { console.error('Could not refresh playlists.json.bak:', e.message); }
  }
  fs.renameSync(tmp, DATA_FILE);
}

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

// Playlist and track ids become file and folder names, so only these characters are allowed.
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
function isSafeId(v) {
  return typeof v === 'string' && SAFE_ID.test(v);
}

const MAX_NAME_LENGTH = 200;
const MAX_FIELD_LENGTH = 500;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

// Returns a trimmed playlist (or folder) name, or null if it isn't usable.
function cleanName(v, { allowEmpty = false } = {}) {
  if (v === undefined || v === null) return allowEmpty ? '' : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return allowEmpty ? '' : null;
  if (s.length > MAX_NAME_LENGTH || CONTROL_CHARS.test(s)) return null;
  return s;
}

function cleanField(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '') // eslint-disable-line no-control-regex
    .trim()
    .slice(0, MAX_FIELD_LENGTH);
}

// A live (not deleted) playlist, or null. Deleted playlists can't be reached by name.
function getPlaylist(all, name) {
  if (typeof name !== 'string' || !Object.hasOwn(all, name)) return null;
  const pl = all[name];
  return pl && typeof pl === 'object' && !pl.deleted ? pl : null;
}

function nameTaken(all, name) {
  return Object.hasOwn(all, name) && !all[name].deleted;
}

// Every playlist has a stable internal id (independent of its display name) so its audio folder
// survives renames. Assigned for playlists created before ids existed, or with an unsafe id.
function ensurePlaylistId(all, name) {
  const pl = all[name];
  if (!isSafeId(pl.id)) {
    pl.id = newId();
    writeAll(all);
  }
  return pl.id;
}

function idInUse(all, plId, exceptKey) {
  return Object.keys(all).some((k) => k !== exceptKey && all[k] && all[k].id === plId);
}

function playlistAudioDir(plId) {
  if (!isSafeId(plId)) throw new Error('Unsafe playlist id');
  return path.join(AUDIO_DIR, plId);
}

function playlistPoolDir(plId) {
  return path.join(playlistAudioDir(plId), '_pool');
}

function trackAudioPath(plId, trackIdValue) {
  if (!isSafeId(trackIdValue)) throw new Error('Unsafe track id');
  return path.join(playlistAudioDir(plId), `${trackIdValue}.mp3`);
}

function removeAudioDir(all, plId, exceptKey) {
  // Never delete a folder another playlist still points at.
  if (!isSafeId(plId) || idInUse(all, plId, exceptKey)) return;
  try { fs.rmSync(playlistAudioDir(plId), { recursive: true, force: true }); } catch { /* ignore */ }
}

function stamp(pl) {
  pl.updatedAt = new Date().toISOString();
}

// Parse pasted text into track objects.
function parseImportText(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  return lines.map((rawLine, i) => {
    const line = rawLine.replace(/^\s*\d+[.)]\s*/, '');
    let artist = '';
    let title = line;

    const dashMatch = line.match(/^(.+?)\s+-\s+(.+)$/);
    const parenMatch = line.match(/^(.+?)\s*\(([^)]+)\)\s*$/);

    if (dashMatch) {
      artist = dashMatch[1].trim();
      title = dashMatch[2].trim();
    } else if (parenMatch) {
      title = parenMatch[1].trim();
      artist = parenMatch[2].trim();
    }

    return { id: newId(), title: cleanField(title), artist: cleanField(artist), audioFile: null, durationSec: null, createdAt: Date.now() + i };
  });
}

// ---------- filename <-> track matching ----------

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,4}$/i, '') // strip extension
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(s) {
  return new Set(normalize(s).split(' ').filter(Boolean));
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

const MATCH_THRESHOLD = 0.34;

function analyzeAudioBuffer(buf) {
  let tags = null;
  let durationSec = null;
  try { tags = mp3info.readTags(buf); } catch { /* unreadable tags: match on the filename */ }
  try { durationSec = mp3info.estimateDurationSeconds(buf); } catch { /* unknown length */ }
  return { tags, durationSec };
}

function matchFilesToTracks(files, tracks) {
  // files: [{ originalname, tags? }], tracks: [{ id, title, artist }]
  const fileSets = files.map((f) => {
    const fromName = tokenSet(f.originalname);
    if (f.tags && (f.tags.title || f.tags.artist)) {
      const fromTags = tokenSet(`${f.tags.artist || ''} ${f.tags.title || ''}`);
      return { fromName, fromTags };
    }
    return { fromName, fromTags: null };
  });
  const pairs = [];
  files.forEach((f, fi) => {
    tracks.forEach((t) => {
      const combined = tokenSet(`${t.artist || ''} ${t.title}`);
      const titleOnly = tokenSet(t.title);
      let score = Math.max(jaccard(fileSets[fi].fromName, combined), jaccard(fileSets[fi].fromName, titleOnly));
      if (fileSets[fi].fromTags) {
        // embedded ID3 tags are a stronger signal than the filename when present
        score = Math.max(score, jaccard(fileSets[fi].fromTags, combined) * 1.15);
      }
      if (score >= MATCH_THRESHOLD) pairs.push({ fi, trackId: t.id, score });
    });
  });
  pairs.sort((a, b) => b.score - a.score);

  const usedFiles = new Set();
  const usedTracks = new Set();
  const matches = [];
  for (const p of pairs) {
    if (usedFiles.has(p.fi) || usedTracks.has(p.trackId)) continue;
    usedFiles.add(p.fi);
    usedTracks.add(p.trackId);
    matches.push(p);
  }
  return { matches, usedFiles };
}

function trackKey(t) {
  return normalize(`${t.artist || ''} ${t.title}`);
}

function safePoolName(originalname) {
  return `${newId()}__${String(originalname).replace(/[^\w.-]+/g, '_').slice(0, 150)}`;
}

// Multer gives the original filename as latin1; browsers send UTF-8.
function originalName(file) {
  const name = Buffer.from(file.originalname, 'latin1').toString('utf8');
  return cleanField(path.basename(name.replace(/\\/g, '/')));
}

function discardUploads(req) {
  const files = req.files || (req.file ? [req.file] : []);
  files.forEach((f) => { try { fs.rmSync(f.path, { force: true }); } catch { /* ignore */ } });
}

// Moves an uploaded temp file into place.
function moveUpload(file, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(file.path, dest);
  } catch {
    fs.copyFileSync(file.path, dest);
    fs.rmSync(file.path, { force: true });
  }
}

const DELETED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Soft-deleted playlists are kept in the same store under a key that can't collide with a real
// playlist name (names can't contain control characters).
function deletedKeyFor(name) {
  return `\u0000deleted\u0000${Date.now()}\u0000${crypto.randomBytes(3).toString('hex')}\u0000${name}`;
}

function softDelete(all, name) {
  const pl = all[name];
  pl.deleted = true;
  pl.deletedAt = new Date().toISOString();
  pl.originalName = name;
  all[deletedKeyFor(name)] = pl;
  delete all[name];
}

function purgeExpiredDeleted(all) {
  let changed = false;
  Object.keys(all).forEach((key) => {
    const pl = all[key];
    if (pl && pl.deleted && pl.deletedAt) {
      const age = Date.now() - new Date(pl.deletedAt).getTime();
      if (age > DELETED_RETENTION_MS) {
        removeAudioDir(all, pl.id, key);
        delete all[key];
        changed = true;
      }
    }
  });
  return changed;
}

function cleanupOrphanedAudio(plId, keepTracks) {
  const dir = playlistAudioDir(plId);
  if (!fs.existsSync(dir)) return;
  const keepIds = new Set(keepTracks.map((t) => t.id));
  fs.readdirSync(dir).forEach((entry) => {
    // Only track audio files ("<trackId>.mp3"); the pool folder and cover art stay.
    if (!/\.mp3$/i.test(entry)) return;
    const trackIdValue = entry.replace(/\.mp3$/i, '');
    if (!keepIds.has(trackIdValue)) {
      try { fs.unlinkSync(path.join(dir, entry)); } catch { /* ignore */ }
    }
  });
}

function findCoverOnDisk(plId) {
  for (const [ext, mime] of [['jpg', 'image/jpeg'], ['png', 'image/png']]) {
    if (fs.existsSync(path.join(playlistAudioDir(plId), `cover.${ext}`))) return { mime, filename: `cover.${ext}` };
  }
  return null;
}

// A download filename with characters Windows can't use replaced. Non-ASCII characters are kept:
// res.attachment() sends them in the UTF-8 filename* parameter.
function downloadName(name, ext) {
  // eslint-disable-next-line no-control-regex
  const base = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/^\.+/, '').trim() || 'playlist';
  return `${base}${ext}`;
}

function trackLabel(t) {
  return t.artist ? `${t.artist} - ${t.title}` : t.title;
}

// ---------- playlist CRUD ----------

app.get('/api/playlists', (req, res) => {
  const all = readAll();
  if (purgeExpiredDeleted(all)) writeAll(all);
  const summary = Object.entries(all)
    .filter(([, pl]) => pl && !pl.deleted)
    .map(([name, pl]) => ({
      name,
      count: (pl.tracks || []).length,
      audioCount: (pl.tracks || []).filter((t) => t.audioFile).length,
      folder: pl.folder || null,
      hasCover: !!pl.cover,
      updatedAt: pl.updatedAt || null,
    }));
  res.json(summary);
});

app.get('/api/playlists/:name', (req, res) => {
  const all = readAll();
  const pl = getPlaylist(all, req.params.name);
  if (!pl) return res.status(404).json({ error: 'Playlist not found' });
  // Older versions deleted cover.jpg/png on every track save but kept the cover entry, which
  // showed as a broken image. Drop the entry if its file is gone.
  if (pl.cover) {
    const cPath = coverPath(ensurePlaylistId(all, req.params.name), pl.cover);
    if (!cPath || !fs.existsSync(cPath)) {
      pl.cover = null;
      writeAll(all);
    }
  }
  res.json({
    name: req.params.name,
    tracks: pl.tracks || [],
    poolFiles: pl.poolFiles || [],
    folder: pl.folder || null,
    cover: pl.cover || null,
  });
});

app.post('/api/playlists', (req, res) => {
  const name = cleanName(req.body.name);
  if (!name) return res.status(400).json({ error: `Give the playlist a name (up to ${MAX_NAME_LENGTH} characters)` });
  const folder = cleanName(req.body.folder, { allowEmpty: true });
  if (folder === null) return res.status(400).json({ error: 'That folder name can\'t be used' });
  const all = readAll();
  if (nameTaken(all, name)) return res.status(409).json({ error: 'Playlist already exists' });
  all[name] = {
    id: newId(),
    tracks: [],
    poolFiles: [],
    folder: folder || null,
    updatedAt: new Date().toISOString(),
  };
  writeAll(all);
  res.status(201).json({ name, tracks: [] });
});

app.put('/api/playlists/:name/folder', (req, res) => {
  const all = readAll();
  const name = req.params.name;
  const pl = getPlaylist(all, name);
  if (!pl) return res.status(404).json({ error: 'Playlist not found' });
  const folder = cleanName(req.body.folder, { allowEmpty: true });
  if (folder === null) return res.status(400).json({ error: 'That folder name can\'t be used' });
  pl.folder = folder || null;
  writeAll(all);
  res.json({ folder: pl.folder });
});

app.post('/api/playlists/:name/import', (req, res) => {
  const { text, mode } = req.body;
  if (typeof text !== 'string') return res.status(400).json({ error: 'text is required' });

  const all = readAll();
  const name = req.params.name;
  const pl = getPlaylist(all, name);
  if (!pl) return res.status(404).json({ error: 'Playlist not found' });

  const plId = ensurePlaylistId(all, name);
  const imported = parseImportText(text);

  const existing = mode === 'append' ? pl.tracks || [] : [];
  const seenKeys = new Set(existing.map(trackKey).filter(Boolean));
  const deduped = [];
  let duplicatesSkipped = 0;
  imported.forEach((t) => {
    const key = trackKey(t);
    if (key && seenKeys.has(key)) {
      duplicatesSkipped++;
      return;
    }
    if (key) seenKeys.add(key);
    deduped.push(t);
  });

  if (mode === 'append') {
    pl.tracks = [...existing, ...deduped];
  } else {
    pl.tracks = deduped;
    cleanupOrphanedAudio(plId, pl.tracks); // replacing drops orphaned audio
  }
  stamp(pl);
  writeAll(all);
  res.json({ name, tracks: pl.tracks, duplicatesSkipped });
});

app.put('/api/playlists/:name', (req, res) => {
  const { tracks } = req.body;
  if (!Array.isArray(tracks)) return res.status(400).json({ error: 'tracks must be an array' });
  const all = readAll();
  const name = req.params.name;
  const pl = getPlaylist(all, name);
  if (!pl) return res.status(404).json({ error: 'Playlist not found' });

  const plId = ensurePlaylistId(all, name);
  // The browser sends titles, artists and order. Which tracks have audio is the server's
  // business, so audioFile and durationSec come from what's already stored for that track.
  const stored = new Map((pl.tracks || []).map((t) => [t.id, t]));
  const seen = new Set();
  pl.tracks = tracks.filter((t) => t && typeof t === 'object').map((t) => {
    let tid = isSafeId(t.id) ? t.id : newId();
    if (seen.has(tid)) tid = newId(); // two rows can't share one audio file
    seen.add(tid);
    const prev = stored.get(tid);
    return {
      id: tid,
      title: cleanField(t.title),
      artist: cleanField(t.artist),
      audioFile: prev ? prev.audioFile || null : null,
      durationSec: prev && typeof prev.durationSec === 'number' ? prev.durationSec : null,
      createdAt: prev && typeof prev.createdAt === 'number' ? prev.createdAt : typeof t.createdAt === 'number' ? t.createdAt : Date.now(),
    };
  });
  cleanupOrphanedAudio(plId, pl.tracks);
  stamp(pl);
  writeAll(all);
  res.json({ name, tracks: pl.tracks });
});

app.put('/api/playlists/:name/rename', (req, res) => {
  const all = readAll();
  const name = req.params.name;
  if (!getPlaylist(all, name)) return res.status(404).json({ error: 'Playlist not found' });
  const newName = cleanName(req.body.newName);
  if (!newName) return res.status(400).json({ error: `Give the playlist a name (up to ${MAX_NAME_LENGTH} characters)` });
  if (newName === name) return res.json({ name, tracks: all[name].tracks });
  if (nameTaken(all, newName)) return res.status(409).json({ error: 'A playlist with that name already exists' });

  all[newName] = all[name];
  delete all[name];
  writeAll(all);
  res.json({ name: newName, tracks: all[newName].tracks });
});

app.post('/api/playlists/:name/duplicate', (req, res) => {
  const all = readAll();
  const name = req.params.name;
  const pl = getPlaylist(all, name);
  if (!pl) return res.status(404).json({ error: 'Playlist not found' });
  const newName = cleanName(req.body.newName);
  if (!newName) return res.status(400).json({ error: `Give the copy a name (up to ${MAX_NAME_LENGTH} characters)` });
  if (nameTaken(all, newName)) return res.status(409).json({ error: 'A playlist with that name already exists' });

  const oldPlId = ensurePlaylistId(all, name);
  const oldTracks = pl.tracks || [];
  const newTracks = oldTracks.map((t) => ({ ...t, id: newId() }));
  const newPlId = newId();

  const oldDir = playlistAudioDir(oldPlId);
  const newDir = playlistAudioDir(newPlId);
  fs.mkdirSync(newDir, { recursive: true });
  oldTracks.forEach((t, i) => {
    if (!t.audioFile || !isSafeId(t.id)) return;
    const src = path.join(oldDir, `${t.id}.mp3`);
    if (fs.existsSync(src)) {
      try { fs.copyFileSync(src, path.join(newDir, `${newTracks[i].id}.mp3`)); } catch { newTracks[i].audioFile = null; }
    } else {
      newTracks[i].audioFile = null;
    }
  });
  let cover = null;
  if (pl.cover) {
    const coverSrc = path.join(oldDir, pl.cover.filename);
    if (fs.existsSync(coverSrc)) {
      try { fs.copyFileSync(coverSrc, path.join(newDir, pl.cover.filename)); cover = pl.cover; } catch { /* copy without cover */ }
    }
  }

  all[newName] = { id: newPlId, tracks: newTracks, poolFiles: [], folder: pl.folder || null, cover, updatedAt: new Date().toISOString() };
  writeAll(all);
  res.status(201).json({ name: newName, tracks: newTracks });
});

app.delete('/api/playlists/:name', (req, res) => {
  const all = readAll();
  const name = req.params.name;
  if (!getPlaylist(all, name)) return res.status(404).json({ error: 'Playlist not found' });
  softDelete(all, name);
  writeAll(all);
  res.status(204).end();
});

function getDeleted(all, key) {
  if (typeof key !== 'string' || !Object.hasOwn(all, key)) return null;
  const pl = all[key];
  return pl && pl.deleted ? pl : null;
}

app.get('/api/deleted-playlists', (req, res) => {
  const all = readAll();
  if (purgeExpiredDeleted(all)) writeAll(all);
  const list = Object.entries(all)
    .filter(([, pl]) => pl && pl.deleted)
    .map(([key, pl]) => ({
      key,
      name: pl.originalName,
      count: (pl.tracks || []).length,
      deletedAt: pl.deletedAt,
    }))
    .sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt));
  res.json(list);
});

app.post('/api/deleted-playlists/:key/restore', (req, res) => {
  const all = readAll();
  const key = req.params.key;
  const pl = getDeleted(all, key);
  if (!pl) return res.status(404).json({ error: 'Not found in recently deleted' });

  const original = cleanName(pl.originalName) || 'Restored playlist';
  let restoreName = original;
  if (nameTaken(all, restoreName)) {
    let n = 2;
    restoreName = `${original} (restored)`;
    while (nameTaken(all, restoreName)) restoreName = `${original} (restored ${n++})`;
  }
  delete pl.deleted;
  delete pl.deletedAt;
  delete pl.originalName;
  delete all[key];
  all[restoreName] = pl;
  writeAll(all);
  res.json({ name: restoreName });
});

app.delete('/api/deleted-playlists/:key', (req, res) => {
  const all = readAll();
  const key = req.params.key;
  const pl = getDeleted(all, key);
  if (!pl) return res.status(404).json({ error: 'Not found in recently deleted' });
  removeAudioDir(all, pl.id, key);
  delete all[key];
  writeAll(all);
  res.status(204).end();
});

// ---------- whole-library backup / restore ----------
// Covers playlists, tracks, order and folders, not the attached audio itself (that lives in the
// data folder). Restoring onto the same data folder that made the backup keeps audio and cover
// art linked up, since playlist and track ids are kept and checked against disk.

app.get('/api/backup', (req, res) => {
  const all = readAll();
  const playlists = {};
  Object.entries(all).forEach(([name, pl]) => {
    if (!pl || pl.deleted) return; // don't back up the recently-deleted bin
    playlists[name] = { id: pl.id, tracks: pl.tracks || [], folder: pl.folder || null };
  });
  const day = new Date().toISOString().slice(0, 10);
  res.attachment(`mp3-playlist-editor-backup-${day}.json`);
  res.json({ app: APP_NAME, version: 1, appVersion: DISPLAY_VERSION, exportedAt: new Date().toISOString(), playlists });
});

app.post('/api/backup/restore', (req, res) => {
  const { mode, playlists } = req.body;
  if (!playlists || typeof playlists !== 'object' || Array.isArray(playlists)) {
    return res.status(400).json({ error: 'That doesn\'t look like a backup file from this app' });
  }
  const incoming = Object.entries(playlists).filter(([, pl]) => pl && typeof pl === 'object');
  const all = readAll();

  if (mode === 'replace') {
    // Existing playlists go to Recently deleted rather than vanishing, so a wrong restore can be
    // undone. One whose id comes back in the backup is replaced outright, since the restored copy
    // takes over its audio folder.
    const incomingIds = new Set(incoming.map(([, pl]) => pl.id).filter(isSafeId));
    Object.keys(all).forEach((k) => {
      const pl = all[k];
      if (!pl || pl.deleted) return;
      if (isSafeId(pl.id) && incomingIds.has(pl.id)) delete all[k];
      else softDelete(all, k);
    });
  }

  let added = 0;
  const skipped = [];
  const invalid = [];
  incoming.forEach(([rawName, pl]) => {
    const name = cleanName(rawName);
    if (!name) { invalid.push(String(rawName).slice(0, 60)); return; }
    if (nameTaken(all, name)) { skipped.push(name); return; }
    // Reuse the backup's id only if it's safe and no other playlist (live or deleted) has it.
    const plId = isSafeId(pl.id) && !idInUse(all, pl.id) ? pl.id : newId();
    const seen = new Set();
    const restoredTracks = (Array.isArray(pl.tracks) ? pl.tracks : [])
      .filter((t) => t && typeof t === 'object')
      .map((t) => {
        let tid = isSafeId(t.id) ? t.id : newId();
        if (seen.has(tid)) tid = newId();
        seen.add(tid);
        const audioExists = fs.existsSync(trackAudioPath(plId, tid));
        return {
          id: tid,
          title: cleanField(t.title),
          artist: cleanField(t.artist),
          audioFile: audioExists ? cleanField(t.audioFile) || `${tid}.mp3` : null,
          durationSec: audioExists && typeof t.durationSec === 'number' ? t.durationSec : null,
          createdAt: typeof t.createdAt === 'number' ? t.createdAt : Date.now(),
        };
      });
    const folder = cleanName(pl.folder, { allowEmpty: true });
    all[name] = {
      id: plId,
      tracks: restoredTracks,
      poolFiles: [],
      folder: folder || null,
      cover: findCoverOnDisk(plId),
      updatedAt: new Date().toISOString(),
    };
    added++;
  });

  writeAll(all);
  res.json({ added, skipped, invalid });
});

app.get('/api/search', (req, res) => {
  const q = String(req.query.q || '').toLowerCase().trim();
  if (!q) return res.json([]);
  const all = readAll();
  const results = [];
  Object.entries(all).forEach(([name, pl]) => {
    if (!pl || pl.deleted) return;
    (pl.tracks || []).forEach((t) => {
      if (String(t.title || '').toLowerCase().includes(q) || String(t.artist || '').toLowerCase().includes(q)) {
        results.push({ playlistName: name, track: t });
      }
    });
  });
  res.json(results.slice(0, 50));
});

// ---------- cover art ----------

function imageType(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', mime: 'image/png' };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  return null;
}

app.post('/api/playlists/:name/cover', upload.single('cover'), (req, res) => {
  try {
    const all = readAll();
    const name = req.params.name;
    const pl = getPlaylist(all, name);
    if (!pl) return res.status(404).json({ error: 'Playlist not found' });
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

    // Check the file itself, not just the type the browser claimed.
    const fd = fs.openSync(req.file.path, 'r');
    const head = Buffer.alloc(8);
    fs.readSync(fd, head, 0, 8, 0);
    fs.closeSync(fd);
    const type = imageType(head);
    if (!type) return res.status(400).json({ error: 'Only JPEG or PNG images are supported' });

    const plId = ensurePlaylistId(all, name);
    const dir = playlistAudioDir(plId);
    ['jpg', 'png'].forEach((e) => { try { fs.unlinkSync(path.join(dir, `cover.${e}`)); } catch { /* none yet */ } });
    moveUpload(req.file, path.join(dir, `cover.${type.ext}`));

    pl.cover = { mime: type.mime, filename: `cover.${type.ext}` };
    writeAll(all);
    res.json({ cover: pl.cover });
  } finally {
    discardUploads(req);
  }
});

function coverPath(plId, cover) {
  if (!cover || !/^cover\.(jpg|png)$/.test(cover.filename)) return null;
  return path.join(playlistAudioDir(plId), cover.filename);
}

app.get('/api/playlists/:name/cover', (req, res) => {
  const all = readAll();
  const pl = getPlaylist(all, req.params.name);
  if (!pl || !pl.cover) return res.status(404).end();
  const plId = ensurePlaylistId(all, req.params.name);
  const filePath = coverPath(plId, pl.cover);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).end();
  res.setHeader('Content-Type', pl.cover.filename.endsWith('.png') ? 'image/png' : 'image/jpeg');
  res.setHeader('Cache-Control', 'no-cache');
  fs.createReadStream(filePath).pipe(res);
});

app.delete('/api/playlists/:name/cover', (req, res) => {
  const all = readAll();
  const name = req.params.name;
  const pl = getPlaylist(all, name);
  if (!pl) return res.status(404).json({ error: 'Playlist not found' });
  if (pl.cover) {
    const filePath = coverPath(ensurePlaylistId(all, name), pl.cover);
    if (filePath) { try { fs.unlinkSync(filePath); } catch { /* already gone */ } }
    pl.cover = null;
  }
  writeAll(all);
  res.json({ cover: null });
});

app.get('/api/playlists/:name/export', (req, res) => {
  const all = readAll();
  const name = req.params.name;
  const pl = getPlaylist(all, name);
  if (!pl) return res.status(404).json({ error: 'Playlist not found' });
  const format = String(req.query.format || 'txt').toLowerCase();
  const tracks = pl.tracks || [];

  if (format === 'json') {
    res.attachment(downloadName(name, '.json'));
    return res.json({ name, tracks });
  }

  if (format === 'm3u') {
    const lines = ['#EXTM3U'];
    tracks.forEach((t) => {
      const label = trackLabel(t);
      lines.push(`#EXTINF:${typeof t.durationSec === 'number' ? t.durationSec : -1},${label}`);
      lines.push(label);
    });
    res.attachment(downloadName(name, '.m3u'));
    res.type('audio/x-mpegurl; charset=utf-8');
    return res.send(lines.join('\n'));
  }

  if (format === 'cue') {
    const tracksWithAudio = tracks.filter((t) => t.audioFile);
    if (!tracksWithAudio.length) {
      return res.status(400).json({ error: 'Attach MP3s and export the audio .zip before generating a .cue sheet' });
    }
    const pad = Math.max(4, String(tracksWithAudio.length).length);
    const lines = [];
    tracksWithAudio.forEach((t, i) => {
      const num = String(i + 1).padStart(pad, '0');
      lines.push(`FILE "${num}.mp3" MP3`);
      lines.push(`  TRACK ${String(i + 1).padStart(2, '0')} AUDIO`);
      lines.push(`    TITLE "${(t.title || '').replace(/"/g, "'")}"`);
      if (t.artist) lines.push(`    PERFORMER "${t.artist.replace(/"/g, "'")}"`);
      lines.push('    INDEX 01 00:00:00');
    });
    res.attachment(downloadName(name, '.cue'));
    res.type('text/plain; charset=utf-8');
    return res.send(lines.join('\n'));
  }

  res.attachment(downloadName(name, '.txt'));
  res.type('text/plain; charset=utf-8');
  res.send(tracks.map(trackLabel).join('\n'));
});

// ---------- audio: single-track attach/remove ----------

app.post('/api/playlists/:name/tracks/:trackId/audio', upload.single('file'), (req, res) => {
  try {
    const all = readAll();
    const name = req.params.name;
    const pl = getPlaylist(all, name);
    if (!pl) return res.status(404).json({ error: 'Playlist not found' });
    const track = (pl.tracks || []).find((t) => t.id === req.params.trackId);
    if (!track || !isSafeId(track.id)) return res.status(404).json({ error: 'Track not found' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const fileName = originalName(req.file);
    if (!/\.mp3$/i.test(fileName)) return res.status(400).json({ error: 'Only .mp3 files are supported' });

    const plId = ensurePlaylistId(all, name);
    const { tags, durationSec } = analyzeAudioBuffer(fs.readFileSync(req.file.path));
    moveUpload(req.file, trackAudioPath(plId, track.id));

    track.audioFile = fileName;
    track.durationSec = durationSec;
    if (tags) {
      if (!track.title && tags.title) track.title = cleanField(tags.title);
      if (!track.artist && tags.artist) track.artist = cleanField(tags.artist);
    }
    stamp(pl);
    writeAll(all);
    res.json({ track });
  } finally {
    discardUploads(req);
  }
});

app.delete('/api/playlists/:name/tracks/:trackId/audio', (req, res) => {
  const all = readAll();
  const name = req.params.name;
  const pl = getPlaylist(all, name);
  if (!pl) return res.status(404).json({ error: 'Playlist not found' });
  const track = (pl.tracks || []).find((t) => t.id === req.params.trackId);
  if (!track || !isSafeId(track.id)) return res.status(404).json({ error: 'Track not found' });

  const plId = ensurePlaylistId(all, name);
  try { fs.unlinkSync(trackAudioPath(plId, track.id)); } catch { /* already gone */ }
  track.audioFile = null;
  track.durationSec = null;
  stamp(pl);
  writeAll(all);
  res.json({ track });
});

// ---------- audio: bulk upload + auto-match ----------
// The browser sends large drops in batches; each batch is matched against the tracks that still
// have no audio.

app.post('/api/playlists/:name/audio/bulk', upload.array('files', 300), (req, res) => {
  try {
    const all = readAll();
    const name = req.params.name;
    const pl = getPlaylist(all, name);
    if (!pl) return res.status(404).json({ error: 'Playlist not found' });

    const files = (req.files || []).map((f) => ({ ...f, name: originalName(f) }));
    const mp3Files = files.filter((f) => /\.mp3$/i.test(f.name));
    const skippedNonMp3 = files.length - mp3Files.length;

    const plId = ensurePlaylistId(all, name);
    const unassignedTracks = (pl.tracks || []).filter((t) => !t.audioFile && isSafeId(t.id));

    // Read ID3 tags up front so matching can use them alongside filenames (one file in memory
    // at a time).
    const analyzed = mp3Files.map((f) => {
      const buf = fs.readFileSync(f.path);
      return { file: f, ...analyzeAudioBuffer(buf) };
    });

    const { matches, usedFiles } = matchFilesToTracks(
      analyzed.map((a) => ({ originalname: a.file.name, tags: a.tags })),
      unassignedTracks
    );

    matches.forEach((m) => {
      const a = analyzed[m.fi];
      moveUpload(a.file, trackAudioPath(plId, m.trackId));
      const track = pl.tracks.find((t) => t.id === m.trackId);
      track.audioFile = a.file.name;
      track.durationSec = a.durationSec;
      if (a.tags) {
        if (!track.title && a.tags.title) track.title = cleanField(a.tags.title);
        if (!track.artist && a.tags.artist) track.artist = cleanField(a.tags.artist);
      }
    });

    const unmatched = [];
    pl.poolFiles = pl.poolFiles || [];
    analyzed.forEach((a, fi) => {
      if (usedFiles.has(fi)) return;
      const poolName = safePoolName(a.file.name);
      moveUpload(a.file, path.join(playlistPoolDir(plId), poolName));
      const entry = { poolName, originalName: a.file.name, durationSec: a.durationSec, tags: a.tags };
      pl.poolFiles.push(entry);
      unmatched.push(entry);
    });

    stamp(pl);
    writeAll(all);

    res.json({
      matchedCount: matches.length,
      skippedNonMp3,
      unmatched,
      tracks: pl.tracks,
      poolFiles: pl.poolFiles,
    });
  } finally {
    discardUploads(req);
  }
});

app.post('/api/playlists/:name/tracks/:trackId/audio/from-pool', (req, res) => {
  const { poolName } = req.body;
  const all = readAll();
  const name = req.params.name;
  const pl = getPlaylist(all, name);
  if (!pl) return res.status(404).json({ error: 'Playlist not found' });
  const track = (pl.tracks || []).find((t) => t.id === req.params.trackId);
  if (!track || !isSafeId(track.id)) return res.status(404).json({ error: 'Track not found' });

  const entry = (pl.poolFiles || []).find((p) => p.poolName === poolName);
  if (!entry || path.basename(String(entry.poolName)) !== entry.poolName) return res.status(404).json({ error: 'Pool file not found' });

  const plId = ensurePlaylistId(all, name);
  const src = path.join(playlistPoolDir(plId), entry.poolName);
  if (!fs.existsSync(src)) return res.status(404).json({ error: 'Pool file missing on disk' });
  fs.renameSync(src, trackAudioPath(plId, track.id));

  pl.poolFiles = pl.poolFiles.filter((p) => p.poolName !== poolName);
  track.audioFile = entry.originalName;
  track.durationSec = typeof entry.durationSec === 'number' ? entry.durationSec : null;
  if (entry.tags) {
    if (!track.title && entry.tags.title) track.title = cleanField(entry.tags.title);
    if (!track.artist && entry.tags.artist) track.artist = cleanField(entry.tags.artist);
  }
  stamp(pl);
  writeAll(all);
  res.json({ track, poolFiles: pl.poolFiles });
});

app.delete('/api/playlists/:name/pool/:poolName', (req, res) => {
  const all = readAll();
  const name = req.params.name;
  const pl = getPlaylist(all, name);
  if (!pl) return res.status(404).json({ error: 'Playlist not found' });
  // Only files the playlist actually lists can be removed.
  const entry = (pl.poolFiles || []).find((p) => p.poolName === req.params.poolName);
  if (entry && path.basename(String(entry.poolName)) === entry.poolName) {
    const plId = ensurePlaylistId(all, name);
    try { fs.unlinkSync(path.join(playlistPoolDir(plId), entry.poolName)); } catch { /* already gone */ }
  }
  pl.poolFiles = (pl.poolFiles || []).filter((p) => p.poolName !== req.params.poolName);
  writeAll(all);
  res.json({ poolFiles: pl.poolFiles });
});

// ---------- audio: streaming (for inline preview playback) ----------

app.get('/api/playlists/:name/tracks/:trackId/audio/file', (req, res) => {
  const all = readAll();
  const name = req.params.name;
  const pl = getPlaylist(all, name);
  if (!pl) return res.status(404).end();
  const track = (pl.tracks || []).find((t) => t.id === req.params.trackId);
  if (!track || !track.audioFile || !isSafeId(track.id)) return res.status(404).end();

  const plId = ensurePlaylistId(all, name);
  const filePath = trackAudioPath(plId, track.id);
  if (!fs.existsSync(filePath)) return res.status(404).end();

  const size = fs.statSync(filePath).size;
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Accept-Ranges', 'bytes');

  const range = req.headers.range;
  if (!range) {
    res.setHeader('Content-Length', size);
    return fs.createReadStream(filePath).pipe(res);
  }

  const notSatisfiable = () => {
    res.status(416).setHeader('Content-Range', `bytes */${size}`);
    return res.end();
  };
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
  if (!match || (!match[1] && !match[2])) return notSatisfiable();
  let start;
  let end;
  if (!match[1]) {
    // "bytes=-500" means the last 500 bytes
    const suffix = parseInt(match[2], 10);
    if (!suffix) return notSatisfiable();
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = parseInt(match[1], 10);
    end = match[2] ? Math.min(parseInt(match[2], 10), size - 1) : size - 1;
  }
  if (start >= size || start > end) return notSatisfiable();
  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  res.setHeader('Content-Length', end - start + 1);
  fs.createReadStream(filePath, { start, end }).pipe(res);
});

// ---------- audio: numbered zip export ----------

app.get('/api/playlists/:name/export-audio', (req, res) => {
  const all = readAll();
  const name = req.params.name;
  const pl = getPlaylist(all, name);
  if (!pl) return res.status(404).json({ error: 'Playlist not found' });

  const plId = ensurePlaylistId(all, name);
  const tracksWithAudio = (pl.tracks || []).filter(
    (t) => t.audioFile && isSafeId(t.id) && fs.existsSync(trackAudioPath(plId, t.id))
  );

  if (!tracksWithAudio.length) {
    return res.status(400).json({ error: 'No MP3s attached to this playlist yet' });
  }

  const pad = Math.max(4, String(tracksWithAudio.length).length);

  let coverPicture = null;
  const cPath = pl.cover ? coverPath(plId, pl.cover) : null;
  if (cPath) {
    try {
      if (fs.existsSync(cPath)) coverPicture = { mime: pl.cover.mime, data: fs.readFileSync(cPath) };
    } catch { /* export without cover art */ }
  }

  res.attachment(downloadName(name, '-audio.zip'));
  res.type('application/zip');

  // The MP3s are already compressed, so store them rather than spend CPU on deflate.
  const archive = new ZipArchive({ store: true });
  archive.on('error', (err) => {
    console.error('Archive error', err);
    if (!res.headersSent) res.status(500).end();
    else res.destroy(err);
  });
  archive.pipe(res);

  const manifestLines = [];
  tracksWithAudio.forEach((t, i) => {
    const num = String(i + 1).padStart(pad, '0');
    const filePath = trackAudioPath(plId, t.id);
    let fileBuf;
    try {
      fileBuf = mp3info.writeId3v2(fs.readFileSync(filePath), { title: t.title, artist: t.artist, picture: coverPicture });
    } catch {
      fileBuf = fs.readFileSync(filePath); // fall back to the untagged original if writing fails
    }
    archive.append(fileBuf, { name: `${num}.mp3` });
    manifestLines.push(`${num}.mp3  -  ${trackLabel(t)}`);
  });
  archive.append(manifestLines.join('\r\n'), { name: 'tracklist.txt' });

  archive.finalize();
});

// ---------- errors ----------

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, _next) => {
  discardUploads(req);
  if (err instanceof multer.MulterError) {
    const messages = {
      LIMIT_FILE_SIZE: 'That file is over the 40 MB limit',
      LIMIT_FILE_COUNT: 'Too many files in one go (300 at most)',
      LIMIT_UNEXPECTED_FILE: 'Unexpected file field',
    };
    return res.status(400).json({ error: messages[err.code] || err.message });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request wasn\'t valid JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too large to upload' });
  if (err instanceof StorageError) {
    console.error(err.message);
    return res.status(500).json({ error: err.message });
  }
  console.error(err);
  if (res.headersSent) return res.destroy();
  res.status(500).json({ error: 'Something went wrong on the server. Check the container log.' });
});

// Check the data file once at start-up, so a damaged file shows in the log straight away.
try {
  readAll();
} catch (e) {
  console.error(e.message);
}

app.listen(PORT, () => {
  console.log(`${APP_NAME} v${DISPLAY_VERSION} running at http://localhost:${PORT} (data in ${DATA_DIR})`);
  if (LOGIN_DISABLED) {
    console.warn('Login screen is OFF (DISABLE_LOGIN=true): anyone who can reach this port can use the app.');
  }
});
