/**
 * Transcribe Command
 * Converts audio / video messages to text using the Keith API.
 * Usage: reply to an audio or video with .transcribe
 *        append "clean" to get raw text only: .transcribe clean
 */

const axios    = require('axios');
const FormData = require('form-data');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');

module.exports = {
    name: 'transcribe',
    aliases: ['totext', 'trnsc', 'speech'],
    category: 'general',
    description: 'Transcribe audio or video messages to text',
    usage: '.transcribe  (reply to an audio/video)\n.transcribe clean  — raw text only',

    async execute(sock, msg, args, extra) {
        const from = extra.from;

        // Resolve quoted message
        const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
        const qMsg    = ctxInfo?.quotedMessage;

        if (!qMsg) {
            return extra.reply(
                `🎤 *Audio / Video Transcription*\n\n` +
                `❌ Please *reply* to an audio or video message.\n\n` +
                `📝 *Usage:*\n` +
                `• Reply to audio/voice note with _${extra.prefix || '.'}transcribe_\n` +
                `• Reply to video with _${extra.prefix || '.'}transcribe_\n` +
                `• Add \`clean\` to get plain text only: _${extra.prefix || '.'}transcribe clean_\n\n` +
                `🔊 *Supported:* voice notes, audio messages, video (with audio)`
            );
        }

        const isAudio = !!qMsg.audioMessage;
        const isVideo = !!qMsg.videoMessage;

        if (!isAudio && !isVideo) {
            return extra.reply(
                `🎤 *Transcription*\n\n` +
                `❌ Unsupported media type.\n\n` +
                `Please reply to an *audio* or *video* message only.\n` +
                `(Images, documents and text are not supported.)`
            );
        }

        const mediaType = isAudio ? 'audio' : 'video';
        const cleanMode = args.join(' ').toLowerCase().includes('clean');

        // React to signal processing
        await sock.sendMessage(from, { react: { text: '🎤', key: msg.key } });
        await sock.sendPresenceUpdate('recording', from);

        try {
            // ── Download the quoted media ───────────────────────────────────
            const quotedMsgObj = {
                key: {
                    remoteJid: from,
                    id: ctxInfo.stanzaId,
                    participant: ctxInfo.participant,
                },
                message: qMsg,
            };

            const buffer = await downloadMediaMessage(
                quotedMsgObj,
                'buffer',
                {},
                { logger: undefined, reuploadRequest: sock.updateMediaMessage }
            );

            if (!buffer || buffer.length === 0) throw new Error('Failed to download media');

            // ── Upload to uguu.se for a public URL ──────────────────────────
            const formData = new FormData();
            formData.append('files[]', buffer, {
                filename: `transcribe_${Date.now()}.${isAudio ? 'mp3' : 'mp4'}`,
            });

            const uploadRes = await axios.post('https://uguu.se/upload.php', formData, {
                headers: formData.getHeaders(),
                timeout: 30000,
            });

            const mediaUrl = uploadRes.data?.files?.[0]?.url;
            if (!mediaUrl) throw new Error('Failed to upload media to hosting');

            // ── Call Keith transcription API ────────────────────────────────
            const apiUrl = `https://apiskeith.top/ai/transcribe?q=${encodeURIComponent(mediaUrl)}`;
            const apiRes = await axios.get(apiUrl, { timeout: 60000 });

            const transcription = apiRes.data?.result?.text?.trim();
            if (!transcription) throw new Error('No speech detected in the media');

            // ── Send result ─────────────────────────────────────────────────
            await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });

            const replyText = cleanMode
                ? transcription
                : `🎤 *Transcription Result*\n\n📝 ${transcription}\n\n🔊 _Media type: ${mediaType.toUpperCase()}_`;

            await sock.sendMessage(from, { text: replyText }, { quoted: msg });

            await sock.sendMessage(from, { react: { text: '📝', key: msg.key } });

        } catch (error) {
            console.error('[transcribe] error:', error);
            await sock.sendMessage(from, { react: { text: '❌', key: msg.key } });

            let errMsg;
            if (error.response?.status === 404) {
                errMsg = 'Transcription API not found.';
            } else if (error.message?.includes('timeout') || error.code === 'ECONNABORTED') {
                errMsg = 'Timed out — try a shorter clip (under 5 minutes).';
            } else if (error.code === 'ENOTFOUND') {
                errMsg = 'Cannot reach the transcription service. Check your connection.';
            } else if (error.response?.status === 429) {
                errMsg = 'Too many requests — please wait a moment and retry.';
            } else if (error.response?.status >= 500) {
                errMsg = 'Transcription service is unavailable right now.';
            } else if (error.message?.includes('No speech')) {
                errMsg = 'No speech detected in the media.';
            } else if (error.message?.includes('upload')) {
                errMsg = 'Failed to upload the media file.';
            } else {
                errMsg = error.message;
            }

            await extra.reply(
                `🎤 *Transcription Error*\n\n` +
                `🚫 ${errMsg}\n\n` +
                `💡 *Tips:*\n` +
                `• Make sure the audio is clear\n` +
                `• Keep clips under 5 minutes\n` +
                `• Retry in a moment`
            );
        }
    },
};
