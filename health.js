import { getConfig, sendJson } from '../lib/nexa.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { ready: false, error: 'Method tidak diizinkan.' });
  }
  try {
    getConfig();
    return sendJson(res, 200, {
      ready: true,
      service: 'NexaBuilder Build Engine',
      mode: 'github-actions',
      message: 'Konfigurasi server tersedia. File akan divalidasi lagi sebelum dikirim ke mesin build.',
    });
  } catch (error) {
    return sendJson(res, error.statusCode || 503, {
      ready: false,
      service: 'NexaBuilder Build Engine',
      error: error.message || 'Backend belum siap.',
    });
  }
}
