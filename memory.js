/**
 * Multi-Turn Conversation Memory & Entity Extraction Engine
 * Extracts and tracks customer details, appointment preferences, and intent across conversation turns.
 */

export class ConversationMemory {
    constructor() {
        this.sessionId = `session_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        this.entities = {
            customerName: null,
            phone: null,
            email: null,
            company: null,
            service: null, // AI Strategy Audit, Voice Agent, WhatsApp Bot, Custom AI
            targetDate: null,
            targetTime: null,
            appointmentId: null,
            userIntent: null,
            notes: []
        };
        this.turnHistory = [];
    }

    /**
     * Update memory from user speech turn
     */
    extractEntities(text) {
        if (!text || typeof text !== 'string') return;
        const lower = text.toLowerCase();

        // 1. Phone number extraction (Indian 10-digit & international patterns)
        const phoneMatch = text.match(/(?:\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}|\b\d{10}\b/);
        if (phoneMatch) {
            this.entities.phone = phoneMatch[0].replace(/[\s-]/g, '');
        }

        // 2. Email extraction
        const emailMatch = text.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/);
        if (emailMatch) {
            this.entities.email = emailMatch[0].toLowerCase();
        }

        // 3. Name extraction ("mera naam X hai", "I am X", "My name is X", "This is X")
        const nameMatch = text.match(/(?:mera naam|my name is|i am|this is)\s+([A-Za-z]{2,20})/i);
        if (nameMatch && nameMatch[1]) {
            const forbiddenNames = ['converse', 'sonara', 'interested', 'here', 'calling', 'looking'];
            if (!forbiddenNames.includes(nameMatch[1].toLowerCase())) {
                this.entities.customerName = nameMatch[1];
            }
        }

        // 4. Service intent extraction
        if (lower.includes('audit') || lower.includes('readiness') || lower.includes('strategy')) {
            this.entities.service = 'AI Strategy & Readiness Audit';
            this.entities.userIntent = 'Book AI Audit';
        } else if (lower.includes('voice') || lower.includes('calling') || lower.includes('call bot')) {
            this.entities.service = 'AI Voice Agents';
            this.entities.userIntent = 'Voice Bot Inquiry';
        } else if (lower.includes('whatsapp') || lower.includes('wa bot')) {
            this.entities.service = 'WhatsApp AI Automation';
            this.entities.userIntent = 'WhatsApp Automation';
        } else if (lower.includes('appointment') || lower.includes('demo') || lower.includes('booking') || lower.includes('book')) {
            this.entities.userIntent = 'Book Demo / Consultation';
        }

        // 5. Date extraction ("kal", "aaj", "tomorrow", "today", "monday", "25 august")
        if (lower.includes('kal') || lower.includes('tomorrow')) {
            const d = new Date();
            d.setDate(d.getDate() + 1);
            this.entities.targetDate = d.toISOString().split('T')[0];
        } else if (lower.includes('aaj') || lower.includes('today')) {
            this.entities.targetDate = new Date().toISOString().split('T')[0];
        } else {
            const dateRegex = /\b(\d{4}-\d{2}-\d{2}|\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)\b/i;
            const dm = text.match(dateRegex);
            if (dm) this.entities.targetDate = dm[0];
        }

        // 6. Time extraction ("3 baje", "11 am", "4:30 pm", "shaam 5 baje", "dopahar 2 baje")
        const timeMatch = text.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm|baje|o'clock))\b/i);
        if (timeMatch) {
            this.entities.targetTime = timeMatch[0];
        }
    }

    /**
     * Record a turn in memory
     */
    addTurn(role, text) {
        this.turnHistory.push({
            role,
            content: text,
            timestamp: new Date().toISOString()
        });
        if (role === 'user') {
            this.extractEntities(text);
        }
    }

    /**
     * Format active memory prompt for LLM context
     */
    getMemoryPrompt() {
        const known = [];
        if (this.entities.customerName) known.push(`Customer Name: ${this.entities.customerName}`);
        if (this.entities.phone) known.push(`Phone: ${this.entities.phone}`);
        if (this.entities.email) known.push(`Email: ${this.entities.email}`);
        if (this.entities.company) known.push(`Company: ${this.entities.company}`);
        if (this.entities.service) known.push(`Interested Service: ${this.entities.service}`);
        if (this.entities.targetDate) known.push(`Target Date: ${this.entities.targetDate}`);
        if (this.entities.targetTime) known.push(`Target Time: ${this.entities.targetTime}`);
        if (this.entities.appointmentId) known.push(`Active Appointment ID: ${this.entities.appointmentId}`);

        if (known.length === 0) return '';

        return `\n--- ACTIVE CONVERSATION MEMORY (Known Entities) ---\n${known.join('\n')}\n(Use these details directly; DO NOT ask the customer to repeat information they have already provided!)\n`;
    }

    /**
     * Clear active session memory
     */
    reset() {
        this.sessionId = `session_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        this.entities = {
            customerName: null,
            phone: null,
            email: null,
            company: null,
            service: null,
            targetDate: null,
            targetTime: null,
            appointmentId: null,
            userIntent: null,
            notes: []
        };
        this.turnHistory = [];
    }
}
