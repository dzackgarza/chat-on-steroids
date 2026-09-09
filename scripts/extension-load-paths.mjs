#!/usr/bin/env node
// Chromium runs an unpacked extension from wherever it was loaded, which is not where the app
// keeps its copy. An install that replaces only the app leaves the browser on whatever build was
// loaded last — ours had drifted ten days stale that way, so none of the extension's fixes ran.
//
// Prints one absolute path per line: every unpacked extension, in every local Chromium/Chrome
// profile, whose manifest name matches ours. Prints nothing when the extension was never loaded
// unpacked, which is not an error.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const UNPACKED_LOCATION = 4;

const ourName = JSON.parse(readFileSync(resolve('extension/manifest.json'), 'utf8')).name;

const browserRoots = [
  '.config/chromium',
  '.config/google-chrome',
  '.config/BraveSoftware/Brave-Browser',
  '.config/microsoft-edge',
  '.config/vivaldi'
].map((relative) => join(homedir(), relative));

function profileDirectories(root) {
  if (!existsSync(root)) return [];
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .filter((directory) => existsSync(join(directory, 'Preferences')));
}

function loadedPaths(profile) {
  let preferences;
  try {
    preferences = JSON.parse(readFileSync(join(profile, 'Preferences'), 'utf8'));
  } catch {
    return [];
  }
  const settings = preferences?.extensions?.settings;
  if (!settings || typeof settings !== 'object') return [];

  const found = [];
  for (const record of Object.values(settings)) {
    if (!record || typeof record !== 'object') continue;
    if (record.location !== UNPACKED_LOCATION) continue;
    const path = typeof record.path === 'string' ? record.path : '';
    // An unpacked path is absolute; a packed one is a relative version directory.
    if (!path.startsWith('/')) continue;
    const manifest = join(path, 'manifest.json');
    if (!existsSync(manifest)) continue;
    try {
      if (JSON.parse(readFileSync(manifest, 'utf8')).name === ourName) found.push(path);
    } catch {
      // A half-written or hand-edited manifest is not ours to guess at.
    }
  }
  return found;
}

const paths = new Set();
for (const root of browserRoots) {
  for (const profile of profileDirectories(root)) {
    for (const path of loadedPaths(profile)) paths.add(path);
  }
}

for (const path of paths) console.log(path);
