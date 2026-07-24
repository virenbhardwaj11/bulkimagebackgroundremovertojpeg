import { removeBackground } from 'https://cdn.jsdelivr.net/npm/@imgly/background-removal/+esm';
import * as pdfjsLib from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.3.136/pdf.min.mjs';

// Configure PDF.js Worker path from CDN
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.3.136/pdf.worker.min.mjs';

document.addEventListener('DOMContentLoaded', () => {
  // State
  let imageList = [];
  let currentImageId = null;
  let currentViewType = 'processed'; // 'processed' or 'original'

  // DOM Elements
  const dropZone = document.getElementById('drop-zone');
  const pdfInput = document.getElementById('pdf-file-input');
  const browseBtn = document.getElementById('browse-btn');
  const dpiSelect = document.getElementById('dpi-select');
  const defaultBgMode = document.getElementById('default-bg-mode');

  const uploadSection = document.getElementById('upload-section');
  const workspaceSection = document.getElementById('workspace-section');
  const loadingOverlay = document.getElementById('loading-overlay');
  const loadingText = document.getElementById('loading-text');

  const thumbnailGallery = document.getElementById('thumbnail-gallery');
  const mainPreviewImg = document.getElementById('main-preview-img');
  const previewPlaceholder = document.getElementById('preview-placeholder');
  const currentImageName = document.getElementById('current-image-name');
  const currentImageDims = document.getElementById('current-image-dims');
  const totalCountBadge = document.getElementById('total-count-badge');

  // Controls
  const viewProcessedBtn = document.getElementById('view-processed-btn');
  const viewOriginalBtn = document.getElementById('view-original-btn');
  const bgAiBtn = document.getElementById('bg-ai-btn');
  const bgNoneBtn = document.getElementById('bg-none-btn');
  const rot90Btn = document.getElementById('rot-90');
  const rot180Btn = document.getElementById('rot-180');
  const rot270Btn = document.getElementById('rot-270');
  const rot360Btn = document.getElementById('rot-360');

  const downloadSingleBtn = document.getElementById('download-single-btn');
  const downloadAllBtn = document.getElementById('download-all-btn');
  const uploadMoreBtn = document.getElementById('upload-more-btn');

  // --- Upload Drag & Drop Handlers ---
  browseBtn.addEventListener('click', () => pdfInput.click());

  pdfInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleFiles(e.target.files);
    }
  });

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  });

  // Client-side PDF file reader & converter
  async function handleFiles(fileList) {
    const pdfFiles = Array.from(fileList).filter(f => f.name.toLowerCase().endsWith('.pdf') || f.type === 'application/pdf');

    if (pdfFiles.length === 0) {
      alert('Please select valid PDF file(s).');
      return;
    }

    showLoading('Loading PDF file(s)...', 'Initializing client-side PDF renderer');

    try {
      const dpi = parseInt(dpiSelect.value, 10);
      const bgMode = defaultBgMode.value;
      const newlyAddedPages = [];

      for (const file of pdfFiles) {
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        const numPages = pdf.numPages;

        for (let pageNum = 1; pageNum <= numPages; pageNum++) {
          showLoading(
            `Rendering Page ${pageNum} of ${numPages}...`, 
            `Converting "${file.name}" to high-resolution JPEG`
          );

          const page = await pdf.getPage(pageNum);
          const scale = dpi / 72.0;
          const viewport = page.getViewport({ scale });

          // Render PDF page to canvas
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const ctx = canvas.getContext('2d');

          const renderContext = {
            canvasContext: ctx,
            viewport: viewport
          };
          await page.render(renderContext).promise;

          // Convert canvas rendering to JPEG Blob
          const originalBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.95));

          const imageId = 'img_' + Math.random().toString(36).substring(2, 10);
          const baseName = file.name.substring(0, file.name.lastIndexOf('.')) || file.name;
          
          let origFilename = '';
          let procFilename = '';
          if (numPages === 1) {
            origFilename = `${baseName}_orig.jpeg`;
            procFilename = `${baseName}.jpeg`;
          } else {
            origFilename = `${baseName}_page_${pageNum}_orig.jpeg`;
            procFilename = `${baseName}_page_${pageNum}.jpeg`;
          }

          const imgItem = {
            id: imageId,
            filename: procFilename,
            orig_filename: origFilename,
            pdf_name: file.name,
            page: pageNum,
            rotation: 0,
            bg_mode: bgMode,
            originalBlob: originalBlob,
            originalUrl: URL.createObjectURL(originalBlob),
            transparentBlob: null, // Cache for AI transparent output blob
            processedBlob: null,
            processedUrl: null,
            width: canvas.width,
            height: canvas.height
          };

          showLoading(
            `Processing Page ${pageNum} of ${numPages}...`, 
            `Running client-side AI product isolator`
          );
          await processImageItem(imgItem);

          imageList.push(imgItem);
          newlyAddedPages.push(imgItem);
        }
      }

      hideLoading();
      showWorkspace();
      renderGallery();

      if (newlyAddedPages.length > 0) {
        selectImage(newlyAddedPages[0].id);
      }
    } catch (err) {
      hideLoading();
      alert('Error converting PDF files: ' + err.message);
    }
  }

  // AI Background removal & rotation pipeline using canvas and WASM
  async function processImageItem(imgItem) {
    if (imgItem.bg_mode === 'ai') {
      if (!imgItem.transparentBlob) {
        try {
          // Process originalBlob with @imgly/background-removal entirely local
          const transparentBlob = await removeBackground(imgItem.originalBlob);
          imgItem.transparentBlob = transparentBlob;
        } catch (err) {
          console.warn('Local AI background removal failed, using original backdrop:', err);
          imgItem.transparentBlob = imgItem.originalBlob;
        }
      }
    }

    const sourceBlob = imgItem.bg_mode === 'ai' ? imgItem.transparentBlob : imgItem.originalBlob;

    // Load source blob to image element to draw on canvas
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = URL.createObjectURL(sourceBlob);
    });

    const canvas = document.createElement('canvas');
    const rot = imgItem.rotation % 360;

    if (rot === 90 || rot === 270) {
      canvas.width = img.naturalHeight;
      canvas.height = img.naturalWidth;
    } else {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
    }

    const ctx = canvas.getContext('2d');

    // Fill white background
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Apply rotation transformations
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((rot * Math.PI) / 180);
    ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);

    URL.revokeObjectURL(img.src);

    const processedBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.95));

    if (imgItem.processedUrl) {
      URL.revokeObjectURL(imgItem.processedUrl);
    }

    imgItem.processedBlob = processedBlob;
    imgItem.processedUrl = URL.createObjectURL(processedBlob);
    imgItem.width = canvas.width;
    imgItem.height = canvas.height;
  }

  // UI State toggles
  function showLoading(text, subtext) {
    loadingText.textContent = text;
    if (subtext) document.getElementById('loading-subtext').textContent = subtext;
    loadingOverlay.classList.remove('hidden');
  }

  function hideLoading() {
    loadingOverlay.classList.add('hidden');
  }

  function showWorkspace() {
    uploadSection.classList.add('hidden');
    workspaceSection.classList.remove('hidden');
    totalCountBadge.textContent = `${imageList.length} Page${imageList.length > 1 ? 's' : ''}`;
  }

  uploadMoreBtn.addEventListener('click', () => {
    pdfInput.value = '';
    uploadSection.classList.remove('hidden');
    pdfInput.click();
  });

  // Render Sidebar Gallery
  function renderGallery() {
    thumbnailGallery.innerHTML = '';
    imageList.forEach((imgItem) => {
      const card = document.createElement('div');
      card.className = `thumb-card ${imgItem.id === currentImageId ? 'active' : ''}`;
      card.dataset.id = imgItem.id;

      const thumbUrl = imgItem.processedUrl;

      card.innerHTML = `
        <img src="${thumbUrl}" alt="Page ${imgItem.page}" class="thumb-img" />
        <div class="thumb-info">
          <span class="thumb-name">${imgItem.pdf_name}</span>
          <span class="thumb-sub">Page ${imgItem.page} • ${imgItem.rotation}°</span>
        </div>
      `;

      card.addEventListener('click', () => selectImage(imgItem.id));
      thumbnailGallery.appendChild(card);
    });
  }

  // Select Image for Preview
  function selectImage(imageId) {
    currentImageId = imageId;
    const imgItem = imageList.find(i => i.id === imageId);
    if (!imgItem) return;

    document.querySelectorAll('.thumb-card').forEach(el => {
      el.classList.toggle('active', el.dataset.id === imageId);
    });

    currentImageName.textContent = `${imgItem.pdf_name} - Page ${imgItem.page}`;
    currentImageDims.textContent = `${imgItem.width} × ${imgItem.height} px`;

    updateBgButtons(imgItem.bg_mode || 'ai');
    updatePreviewImage();
  }

  function updateBgButtons(mode) {
    bgAiBtn.classList.toggle('active', mode === 'ai');
    bgNoneBtn.classList.toggle('active', mode === 'none');
  }

  // Update Main Preview Image
  function updatePreviewImage() {
    if (!currentImageId) return;
    const imgItem = imageList.find(i => i.id === currentImageId);
    if (!imgItem) return;

    previewPlaceholder.classList.add('hidden');
    mainPreviewImg.classList.remove('hidden');

    mainPreviewImg.src = currentViewType === 'processed' ? imgItem.processedUrl : imgItem.originalUrl;
  }

  // View Mode Toggles (Processed vs Original)
  viewProcessedBtn.addEventListener('click', () => {
    currentViewType = 'processed';
    viewProcessedBtn.classList.add('active');
    viewOriginalBtn.classList.remove('active');
    updatePreviewImage();
  });

  viewOriginalBtn.addEventListener('click', () => {
    currentViewType = 'original';
    viewOriginalBtn.classList.add('active');
    viewProcessedBtn.classList.remove('active');
    updatePreviewImage();
  });

  // Re-apply rotation or background mode
  async function applyImageProcess(newBgMode, newRotation) {
    const imgItem = imageList.find(i => i.id === currentImageId);
    if (!imgItem) return;

    const bgMode = newBgMode !== undefined ? newBgMode : imgItem.bg_mode;
    const rotation = newRotation !== undefined ? newRotation : imgItem.rotation;

    showLoading('Updating Image...', 'Re-rendering and applying options');

    try {
      imgItem.bg_mode = bgMode;
      imgItem.rotation = rotation;

      await processImageItem(imgItem);

      currentImageDims.textContent = `${imgItem.width} × ${imgItem.height} px`;
      renderGallery();
      updatePreviewImage();
    } catch (err) {
      alert('Failed to process image: ' + err.message);
    } finally {
      hideLoading();
    }
  }

  // Background Mode button listeners
  [bgAiBtn, bgNoneBtn].forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      updateBgButtons(mode);
      applyImageProcess(mode, undefined);
    });
  });

  // Rotation Buttons
  rot90Btn.addEventListener('click', () => rotateBy(90));
  rot180Btn.addEventListener('click', () => rotateBy(180));
  rot270Btn.addEventListener('click', () => rotateBy(270));
  rot360Btn.addEventListener('click', () => rotateBy(360));

  function rotateBy(angle) {
    const imgItem = imageList.find(i => i.id === currentImageId);
    if (!imgItem) return;
    const newRot = (imgItem.rotation + angle) % 360;
    applyImageProcess(undefined, newRot);
  }

  // Single Download (handled locally)
  downloadSingleBtn.addEventListener('click', () => {
    if (!currentImageId) return;
    const imgItem = imageList.find(i => i.id === currentImageId);
    if (!imgItem) return;

    const blob = currentViewType === 'processed' ? imgItem.processedBlob : imgItem.originalBlob;
    const filename = currentViewType === 'processed' ? imgItem.filename : imgItem.orig_filename;

    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  });

  // Download All ZIP (handled locally via JSZip)
  downloadAllBtn.addEventListener('click', async () => {
    if (imageList.length === 0) return;

    showLoading('Preparing ZIP Archive...', 'Compressing all processed images inside browser');

    try {
      const zip = new window.JSZip();
      
      imageList.forEach((imgItem) => {
        zip.file(imgItem.filename, imgItem.processedBlob);
      });

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const downloadUrl = URL.createObjectURL(zipBlob);
      
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = `white_bg_jpg_files.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(downloadUrl);
    } catch (err) {
      alert('Download ZIP error: ' + err.message);
    } finally {
      hideLoading();
    }
  });
});
