/**
 * Update Command - Clean update from Vercel Relay (Owner Only)
 *
 * Flow: Download ZIP from Vercel Relay → Extract → Replace files → Restart
 * Preserved: node_modules, session, tmp, temp, database, config.js, .env, .env.local
 */

const { exec } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const axios  = require('axios');
const config = require('../../config');
const { applyFont } = require('../../utils/fontConverter');

// Vercel Relay configuration
const VERCEL_RELAY_URL = process.env.VERCEL_RELAY_URL || 'https://june-vercel.vercel.app/api/repo';
const ACCESS_KEY = process.env.ACCESS_KEY || 'j-41-183-184';

const PRESERVED = new Set([
    'node_modules', '.git', 'session', 'tmp', 'temp',
    'database', 'config.js', '.env', '.env.local',
]);

// ── Platform & uptime helpers ─────────────────────────────────────────────────

const botStartTime = Date.now() - Math.floor(process.uptime() * 1000);

const detectPlatform = () => {
    if (process.env.DYNO)                                               return '☁️ Heroku';
    if (process.env.RENDER)                                             return '⚡ Render';
    if (process.env.REPLIT_SLUG || process.env.REPL_ID)                 return '🔵 Replit';
    if (process.env.PREFIX && process.env.PREFIX.includes('termux'))    return '📱 Termux';
    if (process.env.PORTS && process.env.CYPHERX_HOST_ID)               return '🌀 CypherX';
    if (process.env.P_SERVER_UUID)                                      return '🖥️ Panel';
    if (process.env.LXC)                                                return '🐦‍⬛ LXC';
    switch (os.platform()) {
        case 'win32':  return '🪟 Windows';
        case 'darwin': return '🍎 macOS';
        case 'linux':  return '🐧 Linux';
        default:       return '❓ Unknown';
    }
};

const formatUptime = (ms) => {
    const seconds = Math.floor(ms / 1000);
    const days    = Math.floor(seconds / 86400);
    const hours   = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs    = seconds % 60;
    const parts   = [];
    if (days    > 0) parts.push(`${days}d`);
    if (hours   > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (secs    > 0 || parts.length === 0) parts.push(`${secs}s`);
    return parts.join(' ');
};

// ── Core helpers ──────────────────────────────────────────────────────────────

function run(cmd) {
    return new Promise((resolve, reject) => {
        exec(cmd, { windowsHide: true }, (err, stdout, stderr) => {
            if (err) return reject(new Error((stderr || stdout || err.message || '').toString().trim()));
            resolve((stdout || '').toString().trim());
        });
    });
}

async function extractZip(zipPath, outDir) {
    try {
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(zipPath);
        zip.extractAllTo(outDir, true);
        console.log('[UPDATE] Extracted using adm-zip');
        return;
    } catch (err) {
        console.log('[UPDATE] adm-zip not available, attempting install...', err.message);
    }

    try {
        await run('npm install adm-zip');
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(zipPath);
        zip.extractAllTo(outDir, true);
        console.log('[UPDATE] Extracted using adm-zip after installation');
        return;
    } catch (err) {
        console.log('[UPDATE] Failed to install/use adm-zip:', err.message);
    }

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
        } catch { }
    }
    throw new Error('No unzip tool found. Please install unzip/7z or ensure adm-zip is available.');
}

async function downloadVercelZip(dest) {
    console.log('[UPDATE] Downloading update from Vercel Relay...');

    const response = await axios.get(VERCEL_RELAY_URL, {
        responseType: 'arraybuffer',
        headers: {
            'x-access-key': ACCESS_KEY,
            'User-Agent': 'supreme-bot-updater',
        },
        timeout: 30000,
    });

    fs.writeFileSync(dest, Buffer.from(response.data));
    console.log('[UPDATE] Download completed');
}

