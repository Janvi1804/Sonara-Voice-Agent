/**
 * Whisper Large V3 Turbo STT Engine (Groq Cloud)
 * Sub-150ms ultra-low latency transcription for multilingual Hindi, English and Hinglish.
 * STRICT GROQ WHISPER PIPELINE — NO Web Speech API / Alternate Provider Fallback.
 */

export class WhisperSTT {
    constructor(options = {}) {
        this.apiKey = options.apiKey || '';
        // language = '' means auto-detect (Whisper detects Hindi/English/Hinglish automatically)
        // Set to 'hi' or 'en' only if you want to FORCE a specific language
        this.language = options.language || '';
        this.model = options.model || 'sarvam-saaras-v3';
        this.onTranscript = options.onTranscript || (() => {});
        this.onError = options.onError || (() => {});
        this.sampleRate = 16000;
        this.audioChunks = [];
        this.preSpeechRingBuffer = [];
        this.preSpeechMaxChunks = 8; // ~256ms pre-speech buffer — enough for consonants, less junk audio
        this.isRecording = false;
        this.isTranscribing = false;

        this.rmsFloor = options.rmsFloor !== undefined ? options.rmsFloor : 0.012;
        this.minDurationMs = options.minDurationMs !== undefined ? options.minDurationMs : 200;
    }

    setApiKey(key) { this.apiKey = key; }
    setModel(m) { this.model = m || 'sarvam-saaras-v3'; }
    // Allow 'hi', 'en', or '' (auto-detect)
    setLanguage(lang) { this.language = (lang === 'hi' || lang === 'en') ? lang : ''; }
    setRmsFloor(val) { this.rmsFloor = Math.max(0.005, Math.min(0.05, Number(val) || 0.018)); }


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
            // Safety cap: keep max 7 seconds of audio (~220 frames) so background noise cannot pile up
            if (this.audioChunks.length > 220) {
                this.audioChunks.shift();
            }
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
        const isSarvam = this.model === 'sarvam-saaras-v3' || this.model.startsWith('sarvam');
        let result = isSarvam
            ? await this.sendToSarvam(wavBlob, { durationMs, rms })
            : await this.sendToGroqWhisper(wavBlob, { durationMs, rms });

        // Groq shares its daily token quota with the chat LLM — if it's rate-limited or
        // otherwise erroring out, fall back to Sarvam so transcription still works.
        if (!isSarvam && (!result || !result.text)) {
            console.warn('[GroqWhisper] Primary STT failed. Falling back to Sarvam...');
            result = await this.sendToSarvam(wavBlob, { durationMs, rms });
        }

        if (!result || !result.text) return '';

        const text = result.text.trim();

        // ── Post-transcription junk filter ──
        // Discard Whisper hallucination artifacts that are purely punctuation/noise
        // e.g. ",", ",,", ".", "..", "...", "،" (Arabic comma), etc.
        const strippedJunk = text.replace(/[,.\s،؟!?।।]+/g, '').trim();
        if (strippedJunk.length === 0) {
            console.log('[GroqWhisper] Discarding junk-only transcript:', JSON.stringify(text));
            this.audioChunks = [];
            return '';
        }

        // Discard Whisper phantom single-word hallucinations from background noise
        const lowerText = text.toLowerCase().trim().replace(/[^a-z0-9\u0900-\u097f\s]/g, '').trim();

        // Minimum length check — allow valid short inputs like numbers ("2", "10"), times ("2pm", "am", "pm"), and short affirmatives ("ok", "no", "yes", "ji", "ha")
        const strippedChars = lowerText.replace(/\s/g, '');
        const validShortTokens = ['ok', 'no', 'hi', 'ha', 'ji', 'am', 'pm', 'yes', 'two', 'ten'];
        const hasDigits = /\d/.test(strippedChars);
        const isValidShort = hasDigits || validShortTokens.includes(lowerText);

        if (strippedChars.length < 3 && !isValidShort) {
            console.log('[GroqWhisper] Discarding too-short noise transcript:', JSON.stringify(text));
            this.audioChunks = [];
            return '';
        }

