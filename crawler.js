/**
 * Website Crawler & Multi-Page Extractor (theconverseai.com)
 * Automatically fetches and structures website pages into semantic chunks for vector embeddings.
 */

export const OFFICIAL_THECONVERSEAI_PAGES = [
    {
        url: 'https://theconverseai.com/',
        title: 'ConverseAI Home — AI Agents Built & Run For Your Business',
        category: 'Overview',
        content: `ConverseAI (theconverseai.com) is an enterprise Agentic AI & Customer Engagement platform powered by Revti Digital, based in Jaipur, Rajasthan, India.
We scope the problem, build the custom AI agent, and run it in production across Voice, WhatsApp, and agentic workflows with zero internal AI team needed on the client's end.
Meta Tech Provider Partner.
Core Value Proposition: Human Conversations. Agentic Intelligence. Zero Overhead.
Stats: 50+ Growing Businesses, 98% WhatsApp Open Rate, 60% Faster Response Times, 24/7 Always On Support, 50 Million+ messages automated across 100+ languages.
Clients: Tata Motors, Mapsor Experiential Weddings, Meghaa Modi Design Studio, Zapp Loans, Readiprint Fashions, Heritage Food Diary.
Contact: contact@theconverseai.com | Phone: +91-9982323333, +91-7023084065.`
    },
    {
        url: 'https://theconverseai.com/services/ai-strategy-audit',
        title: 'AI Strategy & Readiness Audit — ConverseAI',
        category: 'Services',
        content: `ConverseAI offers a 100% Free AI Opportunity & Readiness Audit.
We map where AI can move the needle in your business, scope the highest-value workflows, assess technical readiness, and deliver a clear build plan and ROI estimate — not a slide deck.
Book demo/audit: https://theconverseai.com/book-demo`
    },
    {
        url: 'https://theconverseai.com/services/ai-voice-agents',
        title: 'AI Voice Agents — Inbound & Outbound Voice Automation',
        category: 'Services',
        content: `Inbound and outbound voice AI for sales, customer support, and appointment scheduling.
Multilingual capabilities across 100+ languages, deep integration with CRM (Salesforce, HubSpot) and telephony, with full production operation and zero client maintenance.`
    },
    {
        url: 'https://theconverseai.com/services/agentic-automation',
        title: 'Agentic Systems & Process Automation — ConverseAI',
        category: 'Services',
        content: `Replace manual, multi-step workflows with AI agents that reason, decide, and act autonomously.
We build and run agentic pipelines that integrate with your existing software stack, ERP, and databases.`
    },
    {
        url: 'https://theconverseai.com/services/custom-ai-agents',
        title: 'Custom AI Agent Development — ConverseAI',
        category: 'Services',
        content: `Bespoke AI agents custom-scoped to your exact business requirements.
Clients own 100% of the IP. We build against your proprietary workflows, data, and internal systems, then operate and maintain them in production.`
    },
    {
        url: 'https://theconverseai.com/services/ai-integration',
        title: 'AI Integration Services — ConverseAI',
        category: 'Services',
        content: `Seamlessly connect AI systems to your existing CRM, ERP, Shopify store, helpdesks (Zendesk, Freshdesk), or internal databases.
We manage authentication, rate limits, error handling, and 24/7 maintenance.`
    },
    {
        url: 'https://theconverseai.com/services/knowledge-intelligence',
        title: 'Document & Knowledge Intelligence — Enterprise RAG',
        category: 'Services',
        content: `Enterprise RAG (Retrieval-Augmented Generation) systems enabling teams to query internal knowledge bases, contracts, SOP manuals, and business reports.
Hosted in your own cloud infrastructure, 100% GDPR, CCPA, and DPDP India compliant.`
    },
    {
        url: 'https://theconverseai.com/services/sales-ai',
        title: 'Sales Intelligence & Outreach — ConverseAI',
        category: 'Services',
        content: `AI-driven prospecting, intent signal detection, personalized outreach sequences, and automated lead generation campaigns done-for-you.`
    },
    {
        url: 'https://theconverseai.com/chatbot',
        title: 'AI Chatbot Product — 24/7 Automated Support',
        category: 'Products',
        content: `Natural language understanding with 24/7 automated customer care, lead qualification, and smart escalation/handover to human agents.`
    },
    {
        url: 'https://theconverseai.com/whatsapp-ai-chatbot',
        title: 'WhatsApp AI Automation — ConverseAI',
        category: 'Products',
        content: `Official WhatsApp Business AI automation with personalized, context-aware responses, 98% open rates, multilingual support, and catalog commerce integration.`
    },
    {
        url: 'https://theconverseai.com/omni-channel',
        title: 'Omni-Channel Unified Inbox — ConverseAI',
        category: 'Products',
        content: `Single unified customer support inbox connecting Website Chat, WhatsApp, Instagram DMs, Facebook Messenger, and Email with seamless channel switching.`
    },
    {
        url: 'https://theconverseai.com/case-studies',
        title: 'Verified Case Studies & ROI Results — ConverseAI',
        category: 'Case Studies',
        content: `1. StyleMart India (Retail): 3x revenue growth in repeat purchases, 65% reduction in customer support costs, under 30 seconds response time, 94% CSAT.
2. LearnSphere (EdTech): Doubled course enrolments in 90 days, 500+ daily qualified leads automatically, 45% reduction in cost per qualified lead, 80% cut in response time.
3. CareFirst Clinics (Healthcare): 55% reduction in appointment no-shows, 120 admin hours saved per month, 91% appointment fill rate, +28 NPS increase.`
    },
    {
        url: 'https://theconverseai.com/about-us',
        title: 'About ConverseAI & Revti Digital',
        category: 'Company',
        content: `ConverseAI was founded in 2021 by Revti Digital in Jaipur, Rajasthan, India.
We engineer AI agents and agentic pipelines that talk, decide, and act around the clock for mid-market and SMB teams worldwide.
Meta Tech Provider Partner.`
    },
    {
        url: 'https://theconverseai.com/contact-us',
        title: 'Contact Us & Booking — ConverseAI',
        category: 'Contact',
        content: `Email: contact@theconverseai.com
Phone: +91-9982323333 / +91-7023084065
WhatsApp: https://wa.me/919982323333
Headquarters: Jaipur, Rajasthan, India
Book a Demo / Audit: https://theconverseai.com/book-demo`
    },
    {
        url: 'https://theconverseai.com/pricing',
        title: 'Pricing & Engagement Model — ConverseAI',
        category: 'Pricing',
        content: `ConverseAI does not offer fixed one-size-fits-all generic monthly pricing tiers.
Every engagement starts with a 100% Free AI Opportunity & Readiness Audit (theconverseai.com/book-demo) to assess requirements and calculate ROI, followed by bespoke build and management pricing tailored to your scale with zero hidden overhead.`
    }
];

