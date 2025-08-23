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
// Leaflet default marker asset fix for bundlers
// @ts-ignore
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
// @ts-ignore
import markerIcon from "leaflet/dist/images/marker-icon.png";
// @ts-ignore
import markerShadow from "leaflet/dist/images/marker-shadow.png";

L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

const IS_WEB = Capacitor.getPlatform() === "web";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type Note = {
  id: string;
  filePath: string; // native path (web: our virtual path)
  webPath: string;  // data: or blob: url for <audio>
  createdAt: string; // ISO
  lat: number;
  lon: number;
  label?: string;
  durationMs?: number;
  mimeType?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Local persistence (JSON index + audio files)
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
  await Filesystem.writeFile({
    path: NOTES_INDEX,
    data: JSON.stringify(notes),
    directory: Directory.Data,
    encoding: Encoding.UTF8,
    recursive: true,
  });
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

function canPlay(mime: string): boolean {
  const a = document.createElement("audio");
  // 'probably' or 'maybe' are both acceptable
  return !!(a && a.canPlayType && a.canPlayType(mime));
}

const CANDIDATE_TYPES = [
  // Prefer types most likely to be playable by the current browser
  "audio/mp4;codecs=mp4a.40.2", // Safari
  "audio/mp4",                   // Safari
  "audio/aac",                   // Safari
  "audio/webm;codecs=opus",      // Chrome
  "audio/webm",
  "audio/ogg;codecs=opus",       // Firefox
  "audio/ogg",
];

function pickSupportedType(): string {
  // Cross-check what MediaRecorder can emit AND <audio> can play
  // @ts-ignore
  const MR: typeof MediaRecorder | undefined = (typeof window !== "undefined" ? (window as any).MediaRecorder : undefined);
  if (!MR || typeof MR.isTypeSupported !== "function") return "";
  for (const t of CANDIDATE_TYPES) {
    try {
      if (MR.isTypeSupported(t) && canPlay(t)) return t;
    } catch {}
  }
  return ""; // no mutually-supported type → use WAV fallback
}

function mimeToExt(m: string): string {
  if (!m) return "webm";
  if (m.includes("mp4")) return "m4a"; // good generic ext for audio/mp4
  if (m.includes("aac")) return "aac";
  if (m.includes("ogg")) return "ogg";
  return "webm";
}

// WAV encoder (16-bit PCM, mono)
function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const numChannels = 1;
  const bytesPerSample = 2; // 16-bit
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  // fmt chunk
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true);  // audio format = PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  // data chunk
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  // PCM samples
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

