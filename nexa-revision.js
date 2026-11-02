/* NexaBuild revision layer: GitHub identity, shared community data, Actions releases,
   global chat, custom settings, themes, media slots and onboarding. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const KEYS = {
    connection: 'nexabuild.github.connection.v1', authorized: 'nexabuild.device.authorized.v1',
    first: 'nexabuild.device.first-connect.v1', theme: 'nexabuild.theme.v2', chatIssue: 'nexabuild.chat.issue.v1',
    buildVideos: 'nexabuild.build.videos.v1', font: 'nexabuild.font.v1', stickers: 'nexabuild.chat.stickers.v1'
  };
  const DEFAULT_VIDEOS = {
    intro: 'assets/videos/intro.mp4', liquid: 'assets/videos/liquidglass-bg.mp4',
    build: ['assets/videos/anime-1.mp4', 'assets/videos/anime-2.mp4', 'assets/videos/anime-3.mp4']
  };
  const state = { connection: null, buildTimer: null, heartbeat: null, buildCycle: null, buildVideoIndex: 0,
    mediaDb: null, mediaUrls: new Map(), chatAssetUrls: [], currentStickerImage: null, currentStickerFile: null,
    chatBusy: false, chatPage: 1, chatHasMore: false, chatLoadingOlder: false, chatLoadSequence: 0,
    members: [], presence: {}, buildVideos: DEFAULT_VIDEOS.build.slice(),
    lastPresenceWrite: 0, buildRunId: null, buildRunUrl: null };

  const bridge = () => window.NexaBuildBridge || {};
  const toast = message => { if (typeof bridge().toast === 'function') bridge().toast(message); else console.info(message); };
  const openOverlay = id => $(id)?.classList.remove('hidden');
  const closeOverlay = id => $(id)?.classList.add('hidden');
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const enc = value => { const [pathname, ...query] = String(value || '').split('?'); return pathname.split('/').map(encodeURIComponent).join('/') + (query.length ? `?${query.join('?')}` : ''); };
  const encodeUtf8Base64 = value => {
    const bytes = new TextEncoder().encode(String(value));
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  };
  const decodeUtf8Base64 = value => {
    const binary = atob(String(value || '').replace(/\s/g, ''));
    const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  };
  const storageGet = (key, fallback = null) => { try { return window.localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
  const storageSet = (key, value) => { try { window.localStorage.setItem(key, String(value)); return true; } catch { return false; } };
  const storageRemove = key => { try { window.localStorage.removeItem(key); return true; } catch { return false; } };
  const safeJson = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
  const getConnection = () => state.connection || safeJson(storageGet(KEYS.connection), null);
  const hasConnection = () => { const c = getConnection(); return !!(c?.token && c?.owner && c?.repo); };
  const repoBase = () => { const c = getConnection(); if (!c) throw new Error('Hubungkan GitHub terlebih dahulu.'); return `/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}`; };
  const defaultBranch = () => getConnection()?.branch || 'main';
  const githubHeaders = (extra = {}) => {
    const c = getConnection();
    if (!c?.token) throw new Error('Token GitHub belum tersimpan. Hubungkan kembali akun GitHub.');
    return { Accept: 'application/vnd.github+json', Authorization: `Bearer ${c.token}`, 'X-GitHub-Api-Version': '2026-03-10', ...extra };
  };
  function githubMessage(message, status) {
    const text = String(message || 'Permintaan GitHub gagal.');
    if (status === 401) return 'Token GitHub tidak valid atau sudah kedaluwarsa. Hubungkan ulang dengan token yang benar.';
    if (status === 403 && /rate limit/i.test(text)) return 'Batas permintaan GitHub API tercapai. Tunggu sebentar lalu coba lagi.';
    if (status === 403) return 'GitHub menolak izin token. Untuk NexaBuild, periksa Contents: Read and write, Actions: Read and write, dan Issues: Read and write bila memakai GlobalChat.';
    if (status === 404) return 'Repository, workflow, branch, Issue, atau file tidak ditemukan / tidak dapat diakses oleh token.';
    return `${text} (HTTP ${status || 'network'})`;
  }
  async function githubRequestWithToken(path, token, timeout = 20000) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(`https://api.github.com${path}`, { headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2026-03-10' }, cache: 'no-store', signal: controller.signal });
      const raw = await response.text(); let data = {}; try { data = raw ? JSON.parse(raw) : {}; } catch { data = { message: raw.slice(0, 300) }; }
      if (!response.ok) { const error = new Error(githubMessage(data.message, response.status)); error.status = response.status; error.data = data; throw error; }
      return data;
    } catch (error) { if (error.name === 'AbortError') throw new Error('Koneksi ke GitHub melewati batas waktu. Periksa internet lalu coba lagi.'); throw error; }
    finally { clearTimeout(timer); }
  }
  async function githubApi(path, options = {}, timeout = 25000) {
    const method = String(options.method || 'GET').toUpperCase();
    const attempts = method === 'GET' ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch(`https://api.github.com${path}`, { ...options, headers: githubHeaders(options.headers || {}), cache: 'no-store', signal: controller.signal });
        const raw = await response.text(); let data = {}; try { data = raw ? JSON.parse(raw) : {}; } catch { data = { message: raw.slice(0, 300) }; }
        if (!response.ok) {
          const message = data.message || `GitHub API HTTP ${response.status}`;
          const error = new Error(githubMessage(message, response.status)); error.status = response.status; error.data = data;
          const rateLimited = response.status === 403 && (/rate limit/i.test(message) || response.headers.get('x-ratelimit-remaining') === '0');
          const transient = response.status === 429 || response.status >= 500 || rateLimited;
          if (method === 'GET' && transient && attempt < attempts - 1) {
            const retryAfter = Number(response.headers.get('retry-after') || 0) * 1000;
            const resetAt = Number(response.headers.get('x-ratelimit-reset') || 0) * 1000;
            const wait = Math.min(6500, Math.max(retryAfter, resetAt > Date.now() ? resetAt - Date.now() : 0, 700 * (attempt + 1)));
            clearTimeout(timer); await delay(wait); continue;
          }
          throw error;
        }
        return data;
      } catch (error) {
        if (error.name === 'AbortError') {
          if (method === 'GET' && attempt < attempts - 1) { clearTimeout(timer); await delay(500 * (attempt + 1)); continue; }
          throw new Error('Koneksi ke GitHub melewati batas waktu. Periksa internet lalu coba lagi.');
        }
        if (method === 'GET' && !error.status && attempt < attempts - 1) { clearTimeout(timer); await delay(500 * (attempt + 1)); continue; }
        throw error;
      } finally { clearTimeout(timer); }
    }
    throw new Error('GitHub API sementara tidak merespons. Coba lagi beberapa saat.');
  }
  async function githubGet(path) { return githubApi(path, { method: 'GET' }); }
  async function githubPost(path, body) { return githubApi(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 60000); }
  async function githubPut(path, body) { return githubApi(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 60000); }
  function showStatus(id, message, isError = false) { const el = $(id); if (el) { el.textContent = message; el.classList.toggle('error-text', !!isError); } }

  // Persistent media slots (separate DB so the original project ZIP store remains untouched).
  function openMediaDb() {
    if (state.mediaDb) return Promise.resolve(state.mediaDb);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('nexabuild-media-v1', 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('media')) req.result.createObjectStore('media'); };
      req.onsuccess = () => { state.mediaDb = req.result; resolve(req.result); };
      req.onerror = () => reject(req.error || new Error('Penyimpanan media tidak tersedia.'));
    });
  }
  async function saveMedia(key, blob, name) {
    const db = await openMediaDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('media', 'readwrite'); tx.objectStore('media').put({ blob, name, savedAt: Date.now() }, key);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error || new Error('Gagal menyimpan video/font.'));
    });
  }
  async function getMedia(key) {
    const db = await openMediaDb();
    return new Promise((resolve, reject) => { const tx = db.transaction('media', 'readonly'); const req = tx.objectStore('media').get(key); req.onsuccess = () => resolve(req.result || null); req.onerror = () => reject(req.error); });
  }
  async function videoUrl(slot, defaultPath) {
    if (state.mediaUrls.has(slot)) return state.mediaUrls.get(slot);
    try {
      const saved = await getMedia(`video:${slot}`);
      if (saved?.blob) { const url = URL.createObjectURL(saved.blob); state.mediaUrls.set(slot, url); return url; }
    } catch { /* storage may be unavailable; use repo asset */ }
    return defaultPath;
  }
  async function applyVideoSettings() {
    const intro = $('introVideo'); const bg = $('liquidBackgroundVideo'); const build = $('buildAnimeVideo');
    const cfg = safeJson(storageGet('nexabuild.video.config.v1'), {});
    const introSrc = await videoUrl('intro', DEFAULT_VIDEOS.intro);
    const liquidSrc = await videoUrl('liquid', DEFAULT_VIDEOS.liquid);
    if (intro) setVideoSource(intro, introSrc, 'intro');
    if (bg) setVideoSource(bg, liquidSrc, 'liquid');
    state.buildVideos = safeJson(storageGet(KEYS.buildVideos), DEFAULT_VIDEOS.build.slice()) || DEFAULT_VIDEOS.build.slice();
    if (!Array.isArray(state.buildVideos) || !state.buildVideos.length) state.buildVideos = DEFAULT_VIDEOS.build.slice();
    const first = await resolveBuildVideo(state.buildVideos[0]);
    if (build) setVideoSource(build, first, 'build');
    if (cfg.introName) $('introVideoName').textContent = `Tersimpan: ${cfg.introName}`;
    if (cfg.liquidName) $('liquidVideoName').textContent = `Tersimpan: ${cfg.liquidName}`;
    if (cfg.buildNames?.length) $('buildVideoNames').textContent = `Pool tersimpan: ${cfg.buildNames.join(' · ')}`;
    if (cfg.introName || cfg.liquidName || cfg.buildNames?.length) showStatus('videoSettingsInfo', `Intro: ${cfg.introName || 'intro.mp4'} · Background: ${cfg.liquidName || 'liquidglass-bg.mp4'} · Build: ${cfg.buildNames?.length || 'slot default'}`);
  }
  function setVideoSource(video, src, slot) {
    if (!video || !src) return;
    video.onerror = () => {
      video.classList.add('video-unavailable');
      if (slot === 'build') $('buildVideoPlaceholder')?.classList.remove('hidden');
      if (slot === 'intro') video.parentElement?.classList.add('video-placeholder-active');
      if (slot === 'liquid') video.classList.add('video-unavailable');
    };
    video.onloadeddata = () => {
      video.classList.remove('video-unavailable');
      if (slot === 'build') $('buildVideoPlaceholder')?.classList.add('hidden');
      if (slot === 'intro') video.parentElement?.classList.remove('video-placeholder-active');
      if (slot === 'liquid') video.classList.remove('video-unavailable');
    };
    if (video.src !== new URL(src, document.baseURI).href) video.src = src;
    video.play().catch(() => {});
  }
  async function resolveBuildVideo(slot) {
    // Custom slots are persisted under video:<slot-id>; strip the display prefix
    // before reading IndexedDB so they survive reloads as well as this session.
    if (String(slot).startsWith('custom:')) return (await videoUrl(String(slot).slice(7), '')) || '';
    return slot;
  }
  async function cycleBuildVideo() {
    if (!state.buildVideos.length) return;
    const video = $('buildAnimeVideo'); if (!video) return;
    const slot = state.buildVideos[state.buildVideoIndex++ % state.buildVideos.length];
    const src = await resolveBuildVideo(slot);
    if (src) setVideoSource(video, src, 'build');
    else { video.pause(); video.removeAttribute('src'); video.load(); video.classList.add('video-unavailable'); $('buildVideoPlaceholder')?.classList.remove('hidden'); }
  }

  // Theme switch is global and replaces component styling consistently.
  function applyTheme(theme) {
    const value = theme === 'liquid' ? 'liquid' : 'neo';
    document.body.dataset.theme = value;
    storageSet(KEYS.theme, value);
    $('themeNeo')?.classList.toggle('active', value === 'neo');
    $('themeLiquid')?.classList.toggle('active', value === 'liquid');
    $('liquidBackgroundVideo')?.classList.toggle('active', value === 'liquid');
  }

  // Authentication and the local long-press gate.
  function setAuthProfile(user) {
    if (!user) return;
    $('profileName').textContent = getConnection()?.displayName || user.login;
    $('profileRole').textContent = `${user.login === getConnection()?.owner ? 'OWNER' : 'MEMBER'} · GITHUB`;
    const avatar = $('githubAvatar');
    if (avatar) { avatar.src = user.avatar_url; avatar.classList.remove('hidden'); $('defaultAvatar')?.classList.add('hidden'); }
    $('accountStatusText').textContent = '● Aktif';
    $('drawerEngineLabel').textContent = 'GITHUB TERHUBUNG';
    $('drawerEngineSub').textContent = `${getConnection()?.owner}/${getConnection()?.repo}`;
    $('drawerEngineBullet')?.classList.add('good');
  }
  function readGateState() {
    state.connection = safeJson(storageGet(KEYS.connection), null);
    const authorized = storageGet(KEYS.authorized) === '1';
    if (hasConnection() && authorized) {
      $('fingerprintGate')?.classList.add('hidden'); $('githubLoginScreen')?.classList.add('hidden'); $('introScreen')?.classList.add('hidden');
      return true;
    }
    $('fingerprintGate')?.classList.remove('hidden');
    $('githubLoginScreen')?.classList.add('hidden'); $('introScreen')?.classList.add('hidden');
    return false;
  }
  let pressStarted = 0, pressTick = null, pressInterval = null;
  const fingerprintBtn = $('fingerprintHold');
  if (fingerprintBtn) {
    const path = fingerprintBtn.querySelector('.finger-progress');
    const pathLength = path?.getTotalLength?.() || 600;
    if (path) { path.style.strokeDasharray = `${pathLength}`; path.style.strokeDashoffset = `${pathLength}`; }
    const resetPress = () => { clearTimeout(pressTick); clearInterval(pressInterval); pressStarted = 0; if (path) path.style.strokeDashoffset = `${pathLength}`; showStatus('fingerprintStatus', 'Gerbang lokal · 1,8 detik'); fingerprintBtn.classList.remove('pressing'); };
    fingerprintBtn.addEventListener('pointerdown', event => {
      event.preventDefault(); fingerprintBtn.setPointerCapture?.(event.pointerId); resetPress(); pressStarted = Date.now(); fingerprintBtn.classList.add('pressing'); const ambient = $('liquidBackgroundVideo'); if (ambient && document.body.dataset.theme === 'liquid') { ambient.muted = false; ambient.play().catch(() => { ambient.muted = true; }); }
      pressInterval = setInterval(() => { const ratio = Math.min(1, (Date.now() - pressStarted) / 1800); if (path) path.style.strokeDashoffset = `${pathLength * (1 - ratio)}`; showStatus('fingerprintStatus', `Verifikasi lokal ${Math.round(ratio * 100)}%`); }, 25);
      pressTick = setTimeout(() => { clearInterval(pressInterval); if (path) path.style.strokeDashoffset = '0'; fingerprintBtn.classList.remove('pressing'); storageSet(KEYS.authorized, '1'); $('fingerprintGate').classList.add('hidden'); $('githubLoginScreen').classList.remove('hidden'); $('loginToken')?.focus(); }, 1800);
    });
    ['pointerup','pointercancel','lostpointercapture','pointerleave'].forEach(type => fingerprintBtn.addEventListener(type, () => { if (pressStarted && Date.now() - pressStarted < 1800) resetPress(); }));
  }
  async function connectGithub() {
    const token = $('loginToken').value.trim(); const owner = $('loginOwner').value.trim(); const repo = $('loginRepo').value.trim();
    if (!token || !owner || !repo) return showStatus('githubLoginMessage', 'Token, Owner, dan Nama Repository wajib diisi.', true);
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return showStatus('githubLoginMessage', 'Owner atau nama repository tidak valid.', true);
    $('githubConnect').disabled = true; $('githubConnect').textContent = 'MEMERIKSA TOKEN…';
    try {
      const [user, repoData] = await Promise.all([
        githubRequestWithToken('/user', token),
        githubRequestWithToken(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, token)
      ]);
      if (!user.login) throw new Error('Token GitHub tidak mengembalikan identitas pengguna yang valid.');
      state.connection = { token, owner, repo, branch: repoData.default_branch || 'main', username: user.login, displayName: user.name || user.login, avatar: user.avatar_url, connectedAt: Date.now() };
      const persisted = storageSet(KEYS.connection, JSON.stringify(state.connection));
      setAuthProfile(user);
      showStatus('githubLoginMessage', persisted ? `Terhubung sebagai @${user.login} · ${owner}/${repo}` : `Terhubung sebagai @${user.login}, tetapi penyimpanan browser diblokir. Koneksi hanya berlaku selama halaman terbuka.`, !persisted);
      if (persisted) $('loginToken').value = '';
      const first = storageGet(KEYS.first) !== '1'; storageSet(KEYS.first, '1');
      await upsertMember(user.login, user.avatar_url);
      await heartbeat(true);
      if (first) { $('githubLoginScreen').classList.add('hidden'); $('introScreen').classList.remove('hidden'); const intro = $('introVideo'); if (intro) { intro.muted = false; intro.play().catch(() => { intro.muted = true; intro.play().catch(() => {}); }); } }
      else { $('githubLoginScreen').classList.add('hidden'); $('introScreen').classList.add('hidden'); }
      applyTheme(storageGet(KEYS.theme) || 'neo');
      await loadCommunityStats(); await loadRemoteHistory();
      startHeartbeat(); startBuildVideoCycle();
      toast(`GitHub terhubung: @${user.login}`);
    } catch (error) { showStatus('githubLoginMessage', error.message, true); }
    finally { $('githubConnect').disabled = false; $('githubConnect').textContent = 'HUBUNGKAN GITHUB →'; }
  }
  $('githubConnect')?.addEventListener('click', connectGithub);
  ['loginToken','loginOwner','loginRepo'].forEach(id => $(id)?.addEventListener('focus', () => $('loginMascot')?.classList.add(`focus-${id}`)));
  ['loginToken','loginOwner','loginRepo'].forEach(id => $(id)?.addEventListener('blur', () => $('loginMascot')?.classList.remove(`focus-${id}`)));
  $('introSoundToggle')?.addEventListener('click', async () => { const video = $('introVideo'); if (!video) return; video.muted = !video.muted; try { await video.play(); } catch { video.muted = true; } $('introSoundToggle').textContent = video.muted ? 'AKTIFKAN SUARA' : 'MATIKAN SUARA'; });
  $('introContinue')?.addEventListener('click', () => { $('introScreen').classList.add('hidden'); $('fingerprintGate').classList.add('hidden'); $('githubLoginScreen').classList.add('hidden'); storageSet(KEYS.authorized, '1'); applyTheme(storageGet(KEYS.theme) || 'neo'); bridge().showView?.('home'); });

  // The same repository holds unique members, online presence, build history and chat attachment metadata.
  async function readRepoJson(path, fallback) {
    try {
      const file = await githubGet(`${repoBase()}/contents/${enc(path)}?ref=${encodeURIComponent(defaultBranch())}`);
      let content = file.content || '';
      // GitHub Contents API omits inline content for larger files. The blob API
      // still supplies base64 content, which is important for builds.json icons.
      if (!content && file.sha) { const blob = await githubGet(`${repoBase()}/git/blobs/${file.sha}`); content = blob.content || ''; }
      if (!content) throw new Error(`${path} ditemukan tetapi isinya tidak dapat dibaca dari GitHub. Data tidak akan dianggap kosong atau ditimpa.`);
      let parsed;
      try { parsed = JSON.parse(decodeUtf8Base64(content)); }
      catch { throw new Error(`${path} berisi JSON rusak. Data tidak akan ditimpa otomatis; perbaiki file di repository terlebih dahulu.`); }
      const filename = path.split('/').pop();
      if ((filename === 'builds.json' || filename === 'members.json') && !Array.isArray(parsed)) throw new Error(`${path} harus berisi array JSON. Data tidak akan ditimpa otomatis.`);
      if (filename === 'presence.json' && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) throw new Error(`${path} harus berisi object JSON. Data tidak akan ditimpa otomatis.`);
      return { data: parsed, sha: file.sha };
    } catch (error) { if (error.status === 404) return { data: fallback, sha: null }; throw error; }
  }
  async function writeRepoJson(path, value, message) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await readRepoJson(path, {});
      const body = { message, content: encodeUtf8Base64(JSON.stringify(value, null, 2)), branch: defaultBranch() };
      if (current.sha) body.sha = current.sha;
      try { return await githubPut(`${repoBase()}/contents/${enc(path)}`, body); }
      catch (error) { if (![409, 422].includes(error.status) || attempt === 2) throw error; await delay(450 * (attempt + 1)); }
    }
  }
  async function mutateRepoJson(path, fallback, transform, message) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await readRepoJson(path, fallback);
      const before = JSON.stringify(current.data ?? fallback);
      const input = safeJson(before, fallback);
      const next = transform(input);
      if (JSON.stringify(next) === before) return next;
      const serialized = JSON.stringify(next, null, 2);
      if (new Blob([serialized]).size > 40 * 1024 * 1024) throw new Error(`${path} sudah melebihi batas aman sinkronisasi 40 MiB. Data lokal tetap disimpan; arsipkan riwayat lama sebelum sinkronisasi berikutnya.`);
      const body = { message, content: encodeUtf8Base64(serialized), branch: defaultBranch() };
      if (current.sha) body.sha = current.sha;
      try { await githubPut(`${repoBase()}/contents/${enc(path)}`, body); return next; }
      catch (error) { if (![409, 422].includes(error.status) || attempt === 4) throw error; await delay(350 * (attempt + 1)); }
    }
    throw new Error(`Gagal memperbarui ${path} karena perubahan bersamaan.`);
  }
  async function upsertMember(login, avatar) {
    try {
      const rows = await mutateRepoJson('community/members.json', [], current => {
        const next = Array.isArray(current) ? current : [];
        const index = next.findIndex(item => String(typeof item === 'string' ? item : item?.username || '').toLowerCase() === login.toLowerCase());
        if (index < 0) next.push({ username: login, avatar_url: avatar || '', first_connected_at: new Date().toISOString() });
        else {
          const prior = typeof next[index] === 'string' ? { username: next[index] } : (next[index] || {});
          next[index] = { ...prior, username: login, avatar_url: avatar || prior.avatar_url || '' };
        }
        return next;
      }, `NexaBuild: register community member @${login}`);
      state.members = rows;
    } catch (error) { console.warn('Member registry:', error.message); showStatus('videoSettingsInfo', `Koneksi aktif, tetapi daftar anggota belum tersinkron: ${error.message}`, true); }
  }
  async function heartbeat(force = false) {
    if (!hasConnection() || !document.visibilityState || document.visibilityState === 'hidden') return;
    if (!force && Date.now() - state.lastPresenceWrite < 115000) return;
    const username = getConnection().username || getConnection().owner;
    try {
      const presence = await mutateRepoJson('community/presence.json', {}, current => {
        const next = current && typeof current === 'object' && !Array.isArray(current) ? { ...current } : {};
        const staleBefore = Date.now() - 30 * 24 * 60 * 60 * 1000;
        for (const [key, value] of Object.entries(next)) {
          const seen = Date.parse(value?.last_seen || value?.timestamp || '');
          if (!Number.isFinite(seen) || seen < staleBefore) delete next[key];
        }
        next[username] = { username, avatar_url: getConnection().avatar || '', last_seen: new Date().toISOString() };
        return next;
      }, `NexaBuild: heartbeat @${username}`);
      state.lastPresenceWrite = Date.now(); state.presence = presence;
      renderPresenceCount(presence);
    } catch (error) { console.warn('Presence heartbeat:', error.message); }
  }
  function renderPresenceCount(presence) {
    const cutoff = Date.now() - 10 * 60 * 1000;
    const count = Object.values(presence || {}).filter(item => {
      const time = Date.parse(item?.last_seen || item?.timestamp || ''); return Number.isFinite(time) && time >= cutoff;
    }).length;
    if ($('presenceCount')) $('presenceCount').textContent = String(count);
  }
  async function loadCommunityStats() {
    if (!hasConnection()) return;
    if ($('memberCount')) $('memberCount').textContent = '…';
    if ($('presenceCount')) $('presenceCount').textContent = '…';
    try {
      const [members, presence] = await Promise.all([readRepoJson('community/members.json', []), readRepoJson('community/presence.json', {})]);
      state.members = Array.isArray(members.data) ? members.data : [];
      const unique = new Set(state.members.map(item => String(typeof item === 'string' ? item : item?.username || '').toLowerCase()).filter(Boolean));
      $('memberCount').textContent = String(unique.size); state.presence = presence.data || {}; renderPresenceCount(state.presence);
    } catch (error) { $('memberCount').textContent = '—'; $('presenceCount').textContent = '—'; console.warn('Community stats:', error.message); }
  }
  function startHeartbeat() { clearInterval(state.heartbeat); heartbeat(true); state.heartbeat = setInterval(() => heartbeat(false), 120000); }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && hasConnection()) heartbeat(true); });

  // Shared build history: icon data is embedded in each row and never depends on a relative path.
  const pendingBuildRecords = new Map();
  let buildHistorySyncTimer = null;
  let buildHistorySyncBusy = false;
  async function flushBuildHistory() {
    if (!hasConnection() || buildHistorySyncBusy || !pendingBuildRecords.size) return;
    buildHistorySyncBusy = true;
    const batch = [...pendingBuildRecords.values()]; pendingBuildRecords.clear();
    try {
      const rows = await mutateRepoJson('builds.json', [], current => {
        const next = Array.isArray(current) ? current : [];
        for (const record of batch) {
          const index = next.findIndex(row => row.id === record.id);
          const shared = { ...record, username: getConnection().username, iconDataUrl: record.iconDataUrl || null };
          if (index >= 0) next[index] = { ...next[index], ...shared }; else next.unshift(shared);
        }
        next.sort((a,b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
        return next;
      }, `NexaBuild: sync ${batch.length} build record(s)`);
      if ($('buildTotalCount')) $('buildTotalCount').textContent = String(rows.length);
      if ($('buildSuccessCount')) $('buildSuccessCount').textContent = String(rows.filter(item => item?.status === 'success').length);
    } catch (error) {
      batch.forEach(record => pendingBuildRecords.set(record.id, record));
      console.warn('Build history sync:', error.message);
    } finally {
      buildHistorySyncBusy = false;
      if (pendingBuildRecords.size && !buildHistorySyncTimer) buildHistorySyncTimer = setTimeout(() => { buildHistorySyncTimer = null; flushBuildHistory(); }, 12000);
    }
  }
  function syncBuildRecord(record) {
    if (!hasConnection() || !record?.id) return;
    pendingBuildRecords.set(record.id, { ...record });
    const terminal = ['success','failed','cancelled','stopped'].includes(String(record.status).toLowerCase());
    clearTimeout(buildHistorySyncTimer);
    buildHistorySyncTimer = setTimeout(() => { buildHistorySyncTimer = null; flushBuildHistory(); }, terminal ? 0 : 25000);
  }
  async function loadRemoteHistory() {
    if (!hasConnection()) return;
    const localAtStart = bridge().getHistory?.() || [];
    if (!localAtStart.length && $('resultsList')) $('resultsList').innerHTML = '<div class="loading-state glass">Memuat riwayat build dari GitHub…</div>';
    try {
      const result = await readRepoJson('builds.json', []); const remote = Array.isArray(result.data) ? result.data : [];
      const local = bridge().getHistory?.() || []; const byId = new Map();
      for (const item of [...remote, ...local]) {
        if (!item?.id) continue;
        const previous = byId.get(item.id);
        if (!previous) { byId.set(item.id, item); continue; }
        const timeOf = value => Number(value.updatedAt || value.finishedAt || value.createdAt || 0);
        const terminal = value => ['success','failed','cancelled','stopped'].includes(String(value.status || '').toLowerCase());
        const preferIncoming = timeOf(item) > timeOf(previous) || (timeOf(item) === timeOf(previous) && terminal(item) && !terminal(previous));
        byId.set(item.id, preferIncoming ? { ...previous, ...item } : { ...item, ...previous });
      }
      const merged = [...byId.values()].sort((a,b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)).slice(0, 100);
      try { storageSet('nexa.v2.history', JSON.stringify(merged.slice(0, 20))); } catch {}
      bridge().renderResults?.();
      if ($('buildTotalCount')) $('buildTotalCount').textContent = String(remote.length);
      if ($('buildSuccessCount')) $('buildSuccessCount').textContent = String(remote.filter(item => item.status === 'success').length);
    } catch (error) { if ($('resultsList') && !localAtStart.length) $('resultsList').innerHTML = `<div class="empty-state glass"><h2>Riwayat GitHub belum dapat dimuat</h2><p>Periksa izin Contents pada token. Histori lokal perangkat tetap dipertahankan.</p></div>`; console.warn('Remote history:', error.message); }
  }

  // Git Data API upload + workflow_dispatch + direct browser_download_url from the Release API.
  function arrayBufferBase64(buffer) {
    const bytes = new Uint8Array(buffer); let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }
  async function uploadBlob(blob) {
    const base64 = arrayBufferBase64(await blob.arrayBuffer());
    return githubPost(`${repoBase()}/git/blobs`, { content: base64, encoding: 'base64' });
  }
  async function createUploadBranch(record, blob) {
    if (blob.size > 40 * 1024 * 1024) throw new Error('ZIP lebih besar dari batas GitHub Actions NexaBuild (40 MiB).');
    const branch = defaultBranch(); const ref = await githubGet(`${repoBase()}/git/ref/heads/${enc(branch)}`);
    const parentSha = ref.object?.sha; if (!parentSha) throw new Error('Branch utama repository belum memiliki commit. Buat README.md terlebih dahulu.');
    const parent = await githubGet(`${repoBase()}/git/commits/${parentSha}`);
    const chunkSize = 2 * 1024 * 1024; const total = Math.ceil(blob.size / chunkSize); const entries = [];
    for (let i = 0; i < total; i++) {
      const part = blob.slice(i * chunkSize, Math.min(blob.size, (i + 1) * chunkSize));
      const created = await uploadBlob(part);
      entries.push({ path: `.nexabuilder/incoming/${record.id}/parts/part-${String(i).padStart(3, '0')}.bin`, mode: '100644', type: 'blob', sha: created.sha });
      record.uploadProgress = Math.round(((i + 1) / total) * 60); updateActionProgress(record.uploadProgress, 'Upload potongan ZIP ke GitHub…');
    }
    if (record.iconDataUrl) {
      const match = record.iconDataUrl.match(/^data:([^;,]+);base64,(.+)$/);
      if (match) {
        const bytes = Uint8Array.from(atob(match[2]), ch => ch.charCodeAt(0)); const iconBlob = new Blob([bytes], { type: match[1] });
        const icon = await uploadBlob(iconBlob); entries.push({ path: `.nexabuilder/incoming/${record.id}/icon.bin`, mode: '100644', type: 'blob', sha: icon.sha });
      }
    }
    const tree = await githubPost(`${repoBase()}/git/trees`, { base_tree: parent.tree.sha, tree: entries });
    const commit = await githubPost(`${repoBase()}/git/commits`, { message: `NexaBuild upload ${record.id}`, tree: tree.sha, parents: [parentSha] });
    const uploadRef = `nexabuilder-upload-${record.id}`;
    try {
      await githubPost(`${repoBase()}/git/refs`, { ref: `refs/heads/${uploadRef}`, sha: commit.sha });
    } catch (createError) {
      // GitHub may create the ref but the response can time out on a mobile
      // connection. Verify the exact target before treating that as failure.
      let createdRef = null;
      try { createdRef = await githubGet(`${repoBase()}/git/ref/heads/${enc(uploadRef)}`); }
      catch (readError) { if (readError.status !== 404) throw createError; }
      if (createdRef?.object?.sha !== commit.sha) throw createError;
    }
    return { uploadRef, commitSha: commit.sha, branch };
  }
  function updateActionProgress(progress, stage) {
    $('realProgressBar').style.width = `${Math.min(100, progress)}%`; $('progressNumber').textContent = `${Math.round(progress)}%`; $('terminalStage').textContent = stage;
  }
  async function deleteUploadBranch(uploadRef) {
    if (!uploadRef || !/^nexabuilder-upload-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uploadRef)) return;
    try { await githubApi(`${repoBase()}/git/refs/heads/${enc(uploadRef)}`, { method: 'DELETE' }, 25000); }
    catch (error) { if (error.status !== 404) console.warn('Temporary branch cleanup:', error.message); }
  }
  async function findWorkflowRun(id, branch) {
    const runs = await githubGet(`${repoBase()}/actions/workflows/build.yml/runs?event=workflow_dispatch&branch=${encodeURIComponent(branch)}&per_page=100`);
    return (runs.workflow_runs || []).find(run => String(run.display_title || '').includes(id)) || null;
  }
  async function findReleaseAsset(tag, assetName) {
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const release = await githubGet(`${repoBase()}/releases/tags/${encodeURIComponent(tag)}`);
        const asset = (release.assets || []).find(item => item.name === assetName);
        let assetUrl = null;
        try { assetUrl = new URL(asset?.browser_download_url || ''); } catch {}
        const trustedHost = assetUrl && (assetUrl.hostname === 'github.com' || assetUrl.hostname.endsWith('.githubusercontent.com'));
        if (asset && asset.size > 0 && assetUrl?.protocol === 'https:' && trustedHost && assetUrl.pathname.endsWith(`/${encodeURIComponent(assetName)}`)) return { release, asset };
      } catch (error) { if (error.status !== 404) throw error; }
      await delay(3000);
    }
    throw new Error('Build selesai, tetapi asset APK belum tersedia di GitHub Release. Periksa halaman Actions dan Releases repository.');
  }
  async function runGithubBuild(ctx) {
    const { record, prepared } = ctx;
    ctx.addLog('Memeriksa akses repository dan workflow build.yml…', 'info');
    ctx.setLabState('connecting', 'MENGHUBUNGKAN GITHUB', 'Menyiapkan commit upload sementara…', null);
    const upload = await createUploadBranch(record, prepared.blob);
    const options = record.buildOptions || bridge().getOptions?.() || {};
    const dispatchBody = { ref: upload.branch, inputs: {
      upload_id: record.id, upload_ref: upload.uploadRef, app_name: record.appName,
      package_id: record.appId, app_version: record.version, version_code: String(record.versionCode || 1),
      internet_mode: options.internetMode || 'online', camera_permission: String(!!options.camera),
      wake_lock: String(!!options.wakeLock), vibrate_permission: String(!!options.vibrate)
    }};
    try {
      await githubPost(`${repoBase()}/actions/workflows/build.yml/dispatches`, dispatchBody);
    } catch (dispatchError) {
      // A timeout may happen after GitHub accepted dispatch. Delete the input ref
      // only for a definitive HTTP rejection; on ambiguous outcomes preserve it.
      let foundRun = null;
      for (let i = 0; i < 3 && !foundRun; i++) {
        try { foundRun = await findWorkflowRun(record.id, upload.branch); }
        catch (readError) { if (readError.status && readError.status < 500 && readError.status !== 429) break; }
        if (!foundRun && i < 2) await delay(1800);
      }
      const definitiveRejection = Number.isInteger(dispatchError.status) && dispatchError.status >= 400 && dispatchError.status < 500 && dispatchError.status !== 429;
      if (!foundRun && definitiveRejection) await deleteUploadBranch(upload.uploadRef);
      if (!foundRun && !definitiveRejection) {
        const uncertain = new Error(`Status pengiriman workflow belum pasti: ${dispatchError.message}. Branch upload sementara sengaja dipertahankan agar runner yang mungkin sudah menerima dispatch tidak kehilangan ZIP. Periksa tab Actions sebelum mencoba ulang.`);
        uncertain.code = 'NEXA_DISPATCH_UNCERTAIN';
        uncertain.uploadRef = upload.uploadRef;
        throw uncertain;
      }
      if (dispatchError.status === 403) throw new Error(`${dispatchError.message} Pastikan token pemilik repository memiliki izin Actions: Read and write serta Contents: Read and write.`);
      throw new Error(`Workflow tidak dapat dijalankan: ${dispatchError.message}`);
    }
    ctx.addLog(`Workflow NexaBuild dikirim. Upload branch: ${upload.uploadRef}`, 'success');
    record.status = 'queued'; record.githubUploadRef = upload.uploadRef; record.githubCommit = upload.commitSha; record.githubRepo = `${getConnection().owner}/${getConnection().repo}`;
    ctx.saveHistoryRecord(record); ctx.startElapsedTimer(record.startedAt || Date.now());
    let run = null; let jobs = { jobs: [] }; let attempts = 0; let previousLog = '';
    while (attempts < 720) {
      attempts++;
      await delay(5000);
      try {
        run = await findWorkflowRun(record.id, upload.branch);
        if (!run) { updateActionProgress(Math.min(75, 60 + attempts * 0.2), 'Menunggu GitHub Actions memulai workflow…'); continue; }
        record.githubRunId = run.id; record.githubRunUrl = run.html_url; record.status = run.status === 'completed' ? run.conclusion || 'failed' : run.status;
        jobs = await githubGet(`${repoBase()}/actions/runs/${run.id}/jobs?per_page=100`);
      } catch (pollError) {
        if (pollError.status && pollError.status !== 429 && pollError.status < 500) throw pollError;
        ctx.addLog(`Status GitHub belum dapat dibaca, polling akan dicoba lagi: ${pollError.message}`, 'info');
        updateActionProgress(Math.min(92, 65 + attempts * 0.05), 'Mencoba ulang koneksi GitHub…');
        continue;
      }
      const steps = (jobs.jobs || []).flatMap(job => job.steps || []);
      const current = steps.find(step => step.status === 'in_progress') || steps.find(step => step.status === 'queued');
      const completed = steps.filter(step => step.status === 'completed').length;
      const progress = run.status === 'completed' ? (run.conclusion === 'success' ? 100 : 0) : Math.min(95, 60 + completed * 4 + (current ? 2 : 0));
      const stage = current?.name || steps.filter(step => step.status === 'completed').slice(-1)[0]?.name || 'Menunggu runner';
      ctx.setLabState(run.status === 'completed' ? run.conclusion : run.status, run.status === 'completed' ? (run.conclusion === 'success' ? 'APK BERHASIL DIBUAT' : 'BUILD GAGAL') : 'BUILD GITHUB ACTIONS', stage, progress);
      ctx.updateBuildSteps(stage, run.status === 'completed' ? run.conclusion : 'building');
      updateActionProgress(progress, stage);
      const logLine = `${run.status} · ${stage}`;
      if (logLine !== previousLog) { ctx.addLog(logLine, run.status === 'completed' && run.conclusion !== 'success' ? 'error' : 'info'); previousLog = logLine; }
      record.status = run.status === 'completed' ? run.conclusion : run.status;
      ctx.saveHistoryRecord(record);
      if (run.status === 'completed') break;
      if (attempts % 6 === 0) await loadCommunityStats();
    }
    if (!run || run.status !== 'completed') {
      const uncertain = new Error('GitHub Actions belum selesai setelah batas polling 60 menit. Workflow mungkin masih menunggu runner; periksa halaman Actions sebelum mengirim ulang.');
      uncertain.code = 'NEXA_DISPATCH_UNCERTAIN';
      uncertain.uploadRef = upload.uploadRef;
      throw uncertain;
    }
    record.finishedAt = Date.now();
    if (run.conclusion !== 'success') {
      const failed = (jobs.jobs || []).flatMap(job => job.steps || []).find(step => step.conclusion === 'failure');
      record.status = 'failed'; record.error = `Workflow gagal pada: ${failed?.name || 'step tidak diketahui'}`;
      ctx.addLog(record.error, 'error'); ctx.saveHistoryRecord(record); await flushBuildHistory(); throw new Error(`${record.error}. Buka Actions untuk detail log.`);
    }
    const { release, asset } = await findReleaseAsset(`nexabuild-${record.id}`, `NexaBuild-${record.id}.apk`);
    const url = asset.browser_download_url;
    if (!url || !/^https:\/\/(?:github\.com|githubusercontent\.com)\//i.test(url)) throw new Error('GitHub mengembalikan URL asset yang tidak valid.');
    record.status = 'success'; record.downloadUrl = url; record.releaseUrl = release.html_url; record.browserDownloadUrl = url;
    record.releaseAssetName = asset.name; record.releaseAssetSize = asset.size; record.finishedAt = Date.now();
    $('downloadApk').href = url; $('downloadFallback').href = url;
    $('downloadApk').setAttribute('download', asset.name); $('downloadFallback').setAttribute('download', asset.name);
    $('downloadPanel').classList.remove('hidden'); $('terminalActions').classList.remove('hidden');
    $('downloadInfo').textContent = `${asset.name} · ${(asset.size / 1048576).toFixed(1)} MB · GitHub Release`;
    ctx.setLabState('success', 'APK BERHASIL DIBUAT', 'GitHub Release berhasil menerbitkan APK.', 100);
    ctx.updateBuildSteps('Menyiapkan APK', 'success'); ctx.addLog('APK ditemukan pada GitHub Release API. browser_download_url dipasang langsung pada tautan unduhan.', 'success');
    $('labFootnote').textContent = 'Download membuka asset GitHub Release secara langsung. Tautan cadangan tersedia pada tombol “Buka di tab baru”.';
    ctx.saveHistoryRecord(record); await flushBuildHistory(); ctx.renderResults(); ctx.setFinished?.(); await loadRemoteHistory();
  }

  // GitHub Issue comments are the shared GlobalChat store.
  function configuredIssue() { return Number(storageGet(KEYS.chatIssue) || 0); }
  function chatAssetPath(rawUrl) {
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== 'https:' || url.hostname !== 'raw.githubusercontent.com') return null;
      const parts = url.pathname.split('/').filter(Boolean).map(part => { try { return decodeURIComponent(part); } catch { return part; } });
      const folder = parts.findIndex((part, index) => part === 'community' && parts[index + 1] === 'chat-assets');
      if (folder < 0 || folder !== parts.length - 3) return null;
      const filename = parts[folder + 2] || '';
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/.test(filename) || filename === '.' || filename === '..') return null;
      return `community/chat-assets/${filename}`;
    } catch { return null; }
  }
  function mimeForAsset(path) {
    const ext = String(path).split('.').pop().toLowerCase();
    return ({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',pdf:'application/pdf',txt:'text/plain',zip:'application/zip',mp4:'video/mp4',mp3:'audio/mpeg',doc:'application/msword',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'})[ext] || 'application/octet-stream';
  }
  async function fetchChatAsset(rawUrl) {
    const path = chatAssetPath(rawUrl);
    if (!path) throw new Error('Lampiran tidak berasal dari penyimpanan GlobalChat NexaBuild.');
    const file = await githubGet(`${repoBase()}/contents/${enc(path)}?ref=${encodeURIComponent(defaultBranch())}`);
    if (Number(file.size || 0) > 15 * 1024 * 1024) throw new Error('Lampiran melebihi batas GlobalChat 15 MB.');
    let content = file.content || '';
    if (!content && file.sha) content = (await githubGet(`${repoBase()}/git/blobs/${file.sha}`)).content || '';
    if (!content) throw new Error('Isi lampiran tidak tersedia pada repository.');
    const bytes = Uint8Array.from(atob(content.replace(/\s/g, '')), char => char.charCodeAt(0));
    return new Blob([bytes], { type: mimeForAsset(path) });
  }
  async function hydrateChatImages() {
    state.chatAssetUrls.forEach(url => URL.revokeObjectURL(url)); state.chatAssetUrls = [];
    const images = [...($('chatMessages')?.querySelectorAll('img[data-chat-asset]') || [])];
    const load = async image => {
      if (!image.isConnected || image.dataset.loaded === '1') return;
      image.dataset.loaded = '1';
      try { const blob = await fetchChatAsset(image.dataset.chatAsset); const url = URL.createObjectURL(blob); state.chatAssetUrls.push(url); if (image.isConnected) image.src = url; else URL.revokeObjectURL(url); }
      catch { image.alt = 'Lampiran tidak dapat dimuat. Periksa izin Contents token.'; image.classList.add('attachment-unavailable'); }
    };
    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver(entries => entries.forEach(entry => { if (entry.isIntersecting) { observer.unobserve(entry.target); load(entry.target); } }), { root: $('chatMessages'), rootMargin: '180px' });
      images.forEach(image => observer.observe(image));
    } else images.forEach(load);
  }
  $('chatMessages')?.addEventListener('click', async event => {
    const link = event.target.closest('a[data-chat-asset]');
    if (!link) return;
    event.preventDefault();
    const tab = window.open('about:blank', '_blank');
    try {
      const blob = await fetchChatAsset(link.dataset.chatAsset);
      const url = URL.createObjectURL(blob); state.chatAssetUrls.push(url);
      if (tab) tab.location.href = url;
      else { const anchor = document.createElement('a'); anchor.href = url; anchor.download = link.dataset.filename || 'nexabuild-attachment'; anchor.click(); }
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) { try { tab?.close(); } catch {} toast(`Lampiran gagal dibuka: ${error.message}`); }
  });
  function renderChatComment(comment) {
    const author = comment.user?.login || 'GitHub user'; const avatar = comment.user?.avatar_url || '';
    const body = renderChatMarkdown(comment.body || '');
    const stamp = Date.parse(comment.created_at || '');
    const when = Number.isFinite(stamp) ? new Date(stamp).toLocaleString('id-ID') : 'Waktu tidak diketahui';
    return `<article class="chat-message"><img src="${escapeAttr(avatar)}" alt="Avatar ${escapeAttr(author)}" loading="lazy"><div class="chat-message-body"><div class="chat-author"><strong>${escapeHtml(author)}</strong><time>${escapeHtml(when)}</time></div><div class="chat-message-text">${body}</div></div></article>`;
  }
  function updateChatOlderButton() {
    const button = $('chatLoadOlder'); if (!button) return;
    button.classList.toggle('hidden', !state.chatHasMore);
    button.disabled = state.chatLoadingOlder;
    button.textContent = state.chatLoadingOlder ? 'MEMUAT PESAN…' : 'MUAT PESAN LAMA';
  }
  async function loadChat() {
    const sequence = ++state.chatLoadSequence;
    state.chatPage = 1; state.chatHasMore = false; state.chatLoadingOlder = false; updateChatOlderButton();
    if (!hasConnection()) { $('chatMessages').innerHTML = '<div class="chat-state">Hubungkan GitHub terlebih dahulu.</div>'; return; }
    const issue = configuredIssue();
    if (!issue) { $('chatMessages').innerHTML = '<div class="chat-state">Nomor Issue belum diatur. Buka Settings → Chat Config.</div>'; $('chatRoomLabel').textContent = 'Belum ada Issue yang dipilih'; return; }
    const connection = getConnection();
    $('chatRoomLabel').textContent = `Issue #${issue} · ${connection.owner}/${connection.repo}`;
    $('chatMessages').innerHTML = '<div class="chat-state">Memuat pesan komunitas…</div>';
    try {
      await githubGet(`${repoBase()}/issues/${issue}`);
      if (sequence !== state.chatLoadSequence) return;
      const comments = await githubGet(`${repoBase()}/issues/${issue}/comments?per_page=100&sort=created&direction=desc&page=1`);
      if (sequence !== state.chatLoadSequence) return;
      if (!Array.isArray(comments) || !comments.length) { $('chatMessages').innerHTML = '<div class="chat-state">Belum ada pesan. Jadilah yang pertama menyapa komunitas.</div>'; return; }
      state.chatHasMore = comments.length === 100;
      comments.reverse(); // Newest page arrives descending; chronological layout reads top to bottom.
      $('chatMessages').innerHTML = comments.map(renderChatComment).join('');
      updateChatOlderButton(); await hydrateChatImages();
      if (sequence === state.chatLoadSequence) $('chatMessages').scrollTop = $('chatMessages').scrollHeight;
    } catch (error) { if (sequence === state.chatLoadSequence) $('chatMessages').innerHTML = `<div class="chat-state error-text">Gagal memuat chat: ${escapeHtml(error.message)}</div>`; }
  }
  async function loadOlderChat() {
    if (state.chatLoadingOlder || !state.chatHasMore || !hasConnection()) return;
    const issue = configuredIssue(); if (!issue) return;
    const sequence = state.chatLoadSequence;
    state.chatLoadingOlder = true; updateChatOlderButton();
    const box = $('chatMessages'); const beforeHeight = box.scrollHeight; const beforeTop = box.scrollTop;
    try {
      const page = state.chatPage + 1;
      const comments = await githubGet(`${repoBase()}/issues/${issue}/comments?per_page=100&sort=created&direction=desc&page=${page}`);
      if (sequence !== state.chatLoadSequence) return;
      if (!Array.isArray(comments)) throw new Error('GitHub mengembalikan format komentar yang tidak valid.');
      if (!comments.length) { state.chatHasMore = false; return; }
      comments.reverse();
      box.insertAdjacentHTML('afterbegin', comments.map(renderChatComment).join(''));
      state.chatPage = page; state.chatHasMore = comments.length === 100;
      await hydrateChatImages();
      if (sequence === state.chatLoadSequence) box.scrollTop = box.scrollHeight - beforeHeight + beforeTop;
    } catch (error) { if (sequence === state.chatLoadSequence) toast(`Pesan lama gagal dimuat: ${error.message}`); }
    finally { if (sequence === state.chatLoadSequence) { state.chatLoadingOlder = false; updateChatOlderButton(); } }
  }
  $('chatLoadOlder')?.addEventListener('click', loadOlderChat);
  function escapeHtml(input) { return String(input ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  const escapeAttr = escapeHtml;
  function renderChatMarkdown(source) {
    const renderLine = line => {
      const pattern = /!\[([^\]]*)\]\((https:\/\/[^\s)]+)\)|\[([^\]]+)\]\((https:\/\/[^\s)]+)\)|(https:\/\/[^\s<]+)/g;
      let html = ''; let cursor = 0; let match;
      while ((match = pattern.exec(line))) {
        html += escapeHtml(line.slice(cursor, match.index));
        const rawUrl = match[2] || match[4] || match[5] || '';
        let url;
        try { url = new URL(rawUrl); } catch { html += escapeHtml(match[0]); cursor = pattern.lastIndex; continue; }
        if (url.protocol !== 'https:') { html += escapeHtml(match[0]); cursor = pattern.lastIndex; continue; }
        if (match[1] !== undefined) {
          const alt = escapeHtml(match[1] || 'Lampiran gambar');
          const isPrivateAsset = url.hostname === 'raw.githubusercontent.com' && Boolean(chatAssetPath(url.href));
          if (isPrivateAsset) html += `<a class="chat-image-link" href="${escapeAttr(url.href)}" data-chat-asset="${escapeAttr(url.href)}" data-filename="${alt}" target="_blank" rel="noopener noreferrer"><img class="chat-attachment-image" data-chat-asset="${escapeAttr(url.href)}" src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=" alt="${alt}" loading="lazy"></a>`;
          else if (url.hostname === 'raw.githubusercontent.com') html += `<a href="${escapeAttr(url.href)}" target="_blank" rel="noopener noreferrer"><img class="chat-attachment-image" src="${escapeAttr(url.href)}" alt="${alt}" loading="lazy"></a>`;
          else html += `<a href="${escapeAttr(url.href)}" target="_blank" rel="noopener noreferrer">▧ ${alt}</a>`;
        } else if (match[3] !== undefined) {
          const privateAssetAttribute = chatAssetPath(url.href) ? ` data-chat-asset="${escapeAttr(url.href)}"` : '';
          html += `<a href="${escapeAttr(url.href)}"${privateAssetAttribute} target="_blank" rel="noopener noreferrer">${escapeHtml(match[3])}</a>`;
        } else {
          const suffix = (match[5] || '').match(/[.,;:!?\])}]+$/)?.[0] || '';
          const label = suffix ? rawUrl.slice(0, -suffix.length) : rawUrl;
          let safeLabel = label; try { safeLabel = new URL(label).href; } catch {}
          html += `<a href=\"${escapeAttr(safeLabel)}\" target=\"_blank\" rel=\"noopener noreferrer\">${escapeHtml(label)}</a>${escapeHtml(suffix)}`;
        }
        cursor = pattern.lastIndex;
      }
      html += escapeHtml(line.slice(cursor));
      return html;
    };
    return String(source || '').split(/\r?\n/).map(renderLine).join('<br>');
  }
  async function sendChatMessage(extra = '') {
    if (state.chatBusy) return;
    const body = `${$('chatInput').value.trim()}${extra ? `\n${extra}` : ''}`.trim();
    if (!body) return;
    const issue = configuredIssue(); if (!issue) { toast('Atur nomor GitHub Issue di Settings → Chat Config.'); openOverlay('chatConfigOverlay'); return; }
    state.chatBusy = true; $('chatSend').disabled = true;
    try {
      await githubPost(`${repoBase()}/issues/${issue}/comments`, { body }); $('chatInput').value = ''; await loadChat();
    } catch (error) { toast(`Pesan gagal dikirim: ${error.message}`); }
    finally { state.chatBusy = false; $('chatSend').disabled = false; }
  }
  async function uploadChatFile(file, asImage = false) {
    if (!configuredIssue()) { openOverlay('chatConfigOverlay'); throw new Error('Atur nomor GitHub Issue terlebih dahulu. Lampiran belum diunggah.'); }
    const max = 15 * 1024 * 1024; if (!file || file.size < 1) throw new Error('File lampiran kosong atau tidak valid.'); if (file.size > max) throw new Error('Ukuran lampiran chat maksimum 15 MB.');
    if (asImage && !/^image\/(png|jpeg|webp|gif)$/i.test(file.type || '')) throw new Error('Foto/stiker harus berupa PNG, JPG, WEBP, atau GIF. Ubah format foto lalu coba lagi.');
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-90) || 'attachment';
    const nonce = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2, 12);
    const path = `community/chat-assets/${Date.now()}-${nonce}-${safeName}`;
    const data = arrayBufferBase64(await file.arrayBuffer());
    await githubPut(`${repoBase()}/contents/${enc(path)}`, { message: `NexaBuild GlobalChat attachment ${safeName}`, content: data, branch: defaultBranch() });
    const url = `https://raw.githubusercontent.com/${encodeURIComponent(getConnection().owner)}/${encodeURIComponent(getConnection().repo)}/${encodeURIComponent(defaultBranch())}/${path.split('/').map(encodeURIComponent).join('/')}`;
    await sendChatMessage(asImage ? `![Foto](${url})` : `[Lampiran: ${safeName}](${url})`);
  }
  $('chatSend')?.addEventListener('click', () => sendChatMessage());
  $('chatInput')?.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendChatMessage(); } });
  $('chatRefresh')?.addEventListener('click', loadChat);
  $('chatAttach')?.addEventListener('click', () => { renderStickerTray(); openOverlay('attachmentOverlay'); });
  $('sendChatPhoto')?.addEventListener('click', () => { closeOverlay('attachmentOverlay'); $('chatPhotoInput').dataset.sticker = '0'; $('chatPhotoInput').click(); });
  $('sendChatFile')?.addEventListener('click', () => { closeOverlay('attachmentOverlay'); $('chatFileInput').click(); });
  $('chatPhotoInput')?.addEventListener('change', async event => { if (event.target.dataset.sticker === '1') return; const file = event.target.files?.[0]; if (file) try { await uploadChatFile(file, true); } catch (error) { toast(error.message); } event.target.value = ''; });
  $('chatFileInput')?.addEventListener('change', async event => { const file = event.target.files?.[0]; if (file) try { await uploadChatFile(file, false); } catch (error) { toast(error.message); } event.target.value = ''; });

  // Simple centered square crop + brightness control, saved on this device as personal sticker tray.
  function drawSticker() {
    const canvas = $('stickerCanvas'), ctx = canvas?.getContext('2d'), img = state.currentStickerImage; if (!ctx || !img) return;
    const side = Math.min(img.naturalWidth, img.naturalHeight), sx = (img.naturalWidth - side) / 2, sy = (img.naturalHeight - side) / 2;
    ctx.clearRect(0,0,canvas.width,canvas.height); ctx.filter = `brightness(${Number($('stickerBrightness').value || 100)}%)`;
    ctx.drawImage(img, sx, sy, side, side, 0, 0, canvas.width, canvas.height); ctx.filter = 'none';
  }
  $('makeChatSticker')?.addEventListener('click', () => { closeOverlay('attachmentOverlay'); $('chatPhotoInput').dataset.sticker = '1'; $('chatPhotoInput').click(); });
  $('chatPhotoInput')?.addEventListener('change', async event => {
    if (event.target.dataset.sticker !== '1') return; event.target.dataset.sticker = '0';
    const file = event.target.files?.[0]; if (!file) return; event.target.value = ''; const url = URL.createObjectURL(file); const image = new Image();
    image.onload = () => { state.currentStickerImage = image; state.currentStickerFile = file; drawSticker(); openOverlay('stickerOverlay'); URL.revokeObjectURL(url); };
    image.onerror = () => toast('Foto tidak dapat dibuka untuk dibuat stiker.'); image.src = url;
  });
  $('stickerBrightness')?.addEventListener('input', drawSticker);
  function readStickers() { const value = safeJson(storageGet(KEYS.stickers), []); return Array.isArray(value) ? value.filter(src => typeof src === 'string' && /^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(src)).slice(-20) : []; }
  function renderStickerTray() {
    const stickers = readStickers(); const container = $('stickerPersonalTray'); if (!container) return;
    container.innerHTML = stickers.length ? stickers.map((src, i) => `<button class="sticker-thumb" data-sticker-index="${i}" aria-label="Kirim stiker ${i+1}"><img src="${src}" alt="Stiker ${i+1}"></button>`).join('') : '<small>Tray stiker pribadi masih kosong.</small>';
    container.querySelectorAll('[data-sticker-index]').forEach(button => button.addEventListener('click', async () => { const src = readStickers()[Number(button.dataset.stickerIndex)]; if (!src) return; await uploadChatFile(dataUrlToFile(src, `nexa-sticker-${Date.now()}.webp`), true); closeOverlay('attachmentOverlay'); }));
    const main = $('stickerTray'); if (main) main.innerHTML = stickers.slice(-5).map((src,i) => `<button class="sticker-thumb" data-main-sticker="${i}"><img src="${src}" alt="Stiker tersimpan"></button>`).join('');
    main?.querySelectorAll('[data-main-sticker]').forEach(button => button.addEventListener('click', async () => { const sticker = readStickers().slice(-5)[Number(button.dataset.mainSticker)]; if (sticker) await uploadChatFile(dataUrlToFile(sticker, `nexa-sticker-${Date.now()}.webp`), true); }));
  }
  function dataUrlToFile(url, name) { const [meta, data] = url.split(','); const type = /data:([^;]+)/.exec(meta)?.[1] || 'image/webp'; const ext = ({'image/webp':'webp','image/png':'png','image/jpeg':'jpg'})[type] || 'webp'; const base = String(name || 'nexa-sticker').replace(/\.[^.]+$/, ''); const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0)); return new File([bytes], `${base}.${ext}`, { type }); }
  $('saveSticker')?.addEventListener('click', () => {
    try { const src = $('stickerCanvas').toDataURL('image/webp', .82); const stickers = readStickers(); stickers.push(src); storageSet(KEYS.stickers, JSON.stringify(stickers.slice(-12))); closeOverlay('stickerOverlay'); renderStickerTray(); toast('Stiker disimpan pada perangkat ini.'); }
    catch { toast('Penyimpanan perangkat penuh atau tidak tersedia. Hapus beberapa stiker lalu coba lagi.'); }
  });

  // Settings actions: every entry opens its own working screen/dialog.
  function openProfile() { const user = getConnection(); $('profileNameInput').value = user?.displayName || user?.username || $('profileName').textContent; $('profileName').textContent = user?.displayName || user?.username || $('profileName').textContent; openOverlay('profileOverlay'); }
  $('settingsProfile')?.addEventListener('click', () => { closeOverlay('settingsOverlay'); openProfile(); });
  $('drawerProfile')?.addEventListener('click', () => { document.getElementById('appDrawer').classList.remove('open'); $('drawerScrim').classList.add('hidden'); openProfile(); });
  $('drawerSettings')?.addEventListener('click', () => { $('appDrawer').classList.remove('open'); $('drawerScrim').classList.add('hidden'); openSettings(); });
  $('settingsKeystore')?.addEventListener('click', () => { closeOverlay('settingsOverlay'); openOverlay('keystoreOverlay'); });
  $('drawerKeystore')?.addEventListener('click', () => { $('appDrawer').classList.remove('open'); $('drawerScrim').classList.add('hidden'); openOverlay('keystoreOverlay'); });
  $('settingsChat')?.addEventListener('click', () => { closeOverlay('settingsOverlay'); openChatConfig(); });
  $('drawerChatConfig')?.addEventListener('click', () => { $('appDrawer').classList.remove('open'); $('drawerScrim').classList.add('hidden'); openChatConfig(); });
  $('settingsLogout')?.addEventListener('click', () => { closeOverlay('settingsOverlay'); openOverlay('logoutOverlay'); });
  $('drawerLogout')?.addEventListener('click', () => { $('appDrawer').classList.remove('open'); $('drawerScrim').classList.add('hidden'); openOverlay('logoutOverlay'); });
  function openChatConfig() { $('chatIssueNumber').value = configuredIssue() || ''; openOverlay('chatConfigOverlay'); }
  $('saveChatConfig')?.addEventListener('click', () => { const issue = Number($('chatIssueNumber').value); if (!Number.isInteger(issue) || issue < 1) return toast('Masukkan nomor Issue yang valid.'); storageSet(KEYS.chatIssue, String(issue)); closeOverlay('chatConfigOverlay'); toast('Nomor Issue GlobalChat disimpan.'); loadChat(); });
  $('cancelLogout')?.addEventListener('click', () => closeOverlay('logoutOverlay'));
  $('confirmLogout')?.addEventListener('click', () => {
    storageRemove(KEYS.connection); storageRemove(KEYS.authorized); storageRemove(KEYS.first); state.connection = null; clearInterval(state.heartbeat); clearInterval(state.buildCycle); closeOverlay('logoutOverlay');
    $('fingerprintGate').classList.remove('hidden'); $('githubLoginScreen').classList.add('hidden'); $('introScreen').classList.add('hidden'); $('loginOwner').value = ''; $('loginRepo').value = ''; $('loginToken').value = ''; toast('GitHub terputus dari perangkat ini.');
  });
  $('saveProfile')?.addEventListener('click', () => {
    const value = $('profileNameInput').value.trim().slice(0, 32); if (!value) return toast('Nama tampilan tidak boleh kosong.');
    const c = getConnection(); if (c) { c.displayName = value; state.connection = c; storageSet(KEYS.connection, JSON.stringify(c)); }
    $('profileName').textContent = value; $('profileRole').textContent = c ? `${c.username === c.owner ? 'OWNER' : 'MEMBER'} · GITHUB` : 'GITHUB · BELUM TERHUBUNG'; closeOverlay('profileOverlay'); toast('Profil diperbarui.');
  });
  function openSettings() {
    const c = getConnection() || {}; $('settingsToken').value = ''; $('settingsOwner').value = c.owner || ''; $('settingsRepo').value = c.repo || '';
    $('fontChoice').value = storageGet(KEYS.font) || 'Inter'; $('chatIssueNumber').value = configuredIssue() || '';
    openOverlay('settingsOverlay');
  }
  $('themeNeo')?.addEventListener('click', () => applyTheme('neo'));
  $('themeLiquid')?.addEventListener('click', () => applyTheme('liquid'));
  $('saveGithubSettings')?.addEventListener('click', async () => {
    const token = $('settingsToken').value.trim() || getConnection()?.token; const owner = $('settingsOwner').value.trim(); const repo = $('settingsRepo').value.trim();
    if (!token || !owner || !repo) return toast('Token, Owner, dan Repo wajib tersedia.');
    try {
      const [user, data] = await Promise.all([
        githubRequestWithToken('/user', token),
        githubRequestWithToken(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, token)
      ]);
      if (!user.login) throw new Error('GitHub tidak mengembalikan identitas akun yang valid.');
      const c = getConnection() || {};
      state.connection = { ...c, token, owner, repo, branch: data.default_branch || 'main', username: user.login, displayName: c.displayName && c.username === user.login ? c.displayName : (user.name || user.login), avatar: user.avatar_url || '', connectedAt: c.connectedAt || Date.now() };
      storageSet(KEYS.connection, JSON.stringify(state.connection)); setAuthProfile(user);
      state.lastPresenceWrite = 0; closeOverlay('settingsOverlay');
      await upsertMember(user.login, user.avatar_url); await heartbeat(true);
      await Promise.all([loadCommunityStats(), loadRemoteHistory()]); startHeartbeat(); await loadChat(); toast(`Koneksi GitHub disimpan sebagai @${user.login}.`);
    } catch (error) { toast(`Gagal menyimpan koneksi: ${error.message}`); }
  });
  $('replayIntro')?.addEventListener('click', () => { closeOverlay('settingsOverlay'); $('introScreen').classList.remove('hidden'); const v = $('introVideo'); v.muted = false; v.play().catch(() => { v.muted = true; }); $('introSoundToggle').textContent = v.muted ? 'AKTIFKAN SUARA' : 'MATIKAN SUARA'; });
  $('drawerEngineTest')?.addEventListener('click', () => { if (hasConnection()) { githubGet('/user').then(user => { setAuthProfile(user); toast('GitHub API terhubung.'); }).catch(error => toast(error.message)); } else openSettings(); });

  // Video/font customisation. Files persist locally in IndexedDB, no fake path writes.

  function styleNativeFileInputs() {
    document.querySelectorAll('input[type=file]:not([hidden])').forEach(input => {
      input.classList.add('native-file-input');
      const parent = input.closest('.file-upload-field, .app-icon-uploader');
      if (!parent) return;
      parent.classList.add('native-file-shell');
      if (parent.classList.contains('file-upload-field')) {
        input.addEventListener('change', () => {
          const targetId = ({introVideoFile:'introVideoName',liquidVideoFile:'liquidVideoName',buildVideoFiles:'buildVideoNames',fontFile:'fontFileName',keystoreFile:'keystoreFileName'})[input.id];
          const target = targetId && $(targetId); if (target && input.files?.length) target.textContent = [...input.files].map(file => file.name).join(' · ');
        });
      }
    });
  }
  styleNativeFileInputs();
  async function saveVideoSlot(slot, file) { if (!file) return; if (file.size > 150 * 1024 * 1024) throw new Error('Ukuran video maksimum 150 MB.'); await saveMedia(`video:${slot}`, file, file.name); const url = URL.createObjectURL(file); if (state.mediaUrls.has(slot)) URL.revokeObjectURL(state.mediaUrls.get(slot)); state.mediaUrls.set(slot, url); }
  $('introVideoFile')?.addEventListener('change', async e => { try { const file = e.target.files?.[0]; if (!file) return; await saveVideoSlot('intro', file); const cfg = safeJson(storageGet('nexabuild.video.config.v1'), {}); cfg.introName = file.name; storageSet('nexabuild.video.config.v1', JSON.stringify(cfg)); $('introVideoName').textContent = `Tersimpan: ${file.name}`; setVideoSource($('introVideo'), state.mediaUrls.get('intro'), 'intro'); showStatus('videoSettingsInfo', `Intro tersimpan: ${file.name}`); } catch (error) { toast(error.message); } });
  $('liquidVideoFile')?.addEventListener('change', async e => { try { const file = e.target.files?.[0]; if (!file) return; await saveVideoSlot('liquid', file); const cfg = safeJson(storageGet('nexabuild.video.config.v1'), {}); cfg.liquidName = file.name; storageSet('nexabuild.video.config.v1', JSON.stringify(cfg)); $('liquidVideoName').textContent = `Tersimpan: ${file.name}`; setVideoSource($('liquidBackgroundVideo'), state.mediaUrls.get('liquid'), 'liquid'); showStatus('videoSettingsInfo', `Background tersimpan: ${file.name}`); } catch (error) { toast(error.message); } });
  $('buildVideoFiles')?.addEventListener('change', async e => {
    try { const files = [...(e.target.files || [])]; if (!files.length) return; const slots = [];
      for (let i = 0; i < files.length; i++) { const slot = `build-${Date.now()}-${i}`; await saveMedia(`video:${slot}`, files[i], files[i].name); const url = URL.createObjectURL(files[i]); state.mediaUrls.set(slot, url); slots.push(`custom:${slot}`); }
      state.buildVideos = [...slots, ...DEFAULT_VIDEOS.build]; storageSet(KEYS.buildVideos, JSON.stringify(state.buildVideos)); const cfg = safeJson(storageGet('nexabuild.video.config.v1'), {}); cfg.buildNames = files.map(file => file.name); storageSet('nexabuild.video.config.v1', JSON.stringify(cfg)); $('buildVideoNames').textContent = `Pool tersimpan: ${cfg.buildNames.join(' · ')}`; startBuildVideoCycle(); showStatus('videoSettingsInfo', `${files.length} video Build masuk ke pool. Slot default tetap menjadi cadangan.`);
    } catch (error) { toast(error.message); }
  });
  $('fontChoice')?.addEventListener('change', e => applyGoogleFont(e.target.value));
  function applyGoogleFont(name) {
    const allowed = ['Inter','Space Grotesk','Nunito','DM Sans']; if (!allowed.includes(name)) return;
    const id = 'nexa-google-font'; $(id)?.remove(); const link = document.createElement('link'); link.id = id; link.rel = 'stylesheet'; link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name).replace(/%20/g,'+')}:wght@400;500;600;700;800&display=swap`; document.head.appendChild(link); document.documentElement.style.setProperty('--font-main', `'${name}', sans-serif`); storageSet(KEYS.font, name);
  }
  async function restoreUploadedFont() {
    if (storageGet(KEYS.font) !== 'NexaCustomFont') return;
    try { const saved = await getMedia('font:custom'); if (!saved?.blob) throw new Error('File font lokal tidak ditemukan.'); const url = URL.createObjectURL(saved.blob); const style = document.getElementById('nexa-custom-font') || document.createElement('style'); style.id = 'nexa-custom-font'; const ext = (saved.name?.split('.').pop() || 'woff2').toLowerCase(); const format = ({woff:'woff',woff2:'woff2',ttf:'truetype',otf:'opentype'})[ext] || 'woff2'; style.textContent = `@font-face{font-family:NexaCustomFont;src:url('${url}') format('${format}');font-display:swap}`; document.head.appendChild(style); document.documentElement.style.setProperty('--font-main', `'NexaCustomFont',sans-serif`); $('fontChoice').value = ''; $('fontFileName').textContent = `Tersimpan: ${saved.name || 'font khusus'}`; } catch (error) { storageSet(KEYS.font, 'Inter'); applyGoogleFont('Inter'); showStatus('videoSettingsInfo', `Font kustom tidak dapat dipulihkan: ${error.message}`, true); }
  }
  $('fontFile')?.addEventListener('change', async e => {
    const file = e.target.files?.[0]; if (!file) return;
    try { await saveMedia('font:custom', file, file.name); const url = URL.createObjectURL(file); const family = 'NexaCustomFont'; const ext = (file.name.split('.').pop() || 'woff2').toLowerCase(); const format = ({woff:'woff',woff2:'woff2',ttf:'truetype',otf:'opentype'})[ext] || 'woff2'; const style = document.getElementById('nexa-custom-font') || document.createElement('style'); style.id = 'nexa-custom-font'; style.textContent = `@font-face{font-family:${family};src:url('${url}') format('${format}');font-display:swap}`; document.head.appendChild(style); document.documentElement.style.setProperty('--font-main', `'${family}',sans-serif`); storageSet(KEYS.font, family); toast(`Font ${file.name} diterapkan pada dashboard.`); } catch (error) { toast(error.message); }
  });

  // Optional-feature previews and real wake-lock control for the dashboard tab.
  let screenLock = null;
  $('internetMode')?.addEventListener('change', e => { const offline = e.target.value === 'offline'; $('internetPreview').innerHTML = `<span class="preview-symbol ${offline ? 'offline-symbol' : 'online-symbol'}">${offline ? '◌' : '◎'}</span><span>${offline ? 'Offline · cache lokal akan disiapkan pada build static web.' : 'Online · API dan layanan jaringan dapat digunakan.'}</span>`; });
  $('cameraPermission')?.addEventListener('change', e => { const node = e.target.closest('.option-card')?.querySelector('.option-preview span:last-child'); if (node) node.textContent = e.target.checked ? 'Izin CAMERA ditambahkan untuk APK; fitur foto/scan dapat meminta akses kamera.' : 'Izin kamera tidak diminta oleh APK.'; });
  $('vibratePermission')?.addEventListener('change', e => { const node = e.target.closest('.option-card')?.querySelector('.option-preview span:last-child'); if (node) node.textContent = e.target.checked ? 'Izin VIBRATE ditambahkan untuk umpan balik haptic.' : 'APK tidak meminta izin getaran.'; });
  $('wakeLock')?.addEventListener('change', async e => {
    $('wakePreview').classList.toggle('screen-dim-preview', !e.target.checked);
    if (e.target.checked && 'wakeLock' in navigator) { try { screenLock = await navigator.wakeLock.request('screen'); $('wakePreview').querySelector('span:last-child').textContent = 'Layar ditahan menyala pada sesi browser ini dan izin native dimasukkan ke APK.'; } catch { $('wakePreview').querySelector('span:last-child').textContent = 'Izin Wake Lock akan diterapkan pada APK; browser tidak mengizinkan lock sekarang.'; } }
    else { try { await screenLock?.release(); } catch {} screenLock = null; $('wakePreview').querySelector('span:last-child').textContent = 'Layar dapat meredup normal; APK tidak meminta Wake Lock.'; }
  });

  // Keystore helper prepares base64 locally and opens the official repository secret settings page.
  let keystoreBase64 = '';
  $('prepareKeystore')?.addEventListener('click', async () => {
    const file = $('keystoreFile').files?.[0]; const alias = $('keystoreAlias').value.trim(); const password = $('keystorePassword').value; const keyPassword = $('keyPassword').value;
    if (!file || !/\.(jks|keystore)$/i.test(file.name) || !alias || !password || !keyPassword) return showStatus('keystoreResult', 'Pilih file keystore dan isi alias serta kedua password.', true);
    if (file.size > 10 * 1024 * 1024) return showStatus('keystoreResult', 'Ukuran keystore maksimum 10 MB.', true);
    try {
      keystoreBase64 = arrayBufferBase64(await file.arrayBuffer());
      showStatus('keystoreResult', `Keystore siap (${(file.size/1024).toFixed(1)} KB). Buat 4 repository secrets berikut: NEXABUILD_KEYSTORE_BASE64, NEXABUILD_KEYSTORE_PASSWORD, NEXABUILD_KEY_ALIAS, NEXABUILD_KEY_PASSWORD. Nilai Base64 dapat disalin pada langkah berikutnya.`);
      let copy = $('copyKeystoreBase64'); if (!copy) { copy = document.createElement('button'); copy.id = 'copyKeystoreBase64'; copy.className = 'secondary-btn full-btn'; copy.textContent = 'SALIN KEYSTORE BASE64'; $('keystoreResult').after(copy); }
      copy.onclick = async () => { try { await navigator.clipboard.writeText(keystoreBase64); toast('Base64 keystore disalin.'); } catch { showStatus('keystoreResult', 'Browser tidak mengizinkan clipboard. Buka ulang modal di browser yang mendukung clipboard.', true); } };
      $('openRepoSecrets').disabled = false;
    } catch (error) { showStatus('keystoreResult', error.message, true); }
  });
  $('openRepoSecrets')?.addEventListener('click', () => { const c = getConnection(); if (!c) return toast('Hubungkan GitHub terlebih dahulu.'); window.open(`https://github.com/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/settings/secrets/actions`, '_blank', 'noopener'); });

  // Full-screen Quran reader. The source remains the app's verified Quran API/fallback.
  let quranNumber = 1;
  function syncFullQuran() { $('quranFullSurah').textContent = $('surahLabel').textContent; $('quranFullArabic').textContent = $('arabicText').textContent; $('quranFullTranslation').textContent = $('translationText').textContent; }
  $('openQuran')?.addEventListener('click', () => { quranNumber = window.NexaQuranCurrent || 1; syncFullQuran(); $('quranFullscreen').classList.remove('hidden'); });
  $('openQuran')?.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('openQuran').click(); } });
  $('quranClose')?.addEventListener('click', () => $('quranFullscreen').classList.add('hidden'));
  $('quranRandom')?.addEventListener('click', async () => { quranNumber = Math.floor(Math.random() * 6236) + 1; await bridge().loadVerse?.(quranNumber); syncFullQuran(); });
  const originalQuranLoad = window.NexaQuranLoad;
  if (originalQuranLoad) window.NexaQuranLoad = async number => { await originalQuranLoad(number); syncFullQuran(); };

  function updateDates() {
    const now = new Date(); const value = now.toLocaleDateString('id-ID', { day:'2-digit', month:'short', year:'numeric' });
    if ($('homeDate')) $('homeDate').textContent = value;
    if ($('buildDate')) $('buildDate').textContent = value;
  }
  function startBuildVideoCycle() { clearInterval(state.buildCycle); cycleBuildVideo(); state.buildCycle = setInterval(cycleBuildVideo, 18000); }
  document.addEventListener('click', event => {
    const nav = event.target.closest('[data-nav]');
    if (nav?.dataset.nav === 'chat') { setTimeout(loadChat, 0); }
    if (nav?.dataset.nav === 'home' || nav?.dataset.nav === 'build' || nav?.dataset.nav === 'results') {
      setTimeout(() => { if (nav.dataset.nav === 'build') startBuildVideoCycle(); if (nav.dataset.nav === 'home' && hasConnection()) loadCommunityStats(); }, 0);
    }
  });
  // Remove any inherited APKit auto test status as primary connection indicator: both paths remain available.
  if (hasConnection()) { githubGet('/user').then(user => { setAuthProfile(user); }).catch(error => { console.warn('Saved GitHub session could not be verified:', error.message); }); }

  async function bootRevision() {
    updateDates(); setInterval(updateDates, 30000);
    applyTheme(storageGet(KEYS.theme) || 'neo');
    if (storageGet(KEYS.font) === 'NexaCustomFont') await restoreUploadedFont(); else applyGoogleFont(storageGet(KEYS.font) || 'Inter');
    await applyVideoSettings().catch(error => console.warn('Video slot fallback:', error.message));
    startBuildVideoCycle();
    renderStickerTray();
    readGateState();
    if (hasConnection() && storageGet(KEYS.authorized) === '1') {
      try { const user = await githubGet('/user'); setAuthProfile(user); await heartbeat(true); await Promise.all([loadCommunityStats(), loadRemoteHistory()]); startHeartbeat(); startBuildVideoCycle(); }
      catch (error) { console.warn('GitHub reconnect check:', error.message); if (error.status === 401) { $('fingerprintGate').classList.remove('hidden'); $('githubLoginScreen').classList.add('hidden'); toast('Token GitHub tidak berlaku lagi. Hubungkan kembali.'); } }
    }
  }
  bootRevision();

  window.NexaRevision = { hasConnection, runGithubBuild, syncBuildRecord, loadChat, loadCommunityStats, applyTheme, getConnection };
})();