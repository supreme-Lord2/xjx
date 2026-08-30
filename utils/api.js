/**
 * API Integration Utilities
 * Centralized helpers for AI, media download, and "stalk" (profile lookup) commands.
 */

const axios = require('axios');

// ─────────────────────────────────────────────────────────────────
// Shared HTTP clients
// ─────────────────────────────────────────────────────────────────

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

const CHROME_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const api = axios.create({
  timeout: 30000,
  headers: { 'User-Agent': DEFAULT_USER_AGENT },
});

const DOWNLOAD_HEADERS = {
  timeout: 60000,
  headers: {
    'User-Agent': CHROME_USER_AGENT,
    Accept: 'application/json, text/plain, */*',
  },
};

/**
 * Retry a request-returning function with linear backoff.
 * @param {() => Promise<any>} getter
 * @param {number} attempts
 */
async function tryRequest(getter, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await getter();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw lastError;
}

// ─────────────────────────────────────────────────────────────────
// NVIDIA NIM (build.nvidia.com) config
// ─────────────────────────────────────────────────────────────────

const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const NVIDIA_IMAGE_URL = 'https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-dev';
const NVIDIA_DEFAULT_MODEL = 'nvidia/nemotron-nano-12b-v2-vl';

/**
 * Reads the NVIDIA API key from the environment.
 * IMPORTANT: never hardcode this key in source. Set NVIDIA_API_KEY
 * in your .env / hosting panel's environment variables instead.
 */
function getNvidiaApiKey() {
  const key = process.env.NVIDIA_API_KEY;
  if (!key) {
    throw new Error(
      'NVIDIA_API_KEY is not set. Get a free key at https://build.nvidia.com and add it to your environment secrets.'
    );
  }
  return key;
}

/**
 * Low-level chat-completions call to NVIDIA NIM.
 */
