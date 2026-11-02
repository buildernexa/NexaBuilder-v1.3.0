import { sendJson, UUID_RE, findWorkflowRun, findReleaseAsset } from '../../../lib/nexa.js';

// Compatibility endpoint: redirect to GitHub's official asset URL. No proxy/blob copy.
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { error: 'Gunakan GET untuk membuka unduhan APK.' });
  }
  const id = String(req.query?.id || '');
  if (!UUID_RE.test(id)) return sendJson(res, 400, { error: 'ID build tidak valid.' });
  try {
    const run = await findWorkflowRun(id);
    if (!run || run.status !== 'completed' || run.conclusion !== 'success') {
      return sendJson(res, 409, { error: 'APK belum siap diunduh.' });
    }
    const published = await findReleaseAsset(id);
    if (!published?.asset?.browser_download_url) {
      return sendJson(res, 404, { error: 'Asset APK tidak ditemukan pada GitHub Release.' });
    }
    res.statusCode = 302;
    res.setHeader('Location', published.asset.browser_download_url);
    res.setHeader('Cache-Control', 'no-store');
    return res.end();
  } catch (error) {
    return sendJson(res, error.statusCode || 502, { error: error.message || 'Gagal membuka unduhan APK.' });
  }
}
