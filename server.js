/**
 * Sonara Voice Agent — Exotel Telephony WebSocket Bridge
 * Production-Ready | Full 2-Way AI Phone Conversation
 *
 * Flow:
 *   Exotel (mulaw 8kHz) <-> VAD <-> Groq Whisper STT <-> LLaMA 3.3-70B <-> ElevenLabs TTS
 *
 * Fixes applied:
 *  - No duplicate greeting (Exotel Greeting applet handles it)
 *  - StreamSid optional (works with or without it)
 *  - RMS threshold tuned for real GSM telephony (speech ~2000-8000, noise ~100-400)
 *  - Barge-in cooldown 3s so phone line noise never cancels Sonara mid-sentence
 *  - 160-byte audio frames (20ms @ 8kHz) for Exotel compatibility
 *  - Full error handling with automatic recovery
 *  - Conversation history maintained across full call
 */

import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import 'dotenv/config';

const PORT     = process.env.PORT             || 8080;
const GROQ_KEY = process.env.GROQ_API_KEY     || '';
const EL_KEY   = process.env.ELEVENLABS_API_KEY || '';
const EL_VOICE = process.env.ELEVENLABS_VOICE_ID || 'cgSgspJ2msm6clMCkdW9'; // Jessica

// ─────────────────────────────────────────────────────────────────────────────
// G.711 Mu-Law Decoding (Exotel sends mulaw 8kHz audio)
// ─────────────────────────────────────────────────────────────────────────────
const ULAW_TABLE = (() => {
    const t = new Int16Array(256);
    for (let i = 0; i < 256; i++) {
        let u = ~i;
        const sign = u & 0x80 ? -1 : 1;
        const exp  = (u >> 4) & 0x07;
        const mant = u & 0x0F;
        t[i] = sign * (((mant << 3) + 0x84) << exp) - sign * 0x84;
    }
    return t;
})();

/** Convert mulaw 8kHz buffer to 16kHz 16-bit PCM for Whisper */
function mulaw8kTo16kPcm(buf) {
    const out = new Int16Array(buf.length * 2);
    for (let i = 0; i < buf.length; i++) {
        const s1 = ULAW_TABLE[buf[i]];
        const s2 = i < buf.length - 1 ? ULAW_TABLE[buf[i + 1]] : s1;
        out[i * 2]     = s1;
        out[i * 2 + 1] = Math.round((s1 + s2) / 2);
    }
    return Buffer.from(out.buffer);
}

/** RMS energy — used for Voice Activity Detection */
function rms(buf) {
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += ULAW_TABLE[buf[i]] ** 2;
    return Math.sqrt(s / buf.length);
}

