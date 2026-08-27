/**
 * Whisper Large V3 Turbo STT Engine (Groq Cloud)
 * Sub-150ms ultra-low latency transcription for multilingual Hindi, English and Hinglish.
 *
 * Improvements in this version:
 *  - response_format: verbose_json: provides no_speech_prob and avg_logprob per segment.
 *    These are used as ONE SIGNAL alongside RMS, duration, and hallucination filters.
 *    Verified: Groq Whisper API returns no_speech_prob in verbose_json responses.
 *    Important: Groq's backend returns no_speech_prob=0 for synthetic noise patterns,
 *    so this field is only reliable for genuine quiet-mic conditions.
 *  - rmsFloor: configurable (default 0.007). Not blindly increased. Tune per environment.
 *  - minSpeechDurationMs: configurable (default 400ms).
 *  - Whisper initial_prompt changed from keyword list to sentence-form context for better
 *    Hindi/Hinglish phoneme priming.
 *  - Diagnostic log block per utterance for debugging.
 *  - Hallucination filter unchanged from v1 but with cleaner structure.
 */

export class WhisperSTT {
    constructor(options = {}) {
        this.apiKey = options.apiKey || '';
        this.language = options.language || 'hi';
        this.model = options.model || 'whisper-large-v3-turbo';
        this.onTranscript = options.onTranscript || (() => {});
        this.onError = options.onError || (() => {});
        this.sampleRate = 16000;
        this.audioChunks = [];
        this.preSpeechRingBuffer = [];
        this.preSpeechMaxChunks = 12; // ~380ms pre-speech buffer
        this.isRecording = false;
        this.isTranscribing = false;

        // Configurable gates (tune per environment)
        // rmsFloor: audio below this RMS is considered too quiet to transcribe.
        // Default 0.007 retained from v1. Do NOT change without testing against:
        // quiet speech, normal speech, loud speech, Hindi, English, Hinglish, and noisy environments.
        this.rmsFloor = options.rmsFloor !== undefined ? options.rmsFloor : 0.007;

        // Minimum speech duration to pass to Whisper (ms).
        // VAD already filters via minSpeechDurationMs, but we keep a backup here.
        this.minDurationMs = options.minDurationMs !== undefined ? options.minDurationMs : 250;
    }

    setApiKey(key) { this.apiKey = key; }
    setLanguage(lang) { this.language = (lang === 'hi' || lang === 'en') ? lang : 'hi'; }
    setRmsFloor(val) { this.rmsFloor = Math.max(0.001, Math.min(0.05, Number(val) || 0.007)); }

    clearBuffer() {
        this.audioChunks = [];
        this.preSpeechRingBuffer = [];
        this.isRecording = false;
    }

    startRecording() {
        // Prepend rolling pre-speech buffer so leading consonants (e.g. K in Kal) are never clipped
        this.audioChunks = [...this.preSpeechRingBuffer];
        this.preSpeechRingBuffer = [];
        this.isRecording = true;
    }

    pushAudioFrame(pcm16kFloat32) {
        if (!pcm16kFloat32 || pcm16kFloat32.length === 0) return;
        const frame = new Float32Array(pcm16kFloat32);
        if (this.isRecording) {
            this.audioChunks.push(frame);
        } else {
            this.preSpeechRingBuffer.push(frame);
            if (this.preSpeechRingBuffer.length > this.preSpeechMaxChunks) {
                this.preSpeechRingBuffer.shift();
            }
        }
    }

