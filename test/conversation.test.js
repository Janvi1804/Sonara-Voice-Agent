/**
 * conversation.test.js
 * Semantic regression tests for Sonara LLM quality.
 * Verifies that definitional/conceptual queries return correct concept definitions,
 * not generic Converse AI service lists.
 *
 * Usage: node test/conversation.test.js
 * Requires: server running at http://localhost:3000 (or set TEST_BASE_URL)
 *
 * NOTE: Tests use semantic assertions — they do NOT hard-code expected sentences.
 */

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const API_URL = BASE_URL + '/api/chat';

let passed = 0;
let failed = 0;

async function chat(userText, history = []) {
    const messages = [...history, { role: 'user', content: userText }];
    const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, model: 'openai/gpt-oss-120b' })
    });
    if (!res.ok) { const e = await res.text(); throw new Error('API ' + res.status + ': ' + e); }
    const data = await res.json();
    return (data.text || '').toLowerCase();
}

function assert(label, response, checks) {
    const failures = [];
    for (const [desc, fn] of Object.entries(checks)) {
        if (!fn(response)) failures.push(desc);
    }
    if (failures.length === 0) {
        console.log('  PASS  ' + label);
        passed++;
    } else {
        console.log('  FAIL  ' + label);
        failures.forEach(f => console.log('    FAILED: ' + f));
        console.log('    Response: "' + response.slice(0, 200) + '..."');
        failed++;
    }
}

async function runTests() {
    console.log('\n================================================');
    console.log('  Sonara LLM Quality Semantic Regression Tests');
    console.log('  Endpoint: ' + API_URL);
    console.log('================================================\n');

    console.log('Test 1: what is a voice agent?');
    try {
        const r = await chat('what is a voice agent?');
        assert('Defines voice agent as a concept - NOT just company services', r, {
            'Contains definition keywords': t => /\b(automated?|software|system|handles|call|phone|speak|voice ai|interacts|conversation|answers?)\b/.test(t),
            'Does NOT respond with pure company service list': t => !/5\s+core\s+(enterprise\s+)?services/.test(t) && !/1\)\s+inbound/.test(t),
            'Mentions voice agent or AI agent concept': t => /\b(voice agent|ai agent|automated? (voice|call)|phone bot|conversational ai|virtual agent)\b/.test(t)
        });
    } catch (e) { console.log('  ERROR  Test 1: ' + e.message); failed++; }

    console.log('\nTest 2: what are voice agents?');
    try {
        const r = await chat('what are voice agents?');
        assert('Explains voice agents as a category/technology', r, {
            'Explains what voice agents are': t => /\b(automated?|handle|phone|call|customer|interact|system|conversation|respond)\b/.test(t),
            'Does not open with Converse AI services enumeration': t => !/converse\s*ai\s+(provides|offers|has)\s+\d/.test(t)
        });
    } catch (e) { console.log('  ERROR  Test 2: ' + e.message); failed++; }

    console.log('\nTest 3: what is RAG?');
    try {
        const r = await chat('what is RAG?');
        assert('Defines RAG as a technical concept', r, {
            'Mentions retrieval or knowledge retrieval': t => /\b(retrieval|retriev|knowledge base|document|index|search|external)\b/.test(t),
            'Mentions generation or language model': t => /\b(generat|language model|llm|ai model|response)\b/.test(t),
            'Does not respond with 5 core services company list': t => !/5\s+core/.test(t)
        });
    } catch (e) { console.log('  ERROR  Test 3: ' + e.message); failed++; }

    console.log('\nTest 4: what is WhatsApp automation?');
    try {
        const r = await chat('what is WhatsApp automation?');
        assert('Defines WhatsApp automation as a concept', r, {
            'Mentions automation or automated': t => /\b(automat|messages?|workflow|bot|chatbot|respond|reply|send)\b/.test(t),
            'References WhatsApp platform': t => /whatsapp/.test(t),
            'Not a pure generic-services response': t => !/5\s+core\s+(enterprise\s+)?services/.test(t)
        });
    } catch (e) { console.log('  ERROR  Test 4: ' + e.message); failed++; }

    console.log('\nTest 5: what services do you offer? (positive case)');
    try {
        const r = await chat('what services do you offer?');
        assert('Services question returns relevant Converse AI services', r, {
            'Mentions at least one core service': t => /\b(voice|whatsapp|omnichannel|rag|automation|chatbot|workflow)\b/.test(t),
            'References Converse AI context': t => /\b(converse\s*ai|sonara|we (offer|provide|build))\b/.test(t)
        });
    } catch (e) { console.log('  ERROR  Test 5: ' + e.message); failed++; }

    console.log('\nTest 6: Multi-turn define RAG then ask does Converse AI use it?');
    try {
        const history = [
            { role: 'user', content: 'what is RAG?' },
            { role: 'assistant', content: 'RAG stands for Retrieval-Augmented Generation, a technique where an AI model retrieves relevant documents from a knowledge base and uses them to generate accurate, grounded responses.' }
        ];
        const r = await chat('does Converse AI use it?', history);
        assert('Follow-up about Converse AI usage answers in company context', r, {
            'Mentions Converse AI or affirmative usage': t => /\b(converse\s*ai|yes|we use|we do|rag|knowledge|documents?|internal)\b/.test(t)
        });
    } catch (e) { console.log('  ERROR  Test 6: ' + e.message); failed++; }

    console.log('\nTest 7: Greeting does not produce definition');
    try {
        const r = await chat('Hello');
        assert('Greeting returns a greeting not a concept definition', r, {
            'Contains a greeting or welcome': t => /\b(hello|hi|namaste|welcome|how can i help|sonara)\b/.test(t),
            'Does not immediately define voice agents without being asked': t => !/a voice agent is/.test(t)
        });
    } catch (e) { console.log('  ERROR  Test 7: ' + e.message); failed++; }

    console.log('\nTest 8: Pricing question returns pricing info');
    try {
        const r = await chat('how much does it cost?');
        assert('Pricing question returns custom pricing approach', r, {
            'Mentions custom or bespoke pricing': t => /\b(custom|bespoke|requirement|scope|business|quote|audit|free)\b/.test(t),
            'Does not return concept definitions instead': t => !/a voice agent is/.test(t)
        });
    } catch (e) { console.log('  ERROR  Test 8: ' + e.message); failed++; }

    console.log('\nTest 9: Hinglish voice agent kya hota hai?');
    try {
        const r = await chat('voice agent kya hota hai?');
        assert('Hinglish definitional question returns concept explanation', r, {
            'Response is in Hinglish or Hindi': t => /\b(hai|ek|jo|aur|ka|ke|ki|karta|hota|matlab|yani|call|voice)\b/.test(t),
            'Not a pure company services list': t => !/5\s+core/.test(t)
        });
    } catch (e) { console.log('  ERROR  Test 9: ' + e.message); failed++; }

    console.log('\nTest 10: Adaptive length - definition is 2-10 sentences');
    try {
        const r = await chat('what is an AI chatbot?');
        const sentences = (r.match(/[.!?]+\s/g) || []).length + 1;
        assert('Definition response is adaptive length', r, {
            'At least 2 sentences (not a one-liner)': () => sentences >= 2,
            'No more than 10 sentences (not an essay)': () => sentences <= 10
        });
    } catch (e) { console.log('  ERROR  Test 10: ' + e.message); failed++; }

    console.log('\n================================================');
    console.log('  Results: ' + passed + ' passed, ' + failed + ' failed out of ' + (passed + failed) + ' tests');
    console.log('================================================\n');
    if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error('Test runner error:', err.message); process.exit(1); });
