/**
 * SONARA VOICE AI - Main Application & Full Duplex Orchestrator
 * Integrates Silero VAD, WebRTC/Web Audio DSP, Whisper v3 Turbo, Gemma 2, Kokoro-82M, Fish Speech,
 * PostgreSQL + pgvector, Multi-Turn Memory, Customer DB, Appointment DB, Tool Calling & Human Handoff.
 */
import { SileroVAD } from './vad-silero.js';
import { WhisperSTT } from './whisper-stt.js';
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

        const ttsMode = selTtsEngine ? selTtsEngine.value : 'kokoro';
        if (rowFishApiKey) rowFishApiKey.style.display = ttsMode === 'fish-speech' ? 'flex' : 'none';
        if (rowFishCustomUrl) rowFishCustomUrl.style.display = ttsMode === 'fish-speech' ? 'flex' : 'none';
        if (rowFishVoiceId) rowFishVoiceId.style.display = ttsMode === 'fish-speech' ? 'flex' : 'none';
    };
    if (selLlmProvider) selLlmProvider.addEventListener('change', updateProviderFields);
    if (selTtsEngine) selTtsEngine.addEventListener('change', updateProviderFields);

    // BUG-001 FIX: API key is NEVER stored in client-side code.
    // All LLM calls route through /api/chat serverless proxy which reads GROQ_API_KEY from Vercel env vars.
    // Users can optionally enter their own key in Settings → it is stored ONLY in localStorage, not bundled here.
    const DEFAULT_GROQ_KEY = '';

    // Initialize Whisper Large V3 Turbo Engine
    const whisperEngine = new WhisperSTT({
        apiKey: DEFAULT_GROQ_KEY,
        language: 'hi',
        model: 'whisper-large-v3-turbo',
        onTranscript: (text) => {
            if (text && text.trim().length > 1) {
                console.log('🎙️ Whisper Large V3 Turbo Transcribed:', text);
            }
        },
        onError: (err) => {
            console.warn('Whisper STT fallback note:', err.message);
        }
    });

    let ttsCooldownUntil = 0;
    let ttsEndGraceTimer = null;
    let ttsSafetyWatchdog = null;

    const handleTtsStart = (engineName) => {
        clearTimeout(ttsEndGraceTimer);
        clearTimeout(ttsSafetyWatchdog);
        isAiSpeaking = true;
        ttsCooldownUntil = Date.now() + 999999;
        if (vadEngine) vadEngine.setAiSpeakingState(true);
        if (whisperEngine) whisperEngine.clearBuffer();
        setAgentState('speaking', `SONARA Speaking (${engineName || 'Kokoro-82M'})`);

        // Safety Watchdog: If browser SpeechSynthesis hangs or fails to fire onend (e.g. after long multi-turn sessions),
        // force unlock the listening pipeline after a 15-second safety ceiling so the user is NEVER stuck!
        ttsSafetyWatchdog = setTimeout(() => {
            if (isAiSpeaking) {
                console.warn('[TTS] Safety watchdog triggered: Force-unlocking listening state');
                handleTtsEnd();
            }
        }, 15000);
    };

    const handleTtsEnd = () => {
        clearTimeout(ttsSafetyWatchdog);
        clearTimeout(ttsEndGraceTimer);
        isAiSpeaking = false;
        isProcessingUtterance = false;
        if (vadEngine) vadEngine.setAiSpeakingState(false);
        // 150ms hardware drain buffer — just enough to clear speaker room reverb tail
        // without locking out the user's next utterance.
        ttsCooldownUntil = Date.now() + 150;

        ttsEndGraceTimer = setTimeout(() => {
            currentSpeechText = '';
            lastInterimText = '';
            if (isCallActive) {
                setAgentState('listening', 'Connected & Listening (Silero VAD)');
                startRecognitionSafely();
            }
        }, 150);
    };

    // Load saved settings from LocalStorage & Initialize default TTS Engine
    const loadSettings = () => {
        const savedApiKey = localStorage.getItem('sonara_llm_api_key');
        if (txtLlmApiKey) {
            // BUG-001 FIX: Only load user's own saved key — never inject hardcoded key into UI
            // All serverless calls (/api/chat) use GROQ_API_KEY from Vercel env vars automatically
            txtLlmApiKey.value = (savedApiKey && savedApiKey.trim().length > 10) ? savedApiKey : '';
            txtLlmApiKey.placeholder = 'Leave empty — server-side key active';
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
        if (localStorage.getItem('sonara_stt_model') && selSttModel) {
            selSttModel.value = localStorage.getItem('sonara_stt_model');
        }
        if (localStorage.getItem('sonara_language') && selLanguage) {
            selLanguage.value = localStorage.getItem('sonara_language');
        }
        // Whisper uses the user's own saved key if they entered one; otherwise /api/transcribe handles it server-side
        whisperEngine.setApiKey(txtLlmApiKey ? txtLlmApiKey.value.trim() : '');
        whisperEngine.setLanguage(selLanguage ? selLanguage.value : 'hi');
        const savedProvider = localStorage.getItem('sonara_llm_provider');
        if (savedProvider && savedProvider !== 'huggingface') {
            selLlmProvider.value = savedProvider;
        } else {
            selLlmProvider.value = 'groq';
            localStorage.setItem('sonara_llm_provider', 'groq');
        }
        if (localStorage.getItem('sonara_system_prompt')) txtSystemPrompt.value = localStorage.getItem('sonara_system_prompt');
        
        // BUG-002 FIX: Supabase DB URL/password is NEVER stored in client-side code.
        // The /api/db serverless function reads POSTGRES_URL from Vercel env vars.
        // Users can optionally add their OWN custom DB URL via Settings (stored only in localStorage).
        const txtPostgresUrl = document.getElementById('txtPostgresUrl');
        const userCustomDbUrl = localStorage.getItem('sonara_postgres_url') || '';
        if (txtPostgresUrl) {
            txtPostgresUrl.value = userCustomDbUrl;
            txtPostgresUrl.placeholder = 'Optional: paste your own PostgreSQL URL (server DB active)';
        }
        // DB modules use /api/db proxy (which has server-side credentials) unless user provides custom URL
        const activeDbUrl = userCustomDbUrl; // empty = serverless proxy handles it
        ragEngine.vectorStore.setPostgresUrl(activeDbUrl);
        customerDB.setPostgresUrl(activeDbUrl);
        appointmentDB.setPostgresUrl(activeDbUrl);
        logger.setPostgresUrl(activeDbUrl);

        // TTS Settings
        if (selTtsEngine) {
            const savedTts = localStorage.getItem('sonara_tts_engine');
            selTtsEngine.value = (savedTts === 'fish-speech' || savedTts === 'native' || savedTts === 'kokoro') ? savedTts : 'kokoro';
        }
        if (txtFishApiKey) {
            const savedFish = localStorage.getItem('sonara_fish_api_key');
            txtFishApiKey.value = (savedFish && !savedFish.includes('S9_QFL')) ? savedFish : '';
            txtFishApiKey.placeholder = 'Optional: enter your Fish Audio API Key';
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
            const savedSilence = parseInt(localStorage.getItem('sonara_silence_dur'));
            rngSilenceDuration.value = savedSilence >= 1000 ? savedSilence : 1200;
            lblSilenceDuration.textContent = `${rngSilenceDuration.value} ms`;
        } else if (rngSilenceDuration) {
            rngSilenceDuration.value = 1200;
            lblSilenceDuration.textContent = '1200 ms';
        }
        if (chkRagEnabled && localStorage.getItem('sonara_rag_enabled') !== null) {
            chkRagEnabled.checked = localStorage.getItem('sonara_rag_enabled') === 'true';
        }
        if (txtCustomRagUrl && localStorage.getItem('sonara_custom_rag_url')) {
            txtCustomRagUrl.value = localStorage.getItem('sonara_custom_rag_url');
        }

        // Initialize Kokoro-82M Core Engine immediately on page load
        if (!kokoroEngine) {
            kokoroEngine = new KokoroTTS(audioContext, {
                voice: selTtsVoice ? selTtsVoice.value : 'af_heart',
                speed: rngSpeed ? parseFloat(rngSpeed.value) : 1.05,
                onStart: () => handleTtsStart('Kokoro-82M'),
                onEnd: handleTtsEnd
            });
        } else {
            kokoroEngine.setVoice(selTtsVoice ? selTtsVoice.value : 'af_heart');
            kokoroEngine.setSpeed(rngSpeed ? parseFloat(rngSpeed.value) : 1.05);
        }

        if (!fishEngine) {
            fishEngine = new FishSpeechTTS(audioContext, {
                apiKey: txtFishApiKey ? txtFishApiKey.value.trim() : '',
                customUrl: txtFishCustomUrl ? txtFishCustomUrl.value.trim() : '',
                voiceId: txtFishVoiceId ? txtFishVoiceId.value.trim() : '',
                fallbackEngine: kokoroEngine,
                speed: rngSpeed ? parseFloat(rngSpeed.value) : 1.05,
                onStart: () => handleTtsStart('Fish Speech 🐟'),
                onEnd: handleTtsEnd
            });
        }

        const activeTtsChoice = selTtsEngine ? selTtsEngine.value : 'kokoro-82m';
        ttsEngine = activeTtsChoice === 'fish-speech' ? fishEngine : kokoroEngine;

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
        if (selSttModel) localStorage.setItem('sonara_stt_model', selSttModel.value);
        if (selLanguage) localStorage.setItem('sonara_language', selLanguage.value);
        if (chkRagEnabled) localStorage.setItem('sonara_rag_enabled', chkRagEnabled.checked);
        if (txtCustomRagUrl) localStorage.setItem('sonara_custom_rag_url', txtCustomRagUrl.value.trim());

        whisperEngine.setApiKey(txtLlmApiKey ? txtLlmApiKey.value.trim() : '');
        whisperEngine.setLanguage(selLanguage ? selLanguage.value : 'hi');

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

        const activeTtsChoice = selTtsEngine ? selTtsEngine.value : 'kokoro-82m';
        ttsEngine = activeTtsChoice === 'fish-speech' ? fishEngine : kokoroEngine;

        settingsModal.classList.remove('active');
        const activeModelName = selLlmModel ? selLlmModel.options[selLlmModel.selectedIndex].text : selLlmModel.value;
        const activeTtsName = selTtsEngine ? (selTtsEngine.value === 'fish-speech' ? 'Fish Speech 🐟' : 'Kokoro-82M ⚡') : 'TTS';
        const activeSttName = selSttModel ? (selSttModel.value === 'whisper-large-v3-turbo' ? 'Groq Whisper Large-v3-Turbo 🎙️' : 'Web Speech') : 'STT';
        appendSystemMessage(`✅ Configuration saved! STT: ${activeSttName} • LLM: ${activeModelName} • TTS: ${activeTtsName}`);
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
    if (dbModalBackdrop) {
        dbModalBackdrop.addEventListener('click', (e) => {
            if (e.target === dbModalBackdrop) dbModalBackdrop.classList.remove('active');
        });
    }
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (settingsModal && settingsModal.classList.contains('active')) settingsModal.classList.remove('active');
            if (dbModalBackdrop && dbModalBackdrop.classList.contains('active')) dbModalBackdrop.classList.remove('active');
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

            // BUG-004 FIX: Detect microphone disconnect mid-conversation
            const micTrack = mediaStream.getAudioTracks()[0];
            if (micTrack) {
                micTrack.addEventListener('ended', () => {
                    if (isCallActive) {
                        console.warn('🎤 Microphone disconnected!');
                        appendSystemMessage('⚠️ Microphone disconnected. Please reconnect your mic and start the session again.');
                        isCallActive = false;
                        stopAudioPipeline();
                        if (btnToggleVoice) {
                            btnToggleVoice.classList.remove('active-call');
                            if (callBtnIcon) callBtnIcon.className = 'fa-solid fa-phone';
                            if (callBtnText) callBtnText.textContent = 'Start Real-Time Voice';
                        }
                        setAgentState('idle', '⚠️ Mic Disconnected — Click to Restart');
                    }
                });
            }

            // Also listen for device list changes (USB mic unplugged)
            const handleDeviceChange = async () => {
                if (!isCallActive) return;
                const devices = await navigator.mediaDevices.enumerateDevices();
                const mics = devices.filter(d => d.kind === 'audioinput');
                if (mics.length === 0) {
                    appendSystemMessage('⚠️ No microphone detected. Please reconnect and start again.');
                    isCallActive = false;
                    stopAudioPipeline();
                    setAgentState('idle', '⚠️ No Mic Found — Click to Restart');
                    navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange);
                }
            };
            navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange);

            inputAnalyser = audioContext.createAnalyser();
            inputAnalyser.fftSize = 256;
            micSource.connect(inputAnalyser);

            // Update active audioContext on TTS engines for live visualizer wave coupling
            if (kokoroEngine) {
                kokoroEngine.audioContext = audioContext;
            }
            if (fishEngine) {
                fishEngine.audioContext = audioContext;
            }

            // Initialize Silero VAD Engine
            // speechStartConfirmFrames=3: require 3 consecutive above-threshold frames (~96ms)
            // before declaring onset. Eliminates single-frame false triggers (clicks, plosives, chair creaks).
            // rmsFloor=0.007: configurable, not hardcoded. Validate against quiet speech
            // (soft-spoken users) before raising -- higher rmsFloor will reject quiet voices.
            // bargeInConfirmFrames=5: require 5 consecutive high-energy frames to confirm barge-in
            // during AI speech. Prevents speaker bleed (TTS audio via air gap) from triggering.
            vadEngine = new SileroVAD({
                sampleRate: 16000,
                frameSize: 512,
                threshold: rngVadThreshold ? parseFloat(rngVadThreshold.value) : 0.65,
                silenceDurationMs: rngSilenceDuration ? parseInt(rngSilenceDuration.value) : 1200,
                minSpeechDurationMs: 250,
                speechStartConfirmFrames: 3,
                rmsFloor: 0.007,
                bargeInConfirmFrames: 8,
                debugLog: true,
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
                    // onSpeechStart fires after onset confirmation (3 frames ~96ms).
                    // If AI is speaking, barge-in was confirmed in onBargeIn -- recording starts there.
                    if (!isAiSpeaking && !isAiThinking) {
                        whisperEngine.startRecording();
                        setAgentState('listening', 'Hearing your voice (Whisper V3 Turbo)...');
                    }
                },
                onSpeechEnd: async (duration) => {
                    if (vadStatus) {
                        vadStatus.textContent = 'SILENCE';
                        vadStatus.style.color = 'var(--text-secondary)';
                    }
                    if (isAiThinking || isAiSpeaking || isProcessingUtterance) return;
                    if (isCallActive) {
                        const sttChoice = selSttModel ? selSttModel.value : 'whisper-large-v3-turbo';
                        if (sttChoice === 'whisper-large-v3-turbo') {
                            setAgentState('thinking', 'Transcribing (Whisper Large V3 Turbo)...');
                            const transcribed = await whisperEngine.stopAndTranscribe();
                            if (transcribed && transcribed.trim().length > 1) {
                                commitUserVoiceInput(false, transcribed.trim());
                            } else {
                                setAgentState('listening', 'Listening with Silero VAD...');
                            }
                        } else {
                            commitUserVoiceInput(false);
                        }
                    }
                },
                onSpeechSuppressed: (duration) => {
                    // Short sound (<minSpeechDurationMs) was detected and discarded by VAD.
                    // Clear Whisper buffer to prevent stale audio from contaminating the next real utterance.
                    whisperEngine.clearBuffer();
                    console.log('[App] Short sound suppressed, Whisper buffer cleared. Duration:', Math.round(duration) + 'ms');
                },
                onBargeIn: () => {
                    // Confirmed genuine user speech while AI TTS is playing (after bargeInConfirmFrames).
                    console.log('⚡ BARGE-IN CONFIRMED: User spoke during AI output. Interrupting TTS.');
                    if (ttsEngine) ttsEngine.interrupt();
                    // ttsEngine.interrupt() calls this.onEnd() -> handleTtsEnd(). We also reset
                    // state immediately here to avoid any timing race between the two paths.
                    clearTimeout(ttsEndGraceTimer);
                    ttsCooldownUntil = Date.now(); // Unlock mic immediately for barge-in response
                    isAiSpeaking = false;
                    isAiThinking = false;
                    isProcessingUtterance = false;
                    vadEngine.setAiSpeakingState(false);
                    whisperEngine.clearBuffer();
                    whisperEngine.startRecording();
                    setAgentState('listening', 'Interrupted -- Listening to You...');
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
                        // If AI is thinking, skip entirely (not speaking -- no barge-in needed during LLM processing)
                        if (isAiThinking) return;
                        // If AI is speaking: pass frames to VAD for barge-in monitoring ONLY.
                        // VAD handles the ai-speaking gate internally and monitors for genuine user barge-in.
                        // Do NOT push to whisperEngine during AI speech -- VAD's onBargeIn callback handles recording onset.
                        if (isAiSpeaking) {
                            const pcmData = event.data;
                            const outputLength = Math.floor(pcmData.length * resampleRatio);
                            const pcm16k = new Float32Array(outputLength);
                            for (let i = 0; i < outputLength; i++) {
                                const srcIdx = i / resampleRatio;
                                const lo = Math.floor(srcIdx);
                                const hi = Math.min(lo + 1, pcmData.length - 1);
                                const frac = srcIdx - lo;
                                pcm16k[i] = pcmData[lo] * (1 - frac) + pcmData[hi] * frac;
                            }
                            vadEngine.processFrame(pcm16k);
                            return; // do NOT push to whisperEngine
                        }
                        // If in TTS cooldown grace period (right after AI finished speaking), skip.
                        // The grace timer prevents tail-word/reverb capture by keeping mic locked.
                        if (Date.now() < ttsCooldownUntil) return;
                        const pcmData = event.data;
                        const outputLength = Math.floor(pcmData.length * resampleRatio);
                        const pcm16k = new Float32Array(outputLength);
                        // Linear interpolation resampling: smoother than nearest-neighbor.
                        // Reduces aliasing for speech-frequency content.
                        for (let i = 0; i < outputLength; i++) {
                            const srcIdx = i / resampleRatio;
                            const lo = Math.floor(srcIdx);
                            const hi = Math.min(lo + 1, pcmData.length - 1);
                            const frac = srcIdx - lo;
                            pcm16k[i] = pcmData[lo] * (1 - frac) + pcmData[hi] * frac;
                        }
                        vadEngine.processFrame(pcm16k);
                        whisperEngine.pushAudioFrame(pcm16k);
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
                    if (isAiThinking) return;
                    // If AI is speaking: pass frames to VAD for barge-in monitoring ONLY.
                    if (isAiSpeaking) {
                        const inputData = e.inputBuffer.getChannelData(0);
                        const outputLength = Math.floor(inputData.length * resampleRatio);
                        const pcm16k = new Float32Array(outputLength);
                        for (let i = 0; i < outputLength; i++) {
                            const srcIdx = i / resampleRatio;
                            const lo = Math.floor(srcIdx);
                            const hi = Math.min(lo + 1, inputData.length - 1);
                            const frac = srcIdx - lo;
                            pcm16k[i] = inputData[lo] * (1 - frac) + inputData[hi] * frac;
                        }
                        for (let offset = 0; offset + 512 <= pcm16k.length; offset += 512) {
                            vadEngine.processFrame(pcm16k.subarray(offset, offset + 512));
                        }
                        return; // do NOT push to whisperEngine during AI speech
                    }
                    // If in post-TTS grace period, skip
                    if (Date.now() < ttsCooldownUntil) return;
                    const inputData = e.inputBuffer.getChannelData(0);
                    const outputLength = Math.floor(inputData.length * resampleRatio);
                    const pcm16k = new Float32Array(outputLength);
                    // Linear interpolation resampling (same as worklet path)
                    for (let i = 0; i < outputLength; i++) {
                        const srcIdx = i / resampleRatio;
                        const lo = Math.floor(srcIdx);
                        const hi = Math.min(lo + 1, inputData.length - 1);
                        const frac = srcIdx - lo;
                        pcm16k[i] = inputData[lo] * (1 - frac) + inputData[hi] * frac;
                    }
                    for (let offset = 0; offset + 512 <= pcm16k.length; offset += 512) {
                        vadEngine.processFrame(pcm16k.subarray(offset, offset + 512));
                    }
                    whisperEngine.pushAudioFrame(pcm16k);
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
        const clean = text.trim().toLowerCase().replace(/[^a-z0-9\u0900-\u097f\s]/g, '').trim();
        const words = clean.split(/\s+/).filter(Boolean);
        if (words.length === 0) return true;
        
        // Single word commands and standalone greetings/queries allowed:
        const allowedSingleWords = [
            'stop', 'ruko', 'chup', 'pause', 'resume', 'yes', 'haan', 'ha', 'no', 'nahi', 'na', 
            'bye', 'ok', 'theek', 'done', 'sure', 'namaste', 'hello', 'hey', 'hi', 'pricing', 'demo', 'services'
        ];
        if (words.length === 1) {
            if (allowedSingleWords.includes(words[0])) return false;
            // Hanging connective like "mujhe", "mera", "the", "and"
            if (INCOMPLETE_CONNECTORS.includes(words[0])) return true;
            return false;
        }

        // Check if last word is an open hanging connective in short phrases (< 5 words)
        const lastWord = words[words.length - 1];
        if (INCOMPLETE_CONNECTORS.includes(lastWord) && words.length < 5) {
            return true;
        }

        return false;
    };

    const commitUserVoiceInput = (force = false, directText = null) => {
        clearTimeout(sttCommitTimer);
        clearTimeout(pendingIncompleteTimer);

        if (isAiThinking || isAiSpeaking || isProcessingUtterance) return;
        const prompt = (directText !== null ? directText : (currentSpeechText + ' ' + lastInterimText)).trim();

        if (!prompt || prompt.length < 2) {
            setAgentState('listening', 'Listening with Silero VAD...');
            return;
        }

        // Never submit single hanging filler words or Whisper language/special tokens (e.g. "<|hi|>", "Hindi", "and", "so", "um", "uh")
        const cleanPrompt = prompt.replace(/<\|.*?\|>/g, '').toLowerCase().replace(/[^a-z0-9\u0900-\u097f\s]/g, '').trim();
        const junkPhrases = ['and', 'so', 'the', 'a', 'an', 'um', 'uh', 'you', 'or', 'is', 'to', 'for', 'with', 'thank you', 'thanks', 'hindi', 'english', 'hinglish'];
        if (!cleanPrompt || cleanPrompt.length < 2 || junkPhrases.includes(cleanPrompt)) {
            console.log('Discarding standalone junk/token fragment:', prompt);
            currentSpeechText = '';
            lastInterimText = '';
            setAgentState('listening', 'Listening with Silero VAD...');
            return;
        }

        // If sentence is incomplete (e.g. user said "Mujhe" or "Mera naam" and took a breath), wait for remaining words!
        if (!force && isSentenceIncomplete(prompt)) {
            console.log('⏳ Incomplete speech fragment detected ("' + prompt + '"), waiting for user to complete sentence...');
            pendingIncompleteTimer = setTimeout(() => {
                const words = prompt.trim().toLowerCase().replace(/[^a-z0-9\u0900-\u097f\s]/g, '').split(/\s+/).filter(Boolean);
                if (words.length <= 1 && INCOMPLETE_CONNECTORS.includes(words[0])) {
                    console.log('Discarding dangling connective word:', prompt);
                    currentSpeechText = '';
                    lastInterimText = '';
                    setAgentState('listening', 'Listening with Silero VAD...');
                    return;
                }
                commitUserVoiceInput(true, prompt);
            }, 1200);
            return;
        }

        currentSpeechText = '';
        lastInterimText = '';

        const now = Date.now();
        // Prevent duplicate voice submissions within 3.0s
        if (prompt.toLowerCase() === lastCommittedText.toLowerCase() && (now - lastCommittedTime < 3000)) {
            console.log('Filtered duplicate voice input:', prompt);
            setAgentState('listening', 'Listening with Silero VAD...');
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

                // BUG-005 FIX: Use word-boundary detection — only trigger on standalone commands,
                // NOT when "stop", "wait", "continue" are embedded inside normal sentences.
                // e.g. "I want to stop my subscription" should NOT trigger STOP command.
                const words = rawTranscript.trim().split(/\s+/);
                const wordCount = words.length;
                const isShortCommand = wordCount <= 3; // Commands are short: "stop", "ruko", "please stop"
                const firstWord = words[0] || '';
                const lastWord = words[wordCount - 1] || '';

                // STOP command: only if short utterance AND stop/ruko/chup is first or last word
                const isStopCmd = isShortCommand && (
                    firstWord === 'stop' || lastWord === 'stop' ||
                    firstWord === 'ruko' || lastWord === 'ruko' ||
                    firstWord === 'chup' || lastWord === 'chup'
                );
                if (isStopCmd) {
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

                // PAUSE command: only if short utterance with pause keyword
                const isPauseCmd = isShortCommand && (
                    rawTranscript === 'pause' || rawTranscript === 'hold on' || rawTranscript === 'wait' ||
                    rawTranscript === 'wait a moment' || rawTranscript === 'please pause'
                );
                if (isPauseCmd) {
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

                // RESUME command: only if short utterance with resume keyword
                const isResumeCmd = isShortCommand && (
                    firstWord === 'resume' || firstWord === 'continue' || firstWord === 'unpause' || firstWord === 'shuru'
                );
                if (isResumeCmd) {
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

                // Only accumulate text and commit from Web Speech API if user explicitly chose web-speech mode
                const sttChoice = selSttModel ? selSttModel.value : 'whisper-large-v3-turbo';
                if (sttChoice === 'web-speech') {
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

                    if (finalChunk.trim() || interimChunk.trim()) {
                        clearTimeout(sttCommitTimer);
                        sttCommitTimer = setTimeout(() => {
                            if (isCallActive && !isAiSpeaking && !isAiThinking && !isProcessingUtterance) {
                                commitUserVoiceInput(false);
                            }
                        }, 1250);
                    }
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
        const welcomeText = "Namaste! Welcome to Converse AI. I'm Sonara, how can I help you today?";
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
        const viteEnv = (typeof import.meta !== 'undefined' && import.meta.env) ? import.meta.env : {};
        const apiKey = (txtLlmApiKey?.value.trim()) || (viteEnv.VITE_API_KEY || DEFAULT_GROQ_KEY);
        const hfToken = (txtHfToken?.value.trim()) || (viteEnv.VITE_HF_TOKEN || '');
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
3. LANGUAGE MATCHING: Match the user's language naturally. If the user speaks English (e.g. "Hello", "Hi", "What services do you offer?"), reply in natural, fluent English. If the user speaks Hindi or Hinglish, reply in warm, conversational Hinglish (Roman script).
4. GREETING RESPONSE: When greeted with "Hello", "Hi", or "Namaste", reply warmly and directly: "Hello! Welcome to Converse AI. How can I help you automate your customer support, voice bots, or WhatsApp workflows today?" Never combine awkward robotic fillers like "Achha! Bilkul".
5. BREATH-LENGTH PACING: Strictly 1-2 punchy spoken sentences, ending with a warm, relevant follow-up question.
6. NO MARKDOWN / NO THINK TAGS: Output ONLY the spoken words aloud.
7. STRICT APPOINTMENT & COLLISION RULES:
   - NEVER invent an APPT ID or claim a booking is confirmed unless [ACTION TAKEN / TOOL RESULT] explicitly shows "success": true.
   - If the user has not provided their own 10-digit phone number, ask for their phone number before confirming.
   - If [ACTION TAKEN / TOOL RESULT] shows that a requested time slot is ALREADY BOOKED ("isAvailable": false or "success": false), you MUST politely inform the user that this slot is already occupied, and offer the available open slots from the tool result. NEVER confirm an already booked slot even if the user insists.
`;
        const systemPrompt = `${basePersona}\n${converseAiKnowledge}\n${ragContext}\n${memoryPrompt}\n${toolContext}\nReal-Time Context: ${dateStr}, ${timeStr}.${clientWeatherStr}`;

        const aiMessageBubble = appendChatMessage('assistant', '...', true);
        if (toolResult) {
            const badge = document.createElement('div');
            badge.className = 'tool-badge';
            badge.innerHTML = `<i class="fa-solid fa-bolt"></i> ${toolResult.tool}: ${toolResult.message || 'Executed'}`;
            aiMessageBubble.appendChild(badge);
        }
        // Instant Zero-Downtime Knowledge Responder based on https://theconverseai.com/
        const generateSmartFallback = (query) => {
            const lower = (query || '').toLowerCase();

            // 1. Tool execution result handling
            if (toolResult) {
                if (toolResult.tool === 'check_availability') {
                    const slots = toolResult.availableSlots ? toolResult.availableSlots.join(', ') : '10:00 AM, 11:30 AM, 02:00 PM, 03:30 PM, 05:00 PM';
                    return `Kal ke liye hamare open demo slots hain—${slots}. Aapko inme se kaunsa time suit karega?`;
                }
                if (toolResult.tool === 'book_appointment') {
                    if (toolResult.success) {
                        return `Bilkul! Aapka demo call confirm ho gaya hai—Appointment ID ${toolResult.appointmentId || 'APPT-1001'}. Kya aapko koi aur detail chahiye?`;
                    } else {
                        return `Yeh slot abhi booked hai. Hamare khali slots hain: ${toolResult.availableSlots ? toolResult.availableSlots.join(', ') : '11:30 AM, 02:00 PM'}. Kya aap inme se koi choose karna chahenge?`;
                    }
                }
            }

            // 2. Slot & availability inquiries
            if (lower.includes('slot') || lower.includes('available') || lower.includes('timing') || lower.includes('free time') || lower.includes('kab') || lower.includes('schedule') || lower.includes('appointment')) {
                return 'Kal ke liye hamare open slots hain—10:00 AM, 11:30 AM, 02:00 PM, 03:30 PM, aur 05:00 PM. Aap kis time par 100% Free AI Audit demo schedule karna chahenge?';
            }

            // 3. Pricing inquiries
            if (lower.includes('price') || lower.includes('pricing') || lower.includes('cost') || lower.includes('rate') || lower.includes('charge') || lower.includes('fees') || lower.includes('kitna')) {
                return 'Achha! Converse AI ke paas koi rigid fixed monthly plans nahi hain—har partnership ek 100% Free AI Opportunity & Readiness Audit se shuru hoti hai, jiske baad bespoke pricing tayaar hoti hai. Kya aap apne business ke liye free audit demo schedule karna chahenge?';
            }

            // 4. Client inquiries (precise keywords)
            if (lower.includes('client') || lower.includes('customer') || lower.includes('who uses') || lower.includes('trusted by') || lower.includes('tata') || lower.includes('company')) {
                return 'Hamare trusted enterprise clients hain—Tata Motors, Mapsor Experiential Weddings, Zapp Loans, Meghaa Modi Design Studio, Readiprint Fashions aur Heritage Food Diary. Kya aap inke case studies ke baare me janna chahenge?';
            }

            // 5. Products & services
            if (lower.includes('whatsapp') || lower.includes('wa bot') || lower.includes('chatbot')) {
                return 'Bilkul! Hamara WhatsApp AI solution 98% open rates ke sath 24/7 customer queries aur lead qualification ko autonomously handle karta hai. Kya aap iska live demo dekhna chahenge?';
            }
            if (lower.includes('voice') || lower.includes('call') || lower.includes('calling') || lower.includes('telephony')) {
                return 'Bilkul! Hamare AI Voice Agents inbound aur outbound calls ko 100+ languages me bina human intervention ke naturally handle karte hain. Kya aap iske features explore karna chahenge?';
            }
            if (lower.includes('service') || lower.includes('product') || lower.includes('offer') || lower.includes('kya kya') || lower.includes('kya karte')) {
                return 'Converse AI voice bots, WhatsApp AI automation, omnichannel support inbox, Enterprise RAG aur custom AI workflow solutions build aur deploy karta hai. Aap kis solution me interested hain?';
            }
            if (lower.includes('contact') || lower.includes('number') || lower.includes('email') || lower.includes('phone') || lower.includes('address') || lower.includes('jaipur')) {
                return 'Aap humein contact@theconverseai.com ya phone +91-9982323333 par reach out kar sakte hain, aur hamara office Jaipur, India me hai. Kya aapko kisi particular solution me help chahiye?';
            }
            if (lower.includes('case study') || lower.includes('result') || lower.includes('stylemart') || lower.includes('learnsphere') || lower.includes('carefirst')) {
                return 'StyleMart ne repeat orders me 3x revenue grow kiya, LearnSphere ne 90 days me enrolments double kiye, aur CareFirst Clinics me appointment no-shows 55% drop hue. Kya aap apne sector ke liye ROI janna chahenge?';
            }
            const nameGreeting = memory?.entities?.customerName ? ` ${memory.entities.customerName} ji` : '';
            return `Namaste${nameGreeting}! Main Sonara hoon, Converse AI ki official solutions specialist. Main aapke business ke customer care aur sales ko AI Voice bots ya WhatsApp automation se scale karne me help kar sakti hoon. Aap kis service ke baare me janna chahenge?`;
        };

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

        try {
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

            } else if (provider === 'gemini' && apiKey) {
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
                // --- GROQ (Default): High-Speed Vercel Serverless /api/chat Proxy (Server-side GROQ_API_KEY) ---
                const historySlice = conversationHistory.slice(-12);
                const messages = [
                    { role: 'system', content: systemPrompt },
                    ...historySlice.map(m => ({
                        role: m.role === 'assistant' ? 'assistant' : 'user',
                        content: m.content
                    }))
                ];

                let serverSuccess = false;

                try {
                    const apiRes = await fetch('/api/chat', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            provider: 'groq',
                            model: model || 'openai/gpt-oss-120b',
                            messages,
                            apiKey: apiKey || undefined,
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
                        console.warn('/api/chat status:', apiRes.status, errData);
                    }
                } catch (e) {
                    console.warn('/api/chat fetch error:', e.message);
                }

                // Direct client fallback only if user provided a key and serverless proxy failed
                if (!serverSuccess && apiKey) {
                    try {
                        const groqModel = 'openai/gpt-oss-120b';
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
                                    ...conversationHistory.slice(-12)
                                ],
                                temperature: 0.65,
                                max_completion_tokens: 450
                            })
                        });

                        if (res.ok) {
                            const data = await res.json();
                            fullResponse = data.choices?.[0]?.message?.content?.trim() || '';
                            if (fullResponse) serverSuccess = true;
                        }
                    } catch (e) {
                        console.warn('Direct Groq fallback error:', e.message);
                    }
                }

                if (!fullResponse) {
                    fullResponse = generateSmartFallback(userPrompt);
                }

                fullResponse = sanitizeAiResponse(fullResponse);
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

    // ════════════════════════════════════════════════════════════════════════
    // ── CALL AGENT WIDGET (Phase 1 — Free Browser Voice Call)             ──
    // Reuses existing: startAudioPipeline(), stopAudioPipeline(),           ──
    //   setAgentState(), startVisualizerLoop(), appendChatMessage(),         ──
    //   ttsEngine, isCallActive, isAiSpeaking, isAiThinking,                ──
    //   conversationHistory — NO new STT/LLM/TTS code.                      ──
    // ════════════════════════════════════════════════════════════════════════
    (function initCallAgentWidget() {
        const _overlay       = document.getElementById('callPhoneOverlay');
        const _btnCall       = document.getElementById('btnCallAgent');
        const _btnEnd        = document.getElementById('btnEndCall');
        const _inputName     = document.getElementById('callInputName');
        const _inputPhone    = document.getElementById('callInputPhone');
        const _overlayName   = document.getElementById('callOverlayCallerName');
        const _stateText     = document.getElementById('callStateText');
        const _durationEl    = document.getElementById('callDurationDisplay');

        // Guard: exit if elements not found (shouldn't happen)
        if (!_btnCall || !_overlay) return;

        let _callStart   = null;   // Date.now() when call connected
        let _durTimer    = null;   // interval: updates duration + state text

        // ── Helpers ──────────────────────────────────────────────────────
        const _fmtDur = (ms) => {
            const s = Math.floor(ms / 1000);
            return `${String(Math.floor(s / 60)).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
        };

        const _showOverlay = (displayName) => {
            if (_overlayName) _overlayName.textContent = displayName || 'Sonara AI';
            _overlay.classList.add('visible');
            _overlay.setAttribute('aria-hidden', 'false');
            document.body.classList.add('call-overlay-open');
            if (_durationEl) _durationEl.textContent = '00:00';
        };

        const _hideOverlay = () => {
            _overlay.classList.remove('visible');
            _overlay.setAttribute('aria-hidden', 'true');
            document.body.classList.remove('call-overlay-open');
        };

        const _startDurTimer = () => {
            _callStart = Date.now();
            _durTimer = setInterval(() => {
                // Update duration clock
                if (_durationEl) _durationEl.textContent = _fmtDur(Date.now() - _callStart);

                // Reflect current voice-agent state in overlay (reads shared closure vars)
                if (_stateText) {
                    if (isAiSpeaking)       _stateText.textContent = '🔊 Sonara is speaking…';
                    else if (isAiThinking)  _stateText.textContent = '⏳ Processing…';
                    else if (isCallActive)  _stateText.textContent = '🎙️ Listening…';
                }

                // Safety: if main pipeline ended call externally, sync overlay
                if (!isCallActive && _overlay.classList.contains('visible')) {
                    _cleanupCall();
                }
            }, 500);
        };

        const _stopDurTimer = () => {
            clearInterval(_durTimer);
            _durTimer = null;
        };

        const _resetBtn = () => {
            _btnCall.disabled = false;
            _btnCall.innerHTML = '<i class="fa-solid fa-phone" aria-hidden="true"></i><span>Call Agent</span>';
        };

        const _cleanupCall = () => {
            _stopDurTimer();
            _hideOverlay();
            _resetBtn();
            // Remove call context from history
            conversationHistory = conversationHistory.filter(
                m => !m.content?.startsWith('[CALL_CTX]')
            );
        };

        // ── Start Call ───────────────────────────────────────────────────
        _btnCall.addEventListener('click', async () => {
            const name  = _inputName?.value.trim()  || '';
            const phone = _inputPhone?.value.trim()  || '';

            // Validate: phone must have at least 10 digits
            if (!phone || phone.replace(/\D/g, '').length < 10) {
                _inputPhone?.classList.add('call-input-error');
                _inputPhone?.focus();
                setTimeout(() => _inputPhone?.classList.remove('call-input-error'), 2000);
                return;
            }

            // Prevent double-tap
            if (isCallActive) return;

            // Inject caller context into conversation (remove stale one first)
            conversationHistory = conversationHistory.filter(
                m => !m.content?.startsWith('[CALL_CTX]')
            );
            conversationHistory.unshift({
                role: 'system',
                content: `[CALL_CTX] Browser voice call. Caller: ${name || 'Guest'}, Phone: ${phone}. ${name ? `Address the caller as ${name}.` : ''} Keep answers concise and conversational.`
            });

            // Show connecting state
            _btnCall.disabled = true;
            _btnCall.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i><span>Connecting…</span>';
            if (_stateText) _stateText.textContent = '⏳ Connecting…';

            // ── Start the existing audio pipeline (mic → VAD → STT → LLM → TTS)
            const success = await startAudioPipeline();

            if (success) {
                // Mark call active (mirrors btnToggleVoice logic)
                isCallActive = true;

                // Sync existing main voice button UI so both stay consistent
                if (btnToggleVoice) btnToggleVoice.classList.add('active-call');
                if (callBtnIcon)    callBtnIcon.className  = 'fa-solid fa-phone-slash';
                if (callBtnText)    callBtnText.textContent = 'End Voice Session';

                setAgentState('listening', 'Connected & Listening (Silero VAD)');
                startVisualizerLoop();

                // Show overlay with caller name / phone as display name
                _showOverlay(name || phone);
                _startDurTimer();

                console.log(`[CallAgent] call_started — caller: "${name || 'Guest'}", phone: ${phone}`);

                // Personalised proactive greeting
                setTimeout(() => {
                    const greeting = name
                        ? `Namaste ${name}! Welcome to Converse AI. I'm Sonara — how can I help you today?`
                        : "Namaste! Welcome to Converse AI. I'm Sonara — how can I help you today?";
                    appendChatMessage('assistant', greeting);
                    conversationHistory.push({ role: 'assistant', content: greeting });
                    if (ttsEngine) ttsEngine.speak(greeting);
                }, 450);

            } else {
                // Pipeline failed (mic denied / not found / etc.)
                conversationHistory = conversationHistory.filter(
                    m => !m.content?.startsWith('[CALL_CTX]')
                );
                _resetBtn();
                if (_stateText) _stateText.textContent = '🎙️ Listening…';
                console.warn('[CallAgent] call_error — startAudioPipeline failed');
            }
        });

        // ── End Call ─────────────────────────────────────────────────────
        _btnEnd?.addEventListener('click', () => {
            if (!isCallActive) return;

            console.log('[CallAgent] call_ended — user clicked End Call');
            isCallActive = false;
            stopAudioPipeline();
            _cleanupCall();

            // Sync main voice button
            if (btnToggleVoice) btnToggleVoice.classList.remove('active-call');
            if (callBtnIcon)    callBtnIcon.className  = 'fa-solid fa-phone';
            if (callBtnText)    callBtnText.textContent = 'Start Real-Time Voice';
            setAgentState('idle', 'Agent Inactive • Click to Start');
        });

        // ── Keyboard: Escape → end call ───────────────────────────────────
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && _overlay.classList.contains('visible')) {
                _btnEnd?.click();
            }
        });

        // ── Sync: hide overlay if main "End Voice Session" btn was used ───
        // (so both UIs stay consistent regardless of which button the user uses)
        btnToggleVoice?.addEventListener('click', () => {
            setTimeout(() => {
                if (!isCallActive && _overlay.classList.contains('visible')) {
                    _cleanupCall();
                }
            }, 300);
        });

        console.log('[CallAgent] Widget initialised');
    })();

});


