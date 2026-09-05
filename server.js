/**
 * Sonara Voice Agent — Exotel Telephony WebSocket Bridge
 * Production-Ready v2 | Full 2-Way AI Phone Conversation
 * Telephony VAD Calibrated for GSM/VoLTE (RMS 380)
 * Live In-Memory Logs (/logs) & Health Diagnostics (/health)
 */

import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import 'dotenv/config';

const PORT     = process.env.PORT              || 8080;
const GROQ_KEY = process.env.GROQ_API_KEY      || '';
const EL_KEY   = process.env.ELEVENLABS_API_KEY || '';
const EL_VOICE = process.env.ELEVENLABS_VOICE_ID || 'cgSgspJ2msm6clMCkdW9'; // Jessica

// ─────────────────────────────────────────────────────────────────────────────
// In-Memory Diagnostic Log Buffer (Accessible via GET /logs)
// ─────────────────────────────────────────────────────────────────────────────
const LOGS = [];
function log(tag, msg) {
    const time = new Date().toISOString().substring(11, 19);
    const line = `[${time}] [${tag}] ${msg}`;
    LOGS.push(line);
    if (LOGS.length > 300) LOGS.shift();
    console.log(line);
}

function logErr(tag, msg) {
    const time = new Date().toISOString().substring(11, 19);
    const line = `[${time}] [${tag}] ❌ ${msg}`;
    LOGS.push(line);
    if (LOGS.length > 300) LOGS.shift();
    console.error(line);
}

// ─────────────────────────────────────────────────────────────────────────────
// G.711 Mu-Law → Linear PCM Decode Table (8kHz native)
// ─────────────────────────────────────────────────────────────────────────────
const ULAW_TABLE = (() => {
    const t = new Int16Array(256);
    for (let i = 0; i < 256; i++) {
        const u    = ~i & 0xFF;
        const sign = u & 0x80;
        const exp  = (u >> 4) & 0x07;
        const mant = u & 0x0F;
        let s = ((mant << 3) | 0x84) << exp;
        t[i] = sign ? -s : s;
    }
    return t;
})();

/** RMS energy of a mulaw buffer — used for VAD */
function rmsOf(buf) {
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += ULAW_TABLE[buf[i]] ** 2;
    return Math.sqrt(sum / buf.length);
}

/**
 * Build a VALID 8 kHz, 16-bit, Mono WAV from raw mulaw bytes.
 * Whisper handles native 8 kHz WAV without distortion or upsampling artifacts.
 */
function mulawToWav8k(mulawBuf) {
    const samples = new Int16Array(mulawBuf.length);
    for (let i = 0; i < mulawBuf.length; i++) samples[i] = ULAW_TABLE[mulawBuf[i]];
    const pcm = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);

    const hdr = Buffer.alloc(44);
    hdr.write('RIFF', 0);
    hdr.writeUInt32LE(pcm.length + 36, 4);
    hdr.write('WAVE', 8);
    hdr.write('fmt ', 12);
    hdr.writeUInt32LE(16,    16);   // Subchunk1Size
    hdr.writeUInt16LE(1,     20);   // PCM = 1
    hdr.writeUInt16LE(1,     22);   // Mono
    hdr.writeUInt32LE(8000,  24);   // SampleRate = 8000 Hz
    hdr.writeUInt32LE(16000, 28);   // ByteRate = 8000 * 1 * 2
    hdr.writeUInt16LE(2,     32);   // BlockAlign = 1 * 2
    hdr.writeUInt16LE(16,    34);   // BitsPerSample = 16
    hdr.write('data', 36);
    hdr.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([hdr, pcm]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sonara Master System Prompt
// ─────────────────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Sonara, the official Conversational AI Solutions Specialist for Converse AI by Revti Digital, India (theconverseai.com).

CRITICAL ANSWER LENGTH RULE — MAXIMUM 5 LINES:
- Live phone call answers MUST be concise: MAXIMUM 5 LINES (maximum 5 clear sentences).
- Explain EVERYTHING in the caller's question directly, completely, and clearly within these 3 to 5 lines.
- NO rambling, NO repetitive filler, and NO long monologues.
- Deliver high clarity and complete explanation fast so the caller never waits through long answers.
- Never exceed 5 lines/sentences under any circumstances.

PHONE CALL RULES:
- You are speaking on a live phone call. Be warm, confident, articulate, and natural.
- Answer the caller's actual question directly first with substantive, clear details within the 5-line limit.
- Use context and conversation history to understand short follow-up questions.
- When asked for examples or case studies, summarize the client, challenge, solution, and verified metrics in 3-5 lines.
- Never repeat greetings once the call has started.
- Match caller's language naturally: English -> English; Hindi/Hinglish -> natural Hinglish.
- Spoken sentences only. NO markdown, NO asterisks, NO bullet points, NO headings.
- Never invent facts, numbers, clients, or fixed pricing.

COMPANY KNOWLEDGE:
- Company: Converse AI (theconverseai.com) by Revti Digital, based in Jaipur, Rajasthan, India
- Contact: contact@theconverseai.com | +91-9982323333 | +91-7023084065
- Core Services:
  1) Multilingual Inbound & Outbound AI Voice Agents for customer support, lead qualification, and appointment scheduling in 100+ languages
  2) WhatsApp AI Automation with 98% open rates for 24/7 lead generation and query resolution
  3) Omni-Channel Unified Support Inbox across Web, WhatsApp, Instagram, and Email
  4) Enterprise RAG (Document & Knowledge Intelligence) with private cloud deployment
  5) Custom AI Agent Development and CRM/ERP Process Automation
