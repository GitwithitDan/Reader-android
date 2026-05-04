import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Speech from "expo-speech";
import * as ImageManipulator from "expo-image-manipulator";

const BACKEND = process.env.EXPO_PUBLIC_BACKEND_URL;
const C = {
  bg: "#18140f",
  cream: "#f0e6d0",
  amber: "#c8781a",
  dim: "rgba(240,230,208,0.45)",
  border: "rgba(240,230,208,0.18)",
  black70: "rgba(0,0,0,0.7)",
  green: "#4ade80",
  cardBg: "rgba(14,10,5,0.94)",
};

type Page = {
  page_id: string;
  page_num: number;
  doc_type: string;
  text: string;
  summary: string;
};

function makeSessionId() {
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function ReaderApp() {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);

  const [opened, setOpened] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerPageIdx, setDrawerPageIdx] = useState(0);

  const [sessionId] = useState(makeSessionId);
  const [pages, setPages] = useState<Page[]>([]);
  const [multiMode, setMultiMode] = useState(false);

  const [processing, setProcessing] = useState(false);
  const [procText, setProcText] = useState("Reading…");
  const [speaking, setSpeaking] = useState(false);

  const [summary, setSummary] = useState<{ docType: string; text: string } | null>(null);
  const [summaryCollapsed, setSummaryCollapsed] = useState(false);
  const summaryAnim = useRef(new Animated.Value(0)).current; // 0 hidden -> 1 visible

  const [toast, setToast] = useState("");
  const toastAnim = useRef(new Animated.Value(0)).current;

  const flashAnim = useRef(new Animated.Value(0)).current;
  const cornerAnim = useRef(new Animated.Value(0)).current; // 0 white -> 1 green

  const [askText, setAskText] = useState("");
  const [askOpen, setAskOpen] = useState(false);

  const [mode, setMode] = useState("Point at a document");

  // Permissions on first open
  useEffect(() => {
    if (opened && (!permission || !permission.granted)) {
      requestPermission();
    }
  }, [opened]);

  // Toast helper
  const showToast = (msg: string, ms = 2000) => {
    setToast(msg);
    Animated.timing(toastAnim, { toValue: 1, duration: 200, useNativeDriver: true }).start();
    setTimeout(() => {
      Animated.timing(toastAnim, { toValue: 0, duration: 200, useNativeDriver: true }).start();
    }, ms);
  };

  // Summary slide
  const slideSummary = (visible: boolean) => {
    Animated.spring(summaryAnim, {
      toValue: visible ? 1 : 0,
      useNativeDriver: true,
      bounciness: 6,
      speed: 14,
    }).start();
  };

  // Speak helpers
  const speak = (text: string) => {
    Speech.stop();
    setSpeaking(true);
    Speech.speak(text, {
      language: "en-US",
      rate: 0.96,
      pitch: 1.0,
      onDone: () => setSpeaking(false),
      onStopped: () => setSpeaking(false),
      onError: () => setSpeaking(false),
    });
  };
  const stopSpeak = () => {
    Speech.stop();
    setSpeaking(false);
  };

  // Show summary box
  const presentSummary = (docType: string, text: string) => {
    setSummary({ docType, text });
    setSummaryCollapsed(false);
    slideSummary(true);
  };

  const flashCorners = () => {
    Animated.sequence([
      Animated.timing(flashAnim, { toValue: 1, duration: 60, useNativeDriver: true }),
      Animated.timing(flashAnim, { toValue: 0, duration: 380, useNativeDriver: true }),
    ]).start();
    Animated.sequence([
      Animated.timing(cornerAnim, { toValue: 1, duration: 200, useNativeDriver: false }),
      Animated.delay(700),
      Animated.timing(cornerAnim, { toValue: 0, duration: 300, useNativeDriver: false }),
    ]).start();
  };

  // Capture flow
  const capture = async () => {
    if (processing) return;
    if (!cameraRef.current) {
      showToast("Camera not ready");
      return;
    }
    if (speaking) stopSpeak();

    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.7,
        base64: false,
        skipProcessing: true,
      });
      if (!photo?.uri) {
        showToast("Capture failed");
        return;
      }

      // Resize and re-encode to JPEG to keep payload small
      const manipulated = await ImageManipulator.manipulateAsync(
        photo.uri,
        [{ resize: { width: 1600 } }],
        { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG, base64: true }
      );
      const b64 = manipulated.base64;
      if (!b64) {
        showToast("Could not encode image");
        return;
      }

      // Trigger flash visual
      Animated.sequence([
        Animated.timing(flashAnim, { toValue: 0.85, duration: 50, useNativeDriver: true }),
        Animated.timing(flashAnim, { toValue: 0, duration: 380, useNativeDriver: true }),
      ]).start();

      setProcText("Reading…");
      setProcessing(true);
      setMode("Reading…");

      const res = await fetch(`${BACKEND}/api/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_base64: b64, session_id: sessionId }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`HTTP ${res.status}: ${errText}`);
      }
      const data = await res.json();
      setProcessing(false);

      if (data.quality === "poor") {
        const fb =
          data.quality_feedback ||
          "I could not read the document clearly. Try re-centering or adjusting the light.";
        setMode("Try again");
        showToast("Quality issue");
        speak(fb);
        return;
      }

      const newPage: Page = {
        page_id: data.page_id,
        page_num: pages.length + 1,
        doc_type: data.doc_type || "Document",
        text: data.text || "",
        summary: data.summary || "",
      };
      setPages((prev) => [...prev, newPage]);
      flashCorners();

      presentSummary(newPage.doc_type, newPage.summary);

      if (multiMode) {
        setMode(`Page ${newPage.page_num} captured — tap + or "Done"`);
        speak(`Page ${newPage.page_num} captured. ${newPage.summary}`);
      } else {
        setMode("Ask anything about it");
        speak(newPage.summary);
      }
    } catch (e: any) {
      setProcessing(false);
      console.error("Capture error", e);
      showToast("Something went wrong");
      speak("Something went wrong. Please try again.");
    }
  };

  // Multi-page toggle
  const toggleMulti = () => {
    if (multiMode) {
      // Finish
      setMultiMode(false);
      const n = pages.length;
      if (n > 0) {
        setMode(`${n} page${n > 1 ? "s" : ""} saved — ask anything`);
        speak(`All ${n} page${n > 1 ? "s" : ""} saved. What would you like to know?`);
      } else {
        setMode("Point at a document");
      }
    } else {
      // Start: clear existing
      clearAll(false);
      setMultiMode(true);
      setMode("Multi-page — capture each page");
      speak(
        "Multi-page mode is on. Capture each page, then tap the multi-page button again when finished."
      );
    }
  };

  // Clear
  const clearAll = async (announce = true) => {
    setPages([]);
    setSummary(null);
    slideSummary(false);
    setMode("Point at a document");
    try {
      await fetch(`${BACKEND}/api/pages/${sessionId}`, { method: "DELETE" });
    } catch {}
    if (announce) speak("Document cleared. Ready for a new one.");
  };

  // Q&A
  const askQuestion = async () => {
    const q = askText.trim();
    if (!q) return;
    if (!pages.length) {
      showToast("Capture a document first");
      return;
    }
    setAskText("");
    setAskOpen(false);
    setProcText("Thinking…");
    setProcessing(true);
    setMode("Thinking…");

    try {
      const res = await fetch(`${BACKEND}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, question: q }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setProcessing(false);
      setMode("Ask anything about it");
      presentSummary("Answer", data.answer);
      speak(data.answer);
    } catch (e) {
      setProcessing(false);
      setMode("Ask anything about it");
      showToast("Could not reach the assistant");
      speak("Something went wrong. Please try again.");
    }
  };

  // Read full
  const readFull = () => {
    if (!pages.length) {
      speak("No document captured yet.");
      return;
    }
    const all = pages.map((p) => p.text).join("\n\n");
    presentSummary("Full text", all);
    speak(all);
  };

  const summarizeAll = () => {
    if (!pages.length) {
      speak("No document captured yet.");
      return;
    }
    const text = pages.length === 1
      ? pages[0].summary
      : pages.map((p, i) => `Page ${i + 1}: ${p.summary}`).join(" ");
    presentSummary("Summary", text);
    speak(text);
  };

  // ── RENDER ──────────────────────────────────────────────────
  if (!opened) {
    return <Splash onOpen={() => setOpened(true)} onHelp={() => setHelpOpen(true)} helpVisible={helpOpen} closeHelp={() => setHelpOpen(false)} />;
  }

  if (!permission) {
    return (
      <View style={styles.permWrap}>
        <ActivityIndicator color={C.amber} />
      </View>
    );
  }
  if (!permission.granted) {
    return (
      <View style={styles.permWrap}>
        <Text style={styles.permTitle}>Camera access needed</Text>
        <Text style={styles.permBody}>
          Reader needs your camera to scan documents.
        </Text>
        <TouchableOpacity
          testID="grant-camera-btn"
          style={styles.permBtn}
          onPress={requestPermission}
        >
          <Text style={styles.permBtnText}>GRANT CAMERA</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const summaryTranslateY = summaryAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [400, 0],
  });

  const cornerColor = cornerAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ["rgba(240,230,208,0.55)", C.green],
  });

  const screenH = Dimensions.get("window").height;

  return (
    <View style={styles.root}>
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFillObject}
        facing="back"
      />

      {/* Tap to interrupt overlay */}
      <Pressable
        testID="tap-to-interrupt"
        style={StyleSheet.absoluteFillObject}
        onPress={() => {
          if (speaking) stopSpeak();
        }}
      />

      {/* Capture flash */}
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFillObject,
          { backgroundColor: "#fff", opacity: flashAnim },
        ]}
      />

      {/* Top bar */}
      <View style={[styles.topBar, { paddingTop: insets.top + 6 }]}>
        <View
          style={[
            styles.micDot,
            { backgroundColor: speaking ? C.amber : C.green },
          ]}
        />
        <Text style={styles.modeLabel} numberOfLines={1}>
          {speaking ? "Speaking…" : mode}
        </Text>
        {pages.length > 0 && (
          <Text style={styles.pageCounter} testID="page-counter">
            {pages.length === 1 ? "1 pg" : `${pages.length} pgs`}
          </Text>
        )}
        <TouchableOpacity
          testID="help-btn-top"
          onPress={() => setHelpOpen(true)}
          style={styles.helpBtn}
        >
          <Text style={styles.helpBtnText}>?</Text>
        </TouchableOpacity>
      </View>

      {/* Multi-page mini bar */}
      {multiMode && (
        <View style={[styles.multiBar, { top: insets.top + 56 }]}>
          {pages.map((p) => (
            <View key={p.page_id} style={[styles.mdot, styles.mdotCaptured]} />
          ))}
          <View style={styles.mdot} />
        </View>
      )}

      {/* Viewfinder corners */}
      <View pointerEvents="none" style={styles.viewfinder}>
        <Animated.View style={[styles.vfc, styles.tl, { borderColor: cornerColor }]} />
        <Animated.View style={[styles.vfc, styles.tr, { borderColor: cornerColor }]} />
        <Animated.View style={[styles.vfc, styles.bl, { borderColor: cornerColor }]} />
        <Animated.View style={[styles.vfc, styles.br, { borderColor: cornerColor }]} />
      </View>

      {/* Processing overlay */}
      {processing && (
        <View style={styles.procWrap} pointerEvents="auto">
          <ActivityIndicator size="large" color={C.amber} />
          <Text style={styles.procText}>{procText}</Text>
        </View>
      )}

      {/* Summary box */}
      {summary && (
        <Animated.View
          testID="summary-box"
          style={[
            styles.summaryBox,
            {
              transform: [{ translateY: summaryTranslateY }],
              bottom: insets.bottom + 122,
              maxHeight: summaryCollapsed ? 50 : screenH * 0.42,
            },
          ]}
        >
          <View style={styles.summaryHandle}>
            <Text style={styles.summaryLabel}>{summary.docType.toUpperCase()}</Text>
            <View style={styles.summaryActions}>
              <TouchableOpacity
                testID="summary-replay"
                onPress={() => speak(summary.text)}
                style={styles.summaryIconBtn}
              >
                <Text style={styles.summaryIcon}>↻</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="summary-collapse"
                onPress={() => setSummaryCollapsed((c) => !c)}
                style={styles.summaryIconBtn}
              >
                <Text style={styles.summaryIcon}>{summaryCollapsed ? "︿" : "﹀"}</Text>
              </TouchableOpacity>
            </View>
          </View>
          {!summaryCollapsed && (
            <ScrollView
              style={styles.summaryScroll}
              contentContainerStyle={{ paddingBottom: 16 }}
              showsVerticalScrollIndicator={false}
            >
              <Text style={styles.summaryText}>{summary.text}</Text>
            </ScrollView>
          )}
        </Animated.View>
      )}

      {/* Ask input */}
      {askOpen && (
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={[styles.askWrap, { bottom: insets.bottom + 122 }]}
        >
          <TextInput
            testID="ask-input"
            value={askText}
            onChangeText={setAskText}
            placeholder="Ask about this document…"
            placeholderTextColor={C.dim}
            style={styles.askInput}
            autoFocus
            returnKeyType="send"
            onSubmitEditing={askQuestion}
          />
          <TouchableOpacity testID="ask-send" onPress={askQuestion} style={styles.askSend}>
            <Text style={styles.askSendText}>Ask</Text>
          </TouchableOpacity>
        </KeyboardAvoidingView>
      )}

      {/* Bottom controls */}
      <View style={[styles.controls, { paddingBottom: insets.bottom + 14 }]}>
        <TouchableOpacity
          testID="multi-page-btn"
          onPress={toggleMulti}
          style={[styles.sideBtn, multiMode && styles.sideBtnActive]}
        >
          <Text style={[styles.sideIcon, multiMode && { color: C.amber }]}>⊞</Text>
        </TouchableOpacity>

        <TouchableOpacity
          testID="capture-btn"
          onPress={capture}
          activeOpacity={0.85}
          style={styles.captureBtn}
        >
          <View style={styles.captureRing} />
        </TouchableOpacity>

        <TouchableOpacity
          testID="document-drawer-btn"
          onPress={() => {
            if (!pages.length) {
              showToast("No document yet");
              return;
            }
            setDrawerPageIdx(0);
            setDrawerOpen(true);
          }}
          style={styles.sideBtn}
        >
          <Text style={styles.sideIcon}>≡</Text>
        </TouchableOpacity>
      </View>

      {/* Quick actions row */}
      <View style={[styles.quickRow, { bottom: insets.bottom + 100 }]}>
        <QuickBtn label="Ask" onPress={() => setAskOpen((o) => !o)} testID="ask-toggle" disabled={!pages.length} />
        <QuickBtn label="Summary" onPress={summarizeAll} testID="summary-action" disabled={!pages.length} />
        <QuickBtn label="Read" onPress={readFull} testID="read-full" disabled={!pages.length} />
        <QuickBtn label="Stop" onPress={stopSpeak} testID="stop-speak" disabled={!speaking} />
        <QuickBtn label="Clear" onPress={() => clearAll(true)} testID="clear-btn" disabled={!pages.length} />
      </View>

      {/* Toast */}
      <Animated.View
        pointerEvents="none"
        style={[
          styles.toast,
          { bottom: insets.bottom + 200, opacity: toastAnim },
        ]}
      >
        <Text style={styles.toastText}>{toast}</Text>
      </Animated.View>

      {/* Document drawer */}
      <Modal
        visible={drawerOpen}
        animationType="slide"
        onRequestClose={() => setDrawerOpen(false)}
      >
        <SafeAreaView style={styles.drawer}>
          <View style={styles.drawerHeader}>
            <Text style={styles.drawerTitle}>Captured Document</Text>
            <TouchableOpacity testID="drawer-close" onPress={() => setDrawerOpen(false)}>
              <Text style={styles.drawerClose}>×</Text>
            </TouchableOpacity>
          </View>
          {pages.length > 1 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.pillsRow}>
              {pages.map((p, i) => (
                <TouchableOpacity
                  key={p.page_id}
                  onPress={() => setDrawerPageIdx(i)}
                  style={[styles.pill, drawerPageIdx === i && styles.pillActive]}
                >
                  <Text style={[styles.pillText, drawerPageIdx === i && { color: "#111" }]}>
                    Page {i + 1}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}
          <ScrollView style={styles.drawerBody} contentContainerStyle={{ padding: 22 }}>
            <Text style={styles.drawerDocType}>
              {pages[drawerPageIdx]?.doc_type?.toUpperCase()}
            </Text>
            <Text style={styles.drawerText}>
              {pages[drawerPageIdx]?.text || ""}
            </Text>
          </ScrollView>
        </SafeAreaView>
      </Modal>

      {/* Help overlay */}
      <HelpOverlay visible={helpOpen} onClose={() => setHelpOpen(false)} />
    </View>
  );
}

