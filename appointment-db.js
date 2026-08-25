/**
 * Appointment & Slot Scheduling Database (PostgreSQL + IndexedDB)
 * Manages consultation slots, booking collisions, rescheduling, and status management.
 */

export const STANDARD_DAILY_SLOTS = [
    '10:00 AM',
    '11:30 AM',
    '02:00 PM',
    '03:30 PM',
    '05:00 PM'
];

export class AppointmentDB {
    constructor(options = {}) {
        this.postgresUrl = options.postgresUrl || '';
        this.dbName = 'ConverseAIAppointmentDB';
        this.storeName = 'appointments';
        this.isInitialized = false;
        this.inMemoryAppointments = new Map();
    }

    async init() {
        if (this.isInitialized) return;
        await this.initIndexedDB();
        await this.loadAll();
        this.isInitialized = true;
    }

    setPostgresUrl(url) {
        this.postgresUrl = (url || '').trim();
    }

    /**
     * Standardize date string to YYYY-MM-DD
     */
    normalizeDate(dateInput) {
        if (!dateInput) {
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            return tomorrow.toISOString().split('T')[0];
        }
        const d = new Date(dateInput);
        if (!isNaN(d.getTime())) {
            return d.toISOString().split('T')[0];
        }
        return dateInput;
    }

    /**
     * Standardize time slot string
     */
    normalizeTime(timeInput) {
        if (!timeInput) return '11:30 AM';
        const clean = timeInput.toLowerCase().trim();
        if (clean.includes('10')) return '10:00 AM';
        if (clean.includes('11') || clean.includes('12')) return '11:30 AM';
        if (clean.includes('2') || clean.includes('14')) return '02:00 PM';
        if (clean.includes('3') || clean.includes('4') || clean.includes('15') || clean.includes('16')) return '03:30 PM';
        if (clean.includes('5') || clean.includes('6') || clean.includes('17')) return '05:00 PM';
        return '11:30 AM';
    }

    /**
     * Get list of open available slots for a given date
     */
    async getAvailableSlots(date) {
        await this.init();
        const normDate = this.normalizeDate(date);
        const bookedTimes = new Set();

        for (const appt of this.inMemoryAppointments.values()) {
            if (appt.slot_date === normDate && appt.status === 'confirmed') {
                bookedTimes.add(appt.slot_time);
            }
        }

        return STANDARD_DAILY_SLOTS.filter(slot => !bookedTimes.has(slot));
    }

    /**
     * Check if a specific date and time slot is open
     */
    async checkAvailability(date, time) {
        await this.init();
        const normDate = this.normalizeDate(date);
        const normTime = this.normalizeTime(time);
        const available = await this.getAvailableSlots(normDate);
        return {
            isAvailable: available.includes(normTime),
            requestedDate: normDate,
            requestedTime: normTime,
            availableSlots: available
        };
    }

