# Reader — PRD

## Overview
Reader is a native Expo mobile app for users with limited vision. It uses the device camera to scan documents (bills, letters, statements, books, newspapers, prescriptions), runs vision-based OCR + summarization, reads the summary aloud, and lets the user ask follow-up questions about the captured document.

## Stack
- Frontend: Expo SDK 54 (React Native + expo-router), expo-camera, expo-speech, expo-image-manipulator
- Backend: FastAPI + MongoDB (motor)
- AI: Claude Sonnet 4.5 (anthropic/claude-sonnet-4-5-20250929) via Emergent Universal LLM key (emergentintegrations)

## Core Flows
1. **Splash → Camera**: Tap "OPEN READER" → grant camera permission → live camera view.
2. **Capture**: Tap white circle → image is resized + JPEG-encoded → sent to /api/analyze.
3. **Quality check**: If poor quality, app speaks feedback and stays on camera. If ok, summary slides up with doc-type label and is spoken aloud.
4. **Q&A**: Tap "Ask" → text input → /api/chat returns a short spoken answer based on captured pages.
5. **Multi-page**: Toggle grid icon → capture each page in sequence → toggle again to finish (treated as one document).
6. **Drawer**: Full-screen modal with page pills + scrollable transcribed text.

## API Endpoints
| Method | Path | Purpose |
|---|---|---|
| GET | /api/ | Healthcheck |
| POST | /api/analyze | Image (base64) → quality + OCR + summary + doc_type + page_id |
| POST | /api/chat | Q&A grounded in captured pages of session_id |
| GET | /api/pages/{session_id} | List captured pages |
| DELETE | /api/pages/{session_id} | Clear session |

## Notes / Limitations
- Speech-to-text (voice commands) was scoped to native module which doesn't run in Expo Go preview; current MVP uses tap-to-capture and a text input for Q&A. TTS works in Expo Go via expo-speech.
- Stored pages persist in MongoDB keyed by session_id (regenerated on cold start).

## Future Enhancements (deferred)
- Voice commands ("read this", "summarize", "next page", "done") — requires custom dev build with expo-speech-recognition or @react-native-voice/voice.
- Section/paragraph navigation by voice.
- Server-side push of session sharing / save history.
