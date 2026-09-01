/**
 * Sonara Voice Agent — Standalone Telephony WebSocket Bridge (Exotel / Twilio)
 * Real-time bidirectional voice streaming:
 * Exotel Audio (Mulaw 8kHz) <-> Groq Whisper (STT) <-> LLaMA 3.3-70B (LLM) <-> ElevenLabs (TTS)
 */
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import 'dotenv/config';

const PORT = process.env.PORT || 8080;
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'cgSgspJ2msm6clMCkdW9'; // Jessica

// ---------------------------------------------------------------------------
// 1. Mu-law (G.711) Decoding & Encoding Tables
// ---------------------------------------------------------------------------
const ULAW_TO_PCM = new Int16Array(256);
for (let i = 0; i < 256; i++) {
    let input = ~i;
    let sign = (input & 0x80) ? -1 : 1;
    let exponent = (input >> 4) & 0x07;
    let mantissa = input & 0x0F;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample -= 0x84;
    ULAW_TO_PCM[i] = sign * sample;
}

// Convert 8kHz Mu-law Buffer to 16kHz 16-bit Linear PCM (for Whisper STT)
function mulawToPcm16k(mulawBuffer) {
    const pcmSamples = new Int16Array(mulawBuffer.length * 2); // 8kHz -> 16kHz (2x linear interpolation)
    for (let i = 0; i < mulawBuffer.length; i++) {
        const s1 = ULAW_TO_PCM[mulawBuffer[i]];
        const s2 = (i < mulawBuffer.length - 1) ? ULAW_TO_PCM[mulawBuffer[i + 1]] : s1;
        pcmSamples[i * 2] = s1;
        pcmSamples[i * 2 + 1] = Math.round((s1 + s2) / 2);
    }
    return Buffer.from(pcmSamples.buffer);
}

// Calculate RMS energy of mulaw chunk to detect voice vs silence
function calculateRms(mulawBuffer) {
    let sum = 0;
    for (let i = 0; i < mulawBuffer.length; i++) {
        const s = ULAW_TO_PCM[mulawBuffer[i]];
        sum += s * s;
    }
    return Math.sqrt(sum / mulawBuffer.length);
}

// Create a WAV file buffer from 16kHz 16-bit Mono PCM
function createWavBuffer(pcmBuffer) {
    const header = Buffer.alloc(44);
    const byteRate = 16000 * 2;
    const dataSize = pcmBuffer.length;

    header.write('RIFF', 0);
    header.writeUInt32LE(dataSize + 36, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);          // SubChunk1Size (16 for PCM)
    header.writeUInt16LE(1, 20);           // AudioFormat (1 for PCM)
    header.writeUInt16LE(1, 22);           // NumChannels (1 mono)
    header.writeUInt32LE(16000, 24);       // SampleRate
    header.writeUInt32LE(byteRate, 28);    // ByteRate
    header.writeUInt16LE(2, 32);           // BlockAlign
    header.writeUInt16LE(16, 34);          // BitsPerSample
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, pcmBuffer]);
}

// ---------------------------------------------------------------------------
// 2. Master System Prompt & RAG Knowledge Base
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are Sonara, the friendly, natural, and knowledgeable AI Customer Support & Solutions Specialist for Converse AI by Revti Digital, India.
Speak naturally like a professional human customer specialist having a real phone conversation.

PERSONALITY & TONE:
- Be warm, confident, conversational, and professional.
- Speak in simple, spoken conversational English (or natural Hinglish if the user speaks Hindi).
- Keep all responses to 1 to 3 short spoken sentences. Never dump long paragraphs.
- Never use bullet points, markdown, asterisks, or formatting — output plain spoken sentences only.

CORE KNOWLEDGE:
- Company: Converse AI (theconverseai.com), operated by Revti Digital, India. Contact: contact@theconverseai.com, +91-9982323333.
- Services: Agentic AI Systems, Inbound & Outbound Voice Agents, WhatsApp AI Automation (98% open rates), Enterprise RAG Knowledge Bases, Custom CRM/ERP AI Integrations.
- Case Studies:
  1) StyleMart India (Retail): 3x revenue in repeat purchases, 65% support cost reduction.
  2) LearnSphere (EdTech): Doubled course enrolments in 90 days, cut response time by 80%.
  3) CareFirst Clinics (Healthcare): Reduced appointment no-shows by 55%, saved 120 admin hours monthly.