/** Build a WAV file from 16kHz 16-bit Mono PCM */
function toWav(pcm) {
    const hdr = Buffer.alloc(44);
    hdr.write('RIFF', 0);   hdr.writeUInt32LE(pcm.length + 36, 4);
    hdr.write('WAVE', 8);   hdr.write('fmt ', 12);
    hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20);
    hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(16000, 24);
    hdr.writeUInt32LE(32000, 28); hdr.writeUInt16LE(2, 32);
    hdr.writeUInt16LE(16, 34); hdr.write('data', 36);
    hdr.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([hdr, pcm]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sonara Master System Prompt
// ─────────────────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Sonara, the friendly and knowledgeable AI Solutions Specialist for Converse AI by Revti Digital, India.

SPEAKING RULES (Phone Call — CRITICAL):
- Respond in 1 to 3 SHORT natural spoken sentences only. Never more.
- No bullet points, no markdown, no asterisks, no lists — plain spoken words only.
- Be warm, confident, conversational. Like a real human specialist on the phone.
- If user speaks Hindi or Hinglish, reply naturally in Hinglish.
- Always end with a brief question to keep conversation going.

COMPANY KNOWLEDGE:
- Name: Converse AI (theconverseai.com) by Revti Digital, India
- Contact: contact@theconverseai.com | +91-9982323333 | +91-7023084065
- Services: AI Chatbots, WhatsApp AI (98% open rate), Voice AI Agents, Omni-Channel Inbox, CRM/ERP Integration, Enterprise RAG, Agentic Process Automation
- Case Studies:
  * StyleMart India (Retail): 3x repeat revenue, 65% support cost reduction, 94% CSAT
  * LearnSphere (EdTech): 2x course enrolments in 90 days, 80% faster lead response
  * CareFirst Clinics (Healthcare): 55% fewer no-shows, 120 admin hours saved monthly
- Pricing: Custom bespoke pricing. Starts with a 100% Free AI Readiness Audit at theconverseai.com/book-demo
- Clients: Tata Motors, Mapsor, Zapp Loans, Meghaa Modi Design Studio, Readiprint, Heritage Food Diary, 500+ businesses

CALL GOAL: Qualify the caller, understand their business need, and invite them to book a Free AI Opportunity Audit.`;

// ─────────────────────────────────────────────────────────────────────────────
// AI Services
// ─────────────────────────────────────────────────────────────────────────────

/** Groq Whisper STT — converts caller audio to text */
async function stt(wavBuf) {
    if (!GROQ_KEY) throw new Error('GROQ_API_KEY not set');
    const form = new FormData();
    form.append('file', new Blob([wavBuf], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', 'whisper-large-v3-turbo');
    form.append('response_format', 'json');
    form.append('temperature', '0');

    const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${GROQ_KEY}` },
        body: form,
        signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) throw new Error(`Whisper ${r.status}: ${await r.text()}`);
    return ((await r.json()).text || '').trim();
}

/** Groq LLaMA 3.3-70B — generates Sonara's conversational reply */
async function llm(history, userText) {
    if (!GROQ_KEY) return "I'm sorry, my AI brain isn't configured. Please call back later.";
    const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...history.slice(-8),
        { role: 'user', content: userText }
    ];
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages, temperature: 0.65, max_tokens: 160 }),
        signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) throw new Error(`LLM ${r.status}: ${await r.text()}`);
    return ((await r.json()).choices?.[0]?.message?.content || '').trim().replace(/[*_#`[\]]/g, '');
}

/** ElevenLabs Jessica TTS — streams mulaw 8kHz audio back to Exotel */
async function* tts(text) {
    if (!EL_KEY) { console.warn('[TTS] No ELEVENLABS_API_KEY'); return; }
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${EL_VOICE}/stream?output_format=ulaw_8000&optimize_streaming_latency=4`;
    const r = await fetch(url, {
        method: 'POST',
        headers: { 'xi-api-key': EL_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            text,
            model_id: 'eleven_turbo_v2_5',
            voice_settings: { stability: 0.45, similarity_boost: 0.80, style: 0.10, use_speaker_boost: true }
        })
    });
    if (!r.ok) { console.error('[TTS] ElevenLabs error:', r.status, await r.text()); return; }
    const reader = r.body.getReader();
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.length) yield Buffer.from(value);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Server — Health & Resolver Endpoints
// ─────────────────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
    const { url, headers } = req;

    if (url === '/' || url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'online', service: 'Sonara Telephony Bridge', ts: new Date().toISOString() }));
    }

    // Exotel HTTP resolver endpoint — returns WSS URL dynamically
    if (url === '/media' || url === '/voicebot') {
        const host = headers['x-forwarded-host'] || headers.host || `localhost:${PORT}`;
        const proto = headers['x-forwarded-proto'] === 'https' ? 'wss' : 'ws';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ stream_url: `${proto}://${host}/media` }));
    }

    res.writeHead(404); res.end();
});

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket Upgrade Handler
// ─────────────────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

