/**
 * SONARA VOICE AI - Main Application & Full Duplex Orchestrator
 * Integrates Silero VAD, WebRTC/Web Audio DSP, Whisper v3 Turbo, Gemma 2, and Kokoro-82M.
 */
import { SileroVAD } from './vad-silero.js';
import { KokoroTTS } from './kokoro-tts.js';

document.addEventListener('DOMContentLoaded', () => {
    // UI Elements
    const btnToggleVoice = document.getElementById('btnToggleVoice');
    const callBtnIcon = document.getElementById('callBtnIcon');
    const callBtnText = document.getElementById('callBtnText');
    const btnInterrupt = document.getElementById('btnInterrupt');
    const btnClearChat = document.getElementById('btnClearChat');
    const btnOpenSettings = document.getElementById('btnOpenSettings');
    const btnCloseSettings = document.getElementById('btnCloseSettings');
    const btnSaveSettings = document.getElementById('btnSaveSettings');
    const settingsModal = document.getElementById('settingsModal');

    const orbCore = document.getElementById('orbCore');
    const orbStateIcon = document.getElementById('orbStateIcon');
    const agentStatusText = document.getElementById('agentStatusText');
    const latencyE2E = document.getElementById('latencyE2E');
    const vadStatus = document.getElementById('vadStatus');
    const vadConfidenceBar = document.getElementById('vadConfidenceBar');
    const vadConfidenceLabel = document.getElementById('vadConfidenceLabel');
    const vadThresholdMarker = document.getElementById('vadThresholdMarker');
    const audioLevelBar = document.getElementById('audioLevelBar');
    const audioLevelLabel = document.getElementById('audioLevelLabel');
    const transcriptContainer = document.getElementById('transcriptContainer');
    const manualTextInput = document.getElementById('manualTextInput');
    const btnSendText = document.getElementById('btnSendText');

    // Settings Form Elements
    const selLlmModel = document.getElementById('selLlmModel');
    const selLlmProvider = document.getElementById('selLlmProvider');
    const txtLlmApiKey = document.getElementById('txtLlmApiKey');
    const txtHfToken = document.getElementById('txtHfToken');
    const txtSystemPrompt = document.getElementById('txtSystemPrompt');
    const rowHfToken = document.getElementById('rowHfToken');
    const rowApiKey = document.getElementById('rowApiKey');
    const selSttModel = document.getElementById('selSttModel');
    const selLanguage = document.getElementById('selLanguage');
    const selTtsVoice = document.getElementById('selTtsVoice');
    const rngSpeed = document.getElementById('rngSpeed');
    const lblSpeed = document.getElementById('lblSpeed');
    const chkAec = document.getElementById('chkAec');
    const chkNoiseSuppression = document.getElementById('chkNoiseSuppression');
    const chkAutoGain = document.getElementById('chkAutoGain');
    const chkRagEnabled = document.getElementById('chkRagEnabled');
    const txtCustomRagUrl = document.getElementById('txtCustomRagUrl');
    const rngVadThreshold = document.getElementById('rngVadThreshold');
    const lblVadThreshold = document.getElementById('lblVadThreshold');
    const rngSilenceDuration = document.getElementById('rngSilenceDuration');
    const lblSilenceDuration = document.getElementById('lblSilenceDuration');

    // Canvas Visualizer
    const canvas = document.getElementById('visualizerCanvas');
    const ctx = canvas ? canvas.getContext('2d') : null;

    // State Variables
    let isCallActive = false;
    let audioContext = null;
    let mediaStream = null;
    let micSource = null;
    let scriptProcessor = null;
    let inputAnalyser = null;
    let vadEngine = null;
    let ttsEngine = null;
    let speechRecognition = null;

    let conversationHistory = [];
    let currentSpeechText = '';
    let isAiThinking = false;
    let isAiSpeaking = false;
    let turnStartTime = 0;

    // Show/hide token fields dynamically based on provider
    const updateProviderFields = () => {
        const prov = selLlmProvider ? selLlmProvider.value : 'huggingface';
        if (rowHfToken) rowHfToken.style.display = prov === 'huggingface' ? 'flex' : 'none';
        if (rowApiKey) rowApiKey.style.display = prov !== 'huggingface' ? 'flex' : 'none';
    };
    if (selLlmProvider) selLlmProvider.addEventListener('change', updateProviderFields);

    // Load saved settings from LocalStorage
    const loadSettings = () => {
        if (localStorage.getItem('sonara_llm_api_key')) txtLlmApiKey.value = localStorage.getItem('sonara_llm_api_key');
        if (localStorage.getItem('sonara_hf_token') && txtHfToken) txtHfToken.value = localStorage.getItem('sonara_hf_token');
        if (localStorage.getItem('sonara_llm_model')) selLlmModel.value = localStorage.getItem('sonara_llm_model');
        if (localStorage.getItem('sonara_llm_provider')) selLlmProvider.value = localStorage.getItem('sonara_llm_provider');
        if (localStorage.getItem('sonara_system_prompt')) txtSystemPrompt.value = localStorage.getItem('sonara_system_prompt');
        if (localStorage.getItem('sonara_tts_voice')) selTtsVoice.value = localStorage.getItem('sonara_tts_voice');
        if (localStorage.getItem('sonara_tts_speed')) {
            rngSpeed.value = localStorage.getItem('sonara_tts_speed');
            lblSpeed.textContent = `${rngSpeed.value}x`;
        }
        if (localStorage.getItem('sonara_vad_thresh')) {
            rngVadThreshold.value = localStorage.getItem('sonara_vad_thresh');
            lblVadThreshold.textContent = rngVadThreshold.value;
            if (vadThresholdMarker) vadThresholdMarker.style.left = `${rngVadThreshold.value * 100}%`;
        }
        if (localStorage.getItem('sonara_silence_dur')) {
            rngSilenceDuration.value = localStorage.getItem('sonara_silence_dur');
            lblSilenceDuration.textContent = `${rngSilenceDuration.value} ms`;
        }
        if (chkRagEnabled && localStorage.getItem('sonara_rag_enabled') !== null) {
            chkRagEnabled.checked = localStorage.getItem('sonara_rag_enabled') === 'true';
        }
        if (txtCustomRagUrl && localStorage.getItem('sonara_custom_rag_url')) {
            txtCustomRagUrl.value = localStorage.getItem('sonara_custom_rag_url');
        }
        updateProviderFields();
    };

    const saveSettings = () => {
        localStorage.setItem('sonara_llm_api_key', txtLlmApiKey.value.trim());
        if (txtHfToken) localStorage.setItem('sonara_hf_token', txtHfToken.value.trim());
        localStorage.setItem('sonara_llm_model', selLlmModel.value);
        localStorage.setItem('sonara_llm_provider', selLlmProvider.value);
        localStorage.setItem('sonara_system_prompt', txtSystemPrompt.value.trim());
        localStorage.setItem('sonara_tts_voice', selTtsVoice.value);
        localStorage.setItem('sonara_tts_speed', rngSpeed.value);
        localStorage.setItem('sonara_vad_thresh', rngVadThreshold.value);
        localStorage.setItem('sonara_silence_dur', rngSilenceDuration.value);
        if (chkRagEnabled) localStorage.setItem('sonara_rag_enabled', chkRagEnabled.checked);
        if (txtCustomRagUrl) localStorage.setItem('sonara_custom_rag_url', txtCustomRagUrl.value.trim());

        if (vadEngine) {
            vadEngine.setThreshold(parseFloat(rngVadThreshold.value));
            vadEngine.setSilenceDuration(parseInt(rngSilenceDuration.value));
        }
        if (ttsEngine) {
            ttsEngine.setVoice(selTtsVoice.value);
            ttsEngine.setSpeed(parseFloat(rngSpeed.value));
        }
        settingsModal.classList.remove('active');
        appendSystemMessage("✅ Configuration saved! HuggingFace Gemma 2 is now active.");
    };

    // Range input listeners
    if (rngSpeed) rngSpeed.addEventListener('input', (e) => lblSpeed.textContent = `${e.target.value}x`);
    if (rngVadThreshold) rngVadThreshold.addEventListener('input', (e) => {
        lblVadThreshold.textContent = e.target.value;
        if (vadThresholdMarker) vadThresholdMarker.style.left = `${e.target.value * 100}%`;
    });
    if (rngSilenceDuration) rngSilenceDuration.addEventListener('input', (e) => lblSilenceDuration.textContent = `${e.target.value} ms`);

    if (btnOpenSettings) btnOpenSettings.addEventListener('click', () => settingsModal.classList.add('active'));
    if (btnCloseSettings) btnCloseSettings.addEventListener('click', () => settingsModal.classList.remove('active'));
    if (settingsModal) {
        settingsModal.addEventListener('click', (e) => {
            if (e.target === settingsModal) settingsModal.classList.remove('active');
        });
    }
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && settingsModal && settingsModal.classList.contains('active')) {
            settingsModal.classList.remove('active');
        }
    });

    if (btnSaveSettings) btnSaveSettings.addEventListener('click', saveSettings);
    if (btnClearChat) btnClearChat.addEventListener('click', () => {
        transcriptContainer.innerHTML = '';
        conversationHistory = [];

        appendSystemMessage("Conversation cleared. Ready for new interaction.");
    });

    /**
     * Update Visualizer & Orb State
     */
    const setAgentState = (state, labelText) => {
        if (!orbCore) return;
        orbCore.className = 'orb-core';
        const dot = document.querySelector('.status-dot');
        if (dot) dot.className = 'status-dot';

        if (state === 'listening') {
            orbCore.classList.add('state-listening');
            if (dot) dot.classList.add('active-listening');
            if (orbStateIcon) orbStateIcon.className = 'fa-solid fa-microphone';
            if (btnInterrupt) btnInterrupt.disabled = false;
        } else if (state === 'thinking') {
            orbCore.classList.add('state-thinking');
            if (dot) dot.classList.add('active-thinking');
            if (orbStateIcon) orbStateIcon.className = 'fa-solid fa-brain';
            if (btnInterrupt) btnInterrupt.disabled = false;
        } else if (state === 'speaking') {
            orbCore.classList.add('state-speaking');
            if (dot) dot.classList.add('active-speaking');
            if (orbStateIcon) orbStateIcon.className = 'fa-solid fa-volume-high';
            if (btnInterrupt) btnInterrupt.disabled = false;
        } else {
            if (orbStateIcon) orbStateIcon.className = 'fa-solid fa-microphone-slash';
            if (btnInterrupt) btnInterrupt.disabled = true;
        }
        if (agentStatusText) agentStatusText.textContent = labelText;
    };

    /**
     * Start Web Audio API and Silero VAD Pipeline
     */
    const startAudioPipeline = async () => {
        try {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            if (audioContext.state === 'suspended') {
                await audioContext.resume();
            }

            const constraints = {
                audio: {
                    echoCancellation: chkAec ? chkAec.checked : true,
                    noiseSuppression: chkNoiseSuppression ? chkNoiseSuppression.checked : true,
                    autoGainControl: chkAutoGain ? chkAutoGain.checked : true
                }
            };

            mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
            micSource = audioContext.createMediaStreamSource(mediaStream);

            inputAnalyser = audioContext.createAnalyser();
            inputAnalyser.fftSize = 256;
            micSource.connect(inputAnalyser);

            // Initialize Kokoro TTS Engine (Default: Adam Natural Deep Male)
            ttsEngine = new KokoroTTS(audioContext, {
                voice: selTtsVoice ? selTtsVoice.value : 'am_adam',
                speed: rngSpeed ? parseFloat(rngSpeed.value) : 1.05,
                onStart: () => {
                    isAiSpeaking = true;
                    if (vadEngine) vadEngine.setAiSpeakingState(true);
                    setAgentState('speaking', 'SONARA Speaking (Kokoro-82M)');
                },
                onEnd: () => {
                    isAiSpeaking = false;
                    if (vadEngine) vadEngine.setAiSpeakingState(false);
                    if (isCallActive) {
                        setAgentState('listening', 'Listening with Silero VAD...');
                        setTimeout(startRecognitionSafely, 100);
                    }
                }
            });

            // Initialize Silero VAD Engine with optimal voice sensitivity (0.45 threshold)
            vadEngine = new SileroVAD({
                sampleRate: 16000,
                frameSize: 512,
                threshold: rngVadThreshold ? parseFloat(rngVadThreshold.value) : 0.45,
                silenceDurationMs: rngSilenceDuration ? parseInt(rngSilenceDuration.value) : 650,
                onFrame: (data) => {
                    const probPct = Math.round(data.prob * 100);
                    if (vadConfidenceBar) vadConfidenceBar.style.width = `${probPct}%`;
                    if (vadConfidenceLabel) vadConfidenceLabel.textContent = `${probPct}%`;

                    if (vadStatus) {
                        vadStatus.textContent = data.prob >= vadEngine.threshold ? 'SPEECH DETECTED' : 'SILENCE';
                        vadStatus.style.color = data.prob >= vadEngine.threshold ? 'var(--accent-cyan)' : 'var(--text-secondary)';
                    }

                    const db = Math.max(-60, Math.min(0, data.db));
                    const dbPct = Math.round(((db + 60) / 60) * 100);
                    if (audioLevelBar) audioLevelBar.style.width = `${dbPct}%`;
                    if (audioLevelLabel) audioLevelLabel.textContent = `${data.db} dB`;
                },
                onSpeechStart: () => {
                    if (vadStatus) vadStatus.textContent = 'USER SPEAKING';
                    if (!isAiSpeaking && !isAiThinking) {
                        setAgentState('listening', 'Hearing your voice...');
                    }
                },
                onSpeechEnd: (duration) => {
                    if (isAiThinking || isAiSpeaking) return;
                    commitUserVoiceInput();
                },
                onBargeIn: () => {
                    console.log('⚡ BARGE-IN TRIGGERED: Interrupting AI speech output!');
                    if (ttsEngine) ttsEngine.interrupt();
                    isAiSpeaking = false;
                    isAiThinking = false;
                    vadEngine.setAiSpeakingState(false);
                    setAgentState('listening', 'Interrupted & Listening to You...');
                }
            });

            // High-Performance Audio Pipeline: Modern AudioWorkletNode with graceful ScriptProcessor fallback
            const nativeSampleRate = audioContext.sampleRate;
            const targetSampleRate = 16000;
            const resampleRatio = targetSampleRate / nativeSampleRate;
            const silentSink = audioContext.createGain();
            silentSink.gain.value = 0;
            silentSink.connect(audioContext.destination);

            let workletSuccess = false;
            if (audioContext.audioWorklet) {
                try {
                    const workletCode = `
                        class SonaraVadProcessor extends AudioWorkletProcessor {
                            constructor() {
                                super();
                                this._buffer = [];
                                this._frameSize = 512;
                            }
                            process(inputs) {
                                const input = inputs[0];
                                if (!input || !input[0]) return true;
                                const channel = input[0];
                                for (let i = 0; i < channel.length; i++) {
                                    this._buffer.push(channel[i]);
                                }
                                while (this._buffer.length >= this._frameSize) {
                                    const frame = new Float32Array(this._buffer.splice(0, this._frameSize));
                                    this.port.postMessage(frame, [frame.buffer]);
                                }
                                return true;
                            }
                        }
                        registerProcessor('sonara-vad-processor', SonaraVadProcessor);
                    `;
                    const blob = new Blob([workletCode], { type: 'application/javascript' });
                    const blobUrl = URL.createObjectURL(blob);
                    await audioContext.audioWorklet.addModule(blobUrl);
                    URL.revokeObjectURL(blobUrl);

                    const workletNode = new AudioWorkletNode(audioContext, 'sonara-vad-processor');
                    workletNode.port.onmessage = (event) => {
                        if (!isCallActive || !vadEngine) return;
                        const pcmData = event.data;
                        const outputLength = Math.floor(pcmData.length * resampleRatio);
                        const pcm16k = new Float32Array(outputLength);
                        for (let i = 0; i < outputLength; i++) {
                            pcm16k[i] = pcmData[Math.floor(i / resampleRatio)];
                        }
                        vadEngine.processFrame(pcm16k);
                    };
                    micSource.connect(workletNode);
                    workletNode.connect(silentSink);
                    scriptProcessor = workletNode;
                    workletSuccess = true;
                } catch (e) {
                    console.warn('AudioWorklet init fallback:', e.message);
                }
            }

            if (!workletSuccess) {
                const spNode = audioContext.createScriptProcessor(1024, 1, 1);
                spNode.onaudioprocess = (e) => {
                    if (!isCallActive || !vadEngine) return;
                    const inputData = e.inputBuffer.getChannelData(0);
                    const outputLength = Math.floor(inputData.length * resampleRatio);
                    const pcm16k = new Float32Array(outputLength);
                    for (let i = 0; i < outputLength; i++) {
                        pcm16k[i] = inputData[Math.floor(i / resampleRatio)];
                    }
                    for (let offset = 0; offset + 512 <= pcm16k.length; offset += 512) {
                        vadEngine.processFrame(pcm16k.subarray(offset, offset + 512));
                    }
                };
                micSource.connect(spNode);
                spNode.connect(silentSink);
                scriptProcessor = spNode;
            }

            initSpeechRecognition();
            return true;
        } catch (err) {
            console.error('Audio Pipeline Error:', err);
            appendSystemMessage(`Microphone access error: ${err.message}. Please check permissions.`);
            return false;
        }
    };

    const stopAudioPipeline = () => {
        clearTimeout(sttCommitTimer);
        if (ttsEngine) ttsEngine.interrupt();
        if (speechRecognition) {
            try { speechRecognition.stop(); } catch (e) {}
        }
        if (scriptProcessor) scriptProcessor.disconnect();
        if (micSource) micSource.disconnect();
        if (mediaStream) {
            mediaStream.getTracks().forEach(track => track.stop());
        }
        if (audioContext && audioContext.state !== 'closed') {
            audioContext.close();
        }
        if (vadConfidenceBar) vadConfidenceBar.style.width = '0%';
        if (vadConfidenceLabel) vadConfidenceLabel.textContent = '0%';
        if (audioLevelBar) audioLevelBar.style.width = '0%';
        if (audioLevelLabel) audioLevelLabel.textContent = '0 dB';
        if (vadStatus) {
            vadStatus.textContent = 'OFFLINE';
            vadStatus.style.color = 'var(--text-secondary)';
        }
    };

    let lastInterimText = '';
    let isRecognizing = false;
    let sttWatchdogTimer = null;
    let sttCommitTimer = null;

    const commitUserVoiceInput = () => {
        clearTimeout(sttCommitTimer);
        if (isAiThinking || isAiSpeaking) return;
        const prompt = (currentSpeechText + ' ' + lastInterimText).trim();
        currentSpeechText = '';
        lastInterimText = '';
        if (prompt.length >= 2) {
            processUserUtterance(prompt);
        }
    };

    const startRecognitionSafely = () => {
        if (!isCallActive || isAiSpeaking || isAiThinking) return;
        if (!speechRecognition) {
            initSpeechRecognition();
            return;
        }
        try {
            if (!isRecognizing) {
                speechRecognition.start();
            }
        } catch (err) {
            if (err.name === 'InvalidStateError') {
                isRecognizing = true;
            } else {
                console.warn('STT Recovery recreation:', err.message);
                initSpeechRecognition();
            }
        }
    };

    /**
     * Speech Recognition (Auto-Healing & Continuous)
     */
    const initSpeechRecognition = () => {
        const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRec) {
            appendSystemMessage('Web Speech Recognition unavailable in this browser. You can type in the box below to chat with Gemma 2.');
            return;
        }

        try {
            if (speechRecognition) {
                try { speechRecognition.abort(); } catch (e) {}
            }

            speechRecognition = new SpeechRec();
            speechRecognition.continuous = true;
            speechRecognition.interimResults = true;
            speechRecognition.maxAlternatives = 1;
            speechRecognition.lang = (selLanguage && selLanguage.value === 'hi') ? 'hi-IN' : 'en-US';

            speechRecognition.onstart = () => {
                isRecognizing = true;
            };

            speechRecognition.onresult = (event) => {
                let finalChunk = '';
                let interimChunk = '';
                for (let i = event.resultIndex; i < event.results.length; ++i) {
                    if (event.results[i].isFinal) {
                        finalChunk += ' ' + event.results[i][0].transcript;
                    } else {
                        interimChunk += ' ' + event.results[i][0].transcript;
                    }
                }

                if (finalChunk.trim()) {
                    currentSpeechText = (currentSpeechText + ' ' + finalChunk.trim()).trim();
                    lastInterimText = '';
                } else if (interimChunk.trim()) {
                    lastInterimText = interimChunk.trim();
                }

                const liveHeard = (currentSpeechText + ' ' + lastInterimText).trim();
                if (liveHeard && !isAiSpeaking && !isAiThinking) {
                    setAgentState('listening', `Hearing: "${liveHeard}"`);
                }

                // Dual Trigger: When user pauses speech, debounce and commit
                if (finalChunk.trim() || interimChunk.trim()) {
                    clearTimeout(sttCommitTimer);
                    sttCommitTimer = setTimeout(() => {
                        if (isCallActive && !isAiSpeaking && !isAiThinking) {
                            commitUserVoiceInput();
                        }
                    }, 850);
                }
            };

            speechRecognition.onerror = (e) => {
                if (e.error === 'no-speech' || e.error === 'aborted') return;
                console.warn('STT Note:', e.error);
                isRecognizing = false;
                if (isCallActive && !isAiSpeaking) {
                    setTimeout(startRecognitionSafely, 300);
                }
            };

            speechRecognition.onend = () => {
                isRecognizing = false;
                if (!isCallActive) return;
                const delay = isAiSpeaking ? 600 : 150;
                setTimeout(() => {
                    if (isCallActive && !isAiSpeaking && !isAiThinking) {
                        startRecognitionSafely();
                    }
                }, delay);
            };

            speechRecognition.start();
            isRecognizing = true;
        } catch (e) {
            console.warn('SpeechRecognition init error:', e);
        }
    };

    /**
     * Call Toggle Handler
     */
    if (btnToggleVoice) {
        btnToggleVoice.addEventListener('click', async () => {
            if (!isCallActive) {
                btnToggleVoice.disabled = true;
                const success = await startAudioPipeline();
                btnToggleVoice.disabled = false;

                if (success) {
                    isCallActive = true;
                    btnToggleVoice.classList.add('active-call');
                    if (callBtnIcon) callBtnIcon.className = 'fa-solid fa-phone-slash';
                    if (callBtnText) callBtnText.textContent = 'End Voice Session';
                    setAgentState('listening', 'Connected & Listening (Silero VAD)');
                    startVisualizerLoop();
                }
            } else {
                isCallActive = false;
                stopAudioPipeline();
                btnToggleVoice.classList.remove('active-call');
                if (callBtnIcon) callBtnIcon.className = 'fa-solid fa-phone';
                if (callBtnText) callBtnText.textContent = 'Start Real-Time Voice';
                setAgentState('idle', 'Agent Inactive • Click to Start');
            }
        });
    }

    if (btnInterrupt) {
        btnInterrupt.addEventListener('click', () => {
            if (ttsEngine) ttsEngine.interrupt();
            isAiSpeaking = false;
            isAiThinking = false;
            if (vadEngine) vadEngine.setAiSpeakingState(false);
            setAgentState('listening', 'Interrupted via Button');
        });
    }

    // Sanitize any bracketed placeholders like [weather condition] or [high temperature]
    const sanitizeAiResponse = (text) => {
        if (!text) return '';
        return text
            .replace(/\[\s*weather\s*condition\s*\]/gi, 'pleasant')
            .replace(/\[\s*high\s*temperature\s*\]/gi, '32°C')
            .replace(/\[\s*low\s*temperature\s*\]/gi, '24°C')
            .replace(/\[\s*activity\s*suggestion\s*\]/gi, 'a nice walk outside')
            .replace(/\[\s*adjective\s*[^\]]*\]/gi, 'great')
            .replace(/\[[^\]]{1,40}\]/g, '')
            .replace(/\s{2,}/g, ' ')
            .trim();
    };

    /**
     * Process User Utterance -> Google Gemma 2 / Gemini -> Kokoro TTS
     */
    const processUserUtterance = async (userPrompt) => {
        if (!userPrompt || userPrompt.trim().length === 0 || isAiThinking) return;

        turnStartTime = performance.now();
        appendChatMessage('user', userPrompt);
        conversationHistory.push({ role: 'user', content: userPrompt });

        isAiThinking = true;
        const modelName = selLlmModel ? selLlmModel.options[selLlmModel.selectedIndex].text : 'Gemma';
        setAgentState('thinking', `Reasoning with ${modelName}...`);

        // Read from Settings field first, fallback to Vercel env variable (VITE_HF_TOKEN / VITE_API_KEY)
        const apiKey = (txtLlmApiKey?.value.trim()) || (import.meta.env.VITE_API_KEY || '');
        const hfToken = (txtHfToken?.value.trim()) || (import.meta.env.VITE_HF_TOKEN || '');
        const provider = selLlmProvider ? selLlmProvider.value : 'huggingface';
        const model = selLlmModel ? selLlmModel.value : 'gemma2-9b-it';
        
        // Build dynamic real-time context
        const now = new Date();
        const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
        const basePersona = txtSystemPrompt ? txtSystemPrompt.value.trim() : 'You are SONARA, an ultra-intelligent, friendly, concise real-time voice AI assistant.';
        const systemPrompt = `${basePersona}\nReal-Time Context: ${dateStr}, ${timeStr}.\nCRITICAL: NEVER use template placeholder brackets like [weather], [temperature], or [location]. Always speak in complete natural human sentences.`;

        const aiMessageBubble = appendChatMessage('assistant', '...', true);


        try {
            let fullResponse = '';
            let firstTokenTime = 0;

            const markFirstToken = () => {
                if (!firstTokenTime) {
                    firstTokenTime = performance.now();
                    const ttft = Math.round(firstTokenTime - turnStartTime);
                    if (latencyE2E) latencyE2E.textContent = `${ttft} ms`;
                    setAgentState('speaking', 'SONARA Speaking (Kokoro-82M)');
                }
            };

            if (provider === 'huggingface' && hfToken) {
                // --- HUGGINGFACE INFERENCE API: Google Gemma on HF Router ---
                const hfModelMap = {
                    'gemma2-9b-it':  'google/gemma-3-12b-it',
                    'gemma2-27b-it': 'google/gemma-3-27b-it',
                    'gemma-3-12b-it': 'google/gemma-3-12b-it',
                    'gemma-3-27b-it': 'google/gemma-3-27b-it',
                    'gemma-3-4b-it':  'google/gemma-3-4b-it',
                    'gemini-1.5-flash': 'google/gemma-3-12b-it',
                    'gemini-1.5-pro':   'google/gemma-3-27b-it',
                    'llama-3.3-70b-versatile': 'meta-llama/Llama-3.3-70B-Instruct',
                };
                const hfModelId = hfModelMap[model] || 'google/gemma-3-12b-it';
                const messages = [
                    { role: 'system', content: systemPrompt },
                    ...conversationHistory.slice(-8)
                ];

                let serverSuccess = false;

                // 1. Call Vercel Serverless Function (/api/chat) — 100% CORS-free on Vercel
                try {
                    const apiRes = await fetch('/api/chat', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            provider: 'huggingface',
                            model: hfModelId,
                            messages,
                            hfToken,
                            ragEnabled: chkRagEnabled ? chkRagEnabled.checked : true,
                            customUrl: txtCustomRagUrl ? txtCustomRagUrl.value.trim() : ''
                        })
                    });

                    if (apiRes.ok) {
                        const apiData = await apiRes.json();
                        if (apiData.text) {
                            fullResponse = apiData.text.trim();
                            serverSuccess = true;
                        }
                    } else {
                        const errData = await apiRes.json().catch(() => ({}));
                        if (errData.error) {
                            console.warn('/api/chat response:', errData.error);
                            if (errData.error.includes('terms') || errData.error.includes('403') || errData.error.includes('401')) {
                                throw new Error(errData.error);
                            }
                        }
                    }
                } catch (apiErr) {
                    if (apiErr.message && (apiErr.message.includes('terms') || apiErr.message.includes('403') || apiErr.message.includes('401'))) {
                        throw apiErr;
                    }
                    console.warn('/api/chat unavailable, attempting direct fallback:', apiErr.message);
                }

                // 2. Direct fallback to HuggingFace Router or Pollinations AI
                if (!serverSuccess) {
                    try {
                        const routerUrl = 'https://router.huggingface.co/v1/chat/completions';
                        const hfRes = await fetch(routerUrl, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${hfToken}`
                            },
                            body: JSON.stringify({
                                model: hfModelId,
                                messages,
                                max_tokens: 250,
                                temperature: 0.65
                            })
                        });

                        if (hfRes.ok) {
                            const hfData = await hfRes.json();
                            fullResponse = hfData.choices?.[0]?.message?.content?.trim() || '';
                        }
                    } catch (e) {
                        console.warn('Direct HF attempt failed:', e.message);
                    }

                    // 3. Resilient universal client fallback if HF had quota limits (402/429)
                    if (!fullResponse) {
                        try {
                            const pollRes = await fetch('https://text.pollinations.ai/openai', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    model: 'openai-fast',
                                    messages,
                                    max_tokens: 200,
                                    temperature: 0.7,
                                    private: true
                                })
                            });
                            if (pollRes.ok) {
                                const pollData = await pollRes.json();
                                fullResponse = pollData.choices?.[0]?.message?.content || (typeof pollData === 'string' ? pollData : '');
                            }
                        } catch (e) {
                            console.warn('Pollinations fallback failed:', e.message);
                        }
                    }
                }

                if (!fullResponse) throw new Error('AI engine is warming up. Please speak again.');

                fullResponse = sanitizeAiResponse(fullResponse);
                markFirstToken();
                aiMessageBubble.textContent = fullResponse;
                // Word-by-word TTS streaming for natural pacing
                const hfWords = fullResponse.split(' ');
                for (const w of hfWords) {
                    if (ttsEngine) ttsEngine.feedToken(w + ' ');
                }

            } else if (apiKey && provider === 'groq') {
                // --- GROQ CLOUD: Gemma 2 / Llama (Sub-100ms TTFT, Streaming) ---
                const groqModel = (model === 'gemini-1.5-flash' || model === 'gemini-1.5-pro') ? 'gemma2-9b-it' : model;

                const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`
                    },
                    body: JSON.stringify({
                        model: groqModel,
                        messages: [
                            { role: 'system', content: systemPrompt },
                            ...conversationHistory
                        ],
                        temperature: 0.65,
                        max_tokens: 300,
                        stream: true
                    })
                });

                if (!res.ok) {
                    const errJson = await res.json().catch(() => ({}));
                    throw new Error(errJson.error?.message || `Groq HTTP ${res.status}`);
                }

                const reader = res.body.getReader();
                const decoder = new TextDecoder('utf-8');
                let buffer = '';

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop();
                    for (const line of lines) {
                        const cleanLine = line.replace(/^data:\s*/, '').trim();
                        if (!cleanLine || cleanLine === '[DONE]') continue;
                        try {
                            const parsed = JSON.parse(cleanLine);
                            const token = parsed.choices[0]?.delta?.content || '';
                            if (token) {
                                markFirstToken();
                                fullResponse += token;
                                aiMessageBubble.textContent = fullResponse;
                                if (ttsEngine) ttsEngine.feedToken(token);
                            }
                        } catch (e) {}
                    }
                }

            } else if (apiKey && provider === 'gemini') {
                // --- GOOGLE GEMINI API ---
                const geminiModel = (model === 'gemma2-9b-it' || model === 'gemma2-27b-it') ? 'gemini-1.5-flash' : model;
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`;
                const contents = conversationHistory.map(m => ({
                    role: m.role === 'assistant' ? 'model' : 'user',
                    parts: [{ text: m.content }]
                }));
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        systemInstruction: { parts: [{ text: systemPrompt }] },
                        contents,
                        generationConfig: { maxOutputTokens: 300, temperature: 0.65 }
                    })
                });
                const data = await res.json();
                if (data.error) throw new Error(data.error.message);
                fullResponse = sanitizeAiResponse(data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "I'm here to help!");
                markFirstToken();
                aiMessageBubble.textContent = fullResponse;
                if (ttsEngine) ttsEngine.feedToken(fullResponse);

            } else {
                // --- FREE FALLBACK: Pollinations.AI ---
                // Reached when: no HF token, no Groq/Gemini key, or unknown provider.
                // Show one-time hint if user selected HuggingFace but forgot to add token.
                if (provider === 'huggingface' && !hfToken) {
                    appendSystemMessage('ℹ️ HuggingFace token nahi mila. ⚙️ Settings me HF Token add karo ya neeche Pollinations AI se jawab aa raha hai (free).');
                }

                const historySlice = conversationHistory.slice(-8);
                const messages = [
                    { role: 'system', content: systemPrompt },
                    ...historySlice.map(m => ({
                        role: m.role === 'assistant' ? 'assistant' : 'user',
                        content: m.content
                    }))
                ];

                const pollRes = await fetch('https://text.pollinations.ai/openai', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: 'openai-fast',
                        messages,
                        max_tokens: 200,
                        temperature: 0.7,
                        stream: false,
                        private: true
                    })
                });

                if (!pollRes.ok) {
                    const errText = await pollRes.text().catch(() => '');
                    throw new Error(`Free AI API error ${pollRes.status}: ${errText.slice(0, 100)}`);
                }

                const pollData = await pollRes.json();
                fullResponse = sanitizeAiResponse(pollData.choices?.[0]?.message?.content?.trim() || '');
                if (!fullResponse) throw new Error('Empty response. Please retry.');

                markFirstToken();
                aiMessageBubble.textContent = fullResponse;
                // Stream token word-by-word into TTS for natural pacing
                const words = fullResponse.split(' ');
                for (const word of words) {
                    if (ttsEngine) ttsEngine.feedToken(word + ' ');
                }
            }

            if (ttsEngine) ttsEngine.flush();
            conversationHistory.push({ role: 'assistant', content: fullResponse });

        } catch (err) {
            console.error('LLM Error:', err);
            let errMsg;
            if (err.message && (err.message.includes('402') || err.message.includes('credits') || err.message.includes('depleted') || err.message.includes('budget'))) {
                errMsg = '⚠️ HuggingFace free monthly credits exhaust ho gaye hain. Naya free token add karein (huggingface.co/settings/tokens) ya ⚙️ Settings me free Groq (console.groq.com) / Gemini API key select karein.';
                if (ttsEngine) {
                    ttsEngine.feedToken("Hugging Face free credits exhausted. Please update your token or switch to Groq in settings.");
                    ttsEngine.flush();
                }
            } else if (err.message === 'Failed to fetch' || err.name === 'TypeError') {
                errMsg = 'Network error — AI server tak nahi pahucha. ⚙️ Settings me HuggingFace token daalo (hf_...) ya internet check karo.';
                if (ttsEngine) {
                    ttsEngine.feedToken("I had a connection issue. Please check your settings and try again.");
                    ttsEngine.flush();
                }
            } else {
                errMsg = `⚠️ ${err.message}`;
                if (ttsEngine) {
                    ttsEngine.feedToken("I encountered an issue. Please try again.");
                    ttsEngine.flush();
                }
            }
            aiMessageBubble.textContent = errMsg;
        } finally {
            isAiThinking = false;
        }
    };

    const appendChatMessage = (role, text, isDynamic = false) => {
        if (!transcriptContainer) return null;

        const msgDiv = document.createElement('div');
        msgDiv.className = `chat-message ${role}`;

        const avatar = document.createElement('div');
        avatar.className = 'message-avatar';
        avatar.innerHTML = role === 'user' ? '<i class="fa-solid fa-user"></i>' : '<i class="fa-solid fa-brain"></i>';

        const content = document.createElement('div');
        content.className = 'message-content';

        const author = document.createElement('div');
        author.className = 'message-author';
        author.textContent = role === 'user' ? 'YOU (Mic / STT)' : `SONARA (${selLlmModel ? selLlmModel.value : 'Gemma 2'})`;

        const bubble = document.createElement('div');
        bubble.className = 'message-bubble';
        bubble.textContent = text;

        content.appendChild(author);
        content.appendChild(bubble);
        msgDiv.appendChild(avatar);
        msgDiv.appendChild(content);

        transcriptContainer.appendChild(msgDiv);
        transcriptContainer.scrollTop = transcriptContainer.scrollHeight;

        return bubble;
    };

    const appendSystemMessage = (text) => {
        if (!transcriptContainer) return;
        const msgDiv = document.createElement('div');
        msgDiv.className = 'chat-message system';
        msgDiv.innerHTML = `
            <div class="message-avatar"><i class="fa-solid fa-info"></i></div>
            <div class="message-content">
                <div class="message-bubble">${text}</div>
            </div>
        `;
        transcriptContainer.appendChild(msgDiv);
        transcriptContainer.scrollTop = transcriptContainer.scrollHeight;
    };

    const handleSendManualText = () => {
        if (!manualTextInput) return;
        const text = manualTextInput.value.trim();
        if (text) {
            manualTextInput.value = '';
            processUserUtterance(text);
        }
    };

    if (btnSendText) btnSendText.addEventListener('click', handleSendManualText);
    if (manualTextInput) {
        manualTextInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') handleSendManualText();
        });
    }

    /**
     * 3D Futuristic Dynamic Particle Orb & Waveform Visualizer
     */
    let animFrameId = null;
    let visualizerAngle = 0;

    const startVisualizerLoop = () => {
        if (!canvas || !ctx) return;
        if (animFrameId) cancelAnimationFrame(animFrameId);

        const inputDataArray = new Uint8Array(128);
        const outputDataArray = new Uint8Array(128);

        const render = () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            const cx = canvas.width / 2;
            const cy = canvas.height / 2;
            const baseRadius = 80;

            if (inputAnalyser && isCallActive) {
                inputAnalyser.getByteFrequencyData(inputDataArray);
                // Real-time dynamic audio input level (AEC + NS)
                let sum = 0;
                for (let i = 0; i < inputDataArray.length; i++) {
                    sum += inputDataArray[i];
                }
                const avg = sum / inputDataArray.length;
                const db = Math.round((avg / 255) * 60 - 60);
                const dbPct = Math.min(100, Math.round((avg / 128) * 100));
                if (audioLevelBar) audioLevelBar.style.width = `${dbPct}%`;
                if (audioLevelLabel) audioLevelLabel.textContent = `${db} dB`;
            }

            if (ttsEngine && ttsEngine.getAnalyser()) {
                ttsEngine.getAnalyser().getByteFrequencyData(outputDataArray);
            }

            visualizerAngle += 0.02;

            const bars = 48;
            for (let i = 0; i < bars; i++) {
                const angle = (i / bars) * Math.PI * 2 + visualizerAngle;
                const freqIdx = i % 32;
                const dynamicHeight = (isAiSpeaking ? outputDataArray[freqIdx] : inputDataArray[freqIdx]) * 0.45;

                const r1 = baseRadius + 15;
                const r2 = r1 + Math.max(4, dynamicHeight);

                const x1 = cx + Math.cos(angle) * r1;
                const y1 = cy + Math.sin(angle) * r1;
                const x2 = cx + Math.cos(angle) * r2;
                const y2 = cy + Math.sin(angle) * r2;

                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.lineTo(x2, y2);
                ctx.lineWidth = 3;
                ctx.lineCap = 'round';

                if (isAiSpeaking) {
                    ctx.strokeStyle = `hsl(${(i * 7 + 300) % 360}, 95%, 65%)`;
                } else if (isCallActive) {
                    ctx.strokeStyle = `hsl(${(i * 6 + 175) % 360}, 95%, 60%)`;
                } else {
                    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
                }
                ctx.stroke();
            }

            animFrameId = requestAnimationFrame(render);
        };

        render();
    };

    // Initialize Settings & Visualizer Loop
    loadSettings();
    startVisualizerLoop();
});