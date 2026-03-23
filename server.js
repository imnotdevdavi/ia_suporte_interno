import 'dotenv/config';
import express from 'express';
import OpenAI from 'openai';
import { Client as NotionClient } from '@notionhq/client';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import fs from 'fs';
import mammoth from 'mammoth';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const notion = new NotionClient({ auth: process.env.NOTION_TOKEN });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const upload = multer({
  dest: '/tmp/smartai/',
  limits: { fileSize: 20 * 1024 * 1024 },
});

/* ═══════════════════════════════════════════════
   NOTION
═══════════════════════════════════════════════ */
const NOTION_SEARCH_LIMIT = 6;
const INITIAL_PAGE_LIMIT = 3;
const FALLBACK_PAGE_LIMIT = 5;
const INITIAL_BLOCK_LIMIT = 60;
const FALLBACK_BLOCK_LIMIT = 120;
const INITIAL_PAGE_CHARS = 2500;
const FALLBACK_PAGE_CHARS = 4500;
const MAX_CONTEXT_SNIPPETS = 6;
const MAX_SNIPPETS_PER_PAGE = 2;
const MIN_RELEVANT_SCORE = 6;

async function searchNotion(question, history = []) {
  const baseQuery = normalizeQuery(question);
  if (!baseQuery) return [];

  const initialCandidates = await runSearchPass({
    queries: buildPrimaryQueries(baseQuery),
    question,
    pageLimit: INITIAL_PAGE_LIMIT,
    blockLimit: INITIAL_BLOCK_LIMIT,
    charLimit: INITIAL_PAGE_CHARS,
  });

  if (hasStrongResults(initialCandidates)) {
    return initialCandidates;
  }

  const fallbackCandidates = await runSearchPass({
    queries: buildFallbackQueries(baseQuery, history),
    question,
    pageLimit: FALLBACK_PAGE_LIMIT,
    blockLimit: FALLBACK_BLOCK_LIMIT,
    charLimit: FALLBACK_PAGE_CHARS,
  });

  return mergeCandidates(initialCandidates, fallbackCandidates);
}

async function runSearchPass({ queries, question, pageLimit, blockLimit, charLimit }) {
  const pageMap = new Map();

  for (const query of queries) {
    if (!query) continue;

    const resp = await notion.search({
      query,
      filter: { value: 'page', property: 'object' },
      page_size: NOTION_SEARCH_LIMIT,
      sort: { direction: 'descending', timestamp: 'last_edited_time' },
    });

    for (const page of resp.results) {
      if (!pageMap.has(page.id)) {
        pageMap.set(page.id, {
          id: page.id,
          title: getTitle(page),
          url: page.url,
        });
      }
    }

    if (pageMap.size >= pageLimit) break;
  }

  const pages = Array.from(pageMap.values()).slice(0, pageLimit);
  const hydrated = await Promise.all(
    pages.map(async (page) => {
      const content = await getPageText(page.id, { blockLimit, charLimit });
      const snippets = selectRelevantSnippets(content, page.title, question);
      const score = snippets.reduce((sum, snippet) => sum + snippet.score, 0);
      return { ...page, content, snippets, score };
    })
  );

  return hydrated
    .filter((page) => page.content && page.snippets.length)
    .sort((a, b) => b.score - a.score)
    .slice(0, pageLimit);
}

function hasStrongResults(results) {
  if (!results.length) return false;
  return results.some((result) => result.score >= MIN_RELEVANT_SCORE);
}

function mergeCandidates(primary, fallback) {
  const merged = new Map();
  [...primary, ...fallback].forEach((item) => {
    const existing = merged.get(item.id);
    if (!existing || item.score > existing.score) {
      merged.set(item.id, item);
    }
  });

  return Array.from(merged.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, INITIAL_PAGE_LIMIT);
}

function buildPrimaryQueries(question) {
  const keywordQuery = buildKeywordFallback(question);
  return [...new Set([question.slice(0, 300), keywordQuery].filter(Boolean))];
}

