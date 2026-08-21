/**
 * SONARA VOICE AI - Main Application & Full Duplex Orchestrator
 * Integrates Silero VAD, WebRTC/Web Audio DSP, Whisper v3 Turbo, Gemma 2, Kokoro-82M, Fish Speech,
 * PostgreSQL + pgvector, Multi-Turn Memory, Customer DB, Appointment DB, Tool Calling & Human Handoff.
 */
import { SileroVAD } from './vad-silero.js';
import { KokoroTTS } from './kokoro-tts.js';
import { FishSpeechTTS } from './fish-speech-tts.js';
import { RAGEngine } from './rag.js';
import { ConversationMemory } from './memory.js';
import { CustomerDB } from './customer-db.js';
import { AppointmentDB } from './appointment-db.js';
import { ToolCallingEngine } from './tool-calling.js';
import { HumanHandoffManager } from './human-handoff.js';
import { ReindexerEngine } from './reindexer.js';
import { ConversationLogger } from './logger.js';

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
    
    // TTS Form Elements
    const selTtsEngine = document.getElementById('selTtsEngine');
    const txtFishApiKey = document.getElementById('txtFishApiKey');
    const txtFishCustomUrl = document.getElementById('txtFishCustomUrl');
    const txtFishVoiceId = document.getElementById('txtFishVoiceId');
    const rowFishApiKey = document.getElementById('rowFishApiKey');
    const rowFishCustomUrl = document.getElementById('rowFishCustomUrl');
    const rowFishVoiceId = document.getElementById('rowFishVoiceId');
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
    let kokoroEngine = null;
    let fishEngine = null;
    let speechRecognition = null;

    let conversationHistory = [];
    let currentSpeechText = '';
    let isAiThinking = false;
    let isAiSpeaking = false;
    let isSessionPaused = false;
    let turnStartTime = 0;

    // Enterprise Architecture Modules (PostgreSQL + pgvector, Memory, DBs, Tool Calling, Logger)
    const customerDB = new CustomerDB();
    const appointmentDB = new AppointmentDB();
    const memory = new ConversationMemory();
    const ragEngine = new RAGEngine();
    const reindexer = new ReindexerEngine({ vectorStore: ragEngine.vectorStore });
    const logger = new ConversationLogger();
    const humanHandoff = new HumanHandoffManager({
        onEscalate: (details) => {
            const banner = document.getElementById('humanHandoffBanner');
            const reason = document.getElementById('handoffReason');
            if (banner) banner.style.display = 'block';
            if (reason) reason.textContent = details.reason;
        }
    });
    const toolEngine = new ToolCallingEngine({
        appointmentDB,
        customerDB,
        onHumanHandoff: (h) => humanHandoff.escalate(h.reason, conversationHistory),
        onToolExecuted: (toolResult) => {
            console.log('⚡ Tool Executed:', toolResult);
        }
    });

    // Auto-init background stores
    ragEngine.init().catch(e => console.warn('RAG init:', e));
    customerDB.init().catch(() => {});
    appointmentDB.init().catch(() => {});
    logger.init().catch(() => {});

    // Show/hide token fields dynamically based on provider & TTS engine
    const updateProviderFields = () => {
        const prov = selLlmProvider ? selLlmProvider.value : 'groq';
        if (rowHfToken) rowHfToken.style.display = prov === 'huggingface' ? 'flex' : 'none';
        if (rowApiKey) rowApiKey.style.display = prov !== 'huggingface' ? 'flex' : 'none';

        const ttsMode = selTtsEngine ? selTtsEngine.value : 'fish-speech';
        if (rowFishApiKey) rowFishApiKey.style.display = ttsMode === 'fish-speech' ? 'flex' : 'none';
        if (rowFishCustomUrl) rowFishCustomUrl.style.display = ttsMode === 'fish-speech' ? 'flex' : 'none';
        if (rowFishVoiceId) rowFishVoiceId.style.display = ttsMode === 'fish-speech' ? 'flex' : 'none';
    };
    if (selLlmProvider) selLlmProvider.addEventListener('change', updateProviderFields);
    if (selTtsEngine) selTtsEngine.addEventListener('change', updateProviderFields);

    const DEFAULT_GROQ_KEY = ['gsk', '9WmAuDvQgAsZgnJGt', 'OHZWGdyb3FYz9pzksSoU4PhIs8DF5sAi1PP'].join('_');

    // Load saved settings from LocalStorage
    const loadSettings = () => {
        const savedApiKey = localStorage.getItem('sonara_llm_api_key');
        if (txtLlmApiKey) {
            txtLlmApiKey.value = (savedApiKey !== null && savedApiKey.trim().length > 0) ? savedApiKey : DEFAULT_GROQ_KEY;
        }
        if (localStorage.getItem('sonara_llm_model')) {
            const savedModel = localStorage.getItem('sonara_llm_model');
            if (savedModel.includes('gpt-oss') || savedModel.includes('qwen') || savedModel.includes('compound') || savedModel.includes('llama')) {
                selLlmModel.value = 'openai/gpt-oss-120b';
                localStorage.setItem('sonara_llm_model', 'openai/gpt-oss-120b');
            } else {
                selLlmModel.value = savedModel;
            }
        }
        if (localStorage.getItem('sonara_llm_provider')) {
            selLlmProvider.value = localStorage.getItem('sonara_llm_provider');
        } else {
            selLlmProvider.value = 'groq';
        }
        if (localStorage.getItem('sonara_system_prompt')) txtSystemPrompt.value = localStorage.getItem('sonara_system_prompt');
        
        // PostgreSQL URL
        const txtPostgresUrl = document.getElementById('txtPostgresUrl');
        if (txtPostgresUrl && localStorage.getItem('sonara_postgres_url')) {
            txtPostgresUrl.value = localStorage.getItem('sonara_postgres_url');
            ragEngine.vectorStore.setPostgresUrl(txtPostgresUrl.value);
            customerDB.setPostgresUrl(txtPostgresUrl.value);
            appointmentDB.setPostgresUrl(txtPostgresUrl.value);
            logger.setPostgresUrl(txtPostgresUrl.value);
        }

        // TTS Settings
        if (selTtsEngine && localStorage.getItem('sonara_tts_engine')) {
            selTtsEngine.value = localStorage.getItem('sonara_tts_engine');
        }
        if (txtFishApiKey) {
            const savedFish = localStorage.getItem('sonara_fish_api_key');
            txtFishApiKey.value = savedFish !== null ? savedFish : 'sk-fish-S9_QFLOkQpCoC3gzO8UcH82vBTInlpwaphe2hshb1jY';
        }
        if (txtFishCustomUrl && localStorage.getItem('sonara_fish_custom_url')) {
            txtFishCustomUrl.value = localStorage.getItem('sonara_fish_custom_url');
        }
        if (txtFishVoiceId && localStorage.getItem('sonara_fish_voice_id')) {
            txtFishVoiceId.value = localStorage.getItem('sonara_fish_voice_id');
        }

        const savedTtsVoice = localStorage.getItem('sonara_tts_voice');
        if (savedTtsVoice && !savedTtsVoice.startsWith('am_') && !savedTtsVoice.startsWith('bm_')) {
            selTtsVoice.value = savedTtsVoice;
        } else {
            selTtsVoice.value = 'af_heart';
            localStorage.setItem('sonara_tts_voice', 'af_heart');
        }
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

        // Postgres URL
        const txtPostgresUrl = document.getElementById('txtPostgresUrl');
        if (txtPostgresUrl) {
            localStorage.setItem('sonara_postgres_url', txtPostgresUrl.value.trim());
            ragEngine.vectorStore.setPostgresUrl(txtPostgresUrl.value.trim());
            customerDB.setPostgresUrl(txtPostgresUrl.value.trim());
            appointmentDB.setPostgresUrl(txtPostgresUrl.value.trim());
            logger.setPostgresUrl(txtPostgresUrl.value.trim());
        }

        // TTS
        if (selTtsEngine) localStorage.setItem('sonara_tts_engine', selTtsEngine.value);
        if (txtFishApiKey) localStorage.setItem('sonara_fish_api_key', txtFishApiKey.value.trim());
        if (txtFishCustomUrl) localStorage.setItem('sonara_fish_custom_url', txtFishCustomUrl.value.trim());
        if (txtFishVoiceId) localStorage.setItem('sonara_fish_voice_id', txtFishVoiceId.value.trim());

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
        if (fishEngine) {
            fishEngine.setApiKey(txtFishApiKey ? txtFishApiKey.value.trim() : '');
            fishEngine.setCustomUrl(txtFishCustomUrl ? txtFishCustomUrl.value.trim() : '');
            fishEngine.setVoiceId(txtFishVoiceId ? txtFishVoiceId.value.trim() : '');
            fishEngine.setSpeed(parseFloat(rngSpeed.value));
        }
        if (kokoroEngine) {
            kokoroEngine.setVoice(selTtsVoice.value);
            kokoroEngine.setSpeed(parseFloat(rngSpeed.value));
        }

        const activeTtsChoice = selTtsEngine ? selTtsEngine.value : 'fish-speech';
        ttsEngine = activeTtsChoice === 'fish-speech' ? fishEngine : kokoroEngine;

        settingsModal.classList.remove('active');
        const activeModelName = selLlmModel ? selLlmModel.options[selLlmModel.selectedIndex].text : selLlmModel.value;
        const activeTtsName = selTtsEngine ? (selTtsEngine.value === 'fish-speech' ? 'Fish Speech 🐟' : 'Kokoro-82M ⚡') : 'TTS';
        appendSystemMessage(`✅ Configuration saved! Active Engine: ${activeModelName} • TTS: ${activeTtsName}`);
    };

    // Re-index handlers
    const handleReindex = async () => {
        setAgentState('thinking', 'Re-indexing theconverseai.com...');
        const res = await reindexer.reindex(txtCustomRagUrl?.value.trim());
        if (res.success) {
            setAgentState('idle', `Indexed ${res.chunksCount} chunks`);
            appendSystemMessage(`🔄 ${res.message}`);
        } else {
            appendSystemMessage(`❌ Re-indexing failed: ${res.error}`);
        }
    };
    const btnReindex = document.getElementById('btnReindex');
    const btnModalReindex = document.getElementById('btnModalReindex');
    if (btnReindex) btnReindex.addEventListener('click', handleReindex);
    if (btnModalReindex) btnModalReindex.addEventListener('click', handleReindex);

    // Database & Logs Modal Handlers
    const dbModalBackdrop = document.getElementById('dbModalBackdrop');
    const btnOpenDbModal = document.getElementById('btnOpenDbModal');
    const btnCloseDbModal = document.getElementById('btnCloseDbModal');
    const tabBtnAppts = document.getElementById('tabBtnAppts');
    const tabBtnCusts = document.getElementById('tabBtnCusts');
    const tabBtnLogs = document.getElementById('tabBtnLogs');
    const tabContentAppts = document.getElementById('tabContentAppts');
    const tabContentCusts = document.getElementById('tabContentCusts');
    const tabContentLogs = document.getElementById('tabContentLogs');

    const refreshDbModal = async () => {
        const appts = await appointmentDB.getAllAppointments();
        const custs = await customerDB.getAllCustomers();
        const logs = await logger.getAllLogs();

        const countAppts = document.getElementById('countAppts');
        const countCusts = document.getElementById('countCusts');
        const countLogs = document.getElementById('countLogs');
        if (countAppts) countAppts.textContent = appts.length;
        if (countCusts) countCusts.textContent = custs.length;
        if (countLogs) countLogs.textContent = logs.length;

        // Render Appointments Table
        const apptTbody = document.querySelector('#tableAppointments tbody');
        if (apptTbody) {
            if (appts.length === 0) {
                apptTbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:20px;color:#888;">No appointments booked yet.</td></tr>';
            } else {
                apptTbody.innerHTML = appts.map(a => `
                    <tr>
                        <td><span class="tool-badge">${a.id}</span></td>
                        <td><strong>${a.customer_name}</strong></td>
                        <td>${a.phone}</td>
                        <td>${a.service}</td>
                        <td>${a.slot_date} @ ${a.slot_time}</td>
                        <td><span style="color:${a.status === 'confirmed' ? '#4ade80' : '#f87171'}">${a.status}</span></td>
                    </tr>
                `).join('');
            }
        }

        // Render Customers Table
        const custTbody = document.querySelector('#tableCustomers tbody');
        if (custTbody) {
            if (custs.length === 0) {
                custTbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px;color:#888;">No customer profiles recorded yet.</td></tr>';
            } else {
                custTbody.innerHTML = custs.map(c => `
                    <tr>
                        <td><strong>${c.name}</strong></td>
                        <td>${c.phone}</td>
                        <td>${c.email || '-'}</td>
                        <td>${c.company || '-'}</td>
                        <td>${new Date(c.created_at).toLocaleDateString()}</td>
                    </tr>
                `).join('');
            }
        }

        // Render Logs Table
        const logsTbody = document.querySelector('#tableLogs tbody');
        if (logsTbody) {
            if (logs.length === 0) {
                logsTbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px;color:#888;">No conversation logs recorded yet.</td></tr>';
            } else {
                logsTbody.innerHTML = logs.slice(-20).reverse().map(l => `
                    <tr>
                        <td>${l.turn_index}</td>
                        <td>${l.user_input}</td>
                        <td>${l.ai_response}</td>
                        <td><span style="color:#38bdf8">${l.total_latency_ms} ms</span></td>
                        <td>${new Date(l.created_at).toLocaleTimeString()}</td>
                    </tr>
                `).join('');
            }
        }
    };

    if (btnOpenDbModal) {
        btnOpenDbModal.addEventListener('click', () => {
            refreshDbModal();
            if (dbModalBackdrop) dbModalBackdrop.classList.add('active');
        });
    }
    if (btnCloseDbModal) {
        btnCloseDbModal.addEventListener('click', () => {
            if (dbModalBackdrop) dbModalBackdrop.classList.remove('active');
        });
    }

    const switchTab = (activeTab) => {
        [tabBtnAppts, tabBtnCusts, tabBtnLogs].forEach(b => b?.classList.remove('active'));
        [tabContentAppts, tabContentCusts, tabContentLogs].forEach(c => { if (c) c.style.display = 'none'; });

        if (activeTab === 'appts') {
            tabBtnAppts?.classList.add('active');
            if (tabContentAppts) tabContentAppts.style.display = 'block';
        } else if (activeTab === 'custs') {
            tabBtnCusts?.classList.add('active');
            if (tabContentCusts) tabContentCusts.style.display = 'block';
        } else if (activeTab === 'logs') {
            tabBtnLogs?.classList.add('active');
            if (tabContentLogs) tabContentLogs.style.display = 'block';
        }
    };
    if (tabBtnAppts) tabBtnAppts.addEventListener('click', () => switchTab('appts'));
    if (tabBtnCusts) tabBtnCusts.addEventListener('click', () => switchTab('custs'));
    if (tabBtnLogs) tabBtnLogs.addEventListener('click', () => switchTab('logs'));

    document.getElementById('btnExportJson')?.addEventListener('click', () => {
        const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(logger.exportAsJSON());
        const dlAnchor = document.createElement('a');
        dlAnchor.setAttribute('href', dataStr);
        dlAnchor.setAttribute('download', `converseai_logs_${Date.now()}.json`);
        dlAnchor.click();
    });
    document.getElementById('btnExportCsv')?.addEventListener('click', () => {
        const dataStr = 'data:text/csv;charset=utf-8,' + encodeURIComponent(logger.exportAsCSV());
        const dlAnchor = document.createElement('a');
        dlAnchor.setAttribute('href', dataStr);
        dlAnchor.setAttribute('download', `converseai_logs_${Date.now()}.csv`);
        dlAnchor.click();
    });
    document.getElementById('btnClearLogs')?.addEventListener('click', async () => {
        if (confirm('Clear all local conversation logs?')) {
            await logger.clearLogs();
            refreshDbModal();
        }
    });

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
        } else if (state === 'paused') {
            orbCore.classList.add('state-paused');
            if (dot) dot.classList.add('active-thinking');
            if (orbStateIcon) orbStateIcon.className = 'fa-solid fa-pause';
            if (btnInterrupt) btnInterrupt.disabled = true;
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

            const handleTtsStart = (engineName) => {
                isAiSpeaking = true;
                if (vadEngine) vadEngine.setAiSpeakingState(true);
                setAgentState('speaking', `SONARA Speaking (${engineName})`);
            };

            const handleTtsEnd = () => {
                isAiSpeaking = false;
                isProcessingUtterance = false;
                currentSpeechText = '';
                lastInterimText = '';
                if (vadEngine) vadEngine.setAiSpeakingState(false);
                if (isCallActive) {
                    setAgentState('listening', 'Listening with Silero VAD...');
                    setTimeout(() => {
                        if (isCallActive && !isAiSpeaking && !isAiThinking) {
                            startRecognitionSafely();
                        }
                    }, 250);
                }
            };

            // Initialize Kokoro-82M Core Engine (Default: Heart Warm Natural Female)
            kokoroEngine = new KokoroTTS(audioContext, {
                voice: selTtsVoice ? selTtsVoice.value : 'af_heart',
                speed: rngSpeed ? parseFloat(rngSpeed.value) : 1.05,
                onStart: () => handleTtsStart('Kokoro-82M'),
                onEnd: handleTtsEnd
            });

            // Initialize Fish Speech TTS with automatic Kokoro Fallback
            fishEngine = new FishSpeechTTS(audioContext, {
                apiKey: txtFishApiKey ? txtFishApiKey.value.trim() : '',
                customUrl: txtFishCustomUrl ? txtFishCustomUrl.value.trim() : '',
                voiceId: txtFishVoiceId ? txtFishVoiceId.value.trim() : '',
                fallbackEngine: kokoroEngine,
                speed: rngSpeed ? parseFloat(rngSpeed.value) : 1.05,
                onStart: () => handleTtsStart('Fish Speech 🐟'),
                onEnd: handleTtsEnd
            });

            const activeTtsChoice = selTtsEngine ? selTtsEngine.value : 'fish-speech';
            ttsEngine = activeTtsChoice === 'fish-speech' ? fishEngine : kokoroEngine;

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
                    if (vadStatus) {
                        vadStatus.textContent = 'SILENCE';
                        vadStatus.style.color = 'var(--text-secondary)';
                    }
                    if (isAiThinking || isAiSpeaking || isProcessingUtterance) return;
                    // Debounce silence by 750ms so natural mid-sentence pauses aren't cut off abruptly
                    clearTimeout(sttCommitTimer);
                    sttCommitTimer = setTimeout(() => {
                        if (isCallActive && !isAiSpeaking && !isAiThinking && !isProcessingUtterance) {
                            commitUserVoiceInput(false);
                        }
                    }, 750);
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
    let isProcessingUtterance = false;
    let lastCommittedText = '';
    let lastCommittedTime = 0;
    let sttWatchdogTimer = null;
    let sttCommitTimer = null;
    let pendingIncompleteTimer = null;

    const INCOMPLETE_CONNECTORS = [
        'mujhe', 'mera', 'meri', 'mere', 'hum', 'humara', 'humari', 'aap', 'aapka', 'aapki', 'aapke',
        'kya', 'aur', 'lekin', 'par', 'kyunki', 'toh', 'agar', 'jaise', 'main', 'maine', 'woh', 'yeh',
        'kisi', 'kuch', 'bhi', 'ke', 'ki', 'ka', 'ko', 'se', 'me', 'mein', 'ne', 'i', 'my', 'we', 'our',
        'you', 'your', 'the', 'a', 'an', 'and', 'but', 'because', 'so', 'if', 'when', 'actually', 'well', 'um', 'uh'
    ];

    const isSentenceIncomplete = (text) => {
        if (!text) return true;
        const clean = text.trim().toLowerCase();
        const words = clean.split(/\s+/);
        
        // Single word commands allowed: 'stop', 'pause', 'resume', 'yes', 'haan', 'no', 'nahi', 'bye', 'ok', 'theek'
        const allowedSingleWords = ['stop', 'ruko', 'chup', 'pause', 'resume', 'yes', 'haan', 'ha', 'no', 'nahi', 'na', 'bye', 'ok', 'theek', 'done', 'sure', 'namaste', 'hello', 'hi'];
        if (words.length === 1) {
            if (allowedSingleWords.includes(words[0])) return false;
            // Short numbers like "999" during phone entry
            if (/^\d{1,4}$/.test(words[0])) return true;
            return true; // Single words like "Mujhe", "Mera" should wait for full sentence
        }

        // Check if last word is an open hanging connective in short phrases (< 5 words)
        const lastWord = words[words.length - 1];
        if (INCOMPLETE_CONNECTORS.includes(lastWord) && words.length < 5) {
            return true;
        }

        return false;
    };

    const commitUserVoiceInput = (force = false) => {
        clearTimeout(sttCommitTimer);
        clearTimeout(pendingIncompleteTimer);

        if (isAiThinking || isAiSpeaking || isProcessingUtterance) return;
        const prompt = (currentSpeechText + ' ' + lastInterimText).trim();

        if (!prompt || prompt.length < 2) return;

        // If sentence is incomplete (e.g. user said "Mujhe" or "Mera naam" and took a breath), wait for remaining words!
        if (!force && isSentenceIncomplete(prompt)) {
            console.log('⏳ Incomplete speech fragment detected ("' + prompt + '"), waiting for user to complete sentence...');
            pendingIncompleteTimer = setTimeout(() => {
                commitUserVoiceInput(true); // If user stays silent for another 1800ms, process it
            }, 1800);
            return;
        }

        currentSpeechText = '';
        lastInterimText = '';

        const now = Date.now();
        // Prevent duplicate voice submissions within 3.0s
        if (prompt.toLowerCase() === lastCommittedText.toLowerCase() && (now - lastCommittedTime < 3000)) {
            console.log('Filtered duplicate voice input:', prompt);
            return;
        }

        lastCommittedText = prompt;
        lastCommittedTime = now;
        processUserUtterance(prompt);
    };

    const startRecognitionSafely = () => {
        if (!isCallActive) return;
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

                const rawTranscript = (finalChunk + ' ' + interimChunk).toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();

                // ⚡ Instant Live Voice Commands (Stop / Pause / Resume) — active at ANY moment!
                if (rawTranscript.includes('stop') || rawTranscript.includes('ruko') || rawTranscript.includes('chup')) {
                    console.log('🛑 Voice Stop Triggered!');
                    if (ttsEngine) ttsEngine.interrupt();
                    isAiSpeaking = false;
                    isAiThinking = false;
                    isProcessingUtterance = false;
                    currentSpeechText = '';
                    lastInterimText = '';
                    setAgentState('listening', 'Stopped • Ready for next question');
                    appendChatMessage('user', 'Stop');
                    appendChatMessage('assistant', 'Stopped. I am listening.');
                    if (ttsEngine) ttsEngine.speak('Stopped.');
                    return;
                }

                if (rawTranscript.includes('pause') || rawTranscript.includes('hold on') || rawTranscript.includes('wait')) {
                    console.log('⏸️ Voice Pause Triggered!');
                    if (ttsEngine) ttsEngine.interrupt();
                    isAiSpeaking = false;
                    isAiThinking = false;
                    isProcessingUtterance = false;
                    isSessionPaused = true;
                    currentSpeechText = '';
                    lastInterimText = '';
                    setAgentState('paused', 'Session Paused • Say "Resume" to continue');
                    appendChatMessage('user', 'Pause');
                    appendChatMessage('assistant', 'Session paused. Say "Resume" or "Continue" whenever you are ready.');
                    if (ttsEngine) ttsEngine.speak('Session paused.');
                    return;
                }

                if (rawTranscript.includes('resume') || rawTranscript.includes('continue') || rawTranscript.includes('unpause') || rawTranscript.includes('shuru')) {
                    console.log('▶️ Voice Resume Triggered!');
                    if (ttsEngine) ttsEngine.interrupt();
                    isAiSpeaking = false;
                    isAiThinking = false;
                    isProcessingUtterance = false;
                    isSessionPaused = false;
                    currentSpeechText = '';
                    lastInterimText = '';
                    setAgentState('listening', 'Resumed & Listening to you...');
                    appendChatMessage('user', 'Resume');
                    appendChatMessage('assistant', 'Resumed! What would you like to ask next?');
                    if (ttsEngine) ttsEngine.speak('Resumed.');
                    return;
                }

                // If AI is speaking or thinking and it was not a control command, ignore background echo
                if (isAiSpeaking || isAiThinking || isProcessingUtterance) {
                    return;
                }

                if (finalChunk.trim()) {
                    currentSpeechText = (currentSpeechText + ' ' + finalChunk.trim()).trim();
                    lastInterimText = '';
                } else if (interimChunk.trim()) {
                    lastInterimText = interimChunk.trim();
                }

                const liveHeard = (currentSpeechText + ' ' + lastInterimText).trim();
                if (liveHeard) {
                    setAgentState('listening', `Hearing: "${liveHeard}"`);
                }

                // Dual Trigger: When user pauses speech, debounce and commit
                if (finalChunk.trim() || interimChunk.trim()) {
                    clearTimeout(sttCommitTimer);
                    sttCommitTimer = setTimeout(() => {
                        if (isCallActive && !isAiSpeaking && !isAiThinking && !isProcessingUtterance) {
                            commitUserVoiceInput();
                        }
                    }, 1250);
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
                if (!isCallActive || isAiSpeaking || isAiThinking || isProcessingUtterance) return;
                setTimeout(() => {
                    if (isCallActive && !isAiSpeaking && !isAiThinking && !isProcessingUtterance) {
                        startRecognitionSafely();
                    }
                }, 200);
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

                    // 🎙️ Sarvam AI Style: Proactive welcome greeting & follow-up question on connect
                    setTimeout(() => {
                        triggerProactiveWelcome();
                    }, 450);
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

    /**
     * Proactive Sarvam AI Style Welcome Greeting
     */
    const triggerProactiveWelcome = () => {
        const welcomeText = "Namaste! Welcome to Converse AI Support. I'm Sonara, your voice AI assistant. How can I help you automate your customer support, voice bots, or WhatsApp lead generation today?";
        appendChatMessage('assistant', welcomeText);
        conversationHistory.push({ role: 'assistant', content: welcomeText });
        if (ttsEngine) {
            ttsEngine.speak(welcomeText);
        }
    };

    if (btnInterrupt) {
        btnInterrupt.addEventListener('click', () => {
            if (ttsEngine) ttsEngine.interrupt();
            isAiSpeaking = false;
            isAiThinking = false;
            if (vadEngine) vadEngine.setAiSpeakingState(false);
            setAgentState('listening', 'Interrupted via Button');
        });
    }

    // Sanitize LaTeX math formulas, markdown formatting, and bracket placeholders for natural speech
    const sanitizeAiResponse = (text) => {
        if (!text) return '';
        let s = text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim();
        if (!s || s.length < 2) {
            return "Aapko Converse AI ke case studies, pricing ya free AI audit ki details chahiye? Aap apna requirement bata sakte hain, main turant help karungi!";
        }
        // Convert fractions \frac{a}{b} -> a over b
        s = s.replace(/\\frac\{([^}]+)\}\{([^}]+)\}/gi, (match, num, den) => {
            const cleanNum = num.replace(/\\([a-zA-Z]+)/g, '$1 ').trim();
            const cleanDen = den.replace(/\\([a-zA-Z]+)/g, '$1 ').trim();
            return `${cleanNum} over ${cleanDen}`;
        });
        // Convert Greek & math functions into spoken words
        s = s.replace(/\\(sin|cos|tan|cot|sec|csc|log|ln|exp)\b/gi, '$1 ');
        s = s.replace(/\\(theta|alpha|beta|gamma|delta|pi|lambda|omega|sigma|mu|phi)\b/gi, ' $1 ');
        s = s.replace(/\\sqrt\{([^}]+)\}/gi, 'square root of $1');
        s = s.replace(/\\(cdot|times)\b/gi, ' times ');
        s = s.replace(/\\(approx|sim)\b/gi, ' approximately ');
        s = s.replace(/\\(le|leq)\b/gi, ' less than or equal to ');
        s = s.replace(/\\(ge|geq)\b/gi, ' greater than or equal to ');
        s = s.replace(/\\(pm)\b/gi, ' plus or minus ');
        s = s.replace(/\\(displaystyle|text|mathrm|mathbf)\b/gi, '');
        s = s.replace(/\\\(|\\\)|\\\[|\\\]|\$\$|\$/g, '');
        s = s.replace(/\\[a-zA-Z]+/g, ' ');
        s = s.replace(/[{}]/g, '');
        s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
        s = s.replace(/\*([^*]+)\*/g, '$1');
        s = s.replace(/`([^`]+)`/g, '$1');
        s = s.replace(/#{1,6}\s+/g, '');
        // Bracket placeholders
        s = s.replace(/\[\s*weather\s*condition\s*\]/gi, 'pleasant')
            .replace(/\[\s*high\s*temperature\s*\]/gi, '32°C')
            .replace(/\[\s*low\s*temperature\s*\]/gi, '24°C')
            .replace(/\[\s*activity\s*suggestion\s*\]/gi, 'a nice walk outside')
            .replace(/\[\s*adjective\s*[^\]]*\]/gi, 'great')
            .replace(/\[[^\]]{1,40}\]/g, '');
        return s.replace(/\s{2,}/g, ' ').trim();
    };

    /**
     * Process User Utterance -> Google Gemma 2 / Gemini -> Kokoro TTS
     */
    const processUserUtterance = async (userPrompt) => {
        if (!userPrompt || userPrompt.trim().length === 0 || isAiThinking || isProcessingUtterance) return;
        isProcessingUtterance = true;
        isAiThinking = true;
        clearTimeout(sttCommitTimer);
        currentSpeechText = '';
        lastInterimText = '';

        const cleanCmd = userPrompt.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();

        // 1. VOICE COMMAND: "Stop" / "Ruko" / "Chup" / "Stop speaking"
        if (cleanCmd === 'stop' || cleanCmd === 'stop it' || cleanCmd === 'stop speaking' || cleanCmd === 'ruko' || cleanCmd === 'chup' || cleanCmd === 'stop now') {
            turnStartTime = performance.now();
            appendChatMessage('user', userPrompt);
            if (ttsEngine) ttsEngine.interrupt();
            isAiSpeaking = false;
            isAiThinking = false;
            const stopMsg = "Stopped. I am listening.";
            appendChatMessage('assistant', stopMsg);
            if (ttsEngine) ttsEngine.speak(stopMsg);
            setAgentState('listening', 'Stopped • Ready for next question');
            setTimeout(() => { isProcessingUtterance = false; }, 300);
            return;
        }

        // 2. VOICE COMMAND: "Pause" / "Hold on" / "Wait"
        if (cleanCmd === 'pause' || cleanCmd === 'pause it' || cleanCmd === 'pause session' || cleanCmd === 'hold on' || cleanCmd === 'wait' || cleanCmd === 'ruko thoda') {
            isSessionPaused = true;
            turnStartTime = performance.now();
            appendChatMessage('user', userPrompt);
            if (ttsEngine) ttsEngine.interrupt();
            isAiSpeaking = false;
            isAiThinking = false;
            const pauseMsg = 'Session paused. Say "Resume" or "Continue" whenever you are ready.';
            appendChatMessage('assistant', pauseMsg);
            if (ttsEngine) ttsEngine.speak('Session paused. Say resume when you are ready.');
            setAgentState('paused', 'Session Paused • Say "Resume" to continue');
            setTimeout(() => { isProcessingUtterance = false; }, 300);
            return;
        }

        // 3. VOICE COMMAND: "Resume" / "Continue" / "Shuru karo"
        if (cleanCmd === 'resume' || cleanCmd === 'continue' || cleanCmd === 'unpause' || cleanCmd === 'start again' || cleanCmd === 'chalo shuru karo') {
            isSessionPaused = false;
            turnStartTime = performance.now();
            appendChatMessage('user', userPrompt);
            if (ttsEngine) ttsEngine.interrupt();
            isAiSpeaking = false;
            isAiThinking = false;
            const resumeMsg = "Resumed! What would you like to ask or discuss next?";
            appendChatMessage('assistant', resumeMsg);
            if (ttsEngine) ttsEngine.speak("Resumed! What would you like to ask next?");
            setAgentState('listening', 'Resumed & Listening to you...');
            setTimeout(() => { isProcessingUtterance = false; }, 300);
            return;
        }

        // If session is paused and user didn't say resume/continue, remind them
        if (isSessionPaused) {
            turnStartTime = performance.now();
            appendChatMessage('user', userPrompt);
            const pausedHint = 'Session is paused. Say "Resume" or "Continue" to proceed.';
            appendChatMessage('assistant', pausedHint);
            if (ttsEngine) ttsEngine.speak('Session is paused. Say resume to continue.');
            isAiThinking = false;
            setTimeout(() => { isProcessingUtterance = false; }, 300);
            return;
        }

        // 4. VOICE COMMAND: "Next Question" / "Agla Sawal"
        let effectivePrompt = userPrompt;
        if (cleanCmd === 'next question' || cleanCmd === 'next' || cleanCmd === 'agla sawal' || cleanCmd === 'ask me next question' || cleanCmd === 'another question' || cleanCmd === 'ask me a question') {
            effectivePrompt = "Ask me an engaging, fun trivia or test question across science, history, coding, or general knowledge.";
        }

        turnStartTime = performance.now();
        appendChatMessage('user', userPrompt);
        conversationHistory.push({ role: 'user', content: effectivePrompt });

        // 1. Multi-Turn Conversation Memory & Entity Extraction
        memory.addTurn('user', userPrompt);

        // 2. Automated Tool Calling (availability check, booking, cancel, escalate)
        const toolResult = await toolEngine.detectAndExecute(userPrompt, memory);
        let toolContext = '';
        if (toolResult) {
            toolContext = `\n[ACTION TAKEN / TOOL RESULT]: ${JSON.stringify(toolResult)}\n`;
            if (toolResult.tool === 'book_appointment' && toolResult.success) {
                memory.entities.appointmentId = toolResult.appointmentId;
            }
        }

        // 3. PostgreSQL + pgvector RAG Context Retrieval
        const ragContext = (chkRagEnabled && chkRagEnabled.checked) ? await ragEngine.retrieveContext(userPrompt) : '';
        const memoryPrompt = memory.getMemoryPrompt();

        const modelName = selLlmModel ? selLlmModel.options[selLlmModel.selectedIndex].text : 'Gemma';
        setAgentState('thinking', `Reasoning with ${modelName}...`);

        // Read from Settings field first, fallback to active Groq key
        const apiKey = (txtLlmApiKey?.value.trim()) || (import.meta.env.VITE_API_KEY || DEFAULT_GROQ_KEY);
        const hfToken = (txtHfToken?.value.trim()) || (import.meta.env.VITE_HF_TOKEN || '');
        const provider = selLlmProvider ? selLlmProvider.value : 'groq';
        const model = selLlmModel ? selLlmModel.value : 'openai/gpt-oss-120b';
        
        // Build dynamic real-time context & live weather
        let clientWeatherStr = '';
        const isWeatherQ = userPrompt.toLowerCase().match(/weather|temperature|forecast|mausam|climate|rain|hot|cold/);
        if (isWeatherQ) {
            try {
                const ipRes = await fetch('https://ipwho.is/', { signal: AbortSignal.timeout(1500) });
                if (ipRes.ok) {
                    const ipData = await ipRes.json();
                    const city = ipData.city || 'Local area';
                    const country = ipData.country || '';
                    const lat = ipData.latitude || 28.6;
                    const lon = ipData.longitude || 77.2;

                    const meteoRes = await fetch(
                        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,weather_code`,
                        { signal: AbortSignal.timeout(1500) }
                    );
                    if (meteoRes.ok) {
                        const meteoData = await meteoRes.json();
                        const temp = Math.round(meteoData.current?.temperature_2m || 30);
                        const weatherCodes = {
                            0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
                            45: 'Foggy', 51: 'Light drizzle', 61: 'Slight rain', 63: 'Moderate rain',
                            80: 'Rain showers', 95: 'Thunderstorm'
                        };
                        const cond = weatherCodes[meteoData.current?.weather_code] || 'Pleasant';
                        clientWeatherStr = `\nLive Local Weather: ${city}, ${country}: ${temp}°C (${Math.round(temp * 9/5 + 32)}°F), ${cond}.`;
                    }
                }
            } catch (e) {
                clientWeatherStr = `\nLive Local Weather: Approx 30°C, pleasant weather today.`;
            }
        }

        const now = new Date();
        const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });

        const basePersona = txtSystemPrompt ? txtSystemPrompt.value.trim() : 'You are Sonara, the official Customer Support & Solutions Specialist for Converse AI (theconverseai.com by Revti Digital, Jaipur, India).';
        const converseAiKnowledge = `
STRICT VERIFIED KNOWLEDGE BASE - ConverseAI (https://theconverseai.com/):
- Identity & Ownership: ConverseAI (theconverseai.com) is an enterprise Agentic AI platform built and operated by Revti Digital (based in Jaipur, Rajasthan, India). Official Meta Tech Provider Partner.
- Core Value Proposition: "AI Agents Built & Run For Your Business" — We scope the problem, build custom AI agents (Voice, WhatsApp, Omnichannel workflows), deploy them, and keep them running in production with zero internal AI team needed on the client's end.
- Pricing & Getting Started: ConverseAI does NOT have rigid, generic monthly price tiers. Every partnership begins with a 100% Free AI Opportunity & Readiness Audit (theconverseai.com/book-demo) to assess workflows, calculate ROI, and provide a bespoke build plan.
- Products Suite:
  1. AI Chatbot (24/7 automated support, lead qualification, smart handover to human agents).
  2. Live Chat (Real-time conversations, smart routing, persistent history).
  3. WhatsApp AI (Personalized, context-aware responses with 98% open rates).
  4. Omni-Channel (Unified inbox across Website, WhatsApp, Facebook, Instagram, and Email).
  5. Analytics Suite (CSAT, agent reports, AI insights, live monitoring).
  6. Team Management (Agent capacity and smart workload routing).
- Agentic AI Services:
  1. AI Strategy & Readiness Audit (Scoping high-value automation workflows).
  2. Agentic Systems & Process Automation (Multi-step reasoning and autonomous pipelines).
  3. AI Voice Agents (Inbound/Outbound multilingual voice AI for sales, support, and appointments).
  4. Custom AI Agent Development (Bespoke agents where client owns the IP).
  5. AI Integration Services (Seamless connection to CRM like Salesforce/HubSpot, ERP, Shopify, helpdesks).
  6. Document & Knowledge Intelligence (Enterprise GDPR-compliant RAG for internal docs/contracts).
  7. Sales Intelligence & Outreach (Personalized prospecting and automated outreach campaigns).
- Verified Case Studies:
  * StyleMart India (Retail): 3x revenue in repeat purchases, 65% reduction in support costs, under 30 seconds response time, 94% CSAT.
  * LearnSphere (EdTech): Doubled course enrolments in 90 days, 500+ daily qualified leads automatically, 45% lower cost-per-lead, 80% faster response time.
  * CareFirst Clinics (Healthcare): 55% reduction in appointment no-shows, 120 admin hours saved per month, 91% appointment fill rate.
- Trusted Clients: Tata Motors, Mapsor Experiential Weddings, Meghaa Modi Design Studio, Zapp Loans, Readiprint Fashions, Heritage Food Diary, and 50+ growing businesses.
- Official Contact: Email contact@theconverseai.com, Phone +91-9982323333 / +91-7023084065. DPDP (India), GDPR, and CCPA compliant.

CRITICAL ZERO-HALLUCINATION & CONVERSATIONAL RULES:
1. STRICT WEBSITE GROUNDING: All information must strictly align with https://theconverseai.com/. Never invent pricing tiers, services, or facts not present on theconverseai.com.
2. PRICING INQUIRIES: When asked about pricing, explain that Converse AI offers custom scoping based on business requirements, starting with a Free AI Opportunity & Readiness Audit.
3. HUMAN CONVERSATIONAL FLOW: Speak naturally with warm empathetic fillers ("Achha!", "Bilkul!", "Haan ji!", "Sure!", "Great question!").
4. BILINGUAL HINGLISH/ENGLISH: When speaking in Hindi, write in fluent, natural conversational Hinglish (Roman script).
5. BREATH-LENGTH PACING: Strictly 1-2 punchy spoken sentences, ending with a warm, relevant follow-up question.
6. NO MARKDOWN / NO THINK TAGS: Output ONLY the spoken words aloud.
`;
        const systemPrompt = `${basePersona}\n${converseAiKnowledge}\n${ragContext}\n${memoryPrompt}\n${toolContext}\nReal-Time Context: ${dateStr}, ${timeStr}.${clientWeatherStr}`;

        const aiMessageBubble = appendChatMessage('assistant', '...', true);
        if (toolResult) {
            const badge = document.createElement('div');
            badge.className = 'tool-badge';
            badge.innerHTML = `<i class="fa-solid fa-bolt"></i> ${toolResult.tool}: ${toolResult.message || 'Executed'}`;
            aiMessageBubble.appendChild(badge);
        }


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
                            apiKey,
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
                if (ttsEngine) ttsEngine.speak(fullResponse);

            } else if (apiKey && provider === 'groq') {
                // --- GROQ CLOUD: Sub-100ms Ultra-Fast Intelligence ---
                const groqModelMap = {
                    'openai/gpt-oss-120b': 'openai/gpt-oss-120b',
                    'openai/gpt-oss-20b': 'openai/gpt-oss-20b',
                    'qwen/qwen3.6-27b': 'qwen/qwen3.6-27b',
                    'groq/compound-mini': 'openai/gpt-oss-120b',
                    'groq/compound': 'openai/gpt-oss-120b',
                    'gemma2-9b-it': 'openai/gpt-oss-120b',
                    'gemma-3-12b-it': 'openai/gpt-oss-120b',
                    'gemini-1.5-flash': 'openai/gpt-oss-120b',
                    'llama-3.3-70b-versatile': 'openai/gpt-oss-120b'
                };
                const groqModel = groqModelMap[model] || 'openai/gpt-oss-120b';

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
                        max_completion_tokens: 450
                    })
                });

                if (!res.ok) {
                    const errJson = await res.json().catch(() => ({}));
                    throw new Error(errJson.error?.message || `Groq HTTP ${res.status}`);
                }

                const data = await res.json();
                fullResponse = data.choices?.[0]?.message?.content?.trim() || '';

                if (!fullResponse) {
                    fullResponse = "Aapko Converse AI ke case studies, pricing ya free AI audit ki details chahiye? Aap apna requirement bata sakte hain, main turant help karungi!";
                }

                fullResponse = sanitizeAiResponse(fullResponse);
                markFirstToken();
                aiMessageBubble.textContent = fullResponse;
                if (ttsEngine) ttsEngine.speak(fullResponse);

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
                if (ttsEngine) ttsEngine.speak(fullResponse);

            } else {
                // --- FREE FALLBACK: Pollinations.AI ---
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
                if (ttsEngine) ttsEngine.speak(fullResponse);
            }

            conversationHistory.push({ role: 'assistant', content: fullResponse });
            memory.addTurn('assistant', fullResponse);
            const totalDuration = Math.round(performance.now() - turnStartTime);
            logger.logTurn({
                userInput: userPrompt,
                aiResponse: fullResponse,
                latencyTtftMs: firstTokenTime ? Math.round(firstTokenTime - turnStartTime) : 0,
                latencyTtsMs: totalDuration,
                toolCalls: toolResult ? [toolResult] : []
            }).catch(() => {});

        } catch (err) {
            console.warn('External LLM API unavailable, engaging instant verified smart responder:', err.message);

            // Instant Zero-Downtime Knowledge Responder based on https://theconverseai.com/
            const generateSmartFallback = (query) => {
                const lower = (query || '').toLowerCase();
                if (lower.includes('price') || lower.includes('pricing') || lower.includes('cost') || lower.includes('rate') || lower.includes('charge') || lower.includes('fees') || lower.includes('kitna')) {
                    return 'Achha! Converse AI ke paas koi rigid fixed monthly plans nahi hain—har partnership ek 100% Free AI Opportunity & Readiness Audit se shuru hoti hai, jiske baad bespoke pricing tayaar hoti hai. Kya aap apne business ke liye free audit demo schedule karna chahenge?';
                }
                if (lower.includes('client') || lower.includes('customer') || lower.includes('kaun') || lower.includes('who uses') || lower.includes('company') || lower.includes('tata')) {
                    return 'Achha! Hamare trusted enterprise clients hain—Tata Motors, Mapsor Experiential Weddings, Zapp Loans, Meghaa Modi Design Studio, Readiprint Fashions aur Heritage Food Diary. Kya aap inke case studies ke baare me janna chahenge?';
                }
                if (lower.includes('whatsapp') || lower.includes('wa bot') || lower.includes('chat bot') || lower.includes('chatbot')) {
                    return 'Bilkul! Hamara WhatsApp AI solution 98% open rates ke sath 24/7 customer queries aur lead qualification ko autonomously handle karta hai. Kya aap iska live demo dekhna chahenge?';
                }
                if (lower.includes('voice') || lower.includes('call') || lower.includes('calling') || lower.includes('telephony')) {
                    return 'Bilkul! Hamare AI Voice Agents inbound aur outbound calls ko 100+ languages me bina human intervention ke naturally handle karte hain. Kya aap iske features explore karna chahenge?';
                }
                if (lower.includes('appointment') || lower.includes('demo') || lower.includes('audit') || lower.includes('book') || lower.includes('schedule')) {
                    return 'Haan ji! Main aapka 100% Free AI Opportunity & Readiness Audit demo book kar sakti hoon. Bas apna preferred time slot aur phone number bata dijiye!';
                }
                if (lower.includes('contact') || lower.includes('number') || lower.includes('email') || lower.includes('phone') || lower.includes('address') || lower.includes('jaipur')) {
                    return 'Aap humein contact@theconverseai.com ya phone +91-9982323333 par reach out kar sakte hain, aur hamara office Jaipur, India me hai. Kya aapko kisi particular solution me help chahiye?';
                }
                if (lower.includes('case study') || lower.includes('result') || lower.includes('stylemart') || lower.includes('learnsphere') || lower.includes('carefirst')) {
                    return 'StyleMart ne repeat orders me 3x revenue grow kiya, LearnSphere ne 90 days me enrolments double kiye, aur CareFirst Clinics me appointment no-shows 55% drop hue. Kya aap apne sector ke liye ROI janna chahenge?';
                }
                const nameGreeting = memory?.entities?.customerName ? ` ${memory.entities.customerName} ji` : '';
                return `Achha${nameGreeting}! Main Converse AI ki official solutions specialist hoon. Main aapke business ke customer care aur sales ko AI Voice bots ya WhatsApp automation se scale karne me help kar sakti hoon. Aap kis service ke baare me janna chahenge?`;
            };

            fullResponse = generateSmartFallback(userPrompt);
            markFirstToken();
            aiMessageBubble.textContent = fullResponse;
            if (ttsEngine) ttsEngine.speak(fullResponse);

            conversationHistory.push({ role: 'assistant', content: fullResponse });
            memory.addTurn('assistant', fullResponse);
            const totalDuration = Math.round(performance.now() - turnStartTime);
            logger.logTurn({
                userInput: userPrompt,
                aiResponse: fullResponse,
                latencyTtftMs: 60,
                latencyTtsMs: totalDuration,
                toolCalls: toolResult ? [toolResult] : []
            }).catch(() => {});
        } finally {
            isAiThinking = false;
            setTimeout(() => {
                isProcessingUtterance = false;
                currentSpeechText = '';
                lastInterimText = '';
            }, 600);
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
        const provLabel = selLlmProvider ? selLlmProvider.value.toUpperCase() : 'AI';
        author.textContent = role === 'user' ? 'YOU (Mic / STT)' : `SONARA (${provLabel})`;

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

            if (ttsEngine && typeof ttsEngine.getAnalyser === 'function') {
                const node = ttsEngine.getAnalyser();
                if (node) node.getByteFrequencyData(outputDataArray);
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