// ─────────────────────────────────────────────────────────────────────────────
// Active Call Session — Handles one Exotel call per WebSocket connection
// ─────────────────────────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
    const remoteIp = req.socket.remoteAddress;
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[Exotel] 📞 Incoming call connection from: ${remoteIp}`);
    console.log('='.repeat(60));

    /* ── Session State ── */
    let streamSid       = null;
    let isAiSpeaking    = false;
    let isProcessing    = false;
    let aiStartedAt     = 0;
    let history         = [];
    let speechBuf       = [];
    let speechFrames    = 0;
    let silenceFrames   = 0;

    /* ── VAD Thresholds (tuned for GSM 8kHz mulaw) ── */
    const SPEECH_RMS    = 900;   // above this = caller speaking
    const BARGE_RMS     = 2000;  // above this = strong interruption while AI speaks
    const SILENCE_FRAMES = 22;  // ~700ms silence @ ~32ms/frame → end of utterance
    const MIN_SPEECH    = 5;    // minimum speech frames before processing
    const BARGE_COOLDOWN = 3000; // ms after AI starts — barge-in disabled

    /* ── Helpers ── */
    const send = (obj) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    };

    const sendAudio = (chunk) => {
        // Exotel expects 160-byte frames (20ms at 8kHz mulaw)
        for (let o = 0; o < chunk.length; o += 160) {
            const frame = chunk.subarray(o, Math.min(o + 160, chunk.length));
            const msg = { event: 'media', media: { payload: frame.toString('base64') } };
            if (streamSid) msg.streamSid = streamSid;
            send(msg);
        }
    };

    const clearQueue = () => {
        const msg = { event: 'clear' };
        if (streamSid) msg.streamSid = streamSid;
        send(msg);
    };

    /* ── Speak Response ── */
    const speak = async (text) => {
        if (!text) return;
        isAiSpeaking = true;
        aiStartedAt  = Date.now();
        console.log(`[Sonara] 🗣️  "${text}"`);
        try {
            for await (const chunk of tts(text)) {
                if (!isAiSpeaking) { console.log('[Sonara] ⛔ TTS interrupted'); break; }
                sendAudio(chunk);
            }
        } catch (e) {
            console.error('[Sonara] TTS error:', e.message);
        } finally {
            isAiSpeaking = false;
            speechBuf    = [];
            speechFrames = 0;
            silenceFrames = 0;
        }
    };

    /* ── Full AI Pipeline: Speech → Text → LLM → Voice ── */
    const processUtterance = async (mulawFrames) => {
        isProcessing = true;
        try {
            const raw  = Buffer.concat(mulawFrames);
            const pcm  = mulaw8kTo16kPcm(raw);
            const wav  = toWav(pcm);

            console.log(`[Pipeline] 🎙️  Transcribing ${raw.length} bytes of caller audio...`);
            const userText = await stt(wav);
            console.log(`[Caller]   💬 "${userText}"`);

            if (!userText || userText.length < 2) {
                console.log('[Pipeline] Empty transcription — skipping');
                return;
            }

            history.push({ role: 'user', content: userText });
            console.log('[Pipeline] 🤖 Generating Sonara response...');
            const reply = await llm(history, userText);
            history.push({ role: 'assistant', content: reply });

            await speak(reply);
        } catch (err) {
            console.error('[Pipeline] ❌ Error:', err.message);
            await speak("I'm sorry, I didn't catch that. Could you please repeat?");
        } finally {
            isProcessing = false;
        }
    };

    /* ── Exotel WebSocket Message Handler ── */
    ws.on('message', async (raw) => {
        let data;
        try { data = JSON.parse(raw.toString()); }
        catch { return; }

        switch (data.event) {

            case 'connected':
                console.log('[Exotel] ✅ WebSocket handshake connected');
                break;

            case 'start':
                // Log raw start event to understand Exotel's exact field names
                console.log('[Exotel] 📋 Start event received:', JSON.stringify(data).slice(0, 500));
                // Try all known Exotel streamSid field locations
                streamSid = data.streamSid
                    || data.start?.streamSid
                    || data.start?.stream_sid
                    || data.CallSid
                    || null;
                console.log(`[Exotel] 📞 Call live. StreamSid: ${streamSid}`);

                // NOTE: Greeting is handled by Exotel's own Greeting applet.
                // We only add it to history so LLM has context.
                history.push({ role: 'assistant', content: 'Namaste! Welcome to Converse AI. I am Sonara, your AI solutions specialist. How can I help you today?' });
                break;

            case 'media': {
                if (!data.media?.payload) return;

                const frame  = Buffer.from(data.media.payload, 'base64');
                const energy = rms(frame);

                // ── Barge-in: caller interrupts Sonara (only after 3s cooldown) ──
                if (isAiSpeaking) {
                    const elapsed = Date.now() - aiStartedAt;
                    if (energy > BARGE_RMS && elapsed > BARGE_COOLDOWN) {
                        speechFrames++;
                        if (speechFrames >= 6) {
                            console.log(`[Barge-In] ⚡ Caller interrupted! RMS=${Math.round(energy)}, elapsed=${elapsed}ms`);
                            isAiSpeaking = false;
                            clearQueue();
                            speechBuf    = [];
                            speechFrames = 0;
                            silenceFrames = 0;
                        }
                    }
                    return; // Don't collect speech while AI is speaking
                }

                if (isProcessing) return; // Don't collect speech while processing previous utterance

                // ── Voice Activity Detection ──
                if (energy > SPEECH_RMS) {
                    if (speechFrames === 0) console.log(`[VAD] 🎙️  Speech onset detected. RMS=${Math.round(energy)}`);
                    speechFrames++;
                    silenceFrames = 0;
                    speechBuf.push(frame);
                } else {
                    // Silence
                    if (speechBuf.length > 0) {
                        silenceFrames++;
                        speechBuf.push(frame); // include trailing silence for natural boundaries

                        if (silenceFrames >= SILENCE_FRAMES && speechFrames >= MIN_SPEECH) {
                            // Utterance complete — process it
                            console.log(`[VAD] ✅ Utterance complete. Frames: speech=${speechFrames}, silence=${silenceFrames}`);
                            const frames  = [...speechBuf];
                            speechBuf     = [];
                            speechFrames  = 0;
                            silenceFrames = 0;
                            processUtterance(frames); // async — don't await
                        }
                    } else {
                        // Noise floor logging (0.2% of frames)
                        if (Math.random() < 0.002) {
                            console.log(`[VAD] 📉 Noise floor: RMS=${Math.round(energy)} (threshold=${SPEECH_RMS})`);
                        }
                    }
                }
                break;
            }

            case 'stop':
                console.log(`[Exotel] 📵 Call ended. StreamSid: ${streamSid}`);
                console.log(`[Session] Conversation had ${history.length} turns`);
                ws.close();
                break;

            default:
                if (data.event) console.log(`[Exotel] Unknown event: ${data.event}`);
        }
    });

    ws.on('close', () => {
        console.log(`[Exotel] 🔌 WebSocket closed for stream: ${streamSid}`);
        isAiSpeaking = false;
        speechBuf    = [];
    });

    ws.on('error', (err) => {
        console.error('[WebSocket] Error:', err.message);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Start Server
// ─────────────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
    console.log('='.repeat(60));
    console.log('🚀  SONARA TELEPHONY WEBSOCKET BRIDGE — ONLINE');
    console.log(`📡  Port        : ${PORT}`);
    console.log(`🔗  Health      : http://localhost:${PORT}/health`);
    console.log(`🎙️   WebSocket   : ws://localhost:${PORT}/media`);
    console.log(`🔑  Groq Key    : ${GROQ_KEY ? '✅ Set' : '❌ MISSING'}`);
    console.log(`🔑  ElevenLabs  : ${EL_KEY   ? '✅ Set' : '❌ MISSING'}`);
    console.log('='.repeat(60));
});
