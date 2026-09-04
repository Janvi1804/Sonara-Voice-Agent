/**
 * Conversation endpoint for Sonara.
 * The server owns the Groq configuration and builds the complete LLM context.
 */
import { setCorsHeaders, checkRateLimit } from './_utils.js';

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_GROQ_MODEL = 'llama-3.3-70b-versatile';
const MAX_HISTORY_MESSAGES = 12;
const MAX_MESSAGE_CHARS = 1_200;
const MAX_RAG_CHARS = 3_200;

const KNOWLEDGE = [
    ['services', ['service', 'offer', 'product', 'voice agent', 'whatsapp', 'chatbot', 'rag', 'integration'], 'Converse AI builds AI chatbots, WhatsApp automation, inbound and outbound voice agents, omnichannel support, CRM and ERP integrations, enterprise RAG, and agentic workflow automation.'],
    ['pricing', ['price', 'pricing', 'cost', 'charge', 'fee', 'quote', 'package', 'plan', 'kitna'], 'Converse AI uses bespoke pricing based on the workflow, integrations, usage, and implementation scope. Every engagement starts with a free AI Opportunity and Readiness Audit.'],
    ['stylemart', ['stylemart'], 'StyleMart India achieved a three-times increase in repeat-purchase revenue and a 65 percent reduction in support costs with Converse AI.'],
    ['learnsphere', ['learnsphere'], 'LearnSphere doubled course enrolments in 90 days and reduced lead response time by 80 percent.'],
    ['carefirst', ['carefirst'], 'CareFirst Clinics reduced appointment no-shows by 55 percent and improved patient satisfaction by 28 NPS points.'],
    ['contact', ['contact', 'email', 'phone', 'call you', 'reach'], 'The official contact details are contact@theconverseai.com, +91-9982323333, and +91-7023084065. Converse AI is operated by Revti Digital in India.'],
    ['company', ['converse ai', 'converseai', 'revti', 'what do you do', 'about you'], 'Converse AI, operated by Revti Digital, designs and runs bespoke agentic AI systems for voice, WhatsApp, and automated customer workflows.']
];

