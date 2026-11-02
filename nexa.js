import crypto from 'node:crypto';

export const MAX_PROJECT_BYTES = 40 * 1024 * 1024;
export const MAX_CHUNK_BYTES = 2 * 1024 * 1024;
export const MAX_ICON_BYTES = 2 * 1024 * 1024;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const SHA_RE = /^[0-9a-f]{40}$/i;

export function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.end(JSON.stringify(data));
}

export function getConfig() {
  const token = process.env.GITHUB_TOKEN?.trim();
  const owner = process.env.GITHUB_OWNER?.trim();
  const repo = process.env.GITHUB_REPO?.trim();
  const branch = (process.env.GITHUB_DEFAULT_BRANCH || 'main').trim();
  const accessKey = process.env.NEXABUILDER_ACCESS_KEY;
  if (!token || !owner || !repo || !accessKey) {
    const err = new Error('Server build belum dikonfigurasi. Admin perlu melengkapi Environment Variables di Vercel.');
    err.statusCode = 503;
    throw err;
  }
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) {
    const err = new Error('Konfigurasi repository GitHub tidak valid.');
    err.statusCode = 503;
    throw err;
  }
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(branch)) {
    const err = new Error('Nama default branch harus berupa nama branch sederhana, misalnya main.');
    err.statusCode = 503;
    throw err;
  }
  if (accessKey.length < 24) {
    const err = new Error('NEXABUILDER_ACCESS_KEY terlalu pendek; gunakan kunci acak minimal 24 karakter.');
    err.statusCode = 503;
    throw err;
  }
  return { token, owner, repo, branch, accessKey };
}

