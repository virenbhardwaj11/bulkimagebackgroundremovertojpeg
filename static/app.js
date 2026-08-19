/**
 * PDF Background Removal Studio – Frontend Logic
 * Handles: file upload, SSE progress, gallery rendering, rotation, reprocessing, ZIP download
 */

// ── State ──
let selectedFiles = [];
let currentJobId = null;
let currentPages = [];
let selectedPageIds = new Set();

// ── DOM Elements ──
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const dropZone = $('#drop-zone');
const fileInput = $('#file-input');
const browseBtn = $('#browse-btn');
const fileListWrap = $('#file-list-wrap');
const fileList = $('#file-list');
const fileCountLabel = $('#file-count-label');
const clearBtn = $('#clear-btn');
const startBtn = $('#start-btn');

const uploadSection = $('#upload-section');
const progressSection = $('#progress-section');
const resultsSection = $('#results-section');

const progressBar = $('#progress-bar');
const progressStatus = $('#progress-status');
const statPdfs = $('#stat-pdfs');
const statPages = $('#stat-pages');
const statProcessed = $('#stat-processed');
const statPercent = $('#stat-percent');
const statSpeed = $('#stat-speed');
const statErrors = $('#stat-errors');

const resultsCount = $('#results-count');
const gallery = $('#gallery');
const downloadAllBtn = $('#download-all-btn');
const selectAllCb = $('#select-all-cb');
const rotateSelectedBtn = $('#rotate-selected-btn');

const modal = $('#reprocess-modal');
const modalClose = $('#modal-close');
const modalOrigImg = $('#modal-original-img');
const modalProcImg = $('#modal-processed-img');
const modalReprocessBtn = $('#modal-reprocess-btn');
const ctrlAlpha = $('#ctrl-alpha');
const ctrlFg = $('#ctrl-fg');
const ctrlFgVal = $('#ctrl-fg-val');
const ctrlBg = $('#ctrl-bg');
const ctrlBgVal = $('#ctrl-bg-val');
const ctrlErode = $('#ctrl-erode');
const ctrlErodeVal = $('#ctrl-erode-val');

let modalPageId = null;

// ── Utility ──
function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

// ── File Selection ──
function handleFiles(files) {
  const pdfs = Array.from(files).filter(f => f.name.toLowerCase().endsWith('.pdf'));
  if (!pdfs.length) return;
  selectedFiles = pdfs;
  renderFileList();
}

function renderFileList() {
  if (!selectedFiles.length) {
    fileListWrap.classList.add('hidden');
    return;
  }
  fileListWrap.classList.remove('hidden');
  fileCountLabel.textContent = `${selectedFiles.length} PDF${selectedFiles.length > 1 ? 's' : ''} selected`;
  fileList.innerHTML = selectedFiles.map(f => `
    <li>
      <span class="file-icon">📄</span>
      <span class="file-name">${f.name}</span>
      <span class="file-size">${formatSize(f.size)}</span>
    </li>
  `).join('');
}

// Drop zone events
dropZone.addEventListener('click', () => fileInput.click());
browseBtn.addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
fileInput.addEventListener('change', () => handleFiles(fileInput.files));

dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  handleFiles(e.dataTransfer.files);
});

clearBtn.addEventListener('click', () => {
  selectedFiles = [];
  fileInput.value = '';
  renderFileList();
});

// ── Upload & Start ──
startBtn.addEventListener('click', startProcessing);

async function startProcessing() {
  if (!selectedFiles.length) return;

  startBtn.disabled = true;
  startBtn.innerHTML = '<span class="spinner"></span> Uploading…';

  const formData = new FormData();
  selectedFiles.forEach(f => formData.append('files', f));

  try {
    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    if (!res.ok) {
      const err = await res.json();
      alert('Upload failed: ' + (err.detail || 'Unknown error'));
      startBtn.disabled = false;
      startBtn.innerHTML = '▶ Start Processing';
      return;
    }
    const data = await res.json();
    currentJobId = data.job_id;

    // Switch to progress view
    uploadSection.classList.add('hidden');
    progressSection.classList.remove('hidden');
    resultsSection.classList.add('hidden');

    // Connect SSE
    connectSSE(currentJobId);
  } catch (err) {
    alert('Upload error: ' + err.message);
    startBtn.disabled = false;
    startBtn.innerHTML = '▶ Start Processing';
  }
}

// ── SSE Progress ──
function connectSSE(jobId) {
  const evtSource = new EventSource(`/api/progress/${jobId}`);

  evtSource.addEventListener('progress', (e) => {
    const d = JSON.parse(e.data);
    updateProgress(d);
  });

  evtSource.addEventListener('complete', (e) => {
    const d = JSON.parse(e.data);
    updateProgress(d);
    evtSource.close();
    progressStatus.textContent = 'Complete';
    progressStatus.classList.add('done');
    currentPages = d.pages || [];
    showResults();
  });

  evtSource.addEventListener('error', (e) => {
    if (e.data) {
      const d = JSON.parse(e.data);
      console.error('SSE error event:', d);
    }
    evtSource.close();
  });

  evtSource.onerror = () => {
    console.warn('SSE connection error');
  };
}

