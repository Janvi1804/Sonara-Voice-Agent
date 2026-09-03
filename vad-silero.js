/**
 * Sonara Voice Activity Detection Engine (Hardened DSP VAD)
 *
 * Key improvements over v1:
 *  - speechStartConfirmFrames: require N consecutive above-threshold frames before
 *    declaring speech onset. Eliminates single-frame false triggers (keyboard clicks,
 *    plosive consonants, chair creaks, mic init noise).
 *  - rmsFloor: configurable minimum RMS gate (not hardcoded). Default 0.007 matches
 *    original. Should be tuned per environment via Settings slider.
 *  - bargeInConfirmFrames: require N consecutive high-energy frames during AI speech
 *    to confirm genuine user barge-in (not speaker bleed).
 *  - onSpeechSuppressed: callback fired when a sound is detected but too short to
 *    transcribe. App uses this to clear Whisper audio buffer.
 *  - maxSpeechDurationMs: safety cutoff if user never goes silent.
 *  - Diagnostic logging: structured per-event log for debugging.
 *
 * NOTE: This is NOT the actual Silero ONNX neural network.
 * It is a calibrated DSP approximation (RMS + ZCR + SNR).
 * A/B comparison with real Silero ONNX (via onnxruntime-web) should be performed
 * using real microphone recordings after pipeline stabilisation.
 */
export class SileroVAD {
    constructor(options = {}) {
        this.sampleRate           = options.sampleRate           || 16000;
        this.frameSize            = options.frameSize            || 512;
        this.threshold            = options.threshold            || 0.65;
        this.silenceDurationMs    = options.silenceDurationMs    || 1200;
        this.minSpeechDurationMs  = options.minSpeechDurationMs  || 250;
        this.maxSpeechDurationMs  = options.maxSpeechDurationMs  || 30000;

        // Onset confirmation: N consecutive frames above threshold required before onSpeechStart.
        // Each frame is approx 32ms. Default 3 = ~96ms of sustained audio required.
        // Eliminates single keyboard clicks, chair creaks, plosive consonants.
        this.speechStartConfirmFrames = Math.max(1,
            options.speechStartConfirmFrames !== undefined ? options.speechStartConfirmFrames : 3);

        // Configurable RMS floor gate. Audio below this level is treated as silence
        // regardless of ZCR or SNR. Not hardcoded -- tune per environment.
        this.rmsFloor = options.rmsFloor !== undefined ? options.rmsFloor : 0.007;

        // Barge-in confirmation: N consecutive frames above barge-in threshold required
        // while AI is speaking. Prevents speaker bleed triggering barge-in.
        this.bargeInConfirmFrames = Math.max(1,
            options.bargeInConfirmFrames !== undefined ? options.bargeInConfirmFrames : 8);

        // Callbacks
        this.onSpeechStart      = options.onSpeechStart      || (() => {});
        this.onSpeechEnd        = options.onSpeechEnd        || (() => {});
        this.onFrame            = options.onFrame            || (() => {});
        this.onBargeIn          = options.onBargeIn          || (() => {});
        // Fired when sound detected but too short (< minSpeechDurationMs).
        // App uses this to call whisperEngine.clearBuffer().
        this.onSpeechSuppressed = options.onSpeechSuppressed || (() => {});

        // State
        this.isSpeaking           = false;
        this.speakingStartTime    = 0;
        this.lastSpeechTime       = 0;
        this.aiIsSpeaking         = false;
        this._onsetConfirmCount   = 0;
        this._bargeInConfirmCount = 0;

        // DSP history
        this.noiseFloor   = 0.005;
        this.smoothedProb = 0.0;

        this._debugLog    = options.debugLog !== false;
        this._lastLogTime = 0;
    }

    setThreshold(val) {
        this.threshold = Math.max(0.1, Math.min(0.99, Number(val) || 0.65));
    }

