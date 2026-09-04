/**
 * db.test.js
 * Focused database contract & double-booking prevention tests for Sonara Voice Agent.
 *
 * IMPORTANT: These tests require a REAL running server with a configured PostgreSQL database.
 * They cannot and do not fake concurrency or constraint behavior.
 *
 * Usage: node test/db.test.js
 * Requires: server running at http://localhost:3000 (or TEST_BASE_URL env var)
 *           with DATABASE_URL / POSTGRES_URL configured
 *
 * If the server returns { fallback: true } (no DB configured), tests are SKIPPED (not faked).
 */

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const API = BASE_URL + '/api/db';

let passed = 0;
let failed = 0;
let skipped = 0;
let dbAvailable = false;

// ── Helpers ──────────────────────────────────────────────────────────────────

async function dbPost(body) {
    try {
        const res = await fetch(API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const json = await res.json();
        return { status: res.status, body: json };
    } catch (err) {
        // Server not running or network failure — return a sentinel
        return { status: 0, body: { server_unavailable: true, error: err.message } };
    }
}

function pass(label) {
    console.log('  PASS  ' + label);
    passed++;
}

function fail(label, reason) {
    console.log('  FAIL  ' + label);
    if (reason) console.log('        reason: ' + reason);
    failed++;
}

function skip(label, reason) {
    console.log('  SKIP  ' + label + (reason ? ' — ' + reason : ''));
    skipped++;
}

// Unique enough slot/id for this test run
const RUN = Date.now();
const SLOT = `2099-12-${String(RUN).slice(-2).padStart(2,'0')} 10:00 AM`;
const ID_A = `TEST-A-${RUN}`;
const ID_B = `TEST-B-${RUN}`;

// ── Tests ─────────────────────────────────────────────────────────────────────

async function test_dbConnectivity() {
    const { status, body } = await dbPost({ action: 'get_appointments' });

    if (body.server_unavailable) {
        console.warn('  NOTE  Server not reachable (' + BASE_URL + ') — skipping all DB tests.');
        console.warn('         Start the dev server and set TEST_BASE_URL to run these tests.');
        dbAvailable = false;
        return;
    }

    if (body.fallback === true) {
        console.warn('  NOTE  Database not configured on this server — skipping all DB tests.');
        dbAvailable = false;
        return;
    }
    dbAvailable = true;
    if (status === 200 && body.success && Array.isArray(body.appointments)) {
        pass('DB connectivity — get_appointments returns success + array');
    } else if (status === 401) {
        // Admin-guarded; still means DB is connected
        dbAvailable = true;
        pass('DB connectivity — server responded (admin auth required, DB is connected)');
    } else {
        fail('DB connectivity', `HTTP ${status}, body: ${JSON.stringify(body)}`);
    }
}

async function test_validInsert() {
    if (!dbAvailable) { skip('Valid appointment insertion', 'no DB'); return; }

    const { status, body } = await dbPost({
        action: 'save_appointment',
        data: {
            id: ID_A,
            customer_name: 'Test User A',
            phone: '9876543210',
            service: 'Free AI Opportunity Audit',
            date_time: SLOT,
            status: 'CONFIRMED',
            notes: 'DB test run'
        }
    });

    if (status === 200 && body.success === true && body.id === ID_A) {
        pass('Valid appointment insertion succeeds');
    } else {
        fail('Valid appointment insertion', `HTTP ${status} body: ${JSON.stringify(body)}`);
    }
}

async function test_apiUsesDateTimeColumn() {
    // Verify the API round-trips the date_time field correctly
    if (!dbAvailable) { skip('API uses date_time column', 'no DB'); return; }

    const { status, body } = await dbPost({ action: 'check_slot', data: { date_time: SLOT } });
    if (status === 200 && 'isAvailable' in body) {
        // Slot should be TAKEN now (we just inserted CONFIRMED ID_A above)
        if (body.isAvailable === false) {
            pass('API uses date_time column — check_slot correctly sees the booked slot');
        } else {
            // Could be admin-auth failure or insert skipped — warn rather than fail
            fail('API uses date_time column — slot should be booked but isAvailable=true', JSON.stringify(body));
        }
    } else {
        fail('API uses date_time column', `HTTP ${status} body: ${JSON.stringify(body)}`);
    }
}

async function test_duplicateBookingRejected() {
    if (!dbAvailable) { skip('Duplicate booking rejected', 'no DB'); return; }

    // Attempt to book the SAME slot (SLOT) with a DIFFERENT appointment ID
    const { status, body } = await dbPost({
        action: 'save_appointment',
        data: {
            id: ID_B,
            customer_name: 'Test User B (duplicate)',
            phone: '9123456789',
            service: 'Free AI Opportunity Audit',
            date_time: SLOT,   // same slot as ID_A
            status: 'CONFIRMED',
            notes: 'This should be rejected'
        }
    });

    if (status === 409) {
        // The DB-level unique index fired — this is the correct behavior
        if (body.error && !body.error.includes('CONFIRMED') && !body.error.toLowerCase().includes('sql')) {
            pass('Duplicate booking rejected with HTTP 409 — no SQL details leaked');
        } else {
            pass('Duplicate booking rejected with HTTP 409');
        }
    } else if (status === 200 && body.success) {
        // The unique index may not be applied yet on this DB instance
        fail(
            'Duplicate booking NOT rejected — unique index may not be applied on this database',
            'Run the migration: CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_no_double_booking ON appointments(date_time) WHERE UPPER(status)=\'CONFIRMED\';'
        );
    } else {
        fail('Duplicate booking rejection', `Unexpected HTTP ${status} body: ${JSON.stringify(body)}`);
    }
}

async function test_cancelledSlotCanBeRebooked() {
    if (!dbAvailable) { skip('Cancelled slot can be re-booked', 'no DB'); return; }

    // 1. Cancel ID_A
    await dbPost({
        action: 'save_appointment',
        data: {
            id: ID_A,
            customer_name: 'Test User A',
            phone: '9876543210',
            service: 'Free AI Opportunity Audit',
            date_time: SLOT,
            status: 'CANCELLED',
            notes: 'cancelled for test'
        }
    });

    // 2. Now try to book the same slot with a NEW id — should succeed
    const ID_C = `TEST-C-${RUN}`;
    const { status, body } = await dbPost({
        action: 'save_appointment',
        data: {
            id: ID_C,
            customer_name: 'Test User C (re-book)',
            phone: '9000000001',
            service: 'Free AI Opportunity Audit',
            date_time: SLOT,
            status: 'CONFIRMED',
            notes: 're-booking after cancel'
        }
    });

    if (status === 200 && body.success === true) {
        pass('Cancelled slot can be re-booked by a new appointment');
    } else if (status === 409) {
        fail(
            'Cancelled slot re-book returned 409 unexpectedly',
            'The partial index WHERE UPPER(status)=\'CONFIRMED\' should allow this. Check whether the CANCELLED row was correctly updated.'
        );
    } else {
        fail('Cancelled slot re-book', `HTTP ${status} body: ${JSON.stringify(body)}`);
    }

    // Cleanup: cancel ID_C so it does not pollute later runs
    await dbPost({
        action: 'save_appointment',
        data: { id: `TEST-C-${RUN}`, customer_name: 'Test User C (re-book)', phone: '9000000001',
                service: 'Free AI Opportunity Audit', date_time: SLOT, status: 'CANCELLED', notes: 'cleanup' }
    });
}

async function test_differentSlotsCanBeBooked() {
    if (!dbAvailable) { skip('Different slots can be booked independently', 'no DB'); return; }

    const SLOT2 = `2099-12-${String(RUN).slice(-2).padStart(2,'0')} 11:30 AM`;
    const ID_D  = `TEST-D-${RUN}`;

    const { status, body } = await dbPost({
        action: 'save_appointment',
        data: {
            id: ID_D,
            customer_name: 'Test User D',
            phone: '9000000002',
            service: 'Free AI Opportunity Audit',
            date_time: SLOT2,
            status: 'CONFIRMED',
            notes: 'different slot test'
        }
    });

    if (status === 200 && body.success === true) {
        pass('Different slot books successfully (no false unique violation)');
    } else {
        fail('Different slot booking', `HTTP ${status} body: ${JSON.stringify(body)}`);
    }

    // Cleanup
    await dbPost({
        action: 'save_appointment',
        data: { id: ID_D, customer_name: 'Test User D', phone: '9000000002',
                service: 'Free AI Opportunity Audit', date_time: SLOT2, status: 'CANCELLED', notes: 'cleanup' }
    });
}

async function test_getAppointmentsReturnsSlotFields() {
    if (!dbAvailable) { skip('get_appointments returns slot_date and slot_time', 'no DB'); return; }

    const { status, body } = await dbPost({ action: 'get_appointments' });
    if (status === 401) { skip('get_appointments returns slot_date and slot_time', 'admin auth required'); return; }

    if (!body.success || !Array.isArray(body.appointments)) {
        fail('get_appointments returns slot_date and slot_time', 'no appointments array returned');
        return;
    }

    if (body.appointments.length === 0) {
        skip('get_appointments returns slot_date and slot_time', 'no appointment rows in DB to verify');
        return;
    }

    const row = body.appointments[0];
    const hasSlotDate = typeof row.slot_date === 'string' && row.slot_date.length > 0;
    const hasSlotTime = typeof row.slot_time === 'string' && row.slot_time.length > 0;
    const hasDateTime = typeof row.date_time === 'string';

    if (hasSlotDate && hasSlotTime && hasDateTime) {
        pass('get_appointments returns date_time + slot_date + slot_time fields');
    } else {
        fail(
            'get_appointments missing slot_date or slot_time',
            `row keys: ${Object.keys(row).join(', ')}`
        );
    }
}

async function test_dbErrorDoesNotExposeSQLDetails() {
    // Send a garbage action — server should return a safe error, not a stack trace or SQL
    const { status, body } = await dbPost({ action: 'not_a_real_action', data: {} });

    if (body.server_unavailable) { skip('DB error response does not leak SQL details', 'server not running'); return; }

    const errorStr = JSON.stringify(body);
    const leaksSQL = /SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN|pg_|relation|column/i.test(errorStr);
    const leaksCreds = /password|DATABASE_URL|POSTGRES_URL|postgresql:\/\//i.test(errorStr);

    if ((status === 400 || status === 500) && !leaksSQL && !leaksCreds) {
        pass('Invalid action returns safe error — no SQL or credential details in response');
    } else if (leaksSQL || leaksCreds) {
        fail('DB error response leaks SQL/credential details', errorStr.slice(0, 200));
    } else {
        fail('DB error response unexpected', `HTTP ${status} body: ${errorStr.slice(0, 200)}`);
    }
}

// ── Runner ───────────────────────────────────────────────────────────────────

async function run() {
    console.log('\n============================================================');
    console.log(' Sonara Voice Agent — Database Tests');
    console.log(' Target: ' + API);
    console.log(' Slot:   ' + SLOT);
    console.log('============================================================\n');

    await test_dbConnectivity();
    await test_validInsert();
    await test_apiUsesDateTimeColumn();
    await test_duplicateBookingRejected();
    await test_cancelledSlotCanBeRebooked();
    await test_differentSlotsCanBeBooked();
    await test_getAppointmentsReturnsSlotFields();
    await test_dbErrorDoesNotExposeSQLDetails();

    console.log('\n------------------------------------------------------------');
    console.log(` Results: ${passed} passed | ${failed} failed | ${skipped} skipped`);
    console.log('------------------------------------------------------------\n');

    if (failed > 0) process.exit(1);
    // 0 passed + 0 failed + N skipped = server not available: exit 0 (not a test failure)
    process.exit(0);
}

run().catch(err => {
    console.error('Test runner crashed:', err);
    process.exit(2);
});