function updateProgress(d) {
  const pct = d.percent || 0;
  progressBar.style.width = pct + '%';
  statPdfs.textContent = d.total_pdfs || 0;
  statPages.textContent = d.total_pages || 0;
  statProcessed.textContent = `${d.processed_pages || 0} / ${d.total_pages || 0}`;
  statPercent.textContent = pct.toFixed(1) + '%';
  statSpeed.textContent = d.speed ? d.speed + ' pages/sec' : '–';
  statErrors.textContent = d.failed_pages || 0;

  if (d.status === 'scanning') {
    progressStatus.textContent = 'Scanning…';
  } else if (d.status === 'processing') {
    progressStatus.textContent = 'Processing…';
  }
}

// ── Results / Gallery ──
function showResults() {
  resultsSection.classList.remove('hidden');
  resultsCount.textContent = `(${currentPages.filter(p => p.status === 'done').length} images)`;
  selectedPageIds.clear();
  selectAllCb.checked = false;
  updateRotateBtn();
  renderGallery();
}

function renderGallery() {
  gallery.innerHTML = currentPages.map(page => {
    if (page.status === 'error') {
      return `
        <div class="gallery-card error-card" data-id="${page.id}">
          <div class="gallery-card-img">
            <div class="error-message">⚠ ${page.error || 'Processing failed'}</div>
          </div>
          <div class="gallery-card-info">
            <div class="gallery-card-meta">
              <span class="gallery-card-name" title="${page.pdf_name}">${page.pdf_name}</span>
              <span class="gallery-card-page">Page ${page.page_num}</span>
            </div>
          </div>
        </div>`;
    }

    const origUrl = `/api/images/original/${currentJobId}/${page.original_filename}`;
    const procUrl = `/api/images/processed/${currentJobId}/${page.processed_filename}`;
    const isSelected = selectedPageIds.has(page.id);

    return `
      <div class="gallery-card${isSelected ? ' selected' : ''}" data-id="${page.id}">
        <div class="gallery-card-img">
          <div class="gallery-card-select">
            <input type="checkbox" ${isSelected ? 'checked' : ''} onchange="toggleSelectCard('${page.id}', this.checked)">
          </div>
          <img src="${procUrl}" alt="${page.id}" loading="lazy" data-orig="${origUrl}" data-proc="${procUrl}">
          <div class="gallery-card-toggle">
            <button class="toggle-btn" data-view="original" onclick="toggleView(this, '${origUrl}')">Original</button>
            <button class="toggle-btn active" data-view="processed" onclick="toggleView(this, '${procUrl}')">Processed</button>
          </div>
        </div>
        <div class="gallery-card-info">
          <div class="gallery-card-meta">
            <span class="gallery-card-name" title="${page.pdf_name}">${page.pdf_name}</span>
            <span class="gallery-card-page">Page ${page.page_num}</span>
          </div>
          <div class="gallery-card-actions">
            <button class="btn btn-ghost btn-sm" onclick="rotateOne('${page.id}')" title="Rotate 180°">
              ↻ Rotate
            </button>
            <button class="btn btn-ghost btn-sm" onclick="openReprocess('${page.id}')">
              ⚙ Reprocess
            </button>
            <a class="btn btn-ghost btn-sm" href="${procUrl}" download="${page.processed_filename}">
              ↓ JPEG
            </a>
          </div>
        </div>
      </div>`;
  }).join('');
}

// Toggle original/processed view
window.toggleView = function(btn, url) {
  const card = btn.closest('.gallery-card');
  const img = card.querySelector('img');
  const buttons = card.querySelectorAll('.toggle-btn');
  buttons.forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  img.src = url;
};

// ── Selection ──
window.toggleSelectCard = function(pageId, checked) {
  if (checked) {
    selectedPageIds.add(pageId);
  } else {
    selectedPageIds.delete(pageId);
  }
  // Update card visual
  const card = document.querySelector(`.gallery-card[data-id="${pageId}"]`);
  if (card) card.classList.toggle('selected', checked);

  // Update select-all checkbox
  const donePages = currentPages.filter(p => p.status === 'done');
  selectAllCb.checked = donePages.length > 0 && selectedPageIds.size === donePages.length;
  updateRotateBtn();
};

selectAllCb.addEventListener('change', () => {
  const checked = selectAllCb.checked;
  selectedPageIds.clear();
  if (checked) {
    currentPages.forEach(p => { if (p.status === 'done') selectedPageIds.add(p.id); });
  }
  // Update all checkboxes
  document.querySelectorAll('.gallery-card-select input').forEach(cb => cb.checked = checked);
  document.querySelectorAll('.gallery-card').forEach(card => {
    const id = card.dataset.id;
    card.classList.toggle('selected', checked && selectedPageIds.has(id));
  });
  updateRotateBtn();
});

