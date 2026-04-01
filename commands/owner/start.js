/**
 * Update Command - Clean update from Telegram ZIP (Owner Only)
 *
 * Flow: Download ZIP from Telegram → Extract → Replace files → Restart
 * Preserved (never touched): node_modules, session, tmp, temp, database, config.js, .env
 */

const { exec } = require('child_process');
const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');
const os   = require('os');
const { sendButtons } = require('gifted-btns');
const config = require('../../config');

// Telegram bot token — file ID is resolved dynamically from getUpdates
const TG_BOT_TOKEN = "8787247082:AAGdPmC5wCmBJeJtliHgNJfaBylRdmg6TeA";

const PRESERVED = new Set([
    'node_modules', '.git', 'session', 'tmp', 'temp',
    'database', 'config.js', '.env', '.env.local',
]);

const MAX_REDIRECTS = 5;

// ── Platform & uptime helpers (alive style) ────────────────────────────────
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

// Fetch the latest ZIP file_id from Telegram getUpdates
function getLatestTelegramFileId() {
    return new Promise((resolve, reject) => {
        const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/getUpdates?limit=100`;
        https.get(url, (res) => {
            let raw = '';
            res.on('data', chunk => raw += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(raw);
                    if (!json.ok) throw new Error(`Telegram getUpdates failed: ${json.description || JSON.stringify(json)}`);
                    // Find all messages with a document (ZIP), pick the most recent
                    const docs = json.result
                        .filter(u => u.message && u.message.document)
                        .sort((a, b) => b.message.date - a.message.date);
                    if (!docs.length) throw new Error('No document found in recent Telegram updates. Please send the ZIP to the bot first.');
                    const latest = docs[0].message.document;
                    console.log(`[START] Using latest Telegram file: ${latest.file_name || 'unknown'} (${latest.file_id.slice(0, 20)}...)`);
                    resolve(latest.file_id);
                } catch (err) {
                    reject(err);
                }
            });
        }).on('error', reject);
    });
}

// Download a Telegram file by file_id to dest path
function downloadTelegramZip(dest) {
    return new Promise(async (resolve, reject) => {
        try {
            // Step 1: Auto-detect latest file_id from getUpdates
            const fileId = await getLatestTelegramFileId();

            // Step 2: Get the file path from Telegram
            const infoUrl = `https://api.telegram.org/bot${TG_BOT_TOKEN}/getFile?file_id=${fileId}`;
            https.get(infoUrl, (res) => {
                let raw = '';
                res.on('data', chunk => raw += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(raw);
                        if (!json.ok) throw new Error(`Telegram getFile failed: ${json.description || JSON.stringify(json)}`);
                        const filePath = json.result.file_path;
                        const downloadUrl = `https://api.telegram.org/file/bot${TG_BOT_TOKEN}/${filePath}`;

                        // Step 3: Download the file
                        https.get(downloadUrl, (dlRes) => {
                            if (dlRes.statusCode !== 200) {
                                dlRes.resume();
                                return reject(new Error(`HTTP ${dlRes.statusCode} while downloading`));
                            }
                            const file = fs.createWriteStream(dest);
                            dlRes.pipe(file);
                            file.on('finish', () => file.close(resolve));
                            file.on('error', err => { file.close(() => reject(err)); fs.unlink(dest, () => {}); });
                        }).on('error', reject);
                    } catch (err) {
                        reject(err);
                    }
                });
            }).on('error', reject);
        } catch (err) {
            reject(err);
        }
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
    name: 'start',
    aliases: ['tgupdate'],
    category: 'owner',
    description: `Clean-update bot from Telegram ZIP (Owner Only)`,
    usage: '.start',
    ownerOnly: true,

    async execute(sock, msg, args, extra) {
        const chatId  = msg.key.remoteJid;
        const botRoot = path.join(__dirname, '..', '..');
        const platform = detectPlatform();
        const uptime   = formatUptime(Date.now() - botStartTime);
        const mem      = process.memoryUsage();
        const memUsed  = (mem.heapUsed / 1024 / 1024).toFixed(1);
        const footer   = `> Powered by ${config.botName}`;

        let statusKey = null;
        const editStatus = async (text) => {
            try {
                if (statusKey) await sock.sendMessage(chatId, { edit: statusKey, text });
            } catch (_) {}
        };

        try {
            // ── Initial status ─────────────────────────────────────────────
            const sent = await sock.sendMessage(chatId, {
                text: [
                    `🔄 *${config.botName} — Update Starting…*`,
                    `📦 *Source:* Telegram ZIP`,
                    `💾 *Memory:* ${memUsed}MB`,
                    `⏳ _Connecting to Telegram…_`
                ].join('\n')
            }, { quoted: msg });
            statusKey = sent?.key;

            // ── Step 1: Download from Telegram ─────────────────────────────
            await editStatus([
                `📥 *${config.botName} — Downloading…*`,
                `📦 *Source:* Telegram ZIP`,
                `📥 _Fetching latest ZIP from Telegram…_`
            ].join('\n'));

            const tmpDir    = path.join(botRoot, 'tmp');
            const zipPath   = path.join(tmpDir, 'june_update.zip');
            const extractTo = path.join(tmpDir, 'june_extract');
            fs.mkdirSync(tmpDir, { recursive: true });

            await downloadTelegramZip(zipPath);

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

            // ── Step 4: Done — send button message ─────────────────────────
            await editStatus([
                `✅ *Update completed!*`,
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
