/**
 * Vercel Serverless Function: /api/tts
 * Unified endpoint pointing exclusively to ElevenLabs TTS
 */
import elevenLabsHandler from './elevenlabs-tts.js';

export default async function handler(req, res) {
    return elevenLabsHandler(req, res);
}