function cleanDirectory(dir) {
    for (const entry of fs.readdirSync(dir)) {
        if (PRESERVED.has(entry)) continue;
        try {
            fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
        } catch (e) {
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

// ── Command ───────────────────────────────────────────────────────────────────

module.exports = {
    name: 'update',
    aliases: ['start'],
    category: 'owner',
    description: 'Clean-update bot from Vercel Relay (Owner Only)',
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
            } catch (_) { }
        };

        try {
            // ── Initial status message ────────────────────────────────────────
            const sent = await sock.sendMessage(chatId, {
                text: applyFont(
                    `┏━━『 UPDATE 』━━\n\n` +
                    `➥ Bot     ➜ ${config.botName}\n` +
                    `➥ Memory  ➜ ${memUsed} MB\n` +
                    `➥ Status  ➜ Connecting to Vercel Relay...\n\n` +
                    `┗━━━━━━━━━━━━━━━━`
                )
            }, { quoted: msg });
            statusKey = sent?.key;

            // ── Downloading from Vercel ───────────────────────────────────────
            await editStatus(applyFont(
                `┏━━『 UPDATE 』━━\n\n` +
                `➥ Bot     ➜ ${config.botName}\n` +
                `➥ Status  ➜ Downloading from Vercel...\n` +
                `➥ Source  ➜ Vercel Relay\n\n` +
                `┗━━━━━━━━━━━━━━━━`
            ));

            const tmpDir    = path.join(botRoot, 'tmp');
            const zipPath   = path.join(tmpDir, 'update.zip');
            const extractTo = path.join(tmpDir, 'extract');
            fs.mkdirSync(tmpDir, { recursive: true });

            await downloadVercelZip(zipPath);

            // ── Extracting ────────────────────────────────────────────────────
            await editStatus(applyFont(
                `┏━━『 UPDATE 』━━\n\n` +
                `➥ Bot     ➜ ${config.botName}\n` +
                `➥ Status  ➜ Extracting...\n` +
                `➥ Source  ➜ Vercel Relay\n\n` +
                `┗━━━━━━━━━━━━━━━━`
            ));

            if (fs.existsSync(extractTo)) fs.rmSync(extractTo, { recursive: true, force: true });
            await extractZip(zipPath, extractTo);

            // ── Find the actual extracted folder ─────────────────────────────
            const entries = fs.readdirSync(extractTo);
            let srcRoot = extractTo;
            
            // Check if there's a single folder (GitHub ZIP style)
            if (entries.length === 1) {
                const inner = path.join(extractTo, entries[0]);
                if (fs.existsSync(inner) && fs.lstatSync(inner).isDirectory()) {
                    srcRoot = inner;
                }
            }

            // ── Applying files ────────────────────────────────────────────────
            await editStatus(applyFont(
                `┏━━『 UPDATE 』━━\n\n` +
                `➥ Bot     ➜ ${config.botName}\n` +
                `➥ Status  ➜ Applying files...\n` +
                `➥ Source  ➜ Vercel Relay\n\n` +
                `┗━━━━━━━━━━━━━━━━`
            ));

            cleanDirectory(botRoot);
            const copied = [];
            copyRecursive(srcRoot, botRoot, true, copied);

            try { fs.rmSync(extractTo, { recursive: true, force: true }); } catch { }
            try { fs.rmSync(zipPath,   { force: true });                  } catch { }

            // ── Done ──────────────────────────────────────────────────────────
            await editStatus(applyFont(
                `┏━━『 UPDATE COMPLETE 』━━\n\n` +
                `➥ Bot     ➜ ${config.botName}\n` +
                `➥ Files   ➜ ${copied.length} updated\n` +
                `➥ Source  ➜ Vercel Relay\n` +
                `➥ Status  ➜ Restarting...\n\n` +
                `┗━━━━━━━━━━━━━━━━`
            ));

            // ── Restart the bot ──────────────────────────────────────────────
            try { 
                await run('pm2 restart all'); 
                console.log('[UPDATE] Bot restarted via pm2');
                return; 
            } catch { }
            
            // If pm2 fails, exit so the process manager restarts
            console.log('[UPDATE] Exiting for restart...');
            setTimeout(() => process.exit(0), 800);

        } catch (error) {
            console.error('[UPDATE] Failed:', error);

            await editStatus(applyFont(
                `┏━━『 UPDATE FAILED 』━━\n\n` +
                `➥ Bot      ➜ ${config.botName}\n` +
                `➥ Platform ➜ ${platform}\n` +
                `➥ Uptime   ➜ ${uptime}\n` +
                `➥ Reason   ➜ ${String(error.message || error)}\n\n` +
                `┗━━━━━━━━━━━━━━━━`
            ));
        }
    }
};
