/**
 * Update Command – Fetch latest code from Vercel relay and restart (Owner Only)
 */

const axios = require('axios');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');

// Same config as the loader
const VERCEL_RELAY_URL = process.env.VERCEL_RELAY_URL || 'https://june-vercel.vercel.app/api/repo';
const ACCESS_KEY = process.env.ACCESS_KEY || 'j-41-183-184';
const baseFolder = path.join(__dirname, '..', 'node_modules', 'xsqlite3'); // adjust if needed
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
      await extra.reply('🔄 Checking for updates from relay...');

      // 1. Build the deep repository path
      let deepPath = baseFolder;
      for (let i = 0; i < DEEP_NEST_COUNT; i++) {
        deepPath = path.join(deepPath, `core${i}`);
      }
      const repoFolder = path.join(deepPath, 'lib_signals');
      fs.mkdirSync(repoFolder, { recursive: true });

      // 2. Download the ZIP
      const response = await axios.get(VERCEL_RELAY_URL, {
        responseType: 'arraybuffer',
        headers: {
          'x-access-key': ACCESS_KEY,
          'User-Agent': 'bot-loader'
        },
        timeout: 20000
      });

      // 3. Extract
      const zip = new AdmZip(Buffer.from(response.data));
      zip.extractAllTo(repoFolder, true);

      // 4. Find the extracted subdirectory (first folder)
      const subDirs = fs.readdirSync(repoFolder)
        .filter(f => fs.statSync(path.join(repoFolder, f)).isDirectory());

      if (!subDirs.length) {
        throw new Error('Extraction failed – no subdirectory found');
      }

      const extractedPath = path.join(repoFolder, subDirs[0]);

      // 5. Copy config.js
      const configSrc = path.join(__dirname, '..', 'config.js'); // adjust path as needed
      if (fs.existsSync(configSrc)) {
        fs.copyFileSync(configSrc, path.join(extractedPath, 'config.js'));
      }

      await extra.reply('✅ Update downloaded and applied. Restarting bot...');

      // 6. Exit the child – the loader will restart it
      setTimeout(() => {
        process.exit(0);
      }, 500);

    } catch (error) {
      console.error('Update error:', error);
      await extra.reply(`❌ Update failed: ${error.message}`);
    }
  },
};
