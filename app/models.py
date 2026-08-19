"""
Pydantic data models for the application.
"""
from pydantic import BaseModel
from typing import Optional
from enum import Enum


class PageStatus(str, Enum):
    PENDING = "pending"
    RENDERING = "rendering"
    REMOVING_BG = "removing_bg"
    SAVING = "saving"
    DONE = "done"
    ERROR = "error"


class PageResult(BaseModel):
    """Result for a single processed PDF page."""
    id: str  # Unique identifier: PDF001_page_001
    pdf_name: str  # Original PDF filename
    pdf_index: int  # 1-based PDF index in the batch
    page_num: int  # 1-based page number
    status: PageStatus = PageStatus.PENDING
    original_filename: Optional[str] = None  # Rendered original JPEG filename
    processed_filename: Optional[str] = None  # BG-removed JPEG filename
    width: Optional[int] = None
    height: Optional[int] = None
    error: Optional[str] = None


class JobProgress(BaseModel):
    """Overall batch job progress."""
    job_id: str
    total_pdfs: int = 0
    total_pages: int = 0
    processed_pages: int = 0
    failed_pages: int = 0
    percent: float = 0.0
    speed: float = 0.0  # pages/sec
    status: str = "idle"  # idle, scanning, processing, done, error
    current_pdf: Optional[str] = None
    pages: list[PageResult] = []


class ReprocessRequest(BaseModel):
    """Request to reprocess a single image."""
    job_id: str
    page_id: str
    alpha_matting: bool = False
    foreground_threshold: int = 270
    background_threshold: int = 20
    erode_size: int = 11
    model: str = "u2net"


class RotateRequest(BaseModel):
    """Request to rotate selected images by 180 degrees."""
    job_id: str
    page_ids: list[str]
    degrees: int = 180
