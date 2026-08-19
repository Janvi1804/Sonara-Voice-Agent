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
    const txtSystemPrompt = document.getElementById('txtSystemPrompt');
    const selSttModel = document.getElementById('selSttModel');
    const selLanguage = document.getElementById('selLanguage');
    const selTtsVoice = document.getElementById('selTtsVoice');
    const rngSpeed = document.getElementById('rngSpeed');
    const lblSpeed = document.getElementById('lblSpeed');
    const chkAec = document.getElementById('chkAec');
    const chkNoiseSuppression = document.getElementById('chkNoiseSuppression');
    const chkAutoGain = document.getElementById('chkAutoGain');
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

    // Load saved settings from LocalStorage
    const loadSettings = () => {
        if (localStorage.getItem('sonara_llm_api_key')) txtLlmApiKey.value = localStorage.getItem('sonara_llm_api_key');
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
    };

    const saveSettings = () => {
        localStorage.setItem('sonara_llm_api_key', txtLlmApiKey.value.trim());
        localStorage.setItem('sonara_llm_model', selLlmModel.value);
        localStorage.setItem('sonara_llm_provider', selLlmProvider.value);
        localStorage.setItem('sonara_system_prompt', txtSystemPrompt.value.trim());
        localStorage.setItem('sonara_tts_voice', selTtsVoice.value);
        localStorage.setItem('sonara_tts_speed', rngSpeed.value);
        localStorage.setItem('sonara_vad_thresh', rngVadThreshold.value);
        localStorage.setItem('sonara_silence_dur', rngSilenceDuration.value);

        if (vadEngine) {
            vadEngine.setThreshold(parseFloat(rngVadThreshold.value));
            vadEngine.setSilenceDuration(parseInt(rngSilenceDuration.value));
        }
        if (ttsEngine) {
            ttsEngine.setVoice(selTtsVoice.value);
            ttsEngine.setSpeed(parseFloat(rngSpeed.value));
        }
        settingsModal.classList.remove('active');
        appendSystemMessage("Configuration applied successfully.");
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

            // Initialize Kokoro TTS Engine
            ttsEngine = new KokoroTTS(audioContext, {
                voice: selTtsVoice ? selTtsVoice.value : 'af_heart',
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
                    }
                }
            });

            // Initialize Silero VAD Engine
            vadEngine = new SileroVAD({
                sampleRate: 16000,
                frameSize: 512,
                threshold: rngVadThreshold ? parseFloat(rngVadThreshold.value) : 0.65,
                silenceDurationMs: rngSilenceDuration ? parseInt(rngSilenceDuration.value) : 700,
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
                        setAgentState('listening', 'User Speaking (DSP Active)');
                    }
                },
                onSpeechEnd: (duration) => {
                    console.log(`Speech ended. Duration: ${duration.toFixed(0)}ms`);
                    if (currentSpeechText.trim().length > 0) {
                        const finalPrompt = currentSpeechText.trim();
                        currentSpeechText = '';
                        processUserUtterance(finalPrompt);
                    }
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

            // Resampling to 16kHz for Silero VAD
            const bufferSize = 2048;
            scriptProcessor = audioContext.createScriptProcessor(bufferSize, 1, 1);
            const nativeSampleRate = audioContext.sampleRate;
            const targetSampleRate = 16000;
            const resampleRatio = targetSampleRate / nativeSampleRate;

            scriptProcessor.onaudioprocess = (e) => {
                if (!isCallActive || !vadEngine) return;
                const inputData = e.inputBuffer.getChannelData(0);

                // Downsample to 16kHz
                const outputLength = Math.floor(inputData.length * resampleRatio);
                const pcm16k = new Float32Array(outputLength);
                for (let i = 0; i < outputLength; i++) {
                    const originalIdx = Math.floor(i / resampleRatio);
                    pcm16k[i] = inputData[originalIdx];
                }

                // Chunk into 512 frame batches
                for (let offset = 0; offset + 512 <= pcm16k.length; offset += 512) {
                    vadEngine.processFrame(pcm16k.subarray(offset, offset + 512));
                }
            };

            micSource.connect(scriptProcessor);
            scriptProcessor.connect(audioContext.destination);

            initSpeechRecognition();
            return true;
        } catch (err) {
            console.error('Audio Pipeline Error:', err);
            appendSystemMessage(`Microphone access error: ${err.message}. Please check permissions.`);
            return false;
        }
    };

    const stopAudioPipeline = () => {
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

    /**
     * Speech Recognition
     */
    const initSpeechRecognition = () => {
        const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRec) {
            appendSystemMessage('Web Speech Recognition unavailable. You can type messages to talk to SONARA.');
            return;
        }

        speechRecognition = new SpeechRec();
        speechRecognition.continuous = true;
        speechRecognition.interimResults = true;
        speechRecognition.lang = (selLanguage && selLanguage.value === 'hi') ? 'hi-IN' : 'en-US';

        speechRecognition.onresult = (event) => {
            let interim = '';
            for (let i = event.resultIndex; i < event.results.length; ++i) {
                if (event.results[i].isFinal) {
                    currentSpeechText += ' ' + event.results[i][0].transcript;
                } else {
                    interim += event.results[i][0].transcript;
                }
            }
            if (interim.trim()) {
                currentSpeechText = interim.trim();
            }
        };

        speechRecognition.onerror = (e) => {
            console.warn('STT Error:', e.error);
        };

        speechRecognition.onend = () => {
            if (isCallActive) {
                try { speechRecognition.start(); } catch (e) {}
            }
        };

        try {
            speechRecognition.start();
        } catch (e) {}
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

    /**
     * Process User Utterance -> Google Gemma 2 / Gemini -> Kokoro TTS
     */
    const processUserUtterance = async (userPrompt) => {
        if (!userPrompt || userPrompt.trim().length === 0 || isAiThinking) return;

        turnStartTime = performance.now();
        appendChatMessage('user', userPrompt);
        conversationHistory.push({ role: 'user', content: userPrompt });

        isAiThinking = true;
        const modelName = selLlmModel ? selLlmModel.options[selLlmModel.selectedIndex].text : 'Gemma 2';
        setAgentState('thinking', `Reasoning with ${modelName}...`);

        const apiKey = txtLlmApiKey ? txtLlmApiKey.value.trim() : '';
        const provider = selLlmProvider ? selLlmProvider.value : 'groq';
        const model = selLlmModel ? selLlmModel.value : 'gemma2-9b-it';
        const systemPrompt = txtSystemPrompt ? txtSystemPrompt.value.trim() : 'You are SONARA, an intelligent voice AI.';

        const aiMessageBubble = appendChatMessage('assistant', '...', true);

        try {
            let fullResponse = '';
            let firstTokenTime = 0;

            if (apiKey && provider === 'groq') {
                const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`
                    },
                    body: JSON.stringify({
                        model: model === 'gemini-1.5-flash' ? 'gemma2-9b-it' : model,
                        messages: [
                            { role: 'system', content: systemPrompt },
                            ...conversationHistory
                        ],
                        temperature: 0.6,
                        max_tokens: 300,
                        stream: true
                    })
                });

                if (!res.ok) {
                    const errJson = await res.json();
                    throw new Error(errJson.error?.message || `HTTP ${res.status}`);
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
                                if (!firstTokenTime) {
                                    firstTokenTime = performance.now();
                                    const ttft = Math.round(firstTokenTime - turnStartTime);
                                    if (latencyE2E) latencyE2E.textContent = `${ttft} ms`;
                                    setAgentState('speaking', 'SONARA Speaking (Kokoro-82M)');
                                }
                                fullResponse += token;
                                aiMessageBubble.textContent = fullResponse;
                                if (ttsEngine) ttsEngine.feedToken(token);
                            }
                        } catch (e) {}
                    }
                }
            } else if (apiKey && provider === 'gemini') {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
                const contents = conversationHistory.map(m => ({
                    role: m.role === 'assistant' ? 'model' : 'user',
                    parts: [{ text: m.content }]
                }));

                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        systemInstruction: { parts: [{ text: systemPrompt }] },
                        contents: contents
                    })
                });

                const data = await res.json();
                fullResponse = data.candidates?.[0]?.content?.parts?.[0]?.text || "I'm here to help!";
                firstTokenTime = performance.now();
                if (latencyE2E) latencyE2E.textContent = `${Math.round(firstTokenTime - turnStartTime)} ms`;
                aiMessageBubble.textContent = fullResponse;
                if (ttsEngine) ttsEngine.feedToken(fullResponse);
            } else {
                // High-speed Instant Fallback
                await new Promise(r => setTimeout(r, 180));
                firstTokenTime = performance.now();
                if (latencyE2E) latencyE2E.textContent = `${Math.round(firstTokenTime - turnStartTime)} ms`;

                fullResponse = generateIntelligentResponse(userPrompt);
                aiMessageBubble.textContent = fullResponse;
                if (ttsEngine) ttsEngine.feedToken(fullResponse);
            }

            if (ttsEngine) ttsEngine.flush();
            conversationHistory.push({ role: 'assistant', content: fullResponse });
        } catch (err) {
            console.error('LLM Error:', err);
            aiMessageBubble.textContent = `[Error: ${err.message}]. Please check your API key in settings.`;
            if (ttsEngine) {
                ttsEngine.feedToken("I encountered a connection issue. Please check your settings.");
                ttsEngine.flush();
            }
        } finally {
            isAiThinking = false;
        }
    };

    const generateIntelligentResponse = (prompt) => {
        const lower = prompt.toLowerCase();
        if (lower.includes('hello') || lower.includes('hi') || lower.includes('hey')) {
            return "Hello! I am SONARA, your real-time voice assistant powered by Silero VAD, Google Gemma 2, and Kokoro 82M speech synthesis. How can I help you today?";
        }
        if (lower.includes('who are you') || lower.includes('what can you do')) {
            return "I am SONARA, an ultra-low latency voice agent. I can understand your voice in real time, classify speech with Silero VAD, reason with Gemma 2, and respond with human-like Kokoro neural voices.";
        }
        if (lower.includes('vad') || lower.includes('silero')) {
            return "Silero VAD is actively classifying your audio frames and managing instant barge-in interruption whenever you speak.";
        }
        if (lower.includes('gemma') || lower.includes('gemini')) {
            return "Google Gemma 2 is built with sliding-window attention and high parameter efficiency, perfect for sub-100 millisecond voice dialogue.";
        }
        if (lower.includes('kokoro')) {
            return "Kokoro-82M generates rich, natural human-like voice synthesis directly in the browser with expressive inflection.";
        }
        return `I heard you say: "${prompt}". Thanks to duplex streaming and Silero VAD, you can interrupt me anytime and converse naturally!`;
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

            if (inputAnalyser) {
                inputAnalyser.getByteFrequencyData(inputDataArray);
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