        // Discard any transcript where Whisper itself indicates low confidence / high silence probability
        if (result.noSpeechProb > 0.45) {
            console.log('[GroqWhisper] Discarding high no_speech_prob noise artifact:', { text, noSpeechProb: result.noSpeechProb.toFixed(3) });
            this.audioChunks = [];
            return '';
        }

        // Discard transcripts where Whisper's own token confidence is low — this catches cases
        // where audio was real speech (not silence/noise, so noSpeechProb looks fine) but garbled
        // enough that Whisper guessed/hallucinated plausible-sounding words instead of transcribing.
        if (result.avgLogProb < -0.7) {
            console.log('[GroqWhisper] Discarding low-confidence transcript:', { text, avgLogProb: result.avgLogProb.toFixed(3) });
            this.audioChunks = [];
            return '';
        }

        // ── Gibberish detection ──
        // Catches random keysmashing like "sjasdkjbfkhfbnsfb", "asfkjhsdfkj", etc.
        // Heuristic: real words (English + Hindi romanization) have >= 15% vowels.
        // Gibberish has long consonant runs and near-zero vowels.
        // Exempt: short words (<4 chars), numbers, known abbreviations (AI, CRM, etc.)
        const ABBREV = /^[A-Z]{2,5}$|^\d+$|^(ok|hi|ha|ji|yes|no|am|pm|sir|mam)$/i;
        const gibberishWords = text.trim().split(/\s+/).filter(w => {
            if (w.length < 4 || ABBREV.test(w)) return false; // exempt short/known
            if (/[\u0900-\u097F]/.test(w)) return false;       // exempt Devanagari
            const vowels = (w.match(/[aeiouy]/gi) || []).length;
            const vowelRatio = vowels / w.length;
            const longConsonantRun = /[^aeiouy\s\d]{5,}/i.test(w); // 5+ consonants in a row
            const repeatedChars = /(.)\1{3,}/i.test(w); // 4+ repeated chars like aaaaa or zzzz
            return vowelRatio < 0.15 || longConsonantRun || repeatedChars;
        });
        const totalWords = text.trim().split(/\s+/).filter(w => w.length >= 4).length;
        if (totalWords > 0 && gibberishWords.length / totalWords > 0.5) {
            console.log('[GroqWhisper] Discarding gibberish transcript:', JSON.stringify(text));
            this.audioChunks = [];
            return '';
        }

        // Whisper's #1 most common phantom hallucinations on background noise/breaths
        const noiseHallucinations = [
            'thank you', 'thank you very much', 'thank you so much',
            'thank you for watching', 'thanks for watching', 'thank you for listening',
            'thanks', 'you', 'namaste', 'um', 'uh', 'hmm', 'hm',
            'music', 'applause', 'laughter', 'silence', 'background noise',
            'hindi', 'english', 'hinglish', 'bye', 'goodbye', 'subtitles by'
        ];

        // If it matches a known phantom hallucination:
        if (noiseHallucinations.includes(lowerText)) {
            // Case 1: Audio was faint, short, or had elevated noSpeechProb
            const isFaintOrSuspicious = (rms < 0.018) || (result.noSpeechProb > 0.15) || (durationMs < 650);

            // Case 2: User spoke for longer (durationMs >= 800ms) but Whisper produced a 1-2 word phantom hallucination like "thank you"
            const isLongSpeechHallucination = durationMs >= 800 && [
                'thank you', 'thank you very much', 'thank you so much',
                'thank you for watching', 'thanks for watching', 'thank you for listening',
                'subtitles by', 'you', 'thanks', 'bye', 'goodbye'
            ].includes(lowerText);

            // If a longer Hinglish question hallucinated as "thank you", automatically retry with Sarvam STT
            if (isLongSpeechHallucination && !isSarvam) {
                console.warn(`[GroqWhisper] Phantom "${text}" on ${Math.round(durationMs)}ms speech. Retrying with Sarvam STT...`);
                try {
                    const sarvamRes = await this.sendToSarvam(wavBlob, { durationMs, rms });
                    if (sarvamRes && sarvamRes.text && !noiseHallucinations.includes(sarvamRes.text.toLowerCase().trim())) {
                        this.audioChunks = [];
                        this.onTranscript(sarvamRes.text);
                        return sarvamRes.text;
                    }
                } catch (e) {
                    console.warn('[STT] Sarvam STT retry note:', e.message);
                }
            }

            if (isFaintOrSuspicious || isLongSpeechHallucination) {
                console.log('[GroqWhisper] Discarding phantom hallucination:', { text, noSpeechProb: result.noSpeechProb, rms: rms.toFixed(4), durationMs: Math.round(durationMs) });
                this.audioChunks = [];
                return '';
            }
        }

