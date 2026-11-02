import { githubApi, isAuthorized, sendJson, UUID_RE, MAX_CHUNK_BYTES, MAX_ICON_BYTES } from '../../lib/nexa.js';

export const config = { api: { bodyParser: false, responseLimit: false } };

async function readRawBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += chunk.length;
    if (size > limit) {
      const error = new Error('Chunk melebihi batas ukuran. Pilih ulang project dan coba lagi.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Gunakan POST untuk mengunggah data.' });
  }
  if (!isAuthorized(req)) return sendJson(res, 401, { error: 'Access key salah atau belum diisi.' });

  const url = new URL(req.url, 'https://nexabuilder.invalid');
  const uploadId = url.searchParams.get('uploadId') || '';
  const kind = url.searchParams.get('kind') || 'project';
  const index = Number(url.searchParams.get('index'));
  const totalChunks = Number(url.searchParams.get('totalChunks'));
  if (!UUID_RE.test(uploadId)) return sendJson(res, 400, { error: 'ID upload tidak valid.' });
  if (kind !== 'project' && kind !== 'icon') return sendJson(res, 400, { error: 'Jenis berkas tidak dikenal.' });
  if (!Number.isInteger(index) || !Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > 20 || index < 0 || index >= totalChunks) {
    return sendJson(res, 400, { error: 'Nomor chunk tidak valid.' });
  }
  if (kind === 'icon' && (index !== 0 || totalChunks !== 1)) return sendJson(res, 400, { error: 'Ikon harus dikirim sebagai satu chunk.' });
  const limit = kind === 'icon' ? MAX_ICON_BYTES : MAX_CHUNK_BYTES;
  try {
    const body = await readRawBody(req, limit);
    if (!body.length) return sendJson(res, 400, { error: 'Chunk kosong.' });
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    if (!contentType.startsWith('application/octet-stream') && !contentType.startsWith('image/')) {
      return sendJson(res, 415, { error: 'Tipe upload tidak didukung. Silakan pilih ulang berkas.' });
    }
    const blob = await githubApi('/git/blobs', {
      method: 'POST',
      body: { content: body.toString('base64'), encoding: 'base64' },
    });
    if (!blob?.sha || !/^[0-9a-f]{40}$/i.test(blob.sha)) {
      return sendJson(res, 502, { error: 'GitHub tidak mengonfirmasi penyimpanan chunk. Coba ulangi upload.' });
    }
    return sendJson(res, 200, { sha: blob.sha, bytes: body.length, index, totalChunks, kind });
  } catch (error) {
    return sendJson(res, error.statusCode || 502, { error: error.message || 'Gagal mengunggah chunk.' });
  }
}
