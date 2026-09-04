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
    title: "Verified Case Studies & Client Results",
    keywords: ["case study", "case studies", "results", "example", "examples", "proof", "metrics", "stylemart", "learnsphere", "carefirst"],
    content: "ConverseAI has 3 verified enterprise case studies: 1) StyleMart India (Retail): Deployed WhatsApp AI Chatbot, driving 3x repeat purchase revenue, 65% reduction in customer support costs, under 30s response time, and 94% CSAT. 2) LearnSphere (EdTech): Automated lead qualification bot doubled course enrolments in 90 days, cut response times by 80%, qualified 500+ leads daily, and lowered cost per qualified lead by 45%. 3) CareFirst Clinics (Healthcare): Unified patient communication over WhatsApp and web chat, slashing appointment no-shows by 55%, saving 120 admin hours monthly, with a 91% booking fill rate and +28 point NPS increase."
  },
  {
    id: "theconverseai-pricing",
    title: "ConverseAI Pricing & Free Opportunity Audit",
    keywords: ["pricing", "price", "cost", "how much", "charges", "rate", "packages", "quote", "subscription", "plans"],
    content: "ConverseAI uses custom, bespoke pricing based on specific business workflows, scale, integrations, and usage requirements. We do not have rigid one-size-fits-all tiers. Every partnership starts with a 100% Free AI Opportunity & Readiness Audit (bookable at theconverseai.com/book-demo) where our engineers assess your systems and deliver a clear build plan and ROI estimate with zero overhead."
  },
  {
    id: "theconverseai-clients",
    title: "ConverseAI Enterprise Clients",
    keywords: ["clients", "customers", "who uses", "companies", "tata motors", "mapsor", "zapp loans", "meghaa modi", "readiprint", "heritage food diary"],
    content: "ConverseAI is trusted by leading enterprise clients including Tata Motors, Mapsor Experiential Weddings, Zapp Loans, Meghaa Modi Design Studio, Readiprint Fashions, and Heritage Food Diary, alongside 500+ businesses worldwide."
  },
  {
    id: "theconverseai-stats",
    title: "Performance Metrics & Scale",
    keywords: ["stats", "metrics", "numbers", "messages automated", "open rate", "languages"],
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

// Clean think tags and markdown
function sanitizeAiResponse(text) {
    if (!text) return '';
    return text
        .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
        .replace(/[*_#`~[\]]/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
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
            model = 'llama-3.3-70b-versatile',
            temperature = 0.65,
            max_tokens = 650
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
            ? `\n\nIMPORTANT — THIS IS A DEFINITIONAL QUESTION: The user asked "${lastUserMsg.trim()}". Your response MUST start by explaining what the concept or technology actually IS in clear, plain language (2-4 sentences). Only after defining the concept may you mention how Converse AI implements or uses it. The company context below is SUPPLEMENTARY — it is NOT the answer. Do NOT answer a definition question with a list of Converse AI services.`
            : '';

        // Production-Grade System Prompt for SONARA
        const SYSTEM_PROMPT = `You are Sonara, the official Conversational AI Solutions Specialist for Converse AI by Revti Digital, India (theconverseai.com).

CORE ROLE & BEHAVIOR:
- You are a knowledgeable, articulate, and confident conversational AI specialist having a real dialogue, NOT a robotic FAQ responder.
- Answer the user's actual question directly first, providing helpful, substantive detail without being artificial or curt.
- Always use the conversation history to understand context. Resolve short follow-ups like "example any", "aur batao", "how?", "details?", "case study", "pricing?" in the direct context of the preceding conversation.
- If the user asks for examples or case studies, explain them clearly: identify the business, the challenge, how Converse AI was deployed, the verified metrics, and the business impact.
- Do NOT give robotic one-sentence answers. Use adaptive answer length:
  * Simple factual answers: 2-4 clear sentences.
  * Explanations & overviews: 4-7 informative sentences.
  * Case studies: Comprehensive breakdown with verified problem, solution, and outcome.
- Never repeat greetings (e.g. "Namaste! Main Sonara hoon...") once the conversation is underway.
- Never force an unnecessary sales question or "Aap kis me interested hain?" at the end of every turn. Only ask a natural follow-up question when genuinely appropriate.
- Language Matching:
  * English user input -> Fluent, professional English response.
  * Hindi user input -> Natural Hindi.
  * Hinglish user input -> Warm, natural conversational Hinglish.
- Strict Honesty: Never hallucinate facts, statistics, integrations, client names, or fixed pricing. If information is not in your verified knowledge, say so honestly.
- Voice Naturalness: Spoken complete sentences only. NO markdown, NO asterisks, NO bullet points, NO headings.
- DEFINITIONAL QUESTIONS: When the user asks "what is X?", "what are X?", "explain X", "define X", or similar concept-level questions, ALWAYS explain what X actually IS as a concept or technology first (in your own words, drawing on your training knowledge). Then, if directly relevant, you may mention how Converse AI implements it. Never substitute a concept definition with a Converse AI services list.${definitionalGuard}

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

        // Candidate Groq models to try (prioritizing requested model, with fallback to verified available Groq models)
        const candidateModels = [...new Set([
            model,
            'llama-3.3-70b-versatile',
            'openai/gpt-oss-120b',
            'qwen/qwen3.8-27b'
        ].filter(Boolean))];

        let activeModel = candidateModels[0];
        let groqData = null;
        let lastError = '';

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
                        temperature: Number(temperature) || 0.65,
                        max_tokens: Math.max(350, Number(max_tokens) || 450)
                    })
                });

                if (groqRes.ok) {
                    groqData = await groqRes.json();
                    activeModel = candidate;
                    break;
                } else {
                    const errData = await groqRes.json().catch(() => ({}));
                    const errMsg = errData.error?.message || `Groq error status ${groqRes.status}`;
                    lastError = errMsg;
                    // If model doesn't exist (404), try the next candidate on Groq
                    if (groqRes.status === 404 || errMsg.toLowerCase().includes('does not exist')) {
                        console.warn(`[Groq LLM] Model ${candidate} not available, trying next Groq model...`);
                        continue;
                    }
                    // For rate limits (429) or auth errors (401), exit immediately
                    return res.status(groqRes.status).json({
                        error: `Groq LLM failed: ${errMsg}`,
                        provider: 'groq'
                    });
                }
            } catch (err) {
                lastError = err.message;
            }
        }

        if (!groqData) {
            console.error('[Groq LLM] All Groq candidate models failed. Last error:', lastError);
            return res.status(502).json({
                error: `Groq LLM failed: ${lastError}`,
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
        return res.status(500).json({
            error: 'Groq LLM request failed: ' + err.message,
            provider: 'groq'
        });
    }
}