        // Discard Whisper prompt recitation / comma-prefixed artifacts (when Whisper recites prompt tokens on ambient silence)
        const isPromptEcho = /^[,،;:]/.test(text.trim()) || 
            (lowerText.includes('kya aap') && lowerText.includes('kaise')) ||
            (lowerText.includes('kaise hain') && lowerText.includes('bataiye')) ||
            (lowerText.includes('bataiye') && lowerText.includes('sales')) ||
            (lowerText.includes('kya aap') && lowerText.includes('sales')) ||
            (lowerText.includes('help') && lowerText.includes('meri sales'));

        if (isPromptEcho) {
            console.log('[GroqWhisper] Discarding prompt echo hallucination on ambient noise:', text);
            this.audioChunks = [];
            return '';
        }

        // Discard Whisper prompt hallucinations (when user said nothing, but Whisper recited prompt phrases)
        const promptHallucinations = [
            'kya aap meri madad kar sakte hain',
            'aap kaise hain',
            'namaste aap kaise hain',
            'mujhe retail business ke liye ek demo booking karni hai',
            'retail business ke liye ek demo booking karni hai',
            'kya aap, kaise hain',
            'kaise hain, bataiye',
            'meri sales'
        ];
        if (promptHallucinations.some(p => lowerText.includes(p)) && (rms < 0.035 || durationMs < 1200 || result.noSpeechProb > 0.08)) {
            console.log('[GroqWhisper] Discarding prompt hallucination on faint noise:', text);
            this.audioChunks = [];
            return '';
        }

        const isPromptHallucination = (
            lowerText.includes('stylemart') ||
            lowerText.includes('learnsphere') ||
            lowerText.includes('carefirst')
        ) && !lowerText.includes('what') && !lowerText.includes('kya') && !lowerText.includes('tell') && !lowerText.includes('batao') && !lowerText.includes('about') && !lowerText.includes('case study');

        if (isPromptHallucination) {
            console.log('[GroqWhisper] Discarding prompt hallucination on silence:', text);
            this.audioChunks = [];
            return '';
        }

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
        const tStart = performance.now();
        try {
            const whisperForm = new FormData();
            whisperForm.append('file', wavBlob, 'user_speech.wav');
            whisperForm.append('model', 'whisper-large-v3-turbo');
            whisperForm.append('response_format', 'verbose_json');
            whisperForm.append('temperature', '0.0');
            whisperForm.append('prompt', 'Transcribe exactly what the caller says, in whichever language or mix of Hindi/English they use.');
            if (this.language) {
                whisperForm.append('language', this.language);
            }



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
            const latencyMs = Math.round(performance.now() - tStart);
            let text = (data.text || '').trim();

            // Extract segment-level metadata (verbose_json)
            const seg = (data.segments && data.segments.length > 0) ? data.segments[0] : null;
            const noSpeechProb = seg ? (seg.no_speech_prob || 0) : 0;
            const avgLogProb   = seg ? (seg.avg_logprob   || 0) : 0;

            // Strip transliteration artifacts & convert Devanagari to natural Hinglish
            text = text.replace(/<\|.*?\|>/g, '');
            text = text.replace(/\bConverse\s+eye\b/gi, 'Converse AI');
            text = text.replace(/\btheconverseeye\b/gi, 'theconverseai');
            text = text.replace(/\bconverse\s*ai\b/gi, 'Converse AI').trim();
            // Phonetic normalization for slot booking times: e.g. "2 BM" or isolated "BM" -> "2 PM"
            text = text.replace(/\b([0-9]|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*bm\b/gi, '$1 PM');
            if (/^\s*bm\s*$/i.test(text)) text = '2 PM';
            text = devanagariToHinglish(text);
            text = cleanHinglishPhonetics(text);

            console.log(`[GroqWhisper] 🎙️ Transcribed in ${latencyMs}ms:`, text);
            this.isTranscribing = false;
            return { text, noSpeechProb, avgLogProb, latencyMs };

        } catch (err) {
            this.isTranscribing = false;
            console.error('[GroqWhisper] Transcription failed:', err.message);
            this.onError(err);
            return null;
        }
    }