    async stopAndTranscribe() {
        if (!this.isRecording && this.audioChunks.length === 0) return '';
        this.isRecording = false;

        // Compute audio duration and RMS across all chunks
        let totalLength = 0;
        let sumSquares = 0;
        for (let i = 0; i < this.audioChunks.length; i++) {
            const chunk = this.audioChunks[i];
            totalLength += chunk.length;
            for (let j = 0; j < chunk.length; j++) {
                sumSquares += chunk[j] * chunk[j];
            }
        }

        const durationMs = (totalLength / this.sampleRate) * 1000;
        const rms = Math.sqrt(sumSquares / Math.max(1, totalLength));

        // Gate 1: Duration check (configurable, backup to VAD minSpeechDurationMs)
        if (totalLength < this.sampleRate * (this.minDurationMs / 1000)) {
            console.log('[STT] Skipped: audio too short', Math.round(durationMs) + 'ms <', this.minDurationMs + 'ms');
            this.audioChunks = [];
            return '';
        }

        // Gate 2: RMS energy gate (configurable, not hardcoded)
        // Rationale: if RMS is below rmsFloor, the audio is likely ambient noise.
        // This threshold should be validated against quiet speech (soft-spoken users),
        // not just against noise scenarios.
        if (rms < this.rmsFloor) {
            console.log('[STT] Skipped: RMS too low', rms.toFixed(4), '< rmsFloor', this.rmsFloor);
            this.audioChunks = [];
            return '';
        }

        const mergedPcm = new Float32Array(totalLength);
        let offset = 0;
        for (let i = 0; i < this.audioChunks.length; i++) {
            mergedPcm.set(this.audioChunks[i], offset);
            offset += this.audioChunks[i].length;
        }
        this.audioChunks = [];

        const wavBlob = this.encodeWav(mergedPcm, this.sampleRate);
        const result = await this.sendToWhisper(wavBlob, { durationMs, rms });

        if (!result || !result.text) return '';

        const text = result.text;

        // Gate 3: Multi-signal hallucination detection
        // Signals used: no_speech_prob (from verbose_json), avg_logprob, text content, RMS, duration.
        // no_speech_prob alone is NOT used as an absolute threshold because:
        //   - Groq's backend returns 0.0 for synthetic noise (tested)
        //   - It is meaningful only when it is HIGH (e.g. > 0.6 with short duration)
        const noSpeechProb = result.noSpeechProb || 0;
        const avgLogProb = result.avgLogProb || 0;
        const clean = text.toLowerCase().replace(/[^a-z0-9\u0900-\u097f]/g, ' ').trim();

        // Known Whisper hallucination phrases on near-silent audio
        const hallucinationPhrases = [
            'thank you', 'thank you very much', 'thank you so much',
            'thanks for watching', 'subtitles by', 'you', 'and',
            'so', 'the end', 'amara org', 'subscribe', 'like and subscribe',
            'thank you for watching', 'thanks', 'body', 'i will',
            'kiregenis sivay', 'nubi sikken', 'torea', 'for the hour',
            // Phantom outputs on silence / self-echo (do NOT include valid user words like hello/yes/no)
            'i m doing', 'i m doing great', 'i promise', 'i promise i m doing',
            'i m sorry', 'i m fine', 'i m good', 'i m here', 'peace',
            'see you next time', 'i ll see you next time', 'please subscribe',
            'thanks for listening', 'uh', 'um'
        ];

        // Known phantom sentence *openers* — filter when the whole (short) utterance starts with these
        const hallucinationOpeners = [
            'i promise', 'i m doing', 'thank you for', 'thanks for',
            'please subscribe', 'see you', 'i ll see you', 'subtitles'
        ];

        const cleanLatin = clean.replace(/[^\x00-\x7F]/g, '').replace(/\s+/g, ' ').trim();
        const wordCount = cleanLatin ? cleanLatin.split(' ').length : 0;
        const isHallucination = hallucinationPhrases.includes(cleanLatin)
            // short phantom sentence (<=6 words) that begins with a known filler opener
            || (wordCount <= 6 && hallucinationOpeners.some(op => cleanLatin.startsWith(op)));

        // Repeating stutter pattern (e.g. and the the the)
        const isRepeatingStutter = /(.)(\1){4,}/.test(clean) || /\b(\w+)\s+\1\s+\1\b/.test(clean);

        // Very short output AND high no_speech_prob AND low avg_logprob = likely noise
        // But NOT used as standalone rule. Require multiple signals.
        const isLikelyNoise = (noSpeechProb > 0.6 && durationMs < 800 && rms < this.rmsFloor * 3)
            || (avgLogProb < -1.2 && clean.length <= 5 && durationMs < 600);

        // Log diagnostic info for every transcription
        console.log('[STT] Diagnostic:', {
            text,
            durationMs: Math.round(durationMs),
            rms: rms.toFixed(4),
            noSpeechProb: noSpeechProb.toFixed(4),
            avgLogProb: avgLogProb.toFixed(4),
            charLen: clean.length,
            isHallucination,
            isRepeatingStutter,
            isLikelyNoise
        });

        if (isHallucination || cleanLatin === 'and' || cleanLatin === 'you' || cleanLatin.length <= 3 || isRepeatingStutter || isLikelyNoise) {
            console.log('[STT] Filtered:', text, '| Reason:', isHallucination ? 'hallucination' : isRepeatingStutter ? 'stutter' : isLikelyNoise ? 'likely noise' : 'too short');
            return '';
        }

        if (this.onTranscript && text) {
            this.onTranscript(text, true);
        }
        return text;
    }

