import 'dotenv/config';
import express from 'express';
import OpenAI from 'openai';
import { Client as NotionClient } from '@notionhq/client';
import { execFile as execFileCallback } from 'child_process';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import { inspect, promisify } from 'util';
import { fileURLToPath } from 'url';
import multer from 'multer';
import fs from 'fs';
import mammoth from 'mammoth';
import { createRequire } from 'module';
import { createAsyncExpiringCache } from './lib/async-cache.js';
import { pool, query, withTransaction } from './lib/db.js';
import { createRateLimiter } from './lib/rate-limit.js';
import {
  SESSION_COOKIE_NAME,
  buildSessionExpiry,
  clearSessionCookie,
  createSessionToken,
  getSessionTokenFromRequest,
  hashPassword,
  hashSessionToken,
  normalizeEmail,
  parseCookies,
  setSessionCookie,
  validatePasswordStrength,
  verifyPassword,
} from './lib/auth.js';
import {
  createAssistantSources,
  createAuthSession,
  createChatThread,
  createMessage,
  createMessageAttachments,
  createUser,
  findSessionUserByTokenHash,
  findUserByEmail,
  findUserByGoogleSub,
  findUserById,
  getAttachmentForUser,
  getChatForUser,
  getMessageForUser,
  listChatMessagesForUser,
  listChatsForUser,
  listRecentHistoryMessages,
  revokeSession,
  softDeleteChatForUser,
  touchSession,
  touchUserLastLogin,
  updateChatTitleIfDefault,
  updateUserPassword,
  updateUserProfile,
  updateUserTheme,
  upsertKnowledgeFeedbackQueue,
  upsertMessageFeedback,
} from './lib/repository.js';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');
const execFileAsync = promisify(execFileCallback);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_LOG_DIR = path.join(__dirname, 'logs');

function resolveProjectPath(rawValue, fallbackPath) {
  const value = String(rawValue || '').trim();
  if (!value) return fallbackPath;
  if (path.isAbsolute(value)) return value;
  return path.join(__dirname, value);
}

function resolveLogFilePath(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) {
    return path.join(DEFAULT_LOG_DIR, 'smartai.log');
  }

  if (path.isAbsolute(value)) return value;
  if (value.includes('/') || value.includes('\\')) {
    return path.join(__dirname, value);
  }

  return path.join(DEFAULT_LOG_DIR, value);
}

function resolveTrustProxySetting(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) {
    return process.env.NODE_ENV === 'production' ? 1 : 0;
  }

  const normalized = value.toLowerCase();
  if (['true', 'yes', 'on'].includes(normalized)) return true;
  if (['false', 'no', 'off'].includes(normalized)) return false;

  const numeric = Number.parseInt(normalized, 10);
  if (Number.isInteger(numeric) && numeric >= 0) return numeric;

  return value;
}

const LOG_FILE = resolveLogFilePath(process.env.SMARTAI_LOG_FILE);
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

const originalConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  dir: console.dir.bind(console),
};
const logFileStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

function writeLogEntry(level, args, inspectOptions = {}) {
  const rendered = args.map((arg) => {
    if (typeof arg === 'string') return arg;

    return inspect(arg, {
      colors: false,
      depth: null,
      maxArrayLength: null,
      breakLength: 120,
      ...inspectOptions,
    });
  }).join(' ');

  try {
    logFileStream.write(`[${new Date().toISOString()}] [${level}] ${rendered}\n`);
  } catch {}
}

console.log = (...args) => {
  writeLogEntry('INFO', args);
  originalConsole.log(...args);
};

console.warn = (...args) => {
  writeLogEntry('WARN', args);
  originalConsole.warn(...args);
};

console.error = (...args) => {
  writeLogEntry('ERROR', args);
  originalConsole.error(...args);
};

console.dir = (value, options = {}) => {
  writeLogEntry('DIR', [value], options);
  originalConsole.dir(value, options);
};

process.on('uncaughtExceptionMonitor', (error) => {
  writeLogEntry('UNCAUGHT_EXCEPTION', [error]);
});

process.on('unhandledRejection', (reason) => {
  writeLogEntry('UNHANDLED_REJECTION', [reason]);
  originalConsole.error(reason);
});

