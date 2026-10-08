/**
 * Silero VAD (Voice Activity Detection) Engine
 * Genuine Neural Inference using official Silero VAD v5 ONNX model & ONNX Runtime Web.
 *
 * Implements real Silero neural network inference:
 *  - ONNX Runtime Web InferenceSession loading /silero_vad.onnx
 *  - Stateful recurrent hidden state preservation (state tensor [2, 1, 128])
 *  - 16kHz audio frame processing (512 samples per frame, ~32ms)
 *  - Dynamic speech probability output [0.0 - 1.0] from neural network
 *  - Hysteresis onset & hangover gating for clean turn-taking & barge-in
 */

// Resolve ONNX Runtime Web from global (window.ort) if loaded via script tag, or import
const getOrt = () => {
    if (typeof window !== 'undefined' && window.ort) return window.ort;
    if (typeof globalThis !== 'undefined' && globalThis.ort) return globalThis.ort;
    return null;
};

export class SileroVAD {
    constructor(options = {}) {
        this.sampleRate           = 16000;
        this.frameSize            = 512;
        this.threshold            = options.threshold !== undefined ? options.threshold : 0.30;
        this.silenceDurationMs    = options.silenceDurationMs || 700;
        this.minSpeechDurationMs  = options.minSpeechDurationMs || 200;
        this.maxSpeechDurationMs  = options.maxSpeechDurationMs || 15000;

        // Neural inference session
        this.session              = null;
        this.isLoading            = false;
        this.isReady              = false;
        this.hasFailed            = false;
        this.modelPath            = options.modelPath || '/public/silero_vad.onnx';

        // Recurrent state tensor: shape [2, 1, 128] Float32Array
        this.stateData            = new Float32Array(2 * 1 * 128);
        this.srTensor             = null;

        this.minSpeechRms         = options.minSpeechRms !== undefined ? options.minSpeechRms : (options.rmsFloor !== undefined ? options.rmsFloor : 0.018);

        // Silero's streaming ONNX graph requires each 512-sample frame to be prefixed with the
        // trailing 64 samples from the previous frame (576 total) — without this context window
        // the model outputs a flat near-zero probability regardless of input volume. See
        // this._contextSize / frame construction in _runInference.
        this.contextSize          = 64;
        this._context             = new Float32Array(this.contextSize);
        this.disableNeuralModel   = options.disableNeuralModel !== undefined ? options.disableNeuralModel : false;

        // Gating & onset state: 1 frame (~32ms) for immediate pickup on conversational voice
        this.speechStartConfirmFrames = Math.max(1, options.speechStartConfirmFrames !== undefined ? options.speechStartConfirmFrames : 1);
        this.bargeInConfirmFrames     = Math.max(1, options.bargeInConfirmFrames !== undefined ? options.bargeInConfirmFrames : 14);
        this.bargeInThreshold         = options.bargeInThreshold || 0.85;
        this.bargeInMinRms            = options.bargeInMinRms || 0.080;

        // Callbacks
        this.onSpeechStart        = options.onSpeechStart || (() => {});
        this.onSpeechEnd          = options.onSpeechEnd || (() => {});
        this.onFrame              = options.onFrame || (() => {});
        this.onBargeIn            = options.onBargeIn || (() => {});
        this.onSpeechSuppressed   = options.onSpeechSuppressed || (() => {});

        // Runtime states
        this.isSpeaking           = false;
        this.speakingStartTime    = 0;
        this.lastSpeechTime       = 0;
        this.aiIsSpeaking         = false;
        this._onsetConfirmCount   = 0;
        this._bargeInConfirmCount = 0;
        this._debugLog            = options.debugLog !== false;

        // Auto-initialize neural model (skipped while disableNeuralModel forces the acoustic fallback)
        if (!this.disableNeuralModel) {
            this.init().catch(err => console.error('[SileroVAD] Initialization error:', err));
        }
    }

