"""Shared pytest fixtures for Reader backend tests."""
import base64
import io
import os
import uuid
from pathlib import Path

import pytest
import requests
from PIL import Image, ImageDraw, ImageFilter, ImageFont

# Load env exactly like the frontend does
FRONTEND_ENV = Path(__file__).resolve().parents[2] / "frontend" / ".env"
BASE_URL = None
if FRONTEND_ENV.exists():
    for line in FRONTEND_ENV.read_text().splitlines():
        if line.startswith("EXPO_PUBLIC_BACKEND_URL"):
            BASE_URL = line.split("=", 1)[1].strip().strip('"').rstrip("/")
            break

if not BASE_URL:
    BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "").rstrip("/")

assert BASE_URL, "EXPO_PUBLIC_BACKEND_URL missing from frontend/.env"


# ── Image helpers ──────────────────────────────────────────────
def _load_font(size: int):
    """Load any common TrueType font that is installed on the system."""
    for path in [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ]:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def _img_to_b64(img: Image.Image, fmt: str = "JPEG", quality: int = 85) -> str:
    buf = io.BytesIO()
    img.save(buf, format=fmt, quality=quality)
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def build_bill_image() -> str:
    """Render a realistic-looking utility bill as a JPEG base64 string."""
    W, H = 900, 1200
    img = Image.new("RGB", (W, H), "white")
    draw = ImageDraw.Draw(img)

    title_font = _load_font(44)
    h_font = _load_font(28)
    body_font = _load_font(22)
    small_font = _load_font(18)

    # Header block
    draw.rectangle([(0, 0), (W, 110)], fill=(30, 90, 160))
    draw.text((40, 30), "NATIONAL GRID", fill="white", font=title_font)
    draw.text((40, 85), "Water & Utility Services", fill="white", font=small_font)

    y = 150
    draw.text((40, y), "Water Bill", fill="black", font=h_font); y += 50
    draw.text((40, y), "Account Number: 4421-9087-23", fill="black", font=body_font); y += 34
    draw.text((40, y), "Billing Date: March 14, 2025", fill="black", font=body_font); y += 34
    draw.text((40, y), "Due Date: April 1, 2025", fill="black", font=body_font); y += 34
    draw.text((40, y), "Service Address: 128 Maple Street, Boston MA 02118",
              fill="black", font=body_font); y += 60

    draw.line([(40, y), (W - 40, y)], fill="black", width=2); y += 20
    draw.text((40, y), "Usage Summary", fill="black", font=h_font); y += 44

    rows = [
        ("Previous Reading", "0432 cu ft"),
        ("Current Reading", "0519 cu ft"),
        ("Usage This Period", "87 cu ft"),
        ("Water Charge", "$ 42.18"),
        ("Sewer Charge", "$ 28.40"),
        ("Service Fee", "$ 9.75"),
        ("Total Amount Due", "$ 80.33"),
    ]
    for label, val in rows:
        draw.text((60, y), label, fill="black", font=body_font)
        draw.text((560, y), val, fill="black", font=body_font)
        y += 34

    y += 30
    draw.line([(40, y), (W - 40, y)], fill="black", width=2); y += 20
    draw.text((40, y), "Please pay online at nationalgrid.example.com",
              fill="black", font=body_font); y += 34
    draw.text((40, y), "Questions? Call 1-800-555-0199",
              fill="black", font=body_font); y += 34
    draw.text((40, y), "Thank you for being our customer.",
              fill=(80, 80, 80), font=small_font)

    # Add a subtle texture so it isn't uniform variance
    for i in range(0, W, 3):
        draw.point((i, H - 2), fill=(240, 240, 240))

    return _img_to_b64(img, "JPEG", 88)


def build_blurry_image() -> str:
    """Heavy gaussian blur of random-ish content -> unreadable."""
    W, H = 600, 800
    img = Image.new("RGB", (W, H), "white")
    draw = ImageDraw.Draw(img)
    font = _load_font(40)
    for i in range(25):
        draw.text((20 + (i % 4) * 140, 40 + (i // 4) * 120),
                  "xxxxx", fill=(120, 120, 120), font=font)
    # Make it severely blurry
    img = img.filter(ImageFilter.GaussianBlur(radius=18))
    return _img_to_b64(img, "JPEG", 70)


# ── Fixtures ───────────────────────────────────────────────────
@pytest.fixture(scope="session")
def base_url() -> str:
    return BASE_URL


@pytest.fixture(scope="session")
def api_client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="session")
def bill_image_b64() -> str:
    return build_bill_image()


@pytest.fixture(scope="session")
def blurry_image_b64() -> str:
    return build_blurry_image()


@pytest.fixture()
def fresh_session_id() -> str:
    return f"TEST_{uuid.uuid4()}"
