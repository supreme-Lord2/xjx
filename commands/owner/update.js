/**
 * Update Command - Clean update from private GitHub repo (Owner Only)
 *
 * Flow: Download ZIP → Extract → Replace files → Restart
 * Preserved (never touched): node_modules, session, tmp, temp, database, config.js, .env
 */

const { exec } = require('child_process');
const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');
const os   = require('os');
const config = require('../../config');

const GITHUB_USER   = 'Vinpink2';
const GITHUB_REPO   = 'June-X-Ultra';
const GITHUB_BRANCH = 'main';
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN || '';

// GitHub API endpoint for private repos (requires Authorization header)
const ZIP_URL = `https://api.github.com/repos/${GITHUB_USER}/${GITHUB_REPO}/zipball/${GITHUB_BRANCH}`;
const REPO_URL = `https://github.com/${GITHUB_USER}/${GITHUB_REPO}`;

const PRESERVED = new Set([
    'node_modules', '.git', 'session', 'tmp', 'temp',
    'database', 'config.js', '.env', '.env.local',
]);

const MAX_REDIRECTS = 5;

// ── Platform & uptime helpers ──────────────────────────────────────────────
const botStartTime = Date.now() - Math.floor(process.uptime() * 1000);

const detectPlatform = () => {
    if (process.env.DYNO) return '☁️ Heroku';
    if (process.env.RENDER) return '⚡ Render';
    if (process.env.REPLIT_SLUG || process.env.REPL_ID) return '🔵 Replit';
    if (process.env.PREFIX && process.env.PREFIX.includes('termux')) return '📱 Termux';
    if (process.env.PORTS && process.env.CYPHERX_HOST_ID) return '🌀 CypherX Platform';
    if (process.env.P_SERVER_UUID) return '🖥️ Panel';
    if (process.env.LXC) return '🐦‍⬛ Linux Container (LXC)';
    switch (os.platform()) {
        case 'win32': return '🪟 Windows';
        case 'darwin': return '🍎 macOS';
        case 'linux': return '🐧 Linux';
        default: return '❓ Unknown';
    }
};

const formatUptime = (ms) => {
    const seconds = Math.floor(ms / 1000);
    const days    = Math.floor(seconds / 86400);
    const hours   = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs    = seconds % 60;
    const parts   = [];
    if (days > 0)    parts.push(`${days} day${days > 1 ? 's' : ''}`);
    if (hours > 0)   parts.push(`${hours} hour${hours > 1 ? 's' : ''}`);
    if (minutes > 0) parts.push(`${minutes} minute${minutes > 1 ? 's' : ''}`);
    if (secs > 0 || parts.length === 0) parts.push(`${secs} second${secs !== 1 ? 's' : ''}`);
    return parts.join(', ');
};

// ── Core helpers ───────────────────────────────────────────────────────────
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
        ['unzip',         `unzip -o "${zipPath}" -d "${outDir}"`],
        ['7z',            `7z x -y "${zipPath}" -o"${outDir}"`],
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

        if (!GITHUB_TOKEN) return reject(new Error('GITHUB_TOKEN is not set in .env — required for private repo download.'));

        const headers = {
            'User-Agent': 'JuneXUltra-Updater/2.0',
            'Accept': 'application/vnd.github+json',
            'Authorization': `token ${GITHUB_TOKEN}`,
            'X-GitHub-Api-Version': '2022-11-28',
        };

        const client = url.startsWith('https://') ? https : http;
        client.get(url, { headers }, res => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                const loc = res.headers.location;
                if (!loc) return reject(new Error(`HTTP ${res.statusCode} without Location`));
                res.resume();
                // Follow redirect — carry auth only for GitHub domains
                const redirectUrl = new URL(loc, url).toString();
                const redirectHeaders = redirectUrl.includes('github') ? headers : { 'User-Agent': headers['User-Agent'] };
                return downloadFileWithHeaders(redirectUrl, dest, redirectHeaders, visited).then(resolve).catch(reject);
            }
            if (res.statusCode === 401 || res.statusCode === 403) {
                return reject(new Error(`GitHub auth failed (HTTP ${res.statusCode}). Check your GITHUB_TOKEN.`));
            }
            if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
            const file = fs.createWriteStream(dest);
            res.pipe(file);
            file.on('finish', () => file.close(resolve));
            file.on('error', err => { try { file.close(() => {}); } catch {} fs.unlink(dest, () => reject(err)); });
        }).on('error', err => { fs.unlink(dest, () => reject(err)); });
    });
}

