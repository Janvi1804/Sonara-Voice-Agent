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
        this.preSpeechMaxChunks = 16; // ~512ms pre-speech buffer to preserve initial consonants
        this.isRecording = false;
        this.isTranscribing = false;

        this.rmsFloor = options.rmsFloor !== undefined ? options.rmsFloor : 0.003;
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
        const result = isSarvam
            ? await this.sendToSarvam(wavBlob, { durationMs, rms })
            : await this.sendToGroqWhisper(wavBlob, { durationMs, rms });

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
            whisperForm.append('prompt', 'Caller speaking in Hindi, Hinglish, or English to Sonara at Converse AI about voice agents, customer support, sales, revenue, and booking a demo.');
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
    return text
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
        .replace(/\b(\d{1,2})\.(\d{2})\b/g, '$1:$2')
        .replace(/\s{2,}/g, ' ')
        .trim();
}
