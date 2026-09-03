/**
 * Sonara Voice Agent — Exotel Telephony WebSocket Bridge
 * Production-Ready v2 | Full 2-Way AI Phone Conversation
 * STT Fix: Proper mulaw decode, 8kHz native WAV, minimum duration guard,
 *           language hint, transcription validation, detailed diagnostics
 */

import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import 'dotenv/config';

const PORT     = process.env.PORT              || 8080;
const GROQ_KEY = process.env.GROQ_API_KEY      || '';
const EL_KEY   = process.env.ELEVENLABS_API_KEY || '';
const EL_VOICE = process.env.ELEVENLABS_VOICE_ID || 'cgSgspJ2msm6clMCkdW9'; // Jessica

// ─────────────────────────────────────────────────────────────────────────────
// G.711 Mu-Law → Linear PCM Decode Table  (reference implementation)
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
 * We decode mulaw → PCM16 and keep the native 8kHz sample rate.
 * Whisper handles 8 kHz natively — no upsampling artifacts.
 */
function mulawToWav8k(mulawBuf) {
    const samples = new Int16Array(mulawBuf.length);
    for (let i = 0; i < mulawBuf.length; i++) samples[i] = ULAW_TABLE[mulawBuf[i]];
    const pcm = Buffer.from(samples.buffer);

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
const SYSTEM_PROMPT = `You are Sonara, the warm and knowledgeable AI Solutions Specialist for Converse AI by Revti Digital, India.

PHONE CALL RULES — CRITICAL:
- You are on a PHONE CALL. Speak naturally. Keep every reply to 1-3 short spoken sentences ONLY.
- NO bullet points. NO markdown. NO asterisks. NO lists. Only plain conversational speech.
- Be warm, confident, and professional like a real human specialist on the phone.
- If the user speaks Hindi or Hinglish, reply in natural Hinglish.
- Always close with a brief follow-up question to keep the conversation going.
- If you hear garbled or unclear input, politely ask them to repeat.

COMPANY KNOWLEDGE:
- Company: Converse AI (theconverseai.com) by Revti Digital, India
- Contact: contact@theconverseai.com | +91-9982323333 | +91-7023084065
- Core Services: AI Chatbots, WhatsApp AI (98% open rate), Inbound & Outbound Voice AI Agents, Omni-Channel Inbox, CRM/ERP Integration, Enterprise RAG Knowledge Bases, Agentic Process Automation
- Case Studies:
  * StyleMart India (Retail): 3x repeat purchase revenue, 65% support cost reduction, 94% CSAT
  * LearnSphere (EdTech): 2x course enrolments in 90 days, 80% faster lead response time
  * CareFirst Clinics (Healthcare): 55% fewer appointment no-shows, 120 admin hours saved monthly
- Pricing: Custom bespoke — no rigid tiers. Starts with a 100% Free AI Readiness Audit at theconverseai.com/book-demo
- Clients: Tata Motors, Mapsor, Zapp Loans, Meghaa Modi Studio, Readiprint, Heritage Food Diary, 500+ businesses

CALL GOAL: Understand the caller's business pain point and invite them to book a Free AI Opportunity Audit.`;

// ─────────────────────────────────────────────────────────────────────────────
// AI Services
// ─────────────────────────────────────────────────────────────────────────────

/** Groq Whisper STT — transcribes caller audio to text */
async function stt(wavBuf) {
    if (!GROQ_KEY) throw new Error('GROQ_API_KEY not configured');
    const form = new FormData();
    form.append('file', new Blob([wavBuf], { type: 'audio/wav' }), 'call.wav');
    form.append('model', 'whisper-large-v3-turbo');
    form.append('response_format', 'verbose_json'); // get confidence + language info
    form.append('temperature', '0');
    // Prompt helps Whisper understand this is a business call context
    form.append('prompt', 'This is a business phone call. The speaker may ask about AI, chatbots, WhatsApp automation, voice agents, pricing, or case studies in English or Hindi.');

    const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${GROQ_KEY}` },
        body: form,
        signal: AbortSignal.timeout(10000)
    });

    if (!r.ok) {
        const errText = await r.text();
        throw new Error(`Whisper ${r.status}: ${errText}`);
    }

    const data = await r.json();
    const text = (data.text || '').trim();
    const lang = data.language || 'unknown';
    const dur  = data.duration  || 0;
    console.log(`[STT] Language: ${lang}, Duration: ${dur.toFixed(1)}s, Text: "${text}"`);
    return text;
}

/** Groq LLaMA 3.3-70B — generates Sonara's spoken reply */
async function llm(history, userText) {
    if (!GROQ_KEY) return "I'm sorry, I can't respond right now. Please call back.";
    const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...history.slice(-10),
        { role: 'user', content: userText }
    ];
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages,
            temperature: 0.65,
            max_tokens: 160
        }),
        signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) throw new Error(`LLM ${r.status}: ${await r.text()}`);
    const reply = ((await r.json()).choices?.[0]?.message?.content || '').trim().replace(/[*_#`[\]]/g, '');
    console.log(`[LLM] Reply: "${reply}"`);
    return reply;
}

