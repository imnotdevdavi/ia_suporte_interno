import { pool } from './db.js';

function getQueryable(queryable) {
  return queryable || pool;
}

export async function findUserByEmail(email, queryable) {
  const db = getQueryable(queryable);
  const { rows } = await db.query(
    `SELECT *
       FROM users
      WHERE lower(email) = lower($1)
      LIMIT 1`,
    [email]
  );
  return rows[0] || null;
}

export async function findUserByGoogleSub(googleSub, queryable) {
  const db = getQueryable(queryable);
  const { rows } = await db.query(
    `SELECT *
       FROM users
      WHERE google_sub = $1
      LIMIT 1`,
    [googleSub]
  );
  return rows[0] || null;
}

export async function findUserById(userId, queryable) {
  const db = getQueryable(queryable);
  const { rows } = await db.query(
    `SELECT *
       FROM users
      WHERE id = $1
      LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

export async function createUser({
  fullName,
  email,
  passwordHash,
  googleSub = null,
  profilePhotoUrl = null,
  emailVerifiedAt = null,
}, queryable) {
  const db = getQueryable(queryable);
  const { rows } = await db.query(
    `INSERT INTO users (
        full_name,
        email,
        password_hash,
        google_sub,
        profile_photo_url,
        email_verified_at
      )
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [fullName, email, passwordHash, googleSub, profilePhotoUrl, emailVerifiedAt]
  );
  return rows[0];
}

export async function updateUserProfile({
  userId,
  fullName,
  profilePhotoPath,
  profilePhotoUrl,
  googleSub,
  emailVerifiedAt,
}, queryable) {
  const db = getQueryable(queryable);
  const updates = [];
  const values = [];

  if (typeof fullName === 'string') {
    values.push(fullName);
    updates.push(`full_name = $${values.length}`);
  }

  if (typeof profilePhotoPath === 'string') {
    values.push(profilePhotoPath);
    updates.push(`profile_photo_path = $${values.length}`);
  }

  if (typeof profilePhotoUrl === 'string') {
    values.push(profilePhotoUrl);
    updates.push(`profile_photo_url = $${values.length}`);
  }

  if (typeof googleSub === 'string') {
    values.push(googleSub);
    updates.push(`google_sub = $${values.length}`);
  }

  if (emailVerifiedAt instanceof Date) {
    values.push(emailVerifiedAt);
    updates.push(`email_verified_at = $${values.length}`);
  }

  if (!updates.length) {
    return findUserById(userId, db);
  }

  values.push(userId);

  const { rows } = await db.query(
    `UPDATE users
        SET ${updates.join(', ')}
      WHERE id = $${values.length}
      RETURNING *`,
    values
  );

  return rows[0] || null;
}

export async function updateUserTheme(userId, siteTheme, queryable) {
  const db = getQueryable(queryable);
  const { rows } = await db.query(
    `UPDATE users
        SET site_theme = $2
      WHERE id = $1
      RETURNING *`,
    [userId, siteTheme]
  );
  return rows[0] || null;
}

export async function updateUserPassword(userId, passwordHash, queryable) {
  const db = getQueryable(queryable);
  const { rows } = await db.query(
    `UPDATE users
        SET password_hash = $2
      WHERE id = $1
      RETURNING *`,
    [userId, passwordHash]
  );
  return rows[0] || null;
}

export async function touchUserLastLogin(userId, queryable) {
  const db = getQueryable(queryable);
  await db.query(
    `UPDATE users
        SET last_login_at = NOW()
      WHERE id = $1`,
    [userId]
  );
}

