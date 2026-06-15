const axios = require('axios');
const FormData = require('form-data');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const config = require('../../config');

const GROQ_API_KEY = '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';
const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

module.exports = {
    name: 'transcribe',
    aliases: ['stt', 'totext'],
    category: 'general',
    description: 'Transcribe audio or voice message to text',
    usage: '.transcribe (reply to an audio/voice message)',

    async execute(sock, msg, args, extra) {
        const chatId = extra.from;
        try {
            const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;

            if (!quoted) {
                return await sock.sendMessage(chatId, {
                    text: '🎙️ Please reply to a voice note or audio message to transcribe it.'
                }, { quoted: msg });
            }

            const isAudio = quoted.audioMessage;
            if (!isAudio) {
                return await sock.sendMessage(chatId, {
                    text: '❌ Only audio or voice messages can be transcribed.'
                }, { quoted: msg });
            }

            await sock.sendMessage(chatId, { react: { text: '🎙️', key: msg.key } });

            // Download the audio
            const quotedMsg = {
                key: {
                    remoteJid: chatId,
                    id: msg.message.extendedTextMessage.contextInfo.stanzaId,
                    fromMe: msg.message.extendedTextMessage.contextInfo.participant === sock.user?.id
                },
                message: quoted
            };

            const buffer = await downloadMediaMessage(quotedMsg, 'buffer', {});

            // Build form data
            const form = new FormData();
            form.append('file', buffer, { filename: 'audio.ogg', contentType: 'audio/ogg' });
            form.append('model', 'whisper-large-v3');
            form.append('response_format', 'json');

            const response = await axios.post(GROQ_URL, form, {
                headers: {
                    ...form.getHeaders(),
                    Authorization: `Bearer ${GROQ_API_KEY}`
                },
                timeout: 60000
            });

            const text = response.data?.text?.trim();
            if (!text) throw new Error('No transcription returned');

            await sock.sendMessage(chatId, {
                text: `🗣️ *Transcription:*\n\n${text}\n\n> Powered by ${config.botName}`
            }, { quoted: msg });

            await sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } });

        } catch (error) {
            console.error('Transcribe error:', error.message);
            await sock.sendMessage(chatId, {
                text: '❌ Failed to transcribe audio. Please try again.'
            }, { quoted: msg });
            await sock.sendMessage(chatId, { react: { text: '❌', key: msg.key } });
        }
    }
};
