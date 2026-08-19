"""
Application configuration constants.
"""
import os
from pathlib import Path
from dotenv import load_dotenv

# Load environment variables from .env file if it exists
load_dotenv()

# Base directories
BASE_DIR = Path(__file__).resolve().parent.parent
UPLOAD_DIR = BASE_DIR / "uploads"
OUTPUT_DIR = BASE_DIR / "output"
STATIC_DIR = BASE_DIR / "static"

# Ensure directories exist (created automatically on startup)
UPLOAD_DIR.mkdir(exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)

# PDF rendering — 200 DPI is excellent quality while keeping images manageable
RENDER_DPI = int(os.getenv("RENDER_DPI", "200"))

# Max image dimension — resize if larger to keep rembg fast
MAX_IMAGE_DIMENSION = int(os.getenv("MAX_IMAGE_DIMENSION", "2048"))

# JPEG export
JPEG_QUALITY = int(os.getenv("JPEG_QUALITY", "95"))

# Background removal — u2net is 50x faster than birefnet on CPU
REMBG_MODEL = os.getenv("REMBG_MODEL", "u2net")
ALPHA_MATTING = os.getenv("ALPHA_MATTING", "False").lower() in ("true", "1", "yes")

# Processing — single worker to control RAM usage
MAX_WORKERS = int(os.getenv("MAX_WORKERS", "1"))

# Upload limits
MAX_UPLOAD_SIZE_MB = int(os.getenv("MAX_UPLOAD_SIZE_MB", "15"))  # Per file
MAX_TOTAL_UPLOAD_MB = int(os.getenv("MAX_TOTAL_UPLOAD_MB", "500"))  # Total batch