    setSilenceDuration(ms) {
        this.silenceDurationMs = Number(ms) || 800;
    }

    setRmsFloor(val) {
        this.rmsFloor = Math.max(0.001, Math.min(0.05, Number(val) || 0.007));
    }

    setSpeechStartConfirmFrames(n) {
        this.speechStartConfirmFrames = Math.max(1, Math.min(20, Math.round(n)));
    }

    setAiSpeakingState(isSpeaking) {
        this.aiIsSpeaking = !!isSpeaking;
        if (isSpeaking) {
            this.aiSpeechStartTime = performance.now();
            this._bargeInConfirmCount = 0;
        } else {
            this._bargeInConfirmCount = 0;
        }
    }

    /**
     * Process one 16kHz PCM frame (Float32Array, approx 32ms).
     * Returns { prob, isSpeaking, rms, snr, db }.
     */
    processFrame(pcmData) {
        const n = pcmData.length;
        if (n === 0) return { prob: 0, isSpeaking: this.isSpeaking, rms: 0, snr: 0, db: -60 };

        // 1. RMS and Zero Crossing Rate (with noise deadband to ignore sub-noise jitter)
        let sumSq = 0;
        let zc = 0;
        let lastSign = pcmData[0] >= 0 ? 1 : -1;
        const deadband = Math.max(0.002, this.noiseFloor * 0.4);
        for (let i = 0; i < n; i++) {
            const s = pcmData[i];
            sumSq += s * s;
            if (s >= deadband && lastSign === -1) { zc++; lastSign = 1; }
            else if (s <= -deadband && lastSign === 1) { zc++; lastSign = -1; }
        }
        const rms = Math.sqrt(sumSq / n);
        const zcr = zc / n;

        // 2. Adaptive noise floor
        if (rms < this.noiseFloor * 1.5) {
            this.noiseFloor = 0.95 * this.noiseFloor + 0.05 * rms;
        } else {
            this.noiseFloor = 0.999 * this.noiseFloor + 0.001 * rms;
        }
        this.noiseFloor = Math.max(0.0005, Math.min(0.04, this.noiseFloor));

        // 3. SNR
        const snr = Math.max(0, 20 * Math.log10((rms + 1e-6) / (this.noiseFloor + 1e-6)));

        // 4. Speech probability (DSP approximation with smooth continuous SNR curve)
        // Replaced hard cutoff (snr < 4) with a smooth continuous logistic curve centered at 3.5 dB.
        const snrFactor        = (rms < this.rmsFloor) ? 0
            : (1 / (1 + Math.exp(-0.45 * (snr - 3.5))));
        // Human speech formants have ZCR between 0.024 and 0.60. Low-frequency motor hums (<150Hz) have ZCR <= 0.018.
        const zcrFactor        = (zcr >= 0.024 && zcr <= 0.60) ? 1.0 : (zcr <= 0.018 ? 0.20 : 0.45);
        const energyConfidence = (rms < this.rmsFloor) ? 0
            : Math.min(1.0, Math.max(0, (rms - this.rmsFloor * 0.7) / (this.rmsFloor * 2.0)));
        const rawProb          = (snrFactor === 0 || energyConfidence === 0) ? 0
            : Math.min(1.0, Math.max(0.0, (snrFactor * 0.75 + energyConfidence * 0.25) * zcrFactor));

        // 5. Asymmetric smoothing
        this.smoothedProb = rawProb > this.smoothedProb
            ? 0.4 * this.smoothedProb + 0.6 * rawProb
            : 0.85 * this.smoothedProb + 0.15 * rawProb;
        const prob = Math.round(this.smoothedProb * 1000) / 1000;

        // 6. Frame callback for UI
        const db = Math.max(-60, Math.min(0, Math.round(20 * Math.log10(rms + 1e-5))));
        this.onFrame({ prob, rms, db, isSpeaking: this.isSpeaking });

        const now = performance.now();

        // 7. AI-speaking gate with safe barge-in monitoring
        if (this.aiIsSpeaking) {
            // Monitor for genuine user barge-in while AI speaks.
            // Speaker bleed from laptop speakers typically measures RMS 0.015 - 0.065.
            // Genuine user speech right into mic is louder (RMS >= 0.085) and sustained (>= 12 frames = ~384ms).
            if (prob >= 0.92 && rms >= 0.085) {
                this._bargeInConfirmCount++;
                if (this._bargeInConfirmCount >= (this.bargeInConfirmFrames || 12)) {
                    this._bargeInConfirmCount = 0;
                    this._onsetConfirmCount = 0;
                    this.isSpeaking = true;
                    this.speakingStartTime = now;
                    this.lastSpeechTime = now;
                    if (this._debugLog) {
                        console.log('[VAD] Genuine Barge-in confirmed', {
                            prob: prob.toFixed(3), rms: rms.toFixed(4),
                            frames: this.bargeInConfirmFrames
                        });
                    }
                    this.onBargeIn();
                    this.onSpeechStart();
                }
            } else {
                this._bargeInConfirmCount = 0;
            }
            return { prob: 0, isSpeaking: false, rms, snr, db };
        }

        // 8. Normal speech state machine
        if (prob >= this.threshold) {
            this.lastSpeechTime = now;

            if (!this.isSpeaking) {
                // Onset confirmation gate
                this._onsetConfirmCount++;
                if (this._onsetConfirmCount >= this.speechStartConfirmFrames) {
                    this._onsetConfirmCount = 0;
                    this.isSpeaking = true;
                    const windowMs = this.speechStartConfirmFrames * (this.frameSize / this.sampleRate) * 1000;
                    this.speakingStartTime = now - windowMs;
                    if (this._debugLog) {
                        console.log('[VAD] Speech onset', {
                            prob: prob.toFixed(3), rms: rms.toFixed(4), snr: snr.toFixed(1)
                        });
                    }
                    this.onSpeechStart();
                }
            } else {
                this._onsetConfirmCount = 0;
                // Safety cutoff
                if ((now - this.speakingStartTime) >= this.maxSpeechDurationMs) {
                    const dur = now - this.speakingStartTime;
                    console.warn('[VAD] Max speech duration cutoff:', Math.round(dur) + 'ms');
                    this.isSpeaking = false;
                    this.onSpeechEnd(dur);
                }
            }
        } else {
            if (this.isSpeaking) {
                const silenceElapsed = now - this.lastSpeechTime;
                if (silenceElapsed >= this.silenceDurationMs) {
                    const speechDuration = this.lastSpeechTime - this.speakingStartTime;
                    this.isSpeaking = false;
                    this._onsetConfirmCount = 0;

                    if (speechDuration >= this.minSpeechDurationMs) {
                        if (this._debugLog) {
                            const t = performance.now();
                            if (t - this._lastLogTime > 300) {
                                console.log('[VAD] Speech end', { duration: Math.round(speechDuration) + 'ms' });
                                this._lastLogTime = t;
                            }
                        }
                        this.onSpeechEnd(speechDuration);
                    } else {
                        if (this._debugLog) {
                            console.log('[VAD] Sound suppressed (too short):', Math.round(speechDuration) + 'ms < min', this.minSpeechDurationMs + 'ms');
                        }
                        this.onSpeechSuppressed(speechDuration);
                    }
                }
            } else {
                this._onsetConfirmCount = 0;
            }
        }

        return { prob, isSpeaking: this.isSpeaking, rms, snr, db };
    }

    reset() {
        this.isSpeaking           = false;
        this.speakingStartTime    = 0;
        this.lastSpeechTime       = 0;
        this.smoothedProb         = 0.0;
        this._onsetConfirmCount   = 0;
        this._bargeInConfirmCount = 0;
    }
}

if (typeof window !== 'undefined') {
    window.SileroVAD = SileroVAD;
}