function updateRotateBtn() {
  rotateSelectedBtn.disabled = selectedPageIds.size === 0;
  const count = selectedPageIds.size;
  rotateSelectedBtn.querySelector('svg').nextSibling.textContent = count > 0
    ? ` Rotate ${count} Selected 180°`
    : ' Rotate Selected 180°';
}

// ── Rotation ──
window.rotateOne = async function(pageId) {
  await rotateImages([pageId]);
};

rotateSelectedBtn.addEventListener('click', async () => {
  if (selectedPageIds.size === 0) return;
  await rotateImages([...selectedPageIds]);
});

async function rotateImages(pageIds) {
  // Disable button while rotating
  rotateSelectedBtn.disabled = true;

  try {
    const res = await fetch('/api/rotate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job_id: currentJobId,
        page_ids: pageIds,
        degrees: 180,
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      alert('Rotate failed: ' + (err.detail || 'Unknown error'));
      return;
    }

    // Force reload images by cache-busting
    const ts = Date.now();
    pageIds.forEach(pageId => {
      const card = document.querySelector(`.gallery-card[data-id="${pageId}"]`);
      if (!card) return;
      const img = card.querySelector('img');
      if (!img) return;
      // Bust cache on current view
      const currentSrc = img.src.split('?')[0];
      img.src = currentSrc + '?t=' + ts;
      // Also update data attributes
      const origBase = img.dataset.orig.split('?')[0];
      const procBase = img.dataset.proc.split('?')[0];
      img.dataset.orig = origBase + '?t=' + ts;
      img.dataset.proc = procBase + '?t=' + ts;
      // Update toggle buttons
      const toggleBtns = card.querySelectorAll('.toggle-btn');
      toggleBtns.forEach(btn => {
        const view = btn.dataset.view;
        if (view === 'original') {
          btn.onclick = () => window.toggleView(btn, origBase + '?t=' + ts);
        } else {
          btn.onclick = () => window.toggleView(btn, procBase + '?t=' + ts);
        }
      });
    });

  } catch (err) {
    alert('Rotate error: ' + err.message);
  } finally {
    updateRotateBtn();
  }
}

// ── Reprocess Modal ──
window.openReprocess = function(pageId) {
  const page = currentPages.find(p => p.id === pageId);
  if (!page) return;
  modalPageId = pageId;

  const origUrl = `/api/images/original/${currentJobId}/${page.original_filename}`;
  const procUrl = `/api/images/processed/${currentJobId}/${page.processed_filename}`;

  modalOrigImg.src = origUrl;
  modalProcImg.src = procUrl || '';

  // Reset controls
  ctrlAlpha.checked = false;
  ctrlFg.value = 270; ctrlFgVal.textContent = '270';
  ctrlBg.value = 20; ctrlBgVal.textContent = '20';
  ctrlErode.value = 11; ctrlErodeVal.textContent = '11';

  modal.classList.remove('hidden');
};

modalClose.addEventListener('click', () => modal.classList.add('hidden'));
modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });

ctrlFg.addEventListener('input', () => ctrlFgVal.textContent = ctrlFg.value);
ctrlBg.addEventListener('input', () => ctrlBgVal.textContent = ctrlBg.value);
ctrlErode.addEventListener('input', () => ctrlErodeVal.textContent = ctrlErode.value);

modalReprocessBtn.addEventListener('click', async () => {
  if (!modalPageId || !currentJobId) return;
  modalReprocessBtn.disabled = true;
  modalReprocessBtn.innerHTML = '<span class="spinner"></span> Processing…';

  try {
    const res = await fetch('/api/reprocess', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job_id: currentJobId,
        page_id: modalPageId,
        alpha_matting: ctrlAlpha.checked,
        foreground_threshold: parseInt(ctrlFg.value),
        background_threshold: parseInt(ctrlBg.value),
        erode_size: parseInt(ctrlErode.value),
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      alert('Reprocess failed: ' + (err.detail || 'Unknown error'));
      return;
    }

    const result = await res.json();

    // Update page data
    const idx = currentPages.findIndex(p => p.id === modalPageId);
    if (idx !== -1) {
      currentPages[idx].status = result.status;
      currentPages[idx].processed_filename = result.processed_filename;
      currentPages[idx].width = result.width;
      currentPages[idx].height = result.height;
      currentPages[idx].error = result.error;
    }

    // Update modal preview
    const procUrl = `/api/images/processed/${currentJobId}/${result.processed_filename}?t=${Date.now()}`;
    modalProcImg.src = procUrl;

    // Update gallery card
    renderGallery();

  } catch (err) {
    alert('Reprocess error: ' + err.message);
  } finally {
    modalReprocessBtn.disabled = false;
    modalReprocessBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
      Reprocess`;
  }
});

// ── Download All ZIP ──
downloadAllBtn.addEventListener('click', () => {
  if (!currentJobId) return;
  window.location.href = `/api/download-all/${currentJobId}`;
});