- Pricing: No rigid fixed tiers. Tailored to business scale. Every engagement starts with a 100% Free AI Opportunity & Readiness Audit.
- Next Steps: Offer to book a Free AI Opportunity Audit or connect with our human specialist.`;

// ---------------------------------------------------------------------------
// 3. AI Service Integrations: Whisper STT, LLaMA 3.3 LLM, ElevenLabs TTS
// ---------------------------------------------------------------------------

// Whisper STT via Groq
async function transcribeAudio(wavBuffer) {
    if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY not configured');

    const formData = new FormData();
    formData.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'speech.wav');
    formData.append('model', 'whisper-large-v3-turbo');
    formData.append('temperature', '0.0');
    formData.append('response_format', 'json');

    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` },
        body: formData,
        signal: AbortSignal.timeout(6000)
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Groq Whisper failed (${res.status}): ${errText}`);
    }

    const data = await res.json();
    return (data.text || '').trim();
}

// LLM via Groq LLaMA 3.3-70B
async function generateAiResponse(history, userPrompt) {
    if (!GROQ_API_KEY) return 'Thank you for calling Converse AI. How can I help you today?';

    const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...history.slice(-6),
        { role: 'user', content: userPrompt }
    ];

    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${GROQ_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages,
            temperature: 0.6,
            max_tokens: 180
        }),
        signal: AbortSignal.timeout(6000)
    });

    if (!res.ok) {
        throw new Error(`Groq LLM failed: ${res.status}`);
    }

    const data = await res.json();
    return (data.choices?.[0]?.message?.content || '').trim().replace(/[*_#`]/g, '');
}

// ElevenLabs TTS streaming mulaw 8000Hz directly for Telephony
async function* streamTtsAudio(text) {
    if (!ELEVENLABS_API_KEY) {
        console.warn('[TTS] ELEVENLABS_API_KEY not configured, skipping speech output');
        return;
    }

    const endpoint = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?output_format=ulaw_8000&optimize_streaming_latency=3`;

    const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'xi-api-key': ELEVENLABS_API_KEY,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            text,
            model_id: 'eleven_turbo_v2_5',
            voice_settings: {
                stability: 0.5,
                similarity_boost: 0.8,
                style: 0.15,
                use_speaker_boost: true
            }
        })
    });

    if (!res.ok) {
        console.error('[TTS] ElevenLabs failed:', res.status, await res.text());
        return;
    }

    const reader = res.body.getReader();
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length > 0) {
            yield Buffer.from(value);
        }
    }
}

// ---------------------------------------------------------------------------
// 4. HTTP & WebSocket Server Setup
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
    // Health check endpoint
    if (req.url === '/' || req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'online',
            service: 'Sonara Exotel Telephony Bridge',
            timestamp: new Date().toISOString()
        }));
        return;
    }

    // Dynamic endpoint for Exotel Voicebot resolver
    if (req.url === '/media' || req.url === '/exotel-voicebot') {
        const host = req.headers.host || `localhost:${PORT}`;
        const wsProtocol = req.headers['x-forwarded-proto'] === 'https' ? 'wss' : 'ws';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            stream_url: `${wsProtocol}://${host}/media`
        }));
        return;
    }

    res.writeHead(404);
    res.end();
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

