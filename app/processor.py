"""
Batch Processing Orchestrator
Sequential processing with strict memory management.
"""
import asyncio
import time
import logging
import gc
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

from app.config import (
    UPLOAD_DIR,
    OUTPUT_DIR,
    RENDER_DPI,
    JPEG_QUALITY,
    REMBG_MODEL,
    ALPHA_MATTING,
)
from app.models import PageResult, PageStatus, JobProgress
from app.pdf_renderer import get_page_count, render_page, save_original_jpeg
from app.bg_remover import process_and_save, get_session

logger = logging.getLogger(__name__)

# Global job store
_jobs: dict[str, JobProgress] = {}


def get_job(job_id: str) -> Optional[JobProgress]:
    return _jobs.get(job_id)


def _process_single_page(
    pdf_path: Path,
    page_num: int,
    page_id: str,
    original_path: Path,
    processed_path: Path,
    model: str = REMBG_MODEL,
    alpha_matting: bool = ALPHA_MATTING,
    foreground_threshold: int = 270,
    background_threshold: int = 20,
    erode_size: int = 11,
) -> dict:
    """
    Process one PDF page: render → save original → remove BG → save processed.
    Runs in a single thread. Aggressively frees memory after each step.
    """
    try:
        # Step 1: Render
        image = render_page(pdf_path, page_num, dpi=RENDER_DPI)

        # Step 2: Save original
        save_original_jpeg(image, original_path, quality=JPEG_QUALITY)

        # Step 3: Remove BG and save
        width, height = process_and_save(
            image,
            processed_path,
            model=model,
            alpha_matting=alpha_matting,
            foreground_threshold=foreground_threshold,
            background_threshold=background_threshold,
            erode_size=erode_size,
            jpeg_quality=JPEG_QUALITY,
        )

        # Free memory
        del image
        gc.collect()

        return {
            "page_id": page_id,
            "status": PageStatus.DONE,
            "original_filename": original_path.name,
            "processed_filename": processed_path.name,
            "width": width,
            "height": height,
            "error": None,
        }
    except Exception as e:
        logger.error(f"Error processing {page_id}: {e}", exc_info=True)
        gc.collect()
        return {
            "page_id": page_id,
            "status": PageStatus.ERROR,
            "original_filename": original_path.name if original_path.exists() else None,
            "processed_filename": None,
            "width": None,
            "height": None,
            "error": str(e),
        }


async def start_batch_job(job_id: str, pdf_files: list[tuple[str, Path]]) -> None:
    """
    Process a batch of PDFs sequentially, one page at a time.
    Uses a single-thread executor to keep the event loop responsive for SSE.
    """
    job_output = OUTPUT_DIR / job_id
    job_output.mkdir(parents=True, exist_ok=True)
    originals_dir = job_output / "originals"
    processed_dir = job_output / "processed"
    originals_dir.mkdir(exist_ok=True)
    processed_dir.mkdir(exist_ok=True)

    # Initialize job
    job = JobProgress(job_id=job_id, total_pdfs=len(pdf_files), status="scanning")
    _jobs[job_id] = job

    # Phase 1: Scan all PDFs to count pages
    all_pages: list[dict] = []
    for pdf_index, (orig_name, pdf_path) in enumerate(pdf_files, start=1):
        try:
            page_count = get_page_count(pdf_path)
            pdf_label = f"PDF{pdf_index:03d}"

            for page_num in range(page_count):
                page_id = f"{pdf_label}_page_{page_num + 1:03d}"
                page_result = PageResult(
                    id=page_id,
                    pdf_name=orig_name,
                    pdf_index=pdf_index,
                    page_num=page_num + 1,
                    status=PageStatus.PENDING,
                )
                job.pages.append(page_result)
                all_pages.append({
                    "pdf_path": pdf_path,
                    "page_num": page_num,
                    "page_id": page_id,
                    "page_index": len(job.pages) - 1,
                    "original_path": originals_dir / f"{page_id}.jpeg",
                    "processed_path": processed_dir / f"{page_id}.jpeg",
                })

            logger.info(f"Scanned {orig_name}: {page_count} pages")
        except Exception as e:
            logger.error(f"Error scanning {orig_name}: {e}")

    job.total_pages = len(all_pages)
    job.status = "processing"

    if not all_pages:
        job.status = "done"
        return

    # Pre-warm model (downloads if first time)
    logger.info("Pre-warming rembg model...")
    loop = asyncio.get_event_loop()
    executor = ThreadPoolExecutor(max_workers=1)
    await loop.run_in_executor(executor, get_session, REMBG_MODEL)
    logger.info("rembg model ready.")

    # Phase 2: Process pages ONE AT A TIME sequentially
    start_time = time.time()

    for page_info in all_pages:
        page_idx = page_info["page_index"]
        page = job.pages[page_idx]
        page.status = PageStatus.RENDERING

        try:
            # Run the heavy work in a thread so SSE/event loop stays responsive
            result = await loop.run_in_executor(
                executor,
                _process_single_page,
                page_info["pdf_path"],
                page_info["page_num"],
                page_info["page_id"],
                page_info["original_path"],
                page_info["processed_path"],
            )

            # Update page result
            page.status = result["status"]
            page.original_filename = result["original_filename"]
            page.processed_filename = result["processed_filename"]
            page.width = result["width"]
            page.height = result["height"]
            page.error = result["error"]

            if result["status"] == PageStatus.DONE:
                job.processed_pages += 1
            else:
                job.failed_pages += 1

        except Exception as e:
            logger.error(f"Future error for {page_info['page_id']}: {e}")
            page.status = PageStatus.ERROR
            page.error = str(e)
            job.failed_pages += 1

        # Update speed/progress
        elapsed = time.time() - start_time
        completed = job.processed_pages + job.failed_pages
        job.speed = round(completed / elapsed, 2) if elapsed > 0 else 0
        job.percent = round((completed / job.total_pages) * 100, 1)

        # Give the event loop a moment to send SSE updates
        await asyncio.sleep(0.05)

    executor.shutdown(wait=False)
    job.status = "done"
    job.percent = 100.0
    elapsed = time.time() - start_time
    logger.info(
        f"Job {job_id} complete: {job.processed_pages}/{job.total_pages} pages "
        f"in {elapsed:.1f}s ({job.speed} pages/sec)"
    )


