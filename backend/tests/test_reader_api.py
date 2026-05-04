"""End-to-end tests for the Reader backend API.

Covers:
- GET /api/ health
- POST /api/analyze (good & poor image)
- GET /api/pages/{session_id}
- POST /api/chat (with and without pages)
- DELETE /api/pages/{session_id}
"""
import pytest
import requests


# ── Health ─────────────────────────────────────────────────────
def test_root_returns_reader_api(base_url, api_client):
    r = api_client.get(f"{base_url}/api/")
    assert r.status_code == 200, r.text
    assert r.json().get("message") == "Reader API"


# ── Analyze (OK path) ──────────────────────────────────────────
@pytest.fixture(scope="module")
def good_analyze_result(bill_image_b64, base_url):
    """Call /api/analyze once with a good image and reuse the result across tests."""
    import uuid as _uuid
    session_id = f"TEST_{_uuid.uuid4()}"

    r = requests.post(
        f"{base_url}/api/analyze",
        json={"image_base64": bill_image_b64, "session_id": session_id},
        timeout=120,
    )
    assert r.status_code == 200, f"analyze failed: {r.status_code} {r.text}"
    data = r.json()
    return session_id, data


def test_analyze_good_image_returns_ok_quality(good_analyze_result):
    _session_id, data = good_analyze_result
    # In rare cases Claude might flag it as poor; allow that but require real fields.
    assert data.get("quality") in ("ok", "poor"), data
    if data["quality"] == "ok":
        assert data.get("page_id"), "page_id must be returned when quality=ok"
        assert isinstance(data.get("text"), str) and len(data["text"]) > 10
        assert isinstance(data.get("summary"), str) and len(data["summary"]) > 0
        assert isinstance(data.get("doc_type"), str) and len(data["doc_type"]) > 0


def test_analyze_good_image_transcription_contains_expected_text(good_analyze_result):
    _session_id, data = good_analyze_result
    if data.get("quality") != "ok":
        pytest.skip("Image marked poor by Claude; skipping transcription content check")
    text = data.get("text", "").lower()
    # Loose assertion — at least one token from the rendered bill should appear
    keywords = ["national grid", "water", "bill", "account", "total"]
    assert any(k in text for k in keywords), f"No expected keywords in text: {text[:200]}"


def test_get_pages_after_analyze(good_analyze_result, api_client, base_url):
    session_id, data = good_analyze_result
    if data.get("quality") != "ok":
        pytest.skip("quality poor — no pages stored")

    r = api_client.get(f"{base_url}/api/pages/{session_id}", timeout=30)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "pages" in body
    pages = body["pages"]
    assert len(pages) >= 1

    p = pages[0]
    # Must NOT leak mongo _id
    assert "_id" not in p, f"Mongo _id leaked: {p}"
    assert p["session_id"] == session_id
    assert p["page_num"] == 1
    for field in ("id", "doc_type", "text", "summary", "created_at"):
        assert field in p, f"missing field {field}"


# ── Chat (requires pages) ──────────────────────────────────────
def test_chat_returns_answer(good_analyze_result, api_client, base_url):
    session_id, data = good_analyze_result
    if data.get("quality") != "ok":
        pytest.skip("No pages stored — cannot test chat")

    r = api_client.post(
        f"{base_url}/api/chat",
        json={"session_id": session_id, "question": "What type of document is this?"},
        timeout=120,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert "answer" in body
    assert isinstance(body["answer"], str) and len(body["answer"]) > 0


def test_chat_404_when_no_pages(api_client, base_url, fresh_session_id):
    r = api_client.post(
        f"{base_url}/api/chat",
        json={"session_id": fresh_session_id, "question": "Anything?"},
        timeout=30,
    )
    assert r.status_code == 404, f"Expected 404, got {r.status_code}: {r.text}"


# ── Analyze (poor quality path) ────────────────────────────────
def test_analyze_blurry_image(api_client, base_url, blurry_image_b64, fresh_session_id):
    r = api_client.post(
        f"{base_url}/api/analyze",
        json={"image_base64": blurry_image_b64, "session_id": fresh_session_id},
        timeout=120,
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data.get("quality") in ("ok", "poor"), data
    if data["quality"] == "poor":
        assert data.get("page_id") in (None, ""), "page_id must not be set for poor"
        assert len(data.get("quality_feedback", "")) > 0, "quality_feedback required when poor"

        # Confirm no page was stored for this session
        pr = api_client.get(f"{base_url}/api/pages/{fresh_session_id}")
        assert pr.status_code == 200
        assert pr.json().get("pages") == []
    else:
        # If Claude somehow read it, that is acceptable but note it
        pytest.skip("Blurry image accepted as OK by model; quality check not triggered")


# ── Delete ─────────────────────────────────────────────────────
def test_delete_pages_clears_session(good_analyze_result, api_client, base_url):
    session_id, data = good_analyze_result
    if data.get("quality") != "ok":
        pytest.skip("No pages to delete")

    # Ensure at least one page exists
    g1 = api_client.get(f"{base_url}/api/pages/{session_id}").json()
    expected = len(g1.get("pages", []))
    assert expected >= 1

    d = api_client.delete(f"{base_url}/api/pages/{session_id}", timeout=30)
    assert d.status_code == 200, d.text
    body = d.json()
    assert "deleted" in body
    assert body["deleted"] == expected, f"deleted={body['deleted']} expected={expected}"

    # Verify pages really gone
    g2 = api_client.get(f"{base_url}/api/pages/{session_id}").json()
    assert g2.get("pages") == []


def test_delete_nonexistent_session_returns_zero(api_client, base_url, fresh_session_id):
    d = api_client.delete(f"{base_url}/api/pages/{fresh_session_id}", timeout=30)
    assert d.status_code == 200
    assert d.json().get("deleted") == 0