function downloadFileWithHeaders(url, dest, headers, visited = new Set()) {
    return new Promise((resolve, reject) => {
        if (visited.has(url) || visited.size > MAX_REDIRECTS) return reject(new Error('Too many redirects'));
        visited.add(url);
        const client = url.startsWith('https://') ? https : http;
        client.get(url, { headers }, res => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                const loc = res.headers.location;
                if (!loc) return reject(new Error(`HTTP ${res.statusCode} without Location`));
                res.resume();
                return downloadFileWithHeaders(new URL(loc, url).toString(), dest, headers, visited).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
            const file = fs.createWriteStream(dest);
            res.pipe(file);
            file.on('finish', () => file.close(resolve));
            file.on('error', err => { try { file.close(() => {}); } catch {} fs.unlink(dest, () => reject(err)); });
        }).on('error', err => { fs.unlink(dest, () => reject(err)); });
    });
}

function cleanDirectory(dir) {
    for (const entry of fs.readdirSync(dir)) {
        if (PRESERVED.has(entry)) continue;
        try { fs.rmSync(path.join(dir, entry), { recursive: true, force: true }); } catch (e) {
            console.warn(`[UPDATE] Could not remove ${entry}: ${e.message}`);
        }
    }
}

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

// ── Command ────────────────────────────────────────────────────────────────
module.exports = {
    name: 'update',
    aliases: ['upgrade'],
    category: 'owner',
    description: `Clean-update bot from private ${GITHUB_USER}/${GITHUB_REPO} repo (Owner Only)`,
    usage: '.update',
    ownerOnly: true,

    async execute(sock, msg, args, extra) {
        const chatId  = msg.key.remoteJid;
        const botRoot = path.join(__dirname, '..', '..');
        const platform = detectPlatform();
        const uptime   = formatUptime(Date.now() - botStartTime);
        const mem      = process.memoryUsage();
        const memUsed  = (mem.heapUsed / 1024 / 1024).toFixed(1);

        let statusKey = null;
        const editStatus = async (text) => {
            try {
                if (statusKey) await sock.sendMessage(chatId, { edit: statusKey, text });
            } catch (_) {}
        };

        try {
            if (!GITHUB_TOKEN) {
                return await sock.sendMessage(chatId, {
                    text: `❌ *Update Failed*\n\nGITHUB_TOKEN is not set in your .env file.\nAdd it to download from a private repo.`
                }, { quoted: msg });
            }

            // ── Initial status ─────────────────────────────────────────────
            const sent = await sock.sendMessage(chatId, {
                text: [
                    `🔄 *${config.botName} — Update Starting…*`,
                    `🌿 *Branch:* ${GITHUB_BRANCH}`,
                    `💾 *Memory:* ${memUsed}MB`,
                    `⏳ _Connecting to GitHub…_`
                ].join('\n')
            }, { quoted: msg });
            statusKey = sent?.key;

            // ── Step 1: Download ───────────────────────────────────────────
            await editStatus([
                `📥 *${config.botName} — Downloading…*`,
                `🌿 *Branch:* ${GITHUB_BRANCH}`,
                `📥 _Downloading latest ZIP from private repo…_`
            ].join('\n'));

            const tmpDir    = path.join(botRoot, 'tmp');
            const zipPath   = path.join(tmpDir, 'june_update.zip');
            const extractTo = path.join(tmpDir, 'june_extract');
            fs.mkdirSync(tmpDir, { recursive: true });
            await downloadFile(ZIP_URL, zipPath);

            // ── Step 2: Extract ────────────────────────────────────────────
            await editStatus([
                `📂 *${config.botName} — Extracting…*`,
                ``,
                `📂 _Extracting ZIP…_`
            ].join('\n'));

            if (fs.existsSync(extractTo)) fs.rmSync(extractTo, { recursive: true, force: true });
            await extractZip(zipPath, extractTo);

            // ── Step 3: Apply ──────────────────────────────────────────────
            await editStatus([
                `_Applying Update…_`,
                ``,
                `🗂️ Replacing old files...`
            ].join('\n'));

            const entries = fs.readdirSync(extractTo);
            const inner   = entries.length === 1 ? path.join(extractTo, entries[0]) : extractTo;
            const srcRoot = fs.existsSync(inner) && fs.lstatSync(inner).isDirectory() ? inner : extractTo;

            cleanDirectory(botRoot);
            const copied = [];
            copyRecursive(srcRoot, botRoot, true, copied);

            try { fs.rmSync(extractTo, { recursive: true, force: true }); } catch {}
            try { fs.rmSync(zipPath,   { force: true }); } catch {}

            // ── Step 4: Done ───────────────────────────────────────────────
            await editStatus([
                `✅ *Update Completed!*`,
                `🔹 *Branch:* ${GITHUB_BRANCH}`,
                `🔹 *Files updated:* ${copied.length}`,
                ` _Restarting bot instance..._`
            ].join('\n'));

            // Restart
            try { await run('pm2 restart all'); return; } catch {}
            setTimeout(() => process.exit(0), 800);

        } catch (error) {
            console.error('[UPDATE] Failed:', error);
            await editStatus([
                `❌ *${config.botName} — Update Failed*`,
                `⏰ *Running on* [${platform}] *for:*`,
                `  *${uptime}*`,
                `⚠️ ${String(error.message || error)}`
            ].join('\n'));
        }
    }
};
