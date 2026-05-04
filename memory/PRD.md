# Reader — PRD

## Overview
Native Expo mobile app for users with limited vision. Camera-driven OCR + conversational AI grounded in whatever the user scans. All voice-first: continuous listening, barge-in, and optional wake-word mode.

## Stack
- **Frontend**: Expo SDK 54 (React Native, expo-router)
  - `expo-camera` — live camera + photo capture
  - `expo-speech` — text-to-speech
  - `expo-speech-recognition` (jamsch) — continuous on-device STT
  - `expo-image-manipulator` — resize + JPEG encode
- **Backend**: FastAPI + MongoDB (motor)
- **AI**: Claude Sonnet 4.5 (`claude-sonnet-4-5-20250929`) via Emergent Universal LLM key (emergentintegrations)

## Core Flows
1. **Splash → Camera + Voice**: Tap "OPEN READER" → grant camera + mic → continuous listening begins. Welcome prompt plays.
2. **Capture**: Say "read this" / "scan" / "capture", or tap the white circle.
3. **Quality check**: Poor → Reader speaks advice, stays on camera. OK → summary slides up + spoken.
4. **Voice Q&A**: Any non-command speech is routed to `/api/chat` for a short spoken answer. Barge-in: user speech interrupts TTS.
5. **Navigation**: "next / previous paragraph", "next / previous section", "next / previous page".
6. **Multi-page**: "multiple pages" → capture each → "done".
7. **Wake word (optional)**: "go to sleep" → Reader only reacts after "Hey Reader ...". "wake up" → always-on again.
8. **Library**: Every scanned document persists in Mongo. Tap the "Library" quick-action or say "library" to browse past documents. Tap an item to re-open (summary + pages); tap × to delete.

## API Endpoints
| Method | Path | Purpose |
|---|---|---|
| GET | /api/ | Healthcheck |
| POST | /api/analyze | Image (base64) → {quality, quality_feedback, text, summary, doc_type, page_id} |
| POST | /api/chat | Q&A grounded in captured pages of session_id |
| GET | /api/pages/{session_id} | List captured pages |
| DELETE | /api/pages/{session_id} | Clear session |
| GET | /api/library | Aggregate all sessions, newest first, with page count + first-page preview |

## Voice Architecture
- Continuous STT starts on launch after mic permission.
- TTS start → STT stop; TTS end → STT auto-restart (prevents self-hearing loop).
- Partial transcripts shown live in top bar between quotes.
- `handleVoice` regex-routes commands (capture, nav, summarize, read, repeat, stop, library, show doc, clear, help, wake/sleep, multi-page). Non-command speech with a document loaded is sent to `/api/chat`.
- Wake word: `hey/ok/okay/hi/hello reader` — activates 10-second interaction window; enabled only in sleep mode.

## Expo Go Limitation (important)
`expo-speech-recognition` and `expo-camera` (full quality) require a custom dev build — they do NOT run in Expo Go or the headless web preview. Camera shows but STT won't fire. To experience the full flow: click Emergent's **Publish** button to trigger an EAS build and install the APK/IPA.

## Backend Tests
- 13/13 passing at iteration 2
- Suite at `/app/backend/tests/{test_reader_api.py,test_library_api.py}`

## Future Enhancements
- Pagination metadata on `/api/library` (currently caps at 100 latest).
- Cloud-backed login so the library follows a user across devices.
- Paragraph-by-paragraph follow-along highlight in the drawer while TTS reads.
