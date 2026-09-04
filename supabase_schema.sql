-- Supabase Schema for Converse AI / Sonara Voice Agent
-- Run this in Supabase Dashboard -> SQL Editor -> New query -> Run
--
-- AUTHORITATIVE SCHEMA NOTE:
-- Appointment date+time is stored as a single "date_time" TEXT column,
-- formatted "YYYY-MM-DD HH:MM AM/PM" (e.g. "2025-01-15 11:30 AM").
-- The client (appointment-db.js) splits this string into slot_date / slot_time
-- for its in-memory representation only; those fields do NOT exist in the DB.

-- Enable pgvector extension for RAG knowledge search
CREATE EXTENSION IF NOT EXISTS vector;

-- 1. Appointments Table
CREATE TABLE IF NOT EXISTS appointments (
    id TEXT PRIMARY KEY,
    customer_name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    service TEXT DEFAULT 'Free AI Opportunity Audit',
    date_time TEXT NOT NULL,
    status TEXT DEFAULT 'CONFIRMED',
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Standard lookup indexes
CREATE INDEX IF NOT EXISTS idx_appointments_phone ON appointments(phone);
CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status);

-- ============================================================
-- DOUBLE-BOOKING PREVENTION (database-level, concurrent-safe)
-- ============================================================
-- Partial UNIQUE index on date_time for CONFIRMED appointments only.
--   * Prevents two concurrent bookings from landing on the same slot.
--   * PostgreSQL rejects the second insert with error code 23505.
--   * Cancelled / rescheduled slots are NOT covered by this index,
--     so they CAN be re-booked (correct business behaviour).
-- A JavaScript SELECT-then-INSERT check alone cannot prevent races.
--
-- Migration safety: run the check query below before applying this
-- index if production data already exists:
--   SELECT date_time, COUNT(*) FROM appointments
--   WHERE UPPER(status)='CONFIRMED' GROUP BY date_time HAVING COUNT(*)>1;
-- If that returns rows, resolve duplicates manually before running this.
CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_no_double_booking
    ON appointments (date_time)
    WHERE UPPER(status) = 'CONFIRMED';

-- 2. Customers Table
CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    company TEXT,
    notes TEXT,
    preferred_services TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);

-- 3. Conversation Logs Table
CREATE TABLE IF NOT EXISTS conversation_logs (
    id SERIAL PRIMARY KEY,
    session_id TEXT,
    turn_index INT,
    user_input TEXT,
    ai_response TEXT,
    latency_ttft_ms NUMERIC,
    total_latency_ms NUMERIC,
    tool_calls JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversation_logs_session ON conversation_logs(session_id);

-- 4. Knowledge Embeddings (pgvector)
CREATE TABLE IF NOT EXISTS knowledge_embeddings (
    id TEXT PRIMARY KEY,
    title TEXT,
    content TEXT NOT NULL,
    url TEXT,
    embedding vector(384),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
