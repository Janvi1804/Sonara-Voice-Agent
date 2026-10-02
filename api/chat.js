/**
 * Vercel Serverless Function: /api/chat
 * Groq API LLM Engine with verified theconverseai.com RAG & context-aware multi-turn reasoning.
 * STRICT GROQ CLOUD ONLY — NO alternate provider fallbacks.
 */

import { setCorsHeaders, checkRateLimit } from './_utils.js';

// 100% Verified Knowledge Base from https://theconverseai.com/
const CONVERSE_AI_KB = [
  {
    id: "theconverseai-overview",
    title: "ConverseAI Overview & Value Proposition",
    keywords: ["overview", "what is converseai", "what is converse ai", "about", "introduction", "who are you", "revti digital", "company", "converse ai"],
    content: "ConverseAI (theconverseai.com) is an enterprise Agentic AI and customer engagement platform powered by Revti Digital, founded in 2021 and based in Jaipur, Rajasthan, India. We scope the problem, build bespoke AI agents, and run them in production across Voice, WhatsApp, and automated workflows with zero AI team needed on the client's end. Meta Tech Provider Partner."
  },
  {
    id: "theconverseai-location-contact",
    title: "ConverseAI Contact & Location",
    keywords: ["where", "location", "address", "contact", "phone", "email", "office", "headquarters", "jaipur", "reach out", "support"],
    content: "ConverseAI is operated by Revti Digital, based in Jaipur, Rajasthan, India. Contact: email contact@theconverseai.com, phone +91-9982323333 and +91-7023084065. All infrastructure is compliant with India DPDP, GDPR, and CCPA standards."
  },
  {
    id: "theconverseai-services",
    title: "ConverseAI Core Services & Products",
    keywords: ["services", "products", "offer", "features", "solutions", "what do you do", "voice bot", "whatsapp", "rag", "omnichannel", "automation"],
    content: "ConverseAI provides 5 core enterprise services: 1) Inbound & Outbound AI Voice Agents for customer support, lead qualification, and appointment scheduling in 100+ languages. 2) WhatsApp AI Automation with 98% open rates for 24/7 lead capture, catalog commerce, and query resolution. 3) Omni-Channel Unified Support Inbox connecting Website, WhatsApp, Instagram, Facebook Messenger, and Email. 4) Enterprise RAG (Document & Knowledge Intelligence) allowing teams to query internal SOPs, contracts, and CRM securely in private cloud. 5) Custom AI Agent Development and Agentic Workflow Automation integrated with CRM (Salesforce, HubSpot) and ERPs."
  },
  {
    id: "theconverseai-casestudies",
    title: "Verified Case Studies with Metrics",
    keywords: ["case study", "case studies", "results", "example", "examples", "proof", "metrics", "roi", "stylemart", "learnsphere", "carefirst", "retail", "edtech", "healthcare", "outcome", "success"],
    content: "ConverseAI has 3 verified enterprise case studies (these are CASE STUDY clients with documented results — different from general brand clients): 1) StyleMart India (Retail sector): Deployed a WhatsApp AI chatbot for customer support. Results: 3x repeat purchase revenue, 65% reduction in customer support costs, under 30-second response time, and 94% CSAT score. 2) LearnSphere (EdTech sector): Deployed an automated lead qualification and follow-up bot. Results: doubled course enrolments within 90 days, 80% faster lead response time, 500+ daily qualified leads, and 45% lower cost per qualified lead. 3) CareFirst Clinics (Healthcare sector): Deployed unified WhatsApp and web chat for patient communication and appointment management. Results: 55% reduction in appointment no-shows, 120 admin hours saved monthly, 91% booking fill rate, and +28 point NPS increase."
  },
  {
    id: "theconverseai-pricing",
    title: "ConverseAI Pricing & Free Opportunity Audit",
    keywords: ["pricing", "price", "cost", "how much", "charges", "rate", "packages", "quote", "subscription", "plans"],
    content: "ConverseAI uses custom, bespoke pricing based on specific business workflows, scale, integrations, and usage requirements. We do not have rigid one-size-fits-all tiers. Every partnership starts with a 100% Free AI Opportunity & Readiness Audit (bookable at theconverseai.com/book-demo) where our engineers assess your systems and deliver a clear build plan and ROI estimate with zero overhead."
  },
  {
    id: "theconverseai-brand-clients",
    title: "ConverseAI Brand Clients & Partners",
    keywords: ["clients", "customers", "who uses", "companies", "brands", "tata motors", "mapsor", "zapp loans", "meghaa modi", "readiprint", "heritage food diary", "partners", "portfolio"],
    content: "ConverseAI is trusted by 500+ businesses worldwide. Notable brand clients and partners include: Tata Motors (automotive), Mapsor Experiential Weddings (events), Zapp Loans (fintech), Meghaa Modi Design Studio (fashion/design), Readiprint Fashions (retail), and Heritage Food Diary (F&B). IMPORTANT: These are brand/partner clients — they are DIFFERENT from the 3 documented case study clients (StyleMart India, LearnSphere, CareFirst Clinics). Do NOT mix these two lists. When asked about case studies or specific results/metrics, refer only to StyleMart, LearnSphere, and CareFirst — never invent metrics for Tata Motors or other brand clients."
  },
  {
    id: "theconverseai-stats",
    title: "Performance Metrics & Scale",
    keywords: ["stats", "metrics", "numbers", "messages automated", "open rate", "languages", "scale", "how many"],
    content: "ConverseAI has automated over 50 Million messages across 500+ businesses globally, delivering a 98% WhatsApp open rate, 60% faster customer response times, and an average 94% CSAT score across 100+ supported languages."
  }
];
// Detect definitional / conceptual queries: "what is X", "explain X", "define X", "how does X work"
const DEFINITIONAL_PATTERNS = /^(what\s+(is|are|does)|explain|define|tell\s+me\s+about|how\s+does|what\s+do\s+you\s+mean\s+by)\b/i;