export async function createAuthSession({ userId, sessionTokenHash, userAgent, ipAddress, expiresAt }, queryable) {
  const db = getQueryable(queryable);
  const { rows } = await db.query(
    `INSERT INTO auth_sessions (user_id, session_token_hash, user_agent, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [userId, sessionTokenHash, userAgent || null, ipAddress || null, expiresAt]
  );
  return rows[0];
}

export async function findSessionUserByTokenHash(tokenHash, queryable) {
  const db = getQueryable(queryable);
  const { rows } = await db.query(
    `SELECT
        s.id AS session_id,
        s.user_id,
        s.expires_at,
        s.last_seen_at,
        s.revoked_at,
        u.*
       FROM auth_sessions AS s
       JOIN users AS u
         ON u.id = s.user_id
      WHERE s.session_token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > NOW()
        AND u.is_active = TRUE
      LIMIT 1`,
    [tokenHash]
  );
  return rows[0] || null;
}

export async function touchSession(sessionId, queryable) {
  const db = getQueryable(queryable);
  await db.query(
    `UPDATE auth_sessions
        SET last_seen_at = NOW()
      WHERE id = $1`,
    [sessionId]
  );
}

export async function revokeSession(sessionId, queryable) {
  const db = getQueryable(queryable);
  await db.query(
    `UPDATE auth_sessions
        SET revoked_at = NOW()
      WHERE id = $1
        AND revoked_at IS NULL`,
    [sessionId]
  );
}

export async function createChatThread({ ownerUserId, title }, queryable) {
  const db = getQueryable(queryable);
  const { rows } = await db.query(
    `INSERT INTO chat_threads (owner_user_id, title)
     VALUES ($1, $2)
     RETURNING *`,
    [ownerUserId, title]
  );
  return rows[0];
}

export async function updateChatTitleIfDefault(chatId, title, queryable) {
  const db = getQueryable(queryable);
  const { rows } = await db.query(
    `UPDATE chat_threads
        SET title = $2
      WHERE id = $1
        AND title = 'Novo chat'
      RETURNING *`,
    [chatId, title]
  );
  return rows[0] || null;
}

export async function updateChatTitle(chatId, title, queryable) {
  const db = getQueryable(queryable);
  const { rows } = await db.query(
    `UPDATE chat_threads
        SET title = $2
      WHERE id = $1
      RETURNING *`,
    [chatId, title]
  );
  return rows[0] || null;
}

export async function listChatsForUser(userId, queryable) {
  const db = getQueryable(queryable);
  const { rows } = await db.query(
    `SELECT *
       FROM chat_threads
      WHERE owner_user_id = $1
        AND status <> 'deleted'
      ORDER BY updated_at DESC, id DESC`,
    [userId]
  );
  return rows;
}

export async function getChatForUser(chatId, userId, queryable) {
  const db = getQueryable(queryable);
  const { rows } = await db.query(
    `SELECT *
       FROM chat_threads
      WHERE id = $1
        AND owner_user_id = $2
        AND status <> 'deleted'
      LIMIT 1`,
    [chatId, userId]
  );
  return rows[0] || null;
}

export async function softDeleteChatForUser(chatId, userId, queryable) {
  const db = getQueryable(queryable);
  const { rows } = await db.query(
    `UPDATE chat_threads
        SET status = 'deleted',
            updated_at = NOW()
      WHERE id = $1
        AND owner_user_id = $2
        AND status <> 'deleted'
      RETURNING *`,
    [chatId, userId]
  );
  return rows[0] || null;
}

export async function createMessage({
  chatId,
  authorUserId,
  role,
  contentText,
  contentFormat = 'plain_text',
  requestId = null,
  modelName = null,
  totalLatencyMs = null,
  aiLatencyMs = null,
  firstTokenMs = null,
  metadata = {},
}, queryable) {
  const db = getQueryable(queryable);
  const { rows } = await db.query(
    `INSERT INTO chat_messages (
        chat_id,
        author_user_id,
        role,
        content_text,
        content_format,
        request_id,
        model_name,
        total_latency_ms,
        ai_latency_ms,
        first_token_ms,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
      RETURNING *`,
    [
      chatId,
      authorUserId || null,
      role,
      contentText || '',
      contentFormat,
      requestId,
      modelName,
      totalLatencyMs,
      aiLatencyMs,
      firstTokenMs,
      JSON.stringify(metadata || {}),
    ]
  );
  return rows[0];
}

export async function listRecentHistoryMessages(chatId, userId, limit = 10, queryable) {
  const db = getQueryable(queryable);
  const { rows } = await db.query(
    `SELECT m.role, m.content_text
       FROM chat_messages AS m
       JOIN chat_threads AS c
         ON c.id = m.chat_id
      WHERE m.chat_id = $1
        AND c.owner_user_id = $2
        AND c.status <> 'deleted'
        AND m.role IN ('user', 'assistant')
      ORDER BY m.sequence_no DESC NULLS LAST, m.created_at DESC, m.id DESC
      LIMIT $3`,
    [chatId, userId, limit]
  );

  return rows.reverse().map((row) => ({
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: row.content_text || '',
  }));
}

export async function createMessageAttachments(messageId, attachments, queryable) {
  const db = getQueryable(queryable);
  const inserted = [];

  for (const attachment of attachments) {
    const { rows } = await db.query(
      `INSERT INTO message_attachments (
          message_id,
          source_attachment_id,
          attachment_kind,
          processing_status,
          display_name,
          original_name,
          mime_type,
          file_extension,
          byte_size,
          checksum_sha256,
          storage_provider,
          storage_path,
          public_url,
          extracted_text,
          extracted_metadata
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15::jsonb
        )
        RETURNING *`,
      [
        messageId,
        attachment.sourceAttachmentId || null,
        attachment.attachmentKind || 'original_file',
        attachment.processingStatus || 'pending',
        attachment.displayName,
        attachment.originalName,
        attachment.mimeType || null,
        attachment.fileExtension || null,
        attachment.byteSize || null,
        attachment.checksumSha256 || null,
        attachment.storageProvider || 'local',
        attachment.storagePath || null,
        attachment.publicUrl || null,
        attachment.extractedText || null,
        JSON.stringify(attachment.extractedMetadata || {}),
      ]
    );

    inserted.push(rows[0]);
  }

  return inserted;
}

export async function createAssistantSources(messageId, sources, queryable) {
  const db = getQueryable(queryable);
  const inserted = [];

  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    const { rows } = await db.query(
      `INSERT INTO assistant_message_sources (
          message_id,
          source_rank,
          source_type,
          external_source_id,
          title,
          url,
          relevance_score,
          snippet_label,
          snippet_text,
          metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
        RETURNING *`,
      [
        messageId,
        index + 1,
        source.sourceType || 'notion_page',
        source.externalSourceId || null,
        source.title,
        source.url || null,
        source.relevanceScore ?? source.score ?? null,
        source.snippetLabel || null,
        source.snippetText || null,
        JSON.stringify(source.metadata || {}),
      ]
    );
    inserted.push(rows[0]);
  }

  return inserted;
}

export async function listChatMessagesForUser(chatId, userId, currentViewerId, queryable) {
  const db = getQueryable(queryable);
  const { rows: messageRows } = await db.query(
    `SELECT
        m.*,
        mf.feedback_value AS viewer_feedback_value
       FROM chat_messages AS m
       JOIN chat_threads AS c
         ON c.id = m.chat_id
       LEFT JOIN message_feedback AS mf
         ON mf.message_id = m.id
        AND mf.user_id = $3
      WHERE m.chat_id = $1
        AND c.owner_user_id = $2
        AND c.status <> 'deleted'
      ORDER BY m.sequence_no ASC NULLS FIRST, m.created_at ASC, m.id ASC`,
    [chatId, userId, currentViewerId]
  );

  const { rows: attachmentRows } = await db.query(
    `SELECT a.*
       FROM message_attachments AS a
       JOIN chat_messages AS m
         ON m.id = a.message_id
       JOIN chat_threads AS c
         ON c.id = m.chat_id
      WHERE m.chat_id = $1
        AND c.owner_user_id = $2
      ORDER BY a.id ASC`,
    [chatId, userId]
  );

  const { rows: sourceRows } = await db.query(
    `SELECT s.*
       FROM assistant_message_sources AS s
       JOIN chat_messages AS m
         ON m.id = s.message_id
       JOIN chat_threads AS c
         ON c.id = m.chat_id
      WHERE m.chat_id = $1
        AND c.owner_user_id = $2
      ORDER BY s.message_id ASC, s.source_rank ASC`,
    [chatId, userId]
  );

  const attachmentsByMessage = new Map();
  attachmentRows.forEach((row) => {
    const current = attachmentsByMessage.get(row.message_id) || [];
    current.push(row);
    attachmentsByMessage.set(row.message_id, current);
  });

  const sourcesByMessage = new Map();
  sourceRows.forEach((row) => {
    const current = sourcesByMessage.get(row.message_id) || [];
    current.push(row);
    sourcesByMessage.set(row.message_id, current);
  });

  return messageRows.map((row) => ({
    ...row,
    attachments: attachmentsByMessage.get(row.id) || [],
    sources: sourcesByMessage.get(row.id) || [],
  }));
}

export async function getAttachmentForUser(attachmentId, userId, queryable) {
  const db = getQueryable(queryable);
  const { rows } = await db.query(
    `SELECT a.*
       FROM message_attachments AS a
       JOIN chat_messages AS m
         ON m.id = a.message_id
       JOIN chat_threads AS c
         ON c.id = m.chat_id
      WHERE a.id = $1
        AND c.owner_user_id = $2
        AND c.status <> 'deleted'
      LIMIT 1`,
    [attachmentId, userId]
  );
  return rows[0] || null;
}

export async function getMessageForUser(messageId, userId, queryable) {
  const db = getQueryable(queryable);
  const { rows } = await db.query(
    `SELECT
        m.*,
        c.owner_user_id
       FROM chat_messages AS m
       JOIN chat_threads AS c
         ON c.id = m.chat_id
      WHERE m.id = $1
        AND c.owner_user_id = $2
        AND c.status <> 'deleted'
      LIMIT 1`,
    [messageId, userId]
  );
  return rows[0] || null;
}

export async function upsertMessageFeedback({ messageId, userId, feedbackValue, comment }, queryable) {
  const db = getQueryable(queryable);
  const { rows } = await db.query(
    `INSERT INTO message_feedback (message_id, user_id, feedback_value, comment)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (message_id, user_id)
     DO UPDATE SET
       feedback_value = EXCLUDED.feedback_value,
       comment = EXCLUDED.comment,
       updated_at = NOW()
     RETURNING *`,
    [messageId, userId, feedbackValue, comment || null]
  );
  return rows[0];
}

export async function upsertKnowledgeFeedbackQueue({
  reportedByUserId,
  chatId,
  messageId,
  feedbackId,
  issueType,
  title,
  userComment,
  suggestedCorrection,
  expectedAnswer,
  sourceSnapshot,
  attachmentSnapshot,
  requestSnapshot,
}, queryable) {
  const db = getQueryable(queryable);
  const { rows: existingRows } = await db.query(
    `SELECT *
       FROM knowledge_feedback_queue
      WHERE feedback_id = $1
      ORDER BY id DESC
      LIMIT 1`,
    [feedbackId]
  );

  if (existingRows[0]) {
    const { rows } = await db.query(
      `UPDATE knowledge_feedback_queue
          SET status = 'pending',
              issue_type = $2,
              title = $3,
              user_comment = $4,
              suggested_correction = $5,
              expected_answer = $6,
              source_snapshot = $7::jsonb,
              attachment_snapshot = $8::jsonb,
              request_snapshot = $9::jsonb,
              reviewed_by_user_id = NULL,
              reviewed_at = NULL,
              review_notes = NULL,
              applied_at = NULL,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [
        existingRows[0].id,
        issueType,
        title,
        userComment || null,
        suggestedCorrection || null,
        expectedAnswer || null,
        JSON.stringify(sourceSnapshot || []),
        JSON.stringify(attachmentSnapshot || []),
        JSON.stringify(requestSnapshot || {}),
      ]
    );
    return rows[0];
  }

  const { rows } = await db.query(
    `INSERT INTO knowledge_feedback_queue (
        reported_by_user_id,
        chat_id,
        message_id,
        feedback_id,
        issue_type,
        title,
        user_comment,
        suggested_correction,
        expected_answer,
        source_snapshot,
        attachment_snapshot,
        request_snapshot
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10::jsonb, $11::jsonb, $12::jsonb
      )
      RETURNING *`,
    [
      reportedByUserId,
      chatId || null,
      messageId || null,
      feedbackId || null,
      issueType,
      title,
      userComment || null,
      suggestedCorrection || null,
      expectedAnswer || null,
      JSON.stringify(sourceSnapshot || []),
      JSON.stringify(attachmentSnapshot || []),
      JSON.stringify(requestSnapshot || {}),
    ]
  );

  return rows[0];
}