- Verified Case Studies:
  * StyleMart India (Retail): 3x repeat purchase revenue, 65% support cost reduction, under 30s response time, 94% CSAT
  * LearnSphere (EdTech): Doubled course enrolments in 90 days, 80% faster lead response time, 500+ daily qualified leads
  * CareFirst Clinics (Healthcare): 55% reduction in appointment no-shows, 120 admin hours saved monthly, 91% booking fill rate
- Pricing: Custom bespoke based on workflow and scale. Starts with a 100% Free AI Opportunity & Readiness Audit at theconverseai.com/book-demo
- Clients: Tata Motors, Mapsor Experiential Weddings, Zapp Loans, Meghaa Modi Studio, Readiprint Fashions, Heritage Food Diary, 500+ businesses`;

// ─────────────────────────────────────────────────────────────────────────────
// AI Services
// ─────────────────────────────────────────────────────────────────────────────

/** Groq Whisper STT — transcribes caller audio to text */
async function stt(wavBuf) {
    const groqKey = process.env.GROQ_API_KEY || GROQ_KEY;
    if (!groqKey) throw new Error('GROQ_API_KEY not configured');
    const form = new FormData();
    form.append('file', new Blob([wavBuf], { type: 'audio/wav' }), 'call.wav');
    form.append('model', 'whisper-large-v3-turbo');
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0');
    form.append('prompt', 'Converse AI, Sonara, Namaste, hello, pricing, services, demo, booking, WhatsApp, Hindi, Hinglish, case studies.');

    const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${groqKey}` },
        body: form,
        signal: AbortSignal.timeout(10000)
    });

    if (!r.ok) {
        const errText = await r.text();
        logErr('STT', `Error ${r.status}: ${errText}`);
        throw new Error(`Whisper ${r.status}: ${errText}`);
    }

    const data = await r.json();
    const text = (data.text || '').trim();
    const lang = data.language || 'unknown';
    const dur  = data.duration  || 0;
    log('STT', `Language: ${lang}, Duration: ${dur.toFixed(1)}s, Text: "${text}"`);
    return text;
}

function clampToMax5Lines(text) {
    if (!text) return '';
    let clean = text.replace(/[*_#`[\]]/g, '').replace(/\s{2,}/g, ' ').trim();
    const sentences = clean.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g);
    if (sentences && sentences.length > 5) {
        clean = sentences.slice(0, 5).map(s => s.trim()).join(' ');
    }
    return clean;
}

/** Groq LLM — generates Sonara's spoken reply */
async function llm(history, userText) {
    const groqKey = process.env.GROQ_API_KEY || GROQ_KEY;
    if (!groqKey) return "I'm sorry, my language system is temporarily offline. Please try calling back in a moment.";
    const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...history.slice(-12),
        { role: 'user', content: userText }
    ];
    const candidateModels = ['qwen/qwen3.8-27b', 'qwen/qwen3.6-27b', 'openai/gpt-oss-20b'];
    let reply = '';
    let lastErr = null;

    for (const modelCandidate of candidateModels) {
        try {
            log('LLM', `Calling ${modelCandidate}...`);
            const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: modelCandidate,
                    messages,
                    temperature: 0.65,
                    max_tokens: 220
                }),
                signal: AbortSignal.timeout(9000)
            });
            if (r.ok) {
                const data = await r.json();
                reply = clampToMax5Lines(data.choices?.[0]?.message?.content || '');
                break;
            } else {
                const txt = await r.text();
                lastErr = new Error(`LLM ${r.status}: ${txt}`);
                logErr('LLM', `Model ${modelCandidate} failed: ${txt}`);
                continue;
            }
        } catch (e) {
            lastErr = e;
            logErr('LLM', `Exception on ${modelCandidate}: ${e.message}`);
        }
    }

    if (!reply) throw lastErr || new Error('All Groq models failed.');
    log('LLM', `Reply: "${reply}"`);
    return reply;
}

