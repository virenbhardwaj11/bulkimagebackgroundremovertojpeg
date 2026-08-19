"""
PDF Renderer Module
Renders PDF pages to high-quality PIL Images using PyMuPDF.
"""
import fitz  # PyMuPDF
from PIL import Image
from pathlib import Path
from typing import Generator
import io
import logging

from app.config import RENDER_DPI

logger = logging.getLogger(__name__)


def get_page_count(pdf_path: Path) -> int:
    """Return the number of pages in a PDF without rendering."""
    doc = fitz.open(str(pdf_path))
    count = doc.page_count
    doc.close()
    return count


def render_page(pdf_path: Path, page_num: int, dpi: int = RENDER_DPI) -> Image.Image:
    """
    Render a single page from a PDF at the specified DPI.
    
    Args:
        pdf_path: Path to the PDF file
        page_num: 0-based page index
        dpi: Rendering resolution (default: 300)
    
    Returns:
        PIL Image in RGB mode
    """
    doc = fitz.open(str(pdf_path))
    try:
        page = doc.load_page(page_num)
        
        # Render at high DPI for maximum quality
        pix = page.get_pixmap(dpi=dpi)
        
        # Convert PyMuPDF pixmap to PIL Image
        if pix.alpha:
            img = Image.frombytes("RGBA", [pix.width, pix.height], pix.samples)
            # Composite onto white background for consistency
            white_bg = Image.new("RGBA", img.size, (255, 255, 255, 255))
            img = Image.alpha_composite(white_bg, img)
            img = img.convert("RGB")
        else:
            img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
        
        logger.info(
            f"Rendered {pdf_path.name} page {page_num + 1}: "
            f"{img.width}x{img.height} at {dpi} DPI"
        )
        return img
    finally:
        doc.close()


def render_pdf_pages(
    pdf_path: Path, dpi: int = RENDER_DPI
) -> Generator[tuple[int, Image.Image], None, None]:
    """
    Generator that yields (page_index, PIL Image) for each page.
    Memory efficient: only one page in memory at a time.
    
    Args:
        pdf_path: Path to the PDF file
        dpi: Rendering resolution
    
    Yields:
        Tuple of (0-based page index, PIL Image in RGB mode)
    """
    doc = fitz.open(str(pdf_path))
    try:
        for page_num in range(doc.page_count):
            page = doc.load_page(page_num)
            pix = page.get_pixmap(dpi=dpi)
            
            if pix.alpha:
                img = Image.frombytes("RGBA", [pix.width, pix.height], pix.samples)
                white_bg = Image.new("RGBA", img.size, (255, 255, 255, 255))
                img = Image.alpha_composite(white_bg, img)
                img = img.convert("RGB")
            else:
                img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
            
            # Free pixmap memory immediately
            del pix
            
            yield page_num, img
    finally:
        doc.close()


def save_original_jpeg(
    image: Image.Image, output_path: Path, quality: int = 97
) -> None:
    """Save the rendered (original) image as a high-quality JPEG."""
    image.save(str(output_path), "JPEG", quality=quality, subsampling=0)
    logger.info(f"Saved original: {output_path.name}")
