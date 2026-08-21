/**
 * Tool Calling & Action Execution Engine
 * Executes actual business actions against Customer DB, Appointment DB, and Human Escalation.
 */

import { AppointmentDB } from './appointment-db.js';
import { CustomerDB } from './customer-db.js';

export class ToolCallingEngine {
    constructor(options = {}) {
        this.appointmentDB = options.appointmentDB || new AppointmentDB(options);
        this.customerDB = options.customerDB || new CustomerDB(options);
        this.onToolExecuted = options.onToolExecuted || (() => {});
        this.onHumanHandoff = options.onHumanHandoff || (() => {});
    }

    /**
     * Tool Definitions for LLM Schema
     */
    getToolDefinitions() {
        return [
            {
                name: 'check_availability',
                description: 'Check available consultation time slots for a given date before booking.',
                parameters: {
                    type: 'object',
                    properties: {
                        date: { type: 'string', description: 'Date in YYYY-MM-DD or spoken format (e.g. tomorrow, 2026-08-25)' },
                        time: { type: 'string', description: 'Optional preferred time (e.g. 11:30 AM, 3:30 PM)' }
                    },
                    required: ['date']
                }
            },
            {
                name: 'book_appointment',
                description: 'Book a confirmed consultation or Free AI Opportunity Audit for the customer.',
                parameters: {
                    type: 'object',
                    properties: {
                        customerName: { type: 'string', description: 'Customer full name' },
                        phone: { type: 'string', description: 'Customer 10-digit phone number' },
                        email: { type: 'string', description: 'Customer email address' },
                        service: { type: 'string', description: 'Requested service (e.g. Free AI Strategy Audit, AI Voice Agent, WhatsApp Bot)' },
                        date: { type: 'string', description: 'Booking date (YYYY-MM-DD)' },
                        time: { type: 'string', description: 'Booking time slot (e.g. 11:30 AM, 02:00 PM, 03:30 PM)' }
                    },
                    required: ['customerName', 'phone', 'date', 'time']
                }
            },
            {
                name: 'cancel_appointment',
                description: 'Cancel an existing appointment using appointment ID or customer phone.',
                parameters: {
                    type: 'object',
                    properties: {
                        appointmentId: { type: 'string', description: 'Appointment ID (e.g. APPT-1234)' },
                        phone: { type: 'string', description: 'Customer phone number' }
                    }
                }
            },
            {
                name: 'reschedule_appointment',
                description: 'Reschedule an existing appointment to a new date and time slot.',
                parameters: {
                    type: 'object',
                    properties: {
                        appointmentId: { type: 'string', description: 'Appointment ID to reschedule' },
                        newDate: { type: 'string', description: 'New booking date (YYYY-MM-DD)' },
                        newTime: { type: 'string', description: 'New time slot (e.g. 03:30 PM)' }
                    },
                    required: ['appointmentId', 'newDate', 'newTime']
                }
            },
            {
                name: 'lookup_customer',
                description: 'Lookup existing customer profile and booking history by phone number or email.',
                parameters: {
                    type: 'object',
                    properties: {
                        phone: { type: 'string', description: 'Customer phone number' },
                        email: { type: 'string', description: 'Customer email' }
                    }
                }
            },
            {
                name: 'escalate_to_human',
                description: 'Escalate conversation to live human support team when requested or if issue cannot be resolved by AI.',
                parameters: {
                    type: 'object',
                    properties: {
                        reason: { type: 'string', description: 'Reason for human escalation' },
                        customerName: { type: 'string', description: 'Customer name' },
                        phone: { type: 'string', description: 'Customer phone number' }
                    },
                    required: ['reason']
                }
            }
        ];
    }