/** ElevenLabs Jessica TTS — streams mulaw 8kHz audio to phone */
async function* tts(text) {
    const elKey = process.env.ELEVENLABS_API_KEY || EL_KEY;
    if (!elKey) {
        logErr('TTS', 'No ELEVENLABS_API_KEY configured in environment!');
        return;
    }
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${EL_VOICE}/stream?output_format=ulaw_8000&optimize_streaming_latency=4`;
    const r = await fetch(url, {
        method: 'POST',
        headers: { 'xi-api-key': elKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            text,
            model_id: 'eleven_flash_v2_5',
            voice_settings: { stability: 0.45, similarity_boost: 0.82, style: 0.1, use_speaker_boost: true }
        })
    });
    if (!r.ok) {
        const errText = await r.text();
        logErr('TTS', `Error ${r.status}: ${errText}`);
        if (r.status === 401 && errText.includes('quota_exceeded')) {
            logErr('TTS', '⚠️ ElevenLabs character quota is 100% EXHAUSTED! Please update ELEVENLABS_API_KEY in Render dashboard.');
        }
        return;
    }
    const reader = r.body.getReader();
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.length) yield Buffer.from(value);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Server
// ─────────────────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        return res.end();
    }

    if (req.url === '/' || req.url === '/health') {
        const groq = process.env.GROQ_API_KEY || GROQ_KEY;
        const el   = process.env.ELEVENLABS_API_KEY || EL_KEY;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            status: 'online',
            service: 'Sonara Telephony Bridge v2',
            groqConfigured: !!groq,
            groqKeySuffix: groq ? `...${groq.slice(-6)}` : null,
            elevenLabsConfigured: !!el,
            elevenLabsKeySuffix: el ? `...${el.slice(-6)}` : null,
            activeCalls: wss.clients.size,
            uptimeSec: Math.round(process.uptime()),
            ts: new Date().toISOString()
        }));
    }

    if (req.url === '/logs') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(LOGS.length ? LOGS.join('\n') : 'No call logs recorded yet. Initiate a phone call to view live bridge logs.');
    }

    if (req.url === '/media' || req.url === '/voicebot') {
        const host  = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
        const proto = req.headers['x-forwarded-proto'] === 'https' ? 'wss' : 'ws';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ stream_url: `${proto}://${host}/media` }));
    }

    res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

