"""
Background Remover Module
Uses rembg with u2net model for fast CPU-based background removal.
"""
from PIL import Image
from rembg import remove, new_session
import io
import gc
import logging
from pathlib import Path

from app.config import (
    REMBG_MODEL,
    ALPHA_MATTING,
    JPEG_QUALITY,
    MAX_IMAGE_DIMENSION,
)

logger = logging.getLogger(__name__)

# Module-level session cache (one per process)
_session = None
_session_model = None


def get_session(model: str = REMBG_MODEL):
    """
    Get or create a rembg session. Cached to avoid
    reloading the model on every call.
    """
    global _session, _session_model
    if _session is None or _session_model != model:
        logger.info(f"Initializing rembg session with model: {model}")
        _session = new_session(model)
        _session_model = model
        logger.info(f"rembg session ready ({model})")
    return _session


def _resize_for_processing(image: Image.Image) -> Image.Image:
    """
    Resize image if it exceeds MAX_IMAGE_DIMENSION on any side.
    This keeps rembg fast and prevents OOM on large PDFs.
    Returns a new image if resized, or the same image if within limits.
    """
    w, h = image.size
    if w <= MAX_IMAGE_DIMENSION and h <= MAX_IMAGE_DIMENSION:
        return image

    if w > h:
        new_w = MAX_IMAGE_DIMENSION
        new_h = int(h * (MAX_IMAGE_DIMENSION / w))
    else:
        new_h = MAX_IMAGE_DIMENSION
        new_w = int(w * (MAX_IMAGE_DIMENSION / h))

    logger.info(f"Resizing {w}x{h} -> {new_w}x{new_h} for BG removal")
    return image.resize((new_w, new_h), Image.LANCZOS)


def remove_background(
    image: Image.Image,
    model: str = REMBG_MODEL,
    alpha_matting: bool = ALPHA_MATTING,
    foreground_threshold: int = 270,
    background_threshold: int = 20,
    erode_size: int = 11,
) -> Image.Image:
    """
    Remove background from an image using rembg.
    Returns RGBA image with background removed.
    """
    session = get_session(model)

    # Resize for processing speed — keeps rembg fast
    proc_image = _resize_for_processing(image)

    # Convert to bytes for rembg
    img_bytes = io.BytesIO()
    proc_image.save(img_bytes, format="PNG", optimize=False)
    img_data = img_bytes.getvalue()
    del img_bytes

    # Build kwargs
    kwargs = {"session": session, "alpha_matting": alpha_matting}
    if alpha_matting:
        kwargs["alpha_matting_foreground_threshold"] = foreground_threshold
        kwargs["alpha_matting_background_threshold"] = background_threshold
        kwargs["alpha_matting_erode_size"] = erode_size

    # Run background removal
    result_bytes = remove(img_data, **kwargs)
    del img_data

    # Convert back to PIL Image
    result_image = Image.open(io.BytesIO(result_bytes)).convert("RGBA")
    del result_bytes

    # If we resized for processing, scale the mask back to original size
    if proc_image.size != image.size:
        # Extract the alpha channel (mask) from the result
        alpha = result_image.split()[3]
        alpha = alpha.resize(image.size, Image.LANCZOS)
        # Apply the full-res mask to the original full-res image
        result_image = image.convert("RGBA")
        result_image.putalpha(alpha)
        del alpha

    del proc_image
    return result_image


def composite_on_white(rgba_image: Image.Image) -> Image.Image:
    """Composite RGBA image onto pure white background → RGB."""
    white_bg = Image.new("RGBA", rgba_image.size, (255, 255, 255, 255))
    composited = Image.alpha_composite(white_bg, rgba_image)
    result = composited.convert("RGB")
    del white_bg, composited
    return result


def process_and_save(
    image: Image.Image,
    output_path: Path,
    model: str = REMBG_MODEL,
    alpha_matting: bool = ALPHA_MATTING,
    foreground_threshold: int = 270,
    background_threshold: int = 20,
    erode_size: int = 11,
    jpeg_quality: int = JPEG_QUALITY,
) -> tuple[int, int]:
    """
    Full pipeline: remove BG → composite on white → save JPEG.
    Returns (width, height).
    """
    # Remove background
    rgba = remove_background(
        image,
        model=model,
        alpha_matting=alpha_matting,
        foreground_threshold=foreground_threshold,
        background_threshold=background_threshold,
        erode_size=erode_size,
    )

    # Composite onto white
    rgb = composite_on_white(rgba)
    del rgba

    # Save as high-quality JPEG
    rgb.save(
        str(output_path),
        "JPEG",
        quality=jpeg_quality,
        subsampling=0,
    )

    w, h = rgb.size
    logger.info(f"Saved processed: {output_path.name} ({w}x{h})")

    del rgb
    gc.collect()

    return w, h