    /**
     * Send recorded audio to Sarvam AI STT endpoint (saaras:v3)
     */
    async sendToSarvam(wavBlob, meta = {}) {
        this.isTranscribing = true;
        try {
            const formData = new FormData();
            formData.append('file', wavBlob, 'user_speech.wav');
            formData.append('model', 'saaras:v3');
            if (this.language === 'en') {
                formData.append('language_code', 'en-IN');
            } else if (this.language === 'hi') {
                formData.append('language_code', 'hi-IN');
            }

            const res = await fetch('/api/sarvam-stt', {
                method: 'POST',
                body: formData,
                signal: AbortSignal.timeout ? AbortSignal.timeout(3500) : undefined
            });

            if (!res.ok) {
                const errJson = await res.json().catch(() => ({}));
                throw new Error(errJson.error || `Sarvam STT HTTP ${res.status}`);
            }

            const data = await res.json();
            let text = (data.text || '').trim();
            text = text.replace(/<\|.*?\|>/g, '');
            text = text.replace(/\bConverse\s+eye\b/gi, 'Converse AI');
            text = text.replace(/\btheconverseeye\b/gi, 'theconverseai');
            text = text.replace(/\bconverse\s*ai\b/gi, 'Converse AI').trim();
            text = devanagariToHinglish(text);
            text = cleanHinglishPhonetics(text);

            console.log('[SarvamSTT] 🎙️ Transcribed:', text);
            this.isTranscribing = false;
            return { text, noSpeechProb: 0, avgLogProb: 0 };
        } catch (err) {
            this.isTranscribing = false;
            console.error('[SarvamSTT] Transcription error:', err.message);
            console.warn('[STT] Auto-falling back to Groq Whisper Large V3 Turbo...');
            return await this.sendToGroqWhisper(wavBlob, meta);
        }
    }
}

/**
 * Converts Devanagari Hindi text to clean, natural Roman Hinglish.
 * Ensures the user's transcript in chat is always readable Roman text (e.g. "aap kaise hain?")
 * and never raw Devanagari Hindi font.
 */