export function normalizeConversation(messages) {
    if (!Array.isArray(messages)) return [];
    return messages
        .filter((message) => message && (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string')
        .map(({ role, content }) => ({ role, content: content.replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE_CHARS) }))
        .filter((message) => message.content)
        .slice(-MAX_HISTORY_MESSAGES);
}

export function responseTokenBudget(value) {
    const requested = Number.parseInt(value, 10);
    if (!Number.isFinite(requested)) return 120;
    return Math.max(40, Math.min(requested, 180));
}

export function retrieveRAGContext(query = '') {
    const normalized = String(query).toLowerCase();
    const terms = normalized.match(/[a-z0-9]{3,}/g) || [];
    const matches = KNOWLEDGE.map(([id, keywords, content]) => ({
        id,
        content,
        score: keywords.reduce((score, keyword) => score + (normalized.includes(keyword) ? 4 : 0), 0)
            + terms.reduce((score, term) => score + (content.toLowerCase().includes(term) ? 1 : 0), 0)
    })).filter((item) => item.score >= 4).sort((a, b) => b.score - a.score).slice(0, 3);

    if (!matches.length) return '';
    return matches.map((item, index) => `Source ${index + 1}: ${item.content}`).join('\n').slice(0, MAX_RAG_CHARS);
}

export function mergeRagContext(retrievedContext = '', suppliedContext = '') {
    const cleanSupplied = String(suppliedContext || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_RAG_CHARS);
    return [retrievedContext, cleanSupplied].filter(Boolean).join('\n').slice(0, MAX_RAG_CHARS);
}

export function buildSystemPrompt(ragContext = '') {
    return `You are Sonara, Converse AI by Revti Digital's warm, accurate voice solutions specialist.

Voice response rules:
- Reply in the user's language; use natural Roman-script Hinglish when they use Hindi or Hinglish.
- Answer the current question first in one to three short spoken sentences. No markdown, lists, headings, emojis, tags, or internal commentary.
- Use the prior conversation to resolve references such as "that", "it", "the second one", and "what about it". Never greet again after the first greeting or ask for information already supplied.
- Ask exactly one specific follow-up only when it would help progress a business requirement, booking, or unclear request. Do not add a follow-up after a complete factual answer, a clear goodbye, or when the user has declined.
- Do not invent pricing, availability, integrations, results, clients, or actions. Say when a verified detail is unavailable.
- Only confirm a booking or other action when an explicit tool result in the conversation says it succeeded.

Verified company knowledge:
${ragContext || 'No retrieved source applies. Give a concise general answer and do not claim unverified company facts.'}`;
}

export function sanitizeAiResponse(text) {
    const cleaned = String(text || '')
        .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
        .replace(/<[^>]*>/g, '')
        .replace(/[\r\n]+/g, ' ')
        .replace(/[*_#`]/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
    if (!cleaned) return '';
    // Preserve a short, listenable answer even if a provider ignores the prompt.
    const sentences = cleaned.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [cleaned];
    return sentences.slice(0, 3).join(' ').replace(/\s{2,}/g, ' ').trim().slice(0, 650);
}

export function contextualFallback(history, query, ragContext) {
    const lower = String(query).toLowerCase();
    if (/\b(bye|goodbye|alvida|bas itna)\b/.test(lower)) return 'Thank you for speaking with Converse AI. Take care.';
    if (ragContext) return ragContext.split('\n')[0].replace(/^Source 1: /, '');
    const previousUser = [...history].reverse().find((message) => message.role === 'user' && message.content !== query)?.content;
    if (/\b(that|it|this|second one|uska|iske)\b/.test(lower) && previousUser) {
        return `I can help with the point you just raised about ${previousUser.slice(0, 110)}. Which outcome matters most to your business?`;
    }
    return 'I can help with Converse AI solutions, pricing approach, or a free AI Opportunity and Readiness Audit. What would you like to explore?';
}

export default async function handler(req, res) {
    const corsAllowed = setCorsHeaders(req, res, 'POST, OPTIONS');
    if (req.method === 'OPTIONS') return corsAllowed ? res.status(200).end() : res.status(403).json({ error: 'Forbidden: CORS origin not allowed.' });
    if (!corsAllowed && req.headers.origin) return res.status(403).json({ error: 'Forbidden: CORS origin not allowed.' });
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });
    if (!checkRateLimit(req, { maxRequests: 60, windowMs: 60_000 })) return res.status(429).json({ error: 'Rate limit exceeded. Please slow down.' });

    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
        const history = normalizeConversation(body.messages);
        const latestUserMessage = [...history].reverse().find((message) => message.role === 'user')?.content || '';
        if (!latestUserMessage) return res.status(400).json({ error: 'A user message is required.' });

        const ragContext = body.ragEnabled === false ? '' : mergeRagContext(retrieveRAGContext(latestUserMessage), body.ragContext);
        const messages = [{ role: 'system', content: buildSystemPrompt(ragContext) }, ...history];
        const groqApiKey = process.env.GROQ_API_KEY;
        const model = process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL;
        const max_completion_tokens = responseTokenBudget(body.max_tokens);

        if (groqApiKey) {
            const groqResponse = await fetch(GROQ_ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${groqApiKey}` },
                body: JSON.stringify({ model, messages, temperature: 0.45, max_completion_tokens }),
                signal: AbortSignal.timeout(8_000)
            });
            if (groqResponse.ok) {
                const data = await groqResponse.json();
                const text = sanitizeAiResponse(data.choices?.[0]?.message?.content);
                if (text) return res.status(200).json({ text, model, provider: 'groq' });
            } else {
                console.warn('Groq completion failed:', groqResponse.status);
            }
        }

        return res.status(200).json({ text: contextualFallback(history, latestUserMessage, ragContext), provider: 'contextual-fallback' });
    } catch (error) {
        console.error('Chat API error:', error.message);
        return res.status(200).json({ text: 'I am sorry, I could not complete that response. Please try again.', provider: 'recovery' });
    }
}