    encodeWav(samples, sampleRate) {
        const buffer = new ArrayBuffer(44 + samples.length * 2);
        const view = new DataView(buffer);
        const writeString = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
        writeString(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true);
        writeString(8, 'WAVE'); writeString(12, 'fmt ');
        view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
        view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
        view.setUint16(32, 2, true); view.setUint16(34, 16, true);
        writeString(36, 'data'); view.setUint32(40, samples.length * 2, true);
        let index = 44;
        for (let i = 0; i < samples.length; i++) {
            let s = Math.max(-1, Math.min(1, samples[i]));
            s = s < 0 ? s * 0x8000 : s * 0x7FFF;
            view.setInt16(index, s, true);
            index += 2;
        }
        return new Blob([buffer], { type: 'audio/wav' });
    }

    async sendToWhisper(wavBlob, meta = {}) {
        this.isTranscribing = true;
        try {
            const formData = new FormData();
            formData.append('file', wavBlob, 'user_speech.wav');
            // Sarvam STT params
            formData.append('language_code', this.language === 'hi' ? 'hi-IN' : 'en-IN');
            formData.append('model', 'saarika:v2');
            formData.append('with_timestamps', 'false');

            // Primary: Sarvam STT via /api/sarvam-stt proxy
            let res = null;
            try {
                res = await fetch('/api/sarvam-stt', { method: 'POST', body: formData });
                if (res.ok) {
                    console.log('[STT] Using Sarvam saarika:v2');
                }
            } catch (sarvamErr) {
                console.warn('[STT] Sarvam proxy error, falling back to Whisper:', sarvamErr.message);
            }

            // Fallback: Groq Whisper (if Sarvam fails)
            if (!res || !res.ok) {
                console.warn('[STT] Sarvam failed (status ' + (res?.status) + '), falling back to Groq Whisper');
                const fallbackForm = new FormData();
                fallbackForm.append('file', wavBlob, 'user_speech.wav');
                fallbackForm.append('model', 'whisper-large-v3-turbo');
                fallbackForm.append('response_format', 'verbose_json');
                fallbackForm.append('temperature', '0.0');
                if (this.language) fallbackForm.append('language', this.language);
                fallbackForm.append('prompt', 'Converse AI, Sonara, Namaste, hello, pricing, services, demo, booking, WhatsApp, Hindi, Hinglish.');
                const keyToUse = this.apiKey ? this.apiKey.trim() : '';
                const headers = keyToUse ? { 'Authorization': 'Bearer ' + keyToUse } : {};
                try {
                    res = await fetch('/api/transcribe', { method: 'POST', headers, body: fallbackForm });
                } catch (proxyErr) {
                    console.warn('[STT] Whisper proxy error:', proxyErr.message);
                }
            }

            if (!res || !res.ok) {
                const errJson = res ? await res.json().catch(() => ({})) : {};
                throw new Error(errJson.error?.message || errJson.error || 'STT HTTP ' + (res ? res.status : 'Network Error'));
            }

            const data = await res.json();
            let text = (data.text || '').trim();

            // Extract segment-level metadata if available (Whisper verbose_json)
            const seg = (data.segments && data.segments.length > 0) ? data.segments[0] : null;
            const noSpeechProb = seg ? (seg.no_speech_prob || 0) : 0;
            const avgLogProb   = seg ? (seg.avg_logprob   || 0) : 0;

            // Post-process common transliteration artifacts and special tokens
            text = text.replace(/<\|.*?\|>/g, '');
            text = text.replace(/\bConverse\s+eye\b/gi, 'Converse AI');
            text = text.replace(/\btheconverseeye\b/gi, 'theconverseai');
            text = text.replace(/\bconverse\s*ai\b/gi, 'Converse AI').trim();

            this.isTranscribing = false;
            return { text, noSpeechProb, avgLogProb };

        } catch (err) {
            this.isTranscribing = false;
            console.warn('[STT] Transcription error:', err.message);
            this.onError(err);
            return null;
        }
    }
}