// ── Splash ────────────────────────────────────────────────────
function Splash({
  onOpen,
  onHelp,
  helpVisible,
  closeHelp,
}: {
  onOpen: () => void;
  onHelp: () => void;
  helpVisible: boolean;
  closeHelp: () => void;
}) {
  return (
    <View style={styles.splash}>
      <Text style={styles.splashTitle}>Reader</Text>
      <TouchableOpacity testID="open-reader-btn" style={styles.splashBtn} onPress={onOpen}>
        <Text style={styles.splashBtnText}>OPEN READER</Text>
      </TouchableOpacity>
      <TouchableOpacity testID="help-btn-splash" onPress={onHelp} style={styles.helpBtnSplash}>
        <Text style={styles.helpBtnText}>?</Text>
      </TouchableOpacity>
      <HelpOverlay visible={helpVisible} onClose={closeHelp} />
    </View>
  );
}

// ── Help Overlay ──────────────────────────────────────────────
function HelpOverlay({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  return (
    <Modal visible={visible} animationType="fade" onRequestClose={onClose}>
      <SafeAreaView style={styles.helpRoot}>
        <View style={styles.helpHeader}>
          <Text style={styles.helpHeaderTitle}>How to use Reader</Text>
          <TouchableOpacity testID="help-close" onPress={onClose}>
            <Text style={styles.helpClose}>×</Text>
          </TouchableOpacity>
        </View>
        <ScrollView contentContainerStyle={{ padding: 24, paddingBottom: 60 }}>
          <Text style={styles.helpSection}>OPENING</Text>
          <Text style={styles.helpBody}>
            Tap Open Reader and allow camera. The app shows a live camera view.
          </Text>

          <Text style={styles.helpSection}>SCANNING</Text>
          <Text style={styles.helpBody}>
            Point your phone at the document. Tap the white circle to capture. Reader will check
            quality, transcribe the text, and read a brief overview aloud.
          </Text>

          <Text style={styles.helpSection}>ASKING QUESTIONS</Text>
          <Text style={styles.helpBody}>
            Tap Ask, type your question, then send. Reader answers aloud using the captured
            document as context.
          </Text>

          <Text style={styles.helpSection}>QUICK ACTIONS</Text>
          <Text style={styles.helpBody}>
            • Summary — speaks a brief overview{"\n"}
            • Read — reads the full text aloud{"\n"}
            • Stop — silences the current speech{"\n"}
            • Clear — starts a new document
          </Text>

          <Text style={styles.helpSection}>MULTIPLE PAGES</Text>
          <Text style={styles.helpBody}>
            Tap the grid icon to start multi-page mode. Capture each page in sequence, then tap
            the grid icon again to finish. Reader treats them as one document.
          </Text>

          <Text style={styles.helpSection}>TIPS</Text>
          <Text style={styles.helpBody}>
            Hold steady before capturing. Tap anywhere on the camera to silence Reader mid-sentence.
            Open the document drawer (≡) to view full text by page.
          </Text>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

// ── Quick Btn ─────────────────────────────────────────────────
function QuickBtn({
  label,
  onPress,
  disabled,
  testID,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <TouchableOpacity
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      style={[styles.quickBtn, disabled && { opacity: 0.35 }]}
    >
      <Text style={styles.quickBtnText}>{label}</Text>
    </TouchableOpacity>
  );
}

// ── Styles ────────────────────────────────────────────────────
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },

  // Splash
  splash: {
    flex: 1,
    backgroundColor: C.bg,
    alignItems: "center",
    justifyContent: "center",
    gap: 36,
  },
  splashTitle: {
    fontFamily: Platform.select({ ios: "Georgia", android: "serif" }),
    fontSize: 80,
    color: C.cream,
    letterSpacing: -2,
  },
  splashBtn: {
    backgroundColor: C.amber,
    paddingHorizontal: 58,
    paddingVertical: 18,
    borderRadius: 14,
  },
  splashBtnText: {
    color: "#111",
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: 1.6,
  },
  helpBtnSplash: {
    position: "absolute",
    bottom: 36,
    right: 22,
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "rgba(240,230,208,0.1)",
    borderWidth: 1,
    borderColor: "rgba(240,230,208,0.25)",
    alignItems: "center",
    justifyContent: "center",
  },
  helpBtnText: { color: C.cream, fontSize: 16, fontWeight: "600" },

  // Permissions
  permWrap: {
    flex: 1,
    backgroundColor: C.bg,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
  },
  permTitle: {
    color: C.cream,
    fontSize: 24,
    fontFamily: Platform.select({ ios: "Georgia", android: "serif" }),
    marginBottom: 12,
  },
  permBody: {
    color: C.dim,
    fontSize: 16,
    textAlign: "center",
    marginBottom: 32,
    lineHeight: 24,
  },
  permBtn: {
    backgroundColor: C.amber,
    paddingHorizontal: 36,
    paddingVertical: 14,
    borderRadius: 12,
  },
  permBtnText: {
    color: "#111",
    fontSize: 14,
    fontWeight: "700",
    letterSpacing: 1.4,
  },

  // Top bar
  topBar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 18,
    paddingBottom: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  micDot: { width: 10, height: 10, borderRadius: 5 },
  modeLabel: { flex: 1, color: "rgba(255,255,255,0.78)", fontSize: 13 },
  pageCounter: { color: "rgba(255,255,255,0.65)", fontSize: 13, marginRight: 8 },
  helpBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "rgba(240,230,208,0.12)",
    borderWidth: 1,
    borderColor: "rgba(240,230,208,0.25)",
    alignItems: "center",
    justifyContent: "center",
  },

  // Multi bar
  multiBar: {
    position: "absolute",
    left: 16,
    right: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
    backgroundColor: "rgba(0,0,0,0.45)",
    padding: 8,
    borderRadius: 10,
  },
  mdot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.4)",
  },
  mdotCaptured: { backgroundColor: C.green, borderColor: C.green },

  // Viewfinder
  viewfinder: {
    position: "absolute",
    top: "22%",
    left: "8%",
    right: "8%",
    bottom: "32%",
  },
  vfc: { position: "absolute", width: 26, height: 26, borderColor: C.dim },
  tl: { top: 0, left: 0, borderTopWidth: 2.5, borderLeftWidth: 2.5 },
  tr: { top: 0, right: 0, borderTopWidth: 2.5, borderRightWidth: 2.5 },
  bl: { bottom: 0, left: 0, borderBottomWidth: 2.5, borderLeftWidth: 2.5 },
  br: { bottom: 0, right: 0, borderBottomWidth: 2.5, borderRightWidth: 2.5 },

  // Processing
  procWrap: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.7)",
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
  },
  procText: { color: "rgba(255,255,255,0.8)", fontSize: 15 },

  // Summary
  summaryBox: {
    position: "absolute",
    left: 12,
    right: 12,
    backgroundColor: C.cardBg,
    borderColor: "rgba(200,120,26,0.28)",
    borderWidth: 1,
    borderRadius: 18,
    overflow: "hidden",
  },
  summaryHandle: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 6,
  },
  summaryLabel: {
    color: C.amber,
    fontSize: 11,
    letterSpacing: 1.2,
    fontWeight: "700",
  },
  summaryActions: { flexDirection: "row", gap: 6 },
  summaryIconBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  summaryIcon: { color: C.dim, fontSize: 16 },
  summaryScroll: { paddingHorizontal: 18 },
  summaryText: {
    color: C.cream,
    fontSize: 21,
    lineHeight: 32,
    fontFamily: Platform.select({ ios: "Georgia", android: "serif" }),
    paddingBottom: 6,
  },

  // Ask
  askWrap: {
    position: "absolute",
    left: 12,
    right: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: C.cardBg,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(200,120,26,0.3)",
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  askInput: {
    flex: 1,
    color: C.cream,
    fontSize: 16,
    paddingVertical: 10,
  },
  askSend: {
    backgroundColor: C.amber,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 10,
  },
  askSendText: { color: "#111", fontWeight: "700", fontSize: 14 },

  // Quick row
  quickRow: {
    position: "absolute",
    left: 0,
    right: 0,
    flexDirection: "row",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 12,
  },
  quickBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
    backgroundColor: "rgba(0,0,0,0.55)",
    borderWidth: 1,
    borderColor: "rgba(240,230,208,0.25)",
  },
  quickBtnText: { color: C.cream, fontSize: 13, fontWeight: "600" },

  // Controls
  controls: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 28,
    paddingTop: 14,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  captureBtn: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: C.cream,
    borderWidth: 4,
    borderColor: "rgba(255,255,255,0.35)",
    alignItems: "center",
    justifyContent: "center",
  },
  captureRing: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: C.cream,
  },
  sideBtn: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: "rgba(255,255,255,0.13)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.22)",
    alignItems: "center",
    justifyContent: "center",
  },
  sideBtnActive: {
    backgroundColor: "rgba(200,120,26,0.36)",
    borderColor: C.amber,
  },
  sideIcon: { color: C.cream, fontSize: 20, fontWeight: "600" },

  // Toast
  toast: {
    position: "absolute",
    alignSelf: "center",
    left: 40,
    right: 40,
    backgroundColor: C.amber,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 22,
    alignItems: "center",
  },
  toastText: { color: "#111", fontSize: 14, fontWeight: "600" },

  // Drawer
  drawer: { flex: 1, backgroundColor: C.bg },
  drawerHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 22,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  drawerTitle: { color: C.cream, fontSize: 17, fontWeight: "600" },
  drawerClose: { color: C.cream, fontSize: 30, lineHeight: 30 },
  pillsRow: { flexGrow: 0, paddingVertical: 12, paddingHorizontal: 22 },
  pill: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
    marginRight: 8,
  },
  pillActive: { backgroundColor: C.amber, borderColor: C.amber },
  pillText: { color: C.cream, fontSize: 13 },
  drawerBody: { flex: 1 },
  drawerDocType: {
    color: C.amber,
    fontSize: 11,
    letterSpacing: 1.2,
    marginBottom: 16,
    fontWeight: "700",
  },
  drawerText: {
    color: C.cream,
    fontSize: 19,
    lineHeight: 30,
    fontFamily: Platform.select({ ios: "Georgia", android: "serif" }),
  },

  // Help
  helpRoot: { flex: 1, backgroundColor: C.bg },
  helpHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 22,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  helpHeaderTitle: {
    color: C.cream,
    fontSize: 22,
    fontFamily: Platform.select({ ios: "Georgia", android: "serif" }),
  },
  helpClose: { color: C.cream, fontSize: 30, lineHeight: 30 },
  helpSection: {
    color: C.amber,
    fontSize: 11,
    letterSpacing: 1.4,
    fontWeight: "700",
    marginTop: 18,
    marginBottom: 8,
  },
  helpBody: { color: C.dim, fontSize: 15, lineHeight: 25 },
});
