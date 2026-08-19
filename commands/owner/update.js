'use strict';

/**
 * Owner-only source updater.
 *
 * The downloaded repository is overlaid onto the current project, but runtime
 * state is deliberately excluded. This keeps SQLite settings, auth/session
 * files, secrets, dependencies, and Replit/Heroku process configuration intact.
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const config = require('../../config');
const database = require('../../database');

const DEFAULT_UPDATE_URL = 'https://github.com/supreme-Lord2/xjx/archive/refs/heads/main.zip';
const MAX_ARCHIVE_BYTES = 80 * 1024 * 1024;

const PROTECTED_ROOTS = new Set([
  '.env',
  '.env.local',
  '.git',
  '.replit',
  'replit.nix',
  'Procfile',
  'app.json',
  'node_modules',
  'database',
  'session',
  'data',
  'tmp',
  'temp',
  'attached_assets',
]);

function updateUrl() {
  return String(config.updateZipUrl || DEFAULT_UPDATE_URL).trim() || DEFAULT_UPDATE_URL;
}

function isProtected(relativePath) {
  const normalized = relativePath.split(path.sep).filter(Boolean);
  return normalized.length > 0 && PROTECTED_ROOTS.has(normalized[0]);
}

function safeArchivePath(root, entryName) {
  const normalizedName = String(entryName || '').replace(/\\/g, '/');
  if (!normalizedName || normalizedName.endsWith('/')) return null;
  if (normalizedName.includes('\0') || normalizedName.startsWith('/')) {
    throw new Error(`Unsafe archive path: ${normalizedName}`);
  }
  const destination = path.resolve(root, normalizedName);
  const relative = path.relative(root, destination);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..') {
    throw new Error(`Unsafe archive path: ${normalizedName}`);
  }
  return destination;
}

async function downloadArchive(url, target) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > MAX_ARCHIVE_BYTES) throw new Error('Update archive is too large');

  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > MAX_ARCHIVE_BYTES) throw new Error('Update archive is too large');
  await fsp.writeFile(target, data);
}

async function extractArchive(archivePath, extractRoot) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(archivePath);
  const entries = zip.getEntries();
  if (!entries.length) throw new Error('Update archive is empty');

  for (const entry of entries) {
    const destination = safeArchivePath(extractRoot, entry.entryName);
    if (!destination) continue;
    const relative = path.relative(extractRoot, destination);
    if (isProtected(relative)) continue;
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.writeFile(destination, entry.getData());
  }

  // GitHub source archives contain one top-level directory (for example
  // xjx-main). Return that directory rather than copying the wrapper itself.
  const topLevel = (await fsp.readdir(extractRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory());
  if (topLevel.length === 1) return path.join(extractRoot, topLevel[0].name);
  return extractRoot;
}

async function overlaySource(sourceRoot, projectRoot) {
  const entries = await fsp.readdir(sourceRoot, { withFileTypes: true });
  let copied = 0;

  for (const entry of entries) {
    const relative = entry.name;
    if (isProtected(relative)) continue;
    const source = path.join(sourceRoot, entry.name);
    const destination = path.join(projectRoot, entry.name);
    await fsp.cp(source, destination, {
      recursive: true,
      force: true,
      errorOnExist: false,
      filter: (candidate) => {
        const candidateRelative = path.relative(sourceRoot, candidate);
        return !isProtected(candidateRelative);
      },
    });
    copied += 1;
  }
  return copied;
}

module.exports = {
  name: 'update',
  aliases: ['upgrade', 'updatebot'],
  category: 'owner',
  description: 'Download and apply the latest bot code without deleting settings or session',
  usage: '.update',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    const workRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'june-update-'));
    const archivePath = path.join(workRoot, 'update.zip');
    const extractRoot = path.join(workRoot, 'source');

    try {
      await extra.reply('⏳ Downloading the latest update from GitHub…');
      await downloadArchive(updateUrl(), archivePath);
      await fsp.mkdir(extractRoot, { recursive: true });
      const sourceRoot = await extractArchive(archivePath, extractRoot);
      const copied = await overlaySource(sourceRoot, path.resolve(__dirname, '../..'));

      // Ensure settings and the current auth state are durable before the
      // process manager restarts the bot with the updated source.
      await database.flushBackup?.();
      await database.flushRemoteAuthMirror?.('update');

      await extra.reply(
        `✅ Update installed successfully.\n` +
        `📦 Updated ${copied} top-level project entries.\n` +
        `🗄️ Database and settings preserved.\n` +
        `🔐 WhatsApp session preserved.\n\n` +
        `🔁 Restarting now…`
      );

      setTimeout(() => process.exit(1), 800);
    } catch (error) {
      console.error('[UPDATE] Failed:', error);
      await extra.reply(`❌ Update failed: ${error.message}`);
    } finally {
      await fsp.rm(workRoot, { recursive: true, force: true }).catch(() => {});
    }
  },
};