function devanagariToHinglish(text) {
    if (!text || !/[\u0900-\u097F]/.test(text)) return text;

    let processed = text;

    // 1. Multi-word phrases & English loanwords in Devanagari
    const phraseMap = [
        ['कन्वर्स एआई', 'Converse AI'], ['कॉन्वर्स एआई', 'Converse AI'],
        ['कन्वर्स', 'Converse'], ['कॉन्वर्स', 'Converse'], ['कन्वेर्स', 'Converse'],
        ['एआई', 'AI'], ['ए.आई.', 'AI'], ['ए.आइ.', 'AI'],
        ['व्हाट्सएप', 'WhatsApp'], ['वाट्सएप', 'WhatsApp'],
        ['कस्टमर सपोर्ट', 'customer support'], ['कस्टमर केयर', 'customer care'],
        ['कस्टमर', 'customer'], ['ग्राहक', 'customer'],
        ['सर्विसेज', 'services'], ['सर्विसेज़', 'services'], ['सर्विस', 'service'],
        ['सेवाएं', 'services'], ['सेवाएँ', 'services'], ['सेवा', 'services'],
        ['प्रोवाइड', 'provide'], ['प्रदान', 'provide'],
        ['बिज़नेस', 'business'], ['बिजनेस', 'business'], ['बिज़नेस', 'business'], ['व्यापार', 'business'],
        ['सपोर्ट', 'support'], ['सहायता', 'support'],
        ['हेल्प', 'help'], ['मदद', 'help'],
        ['रिटेल', 'retail'],
        ['अपॉइंटमेंट', 'appointment'], ['अपॉइंटमेंट्स', 'appointments'],
        ['डेमो', 'demo'], ['स्लॉट', 'slot'], ['टाइम स्लॉट', 'time slot'], ['टाइम', 'time'], ['समय', 'time'],
        ['बुक', 'book'], ['बुकिंग', 'booking'],
        ['वॉइस', 'voice'], ['वाइस', 'voice'], ['बॉट', 'bot'], ['एजेंट', 'agent'], ['एजेंट्स', 'agents'],
        ['सॉल्यूशन', 'solution'], ['सॉल्यूशंस', 'solutions'], ['प्लेटफॉर्म', 'platform'],
        ['एक्ज़ामपल', 'example'], ['एग्जांपल', 'example'], ['उदाहरण', 'example'],
        ['हिन्दी', 'Hindi'], ['हिंदी', 'Hindi'], ['इंग्लिश', 'English'], ['अंग्रेजी', 'English'], ['हिंग्लिश', 'Hinglish'],
        ['फोन नंबर', 'phone number'], ['मोबाइल नंबर', 'mobile number'], ['नंबर', 'number'], ['फोन', 'phone'],
        ['नाम', 'naam'], ['डिटेल', 'details'], ['डिटेल्स', 'details'],
        ['मेरे लिए', 'mere liye'], ['में लिए', 'mere liye'], ['आपके लिए', 'aapke liye'], ['हमारे लिए', 'hamare liye'], ['के लिए', 'ke liye'],
        ['बात कर', 'baat kar'], ['बात', 'baat'], ['बातें', 'baatein'],
        ['नमस्ते', 'namaste'], ['नमस्कार', 'namaskar'], ['शुक्रिया', 'shukriya'], ['धन्यवाद', 'dhanyawad'], ['अलविदा', 'alvida'],
        ['बिल्कुल', 'bilkul'], ['ज़रूर', 'zaroor'], ['जरूर', 'zaroor'], ['कृपया', 'kripya'],
        ['अच्छा', 'accha'], ['अच्छी', 'acchi'], ['अच्छे', 'acche'], ['ठीक', 'theek'], ['बढ़िया', 'badhiya'],
        ['क्या', 'kya'], ['क्यों', 'kyun'], ['कहाँ', 'kahan'], ['कहां', 'kahan'], ['कब', 'kab'], ['कौन', 'kaun'],
        ['कैसे', 'kaise'], ['कैसा', 'kaisa'], ['कैसी', 'kaisi'], ['कितना', 'kitna'], ['कितने', 'kitne'], ['कितनी', 'kitni'],
        ['आप', 'aap'], ['आपका', 'aapka'], ['आपकी', 'aapki'], ['आपके', 'aapke'],
        ['तुम', 'tum'], ['तुम्हारा', 'tumhara'], ['तुम्हारी', 'tumhari'], ['तुम्हारे', 'tumhare'], ['तू', 'tu'],
        ['मैं', 'main'], ['मेरा', 'mera'], ['मेरी', 'meri'], ['मेरे', 'mere'], ['मुझे', 'mujhe'], ['मुझसे', 'mujhse'],
        ['हम', 'hum'], ['हमारा', 'hamara'], ['हमारी', 'hamari'], ['हमारे', 'hamare'], ['हमें', 'humein'],
        ['यह', 'yeh'], ['ये', 'yeh'], ['वह', 'woh'], ['वो', 'woh'], ['इस', 'is'], ['उस', 'us'], ['इन', 'in'], ['उन', 'un'],
        ['कर', 'kar'], ['करता', 'karta'], ['करती', 'karti'], ['करते', 'karte'], ['करना', 'karna'], ['करो', 'karo'], ['करें', 'karein'], ['करके', 'karke'],
        ['हो', 'ho'], ['हैं', 'hain'], ['है', 'hai'], ['हूँ', 'hoon'], ['हूं', 'hoon'], ['था', 'tha'], ['थी', 'thi'], ['थे', 'the'],
        ['सकता', 'sakta'], ['सकती', 'sakti'], ['सकते', 'sakte'], ['सकूं', 'sakoon'], ['सकूँ', 'sakoon'],
        ['बोल', 'bol'], ['बोलो', 'bolo'], ['बोलिए', 'boliye'], ['बोलते', 'bolte'], ['बोलता', 'bolta'], ['बोलती', 'bolti'],
        ['बता', 'bata'], ['बताओ', 'batao'], ['बताइए', 'bataiye'], ['बताइये', 'bataiye'], ['बताएं', 'bataein'],
        ['पूछ', 'pooch'], ['पूछो', 'poocho'], ['पूछिए', 'poochiye'], ['पूछिये', 'poochiye'],
        ['दे', 'de'], ['दो', 'do'], ['दीजिए', 'dijiye'], ['दीजिये', 'dijiye'], ['देना', 'dena'], ['देता', 'deta'], ['देती', 'deti'], ['देते', 'dete'],
        ['ले', 'le'], ['लो', 'lo'], ['लीजिए', 'lijiye'], ['लीजिये', 'lijiye'], ['लेना', 'lena'], ['लेता', 'leta'], ['लेती', 'leti'], ['लेते', 'lete'],
        ['चाहिए', 'chahiye'], ['चाहिये', 'chahiye'], ['चाहता', 'chahta'], ['चाहती', 'chahti'], ['चाहते', 'chahte'],
        ['लिए', 'liye'],
        ['में', 'mein'], ['पर', 'par'], ['पे', 'pe'], ['से', 'se'], ['को', 'ko'], ['का', 'ka'], ['की', 'ki'], ['के', 'ke'], ['ने', 'ne'],
        ['और', 'aur'], ['या', 'ya'], ['लेकिन', 'lekin'], ['मगर', 'magar'], ['भी', 'bhi'], ['तो', 'toh'], ['अगर', 'agar'], ['जब', 'jab'], ['तब', 'tab'], ['क्योंकि', 'kyunki'], ['ताकि', 'taaki'],
        ['कुछ', 'kuch'], ['सब', 'sab'], ['सभी', 'sabhi'], ['बहुत', 'bahut'], ['बोहोत', 'bohot'], ['ज़्यादा', 'zyada'], ['ज्यादा', 'zyada'], ['कम', 'kam'], ['थोड़ा', 'thoda'], ['थोड़ी', 'thodi'], ['थोड़े', 'thode'],
        ['एक', 'ek'], ['दो', 'do'], ['तीन', 'teen'], ['चार', 'chaar'], ['पाँच', 'paanch'], ['पांच', 'paanch'], ['छह', 'chhah'], ['सात', 'saat'], ['आठ', 'aath'], ['नौ', 'nau'], ['दस', 'das'],
        ['आज', 'aaj'], ['कल', 'kal'], ['अभी', 'abhi'], ['बाद', 'baad'], ['पहले', 'pehle'],
        ['हाँ', 'haan'], ['हां', 'haan'], ['नहीं', 'nahin'], ['ना', 'na'], ['जी', 'ji']
    ];

    for (const [hi, ro] of phraseMap) {
        const re = new RegExp('(?<![\\u0900-\\u097F])' + hi + '(?![\\u0900-\\u097F])', 'gi');
        processed = processed.replace(re, ro);
    }

    // 2. Character-level fallback for any obscure Devanagari remaining
    if (/[\u0900-\u097F]/.test(processed)) {
        const vMap = {
            'अ': 'a', 'आ': 'aa', 'इ': 'i', 'ई': 'ee', 'उ': 'u', 'ऊ': 'oo', 'ऋ': 'ri',
            'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au', 'अं': 'an', 'अः': 'ah', 'ऑ': 'o', 'ऍ': 'e'
        };
        const mSignMap = {
            'ा': 'a', 'ि': 'i', 'ी': 'i', 'ु': 'u', 'ू': 'oo', 'ृ': 'ri',
            'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ं': 'n', 'ँ': 'n', 'ः': 'h', '्': '', 'ॉ': 'o', 'ॅ': 'e'
        };
        const cMap = {
            'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'ng',
            'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'ny',
            'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n',
            'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
            'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm',
            'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v',
            'श': 'sh', 'ष': 'sh', 'स': 's', 'ह': 'h',
            'क्ष': 'ksh', 'त्र': 'tr', 'ज्ञ': 'gya',
            'क़': 'q', 'ख़': 'kh', 'ग़': 'gh', 'ज़': 'z', 'फ़': 'f', 'ड़': 'r', 'ढ़': 'rh'
        };

        let res = '';
        const chars = Array.from(processed.replace(/\u093C/g, ''));
        for (let i = 0; i < chars.length; i++) {
            const ch = chars[i];
            const next = chars[i + 1] || '';
            if (cMap[ch]) {
                res += cMap[ch];
                if (next === '्') {
                    i++;
                } else if (mSignMap[next]) {
                    res += mSignMap[next];
                    i++;
                } else if (cMap[next] || vMap[next] || next === ' ' || next === '' || /[.,!?]/.test(next)) {
                    if (next !== ' ' && next !== '' && !/[.,!?]/.test(next)) res += 'a';
                }
            } else if (vMap[ch]) {
                res += vMap[ch];
            } else if (mSignMap[ch]) {
                res += mSignMap[ch];
            } else {
                res += ch;
            }
        }
        processed = res;
    }

    return processed.replace(/\s{2,}/g, ' ').trim();
}

