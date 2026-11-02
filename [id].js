import {
  githubApi, isAuthorized, sendJson, UUID_RE, findWorkflowRun,
  readWorkflowProgress, findReleaseAsset,
} from '../../lib/nexa.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { error: 'Gunakan GET untuk membaca status build.' });
  }
  if (!isAuthorized(req)) return sendJson(res, 401, { error: 'Access key salah atau belum diisi.' });
  const id = String(req.query?.id || '');
  if (!UUID_RE.test(id)) return sendJson(res, 400, { error: 'ID build tidak valid.' });

  try {
    const run = await findWorkflowRun(id);
    if (!run) {
      return sendJson(res, 200, {
        id, status: 'queued', progress: 2,
        message: 'Workflow masuk antrean GitHub Actions. Menunggu runner memulai build.',
        logs: [],
      });
    }

    const progressInfo = await readWorkflowProgress(run).catch(() => ({ progress: run.status === 'queued' ? 2 : 10, logs: [] }));
    if (run.status !== 'completed') {
      const isQueued = run.status === 'queued' || run.status === 'requested' || run.status === 'waiting';
      return sendJson(res, 200, {
        id,
        status: isQueued ? 'queued' : 'in_progress',
        progress: isQueued ? 2 : progressInfo.progress,
        message: isQueued ? 'Build berada dalam antrean GitHub Actions.' : 'Mesin build sedang mengemas website menjadi APK.',
        logs: progressInfo.logs,
        runUrl: run.html_url,
      });
    }

    if (run.conclusion !== 'success') {
      let failedStep = '';
      const jobsData = await githubApi(`/actions/runs/${encodeURIComponent(run.id)}/jobs?per_page=30`).catch(() => null);
      const jobs = Array.isArray(jobsData?.jobs) ? jobsData.jobs : [];
      for (const job of jobs) {
        const step = (job.steps || []).find(item => item.conclusion === 'failure');
        if (step) { failedStep = step.name || job.name || ''; break; }
      }
      return sendJson(res, 200, {
        id, status: 'failed', progress: progressInfo.progress,
        error: failedStep
          ? `Build gagal pada langkah: ${failedStep}. Buka log GitHub Actions untuk detail dan perbaikan.`
          : `Build berhenti dengan status ${run.conclusion || 'unknown'}. Buka log GitHub Actions untuk detail dan perbaikan.`,
        message: 'APK belum tersedia karena proses build tidak berhasil.',
        logs: progressInfo.logs,
        runUrl: run.html_url,
      });
    }

    const published = await findReleaseAsset(id);
    if (!published) {
      const completedAt = Date.parse(run.completed_at || run.updated_at || run.created_at || '');
      const releaseGraceExpired = Number.isFinite(completedAt) && completedAt > 0 && Date.now() - completedAt > 5 * 60 * 1000;
      if (releaseGraceExpired) {
        return sendJson(res, 200, {
          id, status: 'failed', progress: 98,
          error: 'GitHub menyelesaikan workflow tetapi GitHub Release belum menyediakan APK yang valid. Periksa langkah Publish APK as GitHub Release asset.',
          message: 'APK belum tersedia karena asset Release tidak ditemukan.',
          logs: progressInfo.logs, runUrl: run.html_url,
        });
      }
      return sendJson(res, 200, {
        id, status: 'in_progress', progress: 98,
        message: 'Build selesai. GitHub sedang menerbitkan APK pada Release.',
        logs: progressInfo.logs, runUrl: run.html_url,
      });
    }

    return sendJson(res, 200, {
      id, status: 'success', progress: 100,
      message: 'Build berhasil dan APK tersedia pada GitHub Release.',
      downloadUrl: published.asset.browser_download_url,
      browserDownloadUrl: published.asset.browser_download_url,
      releaseUrl: published.release.html_url,
      assetName: published.asset.name,
      assetSize: published.asset.size,
      runUrl: run.html_url,
      logs: progressInfo.logs,
    });
  } catch (error) {
    return sendJson(res, error.statusCode || 502, {
      error: error.message || 'Gagal membaca status build dari GitHub Actions.',
    });
  }
}