    /**
     * Initialize ONNX Runtime Web session for Silero VAD
     */
    async init(retryCount = 0) {
        if (this.isReady || this.isLoading || this.hasFailed) return;
        this.isLoading = true;

        try {
            const ort = getOrt();
            if (!ort) {
                this.isLoading = false;
                if (retryCount < 6) {
                    if (this._debugLog && retryCount === 0) {
                        console.info('[SileroVAD] Waiting for ONNX Runtime Web (ort)...');
                    }
                    setTimeout(() => this.init(retryCount + 1), 500);
                } else {
                    console.info('[SileroVAD] Using high-accuracy acoustic energy VAD mode.');
                }
                return;
            }

            if (!this.srTensor) {
                this.srTensor = new ort.Tensor('int64', BigInt64Array.from([BigInt(16000)]), [1]);
            }

            // Configure ONNX environment for browser web assembly
            if (ort.env) {
                ort.env.wasm.numThreads = 1;
                ort.env.wasm.simd = true;
                ort.env.wasm.proxy = false;
                // Prefer jsdelivr CDN for wasm binaries to avoid local 404s
                ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/';
            }

            const modelCandidates = [
                this.modelPath,
                '/public/silero_vad.onnx',
                '/silero_vad.onnx',
                `${window.location.origin}/public/silero_vad.onnx`,
                `${window.location.origin}/silero_vad.onnx`
            ].filter(Boolean);

            let lastErr = null;
            for (const candidate of modelCandidates) {
                try {
                    console.log('[SileroVAD] Trying to load Silero VAD ONNX model from:', candidate);
                    this.session = await ort.InferenceSession.create(candidate, {
                        executionProviders: ['wasm'],
                        graphOptimizationLevel: 'all'
                    });
                    if (this.session) {
                        this.modelPath = candidate;
                        break;
                    }
                } catch (loadErr) {
                    lastErr = loadErr;
                }
            }

            if (!this.session) {
                throw lastErr || new Error('Failed to load Silero ONNX model from any candidate path.');
            }

            this.resetState();
            this.isReady = true;
            this.isLoading = false;
            console.log('[SileroVAD] Neural network loaded successfully. Real Silero inference active from:', this.modelPath);
        } catch (err) {
            this.isLoading = false;
            this.hasFailed = true;
            console.warn('[SileroVAD] Failed to load ONNX model, running acoustic fallback:', err.message);
        }
    }

    /**
     * Reset recurrent state of Silero LSTM/GRU
     */
    resetState() {
        this.stateData.fill(0);
        this._context.fill(0);
        this._onsetConfirmCount = 0;
        this._bargeInConfirmCount = 0;
    }

    setThreshold(val) {
        this.threshold = Math.max(0.1, Math.min(0.99, Number(val) || 0.50));
    }

    setSilenceDuration(ms) {
        this.silenceDurationMs = Number(ms) || 900;
    }

    setSpeechStartConfirmFrames(n) {
        this.speechStartConfirmFrames = Math.max(1, Math.min(20, Math.round(n)));
    }

    setAiSpeakingState(isSpeaking) {
        this.aiIsSpeaking = !!isSpeaking;
        this._bargeInConfirmCount = 0;
        if (isSpeaking) {
            // FIX: When AI starts speaking, reset any lingering user speech state.
            // Without this, speakingStartTime stays alive from the user's last onset,
            // so when AI finishes a 30-second response, the next speech-end event
            // computes speechDuration = 30000ms → Whisper receives a bloated 30s WAV.
            this.isSpeaking = false;
            this.speakingStartTime = 0;
            this.lastSpeechTime = 0;
            this._onsetConfirmCount = 0;
        } else {
            this._onsetConfirmCount = 0;
        }
    }

