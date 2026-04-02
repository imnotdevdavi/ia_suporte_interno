import fs from 'fs';
import { Readable } from 'stream';
import { del, get, put } from '@vercel/blob';

export const LOCAL_STORAGE_PROVIDER = 'local';
export const PRIVATE_BLOB_STORAGE_PROVIDER = 'vercel_blob_private';
const VERCEL_RUNTIME_UPLOAD_LIMIT_BYTES = 4 * 1024 * 1024;
const LOCAL_UPLOAD_LIMIT_BYTES = 20 * 1024 * 1024;

export function isVercelRuntime() {
  return Boolean(process.env.VERCEL);
}

export function isBlobStorageConfigured() {
  return Boolean(String(process.env.BLOB_READ_WRITE_TOKEN || '').trim());
}

export function shouldUseBlobStorage() {
  return isBlobStorageConfigured();
}

export function getStorageProviderName() {
  return shouldUseBlobStorage() ? PRIVATE_BLOB_STORAGE_PROVIDER : LOCAL_STORAGE_PROVIDER;
}

export function getMaxUploadBytes() {
  return isVercelRuntime() ? VERCEL_RUNTIME_UPLOAD_LIMIT_BYTES : LOCAL_UPLOAD_LIMIT_BYTES;
}

export function getMaxProfilePhotoBytes() {
  return getMaxUploadBytes();
}

export function getMaxAttachmentRequestBytes() {
  return getMaxUploadBytes();
}

export function getMaxAttachmentFiles() {
  return isVercelRuntime() ? 3 : 5;
}

export function assertPersistentFileStorageConfigured() {
  if (!isVercelRuntime() || shouldUseBlobStorage()) return;

  throw Object.assign(
    new Error('Uploads em produção na Vercel exigem BLOB_READ_WRITE_TOKEN configurado.'),
    { statusCode: 503 }
  );
}

function sanitizeSegment(value, fallback = 'arquivo') {
  const cleaned = String(value || fallback)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);

  return cleaned || fallback;
}

export function buildBlobObjectPath(prefix, originalName = 'arquivo') {
  const segments = String(prefix || 'uploads')
    .split('/')
    .map((segment) => sanitizeSegment(segment, 'item'))
    .filter(Boolean);
  const fileName = sanitizeSegment(originalName, 'arquivo');
  return [...segments, fileName].join('/');
}

export async function uploadLocalFileToBlob(filePath, { objectPath, contentType } = {}) {
  assertPersistentFileStorageConfigured();

  const blob = await put(
    objectPath || buildBlobObjectPath('uploads', 'arquivo'),
    fs.createReadStream(filePath),
    {
      access: 'private',
      addRandomSuffix: true,
      contentType: contentType || undefined,
    }
  );

  return blob;
}

export function isBlobStoragePath(value = '') {
  return /vercel-storage\.com/i.test(String(value || ''));
}

export function isBlobStorageProvider(provider = '') {
  return String(provider || '').trim() === PRIVATE_BLOB_STORAGE_PROVIDER;
}

export async function deleteBlobObject(urlOrPathname) {
  if (!urlOrPathname || !isBlobStorageConfigured()) return;
  await del(String(urlOrPathname));
}

export async function streamPrivateBlobToResponse(res, urlOrPathname, options = {}) {
  const blobResult = await get(String(urlOrPathname), {
    access: 'private',
    ifNoneMatch: options.ifNoneMatch || undefined,
  });

  if (!blobResult) {
    return { found: false, notModified: false };
  }

  if (blobResult.statusCode === 304) {
    if (blobResult.blob?.etag) res.setHeader('ETag', blobResult.blob.etag);
    if (blobResult.blob?.cacheControl) res.setHeader('Cache-Control', blobResult.blob.cacheControl);
    res.status(304).end();
    return { found: true, notModified: true };
  }

  if (blobResult.blob?.contentType) {
    res.setHeader('Content-Type', blobResult.blob.contentType);
  }
  if (blobResult.blob?.cacheControl) {
    res.setHeader('Cache-Control', blobResult.blob.cacheControl);
  }
  if (blobResult.blob?.etag) {
    res.setHeader('ETag', blobResult.blob.etag);
  }
  if (blobResult.blob?.size != null) {
    res.setHeader('Content-Length', String(blobResult.blob.size));
  }
  if (options.contentDisposition) {
    res.setHeader('Content-Disposition', options.contentDisposition);
  } else if (blobResult.blob?.contentDisposition) {
    res.setHeader('Content-Disposition', blobResult.blob.contentDisposition);
  }

  if (!blobResult.stream) {
    return { found: true, notModified: false };
  }

  await new Promise((resolve, reject) => {
    const nodeStream = Readable.fromWeb(blobResult.stream);
    nodeStream.on('error', reject);
    res.on('close', resolve);
    res.on('finish', resolve);
    nodeStream.pipe(res);
  });

  return { found: true, notModified: false };
}
