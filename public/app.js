(() => {
  const state = {
    playlists: [],
    currentName: null,
    currentFolder: null,
    tracks: [],
    poolFiles: [],
    dragIndex: null,
    undoStack: [],
    redoStack: [],
    sortMode: 'manual',
    playerQueue: [],
    playerQueuePos: -1,
  };

  const el = {
    playlistList: document.getElementById('playlist-list'),
    sidebarEmptyHint: document.getElementById('sidebar-empty-hint'),
    newPlaylistName: document.getElementById('new-playlist-name'),
    newPlaylistFolder: document.getElementById('new-playlist-folder'),
    newPlaylistTracks: document.getElementById('new-playlist-tracks'),
    createPlaylistBtn: document.getElementById('create-playlist-btn'),
    logoutBtn: document.getElementById('logout-btn'),
    themeToggle: document.getElementById('theme-toggle'),

    recentlyDeletedBtn: document.getElementById('recently-deleted-btn'),
    deletedPanel: document.getElementById('deleted-panel'),
    deletedPanelClose: document.getElementById('deleted-panel-close'),
    deletedList: document.getElementById('deleted-list'),
    deletedEmptyHint: document.getElementById('deleted-empty-hint'),

    backupBtn: document.getElementById('backup-btn'),
    restoreInput: document.getElementById('restore-input'),
    restorePanel: document.getElementById('restore-panel'),
    restoreSummary: document.getElementById('restore-summary'),
    restoreMergeBtn: document.getElementById('restore-merge-btn'),
    restoreReplaceBtn: document.getElementById('restore-replace-btn'),
    restoreCancelBtn: document.getElementById('restore-cancel-btn'),
    restorePanelClose: document.getElementById('restore-panel-close'),

    aboutBtn: document.getElementById('about-btn'),
    aboutPanel: document.getElementById('about-panel'),
    aboutPanelClose: document.getElementById('about-panel-close'),
    aboutVersion: document.getElementById('about-version'),
    aboutRepo: document.getElementById('about-repo'),

    globalSearchInput: document.getElementById('global-search-input'),
    globalSearchResults: document.getElementById('global-search-results'),

    noPlaylistState: document.getElementById('no-playlist-state'),
    playlistView: document.getElementById('playlist-view'),
    playlistTitle: document.getElementById('playlist-title'),
    playlistFolder: document.getElementById('playlist-folder'),
    trackCount: document.getElementById('track-count'),
    totalDuration: document.getElementById('total-duration'),
    deletePlaylistBtn: document.getElementById('delete-playlist-btn'),
    duplicatePlaylistBtn: document.getElementById('duplicate-playlist-btn'),

    coverThumb: document.getElementById('cover-thumb'),
    coverImg: document.getElementById('cover-img'),
    coverRemoveBtn: document.getElementById('cover-remove-btn'),
    coverUploadLabel: document.getElementById('cover-upload-label'),
    coverInput: document.getElementById('cover-input'),

    undoBtn: document.getElementById('undo-btn'),
    redoBtn: document.getElementById('redo-btn'),

    exportBtn: document.getElementById('export-btn'),
    exportMenu: document.getElementById('export-menu'),
    exportAudioBtn: document.getElementById('export-audio-btn'),

    importText: document.getElementById('import-text'),
    importReplaceBtn: document.getElementById('import-replace-btn'),
    importAppendBtn: document.getElementById('import-append-btn'),
    importFileInput: document.getElementById('import-file-input'),

    audioDropzone: document.getElementById('audio-dropzone'),
    audioBulkInput: document.getElementById('audio-bulk-input'),
    poolFilesWrap: document.getElementById('pool-files'),
    poolList: document.getElementById('pool-list'),

    filterInput: document.getElementById('filter-input'),
    missingAudioCheckbox: document.getElementById('missing-audio-checkbox'),
    sortSelect: document.getElementById('sort-select'),
    shuffleBtn: document.getElementById('shuffle-btn'),
    findReplaceToggleBtn: document.getElementById('find-replace-toggle-btn'),
    findReplacePanel: document.getElementById('find-replace-panel'),
    findInput: document.getElementById('find-input'),
    replaceInput: document.getElementById('replace-input'),
    findReplaceScope: document.getElementById('find-replace-scope'),
    findReplaceApplyBtn: document.getElementById('find-replace-apply-btn'),
    addTrackBtn: document.getElementById('add-track-btn'),
    trackList: document.getElementById('track-list'),
    tracksEmptyHint: document.getElementById('tracks-empty-hint'),

    toast: document.getElementById('toast'),

    playerBar: document.getElementById('player-bar'),
    playerAudio: document.getElementById('player-audio'),
    playerTitle: document.getElementById('player-title'),
    playerArtist: document.getElementById('player-artist'),
    playerClose: document.getElementById('player-close'),
    playerWaveform: document.getElementById('player-waveform'),
    playerPrev: document.getElementById('player-prev'),
    playerNext: document.getElementById('player-next'),
  };

  // ---------- generic helpers ----------

  function showToast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.remove('hidden');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.toast.classList.add('hidden'), 2400);
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    if (res.status === 401) {
      window.location.href = '/login';
      throw new Error('Not authenticated');
    }
    if (!res.ok) {
      let msg = 'Request failed';
      try { msg = (await res.json()).error || msg; } catch (e) {}
      throw new Error(msg);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  // Downloads via fetch+blob so server-side errors (e.g. "no audio yet")
  // show a toast instead of navigating to a raw JSON error page.
  async function downloadFrom(url) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        let msg = 'Export failed';
        try { msg = (await res.json()).error || msg; } catch (e) {}
        throw new Error(msg);
      }
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') || '';
      const filename = filenameFromDisposition(disposition);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (e) {
      showToast(e.message);
    }
  }

  // Content-Disposition carries an ASCII filename="..." and, for names with other characters,
  // a UTF-8 filename*=UTF-8''... which is the one to use.
  function filenameFromDisposition(disposition) {
    const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
    if (star) {
      try { return decodeURIComponent(star[1]); } catch (e) { /* fall through */ }
    }
    const plain = /filename="([^"]+)"/.exec(disposition);
    return plain ? plain[1] : 'download';
  }

  function trackId() {
    return Math.random().toString(36).slice(2, 10);
  }

  function escapeAttr(str) {
    return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  function truncate(str, n) {
    return str.length > n ? str.slice(0, n - 1) + '…' : str;
  }

  function formatDuration(sec) {
    if (sec === null || sec === undefined) return '';
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function formatLongDuration(totalSec) {
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = Math.round(totalSec % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // ---------- undo / redo ----------

  function snapshotTracks() {
    return JSON.parse(JSON.stringify(state.tracks));
  }

  function pushUndo() {
    state.undoStack.push(snapshotTracks());
    if (state.undoStack.length > 50) state.undoStack.shift();
    state.redoStack = [];
    updateUndoRedoButtons();
  }

  function resetHistory() {
    state.undoStack = [];
    state.redoStack = [];
    updateUndoRedoButtons();
  }

  function updateUndoRedoButtons() {
    el.undoBtn.disabled = state.undoStack.length === 0;
    el.redoBtn.disabled = state.redoStack.length === 0;
  }

  function undo() {
    if (!state.undoStack.length) return;
    state.redoStack.push(snapshotTracks());
    state.tracks = state.undoStack.pop();
    renderTracks();
    renderPoolFiles();
    saveTracks();
    updateUndoRedoButtons();
  }

  function redo() {
    if (!state.redoStack.length) return;
    state.undoStack.push(snapshotTracks());
    state.tracks = state.redoStack.pop();
    renderTracks();
    renderPoolFiles();
    saveTracks();
    updateUndoRedoButtons();
  }

  el.undoBtn.addEventListener('click', undo);
  el.redoBtn.addEventListener('click', redo);

  function moveTrack(index, direction) {
    const to = index + direction;
    if (to < 0 || to >= state.tracks.length) return;
    pushUndo();
    const [moved] = state.tracks.splice(index, 1);
    state.tracks.splice(to, 0, moved);
    renderTracks();
    saveTracks();
    const inputs = el.trackList.querySelectorAll(`[data-index="${to}"] .track-title`);
    if (inputs.length) inputs[0].focus();
  }

  // ---------- sidebar ----------

  async function loadPlaylists(selectName) {
    state.playlists = await api('/api/playlists');
    renderSidebar();
    if (selectName) {
      selectPlaylist(selectName);
    } else if (state.currentName && state.playlists.find((p) => p.name === state.currentName)) {
      selectPlaylist(state.currentName);
    }
  }

  function renderSidebar() {
    el.playlistList.innerHTML = '';
    el.sidebarEmptyHint.classList.toggle('hidden', state.playlists.length > 0);

    const groups = new Map(); // folder name (or '') -> playlists[]
    state.playlists
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((pl) => {
        const key = pl.folder || '';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(pl);
      });

    const sortedFolders = [...groups.keys()].sort((a, b) => {
      if (a === '') return 1; // ungrouped last
      if (b === '') return -1;
      return a.localeCompare(b);
    });

    sortedFolders.forEach((folderName) => {
      if (folderName) {
        const heading = document.createElement('div');
        heading.className = 'folder-heading';
        heading.textContent = folderName;
        el.playlistList.appendChild(heading);
      }
      groups.get(folderName).forEach((pl) => {
        const item = document.createElement('div');
        item.className = 'playlist-item' + (pl.name === state.currentName ? ' active' : '');
        const audioBit = pl.audioCount ? ` · 🎵${pl.audioCount}` : '';
        item.innerHTML = `
          <span class="pl-name"></span>
          <span class="pl-count">${pl.count}${audioBit}</span>
        `;
        item.querySelector('.pl-name').textContent = pl.name;
        item.addEventListener('click', () => selectPlaylist(pl.name));
        el.playlistList.appendChild(item);
      });
    });
  }

  function refreshSidebarCounts() {
    const pl = state.playlists.find((p) => p.name === state.currentName);
    if (pl) {
      pl.count = state.tracks.length;
      pl.audioCount = state.tracks.filter((t) => t.audioFile).length;
    }
    renderSidebar();
  }

  async function selectPlaylist(name) {
    await flushPendingSave();
    state.currentName = name;
    const data = await api(`/api/playlists/${encodeURIComponent(name)}`);
    state.tracks = data.tracks;
    state.poolFiles = data.poolFiles || [];
    state.currentFolder = data.folder || null;
    state.sortMode = 'manual';
    el.playlistTitle.textContent = name;
    el.playlistFolder.textContent = state.currentFolder || '';
    renderCover(data.cover);
    el.noPlaylistState.classList.add('hidden');
    el.playlistView.classList.remove('hidden');
    el.filterInput.value = '';
    el.missingAudioCheckbox.checked = false;
    el.sortSelect.value = 'manual';
    el.findReplacePanel.classList.add('hidden');
    resetHistory();
    renderSidebar();
    renderTracks();
    renderPoolFiles();
    closePlayer();
  }

  // ---------- global cross-playlist search ----------

  let searchTimer = null;
  el.globalSearchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = el.globalSearchInput.value.trim();
    if (!q) {
      el.globalSearchResults.classList.add('hidden');
      return;
    }
    searchTimer = setTimeout(() => runGlobalSearch(q), 250);
  });

  async function runGlobalSearch(q) {
    try {
      const results = await api(`/api/search?q=${encodeURIComponent(q)}`);
      el.globalSearchResults.innerHTML = '';
      if (!results.length) {
        el.globalSearchResults.innerHTML = '<div class="search-empty">No matches</div>';
      } else {
        results.forEach((r) => {
          const row = document.createElement('div');
          row.className = 'search-result';
          const label = r.track.artist ? `${r.track.artist} - ${r.track.title}` : r.track.title;
          row.innerHTML = `<span class="sr-track"></span><span class="sr-playlist"></span>`;
          row.querySelector('.sr-track').textContent = label;
          row.querySelector('.sr-playlist').textContent = r.playlistName;
          row.addEventListener('click', async () => {
            await selectPlaylist(r.playlistName);
            el.filterInput.value = r.track.title;
            renderTracks();
            el.globalSearchResults.classList.add('hidden');
            el.globalSearchInput.value = '';
          });
          el.globalSearchResults.appendChild(row);
        });
      }
      el.globalSearchResults.classList.remove('hidden');
    } catch (e) {
      showToast(e.message);
    }
  }

  document.addEventListener('click', (e) => {
    if (!el.globalSearchResults.contains(e.target) && e.target !== el.globalSearchInput) {
      el.globalSearchResults.classList.add('hidden');
    }
  });

  // ---------- track list rendering ----------

  function sortedTrackIndices() {
    const indexed = state.tracks.map((t, i) => ({ t, i }));
    const cmp = {
      title: (a, b) => a.t.title.localeCompare(b.t.title),
      artist: (a, b) => (a.t.artist || '').localeCompare(b.t.artist || ''),
      duration: (a, b) => (a.t.durationSec ?? -1) - (b.t.durationSec ?? -1),
      added: (a, b) => (a.t.createdAt ?? 0) - (b.t.createdAt ?? 0),
    }[state.sortMode];
    if (!cmp) return indexed.map((x) => x.i); // manual order
    return indexed.sort(cmp).map((x) => x.i);
  }

  function renderTracks() {
    const filter = el.filterInput.value.trim().toLowerCase();
    const missingOnly = el.missingAudioCheckbox.checked;
    const order = sortedTrackIndices();

    const filtered = order
      .map((i) => ({ ...state.tracks[i], _index: i }))
      .filter(
        (t) =>
          (!filter || t.title.toLowerCase().includes(filter) || (t.artist || '').toLowerCase().includes(filter)) &&
          (!missingOnly || !t.audioFile)
      );

    el.trackCount.textContent = `${state.tracks.length} track${state.tracks.length === 1 ? '' : 's'}`;

    const totalSec = state.tracks.reduce((sum, t) => sum + (t.durationSec || 0), 0);
    el.totalDuration.textContent = totalSec > 0 ? `· ${formatLongDuration(totalSec)} total` : '';

    el.tracksEmptyHint.classList.toggle('hidden', state.tracks.length > 0);
    el.trackList.innerHTML = '';

    filtered.forEach((t, displayIdx) => {
      const row = document.createElement('li');
      row.className = 'track-row';
      row.draggable = state.sortMode === 'manual';
      row.dataset.index = t._index;

      const hasAudio = !!t.audioFile;
      const durationLabel = hasAudio && t.durationSec != null ? ` · ${formatDuration(t.durationSec)}` : '';

      row.innerHTML = `
        <span class="drag-handle" title="${state.sortMode === 'manual' ? 'Drag to reorder' : 'Switch to manual sort to reorder'}">⠿</span>
        <span class="track-num">${displayIdx + 1}</span>
        <input class="track-title" type="text" value="${escapeAttr(t.title)}" placeholder="Title" />
        <input class="track-artist" type="text" value="${escapeAttr(t.artist || '')}" placeholder="Artist" />
        <div class="track-audio ${hasAudio ? 'has-audio' : ''}">
          ${hasAudio
            ? `<button class="audio-play" title="Preview">▶</button>
               <span class="audio-chip" title="${escapeAttr(t.audioFile)}">${escapeAttr(truncate(t.audioFile, 14))}${durationLabel}</span>
               <button class="audio-remove" title="Remove audio">✕</button>`
            : `<label class="audio-attach-btn" title="Attach an MP3, or drag one onto this row">
                 + mp3
                 <input type="file" accept="audio/mpeg,.mp3" hidden />
               </label>`
          }
        </div>
        <button class="track-remove" title="Remove track">✕</button>
      `;

      const titleInput = row.querySelector('.track-title');
      const artistInput = row.querySelector('.track-artist');
      let preEditSnapshot = null;

      [titleInput, artistInput].forEach((input) => {
        input.addEventListener('focus', () => {
          preEditSnapshot = snapshotTracks();
        });
        input.addEventListener('blur', () => {
          if (preEditSnapshot && JSON.stringify(preEditSnapshot) !== JSON.stringify(state.tracks)) {
            state.undoStack.push(preEditSnapshot);
            if (state.undoStack.length > 50) state.undoStack.shift();
            state.redoStack = [];
            updateUndoRedoButtons();
          }
          preEditSnapshot = null;
        });
        input.addEventListener('keydown', (e) => {
          if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
            e.preventDefault();
            if (state.sortMode !== 'manual') {
              showToast('Switch to manual sort to reorder');
              return;
            }
            moveTrack(t._index, e.key === 'ArrowUp' ? -1 : 1);
          }
        });
      });

      titleInput.addEventListener('input', () => {
        state.tracks[t._index].title = titleInput.value;
        scheduleSave();
      });
      artistInput.addEventListener('input', () => {
        state.tracks[t._index].artist = artistInput.value;
        scheduleSave();
      });

      row.querySelector('.track-remove').addEventListener('click', () => {
        pushUndo();
        state.tracks.splice(t._index, 1);
        renderTracks();
        saveTracks();
      });

      if (hasAudio) {
        row.querySelector('.audio-remove').addEventListener('click', async () => {
          try {
            const data = await api(
              `/api/playlists/${encodeURIComponent(state.currentName)}/tracks/${t.id}/audio`,
              { method: 'DELETE' }
            );
            state.tracks[t._index] = { ...state.tracks[t._index], ...data.track };
            renderTracks();
            renderPoolFiles();
            refreshSidebarCounts();
          } catch (e) {
            showToast(e.message);
          }
        });
        row.querySelector('.audio-play').addEventListener('click', () => {
          startPlayback(state.tracks[t._index]);
        });
      } else {
        const fileInput = row.querySelector('.audio-attach-btn input');
        fileInput.addEventListener('change', async () => {
          const file = fileInput.files[0];
          if (!file) return;
          await attachAudioToTrack(t.id, file, t._index);
        });
      }

      // ---- drag & drop: reordering rows vs. dropping an external mp3 file onto a row ----
      row.addEventListener('dragstart', (e) => {
        state.dragIndex = t._index;
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      row.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        document.querySelectorAll('.track-row.drag-over, .track-row.file-drop-over')
          .forEach((r) => r.classList.remove('drag-over', 'file-drop-over'));
      });
      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        const isFileDrag = e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
        row.classList.toggle('file-drop-over', isFileDrag);
        row.classList.toggle('drag-over', !isFileDrag);
      });
      row.addEventListener('dragleave', () => {
        row.classList.remove('drag-over');
        row.classList.remove('file-drop-over');
      });
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('drag-over');
        row.classList.remove('file-drop-over');

        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
          const file = Array.from(e.dataTransfer.files).find((f) => /\.mp3$/i.test(f.name));
          if (file) {
            attachAudioToTrack(t.id, file, t._index);
          } else {
            showToast('Only .mp3 files are supported');
          }
          return;
        }

        const from = state.dragIndex;
        const to = t._index;
        if (from === null || from === to) return;
        pushUndo();
        const [moved] = state.tracks.splice(from, 1);
        state.tracks.splice(to, 0, moved);
        state.dragIndex = null;
        renderTracks();
        saveTracks();
      });

      el.trackList.appendChild(row);
    });
  }

  let saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; saveTracks(); }, 500);
  }

  // Typing autosaves after half a second. Anything that switches, renames, copies or deletes
  // the playlist saves first, so the last edit can't be lost or (worse) saved over the playlist
  // that's opened next.
  async function flushPendingSave() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    await saveTracks();
  }

  // Closing or reloading the tab within that half second: send the save anyway.
  window.addEventListener('pagehide', () => {
    if (!saveTimer || !state.currentName) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    fetch(`/api/playlists/${encodeURIComponent(state.currentName)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tracks: state.tracks }),
      keepalive: true,
    }).catch(() => {});
  });

  async function saveTracks() {
    if (!state.currentName) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    try {
      const data = await api(`/api/playlists/${encodeURIComponent(state.currentName)}`, {
        method: 'PUT',
        body: JSON.stringify({ tracks: state.tracks }),
      });
      // backfill server-assigned defaults (e.g. createdAt on a just-added
      // track) without touching fields the person might be mid-editing
      data.tracks.forEach((serverTrack) => {
        const local = state.tracks.find((t) => t.id === serverTrack.id);
        if (local && local.createdAt == null) local.createdAt = serverTrack.createdAt;
      });
      refreshSidebarCounts();
    } catch (e) {
      showToast('Failed to save: ' + e.message);
    }
  }

  // ---------- attach audio to a single track ----------

  async function attachAudioToTrack(id, file, index) {
    if (!/\.mp3$/i.test(file.name)) {
      showToast('Only .mp3 files are supported');
      return;
    }
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch(
        `/api/playlists/${encodeURIComponent(state.currentName)}/tracks/${id}/audio`,
        { method: 'POST', body: formData }
      );
      if (!res.ok) throw new Error((await res.json()).error || 'Upload failed');
      const data = await res.json();
      state.tracks[index] = { ...state.tracks[index], ...data.track };
      renderTracks();
      refreshSidebarCounts();
    } catch (e) {
      showToast(e.message);
    }
  }

  // ---------- unassigned pool files ----------

  function renderPoolFiles() {
    el.poolFilesWrap.classList.toggle('hidden', state.poolFiles.length === 0);
    el.poolList.innerHTML = '';

    state.poolFiles.forEach((entry) => {
      const row = document.createElement('div');
      row.className = 'pool-row';

      const tracksWithoutAudio = state.tracks.filter((t) => !t.audioFile);
      const options = tracksWithoutAudio
        .map((t) => `<option value="${t.id}">${escapeAttr(t.artist ? `${t.artist} - ${t.title}` : t.title)}</option>`)
        .join('');

      const durationLabel = entry.durationSec != null ? ` · ${formatDuration(entry.durationSec)}` : '';

      row.innerHTML = `
        <span class="pool-filename" title="${escapeAttr(entry.originalName)}">🎵 ${escapeAttr(truncate(entry.originalName, 34))}${durationLabel}</span>
        <select class="pool-select">
          <option value="">Assign to track…</option>
          ${options}
        </select>
        <button class="pool-discard" title="Discard file">✕</button>
      `;

      row.querySelector('.pool-select').addEventListener('change', async (e) => {
        const trackId = e.target.value;
        if (!trackId) return;
        try {
          const data = await api(
            `/api/playlists/${encodeURIComponent(state.currentName)}/tracks/${trackId}/audio/from-pool`,
            { method: 'POST', body: JSON.stringify({ poolName: entry.poolName }) }
          );
          const idx = state.tracks.findIndex((t) => t.id === trackId);
          if (idx !== -1) state.tracks[idx] = { ...state.tracks[idx], ...data.track };
          state.poolFiles = data.poolFiles;
          renderTracks();
          renderPoolFiles();
          refreshSidebarCounts();
          showToast(`Assigned to "${data.track.title || 'track'}"`);
        } catch (err) {
          showToast(err.message);
        }
      });

      row.querySelector('.pool-discard').addEventListener('click', async () => {
        try {
          const data = await api(
            `/api/playlists/${encodeURIComponent(state.currentName)}/pool/${encodeURIComponent(entry.poolName)}`,
            { method: 'DELETE' }
          );
          state.poolFiles = data.poolFiles;
          renderPoolFiles();
        } catch (err) {
          showToast(err.message);
        }
      });

      el.poolList.appendChild(row);
    });
  }

  // ---------- bulk audio upload ----------

  // Large drops are sent in batches so one request never carries hundreds of MB, and the
  // 300-files-per-request limit doesn't apply to the drop as a whole.
  const UPLOAD_BATCH_FILES = 20;
  const UPLOAD_BATCH_BYTES = 200 * 1024 * 1024;
  let bulkUploading = false;

  async function bulkUploadAudio(fileList) {
    if (!state.currentName) return;
    if (bulkUploading) { showToast('Still uploading the last batch of files'); return; }
    const files = Array.from(fileList);
    if (!files.length) return;
    const tooBig = files.filter((f) => f.size > 40 * 1024 * 1024);
    const toSend = files.filter((f) => f.size <= 40 * 1024 * 1024);

    const batches = [];
    let current = [];
    let bytes = 0;
    toSend.forEach((f) => {
      if (current.length && (current.length >= UPLOAD_BATCH_FILES || bytes + f.size > UPLOAD_BATCH_BYTES)) {
        batches.push(current);
        current = [];
        bytes = 0;
      }
      current.push(f);
      bytes += f.size;
    });
    if (current.length) batches.push(current);

    await flushPendingSave();
    const playlistName = state.currentName;
    const totals = { matched: 0, unmatched: 0, skipped: 0 };
    bulkUploading = true;
    try {
      for (let i = 0; i < batches.length; i++) {
        if (batches.length > 1) showToast(`Uploading ${i + 1} of ${batches.length}…`);
        const formData = new FormData();
        batches[i].forEach((f) => formData.append('files', f));
        const res = await fetch(
          `/api/playlists/${encodeURIComponent(playlistName)}/audio/bulk`,
          { method: 'POST', body: formData }
        );
        if (res.status === 401) { window.location.href = '/login'; return; }
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Upload failed');
        const data = await res.json();
        totals.matched += data.matchedCount;
        totals.unmatched += data.unmatched.length;
        totals.skipped += data.skippedNonMp3;
        if (state.currentName === playlistName) {
          state.tracks = data.tracks;
          state.poolFiles = data.poolFiles;
          renderTracks();
          renderPoolFiles();
          refreshSidebarCounts();
        }
      }
      const parts = [`Matched ${totals.matched} file${totals.matched === 1 ? '' : 's'}`];
      if (totals.unmatched) parts.push(`${totals.unmatched} unmatched`);
      if (totals.skipped) parts.push(`${totals.skipped} skipped (not .mp3)`);
      if (tooBig.length) parts.push(`${tooBig.length} over 40 MB skipped`);
      showToast(parts.join(' · '));
    } catch (e) {
      showToast(e.message);
    } finally {
      bulkUploading = false;
    }
  }

  // ---------- preview player ----------

  let audioCtx = null;
  let currentPeaks = null;
  let waveformRAF = null;

  function getAudioCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }

  function drawWaveform() {
    const canvas = el.playerWaveform;
    const ctx2d = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx2d.clearRect(0, 0, w, h);
    if (!currentPeaks) return;
    const mid = h / 2;
    ctx2d.fillStyle = 'rgba(239,231,214,0.35)';
    for (let x = 0; x < w; x++) {
      const amp = Math.max(currentPeaks[x] * mid, 1);
      ctx2d.fillRect(x, mid - amp, 1, amp * 2);
    }
    if (el.playerAudio.duration) {
      const progressX = (el.playerAudio.currentTime / el.playerAudio.duration) * w;
      ctx2d.fillStyle = '#c9992b';
      ctx2d.fillRect(progressX, 0, 2, h);
    }
  }

  function waveformLoop() {
    drawWaveform();
    if (!el.playerAudio.paused) waveformRAF = requestAnimationFrame(waveformLoop);
  }

  el.playerAudio.addEventListener('play', () => {
    cancelAnimationFrame(waveformRAF);
    waveformLoop();
  });
  el.playerAudio.addEventListener('pause', () => {
    cancelAnimationFrame(waveformRAF);
    drawWaveform();
  });
  el.playerAudio.addEventListener('seeked', drawWaveform);

  el.playerWaveform.addEventListener('click', (e) => {
    if (!el.playerAudio.duration) return;
    const rect = el.playerWaveform.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    el.playerAudio.currentTime = Math.max(0, Math.min(1, ratio)) * el.playerAudio.duration;
  });

  async function loadWaveform(url) {
    currentPeaks = null;
    drawWaveform();
    try {
      const res = await fetch(url);
      const arrayBuffer = await res.arrayBuffer();
      const audioBuffer = await getAudioCtx().decodeAudioData(arrayBuffer);
      const channel = audioBuffer.getChannelData(0);
      const width = el.playerWaveform.width;
      const samplesPerPixel = Math.max(1, Math.floor(channel.length / width));
      const peaks = new Float32Array(width);
      for (let x = 0; x < width; x++) {
        let max = 0;
        const start = x * samplesPerPixel;
        const end = Math.min(start + samplesPerPixel, channel.length);
        for (let i = start; i < end; i++) {
          const v = Math.abs(channel[i]);
          if (v > max) max = v;
        }
        peaks[x] = max;
      }
      currentPeaks = peaks;
      drawWaveform();
    } catch (e) {
      // Decoding can fail on odd files — the native controls still work fine without a waveform.
    }
  }

  function buildQueueStartingAt(track) {
    const order = sortedTrackIndices().map((i) => state.tracks[i]).filter((t) => t.audioFile);
    const pos = order.findIndex((t) => t.id === track.id);
    return { queue: order, pos: pos === -1 ? 0 : pos };
  }

  function updatePlayerNavButtons() {
    el.playerPrev.disabled = state.playerQueuePos <= 0;
    el.playerNext.disabled = state.playerQueuePos >= state.playerQueue.length - 1;
  }

  function openTrackAtQueuePos() {
    const track = state.playerQueue[state.playerQueuePos];
    if (!track) { closePlayer(); return; }
    el.playerTitle.textContent = track.title || '(untitled)';
    el.playerArtist.textContent = track.artist || '';
    const url = `/api/playlists/${encodeURIComponent(state.currentName)}/tracks/${track.id}/audio/file`;
    el.playerAudio.src = url;
    el.playerBar.classList.remove('hidden');
    el.playerAudio.play().catch(() => {});
    loadWaveform(url);
    updatePlayerNavButtons();
  }

  function startPlayback(track) {
    const { queue, pos } = buildQueueStartingAt(track);
    state.playerQueue = queue;
    state.playerQueuePos = pos;
    openTrackAtQueuePos();
  }

  function playNext() {
    if (state.playerQueuePos < state.playerQueue.length - 1) {
      state.playerQueuePos++;
      openTrackAtQueuePos();
    }
  }

  function playPrev() {
    if (state.playerQueuePos > 0) {
      state.playerQueuePos--;
      openTrackAtQueuePos();
    }
  }

  function closePlayer() {
    cancelAnimationFrame(waveformRAF);
    currentPeaks = null;
    state.playerQueue = [];
    state.playerQueuePos = -1;
    el.playerAudio.pause();
    el.playerAudio.removeAttribute('src');
    el.playerAudio.load();
    el.playerBar.classList.add('hidden');
    drawWaveform();
    updatePlayerNavButtons();
  }

  el.playerAudio.addEventListener('ended', () => {
    if (state.playerQueuePos < state.playerQueue.length - 1) playNext();
  });
  el.playerPrev.addEventListener('click', playPrev);
  el.playerNext.addEventListener('click', playNext);
  el.playerClose.addEventListener('click', closePlayer);

  // ---------- event wiring: playlists ----------

  el.createPlaylistBtn.addEventListener('click', async () => {
    const name = el.newPlaylistName.value.trim();
    if (!name) return;
    const folder = el.newPlaylistFolder.value.trim();
    const tracksText = el.newPlaylistTracks.value.trim();
    try {
      await api('/api/playlists', { method: 'POST', body: JSON.stringify({ name, folder }) });
      let importResult = null;
      if (tracksText) {
        importResult = await api(`/api/playlists/${encodeURIComponent(name)}/import`, {
          method: 'POST',
          body: JSON.stringify({ text: tracksText, mode: 'replace' }),
        });
      }
      el.newPlaylistName.value = '';
      el.newPlaylistFolder.value = '';
      el.newPlaylistTracks.value = '';
      await loadPlaylists(name);
      const trackCount = importResult ? importResult.tracks.length : 0;
      showToast(trackCount ? `Created "${name}" with ${trackCount} track${trackCount === 1 ? '' : 's'}` : `Created "${name}"`);
    } catch (e) {
      showToast(e.message);
    }
  });
  el.newPlaylistName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') el.createPlaylistBtn.click();
  });

  el.playlistTitle.addEventListener('blur', async () => {
    const newName = el.playlistTitle.textContent.trim();
    if (!newName || newName === state.currentName) {
      el.playlistTitle.textContent = state.currentName;
      return;
    }
    try {
      await flushPendingSave();
      await api(`/api/playlists/${encodeURIComponent(state.currentName)}/rename`, {
        method: 'PUT',
        body: JSON.stringify({ newName }),
      });
      state.currentName = newName;
      await loadPlaylists(newName);
      showToast('Renamed playlist');
    } catch (e) {
      el.playlistTitle.textContent = state.currentName;
      showToast(e.message);
    }
  });
  el.playlistTitle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); el.playlistTitle.blur(); }
  });

  el.playlistFolder.addEventListener('blur', async () => {
    const newFolder = el.playlistFolder.textContent.trim();
    if (newFolder === (state.currentFolder || '')) return;
    try {
      const data = await api(`/api/playlists/${encodeURIComponent(state.currentName)}/folder`, {
        method: 'PUT',
        body: JSON.stringify({ folder: newFolder }),
      });
      state.currentFolder = data.folder;
      el.playlistFolder.textContent = data.folder || '';
      const pl = state.playlists.find((p) => p.name === state.currentName);
      if (pl) pl.folder = data.folder;
      renderSidebar();
    } catch (e) {
      showToast(e.message);
    }
  });
  el.playlistFolder.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); el.playlistFolder.blur(); }
  });

  // ---------- cover art ----------

  function renderCover(cover) {
    if (cover) {
      el.coverImg.src = `/api/playlists/${encodeURIComponent(state.currentName)}/cover?t=${Date.now()}`;
      el.coverThumb.classList.remove('hidden');
      el.coverUploadLabel.classList.add('hidden');
    } else {
      el.coverThumb.classList.add('hidden');
      el.coverUploadLabel.classList.remove('hidden');
    }
  }

  el.coverInput.addEventListener('change', async () => {
    const file = el.coverInput.files[0];
    el.coverInput.value = '';
    if (!file) return;
    if (!/^image\/(jpeg|png)$/.test(file.type)) {
      showToast('Only JPEG or PNG images are supported');
      return;
    }
    const formData = new FormData();
    formData.append('cover', file);
    try {
      const res = await fetch(`/api/playlists/${encodeURIComponent(state.currentName)}/cover`, {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Upload failed');
      const data = await res.json();
      renderCover(data.cover);
      const pl = state.playlists.find((p) => p.name === state.currentName);
      if (pl) pl.hasCover = true;
      showToast('Cover art updated');
    } catch (e) {
      showToast(e.message);
    }
  });

  el.coverRemoveBtn.addEventListener('click', async () => {
    try {
      await api(`/api/playlists/${encodeURIComponent(state.currentName)}/cover`, { method: 'DELETE' });
      renderCover(null);
      const pl = state.playlists.find((p) => p.name === state.currentName);
      if (pl) pl.hasCover = false;
    } catch (e) {
      showToast(e.message);
    }
  });

  el.duplicatePlaylistBtn.addEventListener('click', async () => {
    if (!state.currentName) return;
    const suggested = `${state.currentName} (copy)`;
    const newName = prompt('Name for the duplicated playlist:', suggested);
    if (!newName || !newName.trim()) return;
    try {
      await flushPendingSave();
      await api(`/api/playlists/${encodeURIComponent(state.currentName)}/duplicate`, {
        method: 'POST',
        body: JSON.stringify({ newName: newName.trim() }),
      });
      await loadPlaylists(newName.trim());
      showToast(`Duplicated as "${newName.trim()}"`);
    } catch (e) {
      showToast(e.message);
    }
  });

  el.deletePlaylistBtn.addEventListener('click', async () => {
    if (!state.currentName) return;
    if (!confirm(`Delete playlist "${state.currentName}"? You can restore it from Recently Deleted within 7 days.`)) return;
    const name = state.currentName;
    try {
      await flushPendingSave();
      await api(`/api/playlists/${encodeURIComponent(name)}`, { method: 'DELETE' });
      state.currentName = null;
      state.tracks = [];
      closePlayer();
      el.playlistView.classList.add('hidden');
      el.noPlaylistState.classList.remove('hidden');
      await loadPlaylists();
      showToast(`Deleted "${name}"`);
    } catch (e) {
      showToast(e.message);
    }
  });

  // ---------- event wiring: import ----------

  // ---------- import from a .txt / .m3u / .cue file ----------

  function m3uToLines(text) {
    const lines = [];
    text.split(/\r?\n/).forEach((raw) => {
      const line = raw.trim();
      if (!line || line.startsWith('#EXTM3U')) return;
      if (line.startsWith('#EXTINF:')) {
        const label = line.split(',').slice(1).join(',').trim();
        if (label) lines.push(label);
        return;
      }
      if (line.startsWith('#')) return; // other metadata comments
      // a bare path/filename line with no preceding EXTINF — use the filename
      const base = line.split(/[\\/]/).pop().replace(/\.[a-z0-9]{2,4}$/i, '');
      if (base) lines.push(base);
    });
    return lines.join('\n');
  }

  function cueToLines(text) {
    const lines = [];
    let title = null;
    let performer = null;
    const flush = () => {
      if (title) lines.push(performer ? `${performer} - ${title}` : title);
      title = null;
      performer = null;
    };
    text.split(/\r?\n/).forEach((raw) => {
      const line = raw.trim();
      if (/^TRACK\s+\d+/i.test(line)) flush();
      const titleMatch = /^TITLE\s+"([^"]*)"/i.exec(line);
      const perfMatch = /^PERFORMER\s+"([^"]*)"/i.exec(line);
      if (titleMatch) title = titleMatch[1];
      if (perfMatch) performer = perfMatch[1];
    });
    flush();
    return lines.join('\n');
  }

  el.importFileInput.addEventListener('change', async () => {
    const file = el.importFileInput.files[0];
    el.importFileInput.value = '';
    if (!file) return;
    const text = await file.text();
    const ext = file.name.split('.').pop().toLowerCase();
    let converted = text;
    if (ext === 'm3u' || ext === 'm3u8') converted = m3uToLines(text);
    else if (ext === 'cue') converted = cueToLines(text);

    if (!converted.trim()) {
      showToast('Could not find any tracks in that file');
      return;
    }
    el.importText.value = converted;
    showToast(`Loaded ${converted.split('\n').filter(Boolean).length} line(s) from ${file.name} — review below, then Import`);
  });

  el.importReplaceBtn.addEventListener('click', () => {
    const audioCount = state.tracks.filter((t) => t.audioFile).length;
    if (audioCount > 0) {
      const ok = confirm(
        `${audioCount} track${audioCount === 1 ? '' : 's'} in this playlist ${audioCount === 1 ? 'has' : 'have'} audio attached. ` +
        `Replacing the tracklist will delete that attached audio. Continue?`
      );
      if (!ok) return;
    }
    doImport('replace');
  });
  el.importAppendBtn.addEventListener('click', () => doImport('append'));

  async function doImport(mode) {
    if (!state.currentName) return;
    const text = el.importText.value;
    if (!text.trim()) { showToast('Paste some text first'); return; }
    try {
      const data = await api(`/api/playlists/${encodeURIComponent(state.currentName)}/import`, {
        method: 'POST',
        body: JSON.stringify({ text, mode }),
      });
      state.tracks = data.tracks;
      el.importText.value = '';
      resetHistory();
      renderTracks();
      renderPoolFiles();
      refreshSidebarCounts();

      const parts = [`Imported ${mode === 'append' ? 'and appended ' : ''}tracks`];
      if (data.duplicatesSkipped) {
        parts.push(`${data.duplicatesSkipped} duplicate${data.duplicatesSkipped === 1 ? '' : 's'} skipped`);
      }
      showToast(parts.join(' · '));
    } catch (e) {
      showToast(e.message);
    }
  }

  // ---------- event wiring: tracks toolbar ----------

  el.addTrackBtn.addEventListener('click', () => {
    pushUndo();
    state.tracks.push({ id: trackId(), title: '', artist: '', audioFile: null });
    renderTracks();
    saveTracks();
    const inputs = el.trackList.querySelectorAll('.track-title');
    if (inputs.length) inputs[inputs.length - 1].focus();
  });

  el.filterInput.addEventListener('input', renderTracks);
  el.missingAudioCheckbox.addEventListener('change', renderTracks);

  el.sortSelect.addEventListener('change', () => {
    state.sortMode = el.sortSelect.value;
    renderTracks();
  });

  el.shuffleBtn.addEventListener('click', () => {
    if (state.tracks.length < 2) return;
    pushUndo();
    for (let i = state.tracks.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [state.tracks[i], state.tracks[j]] = [state.tracks[j], state.tracks[i]];
    }
    state.sortMode = 'manual';
    el.sortSelect.value = 'manual';
    renderTracks();
    saveTracks();
    showToast('Shuffled');
  });

  el.findReplaceToggleBtn.addEventListener('click', () => {
    el.findReplacePanel.classList.toggle('hidden');
    if (!el.findReplacePanel.classList.contains('hidden')) el.findInput.focus();
  });

  el.findReplaceApplyBtn.addEventListener('click', () => {
    const find = el.findInput.value;
    if (!find) { showToast('Enter something to find first'); return; }
    const scope = el.findReplaceScope.value; // 'both' | 'title' | 'artist'
    const replace = el.replaceInput.value;
    const pattern = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');

    let count = 0;
    pushUndo();
    state.tracks.forEach((t) => {
      if (scope !== 'artist' && pattern.test(t.title)) {
        t.title = t.title.replace(pattern, () => replace);
        count++;
      }
      pattern.lastIndex = 0;
      if (scope !== 'title' && pattern.test(t.artist || '')) {
        t.artist = (t.artist || '').replace(pattern, () => replace);
        count++;
      }
      pattern.lastIndex = 0;
    });

    if (count === 0) {
      state.undoStack.pop(); // nothing changed — don't leave a no-op undo entry
      updateUndoRedoButtons();
      showToast('No matches found');
      return;
    }
    renderTracks();
    saveTracks();
    showToast(`Replaced in ${count} field${count === 1 ? '' : 's'}`);
  });

  // ---------- event wiring: export ----------

  el.exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    el.exportMenu.classList.toggle('hidden');
  });
  document.addEventListener('click', () => el.exportMenu.classList.add('hidden'));
  el.exportMenu.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!state.currentName) return;
      const format = btn.dataset.format;
      flushPendingSave().then(() => downloadFrom(`/api/playlists/${encodeURIComponent(state.currentName)}/export?format=${format}`));
      el.exportMenu.classList.add('hidden');
    });
  });

  el.exportAudioBtn.addEventListener('click', () => {
    if (!state.currentName) return;
    if (!state.tracks.some((t) => t.audioFile)) {
      showToast('No MP3s attached yet — drop some in below first');
      return;
    }
    flushPendingSave().then(() => downloadFrom(`/api/playlists/${encodeURIComponent(state.currentName)}/export-audio`));
  });

  // ---------- event wiring: bulk audio dropzone ----------

  el.audioBulkInput.addEventListener('change', () => {
    bulkUploadAudio(el.audioBulkInput.files);
    el.audioBulkInput.value = '';
  });

  ['dragenter', 'dragover'].forEach((evt) => {
    el.audioDropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      el.audioDropzone.classList.add('drag-over');
    });
  });
  ['dragleave', 'drop'].forEach((evt) => {
    el.audioDropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      el.audioDropzone.classList.remove('drag-over');
    });
  });
  el.audioDropzone.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files.length) {
      bulkUploadAudio(e.dataTransfer.files);
    }
  });

  // ---------- keyboard shortcuts ----------

  document.addEventListener('keydown', (e) => {
    const activeTag = document.activeElement ? document.activeElement.tagName : '';
    const isEditable =
      (document.activeElement && document.activeElement.isContentEditable) ||
      activeTag === 'INPUT' ||
      activeTag === 'TEXTAREA';

    const mod = e.ctrlKey || e.metaKey;

    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      e.preventDefault();
      undo();
      return;
    }
    if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
      e.preventDefault();
      redo();
      return;
    }
    if (e.key === '/' && !isEditable) {
      e.preventDefault();
      el.globalSearchInput.focus();
    }
  });

  // ---------- recently deleted ----------

  function relativeTime(iso) {
    const diffMs = Date.now() - new Date(iso).getTime();
    const days = Math.floor(diffMs / 86400000);
    if (days >= 1) return `${days} day${days === 1 ? '' : 's'} ago`;
    const hours = Math.floor(diffMs / 3600000);
    if (hours >= 1) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    const mins = Math.max(1, Math.floor(diffMs / 60000));
    return `${mins} min${mins === 1 ? '' : 's'} ago`;
  }

  async function openDeletedPanel() {
    el.deletedPanel.classList.remove('hidden');
    try {
      const list = await api('/api/deleted-playlists');
      el.deletedEmptyHint.classList.toggle('hidden', list.length > 0);
      el.deletedList.innerHTML = '';
      list.forEach((item) => {
        const row = document.createElement('div');
        row.className = 'deleted-row';
        row.innerHTML = `
          <div class="deleted-info">
            <span class="deleted-name"></span>
            <span class="deleted-meta">${item.count} track${item.count === 1 ? '' : 's'} · deleted ${relativeTime(item.deletedAt)}</span>
          </div>
          <button class="btn btn-ghost deleted-restore-btn">Restore</button>
          <button class="btn btn-danger-ghost deleted-purge-btn">Delete forever</button>
        `;
        row.querySelector('.deleted-name').textContent = item.name;
        row.querySelector('.deleted-restore-btn').addEventListener('click', async () => {
          try {
            const data = await api(`/api/deleted-playlists/${encodeURIComponent(item.key)}/restore`, { method: 'POST' });
            showToast(`Restored "${data.name}"`);
            await loadPlaylists(data.name);
            el.deletedPanel.classList.add('hidden');
          } catch (e) {
            showToast(e.message);
          }
        });
        row.querySelector('.deleted-purge-btn').addEventListener('click', async () => {
          if (!confirm(`Permanently delete "${item.name}"? This cannot be undone.`)) return;
          try {
            await api(`/api/deleted-playlists/${encodeURIComponent(item.key)}`, { method: 'DELETE' });
            openDeletedPanel();
          } catch (e) {
            showToast(e.message);
          }
        });
        el.deletedList.appendChild(row);
      });
    } catch (e) {
      showToast(e.message);
    }
  }

  el.recentlyDeletedBtn.addEventListener('click', openDeletedPanel);
  el.deletedPanelClose.addEventListener('click', () => el.deletedPanel.classList.add('hidden'));
  el.deletedPanel.addEventListener('click', (e) => {
    if (e.target === el.deletedPanel) el.deletedPanel.classList.add('hidden');
  });

  // ---------- whole-library backup / restore ----------

  el.backupBtn.addEventListener('click', () => flushPendingSave().then(() => downloadFrom('/api/backup')));

  el.restoreInput.addEventListener('change', async () => {
    const file = el.restoreInput.files[0];
    el.restoreInput.value = '';
    if (!file) return;
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch (e) {
      showToast('That file isn\'t valid JSON');
      return;
    }
    const playlists = parsed && (parsed.playlists || parsed);
    if (!playlists || typeof playlists !== 'object' || Array.isArray(playlists)) {
      showToast('That doesn\'t look like a backup file from this app');
      return;
    }
    const count = Object.keys(playlists).length;
    const mode = await askRestoreMode(`${file.name} has ${count} playlist${count === 1 ? '' : 's'}.`);
    if (!mode) return;
    try {
      await flushPendingSave();
      const data = await api('/api/backup/restore', {
        method: 'POST',
        body: JSON.stringify({ mode, playlists }),
      });
      if (mode === 'replace') {
        state.currentName = null;
        state.tracks = [];
        closePlayer();
        el.playlistView.classList.add('hidden');
        el.noPlaylistState.classList.remove('hidden');
      }
      await loadPlaylists();
      const parts = [`Restored ${data.added} playlist${data.added === 1 ? '' : 's'}`];
      if (data.skipped.length) parts.push(`${data.skipped.length} skipped (name already exists)`);
      if (data.invalid && data.invalid.length) parts.push(`${data.invalid.length} skipped (unusable name)`);
      showToast(parts.join(' · '));
    } catch (e) {
      showToast(e.message);
    }
  });

  // Resolves to 'merge', 'replace' or null (cancelled).
  function askRestoreMode(summary) {
    return new Promise((resolve) => {
      el.restoreSummary.textContent = summary;
      el.restorePanel.classList.remove('hidden');
      const done = (mode) => {
        el.restorePanel.classList.add('hidden');
        el.restoreMergeBtn.onclick = el.restoreReplaceBtn.onclick = el.restoreCancelBtn.onclick = el.restorePanelClose.onclick = null;
        resolve(mode);
      };
      el.restoreMergeBtn.onclick = () => done('merge');
      el.restoreReplaceBtn.onclick = () => {
        if (confirm('Replace all your playlists with the ones in this backup? The current ones go to Recently deleted.')) done('replace');
      };
      el.restoreCancelBtn.onclick = () => done(null);
      el.restorePanelClose.onclick = () => done(null);
      el.restoreMergeBtn.focus();
    });
  }

  // ---------- about ----------

  el.aboutBtn.addEventListener('click', () => el.aboutPanel.classList.remove('hidden'));
  el.aboutPanelClose.addEventListener('click', () => el.aboutPanel.classList.add('hidden'));
  el.aboutPanel.addEventListener('click', (e) => {
    if (e.target === el.aboutPanel) el.aboutPanel.classList.add('hidden');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    el.aboutPanel.classList.add('hidden');
    el.deletedPanel.classList.add('hidden');
  });

  // ---------- theme ----------

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    el.themeToggle.textContent = theme === 'dark' ? '◑' : '◐';
  }

  // The key keeps its old name so an existing theme choice carries over.
  let savedTheme = 'light';
  try { savedTheme = localStorage.getItem('tracklist-theme') || 'light'; } catch (e) {}
  applyTheme(savedTheme);

  el.themeToggle.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem('tracklist-theme', next); } catch (e) {}
  });

  // ---------- auth ----------

  fetch('/api/auth-status')
    .then((r) => r.json())
    .then((data) => {
      el.logoutBtn.classList.toggle('hidden', !data.enabled);
      if (data.version) el.aboutVersion.textContent = `v${data.version}`;
      if (data.repo) {
        el.aboutRepo.href = data.repo;
        el.aboutRepo.textContent = data.repo.replace(/^https?:\/\//, '');
      }
    })
    .catch(() => {});

  el.logoutBtn.addEventListener('click', async () => {
    try { await fetch('/logout', { method: 'POST' }); } catch (e) {}
    window.location.href = '/login';
  });

  // ---------- init ----------
  loadPlaylists().catch((e) => showToast('Failed to load playlists: ' + e.message));
})();
