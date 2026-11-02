/* NEXA STUDIO Mobile Neobrutalism — real browser UI + APKit API client.
   No fake build state: only API responses update build status/progress. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const storageGet = (key, fallback = null) => { try { return window.localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
  const storageSet = (key, value) => { try { window.localStorage.setItem(key, String(value)); return true; } catch { return false; } };
  const STORAGE = { engine: 'nexa.v2.engine', profile: 'nexa.v2.profile', history: 'nexa.v2.history' };
  const DEFAULT_ENGINE = 'https://apkit.onrender.com';
  const SCREEN_LABELS = { home: 'HOME', build: 'BUILD', results: 'EDIT HISTORY', chat: 'GLOBALCHAT', lab: 'BUILD' };
  let currentView = 'home';
  let currentFile = null;
  let currentProjectId = null;
  let projectLoadSequence = 0;
  let currentZip = null;
  let fileEntries = [];
  let indexEntry = null;
  let detectedType = 'Belum diketahui';
  let previewReviewed = false;
  let previewUrl = null;
  let assetUrls = [];
  let customIcon = null;
  let iconFile = null;
  let userProfile = storageGet(STORAGE.profile) || 'Nexa Maker';
  let engineUrl = normalizeUrl(storageGet(STORAGE.engine) || DEFAULT_ENGINE);
  let currentJob = null;
  let pollHandle = null;
  let clockHandle = null;
  let eventStream = null;
  let lastStatus = '';
  let lineCount = 0;
  let activeHistoryId = null;
  const memoryFiles = new Map();

  const DB_NAME = 'nexa-studio-v2';
  let dbPromise;
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('IndexedDB tidak tersedia'));
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Gagal membuka database lokal'));
    });
    return dbPromise;
  }
  async function saveProjectFile(id, file, metadata = {}) {
    memoryFiles.set(id, { file, metadata });
    try {
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction('projects', 'readwrite');
        tx.objectStore('projects').put({ id, file, name: file.name, type: file.type, size: file.size, metadata, savedAt: Date.now() });
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error('Gagal menyimpan ZIP di browser'));
        tx.onabort = () => reject(tx.error || new Error('Penyimpanan ZIP dibatalkan'));
      });
    } catch (err) {
      console.warn('Project tersimpan dalam sesi aktif saja:', err);
    }
  }
  async function getProjectFile(id) {
    if (memoryFiles.has(id)) return memoryFiles.get(id).file;
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('projects', 'readonly');
        const req = tx.objectStore('projects').get(id);
        req.onsuccess = () => resolve(req.result?.file || null);
        req.onerror = () => reject(req.error);
      });
    } catch { return null; }
  }

  function normalizeUrl(url) {
    return String(url || DEFAULT_ENGINE).trim().replace(/\/+$/, '');
  }
  function engineTokenKey(base = engineUrl) { return `nexa.v2.engineToken:${normalizeUrl(base)}`; }
  function getEngineToken(base = engineUrl) {
    try { return sessionStorage.getItem(engineTokenKey(base)) || ''; } catch { return ''; }
  }
  function engineHeaders(extra = {}, base = engineUrl) {
    const headers = { ...extra };
    const token = getEngineToken(base);
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }
  function engineQuery(url, base = engineUrl) {
    const token = getEngineToken(base);
    if (!token) return url;
    const join = url.includes('?') ? '&' : '?';
    return `${url}${join}token=${encodeURIComponent(token)}`;
  }
  async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try { return await fetch(url, { ...options, signal: controller.signal }); }
    finally { clearTimeout(timer); }
  }
  function updateEngineAuthUi(message = '') {
    const signedIn = !!getEngineToken();
    $('engineLogout').disabled = !signedIn;
    $('engineAuthMessage').textContent = message || (signedIn
      ? 'Sesi engine aktif di tab browser ini.'
      : 'Sesi akun hanya disimpan sementara di tab browser ini.');
  }
  async function authenticateEngine(mode) {
    const email = $('engineEmail').value.trim();
    const password = $('enginePassword').value;
    if (!email || !password) { $('engineAuthMessage').textContent = 'Isi email dan password akun engine.'; return; }
    if (password.length < (mode === 'signup' ? 8 : 1)) { $('engineAuthMessage').textContent = 'Password untuk pendaftaran minimal 8 karakter.'; return; }
    const base = normalizeUrl(engineUrl);
    $('engineAuthMessage').textContent = mode === 'signup' ? 'Membuat akun engine…' : 'Masuk ke engine…';
    $('engineLogin').disabled = $('engineSignup').disabled = true;
    try {
      const response = await fetch(`${base}/api/auth/${mode}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email, password }), cache: 'no-store'
      });
      let data = {}; try { data = await response.json(); } catch {}
      if (!response.ok) throw new Error(data.detail || data.error || `Autentikasi gagal (HTTP ${response.status})`);
      if (!data.token) throw new Error('Layanan tidak mengembalikan token sesi.');
      try { sessionStorage.setItem(engineTokenKey(base), data.token); } catch {}
      $('enginePassword').value = '';
      updateEngineAuthUi(mode === 'signup' ? 'Akun engine berhasil dibuat dan sesi aktif di tab ini.' : 'Berhasil masuk. Sesi hanya disimpan di tab ini.');
      toast(mode === 'signup' ? 'Akun engine dibuat.' : 'Berhasil masuk ke engine.');
    } catch (error) {
      $('engineAuthMessage').textContent = error.message;
    } finally {
      $('engineLogin').disabled = false;
      $('engineSignup').disabled = false;
      updateEngineAuthUi($('engineAuthMessage').textContent);
    }
  }
  function toast(message, timeout = 3000) {
    const node = $('toast');
    node.textContent = message;
    node.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => node.classList.remove('show'), timeout);
  }
  function icon(name) { return `<svg aria-hidden="true"><use href="#i-${name}"></use></svg>`; }
  function escapeHtml(input) {
    return String(input ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }
  function showView(name) {
    if (!SCREEN_LABELS[name]) name = 'home';
    currentView = name;
    document.querySelectorAll('.view').forEach(view => view.classList.toggle('active', view.dataset.view === name));
    document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.nav === name));
    $('pageIndicator').textContent = SCREEN_LABELS[name];
    const titles = { home:['NexaBuild','Beranda'], build:['Build','Membangun aplikasi'], results:['Edit History','Riwayat & ubah aplikasi'], chat:['GlobalChat','Obrolan bersama'], lab:['Build','Membangun aplikasi'] };
    if ($('moduleTitle')) $('moduleTitle').textContent = 'NEXA STUDIO';
    if ($('moduleSubtitle')) $('moduleSubtitle').textContent = '';
    document.body.classList.toggle('module-transition', true);
    setTimeout(() => document.body.classList.remove('module-transition'), 520);
    $('bottomNav').classList.toggle('nav-hidden', name === 'lab');
    if (name === 'results') renderResults();
    if (name === 'build') updateBuildReadiness();
    window.scrollTo?.(0, 0);
  }
  function openOverlay(id) { $(id).classList.remove('hidden'); }
  function closeOverlay(id) { $(id).classList.add('hidden'); }
  function openDrawer() { $('appDrawer').classList.add('open'); $('drawerScrim').classList.remove('hidden'); }
  function closeDrawer() { $('appDrawer').classList.remove('open'); $('drawerScrim').classList.add('hidden'); }

  // Clock uses the device's local time.
  function updateClock() {
    const now = new Date();
    $('digitalTime').textContent = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', hour12: false });
    $('dateText').textContent = now.toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  }
  updateClock(); setInterval(updateClock, 15000);

  // The supplied MP4 is included in the package and continuously loops. It starts muted for mobile autoplay policies.
  $('animeVideo').addEventListener('error', () => { $('animeVideo').classList.add('video-unavailable'); $('animeVideo').closest('.anime-card')?.classList.add('home-video-unavailable'); });
  $('animeVideo').addEventListener('loadeddata', () => { $('animeVideo').classList.remove('video-unavailable'); $('animeVideo').closest('.anime-card')?.classList.remove('home-video-unavailable'); });
  $('videoSound').addEventListener('click', async () => {
    const video = $('animeVideo');
    video.muted = !video.muted;
    $('videoSound').innerHTML = icon(video.muted ? 'mute' : 'volume');
    $('videoSound').setAttribute('aria-label', video.muted ? 'Nyalakan suara' : 'Matikan suara');
    if (!video.muted) { try { await video.play(); } catch {} }
  });

  // Live Quran ayah source. If offline, retain a verified short fallback rather than showing a fake loading state forever.
  const quranFallback = { surah: 'Al-Fatihah', n: 1, arabic: 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ', translation: 'Dengan nama Allah Yang Maha Pengasih, Maha Penyayang.' };
  async function loadVerse(number = 1) {
    window.NexaQuranCurrent = number;
    $('surahLabel').textContent = 'Memuat ayat…';
    try {
      const response = await fetch(`https://api.alquran.cloud/v1/ayah/${encodeURIComponent(number)}/editions/quran-uthmani,id.indonesian`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = await response.json();
      if (json.code !== 200 || !Array.isArray(json.data) || json.data.length < 2) throw new Error('Format respons ayat tidak sesuai');
      const arabic = json.data.find(v => v.edition?.identifier === 'quran-uthmani') || json.data[0];
      const translation = json.data.find(v => v.edition?.identifier === 'id.indonesian') || json.data[1];
      $('surahLabel').textContent = `${translation.surah?.englishName || translation.surah?.name || 'Surah'} · ${translation.surah?.number || ''}:${translation.numberInSurah || ''}`;
      $('arabicText').textContent = arabic.text || quranFallback.arabic;
      $('translationText').textContent = translation.text || quranFallback.translation;
    } catch (err) {
      $('surahLabel').textContent = `${quranFallback.surah} · 1:1`;
      $('arabicText').textContent = quranFallback.arabic;
      $('translationText').textContent = quranFallback.translation;
      console.info('API Al-Qur’an tidak terjangkau; menampilkan fallback:', err.message);
    }
  }
  window.NexaQuranLoad = loadVerse;
  loadVerse(1);
  $('refreshVerse').addEventListener('click', event => { event.stopPropagation(); loadVerse(Math.floor(Math.random() * 6236) + 1); });

  // Profile is deliberately a local demo, as requested. It is not an authenticated account.
  function renderProfile() { $('profileName').textContent = userProfile; $('profileNameInput').value = userProfile; }
  renderProfile();
  $('accountStrip').addEventListener('click', () => openOverlay('profileOverlay'));
  $('accountStrip').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openOverlay('profileOverlay'); } });
  $('saveProfile').addEventListener('click', () => {
    if (window.NexaRevision?.hasConnection?.()) return;
    const value = $('profileNameInput').value.trim().slice(0, 32);
    if (!value) return toast('Nama tampilan tidak boleh kosong.');
    userProfile = value;
    storageSet(STORAGE.profile, userProfile);
    renderProfile(); closeOverlay('profileOverlay'); toast('Profil demo diperbarui.');
  });

  // App navigation.
  $('menuOpen').addEventListener('click', openDrawer);
  $('closeDrawer').addEventListener('click', closeDrawer);
  $('drawerScrim').addEventListener('click', closeDrawer);
  document.querySelectorAll('[data-nav]').forEach(button => button.addEventListener('click', () => { closeDrawer(); showView(button.dataset.nav); }));
  document.querySelectorAll('[data-drawer-nav]').forEach(button => button.addEventListener('click', () => {
    closeDrawer();
    const target = button.dataset.drawerNav;
    if (target === 'build') showView('build');
    else if (target === 'results') showView('results');
    else if (target === 'chat') showView('chat');
    else showView('home');
  }));
  $('homeNewBuild').addEventListener('click', () => showView('build'));
  $('drawerGithub').addEventListener('click', () => { closeDrawer(); openOverlay('githubOverlay'); });
  $('importGithub').addEventListener('click', () => openOverlay('githubOverlay'));
  $('drawerEngine').addEventListener('click', () => { closeDrawer(); $('engineUrl').value = engineUrl; openOverlay('engineOverlay'); });
  document.querySelectorAll('[data-close-overlay]').forEach(button => button.addEventListener('click', () => closeOverlay(button.dataset.closeOverlay)));
  document.querySelectorAll('.overlay').forEach(overlay => overlay.addEventListener('click', e => { if (e.target === overlay && overlay.id !== 'previewOverlay') closeOverlay(overlay.id); }));
  $('engineUrl').value = engineUrl;
  $('saveEngine').addEventListener('click', async () => {
    const value = normalizeUrl($('engineUrl').value);
    if (!/^https:\/\//i.test(value)) return toast('Engine URL harus menggunakan HTTPS.');
    engineUrl = value; storageSet(STORAGE.engine, engineUrl); updateEngineAuthUi(); closeOverlay('engineOverlay'); await testEngine(true);
  });
  $('checkEngine').addEventListener('click', () => testEngine(false));
  $('engineLogin').addEventListener('click', () => authenticateEngine('login'));
  $('engineSignup').addEventListener('click', () => authenticateEngine('signup'));
  $('engineLogout').addEventListener('click', async () => {
    const token = getEngineToken();
    try {
      if (token) await fetch(`${engineUrl}/api/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
    } catch { /* Browser may be offline; local session will still be cleared. */ }
    try { sessionStorage.removeItem(engineTokenKey()); } catch {}
    $('enginePassword').value = '';
    updateEngineAuthUi('Sesi engine di tab ini sudah dihapus.');
    toast('Keluar dari sesi engine.');
  });
  updateEngineAuthUi();

  async function testEngine(showToast = false) {
    const currentBase = normalizeUrl(engineUrl);
    $('engineHealthText').textContent = 'Memeriksa engine…';
    $('engineDot').className = 'engine-dot';
    $('drawerEngineLabel').textContent = 'ENGINE SEDANG DITES';
    $('drawerEngineBullet').classList.remove('good');
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const response = await fetch(`${currentBase}/api/health`, { method: 'GET', cache: 'no-store', signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (data.ok !== true) throw new Error('Health check tidak mengembalikan ok:true');
      $('engineDot').classList.add('good'); $('engineHealthText').textContent = 'Engine online';
      $('drawerEngineBullet').classList.add('good'); $('drawerEngineLabel').textContent = 'ENGINE ONLINE'; $('drawerEngineSub').textContent = new URL(currentBase).host;
      $('engineResult').className = 'connection-result good'; $('engineResult').innerHTML = `<i></i><span>Online · ${escapeHtml(new URL(currentBase).host)}</span>`;
      if (showToast) toast('Engine merespons. Build masih perlu diuji dengan ZIP project.');
      return true;
    } catch (error) {
      $('engineDot').className = 'engine-dot bad'; $('engineHealthText').textContent = 'Engine tidak terjangkau';
      let engineHost = currentBase; try { engineHost = new URL(currentBase).host; } catch {}
      $('drawerEngineBullet').classList.remove('good'); $('drawerEngineLabel').textContent = 'ENGINE BELUM TERJANGKAU'; $('drawerEngineSub').textContent = engineHost;
      $('engineResult').className = 'connection-result bad'; $('engineResult').innerHTML = `<i></i><span>${escapeHtml(error.name === 'AbortError' ? 'Timeout saat memeriksa engine' : error.message)}</span>`;
      if (showToast) toast(`Engine gagal dihubungi: ${error.message}. Periksa internet atau URL.` , 4500);
      return false;
    }
  }
  // Do an actual non-blocking health check so the user can distinguish the API's status from a build status.
  testEngine(false);

  // IndexedDB-backed project archive and current project parsing.
  $('pickProject').addEventListener('click', () => $('projectInput').click());
  $('projectInput').addEventListener('change', e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) loadProject(file); });
  $('clearProject').addEventListener('click', clearProject);
  async function loadProject(file, opts = {}) {
    if (!file?.name?.toLowerCase().endsWith('.zip')) return toast('Pilih file ZIP project.');
    if (!Number.isFinite(file.size) || file.size < 1) return toast('File ZIP kosong atau tidak terbaca.');
    if (file.size > 40 * 1024 * 1024) return toast('Batas ZIP NexaBuild adalah 40 MiB agar sesuai batas upload GitHub Actions. Kurangi ukuran project lalu pilih ulang.');
    const loadSequence = ++projectLoadSequence;
    currentZip = null; fileEntries = []; indexEntry = null;
    if (!opts.projectId) {
      packageIdEdited = false;
      $('appName').value = ''; $('appId').value = '';
      $('appVersion').value = '1.0.0'; $('appVersionCode').value = '1';
      if (customIcon) { URL.revokeObjectURL(customIcon); customIcon = null; }
      iconFile = null; $('iconInput').value = '';
      $('appIconPreview').innerHTML = icon('build');
    }
    currentFile = file;
    currentProjectId = opts.projectId || `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (!$('appName').value.trim()) { $('appName').value = String(file.name || 'Nexa App').replace(/\.zip$/i, '').replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).slice(0, 40) || 'Nexa App'; }
    if (!$('appId').value.trim() || !packageIdEdited) $('appId').value = generatedId($('appName').value);
    previewReviewed = false;
    $('projectInput').value = '';
    $('selectedProject').classList.remove('hidden');
    $('selectedName').textContent = file.name;
    $('selectedDetails').textContent = `${humanSize(file.size)} · ZIP dipilih`;
    $('projectClassification').classList.add('hidden');
    $('previewProject').disabled = true;
    $('buildActionStatus').textContent = 'Membaca struktur ZIP…';
    updateBuildReadiness();
    await saveProjectFile(currentProjectId, file, { source: opts.source || 'local', originalName: file.name });
    if (loadSequence !== projectLoadSequence) return;
    try {
      if (!window.JSZip) throw new Error('Library ZIP belum tersedia. Periksa internet dan muat ulang dashboard.');
      currentZip = await JSZip.loadAsync(file, { checkCRC32: false });
      if (loadSequence !== projectLoadSequence) return;
      fileEntries = Object.values(currentZip.files).filter(entry => !entry.dir).sort((a,b) => a.name.localeCompare(b.name));
      validateArchiveEntries(fileEntries);
      indexEntry = chooseIndexEntry(fileEntries);
      detectedType = detectProjectType(fileEntries, currentZip);
      $('projectType').textContent = detectedType.toUpperCase();
      $('projectFileCount').textContent = `${fileEntries.length} file`;
      $('projectClassification').classList.remove('hidden');
      $('previewProject').disabled = false;
      $('buildActionStatus').textContent = indexEntry ? 'Preview dulu; setelah itu build bisa dimulai.' : 'Project terpilih. Preview browser mungkin tidak tersedia untuk tipe native.';
      $('previewBadge').textContent = detectedType.toUpperCase().slice(0, 18);
      toast(`Project terbaca: ${fileEntries.length} file.`);
    } catch (error) {
      if (loadSequence !== projectLoadSequence) return;
      currentZip = null; fileEntries = []; indexEntry = null; detectedType = 'ZIP belum terbaca';
      $('selectedDetails').textContent = `${humanSize(file.size)} · ZIP belum terbaca`;
      $('buildActionStatus').textContent = 'ZIP tidak dapat diperiksa. Pilih arsip lain.';
      toast(error.message, 4500);
    }
    updateBuildReadiness();
  }
  function clearProject() {
    projectLoadSequence++;
    currentFile = null; currentProjectId = null; currentZip = null; fileEntries = []; indexEntry = null; detectedType = 'Belum diketahui'; previewReviewed = false;
    $('selectedProject').classList.add('hidden'); $('projectClassification').classList.add('hidden'); $('previewProject').disabled = true; $('projectInput').value = '';
    $('buildActionStatus').textContent = 'Pilih ZIP dan selesaikan preview untuk melanjutkan.';
    $('reviewGate').classList.remove('done'); $('reviewGate').innerHTML = `${icon('alert')}<span>Preview project dulu sebelum build APK.</span>`;
    updateBuildReadiness();
  }
  function humanSize(bytes) { if (bytes < 1024) return `${bytes} B`; if (bytes < 1048576) return `${(bytes/1024).toFixed(1)} KB`; return `${(bytes/1048576).toFixed(2)} MB`; }

  function validateArchiveEntries(entries) {
    const maxFiles = 10000, maxTotal = 160 * 1024 * 1024, maxSingle = 80 * 1024 * 1024, maxRatio = 500;
    if (!Array.isArray(entries) || entries.length < 1) throw new Error('ZIP tidak memiliki file yang dapat digunakan.');
    if (entries.length > maxFiles) throw new Error(`ZIP berisi lebih dari ${maxFiles.toLocaleString('id-ID')} file. Kurangi jumlah file sebelum upload.`);
    let total = 0; const seen = new Set();
    for (const entry of entries) {
      const raw = String(entry.unsafeOriginalName || entry.name || '').replace(/\\/g, '/');
      const parts = raw.split('/');
      if (!raw || raw.startsWith('/') || /^[A-Za-z]:/.test(raw) || parts.some(part => part === '..') || /[\x00-\x1f]/.test(raw)) {
        throw new Error(`ZIP berisi path file yang tidak aman: ${raw.slice(0, 100) || '(kosong)'}. Kompres ulang hanya folder project yang diperlukan.`);
      }
      const key = raw.toLocaleLowerCase();
      if (seen.has(key)) throw new Error(`ZIP memiliki nama file duplikat: ${raw.slice(0, 100)}.`);
      seen.add(key);
      const uncompressed = Number(entry._data?.uncompressedSize ?? 0);
      const compressed = Number(entry._data?.compressedSize ?? 0);
      if (Number.isFinite(uncompressed) && uncompressed > maxSingle) throw new Error(`File ${raw.slice(0, 80)} melebihi batas 80 MiB setelah diekstrak.`);
      if (Number.isFinite(uncompressed)) total += uncompressed;
      if (uncompressed > 1024 * 1024 && compressed > 0 && uncompressed / compressed > maxRatio) throw new Error(`Rasio kompresi file ${raw.slice(0, 80)} tidak wajar. ZIP ditolak untuk mencegah arsip berbahaya.`);
      const permission = typeof entry.unixPermissions === 'number' ? entry.unixPermissions : (entry.unixPermissions ? parseInt(String(entry.unixPermissions), 8) : 0);
      const kind = Number.isFinite(permission) ? permission & 0o170000 : 0;
      if (kind && kind !== 0o100000) throw new Error(`ZIP berisi file khusus atau symbolic link yang tidak didukung: ${raw.slice(0, 80)}.`);
    }
    if (total > maxTotal) throw new Error('Total isi ZIP setelah diekstrak melebihi 160 MiB. Kurangi aset besar sebelum upload.');
  }

  function cleanPath(path) {
    const parts = [];
    for (const part of String(path).replace(/\\/g, '/').split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') parts.pop(); else parts.push(part);
    }
    return parts.join('/');
  }
  function chooseIndexEntry(entries) {
    const candidates = entries.filter(entry => /(^|\/)index\.html?$/i.test(entry.name));
    const names = entries.map(entry => cleanPath(entry.name).toLowerCase());
    const frameworkMarkers = ['vite.config.js','vite.config.ts','vite.config.mjs','vite.config.mts','next.config.js','next.config.mjs','next.config.ts','angular.json','nuxt.config.js','nuxt.config.ts','vue.config.js','svelte.config.js','webpack.config.js','webpack.config.ts'];
    const hasFrameworkSource = names.some(name => frameworkMarkers.some(marker => name.split('/').pop() === marker));
    const outputFolders = ['dist','build','www','out'];
    const built = candidates.filter(entry => {
      const parts = cleanPath(entry.name).toLowerCase().split('/');
      return parts.at(-1) === 'index.html' && parts.slice(0, -1).some(part => outputFolders.includes(part));
    });
    // Include Angular's dist/<app>/browser/index.html and other nested static exports.
    // Preview and upload use the same output-folder priority to avoid preview/build drift.
    const rankBuilt = entry => {
      const parts = cleanPath(entry.name).toLowerCase().split('/');
      const folderIndex = parts.findIndex(part => outputFolders.includes(part));
      const priority = outputFolders.indexOf(parts[folderIndex]);
      const nestedDepth = Math.max(0, parts.length - folderIndex - 2);
      return priority * 10000 + nestedDepth * 100 + folderIndex;
    };
    if (hasFrameworkSource && built.length) return built.sort((a,b) => rankBuilt(a)-rankBuilt(b))[0] || null;
    if (hasFrameworkSource) return null;
    const rank = entry => {
      const name = cleanPath(entry.name).toLowerCase();
      if (name === 'index.html') return 0;
      if (name === 'www/index.html') return 1;
      if (name === 'dist/index.html') return 2;
      if (name === 'build/index.html') return 3;
      if (name === 'public/index.html') return 4;
      return 20 + entry.name.split('/').length;
    };
    return candidates.sort((a,b) => rank(a)-rank(b))[0] || null;
  }
  function detectProjectType(entries, zip) {
    const names = entries.map(entry => entry.name.toLowerCase());
    const has = suffix => names.some(name => name.endsWith(suffix));
    if (has('pubspec.yaml')) return 'Flutter';
    if (has('settings.gradle') || has('settings.gradle.kts') || names.some(name => /androidmanifest\.xml$/.test(name))) return 'Android / Gradle';
    const packageEntry = entries.find(entry => /(^|\/)package\.json$/i.test(entry.name));
    if (packageEntry) {
      const rawMaybe = zip.file(packageEntry.name);
      // Package JSON read is asynchronous; static hint is upgraded when build ZIP is prepared.
      return 'Web / JavaScript';
    }
    if (names.some(name => name.endsWith('index.js') || name.endsWith('index.tsx')) && names.some(name => name.includes('react-native'))) return 'React Native';
    if (indexEntry) return 'Website / HTML';
    return 'Project ZIP';
  }
  function resolvePath(ref, baseDir, map) {
    if (!ref || /^(data:|blob:|https?:|\/\/|#|mailto:|tel:|javascript:)/i.test(ref)) return ref;
    const cleanRef = ref.split(/[?#]/)[0];
    let decoded = cleanRef; try { decoded = decodeURIComponent(cleanRef); } catch {}
    const candidates = [cleanPath(`${baseDir ? baseDir + '/' : ''}${decoded}`), cleanPath(decoded), cleanPath(`www/${decoded}`), cleanPath(`dist/${decoded}`)];
    for (const candidate of candidates) if (map.has(candidate)) return map.get(candidate) + ref.slice(cleanRef.length);
    return ref;
  }
  function rewriteCss(css, baseDir, map) {
    return String(css || '').replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (full, quote, ref) => `url("${resolvePath(ref, baseDir, map).replace(/"/g, '%22')}")`);
  }
  async function makeFullScreenPreview() {
    closeOverlay('githubOverlay');
    openOverlay('previewOverlay');
    $('previewFileLabel').textContent = currentFile?.name || 'Pratinjau project';
    $('nativePreviewFallback').classList.add('hidden'); $('previewFrame').style.display = 'block'; $('previewFrame').src = 'about:blank';
    cleanupPreviewUrls();
    if (!currentZip || !indexEntry) {
      $('previewFrame').style.display = 'none';
      const sourceFramework = fileEntries.some(entry => /(^|\/)(vite\.config\.(js|ts|mjs|mts)|next\.config\.(js|mjs|ts)|angular\.json|nuxt\.config\.(js|ts)|vue\.config\.js|svelte\.config\.js|webpack\.config\.(js|ts))$/i.test(cleanPath(entry.name)));
      $('fallbackExplanation').textContent = !currentZip ? 'ZIP belum dapat dibaca. Kembali dan pilih arsip ZIP yang valid.' : sourceFramework ? 'Project ini berisi source framework, tetapi belum ada folder hasil build. Jalankan build website lalu unggah ZIP yang berisi dist/, build/, www/, atau out/. Preview source tidak ditampilkan agar yang kamu periksa sama dengan file yang nanti dikirim ke Android.' : 'ZIP tidak berisi index.html. Ini umum pada project Android native atau Flutter. Browser tidak bisa menampilkan aplikasi terinstal langsung; kamu bisa menyatakan telah memeriksa arsip untuk melanjutkan ke build.';
      $('fallbackReviewed').disabled = !currentZip;
      $('nativePreviewFallback').classList.remove('hidden');
      return;
    }
    try {
      const map = new Map();
      // Build a local blob map so relative assets in static web previews can be resolved.
      for (const entry of fileEntries) {
        const normalized = cleanPath(entry.name);
        const extension = (normalized.split('.').pop() || '').toLowerCase();
        const mime = ({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',svg:'image/svg+xml',ico:'image/x-icon',css:'text/css',js:'text/javascript',mjs:'text/javascript',json:'application/json',woff:'font/woff',woff2:'font/woff2',ttf:'font/ttf',otf:'font/otf',mp4:'video/mp4',webm:'video/webm',mp3:'audio/mpeg',wasm:'application/wasm'}[extension] || 'application/octet-stream');
        try { const blob = await entry.async('blob'); const url = URL.createObjectURL(new Blob([blob], { type: mime })); map.set(normalized, url); assetUrls.push(url); } catch {}
      }
      const baseDir = indexEntry.name.includes('/') ? indexEntry.name.slice(0, indexEntry.name.lastIndexOf('/')) : '';
      const source = await indexEntry.async('string');
      const doc = new DOMParser().parseFromString(source, 'text/html');
      doc.querySelectorAll('base').forEach(node => node.remove());
      for (const link of [...doc.querySelectorAll('link[rel="stylesheet"][href]')]) {
        const href = link.getAttribute('href');
        const cssPath = cleanPath(`${baseDir ? baseDir + '/' : ''}${href.split(/[?#]/)[0]}`);
        const cssEntry = fileEntries.find(entry => cleanPath(entry.name) === cssPath) || fileEntries.find(entry => cleanPath(entry.name) === cleanPath(href));
        if (cssEntry) {
          let css = await cssEntry.async('string');
          const cssBase = cssEntry.name.includes('/') ? cssEntry.name.slice(0, cssEntry.name.lastIndexOf('/')) : '';
          css = rewriteCss(css, cssBase, map);
          const cssUrl = URL.createObjectURL(new Blob([css], { type: 'text/css' }));
          assetUrls.push(cssUrl); link.setAttribute('href', cssUrl);
        } else link.setAttribute('href', resolvePath(href, baseDir, map));
      }
      doc.querySelectorAll('[src],[href],[poster]').forEach(node => {
        ['src','href','poster'].forEach(attr => {
          if (!node.hasAttribute(attr)) return;
          const value = node.getAttribute(attr);
          if (attr === 'href' && node.tagName === 'A' && !/\.(css|js|mjs|png|jpe?g|svg|webp|ico|woff2?|ttf|otf)([?#]|$)/i.test(value || '')) return;
          node.setAttribute(attr, resolvePath(value, baseDir, map));
        });
      });
      doc.querySelectorAll('style').forEach(node => { node.textContent = rewriteCss(node.textContent, baseDir, map); });
      doc.querySelectorAll('[style]').forEach(node => node.setAttribute('style', rewriteCss(node.getAttribute('style'), baseDir, map)));
      doc.querySelectorAll('[srcset]').forEach(node => node.setAttribute('srcset', node.getAttribute('srcset').split(',').map(part => { const bits = part.trim().split(/\s+/); bits[0] = resolvePath(bits[0], baseDir, map); return bits.join(' '); }).join(', ')));
      const documentHtml = '<!doctype html>\n' + doc.documentElement.outerHTML;
      previewUrl = URL.createObjectURL(new Blob([documentHtml], { type: 'text/html' })); assetUrls.push(previewUrl);
      $('previewFrame').src = previewUrl;
    } catch (error) {
      $('previewFrame').style.display = 'none';
      $('fallbackExplanation').textContent = `Preview gagal dipersiapkan: ${error.message}. Project tetap bisa diperiksa secara manual.`;
      $('nativePreviewFallback').classList.remove('hidden');
    }
  }
  function cleanupPreviewUrls() { if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = null; assetUrls.forEach(url => URL.revokeObjectURL(url)); assetUrls = []; }
  $('previewProject').addEventListener('click', makeFullScreenPreview);
  $('closePreview').addEventListener('click', completePreview);
  $('finishPreview').addEventListener('click', completePreview);
  $('fallbackBack').addEventListener('click', completePreview);
  $('fallbackReviewed').addEventListener('click', completePreview);
  function completePreview() {
    closeOverlay('previewOverlay'); previewReviewed = true;
    $('reviewGate').classList.add('done'); $('reviewGate').innerHTML = `${icon('check')}<span>Preview sudah diperiksa. Build APK bisa dilanjutkan.</span>`;
    $('buildActionStatus').textContent = currentFile ? 'Preview selesai. Siap mengatur identitas dan build.' : 'Pilih ZIP dan selesaikan preview untuk melanjutkan.';
    updateBuildReadiness(); showView('build'); toast('Preview selesai. Build APK sudah dibuka.');
  }
  function updateBuildReadiness() {
    const ready = Boolean(currentFile && currentZip && previewReviewed);
    $('startBuild').disabled = !ready;
    $('buildActionStatus').textContent = ready ? 'Project diperiksa. Konfigurasi sudah bisa dikirim ke engine.' : (!currentFile ? 'Pilih ZIP dan selesaikan preview untuk melanjutkan.' : (!previewReviewed ? 'Preview project dulu; setelah kembali, tombol build aktif.' : 'ZIP belum siap.'));
  }

  // Import a public repository using GitHub's REST API and archive endpoint. No PAT is stored in browser code.
  $('connectGithub').addEventListener('click', importPublicRepository);
  async function importPublicRepository() {
    const rawUrl = $('githubRepoUrl').value.trim();
    const branchInput = $('githubBranch').value.trim();
    const match = rawUrl.match(/^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)(?:\.git)?(?:\/.*)?$/i);
    if (!match) { $('githubMessage').textContent = 'Masukkan URL repository GitHub yang valid.'; return; }
    const owner = match[1], repo = match[2].replace(/\.git$/i, '');
    const button = $('connectGithub'); button.disabled = true; button.textContent = 'MENGAMBIL REPOSITORY…'; $('githubMessage').textContent = 'Memeriksa repository publik…';
    try {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 25000);
      const metaResponse = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { headers: { Accept: 'application/vnd.github+json' }, signal: controller.signal, cache: 'no-store' });
      clearTimeout(timer);
      if (metaResponse.status === 404) throw new Error('Repository tidak ditemukan atau bersifat privat. Untuk repository privat, OAuth backend perlu dipasang terlebih dahulu.');
      if (metaResponse.status === 403) throw new Error('GitHub API membatasi permintaan sementara. Coba lagi nanti.');
      if (!metaResponse.ok) throw new Error(`GitHub API HTTP ${metaResponse.status}`);
      const metadata = await metaResponse.json();
      if (metadata.private) throw new Error('Repository privat memerlukan OAuth/backend. Jangan tempel token GitHub pribadi di halaman ini.');
      const branch = branchInput || metadata.default_branch || 'main';
      const zipUrl = `https://codeload.github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/zip/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`;
      const zipResponse = await fetch(zipUrl, { cache: 'no-store' });
      if (!zipResponse.ok) throw new Error(`Tidak dapat mengunduh branch '${branch}' (HTTP ${zipResponse.status}). Periksa nama branch.`);
      const blob = await zipResponse.blob();
      if (!blob.size) throw new Error('GitHub menghasilkan arsip kosong.');
      const file = new File([blob], `${repo}-${branch.replace(/[^a-zA-Z0-9._-]/g,'_')}.zip`, { type: 'application/zip', lastModified: Date.now() });
      closeOverlay('githubOverlay'); showView('build'); await loadProject(file, { source: 'github-public' });
      $('githubMessage').textContent = `Berhasil mengambil ${owner}/${repo} (${branch}).`;
      toast('Repository publik berhasil diimpor.');
    } catch (error) {
      $('githubMessage').textContent = error.message || 'Gagal mengakses GitHub.';
    } finally { button.disabled = false; button.innerHTML = `AMBIL PROJECT ${icon('arrow')}`; }
  }

  // Only package a real web output. NexaBuild never runs user-supplied npm scripts
  // in the builder repository; this prevents token exfiltration and avoids guaranteed
  // failures when a framework source ZIP has no compiled dist/ folder.
  async function prepareUploadArchive() {
    if (!currentZip || !currentFile) throw new Error('Pilih ZIP project terlebih dahulu.');
    const typeHint = detectProjectType(fileEntries, currentZip);
    const paths = fileEntries.map(entry => cleanPath(entry.name));
    const hasNative = paths.some(path => /(^|\/)settings\.gradle(\.kts)?$/i.test(path) || /(^|\/)pubspec\.yaml$/i.test(path) || /(^|\/)AndroidManifest\.xml$/i.test(path)) || typeHint === 'React Native';
    const selectedName = $('appName').value.trim() || String(currentFile.name).replace(/\.zip$/i, '');
    const selectedId = $('appId').value.trim() || generatedId(selectedName);
    if (hasNative) return { blob: currentFile, name: currentFile.name, type: typeHint, transformed: false, metadataApplied: false };

    const packageEntry = fileEntries.filter(entry => /(^|\/)package\.json$/i.test(cleanPath(entry.name))).sort((a,b) => a.name.split('/').length - b.name.split('/').length)[0] || null;
    const packageBase = packageEntry ? cleanPath(packageEntry.name).replace(/\/package\.json$/i, '') : '';
    const prefix = packageBase ? `${packageBase}/` : '';
    let packageJson = null;
    if (packageEntry) {
      try { packageJson = JSON.parse(await packageEntry.async('string')); }
      catch { packageJson = null; /* Static HTML can still be packaged when optional package metadata is malformed. */ }
      if (packageJson.dependencies?.['react-native'] || packageJson.devDependencies?.['react-native']) {
        return { blob: currentFile, name: currentFile.name, type: 'React Native', transformed: false, metadataApplied: false };
      }
    }

    const frameworkNames = new Set(['vite.config.js','vite.config.ts','vite.config.mjs','vite.config.mts','next.config.js','next.config.mjs','next.config.ts','angular.json','nuxt.config.js','nuxt.config.ts','vue.config.js','svelte.config.js','webpack.config.js','webpack.config.ts']);
    const hasFrameworkSource = paths.some(path => frameworkNames.has(path.split('/').pop().toLowerCase()));
    const builtCandidates = ['dist/index.html','build/index.html','www/index.html','out/index.html'];
    const outputFolders = ['dist','build','www','out'];
    const builtPaths = paths.map(path => prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path).filter(path => {
      const parts = cleanPath(path).toLowerCase().split('/');
      return parts.at(-1) === 'index.html' && parts.slice(0, -1).some(part => outputFolders.includes(part));
    }).sort((a,b) => {
      const rank = path => { const parts = cleanPath(path).toLowerCase().split('/'); const folderIndex = parts.findIndex(part => outputFolders.includes(part)); return outputFolders.indexOf(parts[folderIndex]) * 10000 + Math.max(0, parts.length-folderIndex-2) * 100 + folderIndex; };
      return rank(a)-rank(b);
    });
    let chosenPath = null;

    const capJsonPath = `${prefix}capacitor.config.json`;
    const capEntry = fileEntries.find(entry => cleanPath(entry.name) === capJsonPath);
    if (capEntry) {
      try {
        const config = JSON.parse(await capEntry.async('string'));
        const webDir = String(config.webDir || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        if (webDir && paths.includes(`${prefix}${webDir}/index.html`)) chosenPath = `${prefix}${webDir}/index.html`;
      } catch { throw new Error('capacitor.config.json tidak valid. Periksa nilai webDir dan JSON konfigurasi.'); }
    }
    if (!chosenPath) {
      const directOutput = builtCandidates.find(candidate => paths.includes(`${prefix}${candidate}`));
      if (directOutput) chosenPath = `${prefix}${directOutput}`;
      else if (builtPaths.length) chosenPath = `${prefix}${builtPaths[0]}`;
    }
    if (hasFrameworkSource && !chosenPath) {
      throw new Error('ZIP berisi source framework (Vite/React/Vue/Angular), bukan hasil build. Jalankan build website lebih dahulu lalu unggah folder output dist/, build/, www/, atau out/. NexaBuild tidak menjalankan npm scripts dari ZIP upload demi keamanan token GitHub.');
    }
    if (!chosenPath) {
      const preferred = ['index.html','www/index.html','dist/index.html','build/index.html','public/index.html','out/index.html'];
      const match = preferred.find(path => paths.includes(`${prefix}${path}`));
      chosenPath = match ? `${prefix}${match}` : (indexEntry ? cleanPath(indexEntry.name) : null);
    }
    if (!chosenPath) throw new Error('ZIP tidak memiliki index.html atau output website yang dikenali. Untuk Android/Flutter native, gunakan project native lengkap; untuk website, sertakan index.html.');

    const chosenEntry = fileEntries.find(entry => cleanPath(entry.name) === chosenPath);
    if (!chosenEntry) throw new Error('File index.html hasil build tidak ditemukan. Periksa kembali folder output project.');
    const base = chosenPath.includes('/') ? chosenPath.slice(0, chosenPath.lastIndexOf('/')) : '';
    const output = new JSZip();
    const excludedPath = /(^|\/)(\.git|node_modules|\.idea|\.vscode|__MACOSX)(\/|$)/i;
    const excludedFiles = new Set(['package.json','capacitor.config.json','capacitor.config.ts','vite.config.js','vite.config.ts','vite.config.mjs','vite.config.mts','next.config.js','next.config.mjs','next.config.ts','angular.json','nuxt.config.js','nuxt.config.ts','vue.config.js','svelte.config.js','webpack.config.js','webpack.config.ts']);
    let copied = 0;
    for (const entry of fileEntries) {
      const path = cleanPath(entry.name);
      if (excludedPath.test(path) || !path) continue;
      if (base && !path.startsWith(base + '/') && path !== base) continue;
      const relative = base ? path.slice(base.length).replace(/^\//, '') : path;
      if (!relative || excludedFiles.has(relative.toLowerCase())) continue;
      output.file(relative, await entry.async('uint8array'));
      copied++;
    }
    if (!output.file('index.html')) throw new Error('Tidak dapat menyiapkan index.html untuk build. Pastikan ZIP berisi folder output website yang benar.');
    const blob = await output.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 5 } });
    return { blob, name: `${slugName(selectedName.toLowerCase())}-prepared.zip`, type: `${typeHint} (static website output)`, transformed: true, metadataApplied: true, copiedFiles: copied };
  }
  function slugName(value) {
    return String(value || 'nexa-app').toLowerCase().normalize('NFKD').replace(/[^a-z0-9-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,48) || 'nexa-app';
  }
  function validateIdentity() {
    const name = $('appName').value.trim(); const id = $('appId').value.trim(); const version = $('appVersion').value.trim(); const versionCode = Number($('appVersionCode').value);
    if (!name || name.length > 48 || /[<>\x00-\x1f]/.test(name)) { toast('Nama aplikasi wajib 1–48 karakter dan tidak boleh memuat karakter kontrol.'); $('appName').focus(); return false; }
    if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(id)) { toast('Application ID tidak valid. Contoh: com.nexa.app'); $('appId').focus(); return false; }
    if (!/^\d+(\.\d+){0,3}$/.test(version) || version.length > 24) { toast('Format versi tidak valid (maksimum 24 karakter). Contoh 1.0.0'); $('appVersion').focus(); return false; }
    if (!Number.isInteger(versionCode) || versionCode < 1 || versionCode > 2100000000) { toast('Version code harus bilangan bulat 1–2.100.000.000.'); $('appVersionCode').focus(); return false; }
    return true;
  }
  function generatedId(name) { let tail = String(name || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'').slice(0,38) || 'app'; if (!/^[a-z]/.test(tail)) tail = `app${tail}`; return `com.nexa.${tail.slice(0,38)}`; }
  let packageIdEdited = false;
  $('appName').addEventListener('input', () => { if (!packageIdEdited) $('appId').value = generatedId($('appName').value); });
  $('appId').addEventListener('input', () => { packageIdEdited = true; });
  $('iconInput').addEventListener('change', e => {
    const file = e.target.files?.[0]; if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { toast('Pilih PNG, JPG, atau WEBP.'); return; }
    if (customIcon) URL.revokeObjectURL(customIcon);
    customIcon = URL.createObjectURL(file); iconFile = file;
    const img = document.createElement('img'); img.src = customIcon; $('appIconPreview').replaceChildren(img);
  });
  async function getAppIconDataUrl() {
    if (iconFile) {
      if (!/^image\/(png|jpeg|webp)$/.test(iconFile.type)) throw new Error('Ikon harus PNG, JPG, atau WEBP.');
      if (iconFile.size > 12 * 1024 * 1024) throw new Error('Ukuran ikon maksimum 12 MB sebelum optimasi.');
      const objectUrl = URL.createObjectURL(iconFile);
      try {
        const image = new Image();
        image.decoding = 'async';
        image.src = objectUrl;
        await (image.decode ? image.decode() : new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; }));
        const canvas = document.createElement('canvas');
        const side = 256;
        canvas.width = side; canvas.height = side;
        const ctx = canvas.getContext('2d', { alpha: true });
        if (!ctx) throw new Error('Browser tidak dapat mengoptimalkan ikon.');
        const scale = Math.min(side / image.naturalWidth, side / image.naturalHeight);
        const width = Math.max(1, Math.round(image.naturalWidth * scale));
        const height = Math.max(1, Math.round(image.naturalHeight * scale));
        ctx.clearRect(0, 0, side, side);
        ctx.drawImage(image, Math.round((side - width) / 2), Math.round((side - height) / 2), width, height);
        const webp = canvas.toDataURL('image/webp', 0.9);
        return webp.startsWith('data:image/webp;base64,') ? webp : canvas.toDataURL('image/png');
      } finally { URL.revokeObjectURL(objectUrl); }
    }
    // Default icon is generated as PNG, not SVG: Pillow in the Android workflow
    // cannot decode SVG, and a failed icon conversion used to fail every default build.
    const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 256;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Browser tidak dapat membuat ikon default.');
    ctx.fillStyle = '#d8ff42'; ctx.fillRect(0, 0, 256, 256);
    ctx.strokeStyle = '#171717'; ctx.lineWidth = 12; ctx.strokeRect(8, 8, 240, 240);
    ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#171717'; ctx.lineWidth = 5; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(55, 196); ctx.lineTo(55, 60); ctx.lineTo(84, 60); ctx.lineTo(172, 153); ctx.lineTo(172, 60); ctx.lineTo(201, 60); ctx.lineTo(201, 196); ctx.lineTo(173, 196); ctx.lineTo(84, 103); ctx.lineTo(84, 196); ctx.closePath(); ctx.fill(); ctx.stroke();
    return canvas.toDataURL('image/png');
  }
  function loadIdentityFromHistory(item) {
    $('appName').value = item.appName || '';
    $('appId').value = item.appId || generatedId(item.appName || 'Nexa App');
    $('appVersion').value = item.version || '1.0.0';
    $('appVersionCode').value = item.versionCode || '1';
    packageIdEdited = true;
  }

  // Engine API integration: POST /api/upload (multipart field "zip"), GET /api/status/{jobId}, SSE /api/logs/{jobId}/stream, GET /api/download/{jobId}.
  // The public API accepts ZIP + optional permissions. For compatible web projects without their own Capacitor config, prepareUploadArchive embeds app name/ID in an adapter config; version/code and launcher icon still require engine-side support.
  let jobStarted = false;
  $('startBuild').addEventListener('click', startRealBuild);

  async function startRealBuild() {
    if (!currentFile || !currentZip) return toast('Pilih ZIP project terlebih dahulu.');
    if (!previewReviewed) return toast('Preview project terlebih dahulu.');
    prepareNameOnFile();
    if (!validateIdentity()) return;
    if (jobStarted) return;

    const button = $('startBuild');
    button.disabled = true;
    button.innerHTML = `MENYIAPKAN ZIP… ${icon('build')}`;
    let prepared;
    try {
      prepared = await prepareUploadArchive();
      if (prepared.transformed && window.NexaRevision?.hasConnection?.() && prepared.blob.size > 40 * 1024 * 1024) {
        throw new Error(`Arsip siap build berukuran ${humanSize(prepared.blob.size)}. Batas upload GitHub Actions NexaBuild adalah 40 MiB. Kurangi aset besar (terutama video) atau gunakan engine build eksternal.`);
      }
    } catch (error) {
      button.innerHTML = `BUILD APK ${icon('arrow')}`;
      updateBuildReadiness();
      toast(error.message, 5000);
      return;
    }

    // Icon conversion can fail on low-memory/mobile browsers. Guard it before
    // creating a job so a rejected decode/canvas operation never leaves the
    // Build button disabled or creates a half-saved history record.
    let iconDataUrl;
    try {
      iconDataUrl = await getAppIconDataUrl();
      if (!/^data:image\/(?:png|webp);base64,/.test(iconDataUrl)) throw new Error('Format ikon hasil optimasi tidak valid.');
    } catch (error) {
      button.innerHTML = `BUILD APK ${icon('arrow')}`;
      updateBuildReadiness();
      toast(error?.message || 'Ikon aplikasi tidak dapat diproses. Pilih PNG, JPG, atau WEBP yang valid.', 5000);
      return;
    }

    const record = {
      id: (globalThis.crypto?.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); })),
      jobId: null,
      projectId: currentProjectId,
      filename: currentFile.name,
      uploadFilename: prepared.name,
      appName: $('appName').value.trim(),
      appId: $('appId').value.trim(),
      version: $('appVersion').value.trim(),
      versionCode: String($('appVersionCode').value),
      detectedType: detectedType,
      prepared: prepared.transformed,
      metadataApplied: Boolean(prepared.metadataApplied),
      status: 'submitting',
      createdAt: Date.now(),
      startedAt: Date.now(),
      engineUrl,
      error: null,
      downloadUrl: null,
      progress: null,
      iconDataUrl,
      buildOptions: { internetMode: $('internetMode')?.value || 'online', camera: !!$('cameraPermission')?.checked, wakeLock: !!$('wakeLock')?.checked, vibrate: !!$('vibratePermission')?.checked }
    };
    activeHistoryId = record.id;
    currentJob = record;
    jobStarted = true;
    saveHistoryRecord(record);
    showView('lab');
    resetLab(record);
    setLabState('connecting', 'MENGHUBUNGKAN ENGINE', 'Memeriksa layanan build…', null);
    $('terminalProjectName').textContent = prepared.name;
    addLog('Memeriksa ketersediaan engine…', 'info');

    try {
      if (prepared.transformed && window.NexaRevision?.hasConnection?.()) {
        addLog('Project web terdeteksi. Mengirim arsip ke GitHub Actions untuk build APK.', 'info');
        await window.NexaRevision.runGithubBuild({ record, prepared, addLog, setLabState, updateBuildSteps, startElapsedTimer, saveHistoryRecord, renderResults, setFinished: () => { jobStarted = false; } });
        return;
      }
      const healthResponse = await fetchWithTimeout(`${engineUrl}/api/health`, { cache: 'no-store' }, 20000);
      if (!healthResponse.ok) throw new Error(`Health endpoint HTTP ${healthResponse.status}`);
      const health = await healthResponse.json();
      if (health.ok !== true) throw new Error('Health check tidak mengembalikan ok:true');
      addLog('Engine merespons. Mengirim ZIP project.', 'success');
      const form = new FormData();
      form.append('zip', prepared.blob, prepared.name);
      if (prepared.metadataApplied) {
        addLog('Nama aplikasi dan Application ID disiapkan untuk wrapper Capacitor project web.', 'success');
        addLog('Versi, version code, dan ikon launcher tetap bergantung pada kemampuan adapter engine; tidak akan diklaim terpasang jika engine tidak mendukungnya.', 'info');
      } else {
        addLog('Project/config native atau Capacitor sendiri dipertahankan. Metadata form tidak menimpa config sumber.', 'info');
      }
      const response = await fetchWithTimeout(`${engineUrl}/api/upload`, { method: 'POST', body: form, headers: engineHeaders({ Accept: 'application/json' }) }, 180000);
      let body = {};
      try { body = await response.json(); } catch {}
      if (!response.ok) {
        const message = body.detail || body.error || `Upload ditolak (HTTP ${response.status})`;
        if (response.status === 401) {
          openOverlay('engineOverlay');
          $('engineAuthDetails').open = true;
          $('engineAuthMessage').textContent = 'Engine meminta autentikasi. Gunakan akun layanan build ini, bukan password Google.';
          updateEngineAuthUi($('engineAuthMessage').textContent);
          throw new Error('Engine meminta login. Buka Pengaturan Engine untuk masuk atau daftar menggunakan akun layanan build.');
        }
        if (response.status === 429) throw new Error(body.detail || 'Batas permintaan build engine tercapai. Coba lagi nanti.');
        throw new Error(message);
      }
      const jobId = body.jobId || body.id;
      if (!jobId) throw new Error('Respons engine tidak menyertakan jobId.');
      record.jobId = String(jobId);
      record.status = 'validating';
      record.uploadedAt = Date.now();
      currentJob = record;
      saveHistoryRecord(record);
      addLog(`Job diterima: ${jobId}`, 'success');
      setLabState('queued', 'PROJECT DIKIRIM', 'Menunggu validasi server…', null);
      connectLiveLogs(jobId);
      startElapsedTimer(record.startedAt);
      pollJob(record.id, jobId);
    } catch (error) {
      const dispatchUncertain = error?.code === 'NEXA_DISPATCH_UNCERTAIN';
      record.status = dispatchUncertain ? 'dispatch_uncertain' : 'failed';
      record.error = error.message;
      if (error?.uploadRef) record.githubUploadRef = error.uploadRef;
      record.finishedAt = Date.now();
      saveHistoryRecord(record);
      setLabState(dispatchUncertain ? 'queued' : 'failed', dispatchUncertain ? 'MENUNGGU KONFIRMASI GITHUB' : 'BUILD BELUM DIMULAI', error.message, null);
      addLog(error.message, dispatchUncertain ? 'info' : 'error');
      $('labStatusChip').className = dispatchUncertain ? 'live-status' : 'live-status bad';
      $('labStatusChip').innerHTML = dispatchUncertain ? '<i></i> STATUS BELUM PASTI' : '<i></i> ENGINE / REQUEST GAGAL';
      $('labFootnote').textContent = dispatchUncertain
        ? 'Jangan kirim ulang sebelum memeriksa tab Actions. GitHub mungkin sudah menerima permintaan; branch upload tetap dipertahankan.'
        : 'Tidak ada APK yang dikonfirmasi untuk permintaan ini. Periksa koneksi, izin repository, dan log di atas.';
      $('terminalActions').classList.add('hidden'); $('downloadPanel')?.classList.add('hidden');
      jobStarted = false;
    } finally {
      button.innerHTML = `BUILD APK ${icon('arrow')}`;
      updateBuildReadiness();
    }
  }

  function resetLab(record) {
    if (eventStream) { try { eventStream.close(); } catch {} eventStream = null; }
    clearTimeout(pollHandle);
    clearInterval(clockHandle);
    $('terminalLogs').innerHTML = '';
    lineCount = 0;
    $('logLineCount').textContent = '0 LINES';
    $('terminalActions').classList.add('hidden');
    $('realProgressBar').style.width = '0%';
    $('progressNumber').textContent = '—';
    $('progressStageLabel').textContent = 'Status dari server';
    $('terminalState').className = 'state-pill';
    $('terminalState').textContent = 'CONNECTING';
    $('labStatusChip').className = 'live-status';
    $('labStatusChip').innerHTML = '<i></i> MENGHUBUNGKAN';
    $('terminalProjectName').textContent = record.filename;
    $('elapsedTime').textContent = '00:00';
    $('buildStepList').innerHTML = [
      ['Validasi project','WAITING'], ['Konfigurasi toolchain','WAITING'], ['Kompilasi Android','WAITING'], ['Menyiapkan APK','WAITING']
    ].map(([label,state]) => `<div class="step-line pending"><span class="step-icon">${icon('check')}</span><span>${label}</span><small>${state}</small></div>`).join('');
    $('labFootnote').textContent = 'Status dan persentase mengikuti server; tidak ada progres simulasi.';
    lastStatus = '';
  }
  function setLabState(state, title, stage, progress) {
    $('terminalMainStatus').textContent = title;
    $('terminalStage').textContent = stage || 'Status dari server.';
    const success = state === 'success';
    const failed = ['failed','stopped'].includes(state);
    $('terminalState').className = `state-pill ${success ? 'success' : failed ? 'failed' : ''}`;
    $('terminalState').textContent = String(state || 'unknown').replace(/_/g,' ').toUpperCase().slice(0,22);
    if (typeof progress === 'number' && Number.isFinite(progress)) {
      const clamped = Math.max(0, Math.min(100, progress));
      $('realProgressBar').style.width = `${clamped}%`;
      $('progressNumber').textContent = `${Math.round(clamped)}%`;
    } else if (success) {
      $('realProgressBar').style.width = '100%';
      $('progressNumber').textContent = '100%';
    } else $('progressNumber').textContent = '—';
    $('labStatusChip').className = `live-status ${success ? 'good' : failed ? 'bad' : ''}`;
    $('labStatusChip').innerHTML = `<i></i> ${success ? 'BUILD BERHASIL' : failed ? 'BUILD GAGAL' : `BUILD / ${String(state).toUpperCase()}`}`;
  }
  function addLog(message, type = 'info') {
    if (!message) return;
    const node = document.createElement('div');
    node.className = `log-line ${type}`;
    node.textContent = String(message).replace(/\x1b\[[0-9;]*m/g, '');
    $('terminalLogs').append(node);
    lineCount++;
    $('logLineCount').textContent = `${lineCount} LINES`;
    while ($('terminalLogs').childElementCount > 260) $('terminalLogs').firstElementChild.remove();
    $('terminalLogs').scrollTop = $('terminalLogs').scrollHeight;
  }
  function startElapsedTimer(startedAt) {
    clearInterval(clockHandle);
    const tick = () => {
      const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      $('elapsedTime').textContent = `${String(Math.floor(seconds / 60)).padStart(2,'0')}:${String(seconds % 60).padStart(2,'0')}`;
    };
    tick();
    clockHandle = setInterval(tick, 1000);
  }
  function parseEventData(raw) { try { return JSON.parse(raw); } catch { return raw; } }
  function connectLiveLogs(jobId) {
    if (eventStream) { try { eventStream.close(); } catch {} }
    try {
      const stream = new EventSource(engineQuery(`${engineUrl}/api/logs/${encodeURIComponent(jobId)}/stream`));
      eventStream = stream;
      stream.onmessage = event => {
        const value = parseEventData(event.data);
        addLog(typeof value === 'string' ? value : (value.message || value.line || JSON.stringify(value)), 'info');
      };
      stream.addEventListener('step', event => {
        const data = parseEventData(event.data);
        if (data.step) $('terminalStage').textContent = data.step;
        if (typeof data.progress === 'number') setLabState(currentJob?.status || 'building', 'BUILD SEDANG BERJALAN', data.step || '', data.progress);
      });
      stream.addEventListener('status', event => {
        const data = parseEventData(event.data);
        if (data.status && currentJob) { currentJob.status = data.status; saveHistoryRecord(currentJob); }
      });
      stream.addEventListener('queue', event => {
        const data = parseEventData(event.data);
        if (data.position != null) { $('terminalStage').textContent = `Antrean build · posisi ${data.position}`; addLog(`Posisi antrean: ${data.position}`, 'info'); }
      });
      stream.addEventListener('notice', event => {
        const data = parseEventData(event.data);
        addLog(`${data.title ? data.title + ': ' : ''}${data.message || JSON.stringify(data)}`, data.level === 'error' ? 'error' : 'info');
      });
      stream.addEventListener('done', event => {
        const data = parseEventData(event.data);
        addLog(`Stream menyatakan job ${data.status || 'selesai'}.`, data.status === 'success' ? 'success' : 'info');
      });
      stream.onerror = () => { /* Status polling remains the fallback */ };
    } catch (error) {
      addLog(`Streaming log tidak tersedia (${error.message}); status tetap dipantau melalui polling.`, 'info');
    }
  }
  async function pollJob(historyId, jobId) {
    clearTimeout(pollHandle);
    let attempts = 0;
    const poll = async () => {
      if (!currentJob || currentJob.id !== historyId) return;
      attempts++;
      try {
        const response = await fetchWithTimeout(`${engineUrl}/api/status/${encodeURIComponent(jobId)}`, { cache: 'no-store', headers: engineHeaders({ Accept: 'application/json' }) }, 20000);
        if (!response.ok) throw new Error(`Status endpoint HTTP ${response.status}`);
        const state = await response.json();
        const status = String(state.status || 'unknown').toLowerCase();
        currentJob.status = status;
        currentJob.error = state.error || null;
        currentJob.serverStep = state.step || null;
        if (typeof state.stepProgress === 'number') currentJob.progress = state.stepProgress;
        saveHistoryRecord(currentJob);
        const stage = state.step || state.message || (status === 'queued' ? 'Menunggu antrean build…' : 'Status diperbarui oleh server.');
        const terminal = ['success','failed','stopped'].includes(status);
        const title = status === 'success' ? 'APK BERHASIL DIBUAT' : status === 'failed' ? 'BUILD GAGAL' : status === 'stopped' ? 'BUILD DIHENTIKAN' : status === 'queued' ? 'MENUNGGU ANTREAN' : status === 'validating' ? 'VALIDASI PROJECT' : 'BUILD SEDANG BERJALAN';
        setLabState(status, title, stage, state.stepProgress);
        updateBuildSteps(stage, status);
        if (state.queuePosition != null && status === 'queued') $('terminalStage').textContent = `Antrean build · posisi ${state.queuePosition}`;
        if (Array.isArray(state.logs) && currentJob.lastServerLogCount !== state.logs.length) {
          const known = currentJob.lastServerLogCount || 0;
          state.logs.slice(known).forEach(item => {
            const text = typeof item === 'string' ? item : (item.message || JSON.stringify(item));
            addLog(text, /error|failed|exception/i.test(text) ? 'error' : 'info');
          });
          currentJob.lastServerLogCount = state.logs.length;
          saveHistoryRecord(currentJob);
        }
        if (terminal) {
          clearInterval(clockHandle);
          currentJob.finishedAt = Date.now();
          if (status === 'success' && state.downloadReady) {
            currentJob.downloadUrl = engineQuery(`${engineUrl}/api/download/${encodeURIComponent(jobId)}`);
            $('terminalActions').classList.remove('hidden'); $('downloadPanel')?.classList.remove('hidden');
            $('downloadApk').href = currentJob.downloadUrl; $('downloadFallback').href = currentJob.downloadUrl;
            $('downloadApk').setAttribute('download', 'app.apk');
            $('labFootnote').textContent = 'Server melaporkan build sukses dan artefak siap. Tekan Download APK untuk mengambil hasilnya.';
            addLog('Server mengonfirmasi APK tersedia untuk diunduh.', 'success');
          } else if (status === 'success') {
            $('labFootnote').textContent = 'Server melaporkan sukses, tetapi belum mengonfirmasi artefak. Periksa status lagi sebelum mengunduh.';
            addLog('Status sukses tetapi downloadReady tidak aktif.', 'error');
          } else {
            $('labFootnote').textContent = state.error || 'Build gagal. Baca log server untuk mengetahui penyebabnya.';
            if (state.error) addLog(state.error, 'error');
          }
          saveHistoryRecord(currentJob);
          renderResults();
          jobStarted = false;
          updateBuildReadiness();
          if (eventStream) { eventStream.close(); eventStream = null; }
          return;
        }
        if (attempts > 720) {
          addLog('Frontend berhenti polling setelah 30 menit. Job mungkin masih ada di server; muat ulang status melalui hasil.', 'error');
          jobStarted = false; clearInterval(clockHandle); return;
        }
      } catch (error) {
        addLog(`Gagal mengambil status: ${error.message}`, 'error');
        if (String(error.message).includes('HTTP 401')) {
          openOverlay('engineOverlay');
          $('engineAuthDetails').open = true;
          $('engineAuthMessage').textContent = 'Sesi engine ditolak atau sudah kedaluwarsa. Masuk kembali menggunakan akun layanan build.';
          updateEngineAuthUi($('engineAuthMessage').textContent);
          clearInterval(clockHandle);
          jobStarted = false;
          if (currentJob) { currentJob.status = 'auth_required'; currentJob.error = error.message; saveHistoryRecord(currentJob); }
          return;
        }
        if (attempts > 5 && currentJob) { currentJob.error = error.message; saveHistoryRecord(currentJob); }
      }
      pollHandle = setTimeout(poll, 2500);
    };
    poll();
  }
  function updateBuildSteps(stage, status) {
    const text = String(stage || '').toLowerCase();
    let active = 0;
    if (/validat|archive|extract|upload/.test(text)) active = 0;
    else if (/install|depend|config|setup|prepar|web asset|capacitor/.test(text)) active = 1;
    else if (/gradle|compile|flutter|assemble|build/.test(text)) active = 2;
    else if (/final|apk|artifact|done/.test(text)) active = 3;
    if (status === 'success') active = 4;
    const rows = [...$('buildStepList').querySelectorAll('.step-line')];
    rows.forEach((row, index) => {
      row.classList.toggle('done', index < active || status === 'success');
      row.classList.toggle('active', index === active && status !== 'success' && !['failed','stopped'].includes(status));
      row.classList.toggle('pending', index > active && status !== 'success');
      row.querySelector('small').textContent = status === 'success' || index < active ? 'SELESAI' : index === active ? 'BERJALAN' : 'MENUNGGU';
    });
  }

  // Local history stores actual API results. Original ZIPs stay in IndexedDB so “edit” means reconfigure the source project and build again.
  function readHistory() {
    try { const value = JSON.parse(storageGet(STORAGE.history) || '[]'); return Array.isArray(value) ? value : []; }
    catch { return []; }
  }
  function writeHistory(items) { storageSet(STORAGE.history, JSON.stringify(items.slice(0, 20))); }
  function saveHistoryRecord(record) {
    const items = readHistory();
    const updated = { ...record, updatedAt: Date.now() };
    const at = items.findIndex(item => item.id === updated.id);
    if (at >= 0) items[at] = { ...items[at], ...updated };
    else items.unshift(updated);
    try { writeHistory(items); } catch (error) { console.warn('Histori tidak bisa disimpan penuh:', error); }
    updateHistoryCount();
    window.NexaRevision?.syncBuildRecord?.(updated);
    return updated;
  }
  function updateHistoryCount() {
    const items = readHistory();
    const total = items.length;
    $('historyCount').textContent = total ? `${total} build tersimpan` : 'Belum ada aplikasi';
    if ($('buildTotalCount')) $('buildTotalCount').textContent = String(total);
    if ($('buildSuccessCount')) $('buildSuccessCount').textContent = String(items.filter(item => String(item.status).toLowerCase() === 'success').length);
  }
  function renderResults() {
    const items = readHistory();
    updateHistoryCount();
    const total = items.length, success = items.filter(item => String(item.status).toLowerCase() === 'success').length;
    if ($('buildTotalCount')) $('buildTotalCount').textContent = String(total);
    if ($('buildSuccessCount')) $('buildSuccessCount').textContent = String(success);
    if (!items.length) {
      $('resultsList').innerHTML = `<div class="empty-state glass"><span class="empty-state-icon">${icon('results')}</span><h2>Belum ada aplikasi yang dibuild</h2><p>Project yang sudah kamu coba build akan muncul di sini.</p><button class="primary-btn" data-results-new>MULAI BUILD ${icon('arrow')}</button></div>`;
      $('resultsList').querySelector('[data-results-new]').addEventListener('click', () => showView('build'));
      return;
    }
    $('resultsList').innerHTML = items.map(item => {
      const status = String(item.status || 'unknown').toLowerCase();
      const statusClass = status === 'success' ? 'success' : ['failed','stopped'].includes(status) ? 'failed' : 'running';
      const label = status === 'success' ? 'BERHASIL' : status === 'failed' ? 'GAGAL' : status === 'stopped' ? 'DIHENTIKAN' : status.toUpperCase();
      const when = new Date(item.createdAt || Date.now()).toLocaleString('id-ID');
      const thumb = item.iconDataUrl ? `<img src="${escapeHtml(item.iconDataUrl)}" alt="Ikon ${escapeHtml(item.appName || 'aplikasi')}">` : icon(status === 'success' ? 'check' : statusClass === 'failed' ? 'alert' : 'build');
      const candidateDownload = item.browserDownloadUrl || item.downloadUrl || '';
      let validDownload = false;
      try { const parsed = new URL(candidateDownload); const host = parsed.hostname.toLowerCase(); validDownload = parsed.protocol === 'https:' && (host === 'github.com' || host.endsWith('.githubusercontent.com')); } catch {}
      const downloadButton = status === 'success' && validDownload ? `<a class="btn" data-download href="${escapeHtml(candidateDownload)}" target="_blank" rel="noopener" download>UNDUH APK</a><a class="btn" href="${escapeHtml(candidateDownload)}" target="_blank" rel="noopener">BUKA TAB BARU</a>` : '';
      return `<article class="result-card" data-history-id="${escapeHtml(item.id)}"><div class="result-icon ${statusClass}">${thumb}</div><div class="result-main"><strong>${escapeHtml(item.appName || item.filename || 'Project')}</strong><small>${escapeHtml(item.filename || '')}<br>${escapeHtml(item.appId || '')} · ${escapeHtml(item.version || '1.0.0')}<br>${escapeHtml(when)}</small><div style="margin-top:6px"><span class="status-label ${statusClass}">${escapeHtml(label)}</span></div></div><div class="result-actions">${downloadButton}<button class="btn" data-edit>EDIT KONFIGURASI</button></div></article>`;
    }).join('');
    $('resultsList').querySelectorAll('[data-edit]').forEach(button => button.addEventListener('click', event => { event.stopPropagation(); editHistoryItem(button.closest('[data-history-id]').dataset.historyId); }));
    $('resultsList').querySelectorAll('[data-history-id]').forEach(card => card.addEventListener('click', event => { if (!event.target.closest('a,button')) editHistoryItem(card.dataset.historyId); }));
  }
  async function editHistoryItem(id) {
    const record = readHistory().find(item => item.id === id);
    if (!record) return toast('Riwayat tidak ditemukan.');
    currentJob = null;
    activeHistoryId = id;
    loadIdentityFromHistory(record);
    const file = await getProjectFile(record.projectId);
    if (file) {
      await loadProject(file, { projectId: record.projectId, source: 'history' });
      loadIdentityFromHistory(record);
      $('buildActionStatus').textContent = 'Konfigurasi riwayat dimuat. Periksa preview sebelum build ulang.';
    } else {
      currentFile = null; currentZip = null; currentProjectId = record.projectId || null; fileEntries = []; indexEntry = null;
      $('selectedProject').classList.add('hidden'); $('projectClassification').classList.add('hidden'); $('previewProject').disabled = true;
      $('buildActionStatus').textContent = 'Konfigurasi riwayat dimuat. Pilih ulang ZIP sumber untuk preview dan build ulang.';
      $('reviewGate').classList.remove('done'); $('reviewGate').innerHTML = `${icon('alert')}<span>Pilih ulang ZIP sumber dari perangkat ini untuk melanjutkan build.</span>`;
    }
    previewReviewed = false;
    updateBuildReadiness();
    showView('build');
  }
  updateHistoryCount();

  // App identity auto-populates from the current filename, including projects imported through GitHub.
  function prepareNameOnFile() {
    if (currentFile && !$('appName').value.trim()) {
      $('appName').value = String(currentFile.name || 'Nexa App').replace(/\.zip$/i, '').replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).slice(0, 40) || 'Nexa App';
    }
    if ($('appName').value.trim() && (!$('appId').value.trim() || !packageIdEdited)) $('appId').value = generatedId($('appName').value);
  }
  function restoreIdentityFromFile() {
    if (!currentFile) return;
    const history = readHistory();
    const previous = history.find(item => item.projectId === currentProjectId);
    if (previous) { loadIdentityFromHistory(previous); return; }
    prepareNameOnFile();
  }

  // Final wiring and clean shutdown.
  $('labBack').addEventListener('click', () => showView('build'));
  $('editAfterBuild').addEventListener('click', async () => {
    const record = currentJob;
    if (!record) return showView('build');
    const file = await getProjectFile(record.projectId);
    loadIdentityFromHistory(record);
    if (file) await loadProject(file, { projectId: record.projectId, source: 'history' });
    else { currentFile = null; currentZip = null; $('selectedProject').classList.add('hidden'); $('buildActionStatus').textContent = 'Konfigurasi dimuat; pilih ulang ZIP sumber untuk membangun ulang.'; }
    loadIdentityFromHistory(record);
    previewReviewed = false;
    updateBuildReadiness();
    showView('build');
  });
  $('downloadApk').addEventListener('click', () => {
    if (currentJob) { currentJob.downloadRequestedAt = Date.now(); saveHistoryRecord(currentJob); }
    toast('Membuka tautan APK GitHub Release…');
  });
  $('appName').addEventListener('change', () => { if ($('appName').value.trim() && (!packageIdEdited || !$('appId').value.trim())) $('appId').value = generatedId($('appName').value); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      closeDrawer();
      document.querySelectorAll('.overlay:not(.hidden)').forEach(layer => { if (layer.id !== 'previewOverlay') closeOverlay(layer.id); });
      if (!$('previewOverlay').classList.contains('hidden')) completePreview();
    }
  });
  window.addEventListener('pagehide', () => {
    if (eventStream) eventStream.close();
    clearTimeout(pollHandle); clearInterval(clockHandle); cleanupPreviewUrls();
  });

  window.NexaBuildBridge = {
    getCurrent: () => ({ currentFile, currentZip, currentProjectId, detectedType, previewReviewed, userProfile, currentJob }),
    getIconDataUrl: getAppIconDataUrl, getHistory: readHistory, saveHistory: saveHistoryRecord, renderResults,
    toast, showView, openOverlay, closeOverlay, loadVerse, loadProject, loadIdentityFromHistory,
    getOptions: () => ({ internetMode: $('internetMode')?.value || 'online', camera: !!$('cameraPermission')?.checked, wakeLock: !!$('wakeLock')?.checked, vibrate: !!$('vibratePermission')?.checked })
  };

  // Initialize identity, status badges and navigation.
  restoreIdentityFromFile();
  updateBuildReadiness();
  showView('home');
})();