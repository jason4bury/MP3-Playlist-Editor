// Single-password sign-in: sessions that survive a restart, and a lockout after too many wrong
// passwords. Good for keeping the app off-limits to "anyone on the network"; put it behind HTTPS
// before exposing it to the internet.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const LOCKOUT_MAX_FAILURES = 10;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000; // 10 wrong passwords in 15 minutes...
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // ...locks that address out for 15 minutes
const COOKIE_NAME = 'session';

// Paths that work without signing in: the sign-in page itself, its assets, and the health check.
const PUBLIC_PATHS = new Set([
  '/login', '/login.js', '/logout', '/healthz', '/favicon.ico', '/apple-touch-icon.png', '/icon.png',
  '/api/auth-status',
]);

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie;
  if (!header) return cookies;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    try {
      cookies[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
    } catch {
      // a malformed cookie from another app on the same host: ignore it
    }
  });
  return cookies;
}

function isHttps(req) {
  return req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function createAuth({ password, disabled, dataDir }) {
  const sessionsFile = path.join(dataDir, 'sessions.json');
  // Only a hash of each session token is stored, so the file can't be used to sign in.
  let sessions = new Map(); // sha256(token) -> expiry (ms)
  const failures = new Map(); // address -> { count, firstAt, lockedUntil }

  function loadSessions() {
    try {
      const raw = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
      const now = Date.now();
      sessions = new Map(Object.entries(raw).filter(([, exp]) => typeof exp === 'number' && exp > now));
    } catch {
      sessions = new Map();
    }
  }

  function saveSessions() {
    const now = Date.now();
    for (const [k, exp] of sessions) if (exp <= now) sessions.delete(k);
    const tmp = `${sessionsFile}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(sessions)));
      fs.renameSync(tmp, sessionsFile);
    } catch (e) {
      console.error('Could not save sessions:', e.message);
    }
  }

  function isValidSession(token) {
    if (!token) return false;
    const exp = sessions.get(sha256(token));
    return typeof exp === 'number' && exp > Date.now();
  }

  function clientAddress(req) {
    return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  }

  function lockedFor(addr) {
    const f = failures.get(addr);
    if (!f || !f.lockedUntil) return 0;
    const left = f.lockedUntil - Date.now();
    if (left <= 0) { failures.delete(addr); return 0; }
    return left;
  }

  function recordFailure(addr) {
    const now = Date.now();
    let f = failures.get(addr);
    if (!f || now - f.firstAt > LOCKOUT_WINDOW_MS) f = { count: 0, firstAt: now, lockedUntil: 0 };
    f.count++;
    if (f.count >= LOCKOUT_MAX_FAILURES) f.lockedUntil = now + LOCKOUT_DURATION_MS;
    failures.set(addr, f);
    // Keep the map from growing without limit.
    if (failures.size > 10000) failures.clear();
  }

  function passwordMatches(submitted) {
    // Compare fixed-length hashes so the comparison takes the same time whatever the length.
    const a = Buffer.from(sha256(String(submitted)), 'hex');
    const b = Buffer.from(sha256(password), 'hex');
    return crypto.timingSafeEqual(a, b);
  }

  function cookie(req, value, maxAgeSec) {
    const parts = [`${COOKIE_NAME}=${value}`, 'HttpOnly', 'Path=/', `Max-Age=${maxAgeSec}`, 'SameSite=Lax'];
    if (isHttps(req)) parts.push('Secure');
    return parts.join('; ');
  }

  loadSessions();

  return {
    enabled: !disabled,

    login(req, res) {
      if (disabled) return res.json({ ok: true });
      const addr = clientAddress(req);
      const wait = lockedFor(addr);
      if (wait) {
        const mins = Math.ceil(wait / 60000);
        return res.status(429).json({ ok: false, error: `Too many wrong passwords. Try again in ${mins} minute${mins === 1 ? '' : 's'}.` });
      }
      const submitted = req.body && typeof req.body.password === 'string' ? req.body.password : '';
      if (!submitted || !passwordMatches(submitted)) {
        recordFailure(addr);
        return res.status(401).json({ ok: false, error: 'Incorrect password' });
      }
      failures.delete(addr);
      // A brand-new token at every sign-in; any cookie the browser already had is dropped.
      const old = parseCookies(req)[COOKIE_NAME];
      if (old) sessions.delete(sha256(old));
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(sha256(token), Date.now() + SESSION_MAX_AGE_MS);
      saveSessions();
      res.setHeader('Set-Cookie', cookie(req, token, Math.floor(SESSION_MAX_AGE_MS / 1000)));
      res.json({ ok: true });
    },

    logout(req, res) {
      const token = parseCookies(req)[COOKIE_NAME];
      if (token && sessions.delete(sha256(token))) saveSessions();
      res.setHeader('Set-Cookie', cookie(req, '', 0));
      res.status(204).end();
    },

    middleware(req, res, next) {
      if (disabled || PUBLIC_PATHS.has(req.path)) return next();
      if (isValidSession(parseCookies(req)[COOKIE_NAME])) return next();
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not signed in' });
      return res.redirect('/login');
    },
  };
}

module.exports = { createAuth };