async function callNvidia({ messages, model, maxTokens, temperature, timeoutMs }) {
  const { data } = await axios.post(
    NVIDIA_BASE_URL,
    {
      model: model || NVIDIA_DEFAULT_MODEL,
      messages,
      max_tokens: maxTokens ?? 2048,
      temperature: temperature ?? 0.7,
      top_p: 0.95,
      stream: false,
    },
    {
      headers: {
        Authorization: `Bearer ${getNvidiaApiKey()}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      timeout: timeoutMs ?? 90000,
    }
  );

  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty response from NVIDIA API');

  return typeof content === 'string'
    ? content
    : content.map((c) => (typeof c === 'string' ? c : c.text || '')).join('');
}

/**
 * Extracts an image Buffer from a variety of possible NVIDIA image-API response shapes.
 */
async function extractImageBuffer(resp, timeoutMs) {
  const artifacts = resp.data?.artifacts || resp.data?.images || resp.data?.data;
  const first = Array.isArray(artifacts) ? artifacts[0] : artifacts;

  const b64 = first?.base64 || first?.b64 || resp.data?.b64;
  if (b64) return Buffer.from(b64, 'base64');

  const openaiB64 = resp.data?.data?.[0]?.b64_json;
  if (openaiB64) return Buffer.from(openaiB64, 'base64');

  const url = first?.url || first?.image_url || resp.data?.url;
  if (url) {
    const img = await axios.get(url, { responseType: 'arraybuffer', timeout: timeoutMs });
    if (img.data?.length) return Buffer.from(img.data);
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────
// "Stalk" (profile lookup) helper — de-duplicates the 4 near-identical
// GiftedTech-based lookups (Instagram, IP, NPM, Twitter)
// ─────────────────────────────────────────────────────────────────

const GIFTEDTECH_BASE = 'https://api.giftedtech.co.ke/api/stalk';

/**
 * @param {string} endpoint - e.g. 'igstalk', 'ipstalk', 'npmstalk', 'twitterstalk'
 * @param {string} paramName - the query param name the API expects (e.g. 'username')
 * @param {string} paramValue
 * @param {string} notFoundMessage
 * @param {number} timeout
 */
async function giftedTechStalk(endpoint, paramName, paramValue, notFoundMessage, timeout = 20000) {
  const url = globalThis._apiOverrides?.[endpoint] || `${GIFTEDTECH_BASE}/${endpoint}`;
  const res = await api.get(url, {
    params: { apikey: 'gifted', [paramName]: paramValue },
    timeout,
  });
  if (!res.data?.success || !res.data?.result) throw new Error(notFoundMessage);
  return res.data.result;
}

// ─────────────────────────────────────────────────────────────────
// Public API surface
// ─────────────────────────────────────────────────────────────────

const APIs = {

  // ── AI & Tools ──────────────────────────────────────────────

  /** Generate an image from a text prompt (Stable Diffusion via siputzx). */
  generateImage: async (prompt) => {
    try {
      const response = await api.get('https://api.siputzx.my.id/api/ai/stablediffusion', { params: { prompt } });
      return response.data;
    } catch {
      throw new Error('Failed to generate image');
    }
  },

  /** Simple GPT-style chat completion via shizo.top. */
  chatAI: async (text) => {
    try {
      const response = await api.get(`https://api.shizo.top/ai/gpt?apikey=shizo&query=${encodeURIComponent(text)}`);
      if (response.data?.msg) return { msg: response.data.msg };
      return response.data;
    } catch {
      throw new Error('Failed to get AI response');
    }
  },

  /** Text chat completion via NVIDIA NIM. */
  nvidiaChat: async (prompt, opts = {}) => {
    const { model, system, maxTokens, temperature, timeoutMs } = opts;
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: prompt });
    return callNvidia({ messages, model, maxTokens, temperature, timeoutMs });
  },

  /** Vision-capable chat completion via NVIDIA NIM. `image` may be a Buffer or a URL string. */
  nvidiaVision: async (prompt, image, opts = {}) => {
    const { model, maxTokens, temperature, timeoutMs } = opts;

    let imageUrl;
    if (Buffer.isBuffer(image)) {
      imageUrl = `data:image/jpeg;base64,${image.toString('base64')}`;
    } else if (typeof image === 'string') {
      imageUrl = image;
    } else {
      throw new Error('nvidiaVision(): image must be a Buffer or URL string');
    }

    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt || 'Describe this image in detail.' },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      },
    ];

    return callNvidia({ messages, model, maxTokens, temperature, timeoutMs });
  },

  /**
   * Generate an image via NVIDIA FLUX (OpenAI-compatible NIM images endpoint).
   * Returns a Buffer on success, or null on failure.
   */
  nvidiaImage: async (prompt, opts = {}) => {
    const { width = 1024, height = 1024, timeoutMs = 120000 } = opts;
    try {
      const resp = await axios.post(
        NVIDIA_IMAGE_URL,
        { prompt, width, height },
        {
          headers: {
            Authorization: `Bearer ${getNvidiaApiKey()}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          timeout: timeoutMs,
        }
      );
      return await extractImageBuffer(resp, timeoutMs);
    } catch (err) {
      console.error('[NVIDIA FLUX]', err.message);
      return null;
    }
  },

  /**
   * Free image-generation fallback (Pollinations, no API key required).
   * Returns a Buffer on success, or null on failure.
   */
  pollinationsImage: async (prompt, opts = {}) => {
    const { width = 1024, height = 1024, timeoutMs = 60000 } = opts;
    try {
      const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${width}&height=${height}&nologo=true`;
      const img = await axios.get(url, { responseType: 'arraybuffer', timeout: timeoutMs });
      return img.data?.length ? Buffer.from(img.data) : null;
    } catch (err) {
      console.error('[Pollinations]', err.message);
      return null;
    }
  },

  /** Translate text to a target language. */
  translate: async (text, to = 'en') => {
    try {
      const response = await api.get('https://api.siputzx.my.id/api/tools/translate', { params: { text, to } });
      const translated =
        response.data?.data?.translatedText ||
        response.data?.translatedText ||
        response.data?.result ||
        response.data?.translation;
      if (!translated) throw new Error('No translation returned');
      return { translation: translated };
    } catch {
      throw new Error('Translation failed');
    }
  },

  /** Fetch a Wikipedia page summary. */
  wikiSearch: async (query) => {
    try {
      const response = await api.get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`);
      return response.data;
    } catch {
      throw new Error('Wikipedia search failed');
    }
  },

  /** Shorten a URL via TinyURL. */
  shortenUrl: async (url) => {
    try {
      const response = await api.get('https://tinyurl.com/api-create.php', { params: { url } });
      return response.data;
    } catch {
      throw new Error('Failed to shorten URL');
    }
  },

  /** Screenshot a website. Returns a Buffer, or a URL string depending on API response. */
  screenshotWebsite: async (url) => {
    try {
      const response = await axios.get(`https://eliteprotech-apis.zone.id/ssweb?url=${encodeURIComponent(url)}`, {
        timeout: 30000,
        responseType: 'arraybuffer',
        headers: { 'User-Agent': DEFAULT_USER_AGENT },
      });
      if (response.headers['content-type']?.includes('image')) return Buffer.from(response.data);
      try {
        const data = JSON.parse(Buffer.from(response.data).toString());
        return data.url || data.data?.url || data.image;
      } catch {
        return Buffer.from(response.data);
      }
    } catch {
      throw new Error('Failed to take screenshot');
    }
  },

  /** Convert text to speech, returns a URL to the generated MP3. */
  textToSpeech: async (text) => {
    try {
      const response = await axios.get(`https://www.laurine.site/api/tts/tts-nova?text=${encodeURIComponent(text)}`, {
        timeout: 30000,
        headers: { 'User-Agent': DEFAULT_USER_AGENT },
      });
      const d = response.data;
      if (!d) throw new Error('Empty response');
      if (typeof d === 'string' && d.startsWith('http')) return d;

      const src = d.data || d;
      if (src.URL) return src.URL;
      if (src.url) return src.url;
      if (src.MP3) return `https://ttsmp3.com/created_mp3_ai/${src.MP3}`;
      if (src.mp3) return `https://ttsmp3.com/created_mp3_ai/${src.mp3}`;
      throw new Error('Invalid API response structure');
    } catch (error) {
      throw new Error(`Failed to generate speech: ${error.message}`);
    }
  },

  // ── Random Content ──────────────────────────────────────────

  getMeme: async () => {
    try {
      const response = await api.get('https://meme-api.com/gimme');
      return response.data;
    } catch {
      throw new Error('Failed to fetch meme');
    }
  },

  getQuote: async () => {
    try {
      const response = await api.get('https://zenquotes.io/api/random');
      const item = Array.isArray(response.data) ? response.data[0] : response.data;
      return { content: item.q, author: item.a };
    } catch {
      throw new Error('Failed to fetch quote');
    }
  },

  getJoke: async () => {
    try {
      const response = await api.get('https://official-joke-api.appspot.com/random_joke');
      return response.data;
    } catch {
      throw new Error('Failed to fetch joke');
    }
  },

  getWeather: async (city) => {
    try {
      const response = await api.get('https://api.siputzx.my.id/api/tools/weather', { params: { city } });
      return response.data;
    } catch {
      throw new Error('Failed to fetch weather');
    }
  },

  // ── YouTube Audio Download ──────────────────────────────────

  getIzumiDownloadByUrl: async (youtubeUrl) => {
    const res = await tryRequest(() =>
      axios.get(`https://apiskeith2-production-3020.up.railway.app/download/audio?url=${encodeURIComponent(youtubeUrl)}`, DOWNLOAD_HEADERS)
    );
    if (res?.data?.status && res?.data?.result) {
      return { download: res.data.result };
    }
    throw new Error('no download URL returned');
  },

  getIzumiDownloadByQuery: async (query) => {
    const res = await tryRequest(() =>
      axios.get(`https://yt-dl.officialhectormanuel.workers.dev/?url=${encodeURIComponent(query)}`, DOWNLOAD_HEADERS)
    );
    if (res?.data?.audio) {
      return { download: res.data.audio, title: res.data.title, thumbnail: res.data.thumbnail };
    }
    throw new Error('Izumi query: no download URL returned');
  },

  getEliteProTechDownloadByUrl: async (youtubeUrl) => {
    const res = await tryRequest(() =>
      axios.get(`https://yt-dl.officialhectormanuel.workers.dev/?url=${encodeURIComponent(youtubeUrl)}`, DOWNLOAD_HEADERS)
    );
    if (res?.data?.audio) {
      return { download: res.data.audio, title: res.data.title };
    }
    throw new Error('casper audio: no download URL returned');
  },

  // ── YouTube Video Download ──────────────────────────────────

  getEliteProTechVideoByUrl: async (youtubeUrl) => {
    const res = await tryRequest(() =>
      axios.get(`https://apissupreme.vercel.app/media/ytmp4?apikey=supreme&url=${encodeURIComponent(youtubeUrl)}&format=mp4`, DOWNLOAD_HEADERS)
    );
    if (res?.data?.status && res?.data?.downloadUrl) {
      return { download: res.data.downloadUrl, title: res.data.title };
    }
    throw new Error('video: no download URL returned');
  },

  // ── Social Media Download ───────────────────────────────────

  igDownload: async (url) => {
    try {
      const response = await api.get('https://api.siputzx.my.id/api/d/igdl', { params: { url } });
      return response.data;
    } catch {
      throw new Error('Failed to download Instagram content');
    }
  },

  getTikTokDownload: async (url) => {
    try {
      const response = await axios.get(`https://api.siputzx.my.id/api/d/tiktok?url=${encodeURIComponent(url)}`, {
        timeout: 15000,
        headers: { 'User-Agent': DEFAULT_USER_AGENT },
      });
      if (response.data?.status && response.data?.data) {
        const d = response.data.data;
        const videoUrl = d.urls?.[0] || d.video_url || d.url || d.download_url || null;
        const title = d.metadata?.title || 'TikTok Video';
        return { videoUrl, title };
      }
      throw new Error('Invalid API response');
    } catch {
      throw new Error('TikTok download failed');
    }
  },

  // ── Stalker Profiles ────────────────────────────────────────

  stalkGitHub: async (username) => {
    const res = await api.get('https://apis.xwolf.space/api/stalk/github', { params: { username }, timeout: 20000 });
    const raw = res.data;
    const d = raw?.result || raw?.data || raw;
    if (!d || (!d.login && !d.username)) throw new Error('User not found on GitHub');
    return raw;
  },

  stalkInstagram: (username) =>
    giftedTechStalk('igstalk', 'username', username, 'User not found'),

  stalkIp: (address) =>
    giftedTechStalk('ipstalk', 'address', address, 'Could not retrieve IP information'),

  stalkNpm: (packagename) =>
    giftedTechStalk('npmstalk', 'packagename', packagename, 'Package not found on NPM', 25000),

  stalkTwitter: (username) =>
    giftedTechStalk('twitterstalk', 'username', username, 'User not found or Twitter API unavailable', 25000),

  stalkTikTok: async (username) => {
    try {
      const res = await api.get('https://apis.xwolf.space/api/stalk/tiktok', { params: { username }, timeout: 15000 });
      const d = res.data;
      if (d?.success && d?.username) {
        return {
          name: d.nickname || d.username, username: d.username, bio: d.bio || 'N/A',
          avatar: d.avatar || null, followers: d.followers ?? 0, following: d.following ?? 0,
          likes: d.likes ?? 0, videos: d.videos ?? null, verified: d.verified ?? false,
          private: d.privateAccount ?? false, profileUrl: d.profileUrl || null, source: 'xwolf',
        };
      }
    } catch {
      // fall through to GiftedTech backup below
    }

    const result = await giftedTechStalk('tiktokstalk', 'username', username, 'User not found', 20000);
    return {
      name: result.name || result.username, username: result.username || username, bio: result.bio || 'N/A',
      avatar: result.avatar || null, followers: result.followers ?? 0, following: result.following ?? 0,
      likes: result.likes ?? 0, videos: null, verified: result.verified ?? false,
      private: result.private ?? false, profileUrl: result.website?.link || null, source: 'gifted',
    };
  },

  stalkWachannel: async (url) => {
    const res = await api.get('https://api.giftedtech.co.ke/api/stalk/wachannel', {
      params: { apikey: 'gifted', url }, timeout: 20000,
    });
    if (!res.data?.success || !res.data?.result) throw new Error('Channel not found or invalid URL');
    return res.data.result;
  },
};

APIs.NVIDIA_DEFAULT_MODEL = NVIDIA_DEFAULT_MODEL;
APIs.NVIDIA_BASE_URL = NVIDIA_BASE_URL;
APIs.getNvidiaApiKey = getNvidiaApiKey;

module.exports = APIs;
