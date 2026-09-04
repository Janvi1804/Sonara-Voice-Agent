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

export function isValidIndianPhone(phone) {
    if (!phone) return false;
    let clean = String(phone).trim().replace(/[\s\-()]/g, '');
    if (clean.startsWith('+91')) clean = clean.slice(3);
    else if (clean.startsWith('91') && clean.length === 12) clean = clean.slice(2);
    else if (clean.startsWith('0') && clean.length === 11) clean = clean.slice(1);
    return /^[6-9]\d{9}$/.test(clean);
}

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
        await this.loadAll();           // Load from local IndexedDB first (fast)
        await this.loadFromSupabase();  // Then sync from remote Supabase (cross-device)
        this.isInitialized = true;
    }

    /**
     * Load all appointments from Supabase (cross-device persistence).
     * Merges remote records into inMemoryAppointments — remote wins on conflict.
     */
    async loadFromSupabase() {
        try {
            const res = await fetch('/api/db', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'get_appointments' })
            });
            if (!res.ok) return; // Silently skip if DB not configured
            const data = await res.json();
            if (!data.success || !Array.isArray(data.appointments)) return;

            // Normalize Supabase flat record → internal format
            for (const row of data.appointments) {
                // Supabase stores "date_time" as "YYYY-MM-DD HH:MM AM/PM"
                const parts = (row.date_time || '').split(' ');
                const slot_date = parts[0] || '';
                const slot_time = parts.slice(1).join(' ') || '';

                const record = {
                    id: row.id,
                    customer_name: row.customer_name || '',
                    phone: row.phone || '',
                    email: row.email || '',
                    service: row.service || 'Free AI Opportunity Audit',
                    slot_date,
                    slot_time,
                    status: (row.status || 'confirmed').toLowerCase(),
                    notes: row.notes || '',
                    created_at: row.created_at || new Date().toISOString(),
                    updated_at: row.updated_at || new Date().toISOString()
                };
                this.inMemoryAppointments.set(record.id, record);
            }
            console.log(`[AppointmentDB] Synced ${data.appointments.length} appointment(s) from Supabase.`);
        } catch (err) {
            console.warn('[AppointmentDB] Supabase sync skipped:', err.message);
        }
    }

    setPostgresUrl(url) {
        this.postgresUrl = (url || '').trim();
    }

    /**
     * Standardize date string to YYYY-MM-DD (local calendar safe, avoids UTC shift)
     */
    normalizeDate(dateInput) {
        if (!dateInput) {
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            const y = tomorrow.getFullYear();
            const m = String(tomorrow.getMonth() + 1).padStart(2, '0');
            const d = String(tomorrow.getDate()).padStart(2, '0');
            return `${y}-${m}-${d}`;
        }
        if (typeof dateInput === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateInput.trim())) {
            return dateInput.trim();
        }
        const d = new Date(dateInput);
        if (!isNaN(d.getTime())) {
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${y}-${m}-${day}`;
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

        if (!isValidIndianPhone(phone)) {
            return {
                success: false,
                message: 'Invalid phone number. A valid 10-digit Indian mobile number starting with 6, 7, 8, or 9 is required to book an appointment.'
            };
        }

        let cleanPhone = String(phone || '').trim().replace(/[\s\-()]/g, '');
        if (cleanPhone.startsWith('+91')) cleanPhone = cleanPhone.slice(3);
        else if (cleanPhone.startsWith('91') && cleanPhone.length === 12) cleanPhone = cleanPhone.slice(2);
        else if (cleanPhone.startsWith('0') && cleanPhone.length === 11) cleanPhone = cleanPhone.slice(1);

        const normDate = this.normalizeDate(date);
        const normTime = this.normalizeTime(time);

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

        // Remote PostgreSQL sync — always attempt via Vercel env var (POSTGRES_URL)
        // Client postgresUrl is optional fallback for self-hosted installs
        try {
            const dbRes = await fetch('/api/db', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'save_appointment',
                    data: {
                        id: record.id,
                        customer_name: record.customer_name,
                        phone: record.phone,
                        service: record.service,
                        date_time: `${record.slot_date} ${record.slot_time}`,
                        status: 'CONFIRMED',
                        notes: record.notes
                    }
                })
            });
            if (dbRes.status === 409) {
                this.inMemoryAppointments.delete(apptId);
                return {
                    success: false,
                    message: `Slot ${normTime} on ${normDate} was just reserved by another client. Please choose another slot.`
                };
            }
        } catch (err) {
            console.warn('[AppointmentDB] Supabase save note:', err.message);
        }

        // Fire email + WhatsApp notifications (non-blocking)
        this.notifyBooking(record).catch(() => {});

        return {
            success: true,
            appointmentId: apptId,
            appointment: record,
            message: `Appointment ${apptId} successfully booked for ${record.customer_name} on ${normDate} at ${normTime} for ${service}.`
        };
    }

    /**
     * Fire-and-forget: send email + WhatsApp notifications to customer and admin.
     */
    async notifyBooking(record) {
        try {
            await fetch('/api/notify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    customerName:  record.customer_name,
                    customerPhone: record.phone,
                    customerEmail: record.email,
                    appointmentId: record.id,
                    date:          record.slot_date,
                    time:          record.slot_time,
                    service:       record.service
                })
            });
            console.log('[AppointmentDB] Notifications dispatched for', record.id);
        } catch (err) {
            console.warn('[AppointmentDB] Notification dispatch failed:', err.message);
        }
    }

    /**
     * Cancel an appointment (syncs to Supabase / PostgreSQL backend)
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

        // Synchronize cancellation to remote PostgreSQL / Supabase
        try {
            await fetch('/api/db', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'save_appointment',
                    data: {
                        id: target.id,
                        customer_name: target.customer_name,
                        phone: target.phone,
                        service: target.service,
                        date_time: `${target.slot_date} ${target.slot_time}`,
                        status: 'CANCELLED',
                        notes: target.notes
                    }
                })
            });
        } catch (err) {
            console.warn('[AppointmentDB] Supabase cancellation sync note:', err.message);
        }

        return {
            success: true,
            appointmentId: target.id,
            message: `Appointment ${target.id} on ${target.slot_date} at ${target.slot_time} has been successfully cancelled.`
        };
    }

    /**
     * Reschedule an appointment (syncs to Supabase / PostgreSQL backend with double-booking check)
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

        const oldDate = target.slot_date;
        const oldTime = target.slot_time;
        const oldStatus = target.status;

        target.slot_date = normDate;
        target.slot_time = normTime;
        target.status = 'confirmed';
        target.updated_at = new Date().toISOString();

        // Remote synchronization to PostgreSQL / Supabase backend with unique index enforcement
        try {
            const dbRes = await fetch('/api/db', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'save_appointment',
                    data: {
                        id: target.id,
                        customer_name: target.customer_name,
                        phone: target.phone,
                        service: target.service,
                        date_time: `${normDate} ${normTime}`,
                        status: 'CONFIRMED',
                        notes: target.notes
                    }
                })
            });

            if (dbRes.status === 409) {
                // Revert local state if remote rejected due to concurrent booking
                target.slot_date = oldDate;
                target.slot_time = oldTime;
                target.status = oldStatus;
                return {
                    success: false,
                    message: `Slot ${normTime} on ${normDate} is already reserved by another client. Please choose another time.`
                };
            }
        } catch (err) {
            console.warn('[AppointmentDB] Supabase reschedule sync note:', err.message);
        }

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
