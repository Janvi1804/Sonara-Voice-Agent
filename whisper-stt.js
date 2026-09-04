/**
 * Whisper Large V3 Turbo STT Engine (Groq Cloud)
 * Sub-150ms ultra-low latency transcription for multilingual Hindi, English and Hinglish.
 * STRICT GROQ WHISPER PIPELINE — NO Web Speech API / Alternate Provider Fallback.
 */

export class WhisperSTT {
    constructor(options = {}) {
        this.apiKey = options.apiKey || '';
        this.language = options.language || 'hi';
        this.model = 'whisper-large-v3-turbo';
        this.onTranscript = options.onTranscript || (() => {});
        this.onError = options.onError || (() => {});
        this.sampleRate = 16000;
        this.audioChunks = [];
        this.preSpeechRingBuffer = [];
        this.preSpeechMaxChunks = 12; // ~380ms pre-speech buffer
        this.isRecording = false;
        this.isTranscribing = false;

        this.rmsFloor = options.rmsFloor !== undefined ? options.rmsFloor : 0.004;
        this.minDurationMs = options.minDurationMs !== undefined ? options.minDurationMs : 150;
    }

    setApiKey(key) { this.apiKey = key; }
    setLanguage(lang) { this.language = (lang === 'hi' || lang === 'en') ? lang : 'hi'; }
    setRmsFloor(val) { this.rmsFloor = Math.max(0.001, Math.min(0.05, Number(val) || 0.004)); }

    clearBuffer() {
        this.audioChunks = [];
        this.preSpeechRingBuffer = [];
        this.isRecording = false;
    }

    startRecording() {
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

        if (totalLength < this.sampleRate * (this.minDurationMs / 1000)) {
            console.log('[GroqWhisper] Skipped: audio too short', Math.round(durationMs) + 'ms <', this.minDurationMs + 'ms');
            this.audioChunks = [];
            return '';
        }

        if (rms < this.rmsFloor) {
            console.log('[GroqWhisper] Skipped: audio too quiet (below rmsFloor)', { rms: rms.toFixed(4), rmsFloor: this.rmsFloor });
            this.audioChunks = [];
            return '';
        }

        const merged = new Float32Array(totalLength);
        let offset = 0;
        for (let i = 0; i < this.audioChunks.length; i++) {
            merged.set(this.audioChunks[i], offset);
            offset += this.audioChunks[i].length;
        }
        this.audioChunks = [];

        const wavBlob = this.encodeWAV(merged);
        const result = await this.sendToGroqWhisper(wavBlob, { durationMs, rms });

        if (!result || !result.text) return '';

        const text = result.text.trim();
        this.onTranscript(text);
        return text;
    }

    encodeWAV(samples) {
        const buffer = new ArrayBuffer(44 + samples.length * 2);
        const view = new DataView(buffer);
        const writeString = (offset, string) => {
            for (let i = 0; i < string.length; i++) {
                view.setUint8(offset + i, string.charCodeAt(i));
            }
        };

        writeString(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true);
        writeString(8, 'WAVE'); writeString(12, 'fmt ');
        view.setUint32(16, 16, true); view.setUint16(20, 1, true);
        view.setUint16(22, 1, true); view.setUint32(24, this.sampleRate, true);
        view.setUint32(28, this.sampleRate * 2, true); view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
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

    /**
     * Send recorded audio strictly to Groq Whisper endpoint
     */
    async sendToGroqWhisper(wavBlob, meta = {}) {
        this.isTranscribing = true;
        try {
            const whisperForm = new FormData();
            whisperForm.append('file', wavBlob, 'user_speech.wav');
            whisperForm.append('model', 'whisper-large-v3-turbo');
            whisperForm.append('response_format', 'verbose_json');
            whisperForm.append('temperature', '0.0');
            if (this.language) whisperForm.append('language', this.language);
            whisperForm.append('prompt', 'Converse AI, Sonara, Namaste, hello, pricing, services, demo, booking, WhatsApp, Hindi, Hinglish, case studies.');

            const keyToUse = this.apiKey ? this.apiKey.trim() : '';
            const headers = keyToUse ? { 'Authorization': 'Bearer ' + keyToUse } : {};

            const res = await fetch('/api/transcribe', {
                method: 'POST',
                headers,
                body: whisperForm
            });

            if (!res.ok) {
                const errJson = await res.json().catch(() => ({}));
                const errMsg = errJson.error?.message || errJson.error || `Groq Whisper error (${res.status})`;
                throw new Error(errMsg);
            }

            const data = await res.json();
            let text = (data.text || '').trim();

            // Extract segment-level metadata (verbose_json)
            const seg = (data.segments && data.segments.length > 0) ? data.segments[0] : null;
            const noSpeechProb = seg ? (seg.no_speech_prob || 0) : 0;
            const avgLogProb   = seg ? (seg.avg_logprob   || 0) : 0;

            // Strip transliteration artifacts
            text = text.replace(/<\|.*?\|>/g, '');
            text = text.replace(/\bConverse\s+eye\b/gi, 'Converse AI');
            text = text.replace(/\btheconverseeye\b/gi, 'theconverseai');
            text = text.replace(/\bconverse\s*ai\b/gi, 'Converse AI').trim();

            console.log('[GroqWhisper] 🎙️ Transcribed:', text);
            this.isTranscribing = false;
            return { text, noSpeechProb, avgLogProb };

        } catch (err) {
            this.isTranscribing = false;
            console.error('[GroqWhisper] Transcription failed:', err.message);
            this.onError(err);
            return null;
        }
    }
}
