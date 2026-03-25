/**
 * Update Command - Clean update from GitHub repo (Owner Only)
 * Repo: https://github.com/Vinpink2/June-X-Ultra
 *
 * Clean update flow:
 *   1. Download latest ZIP from GitHub
 *   2. Extract to a temp folder
 *   3. Delete existing bot files (excluding preserved dirs)
 *   4. Copy new files in
 *   5. Restart
 *
 * Preserved (never touched): node_modules, session, tmp, temp, database, config.js, .env
 */

const { exec } = require('child_process');
const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');

const GITHUB_USER = 'Vinpink2';
const GITHUB_REPO = 'June-X-Ultra';
const GITHUB_BRANCH = 'main';
const ZIP_URL = `https://github.com/${GITHUB_USER}/${GITHUB_REPO}/archive/refs/heads/${GITHUB_BRANCH}.zip`;

// Dirs/files that are never deleted or overwritten
const PRESERVED = new Set([
  'node_modules',
  '.git',
  'session',
  'tmp',
  'temp',
  'database',
  'config.js',
  '.env',
  '.env.local',
]);

const MAX_REDIRECTS = 5;

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || stdout || err.message || '').toString().trim()));
      resolve((stdout || '').toString().trim());
    });
  });
}

async function extractZip(zipPath, outDir) {
  if (process.platform === 'win32') {
    await run(`powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${outDir.replace(/\\/g, '/')}' -Force"`);
    return;
  }
  for (const [check, cmd] of [
    ['unzip', `unzip -o "${zipPath}" -d "${outDir}"`],
    ['7z',    `7z x -y "${zipPath}" -o"${outDir}"`],
    ['busybox unzip', `busybox unzip -o "${zipPath}" -d "${outDir}"`],
  ]) {
    try {
      await run(`command -v ${check.split(' ')[0]}`);
      await run(cmd);
      return;
    } catch {}
  }
  throw new Error('No unzip tool found (unzip / 7z / busybox). Please install one.');
}

function downloadFile(url, dest, visited = new Set()) {
  return new Promise((resolve, reject) => {
    if (visited.has(url) || visited.size > MAX_REDIRECTS) return reject(new Error('Too many redirects'));
    visited.add(url);
    const client = url.startsWith('https://') ? https : http;
    client.get(url, { headers: { 'User-Agent': 'JuneXUltra-Updater/2.0', Accept: '*/*' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        const loc = res.headers.location;
        if (!loc) return reject(new Error(`HTTP ${res.statusCode} without Location`));
        res.resume();
        return downloadFile(new URL(loc, url).toString(), dest, visited).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', err => { try { file.close(() => {}); } catch {} fs.unlink(dest, () => reject(err)); });
    }).on('error', err => { fs.unlink(dest, () => reject(err)); });
  });
}

// Delete all non-preserved entries in a directory (non-recursive at top level)
function cleanDirectory(dir) {
  for (const entry of fs.readdirSync(dir)) {
    if (PRESERVED.has(entry)) continue;
    const full = path.join(dir, entry);
    try {
      fs.rmSync(full, { recursive: true, force: true });
    } catch (e) {
      console.warn(`[UPDATE] Could not remove ${full}: ${e.message}`);
    }
  }
}

// Copy all files from src → dest, skipping preserved names at the root level
function copyRecursive(src, dest, isRoot = false, outList = []) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    if (isRoot && PRESERVED.has(entry)) continue;
    const s = path.join(src, entry);
    const d = path.join(dest, entry);
    if (fs.lstatSync(s).isDirectory()) {
      copyRecursive(s, d, false, outList);
    } else {
      fs.copyFileSync(s, d);
      outList.push(path.relative(dest, d).replace(/\\/g, '/'));
    }
  }
}

async function cleanUpdate(zipUrl, botRoot) {
  const tmpDir  = path.join(botRoot, 'tmp');
  const zipPath = path.join(tmpDir, 'june_update.zip');
  const extractTo = path.join(tmpDir, 'june_extract');

  fs.mkdirSync(tmpDir, { recursive: true });

  // 1. Download
  await downloadFile(zipUrl, zipPath);

  // 2. Extract
  if (fs.existsSync(extractTo)) fs.rmSync(extractTo, { recursive: true, force: true });
  await extractZip(zipPath, extractTo);

  // 3. Find extracted root (GitHub puts files inside <repo>-<branch>/ folder)
  const entries = fs.readdirSync(extractTo);
  const inner   = entries.length === 1 ? path.join(extractTo, entries[0]) : extractTo;
  const srcRoot = fs.existsSync(inner) && fs.lstatSync(inner).isDirectory() ? inner : extractTo;

  // 4. Clean old files (preserve session, node_modules, database, config.js, .env…)
  cleanDirectory(botRoot);

  // 5. Copy new files in
  const copied = [];
  copyRecursive(srcRoot, botRoot, true, copied);

  // 6. Cleanup temp
  try { fs.rmSync(extractTo,  { recursive: true, force: true }); } catch {}
  try { fs.rmSync(zipPath,    { force: true }); } catch {}

  return copied;
}

module.exports = {
  name: 'update',
  aliases: ['upgrade'],
  category: 'owner',
  description: `Clean-update bot from ${GITHUB_USER}/${GITHUB_REPO} (Owner Only)`,
  usage: '.update',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    const chatId = msg.key.remoteJid;
    const botRoot = path.join(__dirname, '..', '..');

    try {
      await extra.reply(
        `🔄 *Starting clean update…*\n` +
        `📦 Repo: *${GITHUB_USER}/${GITHUB_REPO}*\n` +
        `🌿 Branch: *${GITHUB_BRANCH}*\n\n` +
        `_Downloading and applying update. Please wait…_`
      );

      const copied = await cleanUpdate(ZIP_URL, botRoot);

      const summary =
        `✅ *Update complete!*\n` +
        `📁 Files updated: *${copied.length}*\n` +
        `🔒 Preserved: session, config.js, database, .env\n\n` +
        `_Restarting bot…_`;

      await sock.sendMessage(chatId, { text: summary }, { quoted: msg });

      // Restart via pm2 if available, else process.exit for panel auto-restart
      try { await run('pm2 restart all'); return; } catch {}
      setTimeout(() => process.exit(0), 800);

    } catch (error) {
      console.error('[UPDATE] Failed:', error);
      await sock.sendMessage(chatId, {
        text: `❌ *Update failed*\n\n${String(error.message || error)}`
      }, { quoted: msg });
    }
  }
};
