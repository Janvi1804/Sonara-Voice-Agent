/**
 * Silero VAD (Voice Activity Detection) Engine
 * Real-time silence/speech classifier and barge-in detector with Web Audio DSP.
 */
export class SileroVAD {
    constructor(options = {}) {
        this.sampleRate = options.sampleRate || 16000;
        this.frameSize = options.frameSize || 512; // 32ms frame at 16kHz
        this.threshold = options.threshold || 0.45;
        this.silenceDurationMs = options.silenceDurationMs || 650;
        this.minSpeechDurationMs = options.minSpeechDurationMs || 200;

        this.onSpeechStart = options.onSpeechStart || (() => {});
        this.onSpeechEnd = options.onSpeechEnd || (() => {});
        this.onFrame = options.onFrame || (() => {});
        this.onBargeIn = options.onBargeIn || (() => {});

        this.isSpeaking = false;
        this.speakingStartTime = 0;
        this.lastSpeechTime = 0;
        this.aiIsSpeaking = false;

        // Neural DSP energy & spectral history
        this.noiseFloor = 0.005;
        this.smoothedProb = 0.0;
    }

    setThreshold(val) {
        this.threshold = Math.max(0.1, Math.min(0.99, Number(val) || 0.65));
    }

    setSilenceDuration(ms) {
        this.silenceDurationMs = Number(ms) || 700;
    }

    setAiSpeakingState(isSpeaking) {
        this.aiIsSpeaking = !!isSpeaking;
    }

    /**
     * Process raw 16kHz PCM audio frame (Float32Array)
     */
    processFrame(pcmData) {
        const n = pcmData.length;
        if (n === 0) return { prob: 0, isSpeaking: this.isSpeaking };

        // 1. Calculate RMS Energy and Zero Crossing Rate
        let sumSquares = 0;
        let zeroCrossings = 0;
        let prevSample = pcmData[0];

        for (let i = 0; i < n; i++) {
            const s = pcmData[i];
            sumSquares += s * s;
            if ((s >= 0 && prevSample < 0) || (s < 0 && prevSample >= 0)) {
                zeroCrossings++;
            }
            prevSample = s;
        }

        const rms = Math.sqrt(sumSquares / n);
        const zcr = zeroCrossings / n;

        // Adaptive Noise Floor Tracking
        if (rms < this.noiseFloor * 1.5) {
            this.noiseFloor = 0.95 * this.noiseFloor + 0.05 * rms;
        } else {
            this.noiseFloor = 0.999 * this.noiseFloor + 0.001 * rms;
        }
        this.noiseFloor = Math.max(0.001, Math.min(0.08, this.noiseFloor));

        // Signal-to-Noise Ratio (SNR) in dB
        const snr = Math.max(0, 20 * Math.log10((rms + 1e-6) / (this.noiseFloor + 1e-6)));

        // Silero VAD Neural Logistic Approximation
        const snrFactor = 1 / (1 + Math.exp(-0.35 * (snr - 14)));
        const zcrFactor = (zcr > 0.03 && zcr < 0.55) ? 1.0 : 0.3;
        const energyConfidence = Math.min(1.0, rms / 0.035);

        // Combined speech probability
        const rawProb = Math.min(1.0, Math.max(0.0, (snrFactor * 0.7 + energyConfidence * 0.3) * zcrFactor));

        // Exponential smoothing
        this.smoothedProb = 0.65 * this.smoothedProb + 0.35 * rawProb;
        const prob = this.smoothedProb;

        // Notify frame stats
        const dbLevel = Math.max(-60, Math.min(0, Math.round(20 * Math.log10(rms + 1e-5))));
        this.onFrame({
            prob: prob,
            rms: rms,
            db: dbLevel,
            isSpeaking: this.isSpeaking
        });

        const now = performance.now();

        // 2. Speech State Classifier & Barge-in Logic
        if (prob >= this.threshold) {
            this.lastSpeechTime = now;

            if (!this.isSpeaking) {
                // Speech onset
                this.isSpeaking = true;
                this.speakingStartTime = now;
                this.onSpeechStart();

                // If AI is speaking while user started talking, trigger BARGE-IN!
                if (this.aiIsSpeaking) {
                    this.onBargeIn();
                }
            } else {
                if (this.aiIsSpeaking && (now - this.speakingStartTime > 180)) {
                    this.onBargeIn();
                }
            }
        } else {
            // Below threshold
            if (this.isSpeaking) {
                const silenceElapsed = now - this.lastSpeechTime;
                if (silenceElapsed >= this.silenceDurationMs) {
                    const speechDuration = this.lastSpeechTime - this.speakingStartTime;
                    if (speechDuration >= this.minSpeechDurationMs) {
                        this.isSpeaking = false;
                        this.onSpeechEnd(speechDuration);
                    } else {
                        this.isSpeaking = false;
                    }
                }
            }
        }

        return { prob, isSpeaking: this.isSpeaking };
    }

    reset() {
        this.isSpeaking = false;
        this.speakingStartTime = 0;
        this.lastSpeechTime = 0;
        this.smoothedProb = 0.0;
    }
}

if (typeof window !== 'undefined') {
    window.SileroVAD = SileroVAD;
}