// ─────────────────────────────────────────────────────────────────────────────
// Call Session Handler
// ─────────────────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
    log('Call', '═══════════════════════════════════════════════════════');
    log('Call', '📞 NEW EXOTEL PHONE CALL CONNECTED');
    log('Call', '═══════════════════════════════════════════════════════');

    /* ── Session state ── */
    let streamSid     = null;
    let isAiSpeaking  = false;
    let isProcessing  = false;
    let aiStartedAt   = 0;
    let history       = [];
    let speechBuf     = [];
    let speechFrames  = 0;
    let silenceFrames = 0;
    let frameCount    = 0;
    let greetingTimer = null;

    /* ── VAD tuning for GSM 8kHz mulaw telephony ──
     *  Typical values:
     *    Line noise / baseline: RMS  120 – 240
     *    Normal mobile voice  : RMS  350 – 900
     *    Loud voice           : RMS  1200+
     */
    const SPEECH_RMS        = 380;  // lowered to 380 for natural mobile speech pickup
    const BARGE_RMS         = 1800; // caller interruption threshold
    const SILENCE_FRAMES    = 20;   // ~400ms silence (at 20ms/frame) → utterance finished
    const MIN_SPEECH_FRAMES = 5;    // ~100ms min speech to reject quick noise clicks
    const MIN_AUDIO_BYTES   = 2000; // ~250ms of audio
    const BARGE_COOLDOWN_MS = 1000; // allow interruption after 1.0s

    /* ── Audio helpers ── */
    const sendAudio = (chunk) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        for (let o = 0; o < chunk.length; o += 160) {
            const frame = chunk.subarray(o, Math.min(o + 160, chunk.length));
            const msg = {
                event: 'media',
                stream_sid: streamSid,
                streamSid: streamSid,
                media: { payload: frame.toString('base64') }
            };
            ws.send(JSON.stringify(msg));
        }
    };

    const clearQueue = () => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const msg = {
            event: 'clear',
            stream_sid: streamSid,
            streamSid: streamSid
        };
        ws.send(JSON.stringify(msg));
    };

    /* ── Speak a text response ── */
    const speak = async (text) => {
        if (!text) return;
        isAiSpeaking = true;
        aiStartedAt  = Date.now();
        log('Sonara', `🗣️ "${text}"`);
        let totalSentBytes = 0;
        try {
            for await (const chunk of tts(text)) {
                if (!isAiSpeaking) { log('Sonara', '⛔ Interrupted by caller'); break; }
                sendAudio(chunk);
                totalSentBytes += chunk.length;
            }

            // Synchronize with phone playback (8000 bytes = 1 second)
            if (isAiSpeaking && totalSentBytes > 0) {
                const totalDurationMs = (totalSentBytes / 8000) * 1000;
                const streamElapsedMs = Date.now() - aiStartedAt;
                const remainingWaitMs = Math.max(0, totalDurationMs - streamElapsedMs);
                log('Sonara', `Sent ${totalSentBytes}b (${(totalDurationMs/1000).toFixed(1)}s). Waiting ${Math.round(remainingWaitMs)}ms playback.`);
                // Reduced echo margin to 100ms so caller's response is never locked out
                await new Promise(r => setTimeout(r, remainingWaitMs + 100));
            }
        } catch (e) {
            logErr('TTS', e.message);
        } finally {
            isAiSpeaking  = false;
            speechBuf     = [];
            speechFrames  = 0;
            silenceFrames = 0;
            log('Sonara', '🏁 Playback complete, listening for caller response...');
        }
    };

    /* ── Full AI pipeline ── */
    const processUtterance = async (frames) => {
        isProcessing = true;
        try {
            const raw = Buffer.concat(frames);
            log('Pipeline', `🎙️ Processing ${raw.length} bytes (${(raw.length / 8000).toFixed(2)}s audio)`);

            // Minimum audio duration guard
            if (raw.length < MIN_AUDIO_BYTES) {
                log('Pipeline', `⚠️ Audio too short (${raw.length}b < ${MIN_AUDIO_BYTES}b) — skipping`);
                return;
            }

            // Convert to WAV
            const wav = mulawToWav8k(raw);

            // STT
            let userText;
            try {
                userText = await stt(wav);
            } catch (e) {
                logErr('STT', e.message);
                await speak("I'm sorry, I couldn't hear you clearly. Could you repeat that?");
                return;
            }

            // Filter garbage / too-short transcriptions
            const cleaned = userText.replace(/[^a-zA-Z\u0900-\u097F0-9\s]/g, '').trim();
            if (!cleaned || cleaned.length < 2) {
                log('Pipeline', `⚠️ Transcription too short or empty: "${userText}" (audio bytes: ${raw.length})`);
                if (raw.length >= 8000) {
                    // Caller spoke for >= 1s, but STT missed it — prompt caller
                    await speak("I'm sorry, I didn't quite catch that. Could you please repeat your question?");
                }
                return;
            }

            // LLM
            history.push({ role: 'user', content: userText });
            let reply;
            try {
                reply = await llm(history, userText);
            } catch (e) {
                logErr('LLM', e.message);
                reply = "I'm sorry, I had a brief issue. Could you repeat your question?";
            }
            history.push({ role: 'assistant', content: reply });

            // Speak reply
            await speak(reply);

        } finally {
            isProcessing = false;
        }
    };

    /* ── WebSocket message handler ── */
    ws.on('message', async (raw) => {
        let data;
        try { data = JSON.parse(raw.toString()); } catch { return; }

        switch (data.event) {

            case 'connected':
                log('Exotel', '✅ Handshake connected');
                break;

            case 'start':
                log('Exotel', `📋 Start payload: ${JSON.stringify(data).slice(0, 300)}`);
                streamSid = data.streamSid || data.start?.streamSid || data.start?.stream_sid || null;
                log('Exotel', `📞 Call live. StreamSid: ${streamSid}`);
                
                // Add greeting to history
                history.push({ role: 'assistant', content: 'Namaste! Welcome to Converse AI. I am Sonara, your AI solutions specialist. How can I help you today?' });

                // Proactive greeting fallback: greet the caller after connect if silence
                if (greetingTimer) clearTimeout(greetingTimer);
                greetingTimer = setTimeout(() => {
                    if (ws.readyState === WebSocket.OPEN && speechFrames === 0 && !isAiSpeaking && !isProcessing) {
                        log('Exotel', '⏱️ Speaking initial proactive greeting');
                        speak('Namaste! Welcome to Converse AI. I am Sonara. How can I help you today?');
                    }
                }, 2500);
                break;

            case 'media': {
                if (!data.media?.payload) return;
                frameCount++;
                const frame  = Buffer.from(data.media.payload, 'base64');
                const energy = rmsOf(frame);

                // Periodic noise floor log (every ~5 seconds = 250 frames at 20ms each)
                if (frameCount % 250 === 0) {
                    log('VAD', `📊 Frame ${frameCount}, RMS=${Math.round(energy)}, speechFrames=${speechFrames}, silenceFrames=${silenceFrames}, speaking=${isAiSpeaking}, processing=${isProcessing}`);
                }

                // ── Barge-in handling ──
                if (isAiSpeaking) {
                    const elapsed = Date.now() - aiStartedAt;
                    if (energy > BARGE_RMS && elapsed > BARGE_COOLDOWN_MS) {
                        speechFrames++;
                        if (speechFrames >= 8) {
                            log('Barge-In', `⚡ Sustained interruption! RMS=${Math.round(energy)}, elapsed=${elapsed}ms`);
                            isAiSpeaking = false;
                            clearQueue();
                            speechBuf    = [];
                            speechFrames = 0;
                            silenceFrames = 0;
                        }
                    }
                    return;
                }

                if (isProcessing) return;

                // ── Voice Activity Detection ──
                if (energy > SPEECH_RMS) {
                    if (greetingTimer) { clearTimeout(greetingTimer); greetingTimer = null; }
                    if (speechFrames === 0) log('VAD', `🎙️ Speech onset! RMS=${Math.round(energy)}`);
                    speechFrames++;
                    silenceFrames = 0;
                    speechBuf.push(frame);
                } else if (speechBuf.length > 0) {
                    silenceFrames++;
                    speechBuf.push(frame);

                    // Utterance complete: enough speech + enough silence
                    if (silenceFrames >= SILENCE_FRAMES && speechFrames >= MIN_SPEECH_FRAMES) {
                        const totalBytes = speechBuf.reduce((a, b) => a + b.length, 0);
                        log('VAD', `✅ Utterance complete — speech=${speechFrames}fr, silence=${silenceFrames}fr, bytes=${totalBytes}`);
                        const frames  = [...speechBuf];
                        speechBuf     = [];
                        speechFrames  = 0;
                        silenceFrames = 0;
                        processUtterance(frames);
                    } else if (silenceFrames > 35 && speechFrames < MIN_SPEECH_FRAMES) {
                        // Discard false noise blip / breath click to prevent buffer accumulation
                        speechBuf     = [];
                        speechFrames  = 0;
                        silenceFrames = 0;
                    }
                }
                break;
            }

            case 'stop':
                log('Exotel', `📵 Call ended. Total frames: ${frameCount}, Turns: ${Math.floor(history.length / 2)}`);
                if (greetingTimer) { clearTimeout(greetingTimer); greetingTimer = null; }
                ws.close();
                break;

            default:
                if (data.event) log('Exotel', `Event: ${data.event}`);
        }
    });

    ws.on('close', () => {
        log('Call', '📵 Call connection closed');
        if (greetingTimer) { clearTimeout(greetingTimer); greetingTimer = null; }
        isAiSpeaking = false;
        isProcessing = false;
        speechBuf = [];
    });

    ws.on('error', (e) => logErr('WS', e.message));
});

// ─────────────────────────────────────────────────────────────────────────────
// Start Server
// ─────────────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
    log('Server', '═'.repeat(55));
    log('Server', '🚀 SONARA TELEPHONY BRIDGE — PRODUCTION v2');
    log('Server', `📡 Port      : ${PORT}`);
    log('Server', `🔑 Groq      : ${GROQ_KEY ? '✅ CONFIGURED' : '❌ MISSING'}`);
    log('Server', `🔑 ElevenLabs: ${EL_KEY   ? '✅ CONFIGURED' : '❌ MISSING'}`);
    log('Server', '═'.repeat(55));
});