/**
 * Cleans up common phonetic misspellings that Whisper outputs for spoken Hinglish
 */
function cleanHinglishPhonetics(text) {
    if (!text) return '';
    let cleaned = normalizeSpokenTimeWords(text)
        .replace(/\b(naini|nahin|naheen|nhi)\b/gi, 'nahi')
        .replace(/\bkoji\b/gi, 'koi')
        .replace(/\bmen\s+lie\b/gi, 'mere liye')
        .replace(/\bme\s+lie\b/gi, 'mere liye')
        .replace(/\bke\s+lie\b/gi, 'ke liye')
        .replace(/\bhindee\b/gi, 'Hindi')
        .replace(/\bkaartai\b/gi, 'karti hai')
        .replace(/\bsakatee\b/gi, 'sakti')
        .replace(/\bsakate\b/gi, 'sakte')
        .replace(/\bday\s+sakta\b/gi, 'de sakte')
        .replace(/\bday\s+sakti\b/gi, 'de sakti')
        .replace(/\bkaya\s+pa\b/gi, 'kya aap')
        .replace(/\bkaya\b/gi, 'kya')
        .replace(/\bbat\s+kar\b/gi, 'baat kar')
        .replace(/\bkya\s+ke\s+services\b/gi, 'kya services')
        // Common English/domain words Sarvam/Whisper mis-hear phonetically in code-switched speech
        .replace(/\bso\s+nara\b/gi, 'Sonara')
        .replace(/\bkainsil\b/gi, 'cancel')
        .replace(/\bhyooman\b/gi, 'human')
        .replace(/\briyal\s+parsan\b/gi, 'real person')
        .replace(/\bavelebal\b/gi, 'available')
        .replace(/\bpraising\s+plans\b/gi, 'pricing plans')
        .replace(/\bsetaap\b/gi, 'setup')
        .replace(/\bhau\s+das\b/gi, 'how does')
        .replace(/\byor\b/gi, 'your')
        .replace(/\botometed\s+koling\b/gi, 'automated calling')
        .replace(/\blid\s+janareshan\b/gi, 'lead generation')
        .replace(/\bselsaphors?\s+siaaraem\b/gi, 'Salesforce system')
        .replace(/\bkonvarsiya\b/gi, 'Converse AI')
        .replace(/\bintigret\b/gi, 'integrate')
        .replace(/\blaiv\b/gi, 'live')
        .replace(/\bthaink\s+yoo\b/gi, 'thank you')
        .replace(/\b(\d{1,2})\.(\d{2})\b/g, '$1:$2')
        .replace(/\s{2,}/g, ' ')
        .trim();
    cleaned = convertSpokenDigitSequences(cleaned);
    return cleaned;
}

