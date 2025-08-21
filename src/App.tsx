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
  filePath: string; // native URI (for Filesystem)
  webPath: string; // for <audio src>
  createdAt: string; // ISO
  lat: number;
  lon: number;
  label?: string; // simple label (date/time or user-provided later)
  durationMs?: number;
  mimeType?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Local persistence helpers (Notes JSON index + audio files)
// ─────────────────────────────────────────────────────────────────────────────

const NOTES_INDEX = "notesIndex.json";

async function readNotes(): Promise<Note[]> {
  try {
    const res = await Filesystem.readFile({ path: NOTES_INDEX, directory: Directory.Data, encoding: Encoding.UTF8 });
    const raw = res.data as unknown; // string | Blob (web)
    const text = typeof raw === "string" ? raw : await (raw as Blob).text();
    return JSON.parse(text) as Note[];
  } catch (e) {
    // file not found yet
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

// ─────────────────────────────────────────────────────────────────────────────
// Minimalist UI Bits
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
// Record View
// ─────────────────────────────────────────────────────────────────────────────

type UIStatus = "IDLE" | "RECORDING" | "SAVED" | "FAILED_TO_RECORD";

const RecordView: React.FC<{ onSaved: (n: Note) => void }> = ({ onSaved }) => {
  const [isRecording, setIsRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [uiStatus, setUiStatus] = useState<UIStatus>("IDLE");
  const timerRef = useRef<number | null>(null);
  const positionRef = useRef<{ lat: number; lon: number } | null>(null);

  // Web fallback recorder
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaChunksRef = useRef<Blob[]>([]);

  // prefetch current location on mount (best effort)
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

      // location snapshot at start (best effort)
      try {
        const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true });
        positionRef.current = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      } catch {}

      if (IS_WEB) {
        // Web path: use MediaRecorder
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mr = new MediaRecorder(stream);
        mediaChunksRef.current = [];
        mr.ondataavailable = (e) => {
          if (e.data && e.data.size) mediaChunksRef.current.push(e.data);
        };
        mr.start();
        mediaRecorderRef.current = mr;
        mediaStreamRef.current = stream;
        setIsRecording(true);
        setUiStatus("RECORDING");
        setElapsed(0);
        startTimer();
        return;
      }

      // Native path: plugin
      await VoiceRecorder.requestAudioRecordingPermission();
      await VoiceRecorder.startRecording();
      setIsRecording(true);
      setUiStatus("RECORDING");
      setElapsed(0);
      startTimer();
    } catch (err) {
      setUiStatus("FAILED_TO_RECORD");
      setStatus("FAILED_TO_RECORD");
    }
  };

  const stop = async () => {
    try {
      stopTimer();

      if (IS_WEB) {
        const mr = mediaRecorderRef.current;
        if (!mr) throw new Error("No recorder");

        const finished = new Promise<Blob>((resolve) => {
          mr.onstop = () => resolve(new Blob(mediaChunksRef.current, { type: "audio/webm" }));
        });
        mr.stop();
        const blob = await finished;

        // Release tracks
        mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
        mediaRecorderRef.current = null;
        mediaStreamRef.current = null;

        // Persist audio
        const arrayBuffer = await blob.arrayBuffer();
        const base64 = arrayBufferToBase64(arrayBuffer);
        const id = uuidv4();
        const filename = `audio/${id}.webm`;
        await Filesystem.writeFile({ path: filename, directory: Directory.Data, data: base64, recursive: true });

        let webPath = "";
        try {
          const fileUri = await Filesystem.getUri({ path: filename, directory: Directory.Data });
          webPath = Capacitor.convertFileSrc(fileUri.uri);
        } catch {
          webPath = URL.createObjectURL(blob); // fallback for web play
        }

        const note: Note = {
          id,
          filePath: filename,
          webPath,
          createdAt: new Date().toISOString(),
          lat: positionRef.current?.lat ?? 0,
          lon: positionRef.current?.lon ?? 0,
          label: new Date().toLocaleString(),
          durationMs: elapsed,
          mimeType: "audio/webm",
        };

        const existing = await readNotes();
        await writeNotes([note, ...existing]);
        onSaved(note);
        setIsRecording(false);
        setUiStatus("SAVED");
        setStatus("Saved");
        setTimeout(() => setStatus(null), 1500);
        return;
      }

      // Native (plugin)
      const result = await VoiceRecorder.stopRecording();
      setIsRecording(false);

      const rawBase64 = result?.value?.recordDataBase64;
      const ms = result?.value?.msDuration as number | undefined;
      const mime = (result?.value?.mimeType as string | undefined) || "audio/m4a";
      if (!rawBase64) throw new Error("No audio data");

      const base64 = toBase64Standard(rawBase64);
      const id = uuidv4();
      const ext = mime.includes("mp3") ? "mp3" : mime.includes("wav") ? "wav" : "m4a";
      const filename = `audio/${id}.${ext}`;
      await Filesystem.writeFile({ path: filename, directory: Directory.Data, data: base64, recursive: true });
      const fileUri = await Filesystem.getUri({ path: filename, directory: Directory.Data });
      const webPath = Capacitor.convertFileSrc(fileUri.uri);

      if (!positionRef.current) {
        try {
          const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true });
          positionRef.current = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        } catch {}
      }

      const note: Note = {
        id,
        filePath: filename,
        webPath,
        createdAt: new Date().toISOString(),
        lat: positionRef.current?.lat ?? 0,
        lon: positionRef.current?.lon ?? 0,
        label: new Date().toLocaleString(),
        durationMs: ms ?? elapsed,
        mimeType: mime,
      };

      const existing = await readNotes();
      await writeNotes([note, ...existing]);
      onSaved(note);
      setUiStatus("SAVED");
      setStatus("Saved");
      setTimeout(() => setStatus(null), 1500);
    } catch (err) {
      setIsRecording(false);
      setUiStatus("FAILED_TO_RECORD");
      setStatus("FAILED_TO_RECORD");
      setTimeout(() => setStatus(null), 2000);
    }
  };

  return (
    <Screen title="New Voice Memo">
      <div className="text-xs text-neutral-400">
        {uiStatus === "RECORDING" ? "Recording…" : uiStatus === "FAILED_TO_RECORD" ? "FAILED_TO_RECORD" : status || ""}
      </div>
      <button
        onClick={isRecording ? stop : start}
        className={`w-40 h-40 rounded-full flex items-center justify-center shadow-xl transition active:scale-95 border ${
          isRecording ? "bg-red-600 border-red-500 text-white" : "bg-neutral-800 border-neutral-700 text-neutral-100"
        }`}
      >
        <div className="text-lg font-semibold">{isRecording ? "Stop" : "Record"}</div>
      </button>
      <div className="h-6 text-sm text-neutral-400">{isRecording ? msToClock(elapsed) : ""}</div>
      <p className="text-center text-xs text-neutral-500 px-6">Tip: we snapshot your location when you start/stop for better accuracy.</p>
    </Screen>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Map View
// ─────────────────────────────────────────────────────────────────────────────

const Recenter: React.FC<{ lat: number; lon: number }> = ({ lat, lon }) => {
  const map = useMap();
  useEffect(() => {
    map.setView([lat, lon]);
  }, [lat, lon]);
  return null;
};

const FitBounds: React.FC<{ points: [number, number][] }> = ({ points }) => {
  const map = useMap();
  useEffect(() => {
    if (points && points.length > 0) {
      const bounds = L.latLngBounds(points.map(([la, lo]) => L.latLng(la, lo)));
      map.fitBounds(bounds, { padding: [40, 40] });
    }
  }, [JSON.stringify(points)]);
  return null;
};

const MapView: React.FC<{ notes: Note[] }> = ({ notes }) => {
  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true });
        setCoords({ lat: pos.coords.latitude, lon: pos.coords.longitude });
      } catch {
        setCoords(null);
      }
    })();
  }, []);

  const located = useMemo(() => notes.filter(n => !(n.lat === 0 && n.lon === 0)), [notes]);
  const unlocated = useMemo(() => notes.filter(n => (n.lat === 0 && n.lon === 0)), [notes]);

  const center = useMemo<[number, number]>(() => {
    if (coords) return [coords.lat, coords.lon];
    if (located.length > 0) return [located[0].lat, located[0].lon];
    return [42.2808, -83.743]; // Ann Arbor default
  }, [coords, located]);

  const onPlay = (note: Note) => {
    if (!audioRef.current) return;
    audioRef.current.src = note.webPath;
    audioRef.current.play();
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-50 flex flex-col">
      <header className="p-4 text-center font-medium text-neutral-200 tracking-wide">Your Memos</header>
      <div className="flex-1 relative">
        <MapContainer center={[42.2808, -83.743]} zoom={13} style={{height:'70vh', width:'100%'}}>
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <Recenter lat={center[0]} lon={center[1]} />
          {located.length > 0 && (
            <FitBounds points={located.map(n => [n.lat, n.lon]) as [number, number][]} />
          )}

          {located.map((n) => (
            <Marker key={n.id} position={[n.lat, n.lon]}>
              <Popup>
                <div className="text-sm font-medium mb-1">{n.label || new Date(n.createdAt).toLocaleString()}</div>
                <div className="text-xs text-neutral-500 mb-2">
                  {n.mimeType?.replace("audio/", "").toUpperCase()} · {n.durationMs ? msToClock(n.durationMs) : ""}
                </div>
                <button
                  onClick={() => onPlay(n)}
                  className="px-3 py-1 rounded bg-neutral-900 border border-neutral-700 text-neutral-100 text-sm"
                >
                  Play
                </button>
              </Popup>
            </Marker>
          ))}
        </MapContainer>

        {unlocated.length > 0 && (
          <div className="absolute left-3 right-3 bottom-20 bg-neutral-900/90 border border-neutral-700 rounded-xl p-3 text-sm">
            <div className="mb-2">
              Saved {unlocated.length} memo{unlocated.length>1?'s':''} without location. They won't show on the map until location is allowed. You can still play them here:
            </div>
            <div className="flex gap-2 flex-wrap">
              {unlocated.slice(0, 5).map((n) => (
                <button key={n.id} onClick={() => onPlay(n)} className="px-3 py-1 rounded border border-neutral-700 hover:bg-neutral-800">
                  {n.label || new Date(n.createdAt).toLocaleString()}
                </button>
              ))}
            </div>
          </div>
        )}

        <audio ref={audioRef} preload="none" />
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// App Shell (two views)
// ─────────────────────────────────────────────────────────────────────────────

export default function App() {
  const [tab, setTab] = useState<"record" | "map">("record");
  const [notes, setNotes] = useState<Note[]>([]);

  useEffect(() => {
    (async () => {
      const n = await readNotes();
      setNotes(n);
    })();
  }, []);

  const handleSaved = async (note: Note) => {
    setNotes((p) => [note, ...p]);
  };

  return (
    <div className="relative min-h-screen bg-neutral-950">
      {tab === "record" ? <RecordView onSaved={handleSaved} /> : <MapView notes={notes} />}
      <TabBar tab={tab} onChange={setTab} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup Notes (README-style)
// ─────────────────────────────────────────────────────────────────────────────
// 1) Install deps:
//    npm i react react-dom uuid @capacitor/core @capacitor/geolocation @capacitor/filesystem capacitor-voice-recorder react-leaflet leaflet 
//    npm i -D @types/leaflet
//    npx cap add ios && npx cap add android
//
// 2) iOS Info.plist entries:
//    - NSMicrophoneUsageDescription ("This app records voice memos.")
//    - NSLocationWhenInUseUsageDescription ("Used to tag memos with your location.")
//
// 3) AndroidManifest.xml permissions:
//    - <uses-permission android:name="android.permission.RECORD_AUDIO" />
//    - <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
//    - <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
//
// 4) Web testing notes:
//    - Chrome recommended. Web uses MediaRecorder + WebM; Safari support varies.
//    - If playback fails, ensure you clicked Play (autoplay restrictions).
