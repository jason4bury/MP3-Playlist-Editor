const pkg = require('./package.json');

// package.json has to hold a semver version (1.0.0, 1.2.0, 1.10.0). The house style shows it as
// v<major>.<minor> with a two-digit minor (v1.00, v1.02, v1.10), matching the CHANGELOG, the Git
// tags and the Docker image tags. The patch number is always 0.
const [major, minor] = String(pkg.version).split('.');
const DISPLAY_VERSION = `${major}.${String(minor || 0).padStart(2, '0')}`;

module.exports = { pkg, DISPLAY_VERSION };