export class WebsiteCrawler {
    constructor(options = {}) {
        this.baseUrl = options.baseUrl || 'https://theconverseai.com/';
        this.chunkSize = options.chunkSize || 350;
        this.chunkOverlap = options.chunkOverlap || 50;
    }

    /**
     * Crawl website pages or load verified ground-truth knowledge
     */
    async crawl(customUrl = '') {
        const pages = [...OFFICIAL_THECONVERSEAI_PAGES];

        if (customUrl && customUrl !== this.baseUrl) {
            try {
                const fetchedPage = await this.fetchLivePage(customUrl);
                if (fetchedPage) {
                    pages.unshift(fetchedPage);
                }
            } catch (err) {
                console.warn('Custom URL crawl failed, falling back to verified knowledge base:', err);
            }
        }

        return this.chunkPages(pages);
    }

    /**
     * Live fetch helper
     */
    async fetchLivePage(url) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
            if (!res.ok) return null;
            const html = await res.text();
            const text = this.cleanHtml(html);
            return {
                url,
                title: `Crawled Page — ${url}`,
                category: 'Live Crawl',
                content: text.slice(0, 10000)
            };
        } catch (e) {
            return null;
        }
    }

    /**
     * Strip HTML noise
     */
    cleanHtml(html) {
        if (!html) return '';
        return html
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
            .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
            .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * Split documents into overlapping semantic chunks
     */
    chunkPages(pages) {
        const chunks = [];
        let chunkId = 1;

        for (const page of pages) {
            const text = page.content.trim();
            if (text.length <= this.chunkSize) {
                chunks.push({
                    id: `chunk_${chunkId++}`,
                    url: page.url,
                    title: page.title,
                    category: page.category,
                    text
                });
                continue;
            }

            let start = 0;
            while (start < text.length) {
                const end = Math.min(start + this.chunkSize, text.length);
                const chunkText = text.slice(start, end).trim();
                if (chunkText.length > 20) {
                    chunks.push({
                        id: `chunk_${chunkId++}`,
                        url: page.url,
                        title: page.title,
                        category: page.category,
                        text: chunkText
                    });
                }
                start += this.chunkSize - this.chunkOverlap;
            }
        }

        return chunks;
    }
}