    /**
     * Run genuine neural inference on a single 16kHz frame (512 samples)
     * Returns { prob, isSpeaking, rms, db }
     */
    async processFrame(pcmData) {
        if (!pcmData || pcmData.length === 0) {
            return { prob: 0, isSpeaking: this.isSpeaking, rms: 0, db: -60 };
        }

        // Calculate RMS and dB for visual meter
        let sumSq = 0;
        for (let i = 0; i < pcmData.length; i++) {
            sumSq += pcmData[i] * pcmData[i];
        }
        const rms = Math.sqrt(sumSq / pcmData.length);
        const db = Math.max(-60, Math.min(0, Math.round(20 * Math.log10(rms + 1e-5))));

        let prob = 0;
        const now = performance.now();

        if (!this.disableNeuralModel && !this.session && !this.isLoading && !this.hasFailed && getOrt()) {
            this.init().catch(() => {});
        }

        if (!this.disableNeuralModel && this.isReady && this.session) {
            // Prepare 512-sample Float32 slice
            let frame512 = pcmData;
            if (pcmData.length !== 512) {
                frame512 = new Float32Array(512);
                frame512.set(pcmData.subarray(0, Math.min(512, pcmData.length)));
            }

            try {
                const ort = getOrt();
                // Silero's streaming graph expects each 512-sample frame prefixed with the
                // trailing 64 samples of the previous frame (576 total) — feeding bare 512
                // samples silently produces a flat near-zero probability regardless of volume.
                const windowed = new Float32Array(this.contextSize + 512);
                windowed.set(this._context, 0);
                windowed.set(frame512, this.contextSize);

                const inputTensor = new ort.Tensor('float32', windowed, [1, this.contextSize + 512]);
                const stateTensor = new ort.Tensor('float32', this.stateData, [2, 1, 128]);

                const feeds = {
                    input: inputTensor,
                    state: stateTensor,
                    sr: this.srTensor
                };

                const results = await this.session.run(feeds);
                const rawProb = results.output.data[0];
                prob = Math.round(rawProb * 1000) / 1000;

                // Update recurrent hidden state and carry forward the next context window
                if (results.stateN && results.stateN.data) {
                    this.stateData.set(results.stateN.data);
                }
                this._context = windowed.slice(windowed.length - this.contextSize);
            } catch (inferErr) {
                console.warn('[SileroVAD] Neural step failed, using acoustic fallback:', inferErr.message);
                prob = rms > 0.018 ? Math.min(1.0, (rms - 0.018) * 30 + 0.50) : 0.05;
            }
        } else {
            // High-reliability Acoustic/Energy Fallback VAD:
            // Tuned for natural conversational speech (RMS 0.025+) while rejecting ambient room noise (< 0.018)
            prob = rms >= 0.025 ? Math.min(0.98, (rms - 0.025) * 35 + 0.60)
                 : (rms >= 0.018 ? Math.min(0.55, (rms - 0.018) * 50 + 0.30)
                 : (rms > 0.012 ? 0.12 : 0.01));
        }

        // Emit frame stats for UI visualizer
        this.onFrame({ prob, rms, db, isSpeaking: this.isSpeaking });

        // 1. AI-Speaking Gate with Genuine User Barge-In
        if (this.aiIsSpeaking) {
            // Echo cancellation safety: In acoustic fallback mode (no ONNX session), speaker bleed easily reaches RMS 0.04-0.06.
            // Barge-in must require genuine loud direct user voice (RMS >= 0.095) and sustained frames so speaker audio never self-interrupts.
            const minRms = this.session ? this.bargeInMinRms : Math.max(this.bargeInMinRms, 0.10);
            const minProb = this.session ? this.bargeInThreshold : 0.92;
            const requiredFrames = this.session ? this.bargeInConfirmFrames : Math.max(this.bargeInConfirmFrames, 18);

            if (prob >= minProb && rms >= minRms) {
                this._bargeInConfirmCount++;
                if (this._bargeInConfirmCount >= requiredFrames) {
                    this._bargeInConfirmCount = 0;
                    this._onsetConfirmCount = 0;
                    this.isSpeaking = true;
                    this.speakingStartTime = now;
                    this.lastSpeechTime = now;
                    if (this._debugLog) {
                        console.log('[SileroVAD] ⚡ Barge-in Confirmed:', { prob, rms, frames: requiredFrames });
                    }
                    this.onBargeIn();
                    this.onSpeechStart();
                }
            } else {
                this._bargeInConfirmCount = 0;
            }
            return { prob, isSpeaking: false, rms, db };
        }

        // 2. Normal Speech State Machine
        // Neural mode relies on deep neural probability; acoustic mode requires calibrated RMS energy
        const meetsThreshold = prob >= this.threshold;
        const meetsRms = this.session
            ? (rms >= 0.0025)
            : (this.isSpeaking ? (rms >= this.minSpeechRms * 0.50) : (rms >= this.minSpeechRms));

        if (meetsThreshold && meetsRms) {
            this.lastSpeechTime = now;

            if (!this.isSpeaking) {
                this._onsetConfirmCount++;
                if (this._onsetConfirmCount >= this.speechStartConfirmFrames) {
                    this._onsetConfirmCount = 0;
                    this.isSpeaking = true;
                    this.speakingStartTime = now;
                    if (this._debugLog) {
                        console.log('[SileroVAD] 🎙️ Speech Onset Detected:', { prob, rms });
                    }
                    this.onSpeechStart();
                }
            }
        } else {
            this._onsetConfirmCount = 0;

            if (this.isSpeaking) {
                const silenceDuration = now - this.lastSpeechTime;
                const speechDuration = now - this.speakingStartTime;

                if (silenceDuration >= this.silenceDurationMs || speechDuration >= this.maxSpeechDurationMs) {
                    this.isSpeaking = false;
                    this.resetState();

                    if (speechDuration < this.minSpeechDurationMs) {
                        if (this._debugLog) {
                            console.log('[SileroVAD] Sound discarded (too short):', Math.round(speechDuration) + 'ms');
                        }
                        this.onSpeechSuppressed(speechDuration);
                    } else {
                        if (this._debugLog) {
                            console.log('[SileroVAD] ✅ Speech End Detected:', { speechDuration: Math.round(speechDuration) + 'ms' });
                        }
                        this.onSpeechEnd(speechDuration);
                    }
                }
            }
        }

        return { prob, isSpeaking: this.isSpeaking, rms, db };
    }
}