    /**
     * Execute a specific tool by name
     */
    async executeTool(toolName, args = {}) {
        let result = null;

        switch (toolName) {
            case 'check_availability': {
                const avail = await this.appointmentDB.checkAvailability(args.date, args.time);
                result = {
                    tool: 'check_availability',
                    success: true,
                    isAvailable: avail.isAvailable,
                    date: avail.requestedDate,
                    time: avail.requestedTime,
                    availableSlots: avail.availableSlots,
                    message: avail.isAvailable 
                        ? `Slot ${avail.requestedTime} on ${avail.requestedDate} is available!`
                        : `Slot ${avail.requestedTime} on ${avail.requestedDate} is booked. Open slots: ${avail.availableSlots.join(', ')}`
                };
                break;
            }

            case 'book_appointment': {
                // Also save/update customer in Customer DB
                if (args.phone) {
                    await this.customerDB.saveCustomer({
                        name: args.customerName,
                        phone: args.phone,
                        email: args.email
                    });
                }
                const booking = await this.appointmentDB.bookAppointment(args);
                result = {
                    tool: 'book_appointment',
                    ...booking
                };
                break;
            }

            case 'cancel_appointment': {
                const cancelRes = await this.appointmentDB.cancelAppointment(args.appointmentId, args.phone);
                result = {
                    tool: 'cancel_appointment',
                    ...cancelRes
                };
                break;
            }

            case 'reschedule_appointment': {
                const resched = await this.appointmentDB.rescheduleAppointment(args.appointmentId, args.newDate, args.newTime);
                result = {
                    tool: 'reschedule_appointment',
                    ...resched
                };
                break;
            }

            case 'lookup_customer': {
                let customer = null;
                if (args.phone) customer = await this.customerDB.getCustomerByPhone(args.phone);
                if (!customer && args.email) customer = await this.customerDB.getCustomerByEmail(args.email);
                result = {
                    tool: 'lookup_customer',
                    found: !!customer,
                    customer: customer || null
                };
                break;
            }

            case 'escalate_to_human': {
                result = {
                    tool: 'escalate_to_human',
                    success: true,
                    reason: args.reason || 'Customer requested human agent',
                    contact: {
                        phone: '+91-9982323333',
                        email: 'contact@theconverseai.com',
                        whatsapp: 'https://wa.me/919982323333'
                    },
                    message: 'Conversation escalated to Converse AI live human support desk.'
                };
                this.onHumanHandoff(result);
                break;
            }

            default:
                result = { tool: toolName, error: `Unknown tool: ${toolName}` };
        }

        this.onToolExecuted(result);
        return result;
    }

    /**
     * Scan text or structured LLM tool call format and execute
     */
    async detectAndExecute(userText, memory) {
        if (!userText) return null;
        const lower = userText.toLowerCase();

        // 1. Human handoff intent detection
        if (lower.includes('human agent') || lower.includes('insaan se baat') || lower.includes('talk to human') || lower.includes('representative') || lower.includes('manager')) {
            return await this.executeTool('escalate_to_human', {
                reason: 'Customer explicitly asked to speak with a human specialist',
                customerName: memory?.entities?.customerName || '',
                phone: memory?.entities?.phone || ''
            });
        }

        // 2. Cancellation intent
        if (lower.includes('cancel appointment') || lower.includes('cancel booking') || lower.includes('appointment cancel')) {
            return await this.executeTool('cancel_appointment', {
                appointmentId: memory?.entities?.appointmentId || '',
                phone: memory?.entities?.phone || ''
            });
        }

        // 3. Reschedule intent
        if (lower.includes('reschedule') || lower.includes('time change') || lower.includes('date change')) {
            return await this.executeTool('reschedule_appointment', {
                appointmentId: memory?.entities?.appointmentId || 'APPT-1001',
                newDate: memory?.entities?.targetDate || 'tomorrow',
                newTime: memory?.entities?.targetTime || '03:30 PM'
            });
        }

        // 4. Booking intent when all required entities are present
        if ((lower.includes('book') || lower.includes('confirm') || lower.includes('schedule')) && memory?.entities?.phone) {
            return await this.executeTool('book_appointment', {
                customerName: memory.entities.customerName || 'Valued Client',
                phone: memory.entities.phone,
                email: memory.entities.email || '',
                service: memory.entities.service || 'Free AI Opportunity & Readiness Audit',
                date: memory.entities.targetDate || 'tomorrow',
                time: memory.entities.targetTime || '11:30 AM'
            });
        }

        // 5. Availability checking intent
        if (lower.includes('available') || lower.includes('slot') || lower.includes('free time') || lower.includes('timing')) {
            return await this.executeTool('check_availability', {
                date: memory?.entities?.targetDate || 'tomorrow',
                time: memory?.entities?.targetTime || ''
            });
        }

        return null;
    }
}
