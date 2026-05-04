"""Tests for the new GET /api/library aggregation endpoint.

Uses direct pymongo writes so we do NOT burn Claude credits — the endpoint
only performs a MongoDB aggregation over the `pages` collection.
"""
import os
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import pymongo
from dotenv import dotenv_values


# ── Mongo helper ───────────────────────────────────────────────
def _mongo_collection():
    backend_env = Path(__file__).resolve().parents[1] / ".env"
    vals = dotenv_values(str(backend_env))
    mongo_url = vals.get("MONGO_URL") or os.environ.get("MONGO_URL")
    db_name = vals.get("DB_NAME") or os.environ.get("DB_NAME")
    assert mongo_url and db_name, "MONGO_URL/DB_NAME missing from backend/.env"
    client = pymongo.MongoClient(mongo_url, serverSelectionTimeoutMS=5000)
    return client, client[db_name]["pages"]


@pytest.fixture()
def pages_collection():
    client, coll = _mongo_collection()
    yield coll
    # Cleanup any TEST_ seeded sessions after each test
    coll.delete_many({"session_id": {"$regex": "^LIBTEST_"}})
    client.close()


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


def _seed_page(coll, session_id: str, page_num: int, *, doc_type, summary,
               text, created_at: datetime):
    coll.insert_one({
        "id": str(uuid.uuid4()),
        "session_id": session_id,
        "page_num": page_num,
        "doc_type": doc_type,
        "summary": summary,
        "text": text,
        "created_at": _iso(created_at),
    })


# ── Tests ──────────────────────────────────────────────────────
def test_library_empty_returns_documents_array(api_client, base_url, pages_collection):
    # Wipe anything that might currently be in the DB so the endpoint is truly empty.
    # Instead of nuking real data, just assert the shape + that only non-LIBTEST items
    # exist. An "empty" assertion is only safe on a truly empty DB, so first clear ALL
    # pages (this DB is a test DB named test_database per backend/.env).
    pages_collection.delete_many({})

    r = api_client.get(f"{base_url}/api/library", timeout=30)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "documents" in body
    assert body["documents"] == []


def test_library_groups_sessions_and_orders_newest_first(api_client, base_url, pages_collection):
    pages_collection.delete_many({})

    now = datetime.now(timezone.utc)

    # Session A: older, 1 page, Water Bill
    sid_a = f"LIBTEST_{uuid.uuid4()}"
    _seed_page(
        pages_collection, sid_a, 1,
        doc_type="Water Bill",
        summary="This is a water bill from National Grid, dated March twenty twenty five.",
        text="NATIONAL GRID Water Bill — Account 4421-9087-23 — Total due $80.33 — " +
             ("extra filler text " * 30),  # >160 chars so preview must be truncated
        created_at=now - timedelta(hours=2),
    )

    # Session B: newer, 3 pages, Book Page. The first-in-page_num page defines
    # doc_type/summary/preview — seed out of order to be sure $sort:{page_num:1} works.
    sid_b = f"LIBTEST_{uuid.uuid4()}"
    _seed_page(
        pages_collection, sid_b, 3,
        doc_type="WRONG_TYPE_SHOULD_NOT_APPEAR",
        summary="WRONG_SUMMARY",
        text="Page 3 text content.",
        created_at=now - timedelta(minutes=9),
    )
    _seed_page(
        pages_collection, sid_b, 1,
        doc_type="Book Page",
        summary="This is a page from a novel.",
        text="Chapter One. It was a bright cold day in April.",
        created_at=now - timedelta(minutes=10),
    )
    _seed_page(
        pages_collection, sid_b, 2,
        doc_type="WRONG_TYPE_2",
        summary="WRONG_SUMMARY_2",
        text="Page 2 body.",
        created_at=now - timedelta(minutes=8),
    )

    r = api_client.get(f"{base_url}/api/library", timeout=30)
    assert r.status_code == 200, r.text
    docs = r.json()["documents"]
    assert isinstance(docs, list)
    assert len(docs) == 2, docs

    # 1. Newest first — Session B was created ~10 min ago, Session A 2 h ago.
    assert docs[0]["session_id"] == sid_b, f"Order wrong: {[d['session_id'] for d in docs]}"
    assert docs[1]["session_id"] == sid_a

    # 2. No mongo _id leakage anywhere
    for d in docs:
        assert "_id" not in d, f"Leaked _id: {d}"

    # 3. Required fields present
    required = {"session_id", "pages", "doc_type", "summary", "preview", "created_at"}
    for d in docs:
        missing = required - set(d.keys())
        assert not missing, f"Missing fields {missing} in {d}"

    # 4. Session B picks doc_type/summary/preview from page_num=1 (Book Page)
    b = docs[0]
    assert b["pages"] == 3, b
    assert b["doc_type"] == "Book Page", b
    assert b["summary"] == "This is a page from a novel.", b
    assert b["preview"].startswith("Chapter One."), b

    # 5. Session A preview is <=160 chars
    a = docs[1]
    assert a["pages"] == 1
    assert a["doc_type"] == "Water Bill"
    assert len(a["preview"]) <= 160, f"Preview length {len(a['preview'])} exceeds 160"
    assert a["preview"].startswith("NATIONAL GRID Water Bill"), a["preview"]


def test_library_reflects_deletion(api_client, base_url, pages_collection):
    pages_collection.delete_many({})
    now = datetime.now(timezone.utc)

    sid_keep = f"LIBTEST_{uuid.uuid4()}"
    sid_del = f"LIBTEST_{uuid.uuid4()}"

    _seed_page(pages_collection, sid_keep, 1,
               doc_type="Prescription", summary="A prescription.",
               text="Rx: Amoxicillin 500mg",
               created_at=now - timedelta(minutes=5))
    _seed_page(pages_collection, sid_del, 1,
               doc_type="Bank Statement", summary="A bank statement.",
               text="Account ending 1234 — balance $500",
               created_at=now - timedelta(minutes=1))

    # Both should be listed
    r1 = api_client.get(f"{base_url}/api/library", timeout=30)
    assert r1.status_code == 200
    sids = [d["session_id"] for d in r1.json()["documents"]]
    assert sid_keep in sids and sid_del in sids

    # Delete one session via the public API
    d = api_client.delete(f"{base_url}/api/pages/{sid_del}", timeout=30)
    assert d.status_code == 200
    assert d.json().get("deleted") == 1

    # Library must no longer contain the deleted session
    r2 = api_client.get(f"{base_url}/api/library", timeout=30)
    assert r2.status_code == 200
    remaining = [d["session_id"] for d in r2.json()["documents"]]
    assert sid_del not in remaining, f"Deleted session still in library: {remaining}"
    assert sid_keep in remaining


def test_library_preview_truncated_to_160(api_client, base_url, pages_collection):
    pages_collection.delete_many({})
    sid = f"LIBTEST_{uuid.uuid4()}"
    long_text = "A" * 500
    _seed_page(pages_collection, sid, 1,
               doc_type="Letter", summary="A letter.",
               text=long_text,
               created_at=datetime.now(timezone.utc))

    r = api_client.get(f"{base_url}/api/library", timeout=30)
    assert r.status_code == 200
    docs = r.json()["documents"]
    assert len(docs) == 1
    assert len(docs[0]["preview"]) == 160
    assert docs[0]["preview"] == "A" * 160