const app = express();
app.set('trust proxy', resolveTrustProxySetting(process.env.TRUST_PROXY));
app.use((req, res, next) => {
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.use(express.json({ limit: '20mb' }));
app.use(express.static(PUBLIC_DIR));

const notion = new NotionClient({ auth: process.env.NOTION_TOKEN });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const TEMP_UPLOAD_DIR = resolveProjectPath(
  process.env.SMARTAI_UPLOAD_DIR,
  path.join(os.tmpdir(), 'smartai', 'tmp')
);
const STORAGE_DIR = resolveProjectPath(
  process.env.SMARTAI_STORAGE_DIR,
  path.join(__dirname, 'storage')
);
const ATTACHMENT_STORAGE_DIR = path.join(STORAGE_DIR, 'attachments');
const PROFILE_STORAGE_DIR = path.join(STORAGE_DIR, 'profiles');

fs.mkdirSync(TEMP_UPLOAD_DIR, { recursive: true });
fs.mkdirSync(ATTACHMENT_STORAGE_DIR, { recursive: true });
fs.mkdirSync(PROFILE_STORAGE_DIR, { recursive: true });

const upload = multer({
  dest: TEMP_UPLOAD_DIR,
  limits: { fileSize: 20 * 1024 * 1024 },
});

const PROFILE_PHOTO_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const PROFILE_PHOTO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const PROFILE_MAX_FILE_SIZE = 5 * 1024 * 1024;
const ALLOWED_THEMES = new Set(['default', 'midnight', 'ocean', 'forest', 'rose', 'light']);
const GOOGLE_OAUTH_STATE_COOKIE_NAME = `${SESSION_COOKIE_NAME}_google_state`;
const GOOGLE_OAUTH_STATE_DURATION_MS = 1000 * 60 * 10;

/* ═══════════════════════════════════════════════
   NOTION
═══════════════════════════════════════════════ */
const NOTION_SEARCH_LIMIT = 8;
const INITIAL_RESULT_LIMIT = 4;
const FALLBACK_RESULT_LIMIT = 6;
const FINAL_RESULT_LIMIT = 4;
const INITIAL_CANDIDATE_LIMIT = 10;
const FALLBACK_CANDIDATE_LIMIT = 14;
const INITIAL_BLOCK_LIMIT = 180;
const FALLBACK_BLOCK_LIMIT = 320;
const INITIAL_PAGE_CHARS = 9000;
const FALLBACK_PAGE_CHARS = 15000;
const INITIAL_HYDRATION_LIMIT = 5;
const FALLBACK_HYDRATION_LIMIT = 8;
const NOTION_HYDRATION_CONCURRENCY = 3;
const NOTION_SEARCH_CACHE_TTL_MS = 1000 * 60 * 2;
const NOTION_PAGE_CACHE_TTL_MS = 1000 * 60 * 15;
const NOTION_SEARCH_CACHE_MAX_ENTRIES = 200;
const NOTION_PAGE_CACHE_MAX_ENTRIES = 400;
const MAX_SECTION_CHARS = 1200;
const MAX_CONTEXT_SNIPPETS = 8;
const MAX_SNIPPETS_PER_PAGE = 3;
const MIN_RELEVANT_SCORE = 4;
const MAX_FILE_CHARS = 12000;
const MAX_PDF_IMAGE_PAGES = 4;
const PDF_IMAGE_DPI = 144;
const notionSearchCache = createAsyncExpiringCache({
  ttlMs: NOTION_SEARCH_CACHE_TTL_MS,
  maxEntries: NOTION_SEARCH_CACHE_MAX_ENTRIES,
});
const notionPageContentCache = createAsyncExpiringCache({
  ttlMs: NOTION_PAGE_CACHE_TTL_MS,
  maxEntries: NOTION_PAGE_CACHE_MAX_ENTRIES,
});

async function searchNotion(question, history = []) {
  const baseQuery = normalizeQuery(question);
  if (!baseQuery) {
    return {
      pages: [],
      metrics: {
        usedFallback: false,
        returnedFromInitialPass: false,
        passes: [],
      },
    };
  }

  const metrics = {
    usedFallback: false,
    returnedFromInitialPass: false,
    passes: [],
  };

  const initialPass = await runSearchPass({
    passName: 'initial',
    queries: buildPrimaryQueries(baseQuery),
    question,
    candidateLimit: INITIAL_CANDIDATE_LIMIT,
    hydrateLimit: INITIAL_HYDRATION_LIMIT,
    resultLimit: INITIAL_RESULT_LIMIT,
    blockLimit: INITIAL_BLOCK_LIMIT,
    charLimit: INITIAL_PAGE_CHARS,
  });
  metrics.passes.push(initialPass.metrics);

  if (hasStrongResults(initialPass.pages)) {
    metrics.returnedFromInitialPass = true;
    return {
      pages: initialPass.pages,
      metrics,
    };
  }

  metrics.usedFallback = true;
  const fallbackPass = await runSearchPass({
    passName: 'fallback',
    queries: buildFallbackQueries(baseQuery, history),
    question,
    candidateLimit: FALLBACK_CANDIDATE_LIMIT,
    hydrateLimit: FALLBACK_HYDRATION_LIMIT,
    resultLimit: FALLBACK_RESULT_LIMIT,
    blockLimit: FALLBACK_BLOCK_LIMIT,
    charLimit: FALLBACK_PAGE_CHARS,
  });
  metrics.passes.push(fallbackPass.metrics);

  return {
    pages: mergeCandidates(initialPass.pages, fallbackPass.pages, FINAL_RESULT_LIMIT),
    metrics,
  };
}

function registerCacheSource(cacheMetrics, source) {
  if (!cacheMetrics) return;

  if (source === 'cache') {
    cacheMetrics.hits += 1;
    return;
  }

  if (source === 'inflight') {
    cacheMetrics.inflightHits += 1;
    return;
  }

  cacheMetrics.misses += 1;
}

async function searchNotionPages(query, metrics) {
  const cacheKey = `notion-search:${query}`;
  const result = await notionSearchCache.getOrLoad(cacheKey, async () => {
    const resp = await notion.search({
      query,
      filter: { value: 'page', property: 'object' },
      page_size: NOTION_SEARCH_LIMIT,
      sort: { direction: 'descending', timestamp: 'last_edited_time' },
    });

    return resp.results.map((page) => ({
      id: page.id,
      title: getTitle(page),
      url: page.url,
    }));
  });

  registerCacheSource(metrics?.searchCache, result.source);
  return result.value;
}

function prioritizeCandidatePages(pages, question) {
  return pages
    .map((page, index) => ({
      ...page,
      titleScore: scoreTitle(page.title, question),
      originalIndex: index,
    }))
    .sort((left, right) => (
      right.titleScore - left.titleScore
      || left.originalIndex - right.originalIndex
    ));
}

async function mapWithConcurrency(items, concurrency, mapper) {
  if (!items.length) return [];

  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;

      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(Math.max(concurrency, 1), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function runSearchPass({
  passName,
  queries,
  question,
  candidateLimit,
  hydrateLimit,
  resultLimit,
  blockLimit,
  charLimit,
}) {
  const pageMap = new Map();
  const metrics = {
    passName,
    queryCount: 0,
    candidateCount: 0,
    hydratedCount: 0,
    resultCount: 0,
    strongResults: false,
    hydrateLimit,
    blockLimit,
    charLimit,
    searchCache: {
      hits: 0,
      inflightHits: 0,
      misses: 0,
    },
    pageCache: {
      hits: 0,
      inflightHits: 0,
      misses: 0,
    },
  };

  for (const query of [...new Set(queries.filter(Boolean))]) {
    metrics.queryCount += 1;
    const pages = await searchNotionPages(query, metrics);

    for (const page of pages) {
      if (!pageMap.has(page.id)) {
        pageMap.set(page.id, page);
      }

      if (pageMap.size >= candidateLimit) break;
    }

    if (pageMap.size >= candidateLimit) break;
  }

  const candidatePages = prioritizeCandidatePages(
    Array.from(pageMap.values()).slice(0, candidateLimit),
    question
  );
  metrics.candidateCount = candidatePages.length;

  const pagesToHydrate = candidatePages.slice(0, Math.min(hydrateLimit, candidatePages.length));
  const hydrated = [];

  for (let offset = 0; offset < pagesToHydrate.length; offset += NOTION_HYDRATION_CONCURRENCY) {
    const batch = pagesToHydrate.slice(offset, offset + NOTION_HYDRATION_CONCURRENCY);
    const hydratedBatch = await mapWithConcurrency(
      batch,
      NOTION_HYDRATION_CONCURRENCY,
      async (page) => {
        const content = await getPageContent(page.id, { blockLimit, charLimit }, metrics);
        const snippets = selectRelevantSnippets(content, page.title, question);
        const score = page.titleScore + snippets.reduce((sum, snippet) => sum + snippet.score, 0);
        return {
          id: page.id,
          title: page.title,
          url: page.url,
          content: content.text,
          sections: content.sections,
          snippets,
          score,
        };
      }
    );

    hydrated.push(...hydratedBatch);

    const partialRank = rankHydratedPages(hydrated, resultLimit);
    if (partialRank.length >= resultLimit && hasStrongResults(partialRank)) {
      break;
    }
  }

  metrics.hydratedCount = hydrated.length;

  const rankedPages = rankHydratedPages(hydrated, resultLimit);

  metrics.resultCount = rankedPages.length;
  metrics.strongResults = hasStrongResults(rankedPages);

  return {
    pages: rankedPages,
    metrics,
  };
}

function hasStrongResults(results) {
  if (!results.length) return false;
  return results.some((result) => result.snippets.length && result.score >= MIN_RELEVANT_SCORE);
}

function rankHydratedPages(pages, resultLimit) {
  return pages
    .filter((page) => page.content || page.snippets.length)
    .sort((left, right) => right.score - left.score)
    .slice(0, resultLimit);
}

function mergeCandidates(primary, fallback, resultLimit = FINAL_RESULT_LIMIT) {
  const merged = new Map();
  [...primary, ...fallback].forEach((item) => {
    const existing = merged.get(item.id);
    if (!existing || item.score > existing.score) {
      merged.set(item.id, item);
    }
  });

  return Array.from(merged.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, resultLimit);
}

function buildPrimaryQueries(question) {
  const keywordQuery = buildKeywordFallback(question);
  const normalizedQuestion = normalizeQuery(question).slice(0, 300);
  return [...new Set([normalizedQuestion, keywordQuery].filter(Boolean))];
}

function buildFallbackQueries(question, history = []) {
  const recentHistory = history
    .slice(-2)
    .map((msg) => msg?.content || '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  const withHistory = recentHistory ? `${question} ${recentHistory}`.slice(0, 450) : '';
  const historyKeywords = withHistory ? buildKeywordFallback(withHistory) : '';
  return [...new Set([
    ...buildPrimaryQueries(question),
    withHistory,
    historyKeywords,
  ].filter(Boolean))];
}

function buildKeywordFallback(question) {
  return buildQuestionTerms(question)
    .slice(0, 8)
    .join(' ')
    .slice(0, 220);
}

function normalizeQuery(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

async function getPageContent(pageId, { blockLimit, charLimit }, metrics = null) {
  const cacheKey = `notion-page:${pageId}:${blockLimit}:${charLimit}`;
  const result = await notionPageContentCache.getOrLoad(cacheKey, async () => {
    try {
      const nodes = [];
      await collectBlockNodes(pageId, nodes, { count: 0, chars: 0, blockLimit, charLimit, visited: new Set() }, []);
      return {
        text: normalizeExtractedText(nodes.map((node) => node.text).join('\n'), charLimit),
        sections: buildSections(nodes),
      };
    } catch {
      return { text: '', sections: [] };
    }
  });

  registerCacheSource(metrics?.pageCache, result.source);
  return result.value;
}

async function collectBlockNodes(blockId, nodes, state, parentHeadingPath = []) {
  if (state.visited.has(blockId)) return;
  state.visited.add(blockId);

  let cursor;
  let activeHeadingPath = [...parentHeadingPath];

  do {
    const blocks = await notion.blocks.children.list({
      block_id: blockId,
      page_size: 100,
      start_cursor: cursor,
    });

    for (const block of blocks.results) {
      if (state.count >= state.blockLimit || state.chars >= state.charLimit) return;

      const node = describeBlock(block, activeHeadingPath);
      if (node) {
        nodes.push(node);
        state.count += 1;
        state.chars += node.text.length + 1;
        if (node.kind === 'heading') {
          activeHeadingPath = node.path;
        }
      }

      const syncedSourceBlockId = block.type === 'synced_block'
        ? block.synced_block?.synced_from?.block_id
        : null;

      if ((block.has_children || syncedSourceBlockId) && state.count < state.blockLimit && state.chars < state.charLimit) {
        const childHeadingPath = node?.kind === 'heading' ? node.path : activeHeadingPath;
        await collectBlockNodes(syncedSourceBlockId || block.id, nodes, state, childHeadingPath);
      }
    }

    cursor = blocks.has_more ? blocks.next_cursor : null;
  } while (cursor && state.count < state.blockLimit && state.chars < state.charLimit);
}

function describeBlock(block, currentHeadingPath = []) {
  const text = extractBlockText(block);
  if (!text) return null;

  if (block.type === 'heading_1' || block.type === 'heading_2' || block.type === 'heading_3') {
    const level = Number(block.type.slice(-1));
    const path = updateHeadingPath(currentHeadingPath, level, text);
    return { kind: 'heading', type: block.type, level, path, text };
  }

  return {
    kind: 'content',
    type: block.type,
    path: [...currentHeadingPath],
    text,
  };
}

function extractBlockText(block) {
  if (block.type === 'table_row') {
    return (block.table_row?.cells || [])
      .map((cell) => cell.map((item) => item.plain_text).join(' ').trim())
      .filter(Boolean)
      .join(' | ');
  }

  if (block.type === 'child_page') {
    return normalizeExtractedText(block.child_page?.title || '');
  }

  if (block.type === 'equation') {
    return normalizeExtractedText(block.equation?.expression || '');
  }

  if (block.type === 'bookmark') {
    return normalizeExtractedText(block.bookmark?.url || '');
  }

  if (block.type === 'link_preview') {
    return normalizeExtractedText(block.link_preview?.url || '');
  }

  if (block.type === 'embed') {
    return normalizeExtractedText(block.embed?.url || '');
  }

  if (['image', 'video', 'audio', 'file', 'pdf'].includes(block.type)) {
    return normalizeExtractedText(plainRichText(block[block.type]?.caption || []));
  }

  const richText = block[block.type]?.rich_text;
  if (Array.isArray(richText)) {
    const text = plainRichText(richText);
    if (!text) return '';

    if (block.type === 'to_do') {
      return `${block.to_do?.checked ? '[x]' : '[ ]'} ${text}`.trim();
    }

    if (block.type === 'code') {
      const language = block.code?.language ? `[${block.code.language}] ` : '';
      return `${language}${text}`.trim();
    }

    if (block.type === 'callout') {
      const icon = block.callout?.icon?.type === 'emoji' ? `${block.callout.icon.emoji} ` : '';
      return `${icon}${text}`.trim();
    }

    return text;
  }

  return '';
}

function plainRichText(richText = []) {
  return richText.map((item) => item.plain_text || '').join('').trim();
}

function updateHeadingPath(currentPath = [], level, text) {
  const nextPath = currentPath.slice(0, Math.max(level - 1, 0));
  nextPath[level - 1] = text;
  return nextPath.filter(Boolean);
}

function buildSections(nodes) {
  const sections = [];
  let current = createSection([]);

  for (const node of nodes) {
    const sectionPath = node.path || [];

    if (node.kind === 'heading') {
      pushSection(sections, current);
      current = createSection(sectionPath, node.text);
      continue;
    }

    if (!samePath(current.path, sectionPath) || current.charCount + node.text.length > MAX_SECTION_CHARS) {
      pushSection(sections, current);
      current = createSection(sectionPath);
    }

    current.lines.push(node.text);
    current.charCount += node.text.length + 1;
  }

  pushSection(sections, current);
  return sections;
}

function createSection(path = [], headingText = '') {
  const lines = [];
  let charCount = 0;

  if (headingText) {
    lines.push(headingText);
    charCount = headingText.length;
  }

  return {
    path: [...path],
    lines,
    charCount,
  };
}

function pushSection(sections, section) {
  const text = normalizeExtractedText((section?.lines || []).join('\n'), MAX_SECTION_CHARS);
  if (!text) return;

  sections.push({
    path: [...(section.path || [])],
    label: (section.path || []).join(' > '),
    text,
  });
}

function samePath(left = [], right = []) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function selectRelevantSnippets(pageContent, title, question) {
  const sections = pageContent.sections?.length
    ? pageContent.sections
    : pageContent.text
      ? [{ path: [], label: '', text: pageContent.text.slice(0, MAX_SECTION_CHARS) }]
      : [];

  if (!sections.length) return [];

  const scored = sections
    .map((section) => ({
      text: section.text,
      label: section.label,
      score: scoreSection(section, title, question),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SNIPPETS_PER_PAGE);

  if (scored.length) return scored;

  const titleScore = scoreTitle(title, question);
  if (!titleScore) return [];

  return [{
    text: sections[0].text,
    label: sections[0].label,
    score: titleScore,
  }];
}

function scoreTitle(title, question) {
  const terms = buildQuestionTerms(question);
  if (!terms.length) return 0;

  const titleTokens = new Set(tokenizeForMatch(title));
  let score = 0;
  let matches = 0;

  for (const term of terms) {
    if (titleTokens.has(term)) {
      score += 8;
      matches += 1;
    }
  }

  if (matches && matches === terms.length) score += 12;
  return score;
}

function scoreSection(section, title, question) {
  const terms = buildQuestionTerms(question);
  if (!terms.length) return 0;

  const normalizedQuestion = normalizeForMatch(question);
  const normalizedText = normalizeForMatch(section.text);
  const normalizedLabel = normalizeForMatch(section.label);
  const titleTokens = new Set(tokenizeForMatch(title));
  const labelTokens = new Set(tokenizeForMatch(section.label));
  const contentTokens = new Set(tokenizeForMatch(section.text));

  let score = 0;
  let matches = 0;

  for (const term of terms) {
    let matched = false;

    if (titleTokens.has(term)) {
      score += 6;
      matched = true;
    }
    if (labelTokens.has(term)) {
      score += 7;
      matched = true;
    }
    if (contentTokens.has(term)) {
      score += 4;
      matched = true;
    } else if (normalizedText.includes(term)) {
      score += 2;
      matched = true;
    }

    if (matched) matches += 1;
  }

  if (normalizedQuestion.length > 8 && normalizedText.includes(normalizedQuestion)) score += 16;
  if (normalizedQuestion.length > 8 && normalizedLabel.includes(normalizedQuestion)) score += 18;
  if (matches && matches === terms.length) score += 10;
  else if (matches >= Math.ceil(terms.length / 2)) score += 5;
  if (section.text.length > 180) score += 1;

  return score;
}

function buildQuestionTerms(question) {
  return [...new Set(
    tokenizeForMatch(question).filter((term) => term.length > 2 && !STOP_WORDS.has(term))
  )];
}

function normalizeForMatch(text) {
  return (text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeForMatch(text) {
  return normalizeForMatch(text)
    .split(/\s+/)
    .map(normalizeTerm)
    .filter(Boolean);
}

function normalizeTerm(term) {
  let value = (term || '').trim();
  if (!value) return '';

  if ((value.endsWith('oes') || value.endsWith('aes')) && value.length > 4) {
    value = `${value.slice(0, -3)}ao`;
  } else if (value.endsWith('ais') && value.length > 4) {
    value = `${value.slice(0, -3)}al`;
  } else if (value.endsWith('eis') && value.length > 4) {
    value = `${value.slice(0, -3)}el`;
  } else if (value.endsWith('is') && value.length > 4) {
    value = `${value.slice(0, -2)}il`;
  } else if (value.endsWith('ns') && value.length > 4) {
    value = `${value.slice(0, -2)}m`;
  } else if (value.endsWith('s') && value.length > 4) {
    value = value.slice(0, -1);
  }

  return value;
}

function normalizeExtractedText(text, maxChars = Infinity) {
  return (text || '')
    .replace(/\0/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
    .slice(0, maxChars);
}

function buildContextFromPages(pages) {
  const snippets = pages
    .flatMap((page) => page.snippets.map((snippet) => ({
      title: page.title,
      url: page.url,
      text: snippet.text,
      label: snippet.label,
      score: snippet.score,
    })))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CONTEXT_SNIPPETS);

  if (!snippets.length) return null;

  return snippets
    .map((snippet, index) => {
      const lines = [`Documento: ${snippet.title}`];
      if (snippet.label) lines.push(`Secao: ${snippet.label}`);
      lines.push(`URL: ${snippet.url}`);
      lines.push('Trecho relevante:');
      lines.push(snippet.text);
      return lines.join('\n');
    })
    .join('\n\n---\n\n');
}

function getTitle(page) {
  const prop = Object.values(page.properties ?? {}).find((p) => p.type === 'title');
  return prop?.title?.map((t) => t.plain_text).join('') || 'Sem título';
}

const STOP_WORDS = new Set([
  'a', 'as', 'ao', 'aos', 'com', 'como', 'da', 'das', 'de', 'do', 'dos', 'e',
  'ela', 'elas', 'ele', 'eles', 'em', 'entre', 'essa', 'esse', 'esta', 'estao',
  'está', 'isso', 'mais', 'meu', 'minha', 'menos', 'muita', 'muito', 'na', 'nas',
  'no', 'nos', 'num', 'numa', 'o', 'onde', 'os', 'ou', 'para', 'pelas', 'pelos',
  'por', 'porque', 'qual', 'quais', 'quando', 'que', 'quem', 'sao', 'são', 'se',
  'sem', 'ser', 'seu', 'sua', 'sobre', 'tambem', 'também', 'tem', 'ter', 'um',
  'uma', 'umas', 'uns'
]);

/* ═══════════════════════════════════════════════
   EXTRAÇÃO DE ARQUIVOS
═══════════════════════════════════════════════ */
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml'];
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg']);
const TEXT_TYPES = ['text/plain', 'text/csv', 'application/json', 'application/xml', 'text/markdown', 'text/html'];
const TEXT_EXTENSIONS = new Set(['.txt', '.csv', '.json', '.md', '.markdown', '.log', '.xml', '.yml', '.yaml', '.html', '.htm']);
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const ATTACHMENT_REFERENCE_TERMS = new Set([
  'anexo', 'anexado', 'arquivo', 'arquivos', 'documento', 'documentos',
  'pdf', 'doc', 'docx', 'imagem', 'esse', 'essa', 'isto', 'isso'
]);

async function extractFileContent(file) {
  const { mimetype, path: tmpPath } = file;
  const originalname = normalizeUploadedFileName(file.originalname);
  const extension = path.extname(originalname || '').toLowerCase();

  try {
    if (isImageFile(mimetype, extension)) {
      const data = await fs.promises.readFile(tmpPath, { encoding: 'base64' });
      return {
        type: 'image',
        base64: data,
        mime: resolveImageMime(mimetype, extension),
        name: originalname,
      };
    }

    if (mimetype === 'application/pdf' || extension === '.pdf') {
      const content = await extractPdfText(tmpPath);
      if (!content) {
        const pages = await extractPdfPagesAsImages(tmpPath, originalname);
        if (pages.length) {
          console.log(`[SmartAI][arquivo] ${originalname}: PDF sem texto embutido, convertido em ${pages.length} imagem(ns).`);
          return {
            type: 'pdf_images',
            name: originalname,
            images: pages,
            reason: 'PDF convertido em imagens para analise visual.',
          };
        }

        return {
          type: 'error',
          name: originalname,
          reason: 'O PDF nao retornou texto legivel nem imagens utilizaveis. Se ele for escaneado, pode precisar de OCR.',
        };
      }
      console.log(`[SmartAI][arquivo] ${originalname}: PDF lido como texto.`);
      return { type: 'text', content, name: originalname };
    }

    if (mimetype === DOCX_MIME || extension === '.docx') {
      const result = await mammoth.extractRawText({ path: tmpPath });
      const content = normalizeExtractedText(result.value, MAX_FILE_CHARS);
      if (!content) {
        return { type: 'error', name: originalname, reason: 'O DOCX nao retornou texto legivel.' };
      }
      console.log(`[SmartAI][arquivo] ${originalname}: DOCX lido como texto.`);
      return { type: 'text', content, name: originalname };
    }

    if (mimetype === PPTX_MIME || extension === '.pptx') {
      const { default: AdmZip } = await import('adm-zip');
      const zip = new AdmZip(tmpPath);
      const slides = zip.getEntries().filter((entry) => entry.entryName.match(/ppt\/slides\/slide\d+\.xml/));
      const text = slides
        .map((slide) => {
          const xml = slide.getData().toString('utf8');
          const fragments = [...xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map((match) => match[1]);
          return decodeXmlEntities(fragments.join(' '));
        })
        .join('\n')
        .trim();
      const content = normalizeExtractedText(text, MAX_FILE_CHARS);
      if (!content) {
        return { type: 'error', name: originalname, reason: 'O PPTX nao retornou texto legivel.' };
      }
      console.log(`[SmartAI][arquivo] ${originalname}: PPTX lido como texto.`);
      return { type: 'text', content, name: originalname };
    }

    if (TEXT_TYPES.includes(mimetype) || TEXT_EXTENSIONS.has(extension)) {
      const buffer = await fs.promises.readFile(tmpPath);
      const content = normalizeExtractedText(buffer.toString('utf8'), MAX_FILE_CHARS);
      if (!content) {
        return { type: 'error', name: originalname, reason: 'O arquivo esta vazio ou sem texto legivel.' };
      }
      console.log(`[SmartAI][arquivo] ${originalname}: arquivo texto lido com sucesso.`);
      return { type: 'text', content, name: originalname };
    }

    return { type: 'unsupported', name: originalname };
  } catch (error) {
    console.error(`Falha ao extrair arquivo ${originalname}:`, error);
    return { type: 'error', name: originalname, reason: 'Nao foi possivel ler este arquivo.' };
  } finally {
    await safeUnlink(tmpPath);
  }
}

function normalizeUploadedFileName(originalname = '') {
  const value = String(originalname || '').trim();
  if (!value) return 'arquivo';

  if (!looksLikeMojibake(value)) {
    return value;
  }

  try {
    const decoded = Buffer.from(value, 'latin1').toString('utf8');
    return looksLikeMojibake(decoded) ? value : decoded;
  } catch {
    return value;
  }
}

function looksLikeMojibake(text = '') {
  return /Ã.|Â|ð|�/.test(text);
}

async function extractPdfText(tmpPath) {
  try {
    const buffer = await fs.promises.readFile(tmpPath);
    const result = await pdfParse(buffer);
    const parsedText = normalizeExtractedText(result.text, MAX_FILE_CHARS);
    if (parsedText) return parsedText;
  } catch {}

  try {
    const { stdout } = await execFileAsync('pdftotext', ['-layout', tmpPath, '-'], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
    const fallbackText = normalizeExtractedText(stdout, MAX_FILE_CHARS);
    if (fallbackText) return fallbackText;
  } catch {}

  return '';
}

async function extractPdfPagesAsImages(tmpPath, originalname) {
  const tempDir = await fs.promises.mkdtemp(path.join(TEMP_UPLOAD_DIR, 'pdf-pages-'));
  const outputPrefix = path.join(tempDir, 'page');

  try {
    await execFileAsync('pdftoppm', [
      '-f', '1',
      '-l', String(MAX_PDF_IMAGE_PAGES),
      '-r', String(PDF_IMAGE_DPI),
      '-jpeg',
      tmpPath,
      outputPrefix,
    ], {
      maxBuffer: 20 * 1024 * 1024,
    });

    const files = (await fs.promises.readdir(tempDir))
      .filter((file) => /^page-\d+\.jpg$/i.test(file))
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

    const images = await Promise.all(
      files.map(async (file, index) => {
        const fullPath = path.join(tempDir, file);
        const base64 = await fs.promises.readFile(fullPath, { encoding: 'base64' });
        return {
          type: 'image',
          mime: 'image/jpeg',
          base64,
          name: `${originalname} - pagina ${index + 1}`,
        };
      })
    );

    return images;
  } finally {
    await safeRm(tempDir);
  }
}

function isImageFile(mimetype = '', extension = '') {
  return IMAGE_TYPES.includes(mimetype) || IMAGE_EXTENSIONS.has(extension);
}

function resolveImageMime(mimetype = '', extension = '') {
  if (IMAGE_TYPES.includes(mimetype)) return mimetype;

  const mimeByExtension = {
    '.gif': 'image/gif',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
  };

  return mimeByExtension[extension] || 'image/png';
}

function decodeXmlEntities(text) {
  return (text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function safeUnlink(filePath) {
  try {
    await fs.promises.unlink(filePath);
  } catch {}
}

async function safeRm(filePath) {
  try {
    await fs.promises.rm(filePath, { recursive: true, force: true });
  } catch {}
}

function isReadableExtractedFile(file) {
  return ['text', 'image', 'pdf_images'].includes(file?.type);
}

function buildAttachmentSearchText(extracted = []) {
  const parts = extracted.flatMap((file) => {
    if (file.type === 'text') {
      return [`${file.name} ${file.content.slice(0, 500)}`];
    }

    if (file.type === 'pdf_images' || file.type === 'image') {
      return [file.name];
    }

    return [];
  });

  return normalizeQuery(parts.join(' ').slice(0, 700));
}

function shouldSearchNotionForRequest(question, extracted = [], files = []) {
  if (!files.length) return true;
  if (extracted.some((file) => file.type === 'text')) return true;

  const meaningfulTerms = buildQuestionTerms(question)
    .filter((term) => !ATTACHMENT_REFERENCE_TERMS.has(term));

  return meaningfulTerms.length > 0;
}

function buildUserPromptText({ question, hasAttachments, hasKnowledgeBase }) {
  const sections = [`Pergunta do usuario: ${question}`];

  if (hasAttachments) {
    sections.push(
      'Ha arquivos anexados nesta conversa. Analise esses anexos primeiro e trate-os como prioridade maxima.',
      'Nao confunda arquivos anexados nesta conversa com documentos citados na base do Notion.'
    );
  }

  if (hasKnowledgeBase) {
    sections.push(
      'A base do Notion, se presente mais abaixo, deve ser usada apenas como contexto complementar.'
    );
  }

  return sections.join('\n\n');
}

function sanitizeHistory(history = []) {
  if (!Array.isArray(history)) return [];

  return history
    .slice(-10)
    .map((message) => ({
      role: message?.role === 'assistant' ? 'assistant' : 'user',
      content: typeof message?.content === 'string' ? message.content : '',
    }))
    .filter((message) => message.content.trim());
}

function parseHistoryField(rawHistory) {
  if (!rawHistory) return [];

  try {
    const parsed = JSON.parse(rawHistory);
    return sanitizeHistory(parsed);
  } catch {
    return [];
  }
}

function parsePositiveInt(value) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function resolveThemeName(value) {
  const normalized = String(value || '').trim() || 'default';
  return ALLOWED_THEMES.has(normalized) ? normalized : null;
}

function serializeUser(user) {
  if (!user) return null;

  const updatedAt = user.updated_at ? new Date(user.updated_at).getTime() : Date.now();
  return {
    id: user.id,
    fullName: user.full_name,
    email: user.email,
    siteTheme: user.site_theme,
    profilePhotoUrl: user.profile_photo_path ? `/api/profile/photo?v=${updatedAt}` : (user.profile_photo_url || ''),
    role: user.role,
    googleConnected: Boolean(user.google_sub),
    isActive: user.is_active,
    createdAt: user.created_at,
    updatedAt: user.updated_at,
  };
}

function serializeChat(thread) {
  return {
    id: thread.id,
    title: thread.title,
    status: thread.status,
    messageCount: thread.message_count,
    lastMessageAt: thread.last_message_at,
    lastMessagePreview: thread.last_message_preview || '',
    createdAt: thread.created_at,
    updatedAt: thread.updated_at,
  };
}

function serializeSource(source) {
  return {
    id: source.id,
    rank: source.source_rank,
    title: source.title,
    url: source.url,
    relevanceScore: source.relevance_score,
    snippetLabel: source.snippet_label || '',
    snippetText: source.snippet_text || '',
    metadata: source.metadata || {},
  };
}

function serializeAttachment(attachment) {
  return {
    id: attachment.id,
    displayName: attachment.display_name,
    originalName: attachment.original_name,
    mimeType: attachment.mime_type,
    fileExtension: attachment.file_extension,
    byteSize: attachment.byte_size,
    processingStatus: attachment.processing_status,
    extractedText: attachment.extracted_text || '',
    extractedMetadata: attachment.extracted_metadata || {},
    downloadUrl: `/api/attachments/${attachment.id}`,
    createdAt: attachment.created_at,
  };
}

function serializeMessage(message) {
  return {
    id: message.id,
    chatId: message.chat_id,
    authorUserId: message.author_user_id,
    role: message.role,
    sequenceNo: message.sequence_no,
    contentText: message.content_text || '',
    contentFormat: message.content_format,
    requestId: message.request_id,
    modelName: message.model_name,
    timings: {
      totalMs: message.total_latency_ms,
      aiMs: message.ai_latency_ms,
      firstTokenMs: message.first_token_ms,
    },
    metadata: message.metadata || {},
    feedbackValue: message.viewer_feedback_value || null,
    attachments: (message.attachments || []).map(serializeAttachment),
    sources: (message.sources || []).map(serializeSource),
    createdAt: message.created_at,
  };
}

function buildPersistableSources(pages = []) {
  return pages.map((page) => {
    const topSnippet = page.snippets?.[0];
    return {
      title: page.title,
      url: page.url,
      score: page.score,
      snippetLabel: topSnippet?.label || '',
      snippetText: topSnippet?.text || '',
      metadata: {
        snippetCount: page.snippets?.length || 0,
      },
    };
  });
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }

  return req.socket?.remoteAddress || null;
}

const loginRateLimiter = createRateLimiter({
  name: 'auth-login',
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Muitas tentativas de login. Aguarde alguns minutos e tente novamente.',
  keyGenerator: (req) => {
    const email = normalizeEmail(req.body?.email || '');
    return `ip:${getClientIp(req) || 'unknown'}:email:${email || 'unknown'}`;
  },
});

const signupRateLimiter = createRateLimiter({
  name: 'auth-signup',
  windowMs: 30 * 60 * 1000,
  max: 12,
  message: 'Muitas tentativas de cadastro. Aguarde um pouco antes de continuar.',
  keyGenerator: (req) => `ip:${getClientIp(req) || 'unknown'}`,
});

const googleAuthRateLimiter = createRateLimiter({
  name: 'auth-google',
  windowMs: 10 * 60 * 1000,
  max: 20,
  message: 'Muitas tentativas de login com Google. Aguarde alguns minutos.',
  keyGenerator: (req) => `ip:${getClientIp(req) || 'unknown'}`,
});

const askRateLimiter = createRateLimiter({
  name: 'ask',
  windowMs: 60 * 1000,
  max: 20,
  message: 'Muitas perguntas em sequência. Aguarde um minuto antes de tentar de novo.',
  keyGenerator: (req) => `user:${req.auth?.user?.id || getClientIp(req) || 'unknown'}`,
});

const feedbackRateLimiter = createRateLimiter({
  name: 'feedback',
  windowMs: 60 * 1000,
  max: 30,
  message: 'Muitos envios de feedback em sequência. Aguarde um instante e tente novamente.',
  keyGenerator: (req) => `user:${req.auth?.user?.id || getClientIp(req) || 'unknown'}`,
});

function getRequestOrigin(req) {
  const forwardedProto = req.get('x-forwarded-proto');
  const protocol = (forwardedProto || req.protocol || 'http').split(',')[0].trim();
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${protocol}://${host}`;
}

function getGoogleRedirectUri(req) {
  return process.env.GOOGLE_REDIRECT_URI || `${getRequestOrigin(req)}/api/auth/google/callback`;
}

function getGoogleOauthConfig(req) {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || '').trim();
  const redirectUri = getGoogleRedirectUri(req);

  if (!clientId || !clientSecret) {
    return null;
  }

  return {
    clientId,
    clientSecret,
    redirectUri,
  };
}

function setGoogleOauthStateCookie(res, stateToken) {
  res.cookie(GOOGLE_OAUTH_STATE_COOKIE_NAME, stateToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: new Date(Date.now() + GOOGLE_OAUTH_STATE_DURATION_MS),
  });
}

function clearGoogleOauthStateCookie(res) {
  res.clearCookie(GOOGLE_OAUTH_STATE_COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  });
}

function getGoogleOauthStateFromRequest(req) {
  const cookies = parseCookies(req);
  return cookies[GOOGLE_OAUTH_STATE_COOKIE_NAME] || '';
}

function buildAuthRedirectUrl(basePath, params = {}) {
  const searchParams = new URLSearchParams();
  Object.keys(params).forEach((key) => {
    if (params[key]) searchParams.set(key, String(params[key]));
  });

  const queryString = searchParams.toString();
  return queryString ? `${basePath}?${queryString}` : basePath;
}

async function exchangeGoogleAuthCode({ code, req }) {
  const config = getGoogleOauthConfig(req);
  if (!config) {
    throw Object.assign(new Error('Login com Google não está configurado.'), { statusCode: 503 });
  }

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  });

  const tokenPayload = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokenPayload.access_token) {
    throw Object.assign(new Error('Falha ao autenticar com o Google.'), {
      statusCode: 502,
      details: tokenPayload,
    });
  }

  const userInfoResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: {
      Authorization: `Bearer ${tokenPayload.access_token}`,
    },
  });

  const userInfo = await userInfoResponse.json().catch(() => ({}));
  if (!userInfoResponse.ok || !userInfo.sub || !userInfo.email) {
    throw Object.assign(new Error('Não foi possível obter os dados da conta Google.'), {
      statusCode: 502,
      details: userInfo,
    });
  }

  return userInfo;
}

async function upsertGoogleUser(googleProfile, queryable) {
  const email = normalizeEmail(googleProfile.email || '');
  const fullName = normalizeQuery(googleProfile.name || googleProfile.given_name || email.split('@')[0] || 'Usuário Google');
  const profilePhotoUrl = normalizeQuery(googleProfile.picture || '');
  const emailVerifiedAt = googleProfile.email_verified ? new Date() : null;

  let user = await findUserByGoogleSub(googleProfile.sub, queryable);
  if (user) {
    user = await updateUserProfile({
      userId: user.id,
      fullName: user.full_name || fullName,
      profilePhotoUrl: user.profile_photo_path ? user.profile_photo_url || '' : profilePhotoUrl,
      googleSub: googleProfile.sub,
      emailVerifiedAt,
    }, queryable);
    return user;
  }

  user = await findUserByEmail(email, queryable);
  if (user) {
    if (user.google_sub && user.google_sub !== googleProfile.sub) {
      throw Object.assign(new Error('Esta conta já está vinculada a outro login Google.'), {
        statusCode: 409,
      });
    }

    user = await updateUserProfile({
      userId: user.id,
      profilePhotoUrl: user.profile_photo_path ? user.profile_photo_url || '' : profilePhotoUrl,
      googleSub: googleProfile.sub,
      emailVerifiedAt,
    }, queryable);
    return user;
  }

  return createUser({
    fullName,
    email,
    passwordHash: await hashPassword(createSessionToken()),
    googleSub: googleProfile.sub,
    profilePhotoUrl,
    emailVerifiedAt,
  }, queryable);
}

function makeSafeFileName(name = 'arquivo') {
  const value = String(name || 'arquivo')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);

  return value || 'arquivo';
}

function buildChatTitleFromInput(question, files = []) {
  const normalizedQuestion = normalizeQuery(question || '');
  if (normalizedQuestion) {
    return normalizedQuestion.slice(0, 80);
  }

  if (files.length) {
    return files
      .map((file) => normalizeUploadedFileName(file.originalname))
      .join(', ')
      .slice(0, 80) || 'Novo chat';
  }

  return 'Novo chat';
}

async function sha256ForFile(filePath) {
  const buffer = await fs.promises.readFile(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function persistUploadedFileCopy(file, { userId, chatId, messageId }) {
  const originalName = normalizeUploadedFileName(file.originalname);
  const extension = path.extname(originalName).toLowerCase();
  const baseName = path.basename(originalName, extension);
  const safeBaseName = makeSafeFileName(baseName);
  const targetDir = path.join(
    ATTACHMENT_STORAGE_DIR,
    `user-${userId}`,
    `chat-${chatId}`,
    `message-${messageId}`
  );

  await fs.promises.mkdir(targetDir, { recursive: true });

  const storedName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeBaseName}${extension}`;
  const targetPath = path.join(targetDir, storedName);

  await fs.promises.copyFile(file.path, targetPath);

  return {
    displayName: originalName,
    originalName,
    mimeType: file.mimetype,
    fileExtension: extension || null,
    byteSize: file.size || null,
    checksumSha256: await sha256ForFile(targetPath),
    storagePath: targetPath,
  };
}

function buildAttachmentPersistencePayload(file, storedFile, extractedFile) {
  const extractedMetadata = {
    extractedType: extractedFile?.type || 'unknown',
  };

  let processingStatus = 'processed';
  let extractedText = null;

  if (extractedFile?.type === 'text') {
    extractedText = extractedFile.content || null;
  } else if (extractedFile?.type === 'image') {
    extractedMetadata.imageMime = extractedFile.mime || null;
  } else if (extractedFile?.type === 'pdf_images') {
    extractedMetadata.reason = extractedFile.reason || null;
    extractedMetadata.derivedImageCount = Array.isArray(extractedFile.images) ? extractedFile.images.length : 0;
  } else if (extractedFile?.type === 'unsupported') {
    processingStatus = 'unsupported';
  } else if (extractedFile?.type === 'error') {
    processingStatus = 'failed';
    extractedMetadata.reason = extractedFile.reason || null;
  }

  return {
    attachmentKind: 'original_file',
    processingStatus,
    displayName: storedFile.displayName,
    originalName: storedFile.originalName,
    mimeType: storedFile.mimeType,
    fileExtension: storedFile.fileExtension,
    byteSize: storedFile.byteSize,
    checksumSha256: storedFile.checksumSha256,
    storageProvider: 'local',
    storagePath: storedFile.storagePath,
    publicUrl: null,
    extractedText,
    extractedMetadata,
  };
}

async function saveProfilePhotoFile(file, userId) {
  const originalName = normalizeUploadedFileName(file.originalname);
  const extension = path.extname(originalName).toLowerCase();

  if (!PROFILE_PHOTO_MIME_TYPES.has(file.mimetype) || !PROFILE_PHOTO_EXTENSIONS.has(extension)) {
    throw Object.assign(new Error('Envie uma imagem JPG, PNG ou WEBP.'), { statusCode: 400 });
  }

  if ((file.size || 0) > PROFILE_MAX_FILE_SIZE) {
    throw Object.assign(new Error('A foto de perfil deve ter no máximo 5MB.'), { statusCode: 400 });
  }

  const targetDir = path.join(PROFILE_STORAGE_DIR, `user-${userId}`);
  await fs.promises.mkdir(targetDir, { recursive: true });

  const safeBaseName = makeSafeFileName(path.basename(originalName, extension));
  const targetPath = path.join(
    targetDir,
    `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeBaseName}${extension}`
  );

  await fs.promises.copyFile(file.path, targetPath);
  return targetPath;
}

async function issueSessionForUser(res, req, user, queryable) {
  const sessionToken = createSessionToken();
  const sessionTokenHash = hashSessionToken(sessionToken);
  const expiresAt = buildSessionExpiry();

  await createAuthSession({
    userId: user.id,
    sessionTokenHash,
    userAgent: req.get('user-agent') || null,
    ipAddress: getClientIp(req),
    expiresAt,
  }, queryable);

  setSessionCookie(res, sessionToken, expiresAt);
}

async function loadAuthenticatedSession(req, res, next) {
  const sessionToken = getSessionTokenFromRequest(req);

  if (!sessionToken) {
    req.auth = null;
    return next();
  }

  try {
    const session = await findSessionUserByTokenHash(hashSessionToken(sessionToken));

    if (!session) {
      req.auth = null;
      clearSessionCookie(res);
      return next();
    }

    req.auth = {
      sessionId: session.session_id,
      user: serializeUser(session),
      userRow: session,
    };

    const lastSeenAt = session.last_seen_at ? new Date(session.last_seen_at).getTime() : 0;
    if (!lastSeenAt || Date.now() - lastSeenAt > 5 * 60 * 1000) {
      touchSession(session.session_id).catch(() => {});
    }

    return next();
  } catch (error) {
    return next(error);
  }
}

function requireAuth(req, res, next) {
  if (!req.auth?.user) {
    return res.status(401).json({ error: 'Faça login para continuar.' });
  }

  return next();
}

app.use('/api', loadAuthenticatedSession);

app.get('/privacy', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'privacy.html'));
});

app.get('/terms', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'terms.html'));
});

app.get('/api/health', async (req, res) => {
  try {
    const { rows } = await query('select now() as now');
    res.json({
      ok: true,
      dbTime: rows[0].now,
      uptimeSeconds: Math.round(process.uptime()),
      nodeEnv: process.env.NODE_ENV || 'development',
    });
  } catch {
    res.status(500).json({ ok: false });
  }
});

app.get('/api/auth/me', (req, res) => {
  if (!req.auth?.user) {
    return res.json({ user: null });
  }

  return res.json({ user: req.auth.user });
});

app.get('/api/auth/google', googleAuthRateLimiter, (req, res) => {
  const config = getGoogleOauthConfig(req);
  if (!config) {
    return res.redirect(buildAuthRedirectUrl('/', { auth_error: 'google_nao_configurado' }));
  }

  const stateToken = createSessionToken();
  setGoogleOauthStateCookie(res, stateToken);

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', config.clientId);
  authUrl.searchParams.set('redirect_uri', config.redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid email profile');
  authUrl.searchParams.set('state', stateToken);
  authUrl.searchParams.set('prompt', 'select_account');

  return res.redirect(authUrl.toString());
});

app.get('/api/auth/google/callback', async (req, res) => {
  const returnedState = String(req.query?.state || '');
  const storedState = getGoogleOauthStateFromRequest(req);
  clearGoogleOauthStateCookie(res);

  if (!returnedState || !storedState || returnedState !== storedState) {
    return res.redirect(buildAuthRedirectUrl('/', { auth_error: 'google_state_invalido' }));
  }

  if (req.query?.error) {
    return res.redirect(buildAuthRedirectUrl('/', { auth_error: 'google_cancelado' }));
  }

  const code = String(req.query?.code || '');
  if (!code) {
    return res.redirect(buildAuthRedirectUrl('/', { auth_error: 'google_sem_codigo' }));
  }

  try {
    const googleProfile = await exchangeGoogleAuthCode({ code, req });
    let user;

    await withTransaction(async (client) => {
      user = await upsertGoogleUser(googleProfile, client);
      await touchUserLastLogin(user.id, client);
      await issueSessionForUser(res, req, user, client);
    });

    return res.redirect(buildAuthRedirectUrl('/', { auth_success: 'google' }));
  } catch (error) {
    console.error('Falha no OAuth Google:', error);
    return res.redirect(buildAuthRedirectUrl('/', { auth_error: 'google_falhou' }));
  }
});

app.post('/api/auth/signup', signupRateLimiter, async (req, res) => {
  const fullName = normalizeQuery(req.body?.fullName || '');
  const email = normalizeEmail(req.body?.email || '');
  const password = String(req.body?.password || '');

  if (fullName.length < 3) {
    return res.status(400).json({ error: 'Informe o nome completo.' });
  }

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Informe um e-mail válido.' });
  }

  if (!validatePasswordStrength(password)) {
    return res.status(400).json({ error: 'A senha deve ter pelo menos 8 caracteres.' });
  }

  try {
    let createdUser;

    await withTransaction(async (client) => {
      const existingUser = await findUserByEmail(email, client);
      if (existingUser) {
        throw Object.assign(new Error('Já existe uma conta com esse e-mail.'), { statusCode: 409 });
      }

      createdUser = await createUser({
        fullName,
        email,
        passwordHash: await hashPassword(password),
      }, client);

      await touchUserLastLogin(createdUser.id, client);
      await issueSessionForUser(res, req, createdUser, client);
    });

    return res.status(201).json({ user: serializeUser(createdUser) });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : 'Não foi possível criar a conta.',
    });
  }
});

app.post('/api/auth/login', loginRateLimiter, async (req, res) => {
  const email = normalizeEmail(req.body?.email || '');
  const password = String(req.body?.password || '');

  if (!email || !password) {
    return res.status(400).json({ error: 'Informe e-mail e senha.' });
  }

  try {
    const user = await findUserByEmail(email);
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
    }

    if (!user.is_active) {
      return res.status(403).json({ error: 'Sua conta está desativada.' });
    }

    await withTransaction(async (client) => {
      await touchUserLastLogin(user.id, client);
      await issueSessionForUser(res, req, user, client);
    });

    return res.json({ user: serializeUser(user) });
  } catch {
    return res.status(500).json({ error: 'Não foi possível entrar agora.' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    if (req.auth?.sessionId) {
      await revokeSession(req.auth.sessionId);
    }
  } catch {}

  clearSessionCookie(res);
  return res.json({ ok: true });
});

app.put('/api/profile', requireAuth, async (req, res) => {
  const fullName = normalizeQuery(req.body?.fullName || '');

  if (fullName.length < 3) {
    return res.status(400).json({ error: 'Informe um nome válido.' });
  }

  try {
    const user = await updateUserProfile({ userId: req.auth.user.id, fullName });
    return res.json({ user: serializeUser(user) });
  } catch {
    return res.status(500).json({ error: 'Não foi possível atualizar o nome.' });
  }
});

app.put('/api/profile/theme', requireAuth, async (req, res) => {
  const theme = resolveThemeName(req.body?.theme);

  if (!theme) {
    return res.status(400).json({ error: 'Tema inválido.' });
  }

  try {
    const user = await updateUserTheme(req.auth.user.id, theme);
    return res.json({ user: serializeUser(user) });
  } catch {
    return res.status(500).json({ error: 'Não foi possível atualizar o tema.' });
  }
});

app.put('/api/profile/password', requireAuth, async (req, res) => {
  const currentPassword = String(req.body?.currentPassword || '');
  const newPassword = String(req.body?.newPassword || '');

  if (!validatePasswordStrength(newPassword)) {
    return res.status(400).json({ error: 'A nova senha deve ter pelo menos 8 caracteres.' });
  }

  try {
    const freshUser = await findUserById(req.auth.user.id);
    if (!freshUser || !(await verifyPassword(currentPassword, freshUser.password_hash))) {
      return res.status(401).json({ error: 'A senha atual está incorreta.' });
    }

    await updateUserPassword(req.auth.user.id, await hashPassword(newPassword));
    return res.json({ ok: true });
  } catch {
    return res.status(500).json({ error: 'Não foi possível atualizar a senha.' });
  }
});

app.post('/api/profile/photo', requireAuth, upload.single('photo'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Envie uma imagem.' });
  }

  try {
    const currentUser = await findUserById(req.auth.user.id);
    const nextPhotoPath = await saveProfilePhotoFile(req.file, req.auth.user.id);
    const user = await updateUserProfile({
      userId: req.auth.user.id,
      profilePhotoPath: nextPhotoPath,
    });

    if (currentUser?.profile_photo_path && currentUser.profile_photo_path !== nextPhotoPath) {
      safeUnlink(currentUser.profile_photo_path).catch(() => {});
    }

    return res.json({ user: serializeUser(user) });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : 'Não foi possível atualizar a foto.',
    });
  } finally {
    await safeUnlink(req.file.path);
  }
});

app.get('/api/profile/photo', requireAuth, async (req, res) => {
  const user = await findUserById(req.auth.user.id);

  if (!user?.profile_photo_path) {
    return res.status(404).end();
  }

  try {
    await fs.promises.access(user.profile_photo_path, fs.constants.R_OK);
    return res.sendFile(user.profile_photo_path);
  } catch {
    return res.status(404).end();
  }
});

app.get('/api/chats', requireAuth, async (req, res) => {
  try {
    const chats = await listChatsForUser(req.auth.user.id);
    return res.json({ chats: chats.map(serializeChat) });
  } catch {
    return res.status(500).json({ error: 'Não foi possível carregar os chats.' });
  }
});

app.get('/api/chats/:chatId', requireAuth, async (req, res) => {
  const chatId = parsePositiveInt(req.params.chatId);
  if (!chatId) {
    return res.status(400).json({ error: 'Chat inválido.' });
  }

  try {
    const chat = await getChatForUser(chatId, req.auth.user.id);
    if (!chat) {
      return res.status(404).json({ error: 'Chat não encontrado.' });
    }

    const messages = await listChatMessagesForUser(chat.id, req.auth.user.id, req.auth.user.id);
    return res.json({
      chat: serializeChat(chat),
      messages: messages.map(serializeMessage),
    });
  } catch {
    return res.status(500).json({ error: 'Não foi possível carregar a conversa.' });
  }
});

app.delete('/api/chats/:chatId', requireAuth, async (req, res) => {
  const chatId = parsePositiveInt(req.params.chatId);
  if (!chatId) {
    return res.status(400).json({ error: 'Chat inválido.' });
  }

  try {
    const deletedChat = await softDeleteChatForUser(chatId, req.auth.user.id);
    if (!deletedChat) {
      return res.status(404).json({ error: 'Chat não encontrado.' });
    }

    return res.json({
      ok: true,
      chat: serializeChat(deletedChat),
    });
  } catch {
    return res.status(500).json({ error: 'Não foi possível excluir o chat.' });
  }
});

app.get('/api/attachments/:attachmentId', requireAuth, async (req, res) => {
  const attachmentId = parsePositiveInt(req.params.attachmentId);
  if (!attachmentId) {
    return res.status(400).json({ error: 'Anexo inválido.' });
  }

  try {
    const attachment = await getAttachmentForUser(attachmentId, req.auth.user.id);
    if (!attachment?.storage_path) {
      return res.status(404).json({ error: 'Anexo não encontrado.' });
    }

    await fs.promises.access(attachment.storage_path, fs.constants.R_OK);
    return res.download(attachment.storage_path, attachment.original_name);
  } catch {
    return res.status(404).json({ error: 'Anexo não encontrado.' });
  }
});

app.post('/api/messages/:messageId/feedback', requireAuth, feedbackRateLimiter, async (req, res) => {
  const messageId = parsePositiveInt(req.params.messageId);
  if (!messageId) {
    return res.status(400).json({ error: 'Mensagem inválida.' });
  }

  const feedbackValue = req.body?.feedbackValue === 'not_useful' ? 'not_useful' : 'useful';
  const issueType = ['incorrect_answer', 'missing_information', 'outdated_content', 'bad_source', 'other']
    .includes(req.body?.issueType)
    ? req.body.issueType
    : 'other';
  const comment = normalizeQuery(req.body?.comment || '');
  const suggestedCorrection = normalizeQuery(req.body?.suggestedCorrection || '');
  const expectedAnswer = normalizeQuery(req.body?.expectedAnswer || '');

  try {
    const message = await getMessageForUser(messageId, req.auth.user.id);
    if (!message || message.role !== 'assistant') {
      return res.status(404).json({ error: 'Mensagem não encontrada.' });
    }

    const feedback = await upsertMessageFeedback({
      messageId,
      userId: req.auth.user.id,
      feedbackValue,
      comment,
    });

    let queueItem = null;

    if (feedbackValue === 'not_useful' || suggestedCorrection || expectedAnswer) {
      const messages = await listChatMessagesForUser(message.chat_id, req.auth.user.id, req.auth.user.id);
      const targetMessage = messages.find((item) => item.id === messageId) || null;

      queueItem = await upsertKnowledgeFeedbackQueue({
        reportedByUserId: req.auth.user.id,
        chatId: message.chat_id,
        messageId,
        feedbackId: feedback.id,
        issueType,
        title: normalizeQuery(req.body?.title || `Correção da resposta ${messageId}`).slice(0, 180) || `Correção da resposta ${messageId}`,
        userComment: comment,
        suggestedCorrection,
        expectedAnswer,
        sourceSnapshot: (targetMessage?.sources || []).map(serializeSource),
        attachmentSnapshot: (targetMessage?.attachments || []).map(serializeAttachment),
        requestSnapshot: {
          requestId: message.request_id,
          modelName: message.model_name,
          answerPreview: (message.content_text || '').slice(0, 400),
        },
      });
    }

    return res.json({
      feedback: {
        id: feedback.id,
        feedbackValue: feedback.feedback_value,
        comment: feedback.comment || '',
      },
      queueItemId: queueItem?.id || null,
    });
  } catch {
    return res.status(500).json({ error: 'Não foi possível salvar o feedback.' });
  }
});

const OPENAI_MODEL = 'gpt-4o';
const SYSTEM_PROMPT = `Você é o SmartAI, assistente de suporte interno da Smart Leilões, atuando no segmento Smart Caixa.

Se te perguntarem quem foi André Prado, responda dizendo 'Grande Amigo do Davi Tigela - Sistemas'.

Seu papel é esclarecer dúvidas dos colaboradores com profundidade e detalhamento. Ao responder, antecipe dúvidas relacionadas, possíveis contra-argumentos e cenários alternativos — tudo numa única mensagem completa, por mais longa que seja. Prefira sempre a resposta mais completa possível. Se o usuário pedir objetividade, seja mais direto, mas mantenha a precisão e o profissionalismo.

REGRAS DE COMPORTAMENTO:
- Responda SOMENTE com base na documentação interna fornecida no contexto. Ela é sua única fonte de verdade.
- Quando houver arquivos anexados nesta conversa, trate-os como prioridade maxima. Analise primeiro os anexos e so depois use o Notion como contexto complementar.
- Nao confunda arquivos anexados nesta conversa com paginas ou documentos da base do Notion.
- Os documentos chegam como trechos extraídos do Notion. Trate cada trecho como conteúdo literal da página indicada pelo título e pela seção.
- Se houver múltiplos trechos do mesmo documento, combine as informações antes de decidir que faltam dados.
- Nunca invente, suponha, complete lacunas com suposições ou recorra a conhecimento externo. Se não está na documentação, não está na resposta.
- Sempre que citar uma informação, identifique o nome real da página/documento do Notion (ex: "conforme a página Política de Reembolso"). Nunca use rótulos como Doc 1, Doc 2 ou similares.
- Se o usuario perguntar sobre um arquivo anexado e ele nao puder ser lido, diga claramente que nao foi possivel analisar o anexo. Nao responda como se o arquivo tivesse sido compreendido.
- Só use a frase de indisponibilidade quando nenhum trecho fornecido abordar a pergunta.
- Se a informação solicitada não constar em nenhum documento disponível, responda exatamente: "Não encontrei essa informação na base de conhecimento interna. Tente contatar o responsável pela área ou o setor de Sistemas." Não adicione suposições após essa frase.
- Responda sempre em português, com linguagem profissional e acessível.
- Use markdown simples e consistente: use apenas "## Titulo" para seções principais, "-" ou "1." para listas e "**destaque**" para pontos importantes.
- Evite usar "###", tabelas, excesso de formatação ou estilos incomuns.
- Em respostas longas, use subtítulos, listas e estrutura clara para facilitar a leitura.`;

function buildOpenAiPayload(messages) {
  return {
    model: OPENAI_MODEL,
    max_tokens: 5632,
    messages: [
      {
        role: 'system',
        content: SYSTEM_PROMPT,
      },
      ...messages,
    ],
  };
}

function getSourcesFromPages(pages) {
  return pages.map((page) => ({ title: page.title, url: page.url, score: page.score }));
}

function createRequestId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizePayloadForLog(payload) {
  return JSON.parse(JSON.stringify(payload, (key, value) => {
    if (key === 'url' && typeof value === 'string' && value.startsWith('data:')) {
      return `[data-url omitted; ${value.length} chars]`;
    }

    return value;
  }));
}

function buildPagesDebug(pages) {
  return pages.map((page) => ({
    title: page.title,
    url: page.url,
    score: page.score,
    snippets: page.snippets,
  }));
}

function buildFilesDebug(extracted = []) {
  return extracted.map((file) => ({
    name: file.name,
    type: file.type,
    reason: file.reason || null,
    imageCount: Array.isArray(file.images) ? file.images.length : 0,
    textPreview: file.type === 'text' ? file.content.slice(0, 140) : '',
  }));
}

function logRequestDebug({ requestId, question, history, context, pages, sources, unsupported, fileIssues, extracted, openAiPayload, wantsStream }) {
  console.log(`\n[SmartAI][${requestId}] ===== DEBUG REQUEST =====`);
  console.log(`[SmartAI][${requestId}] Pergunta: ${question}`);
  console.log(`[SmartAI][${requestId}] Streaming: ${wantsStream ? 'sim' : 'nao'}`);
  console.log(`[SmartAI][${requestId}] Historico:`, history);
  console.log(`[SmartAI][${requestId}] Referencias recuperadas:`, sources);
  console.log(`[SmartAI][${requestId}] Paginas ranqueadas:`, buildPagesDebug(pages));
  console.log(`[SmartAI][${requestId}] Anexos extraidos:`, buildFilesDebug(extracted));
  console.log(`[SmartAI][${requestId}] Contexto Notion enviado:\n${context || '(vazio)'}`);
  console.log(`[SmartAI][${requestId}] Arquivos nao suportados:`, unsupported);
  console.log(`[SmartAI][${requestId}] Arquivos com falha de leitura:`, fileIssues);
  console.log(`[SmartAI][${requestId}] Pensamento interno do modelo: indisponivel via API. Registrando apenas payload, referencias e resposta observavel.`);
  console.log(`[SmartAI][${requestId}] Payload enviado ao modelo:`);
  console.dir(sanitizePayloadForLog(openAiPayload), { depth: null, maxArrayLength: null });
}

function logResponseDebug({ requestId, answer, sources, totalMs, aiMs, firstTokenMs, chunkCount }) {
  console.log(`[SmartAI][${requestId}] Chunks recebidos: ${chunkCount}`);
  if (firstTokenMs !== null) {
    console.log(`[SmartAI][${requestId}] Primeiro chunk em: ${firstTokenMs}ms`);
  }
  console.log(`[SmartAI][${requestId}] Tempo da IA: ${aiMs}ms`);
  console.log(`[SmartAI][${requestId}] Tempo total da requisicao: ${totalMs}ms`);
  console.log(`[SmartAI][${requestId}] Fontes finais:`, sources);
  console.log(`[SmartAI][${requestId}] Resposta final:\n${answer}`);
  console.log(`[SmartAI][${requestId}] ===== FIM DEBUG =====\n`);
}

function createStageTimer() {
  const stages = {};

  return {
    async measure(name, operation) {
      const startedAt = Date.now();
      try {
        return await operation();
      } finally {
        stages[name] = (stages[name] || 0) + (Date.now() - startedAt);
      }
    },
    measureSync(name, operation) {
      const startedAt = Date.now();
      try {
        return operation();
      } finally {
        stages[name] = (stages[name] || 0) + (Date.now() - startedAt);
      }
    },
    snapshot() {
      return { ...stages };
    },
  };
}

function logStageMetrics(requestId, stageTimings = {}, notionMetrics = null) {
  console.log(`[SmartAI][${requestId}] Etapas da requisicao:`, stageTimings);

  if (notionMetrics?.passes?.length) {
    console.log(`[SmartAI][${requestId}] Metricas Notion:`, notionMetrics);
  }
}

function prepareStreamResponse(res) {
  res.status(200);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }
}

function writeStreamEvent(res, payload) {
  res.write(`${JSON.stringify(payload)}\n`);
}

function getMessageText(content) {
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (typeof part?.text === 'string') return part.text;
        if (typeof part?.text?.value === 'string') return part.text.value;
        return '';
      })
      .join('');
  }

  return '';
}

function getDeltaTextFromChunk(chunk) {
  return getMessageText(chunk?.choices?.[0]?.delta?.content);
}

/* ═══════════════════════════════════════════════
   ROTA PRINCIPAL  POST /api/ask
═══════════════════════════════════════════════ */
app.post('/api/ask', requireAuth, askRateLimiter, upload.array('files', 5), async (req, res) => {
  const requestId = createRequestId();
  const requestStartedAt = Date.now();
  const wantsStream = req.get('x-response-mode') === 'stream';
  const stageTimer = createStageTimer();
  let question;
  let history = [];
  let chatId = null;
  let notionMetrics = null;

  if (req.is('application/json')) {
    ({ question, history = [], chatId } = req.body);
    history = sanitizeHistory(history);
  } else {
    question = req.body.question;
    chatId = req.body.chatId;
    history = parseHistoryField(req.body.history);
  }

  const files = req.files || [];
  if (!question && files.length === 0) {
    return res.status(400).json({ error: 'Envie uma pergunta ou arquivo.' });
  }

  const displayQuestion = normalizeQuery(question || '');
  question = displayQuestion || '(sem texto - analise os arquivos anexados)';

  try {
    const requestedChatId = parsePositiveInt(chatId);
    let chat = null;

    if (requestedChatId) {
      chat = await stageTimer.measure('loadChat', async () => (
        getChatForUser(requestedChatId, req.auth.user.id)
      ));
      if (!chat) {
        return res.status(404).json({ error: 'Chat não encontrado.' });
      }
      history = await stageTimer.measure('loadHistory', async () => (
        listRecentHistoryMessages(chat.id, req.auth.user.id, 10)
      ));
    }

    if (!chat) {
      chat = await stageTimer.measure('createChat', async () => (
        createChatThread({
          ownerUserId: req.auth.user.id,
          title: buildChatTitleFromInput(displayQuestion, files),
        })
      ));
    } else {
      await stageTimer.measure('refreshChatTitle', async () => (
        updateChatTitleIfDefault(chat.id, buildChatTitleFromInput(displayQuestion, files))
      ));
    }

    const userMessage = await stageTimer.measure('saveUserMessage', async () => (
      createMessage({
        chatId: chat.id,
        authorUserId: req.auth.user.id,
        role: 'user',
        contentText: displayQuestion,
        contentFormat: 'plain_text',
        metadata: {
          hasAttachments: files.length > 0,
        },
      })
    ));

    const storedFiles = files.length
      ? await stageTimer.measure('persistFiles', async () => (
        Promise.all(
          files.map((file) => persistUploadedFileCopy(file, {
            userId: req.auth.user.id,
            chatId: chat.id,
            messageId: userMessage.id,
          }))
        )
      ))
      : [];

    const extracted = files.length
      ? await stageTimer.measure('extractFiles', async () => Promise.all(files.map(extractFileContent)))
      : [];
    const attachmentPayloads = files.map((file, index) => (
      buildAttachmentPersistencePayload(file, storedFiles[index], extracted[index])
    ));

    if (attachmentPayloads.length) {
      await stageTimer.measure('saveAttachments', async () => (
        createMessageAttachments(userMessage.id, attachmentPayloads)
      ));
    }

    const unsupported = extracted.filter((f) => f.type === 'unsupported').map((f) => f.name);
    const fileIssues = extracted
      .filter((f) => f.type === 'error')
      .map((f) => ({ name: f.name, reason: f.reason }));
    const readableFiles = extracted.filter(isReadableExtractedFile);
    const shouldSearchNotion = shouldSearchNotionForRequest(question, readableFiles, files);
    const notionQuestion = shouldSearchNotion
      ? normalizeQuery(`${question} ${buildAttachmentSearchText(readableFiles)}`.slice(0, 900))
      : '';
    const notionSearchResult = shouldSearchNotion
      ? await stageTimer.measure('searchNotion', async () => searchNotion(notionQuestion || question, history))
      : { pages: [], metrics: null };
    const pages = notionSearchResult.pages;
    notionMetrics = notionSearchResult.metrics;
    const context = stageTimer.measureSync('buildContext', () => buildContextFromPages(pages));

    if (files.length && !readableFiles.length) {
      const errorPayload = {
        error: 'Nao consegui ler os arquivos anexados. Tente reenviar o arquivo ou usar uma versao pesquisavel.',
        chatId: chat.id,
        userMessageId: userMessage.id,
      };

      if (unsupported.length) errorPayload.unsupported = unsupported;
      if (fileIssues.length) errorPayload.fileIssues = fileIssues;
      console.log(`[SmartAI][${requestId}] Anexos extraidos:`, buildFilesDebug(extracted));
      console.log(`[SmartAI][${requestId}] Nenhum anexo legivel foi extraido. Encerrando antes de consultar o modelo.`);
      return res.status(422).json(errorPayload);
    }

    const userContentParts = [];
    const textBlock = buildUserPromptText({
      question,
      hasAttachments: files.length > 0,
      hasKnowledgeBase: Boolean(context),
    });
    userContentParts.push({ type: 'text', text: textBlock });

    extracted.filter((f) => f.type === 'text').forEach((f) => {
      userContentParts.push({
        type: 'text',
        text: `\n\n[Arquivo anexado nesta conversa: ${f.name}]\nConteudo extraido:\n${f.content}`,
      });
    });

    extracted.filter((f) => f.type === 'image').forEach((f) => {
      userContentParts.push({
        type: 'image_url',
        image_url: { url: `data:${f.mime};base64,${f.base64}`, detail: 'high' },
      });
      userContentParts.push({ type: 'text', text: `[Imagem anexada nesta conversa: ${f.name}]` });
    });

    extracted.filter((f) => f.type === 'pdf_images').forEach((f) => {
      userContentParts.push({
        type: 'text',
        text: `[PDF anexado nesta conversa: ${f.name}] O PDF foi convertido em imagens para analise visual.`,
      });
      f.images.forEach((image) => {
        userContentParts.push({
          type: 'image_url',
          image_url: { url: `data:${image.mime};base64,${image.base64}`, detail: 'high' },
        });
        userContentParts.push({ type: 'text', text: `[Pagina do PDF anexado: ${image.name}]` });
      });
    });

    if (context) {
      userContentParts.push({
        type: 'text',
        text: `\n\n[Base de conhecimento do Notion - contexto complementar]\n${context}`,
      });
    }

    const { messages, sources, persistableSources, openAiPayload } = stageTimer.measureSync('buildPrompt', () => {
      const nextMessages = [
        ...history.map((m) => ({ role: m.role, content: m.content })),
        {
          role: 'user',
          content: userContentParts.length === 1 ? userContentParts[0].text : userContentParts,
        },
      ];

      return {
        messages: nextMessages,
        sources: getSourcesFromPages(pages),
        persistableSources: buildPersistableSources(pages),
        openAiPayload: buildOpenAiPayload(nextMessages),
      };
    });

    logRequestDebug({
      requestId,
      question,
      history,
      context,
      pages,
      sources,
      unsupported,
      fileIssues,
      extracted,
      openAiPayload,
      wantsStream,
    });

    if (wantsStream) {
      prepareStreamResponse(res);
      writeStreamEvent(res, {
        type: 'meta',
        data: {
          requestId,
          chatId: chat.id,
          userMessageId: userMessage.id,
          sources,
          unsupported,
          fileIssues,
        },
      });

      const aiStartedAt = Date.now();
      let firstTokenAt = null;
      let chunkCount = 0;
      let answer = '';

      const stream = await openai.chat.completions.create({
        ...openAiPayload,
        stream: true,
      });

      for await (const chunk of stream) {
        const delta = getDeltaTextFromChunk(chunk);
        if (!delta) continue;

        if (!firstTokenAt) {
          firstTokenAt = Date.now();
        }

        chunkCount += 1;
        answer += delta;
        console.log(`[SmartAI][${requestId}] chunk ${chunkCount}:`, JSON.stringify(delta));
        writeStreamEvent(res, { type: 'chunk', delta });
      }

      const totalMs = Date.now() - requestStartedAt;
      const aiMs = Date.now() - aiStartedAt;
      const firstTokenMs = firstTokenAt ? firstTokenAt - aiStartedAt : null;
      const stageTimings = stageTimer.snapshot();
      stageTimings.openAi = aiMs;
      const payload = {
        answer,
        requestId,
        chatId: chat.id,
        userMessageId: userMessage.id,
        timings: {
          totalMs,
          aiMs,
          firstTokenMs,
          stages: stageTimings,
          notion: notionMetrics,
        },
        sources,
      };

      if (unsupported.length) payload.unsupported = unsupported;
      if (fileIssues.length) payload.fileIssues = fileIssues;

      const assistantMessage = await stageTimer.measure('saveAssistantMessage', async () => (
        createMessage({
          chatId: chat.id,
          authorUserId: null,
          role: 'assistant',
          contentText: answer,
          contentFormat: 'markdown',
          requestId,
          modelName: OPENAI_MODEL,
          totalLatencyMs: totalMs,
          aiLatencyMs: aiMs,
          firstTokenMs,
          metadata: {
            sources,
            unsupported,
            fileIssues,
            hasAttachments: files.length > 0,
          },
        })
      ));

      if (persistableSources.length) {
        await stageTimer.measure('saveAssistantSources', async () => (
          createAssistantSources(assistantMessage.id, persistableSources)
        ));
      }

      payload.assistantMessageId = assistantMessage.id;
      payload.timings.stages = {
        ...stageTimer.snapshot(),
        openAi: aiMs,
      };

      logStageMetrics(requestId, payload.timings.stages, notionMetrics);
      logResponseDebug({
        requestId,
        answer,
        sources,
        totalMs,
        aiMs,
        firstTokenMs,
        chunkCount,
      });

      writeStreamEvent(res, { type: 'done', data: payload });
      return res.end();
    }

    const aiStartedAt = Date.now();
    const response = await openai.chat.completions.create(openAiPayload);
    const answer = getMessageText(response.choices[0]?.message?.content);
    const totalMs = Date.now() - requestStartedAt;
    const aiMs = Date.now() - aiStartedAt;
    const stageTimings = stageTimer.snapshot();
    stageTimings.openAi = aiMs;
    const payload = {
      answer,
      requestId,
      chatId: chat.id,
      userMessageId: userMessage.id,
      timings: {
        totalMs,
        aiMs,
        firstTokenMs: null,
        stages: stageTimings,
        notion: notionMetrics,
      },
      sources,
    };

    if (unsupported.length) payload.unsupported = unsupported;
    if (fileIssues.length) payload.fileIssues = fileIssues;

    const assistantMessage = await stageTimer.measure('saveAssistantMessage', async () => (
      createMessage({
        chatId: chat.id,
        authorUserId: null,
        role: 'assistant',
        contentText: answer,
        contentFormat: 'markdown',
        requestId,
        modelName: OPENAI_MODEL,
        totalLatencyMs: totalMs,
        aiLatencyMs: aiMs,
        firstTokenMs: null,
        metadata: {
          sources,
          unsupported,
          fileIssues,
          hasAttachments: files.length > 0,
        },
      })
    ));

    if (persistableSources.length) {
      await stageTimer.measure('saveAssistantSources', async () => (
        createAssistantSources(assistantMessage.id, persistableSources)
      ));
    }

    payload.assistantMessageId = assistantMessage.id;
    payload.timings.stages = {
      ...stageTimer.snapshot(),
      openAi: aiMs,
    };

    logStageMetrics(requestId, payload.timings.stages, notionMetrics);
    logResponseDebug({
      requestId,
      answer,
      sources,
      totalMs,
      aiMs,
      firstTokenMs: null,
      chunkCount: 0,
    });

    res.json(payload);
  } catch (err) {
    console.error(`[SmartAI][${requestId}] Erro ao processar requisicao:`, err);
    logStageMetrics(requestId, stageTimer.snapshot(), notionMetrics);

    if (wantsStream && res.headersSent) {
      writeStreamEvent(res, {
        type: 'error',
        error: 'Erro interno ao processar a pergunta.',
      });
      return res.end();
    }

    res.status(500).json({ error: 'Erro interno ao processar a pergunta.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('');
  console.log(`SmartAI rodando em http://localhost:${PORT}`);
  console.log(`Log persistido em ${LOG_FILE}`);
  console.log('Streaming de resposta: habilitado');
  console.log('Debug detalhado no console: habilitado');
  pool.query('select current_database() as db')
    .then((result) => {
      console.log(`Postgres conectado ao banco ${result.rows[0].db}`);
    })
    .catch((error) => {
      console.error('Falha ao conectar no Postgres:', error);
    });
  console.log('');
});
