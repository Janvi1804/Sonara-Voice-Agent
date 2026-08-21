/**
 * Customer Database (PostgreSQL + IndexedDB)
 * Manages customer profiles, contact numbers, past bookings, and custom preferences.
 */

export class CustomerDB {
    constructor(options = {}) {
        this.postgresUrl = options.postgresUrl || '';
        this.dbName = 'ConverseAICustomerDB';
        this.storeName = 'customers';
        this.isInitialized = false;
        this.inMemoryCache = new Map();
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
     * Save or update customer record
     */
    async saveCustomer(customer) {
        await this.init();
        if (!customer || !customer.phone) return null;

        const cleanPhone = String(customer.phone).replace(/[\s-]/g, '');
        const id = customer.id || `cust_${cleanPhone}`;

        const existing = this.inMemoryCache.get(cleanPhone) || {};
        const record = {
            id,
            name: customer.name || existing.name || 'Valued Customer',
            phone: cleanPhone,
            email: customer.email || existing.email || '',
            company: customer.company || existing.company || '',
            notes: customer.notes || existing.notes || '',
            preferences: {
                ...(existing.preferences || {}),
                ...(customer.preferences || {})
            },
            created_at: existing.created_at || new Date().toISOString(),
            updated_at: new Date().toISOString()
        };

        this.inMemoryCache.set(cleanPhone, record);
        await this.saveToIndexedDB(record);

        // Remote PostgreSQL sync if connection string configured
        if (this.postgresUrl) {
            try {
                await fetch('/api/pgvector', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        action: 'save_customer',
                        postgresUrl: this.postgresUrl,
                        customer: record
                    })
                });
            } catch (err) {
                console.warn('Postgres customer sync failed, stored locally:', err);
            }
        }

        return record;
    }

    /**
     * Lookup customer by phone number
     */
    async getCustomerByPhone(phone) {
        await this.init();
        if (!phone) return null;
        const cleanPhone = String(phone).replace(/[\s-]/g, '');
        return this.inMemoryCache.get(cleanPhone) || null;
    }

    /**
     * Lookup customer by email address
     */
    async getCustomerByEmail(email) {
        await this.init();
        if (!email) return null;
        const target = email.toLowerCase().trim();
        for (const cust of this.inMemoryCache.values()) {
            if (cust.email && cust.email.toLowerCase().trim() === target) {
                return cust;
            }
        }
        return null;
    }

    /**
     * Get all customer records
     */
    async getAllCustomers() {
        await this.init();
        return Array.from(this.inMemoryCache.values());
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
                    db.createObjectStore(this.storeName, { keyPath: 'phone' });
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
                    (req.result || []).forEach(c => this.inMemoryCache.set(c.phone, c));
                    resolve(req.result || []);
                };
                req.onerror = () => resolve([]);
            };
            request.onerror = () => resolve([]);
        });
    }
}
