/* BeamPi SPA – Vanilla JS, kein Build-Schritt. */
(() => {
  'use strict';

  // --- Mini-DOM-Helfer ------------------------------------------------------

  const $ = (sel, root = document) => root.querySelector(sel);

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'class') node.className = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2), value);
      } else if (value !== undefined && value !== null) node.setAttribute(key, value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child.nodeType ? child : document.createTextNode(child));
    }
    return node;
  }

  const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

  function fmtDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '–:––';
    const total = Math.round(seconds);
    const m = Math.floor(total / 60);
    const s = total % 60;
    if (m >= 60) {
      return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function fmtSize(bytes) {
    if (!Number.isFinite(bytes)) return '';
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} kB`;
  }

  // --- API ------------------------------------------------------------------

  async function api(path, options = {}) {
    const opts = { ...options };
    if (opts.json !== undefined) {
      opts.method = opts.method || 'POST';
      opts.headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
      opts.body = JSON.stringify(opts.json);
      delete opts.json;
    }
    const response = await fetch(path, opts);
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      /* keine JSON-Antwort */
    }
    if (response.status === 401 && path !== '/api/login' && path !== '/api/session') {
      handleUnauthenticated(); // Session abgelaufen → zurück zum Login
    }
    if (!response.ok) {
      throw new Error(payload?.message || `Fehler ${response.status}`);
    }
    return payload;
  }

  function handleUnauthenticated() {
    if (!S.authed) return;
    S.authed = false;
    eventSource?.close();
    eventSource = null;
    render();
  }

  // --- Toasts -----------------------------------------------------------------

  function toast(message, type = 'success') {
    const node = el('div', { class: `toast toast--${type}` }, message);
    $('#toasts').append(node);
    setTimeout(() => {
      node.classList.add('leaving');
      setTimeout(() => node.remove(), 300);
    }, 4200);
  }

  // --- Globaler Zustand ----------------------------------------------------------

  const S = {
    playlists: [],
    status: { mode: 'idle', running: false, current_video: null, loop_video: null },
    active: null,
    progress: null,
    filter: '',
    volume: 100,
    muted: false,
    autoTrigger: { enabled: false, interval_s: 300, next_at: null },
    clockOffset: 0,
    authed: false,
    mustChange: false,
  };

  function applySnapshot(snap) {
    if (!snap) return;
    S.status = snap.status || S.status;
    S.active = snap.active_playlist ?? null;
    S.progress = snap.active_progress ?? null;
    // Eigene Lautstärke-Änderungen nicht von verspäteten Snapshots überschreiben
    if (typeof snap.volume === 'number' && Date.now() - lastVolumeSentAt > 1200) S.volume = snap.volume;
    if (typeof snap.muted === 'boolean') S.muted = snap.muted;
    if (snap.auto_trigger) S.autoTrigger = snap.auto_trigger;
    S.usbMode = Boolean(snap.usb_mode);
    // Uhren-Offset zum Server (Pi ohne RTC kann falsch gehen)
    if (typeof snap.now === 'number') S.clockOffset = snap.now - Date.now();
    updateLamp();
    updateDeck();
    updateVolumeUI();
    updateAutoTriggerUI();
    if (currentRoute().view === 'dashboard') updateActiveMarkers();
  }

  // --- Auto-Trigger -------------------------------------------------------------

  function updateAutoTriggerUI() {
    const toggle = $('#at-toggle');
    if (!toggle) return;
    toggle.checked = S.autoTrigger.enabled;
    const minutes = Math.floor(S.autoTrigger.interval_s / 60);
    const seconds = S.autoTrigger.interval_s % 60;
    const minInput = $('#at-min');
    const secInput = $('#at-sec');
    if (minInput && document.activeElement !== minInput) minInput.value = String(minutes);
    if (secInput && document.activeElement !== secInput) secInput.value = String(seconds);
    updateAutoTriggerCountdown();
  }

  function updateAutoTriggerCountdown() {
    const countdown = $('#at-countdown');
    if (!countdown) return;
    if (!S.autoTrigger.enabled) {
      countdown.textContent = '';
      countdown.classList.add('hidden');
      return;
    }
    if (!S.autoTrigger.next_at) {
      // Countdown wartet, bis das laufende Video zu Ende ist
      countdown.textContent = S.status.mode === 'trigger' ? 'Pausiert bis Videoende' : '';
      countdown.classList.toggle('hidden', S.status.mode !== 'trigger');
      return;
    }
    const remaining = Math.max(0, Math.round((S.autoTrigger.next_at - (Date.now() + S.clockOffset)) / 1000));
    const minutes = Math.floor(remaining / 60);
    const seconds = remaining % 60;
    countdown.textContent = `Nächster Trigger in ${minutes}:${String(seconds).padStart(2, '0')}`;
    countdown.classList.remove('hidden');
  }

  setInterval(updateAutoTriggerCountdown, 1000);

  async function sendAutoTrigger() {
    const toggle = $('#at-toggle');
    const minutes = Math.min(60, Math.max(0, Math.round(Number($('#at-min')?.value || 0))));
    const seconds = Math.min(60, Math.max(0, Math.round(Number($('#at-sec')?.value || 0))));
    const total = minutes * 60 + seconds;
    if (toggle?.checked && total < 1) {
      toast('Bitte ein Intervall von mindestens 1 Sekunde angeben.', 'error');
      toggle.checked = false;
      return;
    }
    try {
      // Beim bloßen Ausschalten das gespeicherte Intervall nicht überschreiben
      const payload = { enabled: Boolean(toggle?.checked) };
      if (total >= 1) payload.interval_s = total;
      const result = await api('/api/auto-trigger', { method: 'PUT', json: payload });
      if (result?.auto_trigger) S.autoTrigger = result.auto_trigger;
      updateAutoTriggerUI();
    } catch (err) {
      toast(err.message, 'error');
      updateAutoTriggerUI();
    }
  }

  // --- Lautstärke -------------------------------------------------------------

  let volumeDragging = false;
  let volumeSendTimer = null;
  let lastVolumeSentAt = 0;

  function volumeIcon(value, muted) {
    if (muted || value === 0) return '🔇';
    if (value < 50) return '🔉';
    return '🔊';
  }

  function updateVolumeUI() {
    const slider = $('#volume-slider');
    if (!slider) return;
    if (!volumeDragging) slider.value = S.volume;
    const shown = volumeDragging ? Number(slider.value) : S.volume;
    const label = $('#volume-label');
    if (label) label.textContent = S.muted ? 'Stumm' : `${shown} %`;
    const muteBtn = $('#volume-mute');
    if (muteBtn) {
      muteBtn.textContent = volumeIcon(shown, S.muted);
      muteBtn.title = S.muted ? 'Stummschaltung aufheben' : 'Stumm schalten';
    }
    const row = $('#volume-row');
    if (row) row.classList.toggle('muted', S.muted);
  }

  function sendVolume(value) {
    clearTimeout(volumeSendTimer);
    lastVolumeSentAt = Date.now();
    volumeSendTimer = setTimeout(async () => {
      try {
        // Ziehen am Regler hebt eine aktive Stummschaltung auf
        const payload = { volume: Number(value) };
        if (S.muted) payload.muted = false;
        const result = await api('/api/volume', { method: 'PUT', json: payload });
        if (typeof result?.muted === 'boolean') S.muted = result.muted;
        updateVolumeUI();
      } catch (err) {
        toast(err.message, 'error');
      }
    }, 150);
  }

  async function toggleMute() {
    try {
      const result = await api('/api/volume', { method: 'PUT', json: { muted: !S.muted } });
      S.muted = Boolean(result?.muted);
      updateVolumeUI();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function loadState() {
    const data = await api('/api/state');
    S.playlists = data.playlists || [];
    applySnapshot(data);
  }

  // --- SSE Live-Status -------------------------------------------------------------

  let eventSource = null;

  function connectEvents() {
    eventSource?.close();
    const source = new EventSource('/api/events');
    eventSource = source;
    source.onmessage = (event) => {
      try {
        applySnapshot(JSON.parse(event.data));
      } catch {
        /* ignorieren */
      }
    };
    source.onerror = () => {
      $('#lamp').className = 'lamp lamp--off';
      $('#lamp-text').textContent = 'OFFLINE';
      // Bei endgültigem Abbruch (z. B. iOS im Hintergrund) selbst neu verbinden –
      // EventSource gibt dann auf und reconnectet NICHT mehr von alleine.
      if (source.readyState === EventSource.CLOSED) {
        setTimeout(() => {
          if (eventSource === source) connectEvents();
        }, 3000);
      }
    };
  }

  // --- Statuslampe + Deck (Live-Elemente) ---------------------------------------------

  const LAMP_CONFIG = {
    idle: { cls: 'lamp--idle', text: 'STANDBY' },
    loop: { cls: 'lamp--loop', text: 'LOOP' },
    trigger: { cls: 'lamp--trigger', text: 'ON AIR' },
  };

  function updateLamp() {
    const config = LAMP_CONFIG[S.status.mode] || LAMP_CONFIG.idle;
    $('#lamp').className = `lamp ${config.cls}`;
    $('#lamp-text').textContent = config.text;
    $('#footer-info').textContent = S.status.running ? 'mpv verbunden' : 'mpv getrennt';
  }

  function buildProgress() {
    if (!S.progress) return null;
    const { next_video_index: next, total_videos: total } = S.progress;
    const wrap = el('div', { class: 'progress-wrap' });
    if (total <= 24) {
      const track = el('div', { class: 'progress-track' });
      for (let i = 1; i <= total; i += 1) {
        const seg = el('div', { class: 'progress-seg' });
        if (i < next) seg.classList.add('done');
        if (i === next) seg.classList.add('next');
        track.append(seg);
      }
      wrap.append(track);
    }
    wrap.append(el('span', { class: 'progress-count' }, `${next} / ${total}`));
    return wrap;
  }

  function updateDeck() {
    const deck = $('#deck');
    if (!deck) return;

    deck.className = `card deck deck--${S.status.mode}`;

    const modeNames = { idle: 'Keine Wiedergabe', loop: 'Loop läuft', trigger: 'Trigger läuft' };
    $('#deck-mode', deck).textContent = modeNames[S.status.mode] || modeNames.idle;

    const playlistNode = $('#deck-playlist', deck);
    playlistNode.innerHTML = '';
    playlistNode.append(
      S.active ? S.active : el('span', { class: 'none' }, 'Keine aktive Playlist')
    );

    const currentNode = $('#deck-current', deck);
    currentNode.textContent = S.status.current_video || '—';
    currentNode.classList.toggle('placeholder', !S.status.current_video);

    const nextNode = $('#deck-next', deck);
    nextNode.textContent = S.progress ? S.progress.next_video : '—';
    nextNode.classList.toggle('placeholder', !S.progress);

    const loopNode = $('#deck-loop', deck);
    loopNode.textContent = S.status.loop_video || 'kein Loop';
    loopNode.classList.toggle('placeholder', !S.status.loop_video);

    const progressSlot = $('#deck-progress', deck);
    progressSlot.innerHTML = '';
    const progress = buildProgress();
    if (progress) progressSlot.append(progress);

    const usbBanner = $('#usb-banner');
    if (usbBanner) usbBanner.hidden = !S.usbMode;

    // Trigger ausgegraut, wenn keine Playlist aktiv ist ODER bereits ein
    // Trigger-Video läuft/ansteht (passend zur Server-Sperre in triggerNext).
    const triggerBusy = S.status.mode === 'trigger' || S.status.queued > 0;
    $('#trigger-btn').disabled = !S.active || triggerBusy;
    updateLive();
    startRemainTimer();
  }

  function updateActiveMarkers() {
    document.querySelectorAll('[data-playlist-card]').forEach((card) => {
      const isActive = card.dataset.playlistCard === S.active;
      card.classList.toggle('active', isActive);
      const tag = $('.active-tag', card);
      if (tag) tag.classList.toggle('hidden', !isActive);
      const progressNode = $('[data-card-progress]', card);
      if (progressNode) {
        if (isActive && S.progress) {
          progressNode.textContent = `Als Nächstes: ${S.progress.next_video} (${S.progress.next_video_index}/${S.progress.total_videos})`;
        } else {
          progressNode.textContent = '';
        }
      }
    });
  }

  // --- Theme (dunkel = Standard, hell optional) -----------------------------------------

  function applyTheme(theme) {
    if (theme === 'light') {
      document.documentElement.dataset.theme = 'light';
      $('#theme-toggle').textContent = '☾';
      $('#theme-toggle').title = 'Zum dunklen Modus wechseln';
    } else {
      delete document.documentElement.dataset.theme;
      $('#theme-toggle').textContent = '☀';
      $('#theme-toggle').title = 'Zum hellen Modus wechseln';
    }
    // Browser-/PWA-Statusleiste ans Theme anpassen
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'light' ? '#f3efe7' : '#0a0c0f';
    localStorage.setItem('beampi-theme', theme);
  }

  $('#theme-toggle').addEventListener('click', () => {
    const isLight = document.documentElement.dataset.theme === 'light';
    applyTheme(isLight ? 'dark' : 'light');
  });

  applyTheme(localStorage.getItem('beampi-theme') === 'light' ? 'light' : 'dark');

  // --- Live-Vorschau (zeigt, was der Beamer gerade ausgibt) -----------------------------

  const live = {
    src: null,
    timer: null,
    open: localStorage.getItem('beampi-live-open') !== '0',
    muted: localStorage.getItem('beampi-live-muted') !== '0',
  };

  function stopLiveTimer() {
    clearInterval(live.timer);
    live.timer = null;
  }

  function startLiveTimer() {
    if (live.timer) return;
    live.timer = setInterval(syncLivePosition, 2000);
  }

  // Restzeit-Anzeige im Deck: pollt die Abspielposition direkt von mpv (läuft
  // auch, wenn die Live-Vorschau eingeklappt ist).
  let remainTimer = null;
  function stopRemainTimer() {
    clearInterval(remainTimer);
    remainTimer = null;
  }
  function startRemainTimer() {
    if (remainTimer) return;
    updateRemaining();
    remainTimer = setInterval(updateRemaining, 1000);
  }
  async function updateRemaining() {
    const node = $('#deck-remaining');
    if (!node) {
      stopRemainTimer(); // Dashboard verlassen
      return;
    }
    if (!S.status.current_video) {
      node.textContent = '—';
      return;
    }
    try {
      const data = await api('/api/player/position');
      const info = data.playback;
      if (!info || info.position === null || !Number.isFinite(info.duration) || info.duration <= 0) {
        node.textContent = '—';
        return;
      }
      const remaining = Math.max(0, info.duration - info.position);
      node.textContent = (info.mode === 'loop' ? '↻ ' : '') + fmtDuration(remaining);
    } catch {
      /* Netzwerkfehler ignorieren */
    }
  }

  function stopLivePlayback(video) {
    live.src = null;
    if (video.getAttribute('src')) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    stopLiveTimer();
  }

  async function syncLivePosition() {
    const video = $('#live-video');
    if (!video || !live.open || !live.src) {
      live.src = null; // View verlassen – beim Zurückkehren Quelle neu setzen
      stopLiveTimer();
      return;
    }
    try {
      const data = await api('/api/player/position');
      const info = data.playback;
      if (!info || info.video !== live.src || info.position === null) return;
      const target = info.position + 0.35; // kleine Latenz-Kompensation
      let drift = Math.abs(video.currentTime - target);
      // Beim Loop zählt der zyklische Abstand – sonst springt die Vorschau
      // bei jedem Wrap (z. B. mpv bei 0.2s, Browser bei 3.9s eines 4s-Loops).
      const duration = info.duration || video.duration;
      if (video.loop && Number.isFinite(duration) && duration > 0) {
        drift = Math.min(drift, Math.abs(duration - drift));
      }
      if (drift > 1.2) video.currentTime = target;
      if (video.paused && !info.paused) video.play().catch(() => {});
    } catch {
      /* Netzwerkfehler ignorieren */
    }
  }

  function updateLive() {
    const video = $('#live-video');
    if (!video) {
      stopLiveTimer();
      return;
    }
    $('#live-wrap').classList.toggle('hidden', !live.open);
    $('#live-toggle').textContent = live.open ? 'Verbergen' : 'Anzeigen';
    const muteBtn = $('#live-mute');
    muteBtn.textContent = live.muted ? '🔇 Stumm' : '🔊 Ton an';
    muteBtn.classList.toggle('hidden', !live.open);
    video.muted = live.muted;

    const current = S.status.current_video;
    $('#live-badge').classList.toggle('on', Boolean(current) && live.open);

    if (!live.open) {
      stopLivePlayback(video);
      updateLiveProgress();
      return;
    }

    const overlay = $('#live-overlay');
    if (!current) {
      stopLivePlayback(video);
      overlay.classList.remove('hidden');
      overlay.textContent = 'Keine Wiedergabe';
      updateLiveProgress();
      return;
    }

    overlay.classList.add('hidden');
    video.loop = S.status.mode === 'loop';
    // Auch prüfen, ob das <video> wirklich eine Quelle hat – nach einem
    // Seitenwechsel ist das Element neu, live.src aber noch gesetzt.
    if (live.src !== current || !video.getAttribute('src')) {
      live.src = current;
      video.src = `/videos/${encodePath(current)}`;
      playLive(video);
      syncLivePosition();
    } else if (video.paused && !document.hidden) {
      // z. B. nachdem der Browser das Video in einem Hintergrund-Tab pausiert hat
      playLive(video);
    }
    startLiveTimer();
    updateLiveProgress();
  }

  /** Laufband unter der Live-Vorschau: Fortschritt des aktuellen Videos. */
  function updateLiveProgress() {
    const wrap = $('#live-progress');
    if (!wrap) return;
    const video = $('#live-video');
    const dur = video?.duration;
    const cur = video?.currentTime ?? 0;
    const show = live.open && Boolean(S.status.current_video) && Number.isFinite(dur) && dur > 0;
    wrap.classList.toggle('hidden', !show);
    if (!show) return;
    const pct = Math.max(0, Math.min(100, (cur / dur) * 100));
    const bar = $('#live-bar');
    const prev = parseFloat(bar.style.width) || 0;
    if (pct < prev - 0.5) {
      // Loop-Wrap/Rücksprung: ohne Animation zurücksetzen (kein Rückwärtslauf)
      bar.classList.add('no-anim');
      bar.style.width = `${pct}%`;
      void bar.offsetWidth; // Reflow erzwingen, damit no-anim greift
      bar.classList.remove('no-anim');
    } else {
      bar.style.width = `${pct}%`;
    }
    $('#live-elapsed').textContent = cur > 0 ? fmtDuration(cur) : '0:00';
    $('#live-total').textContent = fmtDuration(dur);
  }

  /** play() mit iOS-Fallback: unmuted Autoplay ist verboten → stumm weiterspielen. */
  function playLive(video) {
    video.play().catch((err) => {
      if (err?.name === 'NotAllowedError' && !video.muted) {
        live.muted = true;
        localStorage.setItem('beampi-live-muted', '1');
        video.muted = true;
        video.play().catch(() => {});
        toast('Browser blockiert Autoplay mit Ton – Vorschau läuft stumm weiter.', 'info');
        updateLive();
      }
    });
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && S.authed && !S.mustChange) {
      // Nach Rückkehr aus dem Hintergrund: Verbindung und Zustand auffrischen
      if (!eventSource || eventSource.readyState === EventSource.CLOSED) connectEvents();
      loadState().catch(() => {});
      updateLive();
      syncLivePosition();
    }
  });

  function toggleLiveOpen() {
    live.open = !live.open;
    localStorage.setItem('beampi-live-open', live.open ? '1' : '0');
    updateLive();
  }

  function toggleLiveMute() {
    live.muted = !live.muted;
    localStorage.setItem('beampi-live-muted', live.muted ? '1' : '0');
    updateLive();
  }

  // --- Vorschau-Modal ------------------------------------------------------------------

  let previewReturnFocus = null;

  function openPreview(name, relPath) {
    const modal = $('#preview-modal');
    const video = $('#preview-video');
    $('#preview-title').textContent = name || relPath;
    video.src = `/videos/${encodePath(relPath)}`;
    modal.classList.remove('hidden');
    // Fokus in den Dialog holen (Tastatur/Screenreader), Rückkehrziel merken
    previewReturnFocus = document.activeElement;
    $('#preview-close').focus();
    video.play().catch(() => {});
  }

  function closePreview() {
    const modal = $('#preview-modal');
    const video = $('#preview-video');
    video.pause();
    video.removeAttribute('src');
    video.load();
    modal.classList.add('hidden');
    if (previewReturnFocus?.isConnected) previewReturnFocus.focus();
    previewReturnFocus = null;
  }

  $('#preview-close').addEventListener('click', closePreview);
  $('#preview-modal').addEventListener('click', (event) => {
    if (event.target === $('#preview-modal')) closePreview();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#preview-modal').classList.contains('hidden')) closePreview();
  });

  // Leertaste = Trigger (außer in Eingabefeldern/Buttons oder offenem Modal)
  document.addEventListener('keydown', (event) => {
    if (event.code !== 'Space' || event.repeat) return;
    const target = event.target;
    if (target instanceof HTMLElement && target.closest('input, textarea, select, button, a, video, [contenteditable]')) return;
    if (!$('#preview-modal').classList.contains('hidden')) return;
    if (!S.authed || !S.active) return;
    event.preventDefault();
    doTrigger();
  });

  // --- Aktionen ---------------------------------------------------------------------------

  async function doTrigger() {
    try {
      await api('/api/trigger', { method: 'POST', json: {} });
      toast('Nächstes Video gestartet.');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function doStart(name) {
    try {
      const result = await api(`/api/playlists/${encodeURIComponent(name)}/start`, { method: 'POST' });
      toast(`Playlist „${name}" gestartet.`);
      if (result?.warning) toast(result.warning, 'error');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function doDelete(name) {
    if (!window.confirm(`Playlist „${name}" wirklich löschen?`)) return;
    try {
      await api(`/api/playlists/${encodeURIComponent(name)}`, { method: 'DELETE' });
      toast(`Playlist „${name}" wurde gelöscht.`);
      await loadState();
      render();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function doDuplicate(name) {
    try {
      const result = await api(`/api/playlists/${encodeURIComponent(name)}/duplicate`, { method: 'POST', json: {} });
      toast(`Playlist „${result.playlist.name}" wurde erstellt.`);
      await loadState();
      location.hash = `#/playlist/edit/${encodeURIComponent(result.playlist.name)}`;
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // --- View: Dashboard -----------------------------------------------------------------------

  function viewDashboard(root) {
    root.append(
      el('div', { class: 'page-head' },
        el('div', {},
          el('span', { class: 'kicker' }, 'Projektionssteuerung'),
          el('h1', {}, 'Dashboard')
        ),
        el('a', { class: 'btn btn--primary', href: '#/playlist/new' }, '+ Neue Playlist')
      )
    );

    // Hinweis, wenn ein USB-Stick die Wiedergabe übernommen hat
    root.append(
      el('div', { class: 'usb-banner', id: 'usb-banner', hidden: true },
        el('span', { class: 'usb-banner-icon', 'aria-hidden': 'true' }, '🔌'),
        el('div', {},
          el('b', {}, 'USB-Stick-Modus aktiv'),
          el('span', {}, ' – die Wiedergabe läuft vom angesteckten Stick. Playlists und Einstellungen sind hier wirkungslos. Stick abziehen und neu starten für den Normalbetrieb.')
        )
      )
    );

    // Deck / Hero
    const deck = el('section', { class: 'card deck', id: 'deck' },
      el('div', { class: 'deck-info' },
        el('span', { class: 'deck-label', id: 'deck-mode' }, 'Keine Wiedergabe'),
        el('div', { class: 'deck-playlist', id: 'deck-playlist' }),
        el('div', { class: 'deck-rows' },
          el('div', { class: 'deck-row' }, el('b', {}, 'Läuft gerade'), el('span', { class: 'mono', id: 'deck-current' })),
          el('div', { class: 'deck-row' }, el('b', {}, 'Restzeit'), el('span', { class: 'mono', id: 'deck-remaining' }, '—')),
          el('div', { class: 'deck-row' }, el('b', {}, 'Als Nächstes'), el('span', { class: 'mono', id: 'deck-next' })),
          el('div', { class: 'deck-row' }, el('b', {}, 'Loop-Video'), el('span', { class: 'mono', id: 'deck-loop' }))
        ),
        el('div', { id: 'deck-progress' }),
        el('div', { class: 'volume-row', id: 'volume-row' },
          el('button', {
            class: 'volume-mute', id: 'volume-mute', type: 'button',
            title: 'Stumm schalten', 'aria-label': 'Stumm schalten',
            onclick: toggleMute,
          }, '🔊'),
          el('input', {
            type: 'range', min: '0', max: '100', step: '1', value: String(S.volume),
            class: 'volume-slider', id: 'volume-slider', 'aria-label': 'Lautstärke',
            onpointerdown: () => { volumeDragging = true; },
            onpointerup: () => { volumeDragging = false; },
            onpointercancel: () => { volumeDragging = false; updateVolumeUI(); },
            oninput: (event) => {
              updateVolumeUI();
              sendVolume(event.target.value);
            },
            onchange: (event) => {
              volumeDragging = false;
              sendVolume(event.target.value);
            },
          }),
          el('span', { class: 'volume-label mono', id: 'volume-label' }, `${S.volume} %`)
        )
      ),
      el('div', { class: 'trigger-zone' },
        el('button', { class: 'trigger-btn', id: 'trigger-btn', onclick: doTrigger, disabled: 'disabled' }, 'TRIGGER'),
        el('span', { class: 'trigger-hint' }, 'Nächstes Video abspielen'),
        el('div', { class: 'autotrigger' },
          el('div', { class: 'at-head' },
            el('label', { class: 'switch' },
              el('input', { type: 'checkbox', id: 'at-toggle', onchange: sendAutoTrigger }),
              el('span', { class: 'switch-track' }, el('span', { class: 'switch-knob' }))
            ),
            el('span', { class: 'at-title' }, 'Auto-Trigger')
          ),
          el('div', { class: 'at-interval' },
            el('input', { class: 'input mono at-num', id: 'at-min', type: 'number', inputmode: 'numeric', min: '0', max: '60', step: '1', onchange: sendAutoTrigger, 'aria-label': 'Minuten' }),
            el('span', { class: 'at-unit' }, 'Min'),
            el('input', { class: 'input mono at-num', id: 'at-sec', type: 'number', inputmode: 'numeric', min: '0', max: '60', step: '1', onchange: sendAutoTrigger, 'aria-label': 'Sekunden' }),
            el('span', { class: 'at-unit' }, 'Sek')
          ),
          el('div', { class: 'at-countdown mono hidden', id: 'at-countdown' })
        )
      )
    );
    root.append(deck);

    // Live-Vorschau
    const liveVideo = el('video', { id: 'live-video', playsinline: 'playsinline', preload: 'auto' });
    liveVideo.muted = live.muted;
    liveVideo.addEventListener('error', () => {
      if (!live.src) return;
      const overlay = $('#live-overlay');
      if (overlay) {
        overlay.classList.remove('hidden');
        overlay.textContent = 'Dieses Format kann der Browser nicht abspielen.';
      }
    });
    // Laufband direkt aus dem (mit mpv synchronisierten) Vorschau-Video speisen
    liveVideo.addEventListener('timeupdate', updateLiveProgress);
    liveVideo.addEventListener('loadedmetadata', updateLiveProgress);
    liveVideo.addEventListener('emptied', updateLiveProgress);

    root.append(
      el('section', { class: 'card live-card' },
        el('div', { class: 'panel-head' },
          el('h3', {}, 'Live-Vorschau', el('span', { class: 'sub' }, 'Zeigt, was der Beamer gerade ausgibt')),
          el('div', { class: 'live-controls' },
            el('span', { class: 'live-badge', id: 'live-badge' }, el('span', { class: 'live-dot' }), 'LIVE'),
            el('button', { class: 'btn btn--ghost btn--sm', id: 'live-mute', onclick: toggleLiveMute }, ''),
            el('button', { class: 'btn btn--sm', id: 'live-toggle', onclick: toggleLiveOpen }, '')
          )
        ),
        el('div', { class: 'live-wrap', id: 'live-wrap' },
          liveVideo,
          el('div', { class: 'live-overlay', id: 'live-overlay' }, 'Keine Wiedergabe')
        ),
        // Laufband: Fortschritt des aktuell laufenden Videos
        el('div', { class: 'live-progress hidden', id: 'live-progress' },
          el('span', { class: 'live-time mono', id: 'live-elapsed' }, '0:00'),
          el('div', { class: 'live-track' }, el('div', { class: 'live-bar', id: 'live-bar' })),
          el('span', { class: 'live-time mono', id: 'live-total' }, '0:00')
        )
      )
    );

    // Toolbar + Playlist-Karten
    const search = el('input', {
      class: 'input',
      type: 'search',
      placeholder: 'Playlists durchsuchen…',
      value: S.filter,
      oninput: (event) => {
        S.filter = event.target.value;
        renderPlaylistGrid();
      },
    });

    root.append(
      el('div', { class: 'toolbar' },
        el('h2', { style: 'font-size:20px' }, 'Playlists'),
        el('span', { class: 'count-badge', id: 'pl-count' }, ''),
        el('div', { class: 'spacer' }),
        el('div', { class: 'search-wrap' }, search)
      )
    );

    const grid = el('div', { class: 'playlist-grid' });
    root.append(grid);

    function renderPlaylistGrid() {
      const query = S.filter.trim().toLowerCase();
      const visible = S.playlists.filter((p) => !query || p.name.toLowerCase().includes(query));
      $('#pl-count').textContent = `${visible.length} von ${S.playlists.length}`;
      grid.innerHTML = '';
      if (S.playlists.length === 0) {
        grid.append(el('div', { class: 'card empty-state', style: 'grid-column:1/-1' },
          'Noch keine Playlists. Lege mit „Neue Playlist" die erste an.'));
        return;
      }
      if (visible.length === 0) {
        grid.append(el('div', { class: 'card empty-state', style: 'grid-column:1/-1' },
          'Keine Playlists entsprechen deiner Suche.'));
        return;
      }
      for (const playlist of visible) {
        const count = playlist.videos.length;
        grid.append(
          el('div', { class: 'card pl-card', dataset: { playlistCard: playlist.name } },
            el('span', { class: 'active-tag hidden' }, 'AKTIV'),
            el('div', { class: 'pl-name' }, playlist.name),
            el('div', { class: 'pl-meta' },
              el('span', { class: 'chip chip--amber' }, `${count} ${count === 1 ? 'Video' : 'Videos'}`),
              playlist.loop_video
                ? el('span', { class: 'chip chip--loop', title: playlist.loop_video }, `Loop · ${playlist.loop_video}`)
                : el('span', { class: 'chip' }, 'kein Loop')
            ),
            el('div', { class: 'pl-progress', dataset: { cardProgress: '1' } }),
            el('div', { class: 'pl-actions' },
              el('button', { class: 'btn btn--primary btn--sm', onclick: () => doStart(playlist.name) }, '▶ Starten'),
              el('a', { class: 'btn btn--sm', href: `#/playlist/edit/${encodeURIComponent(playlist.name)}` }, 'Bearbeiten'),
              el('button', { class: 'btn btn--ghost btn--sm', onclick: () => doDuplicate(playlist.name) }, 'Duplizieren'),
              el('button', { class: 'btn btn--danger btn--ghost btn--sm', onclick: () => doDelete(playlist.name) }, 'Löschen')
            )
          )
        );
      }
      updateActiveMarkers();
    }

    renderPlaylistGrid();
    updateLamp();
    updateDeck();
    updateAutoTriggerUI();
  }

  // --- View: Playlist-Editor ---------------------------------------------------------------------

  async function viewEditor(root, editName, isStale = () => false) {
    const isEdit = Boolean(editName);
    const playlist = isEdit ? S.playlists.find((p) => p.name === editName) : null;
    if (isEdit && !playlist) {
      toast('Playlist wurde nicht gefunden.', 'error');
      location.hash = '#/';
      return;
    }

    let videoData;
    try {
      videoData = await api('/api/videos');
    } catch (err) {
      toast(err.message, 'error');
      videoData = { videos: [], tree: [], files: [], disk: null };
    }
    if (isStale()) return; // User ist während des Ladens weiternavigiert

    let known = new Set(videoData.videos);
    let fileMeta = new Map((videoData.files ?? []).map((f) => [f.path, f]));
    // Auswahl: bestehende Reihenfolge übernehmen (auch fehlende Dateien anzeigen)
    let selected = playlist ? [...playlist.videos] : [];

    root.append(
      el('div', { class: 'page-head' },
        el('div', {},
          el('span', { class: 'kicker' }, isEdit ? 'Playlist bearbeiten' : 'Neue Playlist'),
          el('h1', {}, isEdit ? playlist.name : 'Neue Playlist')
        ),
        el('a', { class: 'btn btn--ghost', href: '#/' }, '← Zurück')
      )
    );

    // Stammdaten
    const nameInput = el('input', {
      class: 'input', id: 'pl-name', type: 'text',
      value: isEdit ? playlist.name : '',
      placeholder: 'z. B. Halloween Show',
      ...(isEdit ? { readonly: 'readonly' } : {}),
    });

    const loopSelect = el('select', { class: 'input mono', id: 'pl-loop' });
    function rebuildLoopOptions(value) {
      const current = value ?? loopSelect.value ?? '';
      loopSelect.innerHTML = '';
      loopSelect.append(el('option', { value: '' }, '(kein Loop-Video)'));
      for (const v of videoData.videos) loopSelect.append(el('option', { value: v }, v));
      // Falls das gespeicherte Loop-Video nicht mehr existiert, trotzdem anzeigen
      if (current && !known.has(current)) {
        loopSelect.append(el('option', { value: current }, `${current} (fehlt)`));
      }
      loopSelect.value = current;
    }
    rebuildLoopOptions(playlist?.loop_video ?? '');

    root.append(
      el('section', { class: 'card card-pad', style: 'margin-bottom:18px' },
        el('div', { class: 'settings-grid' },
          el('div', { class: 'field', style: 'margin:0' },
            el('label', { for: 'pl-name' }, 'Name'),
            nameInput,
            isEdit ? el('div', { class: 'hint' }, 'Der Name kann nachträglich nicht geändert werden.') : null
          ),
          el('div', { class: 'field', style: 'margin:0' },
            el('label', { for: 'pl-loop' }, 'Loop-Video'),
            loopSelect,
            el('div', { class: 'hint' }, 'Läuft in Dauerschleife, bis ein Trigger ausgelöst wird.')
          )
        )
      )
    );

    // Editor: Auswahl + Bibliothek
    const selList = el('ul', { class: 'sel-list' });
    const selCount = el('span', { class: 'count-badge' }, '0 Videos');

    const selPanel = el('section', { class: 'card' },
      el('div', { class: 'panel-head' },
        el('h3', {}, 'Playlist-Reihenfolge', el('span', { class: 'sub' }, 'Ziehen zum Sortieren')),
        selCount
      ),
      el('div', { class: 'panel-body' }, selList)
    );

    const treeContainer = el('div', {});
    const searchInput = el('input', {
      class: 'input', type: 'search', placeholder: 'Videos durchsuchen…',
      oninput: () => renderTree(),
    });

    function libSubText() {
      const count = videoData.videos.length;
      let text = `${count} ${count === 1 ? 'Video' : 'Videos'}`;
      if (videoData.disk) text += ` · ${fmtSize(videoData.disk.free)} frei`;
      return text;
    }
    const libSub = el('span', { class: 'sub' }, libSubText());

    const libPanel = el('section', { class: 'card' },
      el('div', { class: 'panel-head' },
        el('h3', {}, 'Video-Bibliothek', libSub),
        el('div', { style: 'display:flex;gap:8px' },
          el('button', { class: 'btn btn--ghost btn--sm', onclick: () => toggleAllFolders(true) }, 'Alle öffnen'),
          el('button', { class: 'btn btn--ghost btn--sm', onclick: () => toggleAllFolders(false) }, 'Alle schließen')
        )
      ),
      el('div', { class: 'panel-body' },
        el('div', { class: 'search-wrap', style: 'max-width:none;margin-bottom:12px' }, searchInput),
        treeContainer
      )
    );

    root.append(el('div', { class: 'editor-grid' }, selPanel, libPanel));

    // Speichern-Leiste
    root.append(
      el('div', { style: 'display:flex;gap:10px;margin-top:22px' },
        el('button', { class: 'btn btn--primary', onclick: save }, isEdit ? 'Änderungen speichern' : 'Playlist speichern'),
        el('a', { class: 'btn btn--ghost', href: '#/' }, 'Abbrechen')
      )
    );

    // -- Auswahl-Liste ----------------------------------------------------

    let dragIndex = null;

    function renderSelected() {
      selList.innerHTML = '';
      let label = `${selected.length} ${selected.length === 1 ? 'Video' : 'Videos'}`;
      const totalDuration = selected.reduce((sum, p) => sum + (fileMeta.get(p)?.duration || 0), 0);
      if (selected.length > 0 && totalDuration > 0) {
        const incomplete = selected.some((p) => fileMeta.get(p)?.duration == null);
        label += ` · ${incomplete ? '≈ ' : ''}${fmtDuration(totalDuration)}`;
      }
      selCount.textContent = label;
      if (selected.length === 0) {
        selList.append(el('li', { class: 'sel-empty' }, 'Noch keine Videos ausgewählt – füge sie aus der Bibliothek hinzu.'));
        renderTreeMarkers();
        return;
      }
      selected.forEach((videoPath, index) => {
        const name = videoPath.split('/').pop();
        const grip = el('span', { class: 'grip', title: 'Ziehen zum Sortieren' }, '⠿');
        const item = el('li', { class: 'sel-item', draggable: 'true', dataset: { selIndex: String(index) } },
          grip,
          el('span', { class: 'idx' }, String(index + 1)),
          el('span', { class: 'sel-name', title: videoPath }, known.has(videoPath) ? videoPath : `${videoPath} (fehlt)`),
          el('span', { class: 'sel-dur' }, fileMeta.get(videoPath)?.duration != null ? fmtDuration(fileMeta.get(videoPath).duration) : ''),
          el('span', { class: 'sel-actions' },
            el('button', { class: 'icon-btn', title: 'Nach oben', disabled: index === 0 ? 'disabled' : undefined, onclick: () => move(index, -1) }, '↑'),
            el('button', { class: 'icon-btn', title: 'Nach unten', disabled: index === selected.length - 1 ? 'disabled' : undefined, onclick: () => move(index, 1) }, '↓'),
            known.has(videoPath)
              ? el('button', { class: 'icon-btn', title: 'Vorschau', onclick: () => openPreview(name, videoPath) }, '▶')
              : null,
            el('button', { class: 'icon-btn icon-btn--danger', title: 'Entfernen', onclick: () => removeVideo(videoPath) }, '✕')
          )
        );
        item.addEventListener('dragstart', () => {
          dragIndex = index;
          item.classList.add('dragging');
        });
        item.addEventListener('dragend', () => {
          dragIndex = null;
          item.classList.remove('dragging');
          selList.querySelectorAll('.drag-over').forEach((n) => n.classList.remove('drag-over'));
        });
        item.addEventListener('dragover', (event) => {
          event.preventDefault();
          if (dragIndex !== null && dragIndex !== index) item.classList.add('drag-over');
        });
        item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
        item.addEventListener('drop', (event) => {
          event.preventDefault();
          if (dragIndex === null || dragIndex === index) return;
          const [moved] = selected.splice(dragIndex, 1);
          selected.splice(index, 0, moved);
          renderSelected();
        });
        // Touch-Sortierung über den Griff (HTML5-Drag&Drop gibt es auf
        // iOS/Android nicht); Maus nutzt weiterhin das normale Drag&Drop.
        grip.addEventListener('pointerdown', (event) => {
          if (event.pointerType === 'mouse') return;
          event.preventDefault();
          try {
            grip.setPointerCapture(event.pointerId);
          } catch {
            /* synthetische Events haben keine aktive Pointer-ID */
          }
          item.classList.add('dragging');
          let targetIndex = index;
          const onMove = (ev) => {
            const under = document.elementFromPoint(ev.clientX, ev.clientY);
            const overItem = under ? under.closest('[data-sel-index]') : null;
            selList.querySelectorAll('.drag-over').forEach((n) => n.classList.remove('drag-over'));
            if (overItem && overItem !== item) {
              overItem.classList.add('drag-over');
              targetIndex = Number(overItem.dataset.selIndex);
            } else if (!overItem) {
              targetIndex = index;
            }
          };
          const onEnd = () => {
            grip.removeEventListener('pointermove', onMove);
            grip.removeEventListener('pointerup', onEnd);
            grip.removeEventListener('pointercancel', onEnd);
            item.classList.remove('dragging');
            if (targetIndex !== index) {
              const [moved] = selected.splice(index, 1);
              selected.splice(targetIndex, 0, moved);
            }
            renderSelected();
          };
          grip.addEventListener('pointermove', onMove);
          grip.addEventListener('pointerup', onEnd);
          grip.addEventListener('pointercancel', onEnd);
        });
        selList.append(item);
      });
      renderTreeMarkers();
    }

    function move(index, delta) {
      const target = index + delta;
      if (target < 0 || target >= selected.length) return;
      [selected[index], selected[target]] = [selected[target], selected[index]];
      renderSelected();
    }

    function addVideo(videoPath) {
      if (selected.includes(videoPath)) {
        toast('Video ist bereits in der Playlist.', 'info');
        return;
      }
      selected.push(videoPath);
      renderSelected();
    }

    function removeVideo(videoPath) {
      selected = selected.filter((p) => p !== videoPath);
      renderSelected();
    }

    // -- Bibliotheks-Baum ----------------------------------------------------

    const openFolders = new Set();

    // -- Dateiverwaltung ----------------------------------------------------

    async function refreshLibrary(renameMap = null) {
      try {
        videoData = await api('/api/videos');
      } catch (err) {
        toast(err.message, 'error');
        return;
      }
      known = new Set(videoData.videos);
      fileMeta = new Map((videoData.files ?? []).map((f) => [f.path, f]));
      if (renameMap) selected = selected.map((p) => renameMap.get(p) ?? p);
      libSub.textContent = libSubText();
      rebuildLoopOptions(renameMap ? renameMap.get(loopSelect.value) ?? loopSelect.value : undefined);
      renderSelected(); // rendert auch den Baum neu
    }

    async function deleteFile(videoPath) {
      if (!window.confirm(`Datei „${videoPath}" endgültig löschen?`)) return;
      try {
        const result = await api('/api/files', { method: 'DELETE', json: { path: videoPath } });
        toast('Datei gelöscht.');
        if (result?.warning) toast(result.warning, 'info');
        await refreshLibrary();
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    async function renameFile(videoPath) {
      const input = window.prompt('Neuer Pfad (relativ – anderer Ordner = verschieben):', videoPath);
      if (input === null) return;
      const to = input.trim();
      if (!to || to === videoPath) return;
      try {
        const result = await api('/api/files/rename', { json: { from: videoPath, to } });
        toast(result?.updated_playlists > 0
          ? `Umbenannt – ${result.updated_playlists} Playlist(s) automatisch angepasst.`
          : 'Umbenannt.');
        await refreshLibrary(new Map([[videoPath, to]]));
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    async function deleteFolder(folderPath) {
      if (!window.confirm(`Leeren Ordner „${folderPath}" löschen?`)) return;
      try {
        await api('/api/folders', { method: 'DELETE', json: { path: folderPath } });
        toast('Ordner gelöscht.');
        openFolders.delete(folderPath);
        await refreshLibrary();
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    function buildFileNode(node) {
      const inPlaylist = selected.includes(node.path);
      const meta = fileMeta.get(node.path);
      const metaParts = [];
      if (meta?.duration != null) metaParts.push(fmtDuration(meta.duration));
      if (meta?.size != null) metaParts.push(fmtSize(meta.size));
      const thumb = el('img', { class: 'thumb', loading: 'lazy', alt: '', src: `/api/thumbs/${encodePath(node.path)}` });
      thumb.addEventListener('error', () => thumb.classList.add('thumb--missing'));
      return el('li', { class: `tree-file${inPlaylist ? ' in-playlist' : ''}`, dataset: { filePath: node.path } },
        thumb,
        el('div', { class: 'file-info' },
          el('span', { class: 'file-name', title: node.path }, node.name),
          el('span', { class: 'file-meta' }, metaParts.join(' · '))
        ),
        el('span', { class: 'file-actions' },
          el('button', { class: 'icon-btn', title: 'Vorschau', onclick: () => openPreview(node.name, node.path) }, '▶'),
          inPlaylist
            ? el('button', { class: 'icon-btn icon-btn--danger', title: 'Entfernen', onclick: () => removeVideo(node.path) }, '✕')
            : el('button', { class: 'icon-btn', title: 'Zur Playlist hinzufügen', onclick: () => addVideo(node.path) }, '+'),
          el('button', { class: 'icon-btn', title: 'Umbenennen / Verschieben', onclick: () => renameFile(node.path) }, '✎'),
          el('button', { class: 'icon-btn icon-btn--danger', title: 'Datei löschen', onclick: () => deleteFile(node.path) }, '🗑')
        )
      );
    }

    function buildTreeNodes(nodes) {
      const list = el('ul', { class: 'tree' });
      for (const node of nodes) {
        if (node.is_file) {
          list.append(buildFileNode(node));
        } else {
          const folder = el('li', { class: `tree-folder${openFolders.has(node.path) ? ' open' : ''}`, dataset: { folderPath: node.path } },
            el('div', {
              class: 'folder-row',
              onclick: (event) => {
                const li = event.currentTarget.parentElement;
                li.classList.toggle('open');
                if (li.classList.contains('open')) openFolders.add(node.path);
                else openFolders.delete(node.path);
              },
            }, el('span', { class: 'caret' }, '▶'), `${node.name}/`,
              node.children.length === 0
                ? el('button', {
                    class: 'icon-btn icon-btn--danger folder-del',
                    title: 'Leeren Ordner löschen',
                    onclick: (ev) => {
                      ev.stopPropagation();
                      deleteFolder(node.path);
                    },
                  }, '🗑')
                : null),
            node.children.length
              ? buildTreeNodes(node.children)
              : el('ul', {}, el('li', { class: 'tree-empty' }, 'Keine Videos in diesem Ordner.'))
          );
          list.append(folder);
        }
      }
      return list;
    }

    function renderTree() {
      treeContainer.innerHTML = '';
      const query = searchInput.value.trim().toLowerCase();
      if (videoData.videos.length === 0) {
        treeContainer.append(el('p', { class: 'tree-empty' },
          'Keine Videos gefunden. Lade unter Einstellungen Videos hoch.'));
        return;
      }
      if (!query) {
        treeContainer.append(buildTreeNodes(videoData.tree));
        return;
      }
      const matches = videoData.videos.filter((v) => v.toLowerCase().includes(query));
      if (matches.length === 0) {
        treeContainer.append(el('p', { class: 'tree-empty' }, 'Keine Videos gefunden, die den Suchbegriff enthalten.'));
        return;
      }
      const list = el('ul', { class: 'tree' });
      for (const videoPath of matches) {
        list.append(buildFileNode({ name: videoPath, path: videoPath }));
      }
      treeContainer.append(list);
    }

    function renderTreeMarkers() {
      // Nach Auswahländerung Baum-Buttons aktualisieren
      renderTree();
    }

    function toggleAllFolders(open) {
      treeContainer.querySelectorAll('.tree-folder').forEach((li) => {
        li.classList.toggle('open', open);
        if (open) openFolders.add(li.dataset.folderPath);
        else openFolders.delete(li.dataset.folderPath);
      });
    }

    // -- Speichern -------------------------------------------------------------

    async function save() {
      const name = nameInput.value.trim();
      const loopVideo = loopSelect.value || null;
      if (!name) {
        toast('Bitte einen Namen für die Playlist eingeben.', 'error');
        nameInput.focus();
        return;
      }
      try {
        if (isEdit) {
          const result = await api(`/api/playlists/${encodeURIComponent(editName)}`, {
            method: 'PUT',
            json: { loop_video: loopVideo, videos: selected },
          });
          if (result?.warning) toast(result.warning, 'error');
          toast('Playlist aktualisiert.');
        } else {
          await api('/api/playlists', { json: { name, loop_video: loopVideo, videos: selected } });
          toast('Playlist gespeichert.');
        }
        await loadState();
        location.hash = '#/';
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    renderSelected();

    // Dauern, die noch im Hintergrund ermittelt werden, einmalig nachladen
    if (videoData.videos.length > 0 && (videoData.files ?? []).some((f) => f.duration == null)) {
      setTimeout(() => {
        if (isStale() || !document.querySelector('[data-file-path]')) return;
        refreshLibrary();
      }, 4000);
    }
  }

  // --- View: Einstellungen --------------------------------------------------------------------------

  async function viewSettings(root, isStale = () => false) {
    let data;
    try {
      data = await api('/api/settings');
    } catch (err) {
      if (isStale()) return;
      // Nicht leer lassen – Fehlerkarte mit Retry anbieten
      root.append(
        el('section', { class: 'card empty-state' },
          el('p', {}, `Einstellungen konnten nicht geladen werden: ${err.message}`),
          el('button', { class: 'btn btn--primary', onclick: render }, 'Erneut versuchen')
        )
      );
      return;
    }
    if (isStale()) return;
    const settings = data.settings;

    root.append(
      el('div', { class: 'page-head' },
        el('div', {},
          el('span', { class: 'kicker' }, 'Konfiguration'),
          el('h1', {}, 'Einstellungen')
        ),
        el('a', { class: 'btn btn--ghost', href: '#/' }, '← Zurück')
      )
    );

    // Audio-Geräte von mpv erfragen und als Auswahl anbieten
    let audioDevices = [];
    try {
      audioDevices = (await api('/api/audio-devices')).devices || [];
    } catch {
      /* mpv evtl. gerade nicht verbunden – Auswahl zeigt dann nur "auto" */
    }
    if (isStale()) return;
    const currentAudio = settings.audio_output || 'auto';
    const audioSelect = el('select', { class: 'input mono' },
      audioDevices.length === 0 ? el('option', { value: 'auto' }, 'Automatisch (Systemstandard)') : null,
      audioDevices.map((device) =>
        el('option', {
          value: device.name,
          title: device.name,
          ...(currentAudio === device.name ? { selected: 'selected' } : {}),
        }, device.name === 'auto' ? 'Automatisch (Systemstandard)' : `${device.description} (${device.name})`)
      ),
      // Gespeicherten Wert anbieten, auch wenn er gerade nicht in der Liste ist
      currentAudio !== 'auto' && !audioDevices.some((d) => d.name === currentAudio)
        ? el('option', { value: currentAudio, selected: 'selected' }, `${currentAudio} (gespeichert)`)
        : null
    );
    const startHook = el('input', { class: 'input mono', type: 'url', value: settings.trigger_start_webhook_url, placeholder: 'https://example.com/webhook/start' });
    const endHook = el('input', { class: 'input mono', type: 'url', value: settings.trigger_end_webhook_url, placeholder: 'https://example.com/webhook/end' });
    const dirInput = el('input', { class: 'input mono', type: 'text', value: settings.video_directory });
    const autoSelect = el('select', { class: 'input' },
      el('option', { value: '' }, 'Keine automatische Wiedergabe'),
      S.playlists.map((p) =>
        el('option', { value: p.name, ...(settings.auto_start_playlist === p.name ? { selected: 'selected' } : {}) }, p.name)
      )
    );
    const gpioPinInput = el('input', {
      class: 'input mono', type: 'number', inputmode: 'numeric', min: '0', max: '27', step: '1',
      value: settings.gpio_pin, placeholder: 'z. B. 17 – leer = deaktiviert',
    });
    const gpioDebounceInput = el('input', {
      class: 'input mono', type: 'number', inputmode: 'numeric', min: '50', max: '5000', step: '10',
      value: settings.gpio_debounce_ms,
    });
    const gpioStatusChip = el('span', { class: 'chip' }, '');

    function renderGpioStatus(gpioStatus) {
      gpioStatusChip.classList.remove('chip--loop', 'chip--amber');
      if (!gpioStatus || gpioStatus.pin === null) {
        gpioStatusChip.textContent = 'Taster deaktiviert';
      } else if (gpioStatus.error) {
        gpioStatusChip.textContent = `Fehler: ${gpioStatus.error}`;
      } else if (gpioStatus.running) {
        gpioStatusChip.classList.add('chip--loop');
        gpioStatusChip.textContent = `Taster aktiv an GPIO${gpioStatus.pin}`;
      } else {
        gpioStatusChip.classList.add('chip--amber');
        gpioStatusChip.textContent = `GPIO${gpioStatus.pin} wird gestartet …`;
      }
    }
    renderGpioStatus(data.gpio);

    async function saveSettings() {
      try {
        const result = await api('/api/settings', {
          method: 'PUT',
          json: {
            audio_output: audioSelect.value,
            trigger_start_webhook_url: startHook.value,
            trigger_end_webhook_url: endHook.value,
            video_directory: dirInput.value,
            auto_start_playlist: autoSelect.value,
            gpio_pin: gpioPinInput.value,
            gpio_debounce_ms: gpioDebounceInput.value || '250',
          },
        });
        toast('Einstellungen gespeichert.');
        for (const warning of result?.warnings ?? []) toast(warning, 'info');
        renderGpioStatus(result?.gpio);
        // Kurz darauf nochmal prüfen, ob die Taster-Überwachung läuft
        if (result?.gpio && result.gpio.pin !== null) {
          setTimeout(async () => {
            if (isStale()) return; // View wurde inzwischen verlassen
            try {
              renderGpioStatus((await api('/api/settings')).gpio);
            } catch { /* egal */ }
          }, 1200);
        }
        // Auto-Start-Playlist aktivieren – aber nur, wenn sie nicht ohnehin
        // schon läuft, sonst würde jedes Speichern eine laufende Wiedergabe
        // (Loop/Trigger) hart neu starten.
        if (autoSelect.value && autoSelect.value !== S.active) await doStart(autoSelect.value);
        await loadState();
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    root.append(
      el('section', { class: 'card card-pad', style: 'margin-bottom:18px' },
        el('h3', { style: 'margin-bottom:16px' }, 'Wiedergabe & Integration'),
        el('div', { class: 'settings-grid' },
          el('div', {},
            el('div', { class: 'field' },
              el('label', {}, 'Audioausgabe'),
              audioSelect,
              el('div', { class: 'hint' }, 'Geräteliste kommt von mpv. „HDMI" wählen, um den Ton über den Beamer/Monitor auszugeben; bei Änderung startet der Player neu.')
            ),
            el('div', { class: 'field' },
              el('label', {}, 'Videoverzeichnis'),
              dirInput,
              el('div', { class: 'hint' }, 'Wird automatisch erstellt, falls es noch nicht existiert.')
            ),
            el('div', { class: 'field', style: 'margin-bottom:0' },
              el('label', {}, 'Automatisch startende Playlist'),
              autoSelect,
              el('div', { class: 'hint' }, 'Wird beim Start von BeamPi automatisch aktiviert.')
            )
          ),
          el('div', {},
            el('div', { class: 'field' },
              el('label', {}, 'Webhook bei Trigger-Start'),
              startHook,
              el('div', { class: 'hint' }, 'Wird aufgerufen, wenn ein Trigger-Video startet (POST, JSON).')
            ),
            el('div', { class: 'field', style: 'margin-bottom:0' },
              el('label', {}, 'Webhook bei Trigger-Ende'),
              endHook,
              el('div', { class: 'hint' }, 'Wird aufgerufen, wenn ein Trigger-Video zu Ende ist.')
            )
          ),
          el('div', {},
            el('div', { class: 'field' },
              el('label', {}, 'GPIO-Taster (BCM-Pin)'),
              gpioPinInput,
              el('div', { class: 'hint' },
                'Taster zwischen GPIO-Pin und GND anschließen – der interne Pull-up wird automatisch gesetzt. Beispiel: GPIO17 = Header-Pin 11, GND = Header-Pin 9. Ein Druck wirkt wie der Trigger-Button.')
            ),
            el('div', { class: 'field' },
              el('label', {}, 'Entprellzeit (ms)'),
              gpioDebounceInput,
              el('div', { class: 'hint' }, 'Mindestabstand zwischen zwei Tastendrücken (50–5000 ms).')
            ),
            el('div', { class: 'field', style: 'margin-bottom:0' },
              el('label', {}, 'Taster-Status'),
              gpioStatusChip
            )
          )
        ),
        el('div', { style: 'margin-top:20px' },
          el('button', { class: 'btn btn--primary', onclick: saveSettings }, 'Einstellungen speichern')
        )
      )
    );

    // Ordner + Upload
    const folderInput = el('input', { class: 'input mono', type: 'text', placeholder: 'z. B. veranstaltungen/2026' });
    const subdirInput = el('input', { class: 'input mono', type: 'text', placeholder: 'leer = Hauptverzeichnis' });
    const fileInput = el('input', { class: 'input', type: 'file', accept: 'video/*,.mkv,.avi,.wmv,.m4v,.mpg,.mpeg', multiple: 'multiple' });
    const progressBar = el('div', { class: 'bar' });
    const progressWrap = el('div', { class: 'upload-progress hidden' }, progressBar);
    const uploadBtn = el('button', { class: 'btn btn--primary', onclick: doUpload }, 'Videos hochladen');

    async function createFolder() {
      const value = folderInput.value.trim();
      if (!value) {
        toast('Bitte einen Ordnernamen angeben.', 'error');
        return;
      }
      try {
        await api('/api/folders', { json: { path: value } });
        toast('Ordner wurde erstellt.');
        folderInput.value = '';
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    function doUpload() {
      const files = fileInput.files;
      if (!files || files.length === 0) {
        toast('Bitte zuerst Videodateien auswählen.', 'error');
        return;
      }
      const formData = new FormData();
      formData.append('subdirectory', subdirInput.value.trim());
      for (const file of files) formData.append('video_files', file);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload');
      progressWrap.classList.remove('hidden');
      progressBar.style.width = '0%';
      uploadBtn.disabled = true;

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          progressBar.style.width = `${Math.round((event.loaded / event.total) * 100)}%`;
        }
      };
      xhr.onload = () => {
        uploadBtn.disabled = false;
        progressWrap.classList.add('hidden');
        let payload = null;
        try {
          payload = JSON.parse(xhr.responseText);
        } catch { /* leer */ }
        if (xhr.status >= 200 && xhr.status < 300) {
          toast(`${payload?.saved?.length ?? 0} Datei(en) hochgeladen.`);
          fileInput.value = '';
        } else {
          toast(payload?.message || `Upload fehlgeschlagen (${xhr.status})`, 'error');
        }
      };
      xhr.onerror = () => {
        uploadBtn.disabled = false;
        progressWrap.classList.add('hidden');
        toast('Upload fehlgeschlagen – Netzwerkfehler.', 'error');
      };
      xhr.send(formData);
    }

    root.append(
      el('div', { class: 'settings-grid' },
        el('section', { class: 'card card-pad' },
          el('h3', { style: 'margin-bottom:6px' }, 'Neuen Ordner anlegen'),
          el('p', { class: 'hint', style: 'margin:0 0 14px;color:var(--text-faint);font-size:13px' },
            `Unterordner innerhalb von ${data.video_directory}`),
          el('div', { class: 'field' },
            el('label', {}, 'Ordnerpfad (relativ)'),
            folderInput
          ),
          el('button', { class: 'btn', onclick: createFolder }, 'Ordner erstellen')
        ),
        el('section', { class: 'card card-pad' },
          el('h3', { style: 'margin-bottom:6px' }, 'Videos hochladen'),
          el('p', { class: 'hint', style: 'margin:0 0 14px;color:var(--text-faint);font-size:13px' },
            'Mehrere Dateien möglich. Erlaubt: mp4, mkv, mov, avi, mpg, webm, m4v, wmv'),
          el('div', { class: 'field' },
            el('label', {}, 'Zielordner (relativ, optional)'),
            subdirInput
          ),
          el('div', { class: 'field' },
            el('label', {}, 'Videodateien'),
            fileInput
          ),
          uploadBtn,
          progressWrap
        ),
        el('section', { class: 'card card-pad' },
          el('h3', { style: 'margin-bottom:6px' }, 'Passwort ändern'),
          el('p', { class: 'hint', style: 'margin:0 0 14px;color:var(--text-faint);font-size:13px' },
            'Nach der Änderung bleiben andere angemeldete Geräte abgemeldet.'),
          buildPasswordForm()
        )
      )
    );
  }

  // --- Anmeldung ---------------------------------------------------------------------------------

  async function afterAuthBoot() {
    try {
      await loadState();
    } catch {
      /* Toast kommt über die API-Fehler */
    }
    connectEvents();
    render();
  }

  function viewLogin(root) {
    const userInput = el('input', { class: 'input', type: 'text', value: 'admin', autocomplete: 'username' });
    const passInput = el('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
    const submit = async () => {
      try {
        const result = await api('/api/login', {
          json: { username: userInput.value.trim(), password: passInput.value },
        });
        S.authed = true;
        S.mustChange = Boolean(result?.must_change_password);
        if (S.mustChange) render();
        else await afterAuthBoot();
      } catch (err) {
        toast(err.message, 'error');
        passInput.value = '';
        passInput.focus();
      }
    };
    for (const input of [userInput, passInput]) {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') submit();
      });
    }
    root.append(
      el('div', { class: 'auth-wrap' },
        el('section', { class: 'card card-pad auth-card' },
          el('div', { class: 'auth-logo' }, 'BEAM', el('em', {}, 'PI')),
          el('h2', {}, 'Anmelden'),
          el('p', { class: 'auth-hint' }, 'Die Projektionssteuerung ist passwortgeschützt.'),
          el('div', { class: 'field' }, el('label', {}, 'Benutzername'), userInput),
          el('div', { class: 'field' }, el('label', {}, 'Passwort'), passInput),
          el('button', { class: 'btn btn--primary', style: 'width:100%', onclick: submit }, 'Anmelden')
        )
      )
    );
    passInput.focus();
  }

  function buildPasswordForm(onSuccess) {
    const current = el('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
    const next1 = el('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
    const next2 = el('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
    const submit = async () => {
      if (next1.value.length < 6) {
        toast('Das neue Passwort braucht mindestens 6 Zeichen.', 'error');
        return;
      }
      if (next1.value !== next2.value) {
        toast('Die neuen Passwörter stimmen nicht überein.', 'error');
        return;
      }
      try {
        await api('/api/password', {
          json: { current_password: current.value, new_password: next1.value },
        });
        toast('Passwort geändert.');
        current.value = next1.value = next2.value = '';
        onSuccess?.();
      } catch (err) {
        toast(err.message, 'error');
      }
    };
    next2.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
    });
    return el('div', {},
      el('div', { class: 'field' }, el('label', {}, 'Aktuelles Passwort'), current),
      el('div', { class: 'field' }, el('label', {}, 'Neues Passwort (min. 6 Zeichen)'), next1),
      el('div', { class: 'field' }, el('label', {}, 'Neues Passwort wiederholen'), next2),
      el('button', { class: 'btn btn--primary', onclick: submit }, 'Passwort speichern')
    );
  }

  function viewPasswordChange(root) {
    root.append(
      el('div', { class: 'auth-wrap' },
        el('section', { class: 'card card-pad auth-card' },
          el('div', { class: 'auth-logo' }, 'BEAM', el('em', {}, 'PI')),
          el('h2', {}, 'Neues Passwort festlegen'),
          el('p', { class: 'auth-hint' }, 'Aus Sicherheitsgründen muss das Standardpasswort jetzt geändert werden.'),
          buildPasswordForm(async () => {
            S.mustChange = false;
            await afterAuthBoot();
          })
        )
      )
    );
  }

  $('#logout-btn').addEventListener('click', async () => {
    try {
      await api('/api/logout', { method: 'POST' });
    } catch {
      /* Session ist ohnehin weg */
    }
    S.authed = false;
    eventSource?.close();
    eventSource = null;
    render();
  });

  // --- Router -----------------------------------------------------------------------------------

  function currentRoute() {
    const hash = location.hash.replace(/^#\/?/, '');
    if (hash === 'settings') return { view: 'settings' };
    if (hash === 'playlist/new') return { view: 'editor' };
    const editMatch = hash.match(/^playlist\/edit\/(.+)$/);
    if (editMatch) {
      // Manche Browser liefern location.hash bereits decodiert – ein "%" im
      // Playlist-Namen würde decodeURIComponent dann werfen lassen
      try {
        return { view: 'editor', name: decodeURIComponent(editMatch[1]) };
      } catch {
        return { view: 'editor', name: editMatch[1] };
      }
    }
    return { view: 'dashboard' };
  }

  // Schutz gegen überlappende Renders: Views laden asynchron – navigiert der
  // User währenddessen weiter, darf der alte Lauf nicht mehr ins DOM schreiben.
  let renderSeq = 0;

  async function render() {
    const seq = ++renderSeq;
    const isStale = () => seq !== renderSeq;
    const route = currentRoute();
    const root = $('#app');
    root.innerHTML = '';
    root.style.animation = 'none';
    void root.offsetHeight; // Animation neu starten
    root.style.animation = '';

    document.body.classList.toggle('unauthed', !S.authed || S.mustChange);
    $('#logout-btn').hidden = !S.authed;

    if (!S.authed) {
      viewLogin(root);
      return;
    }
    if (S.mustChange) {
      viewPasswordChange(root);
      return;
    }

    document.querySelectorAll('[data-nav]').forEach((link) => {
      link.classList.toggle('active', link.dataset.nav === (route.view === 'settings' ? 'settings' : 'dashboard'));
    });

    if (route.view === 'settings') await viewSettings(root, isStale);
    else if (route.view === 'editor') await viewEditor(root, route.name, isStale);
    else viewDashboard(root);
  }

  window.addEventListener('hashchange', render);

  // --- Start ------------------------------------------------------------------------------------

  (async () => {
    let session = { authenticated: false };
    try {
      session = await api('/api/session');
    } catch (err) {
      toast(`Server nicht erreichbar: ${err.message}`, 'error');
    }
    S.authed = Boolean(session.authenticated);
    S.mustChange = Boolean(session.must_change_password);
    if (S.authed && !S.mustChange) {
      try {
        await loadState();
      } catch (err) {
        toast(`Server nicht erreichbar: ${err.message}`, 'error');
      }
      connectEvents();
    }
    render();
  })();
})();