async def reprocess_single_page(
    job_id: str,
    page_id: str,
    model: str = REMBG_MODEL,
    alpha_matting: bool = ALPHA_MATTING,
    foreground_threshold: int = 270,
    background_threshold: int = 20,
    erode_size: int = 11,
) -> Optional[PageResult]:
    """Reprocess a single page using the already-saved original image."""
    job = _jobs.get(job_id)
    if not job:
        return None

    page = None
    for p in job.pages:
        if p.id == page_id:
            page = p
            break
    if page is None:
        return None

    job_output = OUTPUT_DIR / job_id
    original_path = job_output / "originals" / f"{page_id}.jpeg"
    processed_path = job_output / "processed" / f"{page_id}.jpeg"

    if not original_path.exists():
        page.status = PageStatus.ERROR
        page.error = "Original image not found"
        return page

    from PIL import Image as PILImage
    page.status = PageStatus.REMOVING_BG

    loop = asyncio.get_event_loop()
    executor = ThreadPoolExecutor(max_workers=1)

    def _do_reprocess():
        image = PILImage.open(str(original_path)).convert("RGB")
        w, h = process_and_save(
            image, processed_path,
            model=model,
            alpha_matting=alpha_matting,
            foreground_threshold=foreground_threshold,
            background_threshold=background_threshold,
            erode_size=erode_size,
            jpeg_quality=JPEG_QUALITY,
        )
        del image
        gc.collect()
        return w, h

    try:
        width, height = await loop.run_in_executor(executor, _do_reprocess)
        page.status = PageStatus.DONE
        page.processed_filename = processed_path.name
        page.width = width
        page.height = height
        page.error = None
    except Exception as e:
        logger.error(f"Reprocess error for {page_id}: {e}", exc_info=True)
        page.status = PageStatus.ERROR
        page.error = str(e)
    finally:
        executor.shutdown(wait=False)

    return page

async def rotate_pages(
    job_id: str,
    page_ids: list[str],
    degrees: int = 180,
) -> list[dict]:
    """
    Rotate selected processed (and original) images by the given degrees.
    Modifies files in-place. Returns list of results.
    """
    from PIL import Image as PILImage

    job = _jobs.get(job_id)
    if not job:
        return []

    job_output = OUTPUT_DIR / job_id
    originals_dir = job_output / "originals"
    processed_dir = job_output / "processed"
    results = []

    loop = asyncio.get_event_loop()
    executor = ThreadPoolExecutor(max_workers=1)

    def _rotate_file(file_path: Path):
        if not file_path.exists():
            return
        img = PILImage.open(str(file_path))
        rotated = img.rotate(degrees, expand=True)
        rotated.save(str(file_path), "JPEG", quality=JPEG_QUALITY, subsampling=0)
        del img, rotated

    for page_id in page_ids:
        page = None
        for p in job.pages:
            if p.id == page_id:
                page = p
                break
        if page is None:
            results.append({"id": page_id, "success": False, "error": "Not found"})
            continue

        orig_path = originals_dir / f"{page_id}.jpeg"
        proc_path = processed_dir / f"{page_id}.jpeg"

        try:
            await loop.run_in_executor(executor, _rotate_file, orig_path)
            await loop.run_in_executor(executor, _rotate_file, proc_path)
            results.append({"id": page_id, "success": True, "error": None})
            logger.info(f"Rotated {page_id} by {degrees}°")
        except Exception as e:
            logger.error(f"Rotate error for {page_id}: {e}")
            results.append({"id": page_id, "success": False, "error": str(e)})

    gc.collect()
    executor.shutdown(wait=False)
    return results