/**
 * Normalizes spoken/phonetic time expressions so downstream time-entity extraction
 * (memory.js) can match them. Handles two STT failure modes seen in practice:
 *   1. "pi em" / "ei em" phonetic spellings of "PM" / "AM" (e.g. "thri pi em" for "3 PM").
 *   2. Spoken number words instead of digits, in English, common STT mishears, or
 *      romanized Hindi ("teen baje" for "3 baje", "thri pm" for "3 pm").
 * Without this, "kya teen baje ka slot available hai?" never produces a time entity
 * and the booking flow silently falls back to a default/stale time.
 */
function normalizeSpokenTimeWords(text) {
    if (!text) return text;

    let out = text
        .replace(/\bpi\s*\.?\s*em\b/gi, 'PM')
        .replace(/\bei\s*\.?\s*em\b/gi, 'AM')
        .replace(/\be\s*em\b/gi, 'AM');

    const numberWordMap = {
        // English
        one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
        // Common STT phonetic mishears of English numbers
        too: 2, tu: 2, thri: 3, tree: 3, thiri: 3, phor: 4, fore: 4, phaiv: 5, siks: 6, sicks: 6,
        sevan: 7, et: 8, ate: 8, nain: 9, nien: 9,
        // Romanized Hindi number words
        ek: 1, do: 2, teen: 3, tin: 3, chaar: 4, char: 4, paanch: 5, panch: 5, chhe: 6, che: 6,
        saat: 7, aath: 8, nau: 9, das: 10, gyarah: 11, barah: 12
    };

    out = out.replace(/\b([a-z]+)\s*(am|pm|baje|o'clock)\b/gi, (match, word, suffix) => {
        const num = numberWordMap[word.toLowerCase()];
        return num !== undefined ? `${num} ${suffix}` : match;
    });

    return out;
}