function buildFallbackQueries(question, history = []) {
  const recentHistory = history
    .slice(-2)
    .map((msg) => msg?.content || '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  const withHistory = recentHistory ? `${question} ${recentHistory}`.slice(0, 450) : '';
  return [...new Set([
    ...buildPrimaryQueries(question),
    withHistory,
  ].filter(Boolean))];
}

function buildKeywordFallback(question) {
  return question
    .split(/\s+/)
    .map((word) => word.toLowerCase())
    .filter((word) => word.length > 3 && !STOP_WORDS.has(word))
    .slice(0, 8)
    .join(' ')
    .slice(0, 220);
}

function normalizeQuery(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

async function getPageText(pageId, { blockLimit, charLimit }) {
  try {
    const texts = [];
    await collectBlockText(pageId, texts, { count: 0, blockLimit, charLimit, chars: 0 });
    return texts.join('\n').slice(0, charLimit);
  } catch {
    return '';
  }
}

async function collectBlockText(blockId, texts, state) {
  let cursor;

  do {
    const blocks = await notion.blocks.children.list({
      block_id: blockId,
      page_size: 100,
      start_cursor: cursor,
    });

    for (const block of blocks.results) {
      if (state.count >= state.blockLimit || state.chars >= state.charLimit) return;

      const text = extractBlockText(block);
      if (text) {
        texts.push(text);
        state.count += 1;
        state.chars += text.length + 1;
      }

      if (block.has_children && state.count < state.blockLimit && state.chars < state.charLimit) {
        await collectBlockText(block.id, texts, state);
      }
    }

    cursor = blocks.has_more ? blocks.next_cursor : null;
  } while (cursor && state.count < state.blockLimit && state.chars < state.charLimit);
}

function extractBlockText(block) {
  const richTextTypes = [
    'paragraph', 'heading_1', 'heading_2', 'heading_3', 'bulleted_list_item',
    'numbered_list_item', 'callout', 'quote', 'toggle', 'to_do'
  ];

  if (richTextTypes.includes(block.type)) {
    return (block[block.type]?.rich_text || []).map((item) => item.plain_text).join('').trim();
  }

  if (block.type === 'table_row') {
    return (block.table_row?.cells || [])
      .map((cell) => cell.map((item) => item.plain_text).join(' ').trim())
      .filter(Boolean)
      .join(' | ');
  }

  return '';
}

function selectRelevantSnippets(content, title, question) {
  if (!content) return [];

  const chunks = chunkText(content, 700, 120);
  const scored = chunks
    .map((chunk) => ({
      text: chunk,
      score: scoreChunk(chunk, title, question),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SNIPPETS_PER_PAGE);

  return scored;
}

function chunkText(text, size = 700, overlap = 120) {
  const normalized = text.replace(/\n{3,}/g, '\n\n').trim();
  if (!normalized) return [];
  if (normalized.length <= size) return [normalized];

  const chunks = [];
  let start = 0;
  while (start < normalized.length) {
    const end = Math.min(normalized.length, start + size);
    chunks.push(normalized.slice(start, end).trim());
    if (end >= normalized.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

function scoreChunk(chunk, title, question) {
  const normalizedQuestion = normalizeForMatch(question);
  const normalizedChunk = normalizeForMatch(chunk);
  const normalizedTitle = normalizeForMatch(title);
  const terms = normalizedQuestion
    .split(/\s+/)
    .filter((term) => term.length > 2 && !STOP_WORDS.has(term));

  let score = 0;
  for (const term of terms) {
    if (normalizedTitle.includes(term)) score += 6;
    if (normalizedChunk.includes(term)) score += 2;
  }

  if (normalizedChunk.includes(normalizedQuestion) && normalizedQuestion.length > 8) score += 8;
  if (normalizedTitle.includes(normalizedQuestion) && normalizedQuestion.length > 8) score += 10;

  return score;
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

function buildContextFromPages(pages, question) {
  const snippets = pages
    .flatMap((page) => page.snippets.map((snippet) => ({
      title: page.title,
      url: page.url,
      text: snippet.text,
      score: snippet.score,
    })))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CONTEXT_SNIPPETS);

  if (!snippets.length) return null;

  return snippets
    .map((snippet, index) => {
      const docLabel = `[Doc ${index + 1}] ${snippet.title}`;
      return `${docLabel}\nURL: ${snippet.url}\nTrecho relevante:\n${snippet.text}`;
    })
    .join('\n\n---\n\n');
}

function getTitle(page) {
  const prop = Object.values(page.properties ?? {}).find((p) => p.type === 'title');
  return prop?.title?.map((t) => t.plain_text).join('') || 'Sem título';
}

const STOP_WORDS = new Set([
  'para', 'com', 'sem', 'uma', 'uns', 'umas', 'que', 'como', 'onde', 'quando',
  'qual', 'quais', 'sobre', 'entre', 'pelos', 'pelas', 'isso', 'essa', 'esse',
  'esta', 'estao', 'está', 'sao', 'são', 'ser', 'ter', 'tem', 'dos', 'das',
  'por', 'porque', 'mais', 'menos', 'muito', 'muita', 'meu', 'minha', 'seu',
  'sua', 'nos', 'nas', 'aos', 'aquelas', 'aqueles', 'tambem', 'também'
]);

/* ═══════════════════════════════════════════════
   EXTRAÇÃO DE ARQUIVOS
═══════════════════════════════════════════════ */
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml'];
const TEXT_TYPES = ['text/plain', 'text/csv', 'application/json'];

async function extractFileContent(file) {
  const { mimetype, path: tmpPath, originalname } = file;
  try {
    if (IMAGE_TYPES.includes(mimetype)) {
      const data = fs.readFileSync(tmpPath).toString('base64');
      return { type: 'image', base64: data, mime: mimetype, name: originalname };
    }
    if (mimetype === 'application/pdf') {
      const buffer = fs.readFileSync(tmpPath);
      const result = await pdfParse(buffer);
      return { type: 'text', content: result.text.slice(0, 8000), name: originalname };
    }
    if (mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const result = await mammoth.extractRawText({ path: tmpPath });
      return { type: 'text', content: result.value.slice(0, 8000), name: originalname };
    }
    if (mimetype === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
      const { default: AdmZip } = await import('adm-zip');
      const zip = new AdmZip(tmpPath);
      const slides = zip.getEntries().filter((e) => e.entryName.match(/ppt\/slides\/slide\d+\.xml/));
      const text = slides
        .map((s) => s.getData().toString('utf8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '))
        .join('\n')
        .slice(0, 8000);
      return { type: 'text', content: text, name: originalname };
    }
    if (TEXT_TYPES.includes(mimetype) || originalname.match(/\.(txt|csv|json|md)$/i)) {
      const content = fs.readFileSync(tmpPath, 'utf8').slice(0, 8000);
      return { type: 'text', content, name: originalname };
    }
    return { type: 'unsupported', name: originalname };
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

/* ═══════════════════════════════════════════════
   ROTA PRINCIPAL  POST /api/ask
═══════════════════════════════════════════════ */
app.post('/api/ask', upload.array('files', 5), async (req, res) => {
  let question;
  let history;

  if (req.is('application/json')) {
    ({ question, history = [] } = req.body);
  } else {
    question = req.body.question;
    history = req.body.history ? JSON.parse(req.body.history) : [];
  }

  if (!question && (!req.files || req.files.length === 0)) {
    return res.status(400).json({ error: 'Envie uma pergunta ou arquivo.' });
  }

  question = question || '(sem texto — analise os arquivos anexados)';

  try {
    const pages = await searchNotion(question, history);
    const context = buildContextFromPages(pages, question);

    const files = req.files || [];
    const extracted = await Promise.all(files.map(extractFileContent));
    const unsupported = extracted.filter((f) => f.type === 'unsupported').map((f) => f.name);

    const userContentParts = [];
    const textBlock = context
      ? `Base de conhecimento interna:\n\n${context}\n\n---\n\nPergunta: ${question}`
      : question;
    userContentParts.push({ type: 'text', text: textBlock });

    extracted.filter((f) => f.type === 'text').forEach((f) => {
      userContentParts.push({ type: 'text', text: `\n\n[Arquivo anexado: ${f.name}]\n${f.content}` });
    });

    extracted.filter((f) => f.type === 'image').forEach((f) => {
      userContentParts.push({
        type: 'image_url',
        image_url: { url: `data:${f.mime};base64,${f.base64}`, detail: 'high' },
      });
      userContentParts.push({ type: 'text', text: `[Imagem anexada: ${f.name}]` });
    });

    const messages = [
      ...history.map((m) => ({ role: m.role, content: m.content })),
      {
        role: 'user',
        content: userContentParts.length === 1 ? userContentParts[0].text : userContentParts,
      },
    ];

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 5632,
      messages: [
        {
          role: 'system',
          content: `Você é o SmartAI, assistente de suporte interno da Smart Leilões, atuando no segmento Smart Caixa.

Se te perguntarem quem foi André Prado, responda dizendo 'Grande Amigo do Davi Tigela - Sistemas'.

Seu papel é esclarecer dúvidas dos colaboradores com profundidade e detalhamento. Ao responder, antecipe dúvidas relacionadas, possíveis contra-argumentos e cenários alternativos — tudo numa única mensagem completa, por mais longa que seja. Prefira sempre a resposta mais completa possível. Se o usuário pedir objetividade, seja mais direto, mas mantenha a precisão e o profissionalismo.

REGRAS DE COMPORTAMENTO:
- Responda SOMENTE com base na documentação interna fornecida no contexto. Ela é sua única fonte de verdade.
- Nunca invente, suponha, complete lacunas com suposições ou recorra a conhecimento externo. Se não está na documentação, não está na resposta.
- Sempre que citar uma informação, identifique o documento de origem (ex: "conforme o Doc 2 — Política de Reembolso...").
- Se a informação solicitada não constar em nenhum documento disponível, responda exatamente: "Não encontrei essa informação na base de conhecimento interna. Tente contatar o RH ou o responsável pela área." Não adicione suposições após essa frase.
- Responda sempre em português, com linguagem profissional e acessível.
- Em respostas longas, use subtítulos, listas e estrutura clara para facilitar a leitura.`,
        },
        ...messages,
      ],
    });

    const answer = response.choices[0].message.content;
    const payload = {
      answer,
      sources: pages.map((p) => ({ title: p.title, url: p.url, score: p.score })),
    };
    if (unsupported.length) payload.unsupported = unsupported;

    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno ao processar a pergunta.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SmartAI rodando em http://localhost:${PORT}`));
