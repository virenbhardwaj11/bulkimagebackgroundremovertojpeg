# Bulk PDF Background Removal Studio

A fast, fully local, Python-based web application for batch processing PDFs. It extracts pages from PDFs, removes the backgrounds using AI (`rembg` with the `u2net` model), replaces them with pure white backgrounds, and exports high-quality JPEGs.

This tool is specifically designed to process a batch of 24–30 high-quality product PDFs cleanly and efficiently.

## Features

- **Python Only**: No Node.js or JavaScript backend dependencies.
- **Fast CPU Processing**: Optimized single-worker thread with the `u2net` model to ensure reasonable processing times on standard PCs without running out of RAM.
- **Batch Upload**: Drag and drop up to 30 PDFs at once.
- **Real-time Progress**: Server-Sent Events (SSE) provide live updates (percent, speed, errors) to the browser.
- **Image Editing**: 180° rotation for misaligned scans and per-image reprocessing.
- **Bulk Download**: One-click download of all processed JPEGs in a ZIP file.

---

## Installation (Windows)

### Prerequisites
- **Python 3.10+** (Ensure Python is added to your PATH).
- **Git** (optional, to clone the repository).

### 1. Clone the repository
```powershell
git clone https://github.com/yourusername/pdf-background-removal.git
cd pdf-background-removal
```

### 2. Create a Virtual Environment
It is highly recommended to isolate dependencies using a virtual environment:
```powershell
python -m venv venv
.\venv\Scripts\activate
```

### 3. Install Dependencies
Once the virtual environment is activated, install the required packages:
```powershell
pip install -r requirements.txt
```

### 4. Configuration (Optional)
The application works out of the box with sensible defaults. If you need to tweak performance or quality, you can create a `.env` file based on the example:
```powershell
copy .env.example .env
```
You can then edit `.env` to change the DPI, maximum image dimensions, or background removal settings.

---

## How to Start the Application

1. Open your terminal (PowerShell).
2. Activate your virtual environment if it isn't already:
   ```powershell
   .\venv\Scripts\activate
   ```
3. Run the application:
   ```powershell
   python run.py
   ```
4. Open your web browser and go to: **http://localhost:8000**

> **Note**: On the very first run, the AI model weights (`u2net`, ~176MB) will be downloaded automatically in the background.

---

## Usage Guide

### 1. Uploading PDFs
- Once the page loads, click the dropzone or drag and drop your **24–30 PDFs** into the designated area.
- The interface will list the selected files and total size.
- Click **"Start Processing"**.

### 2. Monitoring Progress
- A progress bar will appear showing real-time statistics.
- Wait until it says **Complete**.

### 3. Review & Edit
- Once complete, a gallery will appear displaying the processed images.
- **Compare**: Toggle between "Original" and "Processed" views on any image.
- **Rotate**: Select specific images using the checkboxes and click **"Rotate Selected 180°"**, or rotate individual images.
- **Reprocess**: If the edge detection isn't perfect, click **"Reprocess"** on an image to tweak the AI threshold settings manually.

### 4. Downloading
- Click the **"Download All (ZIP)"** button in the top right to download all finalized JPEGs in a single ZIP file.
- The output files will be automatically named sequentially (e.g., `PDF001_page_001.jpeg`).

---

## Project Structure
- `app/` - FastAPI backend logic (routing, rendering, AI processing).
- `static/` - Vanilla JS/CSS frontend interface.
- `uploads/` - Automatically created. Stores raw uploaded PDFs temporarily.
- `output/` - Automatically created. Stores rendered originals and processed JPEGs.
- `run.py` - Uvicorn server entry point.