export function isAuthorized(req) {
  let cfg;
  try { cfg = getConfig(); } catch { return false; }
  const supplied = req.headers['x-nexabuilder-key'];
  if (typeof supplied !== 'string') return false;
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(cfg.accessKey, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function requireAuthorization(req) {
  if (!isAuthorized(req)) {
    const err = new Error('Access key salah atau belum diisi. Masukkan kembali kunci NexaBuilder.');
    err.statusCode = 401;
    throw err;
  }
}

export function buildErrorMessage(err) {
  const status = Number(err?.statusCode) || 500;
  if (status === 401) return 'Access key salah atau belum diisi. Masukkan kembali kunci NexaBuilder.';
  if (status === 413) return 'Data terlalu besar. Periksa batas ukuran ZIP/icon, lalu coba lagi.';
  if (status === 429) return 'GitHub sedang membatasi permintaan. Tunggu sebentar dan coba kembali.';
  if (status === 503) return err.message;
  if (status === 400) return err.message || 'Data tidak valid.';
  return err?.publicMessage || err?.message || 'Terjadi kesalahan server yang tidak terduga.';
}

export async function githubApi(path, options = {}) {
  const cfg = getConfig();
  const method = options.method || 'GET';
  const canRetry = method === 'GET';
  const url = `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}${path}`;
  let lastError;
  const attempts = canRetry ? 3 : 1;

  for (let attempt = 0; attempt < attempts; attempt++) {
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${cfg.token}`,
          'X-GitHub-Api-Version': '2026-03-10',
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(20000),
        cache: 'no-store',
      });
    } catch (error) {
      lastError = error;
      if (!canRetry || attempt === attempts - 1) break;
      await delay(500 * (attempt + 1));
      continue;
    }

    if ((response.status === 429 || response.status >= 500) && canRetry && attempt < attempts - 1) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 5000) : 500 * (attempt + 1);
      await delay(wait);
      continue;
    }

    const text = response.status === 204 ? '' : await response.text().catch(() => '');
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 500) }; }
    }
    if (!response.ok) {
      const err = new Error(data?.message || `GitHub API gagal (HTTP ${response.status}).`);
      err.statusCode = response.status === 401 || response.status === 403 ? 502 : response.status;
      err.upstreamStatus = response.status;
      if (response.status === 403 && /rate limit/i.test(data?.message || '')) err.statusCode = 429;
      if (response.status === 404) err.statusCode = 502;
      throw err;
    }
    return data;
  }

  const err = new Error(lastError?.name === 'TimeoutError' ? 'GitHub tidak merespons tepat waktu. Coba lagi.' : 'Tidak dapat menghubungi GitHub setelah percobaan ulang.');
  err.statusCode = 502;
  throw err;
}

export function validateBuildMetadata(input) {
  const appName = String(input?.appName || '').trim();
  const packageId = String(input?.packageId || '').trim();
  const version = String(input?.version || '').trim();
  const versionCodeRaw = String(input?.versionCode ?? '').trim();
  const versionCode = Number(versionCodeRaw);
  if (!appName || appName.length > 48 || /[<>\u0000-\u001f]/.test(appName)) {
    throw Object.assign(new Error('Nama aplikasi wajib diisi dan maksimal 48 karakter.'), { statusCode: 400 });
  }
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageId) || packageId.length > 150) {
    throw Object.assign(new Error('Application ID tidak valid. Contoh: com.nexa.aplikasi.'), { statusCode: 400 });
  }
  if (!/^\d+(\.\d+){0,3}$/.test(version) || version.length > 24) {
    throw Object.assign(new Error('Versi tidak valid. Contoh: 1.0.0.'), { statusCode: 400 });
  }
  if (!Number.isSafeInteger(versionCode) || versionCode < 1 || versionCode > 2100000000) {
    throw Object.assign(new Error('Version code harus bilangan bulat antara 1 dan 2.100.000.000.'), { statusCode: 400 });
  }
  return { appName, packageId, version, versionCode: String(versionCode) };
}

export function createDownloadUrl(id) {
  const { accessKey } = getConfig();
  const expires = Math.floor(Date.now() / 1000) + 10 * 60;
  const sig = crypto.createHmac('sha256', accessKey).update(`${id}:${expires}`).digest('base64url');
  return `/api/jobs/${encodeURIComponent(id)}/apk?expires=${expires}&sig=${encodeURIComponent(sig)}`;
}

export function validateDownloadSignature(id, expiresValue, signature) {
  if (!UUID_RE.test(id) || typeof signature !== 'string') return false;
  const expires = Number(expiresValue);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(expires) || expires < now || expires > now + 11 * 60) return false;
  let accessKey;
  try { accessKey = getConfig().accessKey; } catch { return false; }
  const expected = crypto.createHmac('sha256', accessKey).update(`${id}:${expires}`).digest('base64url');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function findWorkflowRun(uploadId) {
  const { branch } = getConfig();
  const encodedBranch = encodeURIComponent(branch);
  const data = await githubApi(`/actions/workflows/build.yml/runs?event=workflow_dispatch&branch=${encodedBranch}&per_page=100`);
  const expected = String(uploadId).toLowerCase();
  const runs = Array.isArray(data?.workflow_runs) ? data.workflow_runs : [];
  return runs.find(run => String(run.display_title || '').toLowerCase().includes(expected)) || null;
}

export async function findRunArtifact(runId, uploadId) {
  const data = await githubApi(`/actions/runs/${encodeURIComponent(runId)}/artifacts?per_page=100`);
  const artifacts = Array.isArray(data?.artifacts) ? data.artifacts : [];
  return artifacts.find(item => item.name === `nexabuilder-${uploadId}` && !item.expired) || null;
}

export async function readWorkflowProgress(run) {
  if (!run?.id) return { progress: 0, logs: [] };
  const data = await githubApi(`/actions/runs/${encodeURIComponent(run.id)}/jobs?per_page=30`);
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
  const steps = jobs.flatMap(job => (job.steps || []).map(step => ({
    name: step.name || job.name || 'Build',
    status: step.conclusion || step.status || 'queued',
    started_at: step.started_at || null,
    completed_at: step.completed_at || null,
  })));
  const completed = steps.filter(step => ['success', 'failure', 'cancelled', 'skipped'].includes(step.status)).length;
  const progress = steps.length ? Math.max(5, Math.min(95, Math.round(completed / steps.length * 90) + 5)) : (run.status === 'queued' ? 2 : 10);
  const logs = steps.slice(-8).map(step => `${step.status.toUpperCase()}: ${step.name}`);
  return { progress, logs, steps };
}


export async function findReleaseAsset(uploadId) {
  const tag = `nexabuild-${uploadId}`;
  let release;
  try {
    release = await githubApi(`/releases/tags/${encodeURIComponent(tag)}`);
  } catch (error) {
    if (error.upstreamStatus === 404) return null;
    throw error;
  }
  const assetName = `NexaBuild-${uploadId}.apk`;
  const asset = (Array.isArray(release?.assets) ? release.assets : []).find(item => item.name === assetName);
  let url = null;
  try { url = new URL(asset?.browser_download_url || ''); } catch {}
  if (!asset || !(Number(asset.size) > 0) || url?.protocol !== 'https:' || url.hostname !== 'github.com' || !url.pathname.endsWith(`/${encodeURIComponent(assetName)}`)) return null;
  return { release, asset };
}
