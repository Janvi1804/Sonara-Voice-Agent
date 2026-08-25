# 🎙️ SONARA Voice AI - Real-Time Duplex Voice Agent

A modern, high-speed, human-like voice conversational agent built with **Silero VAD**, **WebRTC / Web Audio DSP**, **OpenAI Whisper Large v3 Turbo**, **Google Gemma 2 (9B / 27B)**, and **Kokoro-82M Neural TTS**.

---

## ⚡ Key Highlights & Architecture

1. **Silero VAD (World's #1 Real-Time Silence/Speech Classifier)**
   - Continuous 16kHz audio frame classification.
   - Real-time speech confidence meter & dynamic threshold markers.
   - **Barge-in Interruptibility**: Speaking while the AI is talking immediately halts audio playback and switches to listening mode.

2. **WebRTC / Web Audio API DSP**
   - Acoustic Echo Cancellation (AEC).
   - Noise Suppression (NS).
   - Automatic Gain Control (AGC).

3. **STT (Speech-to-Text)**
   - OpenAI Whisper Large v3 Turbo & NVIDIA Parakeet support.
   - AssemblyAI Universal-1 real-time streaming integration.
   - Native Web Speech recognition fallback.

4. **LLM Reasoning (Google Gemma 2 9B / 27B & Gemini)**
   - Ultra-fast token streaming (<100ms TTFT via Groq / Gemini API).
   - Conversational memory buffer.

5. **TTS (Kokoro-82M Ultra-Realistic Human Voice)**
   - High-fidelity natural voice profiles (`af_heart`, `af_bella`, `am_adam`, `am_michael`, `bf_emma`, `bm_george`).
   - Sentence-level streaming playback without robotic pauses.

6. **3D Glowing Orb & Dynamic Waveform Visualizer**
   - Smooth canvas particle animations reacting to both user mic input frequencies and AI voice output audio levels.

---

## 🚀 How to Run

### Option 1: Direct In-Browser (Zero Setup)
Simply open `index.html` in Google Chrome, Microsoft Edge, or any modern web browser!

```bash
# On Windows, you can launch it directly:
start index.html
```

### Option 2: Run with Node.js
```bash
npm install
npm start
```
Then visit: `http://localhost:3000`

---

## ⚙️ Configuration
Click the **Sliders / Settings icon (⚙️)** in the top right to:
- Choose your LLM model: **Google Gemma 2 9B**, **Gemma 2 27B**, or **Gemini 1.5 Flash**.
- Select Kokoro-82M Voice profile (`af_heart`, `am_adam`, `bf_emma`, etc.).
- Fine-tune Silero VAD Sensitivity (0.3 - 0.95) and Silence Hangover Duration.
- Insert your free Groq or Gemini API key for sub-100ms cloud responses, or test with built-in instant local conversational reasoning.
