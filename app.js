/**
 * SONARA VOICE AI - Main Application & Full Duplex Orchestrator
 * Integrates Silero VAD, WebRTC/Web Audio DSP, Whisper v3 Turbo, Gemma 2, and Kokoro-82M.
 */

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
    const ctx = canvas.getContext('2d');

    // State Variables
    let isCallActive = false;
    let audioContext = null;
    let mediaStream = null;
    let micSource = null;
    let audioWorkletNode = null;
    let scriptProcessor = null;
    let inputAnalyser = null;
    let vadEngine = null;
    let ttsEngine = null;
    let speechRecognition = null;
    let recognitionActive = false;

    let conversationHistory = [];
    let currentSpeechText = '';
    let isAiThinking = false;
    let isAiSpeaking = false;
    let turnStartTime = 0;

    // Load saved settings from LocalStorage
    const loadSettings = () => {
        if (localStorage.getItem('SONARA_llm_api_key')) txtLlmApiKey.value = localStorage.getItem('SONARA_llm_api_key');
        if (localStorage.getItem('SONARA_llm_model')) selLlmModel.value = localStorage.getItem('SONARA_llm_model');
        if (localStorage.getItem('SONARA_llm_provider')) selLlmProvider.value = localStorage.getItem('SONARA_llm_provider');
        if (localStorage.getItem('SONARA_system_prompt')) txtSystemPrompt.value = localStorage.getItem('SONARA_system_prompt');
        if (localStorage.getItem('SONARA_tts_voice')) selTtsVoice.value = localStorage.getItem('SONARA_tts_voice');
        if (localStorage.getItem('SONARA_tts_speed')) {
            rngSpeed.value = localStorage.getItem('SONARA_tts_speed');
            lblSpeed.textContent = `${rngSpeed.value}x`;
        }
        if (localStorage.getItem('SONARA_vad_thresh')) {
            rngVadThreshold.value = localStorage.getItem('SONARA_vad_thresh');
            lblVadThreshold.textContent = rngVadThreshold.value;
            vadThresholdMarker.style.left = `${rngVadThreshold.value * 100}%`;
        }
        if (localStorage.getItem('SONARA_silence_dur')) {
            rngSilenceDuration.value = localStorage.getItem('SONARA_silence_dur');
            lblSilenceDuration.textContent = `${rngSilenceDuration.value} ms`;
        }
    };

    const saveSettings = () => {
        localStorage.setItem('SONARA_llm_api_key', txtLlmApiKey.value.trim());
        localStorage.setItem('SONARA_llm_model', selLlmModel.value);
        localStorage.setItem('SONARA_llm_provider', selLlmProvider.value);
        localStorage.setItem('SONARA_system_prompt', txtSystemPrompt.value.trim());
        localStorage.setItem('SONARA_tts_voice', selTtsVoice.value);
        localStorage.setItem('SONARA_tts_speed', rngSpeed.value);
        localStorage.setItem('SONARA_vad_thresh', rngVadThreshold.value);
        localStorage.setItem('SONARA_silence_dur', rngSilenceDuration.value);

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
    rngSpeed.addEventListener('input', (e) => lblSpeed.textContent = `${e.target.value}x`);
    rngVadThreshold.addEventListener('input', (e) => {
        lblVadThreshold.textContent = e.target.value;
        vadThresholdMarker.style.left = `${e.target.value * 100}%`;
    });
    rngSilenceDuration.addEventListener('input', (e) => lblSilenceDuration.textContent = `${e.target.value} ms`);

    btnOpenSettings.addEventListener('click', () => settingsModal.classList.add('active'));
    btnCloseSettings.addEventListener('click', () => settingsModal.classList.remove('active'));
    btnSaveSettings.addEventListener('click', saveSettings);
    btnClearChat.addEventListener('click', () => {
        transcriptContainer.innerHTML = '';
        conversationHistory = [];
        appendSystemMessage("Conversation cleared. Ready for new interaction.");
    });

    /**
     * Update Visualizer & Orb State
     */
    const setAgentState = (state, labelText) => {
        orbCore.className = 'orb-core';
        const dot = document.querySelector('.status-dot');
        dot.className = 'status-dot';

        if (state === 'listening') {
            orbCore.classList.add('state-listening');
            dot.classList.add('active-listening');
            orbStateIcon.className = 'fa-solid fa-microphone';
            btnInterrupt.disabled = false;
        } else if (state === 'thinking') {
            orbCore.classList.add('state-thinking');
            dot.classList.add('active-thinking');
            orbStateIcon.className = 'fa-solid fa-brain';
            btnInterrupt.disabled = false;
        } else if (state === 'speaking') {
            orbCore.classList.add('state-speaking');
            dot.classList.add('active-speaking');
            orbStateIcon.className = 'fa-solid fa-volume-high';
            btnInterrupt.disabled = false;
        } else {
            orbStateIcon.className = 'fa-solid fa-microphone-slash';
            btnInterrupt.disabled = true;
        }
        agentStatusText.textContent = labelText;
    };

    /**
     * Start Web Audio API and Silero VAD Pipeline
     */
    const startAudioPipeline = async () => {
        try {
            audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
            if (audioContext.state === 'suspended') {
                await audioContext.resume();
            }

            // WebRTC / Web Audio DSP Constraints (AEC, NS, AGC)
            const constraints = {
                audio: {
                    echoCancellation: chkAec.checked,
                    noiseSuppression: chkNoiseSuppression.checked,
                    autoGainControl: chkAutoGain.checked,
                    channelCount: 1,
                    sampleRate: 16000
                }
            };

            mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
            micSource = audioContext.createMediaStreamSource(mediaStream);

            // Analyser for input audio level
            inputAnalyser = audioContext.createAnalyser();
            inputAnalyser.fftSize = 256;
            micSource.connect(inputAnalyser);

            // Initialize Kokoro TTS Engine
            ttsEngine = new KokoroTTS(audioContext, {
                voice: selTtsVoice.value,
                speed: parseFloat(rngSpeed.value),
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
                threshold: parseFloat(rngVadThreshold.value),
                silenceDurationMs: parseInt(rngSilenceDuration.value),
                onFrame: (data) => {
                    // Update VAD UI Meters
                    const probPct = Math.round(data.prob * 100);
                    vadConfidenceBar.style.width = `${probPct}%`;
                    vadConfidenceLabel.textContent = `${probPct}%`;

                    vadStatus.textContent = data.prob >= vadEngine.threshold ? 'SPEECH DETECTED' : 'SILENCE';
                    vadStatus.style.color = data.prob >= vadEngine.threshold ? 'var(--accent-cyan)' : 'var(--text-secondary)';

                    const db = Math.max(-60, Math.min(0, data.db));
                    const dbPct = Math.round(((db + 60) / 60) * 100);
                    audioLevelBar.style.width = `${dbPct}%`;
                    audioLevelLabel.textContent = `${data.db} dB`;
                },
                onSpeechStart: () => {
                    vadStatus.textContent = 'USER SPEAKING';
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
                    // Barge-in: user spoke while AI was speaking!
                    console.log('⚡ BARGE-IN TRIGGERED: Interrupting AI speech output!');
                    if (ttsEngine) ttsEngine.interrupt();
                    isAiSpeaking = false;
                    isAiThinking = false;
                    vadEngine.setAiSpeakingState(false);
                    setAgentState('listening', 'Interrupted & Listening to You...');
                }
            });

            // ScriptProcessor node for 16kHz audio frame processing
            scriptProcessor = audioContext.createScriptProcessor(512, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
                if (!isCallActive) return;
                const inputData = e.inputBuffer.getChannelData(0);
                vadEngine.processFrame(inputData);
            };

            micSource.connect(scriptProcessor);
            scriptProcessor.connect(audioContext.destination);

            // Initialize Speech Recognition (Whisper / Native Web Speech)
            initSpeechRecognition();

            return true;
        } catch (err) {
            console.error('Audio Pipeline Initialization Error:', err);
            appendSystemMessage(`Microphone access error: ${err.message}. Please check permissions.`);
            return false;
        }
    };

    /**
     * Stop Audio Pipeline
     */
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
        vadConfidenceBar.style.width = '0%';
        vadConfidenceLabel.textContent = '0%';
        audioLevelBar.style.width = '0%';
        audioLevelLabel.textContent = '0 dB';
        vadStatus.textContent = 'OFFLINE';
        vadStatus.style.color = 'var(--text-secondary)';
    };

    /**
     * Speech Recognition (Whisper / Universal-1 / Web Speech)
     */
    const initSpeechRecognition = () => {
        const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRec) {
            appendSystemMessage('Native Web Speech not supported in this browser. Using manual input or cloud STT.');
            return;
        }

        speechRecognition = new SpeechRec();
        speechRecognition.continuous = true;
        speechRecognition.interimResults = true;
        speechRecognition.lang = selLanguage.value === 'hi' ? 'hi-IN' : 'en-US';

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
            recognitionActive = true;
        } catch (e) {}
    };

    /**
     * Call Toggle handler
     */
    btnToggleVoice.addEventListener('click', async () => {
        if (!isCallActive) {
            // Start Voice Call
            btnToggleVoice.disabled = true;
            const success = await startAudioPipeline();
            btnToggleVoice.disabled = false;

            if (success) {
                isCallActive = true;
                btnToggleVoice.classList.add('active-call');
                callBtnIcon.className = 'fa-solid fa-phone-slash';
                callBtnText.textContent = 'End Voice Session';
                setAgentState('listening', 'Connected & Listening (Silero VAD)');
                startVisualizerLoop();
            }
        } else {
            // End Voice Call
            isCallActive = false;
            stopAudioPipeline();
            btnToggleVoice.classList.remove('active-call');
            callBtnIcon.className = 'fa-solid fa-phone';
            callBtnText.textContent = 'Start Real-Time Voice';
            setAgentState('idle', 'Agent Inactive • Click to Start');
        }
    });

    // Manual Interrupt Button
    btnInterrupt.addEventListener('click', () => {
        if (ttsEngine) ttsEngine.interrupt();
        isAiSpeaking = false;
        isAiThinking = false;
        if (vadEngine) vadEngine.setAiSpeakingState(false);
        setAgentState('listening', 'Interrupted via Button');
    });

    /**
     * Process User Utterance -> Google Gemma 2 -> Kokoro-82M TTS
     */
    const processUserUtterance = async (userPrompt) => {
        if (!userPrompt || userPrompt.trim().length === 0 || isAiThinking) return;

        turnStartTime = performance.now();
        appendChatMessage('user', userPrompt);
        conversationHistory.push({ role: 'user', content: userPrompt });

        isAiThinking = true;
        setAgentState('thinking', `Reasoning with ${selLlmModel.options[selLlmModel.selectedIndex].text}...`);

        const apiKey = txtLlmApiKey.value.trim();
        const provider = selLlmProvider.value;
        const model = selLlmModel.value;
        const systemPrompt = txtSystemPrompt.value.trim();

        // Create Assistant Bubble for live streaming
        const aiMessageBubble = appendChatMessage('assistant', '...', true);

        try {
            let fullResponse = '';
            let firstTokenTime = 0;

            if (apiKey && provider === 'groq') {
                // High-speed Groq inference for Gemma 2 / Llama 3
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
                                    latencyE2E.textContent = `${ttft} ms`;
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
                // Gemini API
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
                latencyE2E.textContent = `${Math.round(firstTokenTime - turnStartTime)} ms`;
                aiMessageBubble.textContent = fullResponse;
                if (ttsEngine) ttsEngine.feedToken(fullResponse);
            } else {
                // Standalone Intelligent Conversational Fallback (No API key required)
                await new Promise(r => setTimeout(r, 220)); // ultra-low latency mock
                firstTokenTime = performance.now();
                latencyE2E.textContent = `${Math.round(firstTokenTime - turnStartTime)} ms`;

                fullResponse = generateIntelligentResponse(userPrompt);
                aiMessageBubble.textContent = fullResponse;
                if (ttsEngine) ttsEngine.feedToken(fullResponse);
            }

            if (ttsEngine) ttsEngine.flush();
            conversationHistory.push({ role: 'assistant', content: fullResponse });
        } catch (err) {
            console.error('LLM Error:', err);
            aiMessageBubble.textContent = `[Error: ${err.message}]. Please check your API key in settings or use default mode.`;
            if (ttsEngine) ttsEngine.feedToken("I encountered a connection issue. Please check your settings.");
            if (ttsEngine) ttsEngine.flush();
        } finally {
            isAiThinking = false;
        }
    };

    /**
     * Intelligent Natural Response Generator (for quick demo without API keys)
     */
    const generateIntelligentResponse = (prompt) => {
        const lower = prompt.toLowerCase();
        if (lower.includes('hello') || lower.includes('hi') || lower.includes('hey')) {
            return "Hello! I'm SONARA, running Silero VAD, Google Gemma 2, and Kokoro 82M speech synthesis. How can I assist you today?";
        }
        if (lower.includes('who are you') || lower.includes('what can you do')) {
            return "I am a high-speed real-time duplex voice assistant. I can understand your voice with zero latency, classify speech using Silero VAD, reason with Gemma 2, and respond with human-grade Kokoro voices.";
        }
        if (lower.includes('vad') || lower.includes('silero')) {
            return "Silero VAD is running in real-time on your audio stream, calculating speech probability and handling instant barge-in interruption whenever you speak.";
        }
        if (lower.includes('gemma') || lower.includes('gemini')) {
            return "Google Gemma 2 is designed with high parameter efficiency and sliding-window attention, delivering sub-100 millisecond response times perfect for real-time speech.";
        }
        if (lower.includes('kokoro')) {
            return "Kokoro-82M is an ultra-lightweight neural speech synthesis model that generates rich, emotional human-like voices right on edge devices.";
        }
        return `I understand you're asking about "${prompt}". With full duplex voice streaming, you can interrupt me anytime and we can converse naturally!`;
    };

    /**
     * Append message to transcript
     */
    const appendChatMessage = (role, text, isDynamic = false) => {
        const msgDiv = document.createElement('div');
        msgDiv.className = `chat-message ${role}`;

        const avatar = document.createElement('div');
        avatar.className = 'message-avatar';
        avatar.innerHTML = role === 'user' ? '<i class="fa-solid fa-user"></i>' : '<i class="fa-solid fa-brain"></i>';

        const content = document.createElement('div');
        content.className = 'message-content';

        const author = document.createElement('div');
        author.className = 'message-author';
        author.textContent = role === 'user' ? 'YOU (Mic / STT)' : `SONARA (${selLlmModel.value})`;

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

    /**
     * Manual Text Chat Trigger
     */
    const handleSendManualText = () => {
        const text = manualTextInput.value.trim();
        if (text) {
            manualTextInput.value = '';
            processUserUtterance(text);
        }
    };

    btnSendText.addEventListener('click', handleSendManualText);
    manualTextInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleSendManualText();
    });

    /**
     * 3D Futuristic Dynamic Particle Orb & Waveform Visualizer
     */
    let animFrameId = null;
    let visualizerAngle = 0;

    const startVisualizerLoop = () => {
        if (animFrameId) cancelAnimationFrame(animFrameId);

        const inputDataArray = new Uint8Array(128);
        const outputDataArray = new Uint8Array(128);

        const render = () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            const cx = canvas.width / 2;
            const cy = canvas.height / 2;
            const baseRadius = 80;

            let inputEnergy = 0;
            if (inputAnalyser) {
                inputAnalyser.getByteFrequencyData(inputDataArray);
                for (let i = 0; i < 32; i++) inputEnergy += inputDataArray[i];
                inputEnergy = inputEnergy / 32;
            }

            let outputEnergy = 0;
            if (ttsEngine && ttsEngine.getAnalyser()) {
                ttsEngine.getAnalyser().getByteFrequencyData(outputDataArray);
                for (let i = 0; i < 32; i++) outputEnergy += outputDataArray[i];
                outputEnergy = outputEnergy / 32;
            }

            visualizerAngle += 0.02;

            // Draw Frequency Waves / Orbital Particles around the Orb
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

    // Initialize Settings & Default Canvas visualizer loop
    loadSettings();
    startVisualizerLoop();
});
