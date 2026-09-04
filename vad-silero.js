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
        this.threshold            = options.threshold !== undefined ? options.threshold : 0.50;
        this.silenceDurationMs    = options.silenceDurationMs || 800;
        this.minSpeechDurationMs  = options.minSpeechDurationMs || 250;
        this.maxSpeechDurationMs  = options.maxSpeechDurationMs || 30000;

        // Neural inference session
        this.session              = null;
        this.isLoading            = false;
        this.isReady              = false;
        this.modelPath            = options.modelPath || '/silero_vad.onnx';

        // Recurrent state tensor: shape [2, 1, 128] Float32Array
        this.stateData            = new Float32Array(2 * 1 * 128);
        this.srTensor             = null;

        // Gating & onset state
        this.speechStartConfirmFrames = Math.max(1, options.speechStartConfirmFrames !== undefined ? options.speechStartConfirmFrames : 2);
        this.bargeInConfirmFrames     = Math.max(1, options.bargeInConfirmFrames !== undefined ? options.bargeInConfirmFrames : 6);

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

        // Auto-initialize neural model
        this.init().catch(err => console.error('[SileroVAD] Initialization error:', err));
    }

    /**
     * Initialize ONNX Runtime Web session for Silero VAD
     */
    async init() {
        if (this.isReady || this.isLoading) return;
        this.isLoading = true;

        try {
            const ort = getOrt();
            if (!ort) {
                console.warn('[SileroVAD] ONNX Runtime Web (ort) not loaded yet, will retry when available.');
                this.isLoading = false;
                return;
            }

            if (!this.srTensor) {
                this.srTensor = new ort.Tensor('int64', BigInt64Array.from([BigInt(16000)]), [1]);
            }

            // Configure ONNX environment for browser web assembly
            if (ort.env) {
                ort.env.wasm.numThreads = 1;
                ort.env.wasm.simd = true;
                ort.env.wasm.wasmPaths = '/';
            }

            console.log('[SileroVAD] Loading official Silero VAD ONNX model from', this.modelPath);
            this.session = await ort.InferenceSession.create(this.modelPath, {
                executionProviders: ['wasm'],
                graphOptimizationLevel: 'all'
            });

            this.resetState();
            this.isReady = true;
            this.isLoading = false;
            console.log('[SileroVAD] Neural network loaded successfully. Real Silero inference active.');
        } catch (err) {
            this.isLoading = false;
            console.error('[SileroVAD] Failed to load ONNX model:', err.message);
            throw err;
        }
    }

    /**
     * Reset recurrent state of Silero LSTM/GRU
     */
    resetState() {
        this.stateData.fill(0);
        this._onsetConfirmCount = 0;
        this._bargeInConfirmCount = 0;
    }

    setThreshold(val) {
        this.threshold = Math.max(0.1, Math.min(0.99, Number(val) || 0.50));
    }

    setSilenceDuration(ms) {
        this.silenceDurationMs = Number(ms) || 800;
    }

    setSpeechStartConfirmFrames(n) {
        this.speechStartConfirmFrames = Math.max(1, Math.min(20, Math.round(n)));
    }

    setAiSpeakingState(isSpeaking) {
        this.aiIsSpeaking = !!isSpeaking;
        this._bargeInConfirmCount = 0;
        if (!isSpeaking) {
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

        // If neural model not loaded yet, try initializing
        if (!this.isReady || !this.session) {
            const ort = getOrt();
            if (ort && !this.isLoading) {
                this.init().catch(() => {});
            }
            this.onFrame({ prob: 0, rms, db, isSpeaking: this.isSpeaking });
            return { prob: 0, isSpeaking: this.isSpeaking, rms, db };
        }

        // Prepare 512-sample Float32 slice
        let frame512 = pcmData;
        if (pcmData.length !== 512) {
            frame512 = new Float32Array(512);
            frame512.set(pcmData.subarray(0, Math.min(512, pcmData.length)));
        }

        try {
            const ort = getOrt();
            const inputTensor = new ort.Tensor('float32', frame512, [1, 512]);
            const stateTensor = new ort.Tensor('float32', this.stateData, [2, 1, 128]);

            const feeds = {
                input: inputTensor,
                state: stateTensor,
                sr: this.srTensor
            };

            const results = await this.session.run(feeds);
            const rawProb = results.output.data[0];
            const prob = Math.round(rawProb * 1000) / 1000;

            // Update recurrent hidden state
            if (results.stateN && results.stateN.data) {
                this.stateData.set(results.stateN.data);
            }

            // Emit frame stats for UI visualizer
            this.onFrame({ prob, rms, db, isSpeaking: this.isSpeaking });

            const now = performance.now();

            // 1. AI-Speaking Gate with Genuine User Barge-In
            if (this.aiIsSpeaking) {
                // When AI is speaking, user must deliberately speak with high neural probability
                // and higher energy to override speaker bleed
                if (prob >= 0.70 && rms >= 0.040) {
                    this._bargeInConfirmCount++;
                    if (this._bargeInConfirmCount >= this.bargeInConfirmFrames) {
                        this._bargeInConfirmCount = 0;
                        this._onsetConfirmCount = 0;
                        this.isSpeaking = true;
                        this.speakingStartTime = now;
                        this.lastSpeechTime = now;
                        if (this._debugLog) {
                            console.log('[SileroVAD] ⚡ Neural Barge-in Confirmed:', { prob, rms, frames: this.bargeInConfirmFrames });
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
            if (prob >= this.threshold) {
                this.lastSpeechTime = now;

                if (!this.isSpeaking) {
                    this._onsetConfirmCount++;
                    if (this._onsetConfirmCount >= this.speechStartConfirmFrames) {
                        this._onsetConfirmCount = 0;
                        this.isSpeaking = true;
                        this.speakingStartTime = now;
                        if (this._debugLog) {
                            console.log('[SileroVAD] 🎙️ Neural Speech Onset:', { prob, rms });
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
                                console.log('[SileroVAD] Speech discarded (too short):', Math.round(speechDuration) + 'ms');
                            }
                            this.onSpeechSuppressed(speechDuration);
                        } else {
                            if (this._debugLog) {
                                console.log('[SileroVAD] ✅ Neural Speech End:', { speechDuration: Math.round(speechDuration) + 'ms' });
                            }
                            this.onSpeechEnd(speechDuration);
                        }
                    }
                }
            }

            return { prob, isSpeaking: this.isSpeaking, rms, db };

        } catch (inferErr) {
            console.warn('[SileroVAD] Inference step failed:', inferErr.message);
            return { prob: 0, isSpeaking: this.isSpeaking, rms, db };
        }
    }
}
