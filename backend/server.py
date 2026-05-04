from fastapi import FastAPI, APIRouter, HTTPException
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import json
import logging
import re
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List, Optional
import uuid
from datetime import datetime, timezone

from emergentintegrations.llm.chat import LlmChat, UserMessage, ImageContent


ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# MongoDB connection
mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

EMERGENT_LLM_KEY = os.environ.get('EMERGENT_LLM_KEY', '')
LLM_PROVIDER = "anthropic"
LLM_MODEL = "claude-sonnet-4-5-20250929"

app = FastAPI()
api_router = APIRouter(prefix="/api")


# ── Models ─────────────────────────────────────────────────────
class AnalyzeRequest(BaseModel):
    image_base64: str
    session_id: Optional[str] = None


class AnalyzeResponse(BaseModel):
    quality: str
    quality_feedback: str = ""
    text: str = ""
    summary: str = ""
    doc_type: str = ""
    page_id: Optional[str] = None


class ChatRequest(BaseModel):
    session_id: str
    question: str


class ChatResponse(BaseModel):
    answer: str


class StoredPage(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    session_id: str
    page_num: int
    doc_type: str
    text: str
    summary: str
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


# ── Prompts ────────────────────────────────────────────────────
ANALYZE_PROMPT = """You are helping a person with limited vision read documents using their phone camera.

STEP 1 — QUALITY CHECK:
Decide if the document text is readable.
- Set quality = "poor" if: the document is severely cut off (less than half visible), text is too blurry to read at all, or it is not a document. Low light alone is NOT a reason to fail — try to read it.
- If poor: write brief natural spoken advice in quality_feedback. Examples: "Part of the document is cut off. Try moving back and re-centering it." / "The image is quite blurry. Hold steady and try again." / "It's very dark. A bit more light would help, though I'll do my best if you try again." Keep it one or two sentences.
- Set quality = "ok" if text is readable (even partially dim or tilted is fine).

STEP 2 — TRANSCRIBE (only if quality = ok):
Extract ALL visible text, preserving structure (headings, columns, lists). Use plain text with line breaks.

STEP 3 — OVERVIEW (only if quality = ok):
Write 1 to 2 natural spoken sentences identifying ONLY the document type and date if present. Do not mention amounts or details yet. Example: "This is a water bill from National Grid, dated March 2025." Spell out everything as spoken words.

STEP 4 — DOC TYPE (only if quality = ok):
Short label, e.g. "Water Bill", "Medical Letter", "Bank Statement", "Prescription", "Book Page", "Newspaper Article".

Respond ONLY as valid JSON (no markdown fences, no commentary):
{"quality":"ok","quality_feedback":"","text":"full text here","summary":"spoken overview here","doc_type":"label here"}"""


CHAT_SYSTEM = "You are a reading assistant for someone with limited vision. Give short, natural spoken answers — 1 to 3 sentences. No markdown or bullet points. Spell out numbers, dates, and dollar amounts as words. If the question is not related to the document, answer briefly anyway."


def _strip_json(raw: str) -> str:
    raw = raw.strip()
    raw = re.sub(r"^```(?:json)?", "", raw).strip()
    raw = re.sub(r"```$", "", raw).strip()
    # Find first { ... last }
    m = re.search(r"\{.*\}", raw, re.S)
    return m.group(0) if m else raw


# ── Routes ─────────────────────────────────────────────────────
@api_router.get("/")
async def root():
    return {"message": "Reader API"}


@api_router.post("/analyze", response_model=AnalyzeResponse)
async def analyze_image(req: AnalyzeRequest):
    if not EMERGENT_LLM_KEY:
        raise HTTPException(status_code=500, detail="LLM key not configured")

    session_id = req.session_id or str(uuid.uuid4())

    chat = LlmChat(
        api_key=EMERGENT_LLM_KEY,
        session_id=f"analyze-{uuid.uuid4()}",
        system_message="You output strict JSON only.",
    ).with_model(LLM_PROVIDER, LLM_MODEL).with_params(max_tokens=1500)

    image = ImageContent(image_base64=req.image_base64)
    user_msg = UserMessage(text=ANALYZE_PROMPT, file_contents=[image])

    try:
        raw = await chat.send_message(user_msg)
    except Exception as e:
        logger.exception("LLM analyze failed")
        raise HTTPException(status_code=502, detail=f"Vision call failed: {e}")

    try:
        data = json.loads(_strip_json(raw))
    except Exception:
        data = {
            "quality": "ok",
            "quality_feedback": "",
            "text": raw,
            "summary": "Document captured. Ask me anything.",
            "doc_type": "Document",
        }

    quality = data.get("quality", "ok")

    page_id = None
    if quality == "ok":
        # Count existing pages in this session
        existing = await db.pages.count_documents({"session_id": session_id})
        page = StoredPage(
            session_id=session_id,
            page_num=existing + 1,
            doc_type=data.get("doc_type", "Document"),
            text=data.get("text", ""),
            summary=data.get("summary", ""),
        )
        await db.pages.insert_one(page.model_dump())
        page_id = page.id

    return AnalyzeResponse(
        quality=quality,
        quality_feedback=data.get("quality_feedback", ""),
        text=data.get("text", ""),
        summary=data.get("summary", ""),
        doc_type=data.get("doc_type", ""),
        page_id=page_id,
    )


@api_router.post("/chat", response_model=ChatResponse)
async def chat_about_doc(req: ChatRequest):
    if not EMERGENT_LLM_KEY:
        raise HTTPException(status_code=500, detail="LLM key not configured")

    pages = await db.pages.find(
        {"session_id": req.session_id}, {"_id": 0}
    ).sort("page_num", 1).to_list(50)

    if not pages:
        raise HTTPException(status_code=404, detail="No document captured for this session")

    doc_text = "\n\n".join(
        f"=== PAGE {p['page_num']} ({p.get('doc_type','Document')}) ===\n{p['text']}"
        for p in pages
    )

    chat = LlmChat(
        api_key=EMERGENT_LLM_KEY,
        session_id=f"chat-{req.session_id}",
        system_message=CHAT_SYSTEM,
    ).with_model(LLM_PROVIDER, LLM_MODEL).with_params(max_tokens=400)

    prompt = (
        f"Here is a document captured from a camera:\n\n{doc_text}\n\n"
        f"User question: {req.question}"
    )
    try:
        answer = await chat.send_message(UserMessage(text=prompt))
    except Exception as e:
        logger.exception("LLM chat failed")
        raise HTTPException(status_code=502, detail=f"Chat call failed: {e}")

    return ChatResponse(answer=answer.strip())


@api_router.get("/pages/{session_id}")
async def list_pages(session_id: str):
    pages = await db.pages.find(
        {"session_id": session_id}, {"_id": 0}
    ).sort("page_num", 1).to_list(50)
    return {"pages": pages}


@api_router.delete("/pages/{session_id}")
async def clear_pages(session_id: str):
    res = await db.pages.delete_many({"session_id": session_id})
    return {"deleted": res.deleted_count}


@api_router.get("/library")
async def list_library():
    """Return all captured sessions grouped as documents, newest first."""
    pipeline = [
        {"$sort": {"page_num": 1}},
        {
            "$group": {
                "_id": "$session_id",
                "pages": {"$sum": 1},
                "doc_type": {"$first": "$doc_type"},
                "summary": {"$first": "$summary"},
                "text_preview": {"$first": "$text"},
                "created_at": {"$min": "$created_at"},
            }
        },
        {"$sort": {"created_at": -1}},
        {"$limit": 100},
    ]
    out = []
    async for doc in db.pages.aggregate(pipeline):
        out.append({
            "session_id": doc["_id"],
            "pages": doc["pages"],
            "doc_type": doc.get("doc_type", "Document"),
            "summary": doc.get("summary", ""),
            "preview": (doc.get("text_preview", "") or "")[:160],
            "created_at": doc.get("created_at", ""),
        })
    return {"documents": out}


# Include router
app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