// RAG Retrieval Function — returns relevant company knowledge, with reduced weight for broad service
// chunk on definitional queries to avoid false positives (e.g. "what is a voice agent?" shouldn't
// return the generic Converse AI services overview as if it IS the answer).
function retrieveRAGContext(query = '', isDefinitional = false) {
    if (!query) return '';
    const qLower = query.toLowerCase();
    const qWords = qLower.split(/\s+/).filter(w => w.length > 2);

    const scored = CONVERSE_AI_KB.map(doc => {
        let score = 0;
        doc.keywords.forEach(kw => {
            if (qLower.includes(kw)) score += 5;
        });
        qWords.forEach(w => {
            if (doc.title.toLowerCase().includes(w)) score += 3;
            if (doc.content.toLowerCase().includes(w)) score += 1;
        });

        // For definitional queries, penalise the broad "services" chunk unless a keyword explicitly
        // matched (to avoid it being returned simply because "voice" appears in the chunk body).
        if (isDefinitional && doc.id === 'theconverseai-services') {
            const keywordHit = doc.keywords.some(kw => qLower.includes(kw));
            if (!keywordHit) score = Math.max(0, score - 4);
        }

        return { doc, score };
    }).filter(item => item.score >= 3).sort((a, b) => b.score - a.score);

    if (scored.length === 0) return '';

    const retrieved = scored.slice(0, 3).map(item => `[${item.doc.title}]:\n${item.doc.content}`).join('\n\n');

    const label = isDefinitional
        ? '--- CONVERSE AI COMPANY CONTEXT (use only if directly relevant to the user\'s question — do NOT use as the definition itself) ---'
        : '--- TRUSTED COMPANY KNOWLEDGE (VERIFIED CONVERSE AI FACTS) ---';
    const footer = isDefinitional
        ? '(Use the above only as supplementary context after answering the user\'s actual question. Facts and metrics must be taken from here, never invented.)'
        : '(CRITICAL: Base facts, metrics, and services strictly on the verified knowledge above. Never invent facts, numbers, or clients.)';

    return `\n\n${label}\n${retrieved}\n${footer}\n`;
}

