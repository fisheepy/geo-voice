import React, { useEffect, useMemo, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { Geolocation } from "@capacitor/geolocation";
import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";
import { VoiceRecorder } from "capacitor-voice-recorder";
import { v4 as uuidv4 } from "uuid";

// Map (Leaflet) — tokenless OSM tiles
import "leaflet/dist/leaflet.css";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import * as L from "leaflet";
// @ts-ignore
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
// @ts-ignore
import markerIcon from "leaflet/dist/images/marker-icon.png";
// @ts-ignore
import markerShadow from "leaflet/dist/images/marker-shadow.png";

L.Icon.Default.mergeOptions({ iconRetinaUrl: markerIcon2x, iconUrl: markerIcon, shadowUrl: markerShadow });

// ─────────────────────────────────────────────────────────────────────────────
// Platform flags & debug
// ─────────────────────────────────────────────────────────────────────────────
const PLATFORM = Capacitor.getPlatform();
const IS_WEB = PLATFORM === "web";
const IS_IOS = PLATFORM === "ios";
const BUILD_SENTINEL = "GV_DEBUG_2025_08_24_C"; // bump to prove fresh build
const BUILD_TIME = new Date().toISOString();
const dbgIOS = (...a: any[]) => console.log("[DEBUG][iOS]", ...a);

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type Note = {
  id: string;
  filePath: string;
  webPath: string;
  createdAt: string;
  lat: number;
  lon: number;
  label?: string;
  durationMs?: number;
  mimeType?: string;
};

type UIStatus = "IDLE" | "RECORDING" | "SAVED" | "FAILED_TO_RECORD";

// ─────────────────────────────────────────────────────────────────────────────
// Local persistence
// ─────────────────────────────────────────────────────────────────────────────

const NOTES_INDEX = "notesIndex.json";

async function readNotes(): Promise<Note[]> {
  try {
    const res = await Filesystem.readFile({ path: NOTES_INDEX, directory: Directory.Data, encoding: Encoding.UTF8 });
    const raw = res.data as unknown; // string | Blob (web)
    const text = typeof raw === "string" ? raw : await (raw as Blob).text();
    return JSON.parse(text) as Note[];
  } catch {
    return [];
  }
}

async function writeNotes(notes: Note[]): Promise<void> {
  await Filesystem.writeFile({ path: NOTES_INDEX, data: JSON.stringify(notes), directory: Directory.Data, encoding: Encoding.UTF8, recursive: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// Utils
// ─────────────────────────────────────────────────────────────────────────────

function msToClock(ms: number) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const ss = (s % 60).toString().padStart(2, "0");
  return `${m}:${ss}`;
}

function toBase64Standard(input: string): string {
  let b64 = input.replace(/^data:.*;base64,/, "").trim();
  b64 = b64.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4;
  if (pad === 1) throw new Error("Invalid base64 length");
  if (pad > 0) b64 += "=".repeat(4 - pad);
  return b64;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function mimeToExt(m: string): string {
  if (!m) return "webm";
  if (m.includes("mp4")) return "m4a";
  if (m.includes("aac")) return "aac";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("wav")) return "wav";
  return "webm";
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimalist UI
// ─────────────────────────────────────────────────────────────────────────────

const Screen: React.FC<React.PropsWithChildren<{ title?: string; debugLine?: string }>> = ({ title, debugLine, children }) => (
  <div className="min-h-screen bg-neutral-950 text-neutral-50 flex flex-col">
    <header className="p-4 text-center font-medium text-neutral-200 tracking-wide">
      {title} <span className="text-xs text-neutral-500">({BUILD_SENTINEL} · {BUILD_TIME.slice(11,19)})</span>
      {debugLine ? (<div className="mt-2 text-xs text-neutral-500">{debugLine}</div>) : null}
    </header>
    <main className="flex-1 flex flex-col items-center justify-center gap-4 p-4">{children}</main>
  </div>
);

const TabBar: React.FC<{ tab: "record" | "map"; onChange: (t: "record" | "map") => void }> = ({ tab, onChange }) => (
  <nav className="fixed bottom-0 left-0 right-0 h-16 bg-neutral-900 border-t border-neutral-800 grid grid-cols-2">
    <button className={`text-sm ${tab === "record" ? "text-white" : "text-neutral-400"}`} onClick={() => onChange("record")}>Record</button>
    <button className={`text-sm ${tab === "map" ? "text-white" : "text-neutral-400"}`} onClick={() => onChange("map")}>Map</button>
  </nav>
);

// ─────────────────────────────────────────────────────────────────────────────
// Record View (iOS native + diagnostics)
// ─────────────────────────────────────────────────────────────────────────────

const RecordView: React.FC<{ onSaved: (n: Note) => void }> = ({ onSaved }) => {
  const [isRecording, setIsRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [uiStatus, setUiStatus] = useState<UIStatus>("IDLE");
  const [debugLine, setDebugLine] = useState("loading…");
  const [showDiag, setShowDiag] = useState(false);
  const timerRef = useRef<number | null>(null);
  const positionRef = useRef<{ lat: number; lon: number } | null>(null);

  // Web recorder
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaChunksRef = useRef<Blob[]>([]);
  const mimeTypeRef = useRef<string>("");

  // Prefetch location & capability debug
  useEffect(() => {
    (async () => {
      try { const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true }); positionRef.current = { lat: pos.coords.latitude, lon: pos.coords.longitude }; } catch {}
      const pluginAvailable = (Capacitor as any).isPluginAvailable?.("VoiceRecorder") ?? false;
      // @ts-ignore
      const hasMD = !!navigator.mediaDevices; // often false in WKWebView
      // @ts-ignore
      const hasGUM = !!navigator.mediaDevices?.getUserMedia;
      let inputs = 0; try { // @ts-ignore
        const devs = hasMD && navigator.mediaDevices.enumerateDevices ? await navigator.mediaDevices.enumerateDevices() : [];
        inputs = devs ? devs.filter((d: any) => d.kind === "audioinput").length : 0; } catch {}
      console.log("[DEBUG] sentinel:", BUILD_SENTINEL);
      console.log("[DEBUG] platform=", PLATFORM, "plugin=", pluginAvailable, "hasMD=", hasMD, "hasGUM=", hasGUM, "inputs=", inputs);
      setDebugLine(`platform=${PLATFORM} plugin=${pluginAvailable} hasMD=${hasMD} hasGUM=${hasGUM} inputs=${inputs}`);
    })();
  }, []);

  const startTimer = () => { const t0 = Date.now(); timerRef.current = window.setInterval(() => setElapsed(Date.now() - t0), 200) as unknown as number; };
  const stopTimer  = () => { if (timerRef.current) window.clearInterval(timerRef.current); timerRef.current = null; };

  const start = async () => {
    try {
      setStatus(null);
      try { const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true }); positionRef.current = { lat: pos.coords.latitude, lon: pos.coords.longitude }; } catch {}

      if (IS_IOS) {
        const available = (Capacitor as any).isPluginAvailable?.("VoiceRecorder") ?? false;
        dbgIOS("pluginAvailable?", available, "typeof startRecording:", typeof (VoiceRecorder as any)?.startRecording);
        if (!available || typeof (VoiceRecorder as any)?.startRecording !== "function") {
          setUiStatus("FAILED_TO_RECORD"); setStatus("IOS_PLUGIN_NOT_LINKED"); return;
        }
        try {
          const has = await VoiceRecorder.hasAudioRecordingPermission(); dbgIOS("hasMic?", has);
          if (!has.value) { const asked = await VoiceRecorder.requestAudioRecordingPermission(); dbgIOS("askedMic?", asked); if (!asked.value) { setUiStatus("FAILED_TO_RECORD"); setStatus("IOS_MIC_PERMISSION_DENIED"); return; } }
        } catch (permErr) { dbgIOS("permission error", permErr); }
        try {
          dbgIOS("calling startRecording →");
          await VoiceRecorder.startRecording();
          dbgIOS("← startRecording resolved");
          setIsRecording(true); setUiStatus("RECORDING"); setElapsed(0); startTimer();
          return;
        } catch (e: any) {
          dbgIOS("startRecording error", e); setUiStatus("FAILED_TO_RECORD"); setStatus(e?.message || "IOS_START_ERROR"); return;
        }
      }

      if (IS_WEB) {
        // Web path
        // @ts-ignore
        const hasMR = typeof window !== "undefined" && !!window.MediaRecorder;
        if (!hasMR) { setUiStatus("FAILED_TO_RECORD"); setStatus("WEB_NO_MEDIARECORDER"); return; }
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        const a = document.createElement("audio");
        const candidates = ["audio/mp4;codecs=mp4a.40.2","audio/webm;codecs=opus","audio/webm","audio/ogg;codecs=opus","audio/ogg"]; 
        const chosen = (() => { // pick a type we can also play
          // @ts-ignore
          const MR: any = window.MediaRecorder;
          for (const t of candidates) { try { if (MR.isTypeSupported?.(t) && !!a.canPlayType(t)) return t; } catch {} }
          return "";
        })();
        mimeTypeRef.current = chosen || "audio/webm";
        const mr = chosen ? new MediaRecorder(stream, { mimeType: chosen }) : new MediaRecorder(stream);
        mediaChunksRef.current = []; mr.ondataavailable = (e) => { if (e.data && e.data.size) mediaChunksRef.current.push(e.data); };
        mr.start(); mediaRecorderRef.current = mr; mediaStreamRef.current = stream;
        setIsRecording(true); setUiStatus("RECORDING"); setElapsed(0); startTimer(); return;
      }

      // Android native (similar to iOS plugin)
      const has = await VoiceRecorder.hasAudioRecordingPermission(); if (!has.value) { const asked = await VoiceRecorder.requestAudioRecordingPermission(); if (!asked.value) { setUiStatus("FAILED_TO_RECORD"); setStatus("MIC_PERMISSION_DENIED"); return; } }
      await VoiceRecorder.startRecording(); setIsRecording(true); setUiStatus("RECORDING"); setElapsed(0); startTimer();
    } catch (err: any) {
      setUiStatus("FAILED_TO_RECORD"); setStatus(err?.message || "FAILED_TO_RECORD");
    }
  };

  const stop = async () => {
    try {
      stopTimer();

      if (IS_IOS) {
        const available = (Capacitor as any).isPluginAvailable?.("VoiceRecorder") ?? false;
        dbgIOS("stop: pluginAvailable?", available);
        if (!available) { setUiStatus("FAILED_TO_RECORD"); setStatus("IOS_PLUGIN_NOT_LINKED"); return; }
        try {
          dbgIOS("calling stopRecording →");
          const result = await VoiceRecorder.stopRecording();
          dbgIOS("← stopRecording resolved", { hasData: !!result?.value?.recordDataBase64, ms: result?.value?.msDuration, mime: result?.value?.mimeType });
          setIsRecording(false);
          const rawBase64 = result?.value?.recordDataBase64; const ms = result?.value?.msDuration as number | undefined; const mime = (result?.value?.mimeType as string | undefined) || "audio/m4a";
          if (!rawBase64) throw new Error("No audio data");
          const base64 = toBase64Standard(rawBase64);
          const id = uuidv4(); const ext = mimeToExt(mime);
          const filename = `audio/${id}.${ext}`;
          await Filesystem.writeFile({ path: filename, directory: Directory.Data, data: base64, recursive: true });
          const fileUri = await Filesystem.getUri({ path: filename, directory: Directory.Data });
          const webPath = Capacitor.convertFileSrc(fileUri.uri);
          const note: Note = { id, filePath: filename, webPath, createdAt: new Date().toISOString(), lat: positionRef.current?.lat ?? 0, lon: positionRef.current?.lon ?? 0, label: new Date().toLocaleString(), durationMs: ms ?? elapsed, mimeType: mime };
          const existing = await readNotes(); await writeNotes([note, ...existing]); setUiStatus("SAVED"); setStatus("Saved"); onSaved(note); setTimeout(() => setStatus(null), 1200);
          return;
        } catch (e: any) {
          dbgIOS("stopRecording error", e); setIsRecording(false); setUiStatus("FAILED_TO_RECORD"); setStatus(e?.message || "IOS_STOP_ERROR"); return;
        }
      }

      if (IS_WEB) {
        const mr = mediaRecorderRef.current; if (!mr) throw new Error("No recorder");
        const finished = new Promise<Blob>((resolve) => { mr.onstop = () => resolve(new Blob(mediaChunksRef.current, { type: mimeTypeRef.current || "audio/webm" })); });
        mr.stop(); const blob = await finished; mediaStreamRef.current?.getTracks().forEach((t) => t.stop()); mediaRecorderRef.current = null; mediaStreamRef.current = null;
        await persistBlobAsNote(blob, elapsed, positionRef.current, onSaved); setIsRecording(false); setUiStatus("SAVED"); setStatus("Saved"); setTimeout(() => setStatus(null), 1200);
        return;
      }

      // Android native
      const result = await VoiceRecorder.stopRecording(); setIsRecording(false);
      const rawBase64 = result?.value?.recordDataBase64; const ms = result?.value?.msDuration as number | undefined; const mime = (result?.value?.mimeType as string | undefined) || "audio/m4a";
      if (!rawBase64) throw new Error("No audio data"); const base64 = toBase64Standard(rawBase64); const id = uuidv4(); const ext = mimeToExt(mime);
      const filename = `audio/${id}.${ext}`; await Filesystem.writeFile({ path: filename, directory: Directory.Data, data: base64, recursive: true }); const fileUri = await Filesystem.getUri({ path: filename, directory: Directory.Data }); const webPath = Capacitor.convertFileSrc(fileUri.uri);
      const note: Note = { id, filePath: filename, webPath, createdAt: new Date().toISOString(), lat: positionRef.current?.lat ?? 0, lon: positionRef.current?.lon ?? 0, label: new Date().toLocaleString(), durationMs: ms ?? elapsed, mimeType: mime }; const existing = await readNotes(); await writeNotes([note, ...existing]); onSaved(note); setUiStatus("SAVED"); setStatus("Saved"); setTimeout(() => setStatus(null), 1200);
    } catch (err: any) { setIsRecording(false); setUiStatus("FAILED_TO_RECORD"); setStatus(err?.message || "FAILED_TO_RECORD"); setTimeout(() => setStatus(null), 1800); }
  };

  async function persistBlobAsNote(blob: Blob, elapsedMs: number, pos: {lat:number;lon:number} | null, onSavedCb: (n: Note)=>void) {
    const arrayBuffer = await blob.arrayBuffer(); const base64 = arrayBufferToBase64(arrayBuffer); const id = uuidv4(); const ext = mimeToExt(blob.type);
    const filename = `audio/${id}.${ext}`; await Filesystem.writeFile({ path: filename, directory: Directory.Data, data: base64, recursive: true }); const webPath = `data:${blob.type};base64,${base64}`;
    const note: Note = { id, filePath: filename, webPath, createdAt: new Date().toISOString(), lat: pos?.lat ?? 0, lon: pos?.lon ?? 0, label: new Date().toLocaleString(), durationMs: elapsedMs, mimeType: blob.type };
    const existing = await readNotes(); await writeNotes([note, ...existing]); onSavedCb(note);
  }

  // Diagnostics panel
  const runNativeSmokeTest = async () => {
    try {
      const available = (Capacitor as any).isPluginAvailable?.("VoiceRecorder") ?? false;
      setStatus(`SMOKE: plugin=${available}`);
      if (!available) { setUiStatus("FAILED_TO_RECORD"); setStatus("SMOKE_FAIL: PLUGIN_NOT_LINKED"); return; }
      const has = await VoiceRecorder.hasAudioRecordingPermission(); if (!has.value) { const asked = await VoiceRecorder.requestAudioRecordingPermission(); if (!asked.value) { setStatus("SMOKE_FAIL: MIC_DENIED"); return; } }
      dbgIOS("SMOKE start →"); await VoiceRecorder.startRecording(); setStatus("SMOKE: recording 1s…"); await new Promise(r=>setTimeout(r, 1200));
      const res = await VoiceRecorder.stopRecording(); dbgIOS("SMOKE stop ←", res);
      const base = res?.value?.recordDataBase64; const ms = res?.value?.msDuration; const mime = res?.value?.mimeType; setStatus(`SMOKE_OK ms=${ms} mime=${mime} has=${!!base}`);
    } catch (e: any) {
      dbgIOS("SMOKE error", e); setStatus(`SMOKE_ERR: ${e?.message || e}`);
    }
  };

  const requestMic = async () => {
    try { const asked = await VoiceRecorder.requestAudioRecordingPermission(); setStatus(`PERM: asked=${asked.value}`); } catch (e: any) { setStatus(`PERM_ERR: ${e?.message || e}`); }
  };

  return (
    <Screen title="New Voice Memo" debugLine={debugLine}>
      <div className="text-xs text-neutral-400">{uiStatus === "RECORDING" ? "Recording…" : uiStatus === "FAILED_TO_RECORD" ? (status || "FAILED_TO_RECORD") : status || ""}</div>
      <button onClick={isRecording ? stop : start} className={`w-40 h-40 rounded-full flex items-center justify-center shadow-xl transition active:scale-95 border ${isRecording ? "bg-red-600 border-red-500 text-white" : "bg-neutral-800 border-neutral-700 text-neutral-100"}`}>
        <div className="text-lg font-semibold">{isRecording ? "Stop" : "Record"}</div>
      </button>
      <div className="h-6 text-sm text-neutral-400">{isRecording ? msToClock(elapsed) : ""}</div>

      {/* Diagnostics toggle */}
      <button onClick={() => setShowDiag(s => !s)} className="text-xs text-neutral-400 underline">{showDiag ? "Hide diagnostics" : "Show diagnostics"}</button>
      {showDiag && (
        <div className="w-full max-w-sm text-xs text-neutral-300 bg-neutral-900 border border-neutral-800 rounded-lg p-3 space-y-2">
          <div>Build: {BUILD_SENTINEL} · {BUILD_TIME}</div>
          <div>Platform: {PLATFORM}</div>
          <div className="flex gap-2">
            <button onClick={requestMic} className="px-2 py-1 rounded border border-neutral-700">Ask Mic</button>
            <button onClick={runNativeSmokeTest} className="px-2 py-1 rounded border border-neutral-700">Native 1s Smoke</button>
          </div>
          <div className="text-neutral-400">Watch Xcode for [DEBUG][iOS] logs.</div>
        </div>
      )}
    </Screen>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Map View (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

const Recenter: React.FC<{ lat: number; lon: number }> = ({ lat, lon }) => { const map = useMap(); useEffect(() => { map.setView([lat, lon]); }, [lat, lon]); return null; };
const FitBounds: React.FC<{ points: [number, number][] }> = ({ points }) => { const map = useMap(); useEffect(() => { if (points && points.length > 0) { const b = L.latLngBounds(points.map(([la, lo]) => L.latLng(la, lo))); map.fitBounds(b, { padding: [40, 40] }); } }, [JSON.stringify(points)]); return null; };

const MapView: React.FC<{ notes: Note[] }> = ({ notes }) => {
  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => { (async () => { try { const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true }); setCoords({ lat: pos.coords.latitude, lon: pos.coords.longitude }); } catch { setCoords(null); } })(); }, []);
  const located = useMemo(() => notes.filter(n => !(n.lat === 0 && n.lon === 0)), [notes]);
  const unlocated = useMemo(() => notes.filter(n => (n.lat === 0 && n.lon === 0)), [notes]);
  const center = useMemo<[number, number]>(() => { if (coords) return [coords.lat, coords.lon]; if (located.length > 0) return [located[0].lat, located[0].lon]; return [42.2808, -83.743]; }, [coords, located]);
  const onPlay = (note: Note) => { if (!audioRef.current) return; const a = audioRef.current; a.pause(); a.src = note.webPath; a.currentTime = 0; a.load(); a.play().catch(err => console.warn('play failed:', err)); };
  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-50 flex flex-col">
      <header className="p-4 text-center font-medium text-neutral-200 tracking-wide">Your Memos</header>
      <div className="flex-1 relative">
        <MapContainer center={[42.2808, -83.743]} zoom={13} style={{height:'70vh', width:'100%'}}>
          <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
          <Recenter lat={center[0]} lon={center[1]} />
          {located.length > 0 && (<FitBounds points={located.map(n => [n.lat, n.lon]) as [number, number][]} />)}
          {located.map((n) => (
            <Marker key={n.id} position={[n.lat, n.lon]}>
              <Popup>
                <div className="text-sm font-medium mb-1">{n.label || new Date(n.createdAt).toLocaleString()}</div>
                <div className="text-xs text-neutral-500 mb-2">{n.mimeType?.replace("audio/", "").toUpperCase()} · {n.durationMs ? msToClock(n.durationMs) : ""}</div>
                <button onClick={() => onPlay(n)} className="px-3 py-1 rounded bg-neutral-900 border border-neutral-700 text-neutral-100 text-sm">Play</button>
              </Popup>
            </Marker>
          ))}
        </MapContainer>
        {unlocated.length > 0 && (
          <div className="absolute left-3 right-3 bottom-20 bg-neutral-900/90 border border-neutral-700 rounded-xl p-3 text-sm">
            <div className="mb-2">Saved {unlocated.length} memo{unlocated.length>1?'s':''} without location. They won't show on the map until location is allowed. You can still play them here:</div>
            <div className="flex gap-2 flex-wrap">{unlocated.slice(0, 5).map((n) => (<button key={n.id} onClick={() => onPlay(n)} className="px-3 py-1 rounded border border-neutral-700 hover:bg-neutral-800">{n.label || new Date(n.createdAt).toLocaleString()}</button>))}</div>
          </div>
        )}
        <audio ref={audioRef} preload="none" />
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// App Shell
// ─────────────────────────────────────────────────────────────────────────────

export default function App() {
  const [tab, setTab] = useState<"record" | "map">("record");
  const [notes, setNotes] = useState<Note[]>([]);
  useEffect(() => { (async () => { const n = await readNotes(); setNotes(n); })(); }, []);
  const handleSaved = (note: Note) => setNotes((p) => [note, ...p]);
  return (
    <div className="relative min-h-screen bg-neutral-950">
      {tab === "record" ? <RecordView onSaved={handleSaved} /> : <MapView notes={notes} />}
      <TabBar tab={tab} onChange={setTab} />
    </div>
  );
}
