"""
FastAPI Application - Routes, SSE, and Static File Serving
"""
import asyncio
import uuid
import zipfile
import io
import json
import logging
import time
from pathlib import Path
from typing import AsyncGenerator

from fastapi import FastAPI, UploadFile, File, HTTPException, Request
from fastapi.responses import (
    HTMLResponse,
    FileResponse,
    StreamingResponse,
    JSONResponse,
)
from fastapi.staticfiles import StaticFiles
from sse_starlette.sse import EventSourceResponse

from app.config import UPLOAD_DIR, OUTPUT_DIR, STATIC_DIR
from app.models import ReprocessRequest, RotateRequest, PageStatus
from app.processor import start_batch_job, get_job, reprocess_single_page, rotate_pages

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(title="Bulk PDF Background Removal", version="1.0.0")

# Mount static files
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/", response_class=HTMLResponse)
async def index():
    """Serve the main UI."""
    index_path = STATIC_DIR / "index.html"
    return HTMLResponse(content=index_path.read_text(encoding="utf-8"))


@app.post("/api/upload")
async def upload_pdfs(files: list[UploadFile] = File(...)):
    """
    Accept multiple PDF uploads, save to disk, and start batch processing.
    Returns a job_id for tracking progress.
    """
    if not files:
        raise HTTPException(status_code=400, detail="No files uploaded")
    
    # Validate all files are PDFs
    for f in files:
        if not f.filename.lower().endswith(".pdf"):
            raise HTTPException(
                status_code=400,
                detail=f"File '{f.filename}' is not a PDF"
            )
    
    # Create job
    job_id = str(uuid.uuid4())[:8]
    job_upload_dir = UPLOAD_DIR / job_id
    job_upload_dir.mkdir(parents=True, exist_ok=True)
    
    # Save uploaded PDFs to disk
    pdf_files = []
    for f in files:
        safe_name = f.filename.replace(" ", "_")
        save_path = job_upload_dir / safe_name
        
        # Stream to disk to avoid holding entire file in memory
        with open(save_path, "wb") as out:
            while chunk := await f.read(1024 * 1024):  # 1MB chunks
                out.write(chunk)
        
        pdf_files.append((f.filename, save_path))
        logger.info(f"Saved upload: {f.filename} -> {save_path}")
    
    # Start batch processing in the background
    asyncio.create_task(start_batch_job(job_id, pdf_files))
    
    return {"job_id": job_id, "pdf_count": len(pdf_files)}


@app.get("/api/progress/{job_id}")
async def progress_stream(job_id: str, request: Request):
    """
    Server-Sent Events stream for real-time progress updates.
    """
    async def event_generator() -> AsyncGenerator:
        last_sent = -1
        idle_count = 0
        
        while True:
            # Check client disconnect
            if await request.is_disconnected():
                break
            
            job = get_job(job_id)
            if job is None:
                # Job not yet registered, wait a bit
                idle_count += 1
                if idle_count > 30:  # 15 seconds timeout
                    yield {
                        "event": "error",
                        "data": json.dumps({"error": "Job not found"}),
                    }
                    break
                await asyncio.sleep(0.5)
                continue
            
            completed = job.processed_pages + job.failed_pages
            
            # Send update if progress changed or if done
            if completed != last_sent or job.status in ("done", "error"):
                progress_data = {
                    "job_id": job.job_id,
                    "total_pdfs": job.total_pdfs,
                    "total_pages": job.total_pages,
                    "processed_pages": job.processed_pages,
                    "failed_pages": job.failed_pages,
                    "percent": job.percent,
                    "speed": job.speed,
                    "status": job.status,
                }
                yield {
                    "event": "progress",
                    "data": json.dumps(progress_data),
                }
                last_sent = completed
            
            if job.status == "done":
                # Send final results
                pages_data = []
                for p in job.pages:
                    pages_data.append({
                        "id": p.id,
                        "pdf_name": p.pdf_name,
                        "pdf_index": p.pdf_index,
                        "page_num": p.page_num,
                        "status": p.status.value,
                        "original_filename": p.original_filename,
                        "processed_filename": p.processed_filename,
                        "width": p.width,
                        "height": p.height,
                        "error": p.error,
                    })
                yield {
                    "event": "complete",
                    "data": json.dumps({
                        "pages": pages_data,
                        **progress_data,
                    }),
                }
                break
            
            if job.status == "error":
                yield {
                    "event": "error",
                    "data": json.dumps({"error": "Job failed"}),
                }
                break
            
            await asyncio.sleep(0.5)
    
    return EventSourceResponse(event_generator())


