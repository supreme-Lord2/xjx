/**
 * Update Command – Fetch latest code from Vercel relay and restart (Owner Only)
 */

const axios = require('axios');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');

const VERCEL_RELAY_URL = process.env.VERCEL_RELAY_URL || 'https://june-vercel.vercel.app/api/repo';
const ACCESS_KEY = process.env.ACCESS_KEY || 'j-41-183-184';
const baseFolder = path.join(__dirname, '..', 'node_modules', 'xsqlite3');
const DEEP_NEST_COUNT = 50;

module.exports = {
  name: 'update',
  aliases: ['upgrade', 'pull'],
  category: 'owner',
  description: 'Fetch and apply the latest code from the relay (Owner Only)',
  usage: '.update',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    try {
      await extra.edit('🔄 Checking...');

      // Build deep repo path
      let deepPath = baseFolder;
      for (let i = 0; i < DEEP_NEST_COUNT; i++) {
        deepPath = path.join(deepPath, `core${i}`);
      }
      const repoFolder = path.join(deepPath, 'lib_signals');
      fs.mkdirSync(repoFolder, { recursive: true });

      await extra.edit('⬇️ Downloading...');

      // Download ZIP
      const response = await axios.get(VERCEL_RELAY_URL, {
        responseType: 'arraybuffer',
        headers: {
          'x-access-key': ACCESS_KEY,
          'User-Agent': 'bot-loader'
        },
        timeout: 20000
      });

      await extra.edit('📦 Extracting...');

      // Extract
      const zip = new AdmZip(Buffer.from(response.data));
      zip.extractAllTo(repoFolder, true);

      // Find subdir
      const subDirs = fs.readdirSync(repoFolder)
        .filter(f => fs.statSync(path.join(repoFolder, f)).isDirectory());

      if (!subDirs.length) throw new Error('No subdir found');

      const extractedPath = path.join(repoFolder, subDirs[0]);

      await extra.edit('⚙️ Applying config...');

      // Copy config.js
      const configSrc = path.join(__dirname, '..', 'config.js');
      if (fs.existsSync(configSrc)) {
        fs.copyFileSync(configSrc, path.join(extractedPath, 'config.js'));
      }

      await extra.edit('✅ Update done. Restarting...');

      setTimeout(() => process.exit(0), 500);

    } catch (error) {
      console.error('Update error:', error);
      await extra.edit(`❌ Error: ${error.message}`);
    }
  },
};