function writeString(view: DataView, offset: number, s: string) {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimalist UI
// ─────────────────────────────────────────────────────────────────────────────

const Screen: React.FC<React.PropsWithChildren<{ title?: string }>> = ({ title, children }) => (
  <div className="min-h-screen bg-neutral-950 text-neutral-50 flex flex-col">
    <header className="p-4 text-center font-medium text-neutral-200 tracking-wide">{title}</header>
    <main className="flex-1 flex flex-col items-center justify-center gap-4 p-4">{children}</main>
  </div>
);

const TabBar: React.FC<{ tab: "record" | "map"; onChange: (t: "record" | "map") => void }> = ({ tab, onChange }) => (
  <nav className="fixed bottom-0 left-0 right-0 h-16 bg-neutral-900 border-t border-neutral-800 grid grid-cols-2">
    <button
      className={`text-sm ${tab === "record" ? "text-white" : "text-neutral-400"}`}
      onClick={() => onChange("record")}
    >
      Record
    </button>
    <button
      className={`text-sm ${tab === "map" ? "text-white" : "text-neutral-400"}`}
      onClick={() => onChange("map")}
    >
      Map
    </button>
  </nav>
);

// ─────────────────────────────────────────────────────────────────────────────
// Record View (type negotiation + WAV fallback)
// ─────────────────────────────────────────────────────────────────────────────

type UIStatus = "IDLE" | "RECORDING" | "SAVED" | "FAILED_TO_RECORD";

const RecordView: React.FC<{ onSaved: (n: Note) => void }> = ({ onSaved }) => {
  const [isRecording, setIsRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [uiStatus, setUiStatus] = useState<UIStatus>("IDLE");
  const timerRef = useRef<number | null>(null);
  const positionRef = useRef<{ lat: number; lon: number } | null>(null);

  // MediaRecorder path
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaChunksRef = useRef<Blob[]>([]);
  const mimeTypeRef = useRef<string>("");

  // WAV fallback path
  const wavUseFallbackRef = useRef(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const procNodeRef = useRef<ScriptProcessorNode | null>(null);
  const pcmBuffersRef = useRef<Float32Array[]>([]);
  const sampleRateRef = useRef<number>(44100);

  useEffect(() => {
    (async () => {
      try {
        const perm = await Geolocation.checkPermissions();
        if (perm.location !== "granted") {
          await Geolocation.requestPermissions();
        }
        const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true });
        positionRef.current = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      } catch {
        // ignore; user can still record without GNSS
      }
    })();
  }, []);

  const startTimer = () => {
    const start = Date.now();
    timerRef.current = window.setInterval(() => {
      setElapsed(Date.now() - start);
    }, 200) as unknown as number;
  };

  const stopTimer = () => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = null;
  };

  const start = async () => {
    try {
      setStatus(null);
      // snapshot location (best effort)
      try {
        const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true });
        positionRef.current = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      } catch {}

      if (IS_WEB) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        const chosen = pickSupportedType();
        if (chosen) {
          mimeTypeRef.current = chosen;
          const mr = new MediaRecorder(stream, { mimeType: chosen });
          mediaChunksRef.current = [];
          mr.ondataavailable = (e) => { if (e.data && e.data.size) mediaChunksRef.current.push(e.data); };
          mr.start();
          mediaRecorderRef.current = mr;
          mediaStreamRef.current = stream;
          wavUseFallbackRef.current = false;
        } else {
          // WAV fallback: collect PCM via Web Audio
          const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
          const source = ctx.createMediaStreamSource(stream);
          const proc = ctx.createScriptProcessor(4096, 1, 1);
          pcmBuffersRef.current = [];
          sampleRateRef.current = ctx.sampleRate;
          proc.onaudioprocess = (ev) => {
            const ch0 = ev.inputBuffer.getChannelData(0);
            pcmBuffersRef.current.push(new Float32Array(ch0)); // copy slice
          };
          source.connect(proc); proc.connect(ctx.destination);
          audioCtxRef.current = ctx; sourceNodeRef.current = source; procNodeRef.current = proc;
          mediaStreamRef.current = stream;
          wavUseFallbackRef.current = true;
          mimeTypeRef.current = "audio/wav";
        }
        setIsRecording(true); setUiStatus("RECORDING"); setElapsed(0); startTimer();
        return;
      }

      // Native path
      await VoiceRecorder.requestAudioRecordingPermission();
      await VoiceRecorder.startRecording();
      setIsRecording(true); setUiStatus("RECORDING"); setElapsed(0); startTimer();
    } catch (err) {
      setUiStatus("FAILED_TO_RECORD"); setStatus("FAILED_TO_RECORD");
    }
  };

  const stop = async () => {
    try {
      stopTimer();

      if (IS_WEB) {
        let blob: Blob;
        if (!wavUseFallbackRef.current) {
          // MediaRecorder stop → blob
          const mr = mediaRecorderRef.current; if (!mr) throw new Error("No recorder");
          const finished = new Promise<Blob>((resolve) => { mr.onstop = () => resolve(new Blob(mediaChunksRef.current, { type: mimeTypeRef.current || "audio/webm" })); });
          mr.stop();
          blob = await finished;
        } else {
          // WAV fallback stop → encode PCM
          procNodeRef.current?.disconnect(); sourceNodeRef.current?.disconnect();
          audioCtxRef.current && (await audioCtxRef.current.close());
          mediaStreamRef.current?.getTracks().forEach(t => t.stop());
          const totalLen = pcmBuffersRef.current.reduce((sum, b) => sum + b.length, 0);
          const merged = new Float32Array(totalLen);
          let offset = 0; for (const b of pcmBuffersRef.current) { merged.set(b, offset); offset += b.length; }
          const wavBuf = encodeWav(merged, sampleRateRef.current);
          blob = new Blob([wavBuf], { type: "audio/wav" });
        }

        // Persist + build data URL for playback
        const arrayBuffer = await blob.arrayBuffer();
        const base64 = arrayBufferToBase64(arrayBuffer);
        const id = uuidv4();
        const ext = !wavUseFallbackRef.current ? mimeToExt(blob.type) : "wav";
        const filename = `audio/${id}.${ext}`;
        await Filesystem.writeFile({ path: filename, directory: Directory.Data, data: base64, recursive: true });
        const webPath = `data:${blob.type};base64,${base64}`; // always playable in current browser

        const note: Note = {
          id,
          filePath: filename,
          webPath,
          createdAt: new Date().toISOString(),
          lat: positionRef.current?.lat ?? 0,
          lon: positionRef.current?.lon ?? 0,
          label: new Date().toLocaleString(),
          durationMs: elapsed,
          mimeType: blob.type,
        };
        const existing = await readNotes();
        await writeNotes([note, ...existing]);
        setIsRecording(false); setUiStatus("SAVED"); setStatus("Saved");
        onSaved(note);
        setTimeout(() => setStatus(null), 1200);
        return;
      }

      // Native (plugin)
      const result = await VoiceRecorder.stopRecording();
      setIsRecording(false);
      const rawBase64 = result?.value?.recordDataBase64; const ms = result?.value?.msDuration as number | undefined; const mime = (result?.value?.mimeType as string | undefined) || "audio/m4a"; if (!rawBase64) throw new Error("No audio data");
      const base64 = toBase64Standard(rawBase64);
      const id = uuidv4(); const ext = mime.includes("mp3") ? "mp3" : mime.includes("wav") ? "wav" : "m4a";
      const filename = `audio/${id}.${ext}`;
      await Filesystem.writeFile({ path: filename, directory: Directory.Data, data: base64, recursive: true });
      const fileUri = await Filesystem.getUri({ path: filename, directory: Directory.Data });
      const webPath = Capacitor.convertFileSrc(fileUri.uri);
      if (!positionRef.current) { try { const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true }); positionRef.current = { lat: pos.coords.latitude, lon: pos.coords.longitude }; } catch {} }
      const note: Note = { id, filePath: filename, webPath, createdAt: new Date().toISOString(), lat: positionRef.current?.lat ?? 0, lon: positionRef.current?.lon ?? 0, label: new Date().toLocaleString(), durationMs: ms ?? elapsed, mimeType: mime };
      const existing = await readNotes(); await writeNotes([note, ...existing]);
      setUiStatus("SAVED"); setStatus("Saved"); onSaved(note); setTimeout(() => setStatus(null), 1200);
    } catch (err) {
      setIsRecording(false); setUiStatus("FAILED_TO_RECORD"); setStatus("FAILED_TO_RECORD"); setTimeout(() => setStatus(null), 1800);
    }
  };

  return (
    <Screen title="New Voice Memo">
      <div className="text-xs text-neutral-400">{uiStatus === "RECORDING" ? "Recording…" : uiStatus === "FAILED_TO_RECORD" ? (status || "FAILED_TO_RECORD") : status || ""}</div>
      <button onClick={isRecording ? stop : start} className={`w-40 h-40 rounded-full flex items-center justify-center shadow-xl transition active:scale-95 border ${isRecording ? "bg-red-600 border-red-500 text-white" : "bg-neutral-800 border-neutral-700 text-neutral-100"}`}>
        <div className="text-lg font-semibold">{isRecording ? "Stop" : "Record"}</div>
      </button>
      <div className="h-6 text-sm text-neutral-400">{isRecording ? msToClock(elapsed) : ""}</div>
      <p className="text-center text-xs text-neutral-500 px-6">Tip: on Safari we auto-switch to WAV so playback always works.</p>
    </Screen>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Map View
// ─────────────────────────────────────────────────────────────────────────────

const Recenter: React.FC<{ lat: number; lon: number }> = ({ lat, lon }) => {
  const map = useMap();
  useEffect(() => { map.setView([lat, lon]); }, [lat, lon]);
  return null;
};

const FitBounds: React.FC<{ points: [number, number][] }> = ({ points }) => {
  const map = useMap();
  useEffect(() => { if (points && points.length > 0) { const bounds = L.latLngBounds(points.map(([la, lo]) => L.latLng(la, lo))); map.fitBounds(bounds, { padding: [40, 40] }); } }, [JSON.stringify(points)]);
  return null;
};

const MapView: React.FC<{ notes: Note[] }> = ({ notes }) => {
  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => { (async () => { try { const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true }); setCoords({ lat: pos.coords.latitude, lon: pos.coords.longitude }); } catch { setCoords(null); } })(); }, []);

  const located = useMemo(() => notes.filter(n => !(n.lat === 0 && n.lon === 0)), [notes]);
  const unlocated = useMemo(() => notes.filter(n => (n.lat === 0 && n.lon === 0)), [notes]);

  const center = useMemo<[number, number]>(() => { if (coords) return [coords.lat, coords.lon]; if (located.length > 0) return [located[0].lat, located[0].lon]; return [42.2808, -83.743]; }, [coords, located]);

  const onPlay = (note: Note) => {
    if (!audioRef.current) return;
    const a = audioRef.current;
    a.pause();
    a.src = note.webPath; // always data: on web; native path on device
    a.currentTime = 0;
    a.load();
    a.play().catch((err) => console.warn("play failed:", err));
  };

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
  const handleSaved = async (note: Note) => setNotes((p) => [note, ...p]);

  return (
    <div className="relative min-h-screen bg-neutral-950">
      {tab === "record" ? <RecordView onSaved={handleSaved} /> : <MapView notes={notes} />}
      <TabBar tab={tab} onChange={setTab} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Notes
// ─────────────────────────────────────────────────────────────────────────────
// • On the web, we now pick a recording type that the current browser can BOTH record and play.
// • If none fits (common on Safari), we fall back to WAV via Web Audio, which <audio> can always play.
// • We store a data: URL for playback on web so Vite/dev works without native file serving.
