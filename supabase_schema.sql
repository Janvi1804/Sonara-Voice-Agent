-- Supabase Schema for Converse AI / Sonara Voice Agent
-- Run this in Supabase Dashboard -> SQL Editor -> New query -> Run

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

-- 4. Knowledge Embeddings (pgvector)
CREATE TABLE IF NOT EXISTS knowledge_embeddings (
    id TEXT PRIMARY KEY,
    title TEXT,
    content TEXT NOT NULL,
    url TEXT,
    embedding vector(384),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for high performance lookup
CREATE INDEX IF NOT EXISTS idx_appointments_phone ON appointments(phone);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_conversation_logs_session ON conversation_logs(session_id);