// ---------------------------------------------------------------------------
// 5. Active Call Session Handler
// ---------------------------------------------------------------------------
wss.on('connection', (ws, req) => {
    console.log(`[Telephony] New WebSocket connection from: ${req.socket.remoteAddress}`);

    let streamSid = null;
    let callSid = null;
    let isAiSpeaking = false;
    let isProcessing = false;
    let audioBuffer = [];
    let silenceFrames = 0;
    let speechFrames = 0;
    let history = [];

    const RMS_THRESHOLD = 300;     // Energy threshold for speech onset in 8kHz mulaw
    const SILENCE_TIMEOUT = 14;     // ~450ms silence at 32ms frames declares end of utterance

    // Helper: Send audio chunk to Exotel phone call
    const sendAudioChunk = (chunkBuffer) => {
        if (!streamSid || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({
            event: 'media',
            streamSid,
            media: { payload: chunkBuffer.toString('base64') }
        }));
    };

    // Helper: Clear audio queue on phone (Barge-in / Interruption)
    const clearPhoneQueue = () => {
        if (!streamSid || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ event: 'clear', streamSid }));
    };

    // Helper: Play AI response to caller
    const speakAiResponse = async (responseText) => {
        isAiSpeaking = true;
        console.log(`[Sonara] Speaking: "${responseText}"`);

        try {
            for await (const chunk of streamTtsAudio(responseText)) {
                if (!isAiSpeaking) {
                    console.log('[Sonara] TTS cancelled mid-stream due to barge-in');
                    break;
                }
                // Send in telephony-sized chunks (~320 bytes = 40ms)
                for (let offset = 0; offset < chunk.length; offset += 320) {
                    if (!isAiSpeaking) break;
                    const slice = chunk.subarray(offset, Math.min(offset + 320, chunk.length));
                    sendAudioChunk(slice);
                }
            }
        } catch (err) {
            console.error('[Sonara] TTS playback error:', err);
        } finally {
            isAiSpeaking = false;
            audioBuffer = [];
            silenceFrames = 0;
            speechFrames = 0;
        }
    };

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message.toString());

            switch (data.event) {
                case 'connected':
                    console.log('[Exotel] Handshake connected');
                    break;

                case 'start':
                    streamSid = data.streamSid || data.start?.streamSid;
                    callSid = data.start?.callSid;
                    console.log(`[Exotel] Call Started — StreamSid: ${streamSid}, CallSid: ${callSid}`);

                    // Initial proactive greeting from Sonara
                    setTimeout(() => {
                        const greeting = "Namaste! Welcome to Converse AI. I am Sonara, your AI solutions specialist. How can I help you today?";
                        history.push({ role: 'assistant', content: greeting });
                        speakAiResponse(greeting);
                    }, 500);
                    break;

                case 'media':
                    if (!data.media?.payload) return;
                    const mulawChunk = Buffer.from(data.media.payload, 'base64');
                    const rms = calculateRms(mulawChunk);

                    // BARGE-IN: If caller speaks while Sonara is speaking, interrupt immediately!
                    if (isAiSpeaking && rms > RMS_THRESHOLD * 1.4) {
                        speechFrames++;
                        if (speechFrames >= 3) {
                            console.log('? [Barge-In] Caller interrupted Sonara. Clearing audio!');
                            isAiSpeaking = false;
                            clearPhoneQueue();
                            audioBuffer = [];
                            speechFrames = 0;
                            silenceFrames = 0;
                        }
                        return;
                    }

                    if (isAiSpeaking || isProcessing) return;

                    // Voice Activity Detection (VAD)
                    if (rms > RMS_THRESHOLD) {
                        speechFrames++;
                        silenceFrames = 0;
                        audioBuffer.push(mulawChunk);
                    } else if (audioBuffer.length > 0) {
                        silenceFrames++;
                        audioBuffer.push(mulawChunk);

                        // If caller was speaking and has now paused for ~450ms
                        if (silenceFrames >= SILENCE_TIMEOUT && speechFrames >= 4) {
                            isProcessing = true;
                            const fullMulaw = Buffer.concat(audioBuffer);
                            audioBuffer = [];
                            silenceFrames = 0;
                            speechFrames = 0;

                            (async () => {
                                try {
                                    console.log(`[Telephony] Processing caller utterance (${fullMulaw.length} bytes)...`);
                                    const pcm16k = mulawToPcm16k(fullMulaw);
                                    const wavBuffer = createWavBuffer(pcm16k);

                                    // 1. Transcribe with Whisper
                                    const userSpeech = await transcribeAudio(wavBuffer);
                                    console.log(`[Caller Said]: "${userSpeech}"`);

                                    if (!userSpeech || userSpeech.length < 2) {
                                        isProcessing = false;
                                        return;
                                    }

                                    // 2. Generate Sonara AI Response
                                    history.push({ role: 'user', content: userSpeech });
                                    const aiText = await generateAiResponse(history, userSpeech);
                                    history.push({ role: 'assistant', content: aiText });

                                    // 3. Speak response over phone
                                    await speakAiResponse(aiText);

                                } catch (pipelineErr) {
                                    console.error('[Pipeline Error]:', pipelineErr);
                                    const fallback = "I didn't quite catch that. Could you please repeat?";
                                    speakAiResponse(fallback);
                                } finally {
                                    isProcessing = false;
                                }
                            })();
                        }
                    }
                    break;

                case 'stop':
                    console.log(`[Exotel] Call Ended — StreamSid: ${streamSid}`);
                    ws.close();
                    break;
            }
        } catch (e) {
            console.error('[WebSocket Error]:', e.message);
        }
    });

    ws.on('close', () => {
        console.log(`[Telephony] Connection closed for stream: ${streamSid}`);
        isAiSpeaking = false;
        audioBuffer = [];
    });

    ws.on('error', (err) => {
        console.error('[WebSocket Client Error]:', err.message);
    });
});

// Start HTTP + WebSocket Server
server.listen(PORT, () => {
    console.log(`========================================================`);
    console.log(`?? SONARA TELEPHONY WEBSOCKET BRIDGE ONLINE`);
    console.log(`?? Listening on Port: ${PORT}`);
    console.log(`?? Health Check: http://localhost:${PORT}/health`);
    console.log(`??? WebSocket URL: ws://localhost:${PORT}/media`);
    console.log(`========================================================`);
});