@app.get("/api/results/{job_id}")
async def get_results(job_id: str):
    """Get all processed image results for a job."""
    job = get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    
    pages = []
    for p in job.pages:
        pages.append({
            "id": p.id,
            "pdf_name": p.pdf_name,
            "pdf_index": p.pdf_index,
            "page_num": p.page_num,
            "status": p.status.value,
            "original_filename": p.original_filename,
            "processed_filename": p.processed_filename,
            "width": p.width,
            "height": p.height,
            "error": p.error,
        })
    
    return {
        "job_id": job.job_id,
        "status": job.status,
        "total_pages": job.total_pages,
        "processed_pages": job.processed_pages,
        "failed_pages": job.failed_pages,
        "pages": pages,
    }


@app.get("/api/images/original/{job_id}/{filename}")
async def serve_original(job_id: str, filename: str):
    """Serve an original rendered image."""
    file_path = OUTPUT_DIR / job_id / "originals" / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Image not found")
    return FileResponse(str(file_path), media_type="image/jpeg")


@app.get("/api/images/processed/{job_id}/{filename}")
async def serve_processed(job_id: str, filename: str):
    """Serve a processed (BG-removed) image."""
    file_path = OUTPUT_DIR / job_id / "processed" / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Image not found")
    return FileResponse(str(file_path), media_type="image/jpeg")


@app.post("/api/reprocess")
async def reprocess(req: ReprocessRequest):
    """Reprocess a single image with adjusted parameters."""
    result = await reprocess_single_page(
        job_id=req.job_id,
        page_id=req.page_id,
        model=req.model,
        alpha_matting=req.alpha_matting,
        foreground_threshold=req.foreground_threshold,
        background_threshold=req.background_threshold,
        erode_size=req.erode_size,
    )
    
    if result is None:
        raise HTTPException(status_code=404, detail="Page not found")
    
    return {
        "id": result.id,
        "status": result.status.value,
        "processed_filename": result.processed_filename,
        "width": result.width,
        "height": result.height,
        "error": result.error,
    }


@app.get("/api/download-all/{job_id}")
async def download_all(job_id: str):
    """
    Stream a ZIP file containing all processed images.
    """
    job = get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    
    processed_dir = OUTPUT_DIR / job_id / "processed"
    if not processed_dir.exists():
        raise HTTPException(status_code=404, detail="No processed images found")
    
    def generate_zip():
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
            for page in job.pages:
                if page.status == PageStatus.DONE and page.processed_filename:
                    file_path = processed_dir / page.processed_filename
                    if file_path.exists():
                        zf.write(str(file_path), page.processed_filename)
        
        buffer.seek(0)
        yield buffer.read()
    
    return StreamingResponse(
        generate_zip(),
        media_type="application/zip",
        headers={
            "Content-Disposition": f"attachment; filename=processed_images_{job_id}.zip"
        },
    )


@app.post("/api/rotate")
async def rotate_images(req: RotateRequest):
    """Rotate selected images by 180 degrees (or specified degrees)."""
    if not req.page_ids:
        raise HTTPException(status_code=400, detail="No page IDs provided")

    results = await rotate_pages(
        job_id=req.job_id,
        page_ids=req.page_ids,
        degrees=req.degrees,
    )

    if not results:
        raise HTTPException(status_code=404, detail="Job not found")

    return {"results": results}