    /**
     * Book an appointment
     */
    async bookAppointment({ customerName, phone, email = '', service = 'Free AI Opportunity Audit', date, time, notes = '' }) {
        await this.init();
        const normDate = this.normalizeDate(date);
        const normTime = this.normalizeTime(time);
        const cleanPhone = String(phone || '').replace(/[\s-]/g, '');

        const avail = await this.checkAvailability(normDate, normTime);
        if (!avail.isAvailable) {
            return {
                success: false,
                message: `Slot ${normTime} on ${normDate} is already booked. Available slots: ${avail.availableSlots.join(', ')}`,
                availableSlots: avail.availableSlots
            };
        }

        const apptId = `APPT-${Math.floor(1000 + Math.random() * 9000)}`;
        const record = {
            id: apptId,
            customer_id: `cust_${cleanPhone}`,
            customer_name: customerName || 'Valued Client',
            phone: cleanPhone,
            email,
            service,
            slot_date: normDate,
            slot_time: normTime,
            status: 'confirmed',
            notes,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };

        this.inMemoryAppointments.set(apptId, record);
        await this.saveToIndexedDB(record);

        // Remote PostgreSQL sync if connection string configured
        if (this.postgresUrl) {
            try {
                await fetch('/api/db', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        action: 'save_appointment',
                        postgresUrl: this.postgresUrl,
                        data: {
                            id: record.id,
                            customer_name: record.customer_name,
                            phone: record.phone,
                            service: record.service,
                            date_time: `${record.slot_date} ${record.slot_time}`,
                            status: record.status,
                            notes: record.notes
                        }
                    })
                });
            } catch (err) {
                console.warn('Postgres appointment sync note:', err);
            }
        }

        return {
            success: true,
            appointmentId: apptId,
            appointment: record,
            message: `Appointment ${apptId} successfully booked for ${record.customer_name} on ${normDate} at ${normTime} for ${service}.`
        };
    }

    /**
     * Cancel an appointment
     */
    async cancelAppointment(appointmentId, phone) {
        await this.init();
        let target = this.inMemoryAppointments.get(appointmentId);

        // If not found by ID, look up latest active appointment by phone
        if (!target && phone) {
            const cleanPhone = String(phone).replace(/[\s-]/g, '');
            for (const appt of this.inMemoryAppointments.values()) {
                if (appt.phone === cleanPhone && appt.status === 'confirmed') {
                    target = appt;
                    break;
                }
            }
        }

        if (!target) {
            return {
                success: false,
                message: `No active appointment found for ID ${appointmentId || ''} / Phone ${phone || ''}.`
            };
        }

        target.status = 'cancelled';
        target.updated_at = new Date().toISOString();
        this.inMemoryAppointments.set(target.id, target);
        await this.saveToIndexedDB(target);

        return {
            success: true,
            appointmentId: target.id,
            message: `Appointment ${target.id} on ${target.slot_date} at ${target.slot_time} has been successfully cancelled.`
        };
    }

    /**
     * Reschedule an appointment
     */
    async rescheduleAppointment(appointmentId, newDate, newTime) {
        await this.init();
        const target = this.inMemoryAppointments.get(appointmentId);
        if (!target) {
            return { success: false, message: `Appointment ${appointmentId} not found.` };
        }

        const normDate = this.normalizeDate(newDate || target.slot_date);
        const normTime = this.normalizeTime(newTime || target.slot_time);

        const avail = await this.checkAvailability(normDate, normTime);
        if (!avail.isAvailable) {
            return {
                success: false,
                message: `New slot ${normTime} on ${normDate} is unavailable. Open slots: ${avail.availableSlots.join(', ')}`
            };
        }

        target.slot_date = normDate;
        target.slot_time = normTime;
        target.status = 'rescheduled';
        target.updated_at = new Date().toISOString();

        this.inMemoryAppointments.set(target.id, target);
        await this.saveToIndexedDB(target);

        return {
            success: true,
            appointmentId: target.id,
            message: `Appointment ${target.id} rescheduled to ${normDate} at ${normTime}.`
        };
    }

    /**
     * Get all active appointments
     */
    async getAllAppointments() {
        await this.init();
        return Array.from(this.inMemoryAppointments.values());
    }

    /**
     * IndexedDB Storage Adapter
     */
    initIndexedDB() {
        return new Promise((resolve) => {
            if (typeof window === 'undefined' || !('indexedDB' in window)) {
                resolve();
                return;
            }
            const request = indexedDB.open(this.dbName, 1);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName, { keyPath: 'id' });
                }
            };
            request.onsuccess = () => resolve();
            request.onerror = () => resolve();
        });
    }

    saveToIndexedDB(record) {
        return new Promise((resolve) => {
            if (typeof window === 'undefined' || !('indexedDB' in window)) {
                resolve();
                return;
            }
            const request = indexedDB.open(this.dbName, 1);
            request.onsuccess = (e) => {
                const db = e.target.result;
                const tx = db.transaction(this.storeName, 'readwrite');
                const store = tx.objectStore(this.storeName);
                store.put(record);
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
            };
            request.onerror = () => resolve();
        });
    }

    loadAll() {
        return new Promise((resolve) => {
            if (typeof window === 'undefined' || !('indexedDB' in window)) {
                resolve([]);
                return;
            }
            const request = indexedDB.open(this.dbName, 1);
            request.onsuccess = (e) => {
                const db = e.target.result;
                const tx = db.transaction(this.storeName, 'readonly');
                const store = tx.objectStore(this.storeName);
                const req = store.getAll();
                req.onsuccess = () => {
                    (req.result || []).forEach(a => this.inMemoryAppointments.set(a.id, a));
                    resolve(req.result || []);
                };
                req.onerror = () => resolve([]);
            };
            request.onerror = () => resolve([]);
        });
    }
}