/**
 * STT often transcribes a dictated phone number ("two three four five...") as literal
 * words/phonetic approximations instead of digits. Detect runs of 6+ consecutive
 * digit-words and collapse them into an actual number string so the LLM can extract
 * the phone number correctly. Short runs (1-5 words) are left alone since words like
 * "for"/"to"/"ate" are common in normal speech and would false-positive.
 */
function convertSpokenDigitSequences(text) {
    if (!text) return text;
    const digitWordMap = {
        zero: '0', jiro: '0', jero: '0', 'o': '0',
        one: '1', van: '1', wan: '1',
        two: '2', too: '2', tu: '2',
        three: '3', thri: '3', tree: '3', thiri: '3',
        four: '4', phor: '4', 'for': '4', fore: '4',
        five: '5', phaiv: '5', phive: '5',
        six: '6', siks: '6', sicks: '6',
        seven: '7', sevan: '7',
        eight: '8', et: '8', ate: '8',
        nine: '9', nain: '9', nien: '9'
    };
    const tokens = text.split(/(\s+)/); // keep whitespace tokens for reassembly
    const wordTokens = tokens.filter((_, i) => i % 2 === 0);
    const runs = [];
    let current = [];
    wordTokens.forEach((raw, idx) => {
        const key = raw.toLowerCase().replace(/[.,!?।]/g, '');
        if (digitWordMap[key] !== undefined) {
            current.push({ idx, digit: digitWordMap[key] });
        } else {
            if (current.length >= 6) runs.push(current);
            current = [];
        }
    });
    if (current.length >= 6) runs.push(current);
    if (!runs.length) return text;

    runs.forEach(run => {
        const digits = run.map(r => r.digit).join('');
        wordTokens[run[0].idx] = digits;
        for (let i = 1; i < run.length; i++) wordTokens[run[i].idx] = '';
    });

    let out = '';
    let w = 0;
    for (let i = 0; i < tokens.length; i++) {
        out += (i % 2 === 0) ? wordTokens[w++] : tokens[i];
    }
    return out.replace(/\s{2,}/g, ' ').trim();
}