/** ElevenLabs Jessica TTS — streams mulaw 8kHz audio to phone */
async function* tts(text) {
    if (!EL_KEY) { console.warn('[TTS] No ELEVENLABS_API_KEY'); return; }
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${EL_VOICE}/stream?output_format=ulaw_8000&optimize_streaming_latency=4`;
    const r = await fetch(url, {
        method: 'POST',
        headers: { 'xi-api-key': EL_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            text,
            model_id: 'eleven_turbo_v2_5',
            voice_settings: { stability: 0.45, similarity_boost: 0.82, style: 0.1, use_speaker_boost: true }
        })
    });
    if (!r.ok) { console.error('[TTS] Error:', r.status, await r.text()); return; }
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
    if (req.url === '/' || req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'online', service: 'Sonara Telephony Bridge', ts: new Date().toISOString() }));
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
    console.log('\n' + '═'.repeat(60));
    console.log('📞  NEW CALL CONNECTED');
    console.log('═'.repeat(60));

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

    /* ── VAD tuning for GSM 8kHz mulaw ──
     *  Typical values:
     *    Silence / line noise : RMS  50 – 400
     *    Soft speech          : RMS  500 – 1500
     *    Normal speech        : RMS  1500 – 5000
     *    Loud speech          : RMS  5000+
     */
    const SPEECH_RMS    = 700;  // above → caller speaking
    const BARGE_RMS     = 4500; // above → strong deliberate caller interruption
    const SILENCE_FRAMES = 25;  // ~800ms silence → utterance complete
    const MIN_SPEECH_FRAMES = 8; // ~256ms minimum speech before processing
    const MIN_AUDIO_BYTES   = 3200; // ~400ms of audio (8000 * 0.4 = 3200 bytes)
    const BARGE_COOLDOWN_MS = 4000;

    /* ── Audio helpers ── */
    const sendAudio = (chunk) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        for (let o = 0; o < chunk.length; o += 160) {
            const frame = chunk.subarray(o, Math.min(o + 160, chunk.length));
            const msg = { event: 'media', media: { payload: frame.toString('base64') } };
            if (streamSid) msg.streamSid = streamSid;
            ws.send(JSON.stringify(msg));
        }
    };

    const clearQueue = () => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const msg = { event: 'clear' };
        if (streamSid) msg.streamSid = streamSid;
        ws.send(JSON.stringify(msg));
    };

    /* ── Speak a text response ── */
    const speak = async (text) => {
        if (!text) return;
        isAiSpeaking = true;
        aiStartedAt  = Date.now();
        console.log(`[Sonara] 🗣️  "${text}"`);
        let totalSentBytes = 0;
        try {
            for await (const chunk of tts(text)) {
                if (!isAiSpeaking) { console.log('[Sonara] ⛔ Interrupted'); break; }
                sendAudio(chunk);
                totalSentBytes += chunk.length;
            }

            // Synchronize with phone playback (8000 bytes = 1 second)
            // Prevents closing AI speaking state early and cutting off last sentences
            if (isAiSpeaking && totalSentBytes > 0) {
                const totalDurationMs = (totalSentBytes / 8000) * 1000;
                const streamElapsedMs = Date.now() - aiStartedAt;
                const remainingWaitMs = Math.max(0, totalDurationMs - streamElapsedMs);
                console.log(`[Sonara] Audio sent: ${totalSentBytes}b (${(totalDurationMs/1000).toFixed(1)}s). Waiting ${Math.round(remainingWaitMs)}ms for phone playback...`);
                // Wait for audio to play out on phone speaker + 500ms echo margin
                await new Promise(r => setTimeout(r, remainingWaitMs + 500));
            }
        } catch (e) {
            console.error('[TTS]', e.message);
        } finally {
            isAiSpeaking  = false;
            speechBuf     = [];
            speechFrames  = 0;
            silenceFrames = 0;
            console.log('[Sonara] 🏁 Playback complete, listening for caller response...');
        }
    };

    /* ── Full AI pipeline ── */
    const processUtterance = async (frames) => {
        isProcessing = true;
        try {
            const raw = Buffer.concat(frames);
            console.log(`[Pipeline] 🎙️  Processing ${raw.length} bytes (${(raw.length / 8000).toFixed(2)}s audio)`);

            // Minimum audio duration guard
            if (raw.length < MIN_AUDIO_BYTES) {
                console.log(`[Pipeline] ⚠️  Audio too short (${raw.length} bytes < ${MIN_AUDIO_BYTES}) — skipping`);
                return;
            }

            // Convert to WAV
            const wav = mulawToWav8k(raw);

            // STT
            let userText;
            try {
                userText = await stt(wav);
            } catch (e) {
                console.error('[STT] Error:', e.message);
                await speak("I'm sorry, I couldn't hear you clearly. Could you repeat that?");
                return;
            }

            // Filter garbage / too-short transcriptions
            const cleaned = userText.replace(/[^a-zA-Z\u0900-\u097F0-9\s]/g, '').trim();
            if (!cleaned || cleaned.length < 3) {
                console.log(`[Pipeline] ⚠️  Transcription too short or empty: "${userText}" — skipping`);
                return;
            }

            // LLM
            history.push({ role: 'user', content: userText });
            let reply;
            try {
                reply = await llm(history, userText);
            } catch (e) {
                console.error('[LLM] Error:', e.message);
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
                console.log('[Exotel] ✅ Handshake connected');
                break;

            case 'start':
                console.log('[Exotel] 📋 Raw start:', JSON.stringify(data).slice(0, 500));
                streamSid = data.streamSid || data.start?.streamSid || data.start?.stream_sid || null;
                console.log(`[Exotel] 📞 Call live. StreamSid: ${streamSid}`);
                // Add greeting to history (Exotel's own Greeting applet already spoke it)
                history.push({ role: 'assistant', content: 'Namaste! Welcome to Converse AI. I am Sonara, your AI solutions specialist. How can I help you today?' });
                break;

            case 'media': {
                if (!data.media?.payload) return;
                frameCount++;
                const frame  = Buffer.from(data.media.payload, 'base64');
                const energy = rmsOf(frame);

                // Periodic noise floor log (every ~5 seconds = 625 frames at ~8ms each)
                if (frameCount % 625 === 0) {
                    console.log(`[VAD] 📊 Frame ${frameCount}, noise RMS=${Math.round(energy)}, speechFrames=${speechFrames}, silenceFrames=${silenceFrames}, speaking=${isAiSpeaking}, processing=${isProcessing}`);
                }

                // ── Barge-in handling ──
                if (isAiSpeaking) {
                    const elapsed = Date.now() - aiStartedAt;
                    if (energy > BARGE_RMS && elapsed > BARGE_COOLDOWN_MS) {
                        speechFrames++;
                        if (speechFrames >= 14) {
                            console.log(`[Barge-In] ⚡ Sustained interruption! RMS=${Math.round(energy)}, elapsed=${elapsed}ms`);
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
                    if (speechFrames === 0) console.log(`[VAD] 🎙️  Speech onset! RMS=${Math.round(energy)}`);
                    speechFrames++;
                    silenceFrames = 0;
                    speechBuf.push(frame);
                } else if (speechBuf.length > 0) {
                    silenceFrames++;
                    speechBuf.push(frame);

                    // Utterance complete: enough speech + enough silence
                    if (silenceFrames >= SILENCE_FRAMES && speechFrames >= MIN_SPEECH_FRAMES) {
                        console.log(`[VAD] ✅ Utterance complete — speech=${speechFrames}fr, silence=${silenceFrames}fr, bytes=${speechBuf.reduce((a, b) => a + b.length, 0)}`);
                        const frames  = [...speechBuf];
                        speechBuf     = [];
                        speechFrames  = 0;
                        silenceFrames = 0;
                        processUtterance(frames); // async pipeline
                    }
                }
                break;
            }

            case 'stop':
                console.log(`[Exotel] 📵 Call ended. Total frames: ${frameCount}, Turns: ${Math.floor(history.length / 2)}`);
                ws.close();
                break;

            default:
                if (data.event) console.log(`[Exotel] Unknown event: ${data.event}`);
        }
    });

    ws.on('close', () => {
        console.log('[WS] Connection closed\n' + '═'.repeat(60));
        isAiSpeaking = false;
        isProcessing = false;
        speechBuf = [];
    });

    ws.on('error', (e) => console.error('[WS] Error:', e.message));
});

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
    console.log('═'.repeat(60));
    console.log('🚀  SONARA TELEPHONY BRIDGE — PRODUCTION v2');
    console.log(`📡  Port      : ${PORT}`);
    console.log(`🔑  Groq      : ${GROQ_KEY ? '✅' : '❌ MISSING'}`);
    console.log(`🔑  ElevenLabs: ${EL_KEY   ? '✅' : '❌ MISSING'}`);
    console.log('═'.repeat(60));
});
