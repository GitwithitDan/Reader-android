# Reader — PRD

## Overview
Reader is a native Expo mobile app for users with limited vision. It uses the device camera to scan documents (bills, letters, statements, books, newspapers, prescriptions), runs vision-based OCR + summarization, reads the summary aloud, and lets the user ask follow-up questions about the captured document — all via continuous voice interaction.

## Stack
- **Frontend**: Expo SDK 54 (React Native + expo-router)
  - `expo-camera` for live camera + photo capture
  - `expo-speech` for text-to-speech
  - `expo-speech-recognition` (jamsch) for continuous on-device speech-to-text
  - `expo-image-manipulator` for image resize + JPEG encoding
- **Backend**: FastAPI + MongoDB (motor)
- **AI**: Claude Sonnet 4.5 (`claude-sonnet-4-5-20250929`) via Emergent Universal LLM key (emergentintegrations)

## Core Flows
1. **Splash → Camera + Voice**: Tap "OPEN READER" → grant camera + mic permission → live camera with continuous mic listening.
2. **Capture**: Say "read this" / "scan" / "capture" OR tap the white circle.
3. **Quality check**: If poor, Reader speaks advice and stays on camera. If ok, summary slides up + spoken aloud.
4. **Voice Q&A**: Any speech longer than a short phrase (that isn't a command) is treated as a question → `/api/chat` → spoken answer. Barge-in: any speech interrupts the current TTS.
5. **Multi-page**: Say "multiple pages" (or tap grid). Capture each page. Say "done" (or tap grid) to finish.
6. **Voice commands**: read this / scan / capture / summarize / read it to me / repeat / stop / show document / clear / help / next (in multi mode) / done.

## API Endpoints
| Method | Path | Purpose |
|---|---|---|
| GET | /api/ | Healthcheck |
| POST | /api/analyze | Image (base64) → {quality, quality_feedback, text, summary, doc_type, page_id} |
| POST | /api/chat | Q&A grounded in captured pages of session_id |
| GET | /api/pages/{session_id} | List captured pages |
| DELETE | /api/pages/{session_id} | Clear session |

## Voice Architecture
- `expo-speech-recognition` is started continuously on app open (after mic permission).
- When the AI starts speaking, recognition is stopped; when TTS ends, recognition is restarted (prevents Reader from hearing itself).
- Partial transcripts are shown in the top bar in quotes for visual feedback.
- Finalised transcripts are routed through `handleVoice` which checks regex-based command patterns first, then falls back to treating the text as a question if a document is captured.
- A top-bar mic button lets the user toggle voice off entirely.

## IMPORTANT — Expo Go Limitation
- **`expo-speech-recognition` is a native module and DOES NOT run in Expo Go.**
- In the Expo Go preview (QR code), voice features will not work — only tap-to-capture + text-input Q&A.
- **To experience full conversational voice commands, the app must be built as a custom dev build or production build** (use the Emergent "Publish" button in the top-right to trigger an EAS build and install the generated APK/IPA).

## Future Enhancements (deferred)
- On-device wake-word ("hey reader") to resume listening after a long silence.
- Section/paragraph navigation commands ("next paragraph").
- Shareable / saved document history (MongoDB already stores pages; UI can surface a library).