// Clean think tags, markdown, and enforce natural sentence limit (up to 4 sentences)
function sanitizeAiResponse(text) {
    if (!text) return '';
    let clean = text
        .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
        .replace(/[*_#`~[\]]/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();

    // Enforce maximum 4 sentences for complete, natural voice responses (not clipped)
    const sentences = clean.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g);
    if (sentences && sentences.length > 4) {
        clean = sentences.slice(0, 4).map(s => s.trim()).join(' ');
    }
    return clean;
}


export default async function handler(req, res) {
    const corsAllowed = setCorsHeaders(req, res, 'POST, OPTIONS');

    if (req.method === 'OPTIONS') {
        if (!corsAllowed) return res.status(403).json({ error: 'Forbidden: CORS origin not allowed.' });
        return res.status(200).end();
    }

    if (!corsAllowed && req.headers.origin) {
        return res.status(403).json({ error: 'Forbidden: CORS origin not allowed.' });
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed. Use POST.' });
    }

    if (!checkRateLimit(req, { maxRequests: 60, windowMs: 60000 })) {
        return res.status(429).json({ error: 'Rate limit exceeded. Please slow down.' });
    }

    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
        const {
            messages = [],
            model = 'qwen/qwen3.8-27b',
            temperature = 0.65,
            max_tokens = 180,
            stream = false
        } = body;



        const groqApiKey = process.env.GROQ_API_KEY || '';
        if (!groqApiKey) {
            return res.status(500).json({ error: 'GROQ_API_KEY is not configured on server.' });
        }

        // Get latest user query for RAG lookup
        const userMessages = messages.filter(m => m.role === 'user');
        const lastUserMsg = userMessages.length > 0 ? userMessages[userMessages.length - 1].content : '';

        // Classify query type: definitional ("what is X", "explain X") vs. service/company inquiry
        const isDefinitionalQuery = DEFINITIONAL_PATTERNS.test(lastUserMsg.trim());
        const ragContext = retrieveRAGContext(lastUserMsg, isDefinitionalQuery);

        // Build the definitional-query guard instruction (injected only when query is definitional)
        const definitionalGuard = isDefinitionalQuery
            ? `\n\nIMPORTANT — DEFINITIONAL QUESTION: The user asked "${lastUserMsg.trim()}". Explain what the concept actually IS in clear, plain language, explaining all essential points in MAXIMUM 3-5 sentences. Then briefly mention how Converse AI applies it. Keep the entire response strictly within 5 lines.`
            : '';

        // Production-Grade System Prompt for SONARA
        const SYSTEM_PROMPT = `You are Sonara, the official Conversational AI Solutions Specialist for Converse AI by Revti Digital, India (theconverseai.com).

STRICT LANGUAGE MATCHING (RULE #1 - HIGHEST PRIORITY):
- If the user asks in English -> You MUST respond 100% in fluent, professional English. Do NOT mix Hindi or Hinglish into an English answer.
- If the user asks in Hindi or Hinglish -> You MUST respond in warm, natural conversational Hindi/Hinglish.
- SCRIPT ENFORCEMENT: When speaking Hindi/Hinglish, ALWAYS write in the Roman/English alphabet (e.g., 'Main theek hoon, main acchi hoon! Aap bataiye?'). NEVER output in Devanagari script, ensuring natural TTS pronunciation.
- Strictly match the language of the user's latest query. Never answer a Hindi question in English, and never answer an English question in Hindi.

GENDER & GRAMMAR RULES (VERY IMPORTANT):
1. FOR YOURSELF (SONARA — FEMALE SPECIALIST):
   - You are Sonara, a friendly female AI specialist (she/her). When speaking about yourself, strictly use feminine Hindi grammar:
     * If asked "kaisi ho?" or "aap kaise hain?", say: "Main theek hoon, main acchi hoon! Aap bataiye?" (NEVER say "accha hoon").
     * ALWAYS use: "main karti hoon" (NEVER "karta hoon")
     * ALWAYS use: "main bata sakti hoon" (NEVER "bata sakta hoon")
     * ALWAYS use: "main samajh gayi" (NEVER "samajh gaya")
     * ALWAYS use: "main madad kar sakti hoon" (NEVER "kar sakta hoon")

2. FOR CONVERSE AI (THE COMPANY / PLATFORM / PRODUCT — MASCULINE):
   - Converse AI is an enterprise AI software platform. In Hindi grammar, Converse AI is grammatically masculine:
     * "Converse AI customer support automate karta hai" (NEVER say "karti hai")
     * "Converse AI sales boost karne me help karta hai" (NEVER say "help karti hai")
     * "Converse AI voice bots aur WhatsApp workflows provide karta hai" (NEVER say "provide karti hai")
     * "Converse AI business processes streamline karta hai" (NEVER say "karti hai")

RESPONSE LENGTH & TONE (NATURAL & COMPLETE — 3 TO 4 SENTENCES):
- Deliver clear, conversational, and complete answers in 3 to 4 well-structured sentences (roughly 50 to 75 words).
- Do NOT make answers overly short or abrupt, and do NOT ramble into a monologue. Provide enough detail to directly and satisfactorily answer the question.
- Answer the user's specific question directly in the very first sentence.
- If user says "Thank you", "thanks", "dhanyawad", or says goodbye, respond warmly in 1-2 friendly sentences (e.g. "You're most welcome! Let me know if you need anything else!" or "Bahut shukriya! Aapka din shubh ho!").
- If asked for an example or case study, explain the client, what Converse AI did, and their key verified result clearly in 3-4 sentences.

CORE ROLE & BEHAVIOR:
- You are a knowledgeable, articulate, and confident conversational AI specialist having a real dialogue.
- Always use conversation history to understand context. Resolve short follow-ups like "example any", "aur batao", "how?", "details?", "case study", "pricing?" in the direct context of the preceding conversation.
- Never repeat greetings (e.g. "Namaste! Main Sonara hoon...") once the conversation is underway.
- Never force an unnecessary sales question at the end of every turn.
- Strict Honesty: Never hallucinate facts, statistics, integrations, client names, or fixed pricing. If information is not in your verified knowledge, say so honestly.
- Voice Naturalness: Spoken complete sentences only. NO markdown, NO asterisks, NO bullet points, NO headings.
- DEFINITIONAL QUESTIONS: When the user asks "what is X?", "what are X?", "explain X", "define X", ALWAYS explain what X actually IS first in your own words, then briefly how Converse AI implements it — strictly within 3-4 sentences.${definitionalGuard}

${ragContext}`;

        // Ensure clean, standard message history for Groq
        const formattedMessages = [
            { role: 'system', content: SYSTEM_PROMPT }
        ];

        // Filter and append conversation turns (keep last 12 turns)
        const recentTurns = messages.filter(m => m.role === 'user' || m.role === 'assistant').slice(-12);
        for (const turn of recentTurns) {
            formattedMessages.push({
                role: turn.role,
                content: String(turn.content || '').trim()
            });
        }

        // Verified live models available on this Groq account:
        // 1. qwen/qwen3.8-27b: High quality multilingual, natural Hindi & English
        // 2. openai/gpt-oss-20b: Ultra-fast 20B conversational model (<200ms)
        // 3. openai/gpt-oss-120b: High-capacity reasoning fallback
        const requestedModel = (model && (model.includes('qwen') || model.includes('gpt-oss'))) 
            ? model 
            : 'qwen/qwen3.8-27b';

        const candidateModels = [...new Set([
            requestedModel,
            'qwen/qwen3.8-27b',
            'openai/gpt-oss-20b',
            'openai/gpt-oss-120b'
        ])];

        const maxTokensClamped = Math.min(350, Math.max(120, Number(max_tokens) || 260));

        // ─── STREAMING PATH (SSE) — lets the client start TTS on the first sentence ───
        if (stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
            res.setHeader('Connection', 'keep-alive');
            if (typeof res.flushHeaders === 'function') res.flushHeaders();

            const sendEvent = (obj) => {
                res.write(`data: ${JSON.stringify(obj)}\n\n`);
            };

            let activeModel = null;
            let groqStreamRes = null;
            const modelErrors = [];

            // Find the first candidate that accepts the request (headers only — body not yet consumed)
            for (const candidate of candidateModels) {
                try {
                    const attemptRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${groqApiKey}`
                        },
                        body: JSON.stringify({
                            model: candidate,
                            messages: formattedMessages,
                            temperature: 0.15,
                            max_tokens: maxTokensClamped,
                            stream: true
                        })
                    });

                    if (attemptRes.ok) {
                        groqStreamRes = attemptRes;
                        activeModel = candidate;
                        break;
                    } else {
                        const errData = await attemptRes.json().catch(() => ({}));
                        const errMsg = errData.error?.message || `HTTP ${attemptRes.status}`;
                        modelErrors.push(`${candidate} (${attemptRes.status}): ${errMsg}`);

                        if (attemptRes.status === 401) {
                            sendEvent({ error: `Groq API Key Invalid: ${errMsg}` });
                            return res.end();
                        }
                        if (attemptRes.status === 429) {
                            sendEvent({ error: `Groq Rate Limit / Quota Exceeded: ${errMsg}` });
                            return res.end();
                        }
                        continue;
                    }
                } catch (err) {
                    modelErrors.push(`${candidate}: ${err.message}`);
                }
            }

            if (!groqStreamRes) {
                console.error('[Groq LLM] All models failed (stream):', modelErrors.join(' | '));
                sendEvent({ error: `Groq LLM failed: ${modelErrors.join('; ')}` });
                return res.end();
            }

            // Relay Groq's SSE token stream, sanitizing + enforcing the 4-sentence cap live
            let rawAccumulated = '';
            let emittedSentenceCount = 0;
            let stopped = false;
            let buffer = '';
            const decoder = new TextDecoder('utf-8');

            try {
                for await (const chunk of groqStreamRes.body) {
                    if (stopped) break;
                    // fetch() body chunks are raw Uint8Array — must decode, not string-concat directly
                    buffer += decoder.decode(chunk, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop(); // keep any incomplete trailing line for next iteration

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed.startsWith('data:')) continue;
                        const payload = trimmed.slice(5).trim();
                        if (payload === '[DONE]') { stopped = true; break; }

                        let json;
                        try { json = JSON.parse(payload); } catch (_) { continue; }
                        const delta = json.choices?.[0]?.delta?.content || '';
                        if (!delta) continue;

                        rawAccumulated += delta;

                        // Stop forwarding once we've already completed 4 sentences (keeps voice responses short)
                        if (emittedSentenceCount >= 4) { stopped = true; break; }

                        sendEvent({ delta });

                        // Count sentence terminators to enforce the cap going forward
                        const terminators = delta.match(/[.!?]+(?:\s|$)/g);
                        if (terminators) emittedSentenceCount += terminators.length;
                    }
                }
            } catch (err) {
                console.warn('[Groq LLM] Stream relay error:', err.message);
            }

            const cleanContent = sanitizeAiResponse(rawAccumulated);
            sendEvent({ done: true, text: cleanContent, model: activeModel, provider: 'groq' });
            return res.end();
        }

        // ─── NON-STREAMING PATH (legacy / default fallback) ───
        let activeModel = candidateModels[0];
        let groqData = null;
        const modelErrors = [];

        for (const candidate of candidateModels) {
            try {
                const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${groqApiKey}`
                    },
                    body: JSON.stringify({
                        model: candidate,
                        messages: formattedMessages,
                        temperature: 0.15,
                        max_tokens: maxTokensClamped
                    })
                });

                if (groqRes.ok) {
                    const data = await groqRes.json();
                    const content = (data.choices?.[0]?.message?.content || '').trim();
                    if (!content) {
                        console.warn(`[Groq LLM] Model ${candidate} returned empty content, trying next candidate...`);
                        modelErrors.push(`${candidate}: empty content`);
                        continue;
                    }
                    groqData = data;
                    activeModel = candidate;
                    break;
                } else {
                    const errData = await groqRes.json().catch(() => ({}));
                    const errMsg = errData.error?.message || `HTTP ${groqRes.status}`;
                    console.warn(`[Groq LLM] Model ${candidate} error (${groqRes.status}): ${errMsg}`);
                    modelErrors.push(`${candidate} (${groqRes.status}): ${errMsg}`);

                    // Auth failure — no other model will work with invalid key
                    if (groqRes.status === 401) {
                        return res.status(401).json({ error: `Groq API Key Invalid: ${errMsg}`, provider: 'groq' });
                    }
                    // Quota or rate limit exceeded — inform user directly
                    if (groqRes.status === 429) {
                        return res.status(429).json({ error: `Groq Rate Limit / Quota Exceeded: ${errMsg}`, provider: 'groq' });
                    }
                    continue;
                }
            } catch (err) {
                modelErrors.push(`${candidate}: ${err.message}`);
                console.warn(`[Groq LLM] Model ${candidate} exception:`, err.message);
            }
        }

        if (!groqData) {
            console.error('[Groq LLM] All models failed:', modelErrors.join(' | '));
            return res.status(502).json({
                error: `Groq LLM failed: ${modelErrors.join('; ')}`,
                provider: 'groq'
            });
        }


        const rawContent = groqData.choices?.[0]?.message?.content || '';
        const cleanContent = sanitizeAiResponse(rawContent);

        return res.status(200).json({
            text: cleanContent,
            model: activeModel,
            provider: 'groq'
        });


    } catch (err) {
        console.error('[API /api/chat] Server error:', err);
        if (res.headersSent) {
            try { res.write(`data: ${JSON.stringify({ error: 'Groq LLM request failed: ' + err.message })}\n\n`); } catch (_) {}
            return res.end();
        }
        return res.status(500).json({
            error: 'Groq LLM request failed: ' + err.message,
            provider: 'groq'
        });
    }
}