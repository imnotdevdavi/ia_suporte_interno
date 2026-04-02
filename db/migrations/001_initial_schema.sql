BEGIN;

DO $$
BEGIN
  CREATE TYPE user_role AS ENUM ('member', 'reviewer', 'admin');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE site_theme AS ENUM ('default', 'midnight', 'ocean', 'forest', 'rose', 'light');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE chat_status AS ENUM ('active', 'archived', 'deleted');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE message_role AS ENUM ('system', 'user', 'assistant', 'tool');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE attachment_kind AS ENUM ('original_file', 'derived_image');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE attachment_processing_status AS ENUM ('pending', 'processed', 'unsupported', 'failed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE feedback_value AS ENUM ('useful', 'not_useful');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE feedback_issue_type AS ENUM (
    'incorrect_answer',
    'missing_information',
    'outdated_content',
    'bad_source',
    'other'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE feedback_status AS ENUM ('pending', 'reviewing', 'approved', 'rejected', 'applied');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS users (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  full_name TEXT NOT NULL CHECK (char_length(trim(full_name)) >= 3),
  email TEXT NOT NULL CHECK (position('@' IN email) > 1),
  password_hash TEXT NOT NULL,
  site_theme site_theme NOT NULL DEFAULT 'default',
  profile_photo_url TEXT,
  profile_photo_path TEXT,
  role user_role NOT NULL DEFAULT 'member',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  email_verified_at TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx
  ON users ((lower(email)));

CREATE TABLE IF NOT EXISTS auth_sessions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_token_hash TEXT NOT NULL CHECK (char_length(session_token_hash) >= 32),
  user_agent TEXT,
  ip_address INET,
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS auth_sessions_token_hash_unique_idx
  ON auth_sessions (session_token_hash);

CREATE INDEX IF NOT EXISTS auth_sessions_active_by_user_idx
  ON auth_sessions (user_id, expires_at DESC)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS chat_threads (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'Novo chat' CHECK (char_length(trim(title)) >= 1),
  status chat_status NOT NULL DEFAULT 'active',
  message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  last_message_at TIMESTAMPTZ,
  last_message_preview TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS chat_threads_owner_status_idx
  ON chat_threads (owner_user_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chat_id BIGINT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  author_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  role message_role NOT NULL,
  sequence_no INTEGER,
  content_text TEXT NOT NULL DEFAULT '',
  content_format TEXT NOT NULL DEFAULT 'plain_text'
    CHECK (content_format IN ('plain_text', 'markdown', 'json')),
  request_id TEXT,
  model_name TEXT,
  total_latency_ms INTEGER CHECK (total_latency_ms IS NULL OR total_latency_ms >= 0),
  ai_latency_ms INTEGER CHECK (ai_latency_ms IS NULL OR ai_latency_ms >= 0),
  first_token_ms INTEGER CHECK (first_token_ms IS NULL OR first_token_ms >= 0),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_chat_sequence_unique_idx
  ON chat_messages (chat_id, sequence_no)
  WHERE sequence_no IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_request_id_unique_idx
  ON chat_messages (request_id)
  WHERE request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS chat_messages_chat_created_idx
  ON chat_messages (chat_id, created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS chat_messages_author_created_idx
  ON chat_messages (author_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS message_attachments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id BIGINT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  source_attachment_id BIGINT REFERENCES message_attachments(id) ON DELETE SET NULL,
  attachment_kind attachment_kind NOT NULL DEFAULT 'original_file',
  processing_status attachment_processing_status NOT NULL DEFAULT 'pending',
  display_name TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT,
  file_extension TEXT,
  byte_size BIGINT CHECK (byte_size IS NULL OR byte_size >= 0),
  checksum_sha256 CHAR(64),
  storage_provider TEXT NOT NULL DEFAULT 'local',
  storage_path TEXT,
  public_url TEXT,
  extracted_text TEXT,
  extracted_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT message_attachments_storage_chk
    CHECK (storage_path IS NOT NULL OR public_url IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS message_attachments_message_idx
  ON message_attachments (message_id);

CREATE INDEX IF NOT EXISTS message_attachments_source_idx
  ON message_attachments (source_attachment_id);

CREATE TABLE IF NOT EXISTS assistant_message_sources (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id BIGINT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  source_rank SMALLINT NOT NULL CHECK (source_rank > 0),
  source_type TEXT NOT NULL DEFAULT 'notion_page',
  external_source_id TEXT,
  title TEXT NOT NULL,
  url TEXT,
  relevance_score INTEGER,
  snippet_label TEXT,
  snippet_text TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT assistant_message_sources_rank_unique UNIQUE (message_id, source_rank)
);

CREATE INDEX IF NOT EXISTS assistant_message_sources_message_idx
  ON assistant_message_sources (message_id, source_rank);

CREATE TABLE IF NOT EXISTS message_feedback (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id BIGINT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feedback_value feedback_value NOT NULL,
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT message_feedback_once_per_user UNIQUE (message_id, user_id)
);

CREATE INDEX IF NOT EXISTS message_feedback_message_idx
  ON message_feedback (message_id, created_at DESC);

CREATE INDEX IF NOT EXISTS message_feedback_user_idx
  ON message_feedback (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS knowledge_feedback_queue (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reported_by_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id BIGINT REFERENCES chat_threads(id) ON DELETE SET NULL,
  message_id BIGINT REFERENCES chat_messages(id) ON DELETE SET NULL,
  feedback_id BIGINT REFERENCES message_feedback(id) ON DELETE SET NULL,
  status feedback_status NOT NULL DEFAULT 'pending',
  issue_type feedback_issue_type NOT NULL,
  title TEXT NOT NULL,
  user_comment TEXT,
  suggested_correction TEXT,
  expected_answer TEXT,
  source_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  attachment_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  request_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  review_notes TEXT,
  reviewed_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  applied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS knowledge_feedback_status_idx
  ON knowledge_feedback_queue (status, created_at DESC);

CREATE INDEX IF NOT EXISTS knowledge_feedback_reported_by_idx
  ON knowledge_feedback_queue (reported_by_user_id, created_at DESC);

CREATE OR REPLACE FUNCTION assign_chat_message_sequence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.sequence_no IS NULL THEN
    SELECT COALESCE(MAX(sequence_no), 0) + 1
      INTO NEW.sequence_no
      FROM chat_messages
     WHERE chat_id = NEW.chat_id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION refresh_chat_thread_summary(target_chat_id BIGINT)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE chat_threads AS ct
     SET message_count = agg.message_count,
         last_message_at = agg.last_message_at,
         last_message_preview = agg.last_message_preview,
         updated_at = NOW()
    FROM (
      SELECT
        COUNT(*)::INTEGER AS message_count,
        MAX(created_at) AS last_message_at,
        COALESCE(
          (
            SELECT LEFT(COALESCE(NULLIF(trim(content_text), ''), '(mensagem com anexo)'), 160)
              FROM chat_messages
             WHERE chat_id = target_chat_id
             ORDER BY sequence_no DESC NULLS LAST, created_at DESC, id DESC
             LIMIT 1
          ),
          'Novo chat'
        ) AS last_message_preview
        FROM chat_messages
       WHERE chat_id = target_chat_id
    ) AS agg
   WHERE ct.id = target_chat_id;
END;
$$;

CREATE OR REPLACE FUNCTION sync_chat_thread_summary()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM refresh_chat_thread_summary(OLD.chat_id);
    RETURN OLD;
  END IF;

  PERFORM refresh_chat_thread_summary(NEW.chat_id);

  IF TG_OP = 'UPDATE' AND NEW.chat_id IS DISTINCT FROM OLD.chat_id THEN
    PERFORM refresh_chat_thread_summary(OLD.chat_id);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_users_set_updated_at ON users;
CREATE TRIGGER trg_users_set_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_chat_threads_set_updated_at ON chat_threads;
CREATE TRIGGER trg_chat_threads_set_updated_at
BEFORE UPDATE ON chat_threads
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_message_attachments_set_updated_at ON message_attachments;
CREATE TRIGGER trg_message_attachments_set_updated_at
BEFORE UPDATE ON message_attachments
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_message_feedback_set_updated_at ON message_feedback;
CREATE TRIGGER trg_message_feedback_set_updated_at
BEFORE UPDATE ON message_feedback
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_knowledge_feedback_set_updated_at ON knowledge_feedback_queue;
CREATE TRIGGER trg_knowledge_feedback_set_updated_at
BEFORE UPDATE ON knowledge_feedback_queue
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_chat_messages_assign_sequence ON chat_messages;
CREATE TRIGGER trg_chat_messages_assign_sequence
BEFORE INSERT ON chat_messages
FOR EACH ROW
EXECUTE FUNCTION assign_chat_message_sequence();

DROP TRIGGER IF EXISTS trg_chat_messages_sync_thread_summary ON chat_messages;
CREATE TRIGGER trg_chat_messages_sync_thread_summary
AFTER INSERT OR UPDATE OR DELETE ON chat_messages
FOR EACH ROW
EXECUTE FUNCTION sync_chat_thread_summary();

COMMIT;
