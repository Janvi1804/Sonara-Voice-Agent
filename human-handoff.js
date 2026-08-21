/**
 * Human Handoff & Live Support Escalation Manager
 * Handles graceful transfer of conversation from AI to human specialists at Converse AI.
 */

export class HumanHandoffManager {
    constructor(options = {}) {
        this.supportPhone = options.supportPhone || '+91-9982323333';
        this.supportEmail = options.supportEmail || 'contact@theconverseai.com';
        this.whatsappUrl = options.whatsappUrl || 'https://wa.me/919982323333';
        this.isEscalated = false;
        this.escalationDetails = null;
        this.onEscalate = options.onEscalate || (() => {});
    }

    /**
     * Trigger human escalation
     */
    escalate(reason = 'Customer requested human agent', conversationHistory = [], customer = {}) {
        this.isEscalated = true;
        this.escalationDetails = {
            id: `ESC-${Date.now()}`,
            reason,
            timestamp: new Date().toISOString(),
            customer,
            transcript: conversationHistory
        };

        this.onEscalate(this.escalationDetails);
        return {
            escalated: true,
            details: this.escalationDetails,
            handoffMessage: `Maine aapki call Converse AI ke human specialist team ko forward kar di hai. Aap humein directly WhatsApp ya call par bhi connect kar sakte hain: ${this.supportPhone}.`
        };
    }

    /**
     * Reset escalation state
     */
    reset() {
        this.isEscalated = false;
        this.escalationDetails = null;
    }
}
