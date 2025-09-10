import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Music Player — React + TypeScript (single-file)
 * - Dark UI, one-session playlist
 * - Progress with rose fill
 * - ID3 parsing: Title (TIT2), Artist (TPE1), Album (TALB), and cover art (APIC)
 * - Transport + per-row play/pause
 * - Volume
 * - Shuffle/Repeat beside transport (+ visible chips and badges)
 * - Global keys: Space, ←/→, +/−, S, R, N/P
 * - Robust playback: ref-mirrored state (no stale closures)
 * - UNIQUE FEATURE: WebAudio EQ (Bass/Mid/Treble + Master Gain) with rose-filled sliders
 * - Library panel widened + tooltips for truncated text
 */

type RepeatMode = "off" | "one" | "all";

interface TrackMeta {
  id: string;
  src: string;            // object URL
  title: string;
  artist?: string;
  album?: string;
  artworkUrl?: string;    // object URL for extracted MP3 artwork
}

// ===== Icons =====
const IconPlay   = (p: React.SVGProps<SVGSVGElement>) => <svg viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M8 5v14l11-7z"/></svg>;
const IconPause  = (p: React.SVGProps<SVGSVGElement>) => <svg viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>;
const IconPrev   = (p: React.SVGProps<SVGSVGElement>) => <svg viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M6 5h2v14H6zM20 6v12L9 12z"/></svg>;
const IconNext   = (p: React.SVGProps<SVGSVGElement>) => <svg viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M16 5h2v14h-2zM4 6v12l11-6z"/></svg>;
const IconNote   = (p: React.SVGProps<SVGSVGElement>) => <svg viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M12 3v10.55A4 4 0 1 1 10 19V7h10V3H12z"/></svg>;
const IconShuffle= (p: React.SVGProps<SVGSVGElement>) => <svg viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M17 3h4v4h-2V5h-2V3zM3 7h4l9 10h4v-2h-3.17L7 5H3v2zm0 10h4l3.5-3.89-1.5-1.67L6 15H3v2zm14-6h4v4h-2v-2h-2v-2z"/></svg>;
const IconRepeat = (p: React.SVGProps<SVGSVGElement>) => <svg viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M7 7h9V5H7a5 5 0 0 0 0 10h2v-2H7a3 3 0 0 1 0-6zm10 0h-2v2h2a3 3 0 0 1 0 6h-9v2h9a5 5 0 0 0 0-10zM8 5l3 3-3 3V5zm8 8 3 3-3 3v-6z"/></svg>;

// ===== Helpers =====
function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
function inferMetaFromFilename(name: string): { title: string; artist?: string } {
  const noExt = name.replace(/\.[^.]+$/, "");
  const parts = noExt.split(" - ");
  return parts.length >= 2 ? { title: parts.slice(1).join(" - "), artist: parts[0] } : { title: noExt };
}

// ---- ID3 parsing helpers ----
function decodeID3Text(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  const enc = bytes[0];
  const data = bytes.subarray(1);
  try {
    if (enc === 0) {
      return new TextDecoder("latin1").decode(data).replace(/\0+$/, "");
    } else if (enc === 1) {
      return new TextDecoder("utf-16").decode(data).replace(/\0+$/, "");
    } else if (enc === 2) {
      const withBOM = new Uint8Array(data.length + 2);
      withBOM[0] = 0xFE; withBOM[1] = 0xFF; withBOM.set(data, 2);
      return new TextDecoder("utf-16").decode(withBOM).replace(/\0+$/, "");
    } else if (enc === 3) {
      return new TextDecoder("utf-8").decode(data).replace(/\0+$/, "");
    }
  } catch {}
  try { return new TextDecoder("utf-8").decode(data).replace(/\0+$/, ""); } catch { return ""; }
}

async function extractID3Metadata(file: File): Promise<{
  title?: string; artist?: string; album?: string; artworkUrl?: string;
}> {
  const slice = file.slice(0, Math.min(file.size, 1024 * 1024));
  const buf = new Uint8Array(await slice.arrayBuffer());
  if (buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return {};
  const ver = buf[3];
  const flags = buf[5];
  const tagSize = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
  let offset = 10;
  if (flags & 0x40) {
    const extSize = ver === 4
      ? ((buf[offset] & 0x7f) << 21) | ((buf[offset + 1] & 0x7f) << 14) | ((buf[offset + 2] & 0x7f) << 7) | (buf[offset + 3] & 0x7f)
      : (buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3];
    offset += 4 + extSize;
  }
  const end = Math.min(offset + tagSize, buf.length);

  let title: string | undefined;
  let artist: string | undefined;
  let album: string | undefined;
  let artworkUrl: string | undefined;

  while (offset + 10 <= end) {
    const id = String.fromCharCode(buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3]);
    let frameSize = 0;
    if (ver === 4) {
      frameSize = ((buf[offset + 4] & 0x7f) << 21) | ((buf[offset + 5] & 0x7f) << 14) | ((buf[offset + 6] & 0x7f) << 7) | (buf[offset + 7] & 0x7f);
    } else {
      frameSize = (buf[offset + 4] << 24) | (buf[offset + 5] << 16) | (buf[offset + 6] << 8) | buf[offset + 7];
    }
    const frameStart = offset + 10;
    const frameEnd = frameStart + frameSize;
    if (frameEnd > end) break;

    if (id === "APIC") {
      const view = buf.subarray(frameStart, frameEnd);
      const enc = view[0];
      let i = 1;
      while (i < view.length && view[i] !== 0x00) i++;
      const mime = new TextDecoder("ascii").decode(view.subarray(1, i)) || "image/jpeg";
      i++; // null
      i++; // picture type byte
      let dataStart = i;
      if (enc === 0 || enc === 3) {
        while (dataStart < view.length && view[dataStart] !== 0x00) dataStart++;
        dataStart++;
      } else {
        while (dataStart + 1 < view.length && (view[dataStart] !== 0x00 || view[dataStart + 1] !== 0x00)) dataStart++;
        dataStart += 2;
      }
      const imgBytes = view.subarray(dataStart);
      const blob = new Blob([imgBytes], { type: mime });
      artworkUrl = URL.createObjectURL(blob);
    } else if (id === "TIT2") {
      title = decodeID3Text(buf.subarray(frameStart, frameEnd)) || title;
    } else if (id === "TPE1") {
      artist = decodeID3Text(buf.subarray(frameStart, frameEnd)) || artist;
    } else if (id === "TALB") {
      album = decodeID3Text(buf.subarray(frameStart, frameEnd)) || album;
    } else if (id === "\u0000\u0000\u0000\u0000") {
      break;
    }

    offset = frameEnd;
  }

  return { title, artist, album, artworkUrl };
}

// >>>>>> NEW helper: builds the display line and tooltip with conditional labels
function buildMetaLine(t?: TrackMeta): { text: string; title: string } {
  if (!t) return { text: "", title: "" };

  const artistKnown = !!t.artist && t.artist.trim().toLowerCase() !== "unknown artist";
  const albumKnown  = !!t.album  && t.album!.trim().toLowerCase()  !== "unknown album";

  const artistText = artistKnown ? `Artist: ${t.artist}` : "Unknown Artist";
  const albumText  = albumKnown  ? `Album: ${t.album}`  : "Unknown Album";

  const title = `Artist: ${t.artist || "Unknown Artist"} • Album: ${t.album || "Unknown Album"}`;
  return { text: `${artistText} • ${albumText}`, title };
}
// <<<<<< END new helper

// Rose-filled slider
function FilledSlider({ value, min = 0, max = 100, onChange }:
  { value: number; min?: number; max?: number; onChange: (v: number) => void }) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="relative w-full h-2 bg-neutral-700 rounded-full overflow-hidden">
      <div className="absolute left-0 top-0 h-full bg-rose-500" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
      <input type="range" min={min} max={max} value={value}
             onChange={(e) => onChange(Number(e.target.value))}
             className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
    </div>
  );
}

export default function MusicPlayerApp() {
  useEffect(() => { document.documentElement.classList.add("dark"); }, []);

  const audioRef = useRef<HTMLAudioElement | null>(null);

  // ----- State
  const [playlist, setPlaylist] = useState<TrackMeta[]>([]);
  const [currentIndex, _setCurrentIndex] = useState<number | null>(null);
  const [isPlaying, _setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(80);

  const [shuffle, _setShuffle] = useState(false);
  const [repeat, _setRepeat] = useState<RepeatMode>("off");
  const [_shuffledOrder, _setShuffledOrder] = useState<number[]>([]);
  const [_shuffledPos, _setShuffledPos] = useState(0);

  // EQ UI values
  const [showEQ, setShowEQ] = useState(false);
  const [gain, setGain] = useState(100); 
  const [bass, setBass] = useState(0);   
  const [midG, setMidG] = useState(0);   
  const [treble, setTreble] = useState(0);

  const currentTrack = useMemo(
    () => (currentIndex == null ? undefined : playlist[currentIndex]),
    [playlist, currentIndex]
  );


  const playlistRef = useRef<TrackMeta[]>([]);
  const indexRef    = useRef<number | null>(null);
  const playingRef  = useRef(false);
  const shuffleRef  = useRef(false);
  const repeatRef   = useRef<RepeatMode>("off");
  const orderRef    = useRef<number[]>([]);
  const posRef      = useRef(0);

  const setCurrentIndex = (v: number | null) => { indexRef.current = v; _setCurrentIndex(v); };
  const setIsPlaying    = (v: boolean)        => { playingRef.current = v; _setIsPlaying(v); };
  const setShuffle      = (v: boolean | ((s:boolean)=>boolean)) => {
    const next = typeof v === "function" ? v(shuffleRef.current) : v;
    shuffleRef.current = next; _setShuffle(next);
  };
  const setRepeat       = (v: RepeatMode | ((m:RepeatMode)=>RepeatMode)) => {
    const next = typeof v === "function" ? v(repeatRef.current) : v;
    repeatRef.current = next; _setRepeat(next);
  };
  const setShuffledOrder = (v: number[] | ((o:number[])=>number[])) => {
    const next = typeof v === "function" ? v(orderRef.current) : v;
    orderRef.current = next; _setShuffledOrder(next);
  };
  const setShuffledPos = (v: number | ((p:number)=>number)) => {
    const next = typeof v === "function" ? v(posRef.current) : v;
    posRef.current = next; _setShuffledPos(next);
  };

  useEffect(() => { playlistRef.current = playlist; }, [playlist]);

  // ----- Audio element events
  useEffect(() => {
    const a = audioRef.current; if (!a) return;
    const onTime = () => setCurrentTime(a.currentTime || 0);
    const onLoaded = () => setDuration(a.duration || 0);
    const onEnded  = () => handleEnded(); // reads refs
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("loadedmetadata", onLoaded);
    a.addEventListener("ended", onEnded);
    return () => { a.removeEventListener("timeupdate", onTime); a.removeEventListener("loadedmetadata", onLoaded); a.removeEventListener("ended", onEnded); };
  }, []);

  // Volume to element
  useEffect(() => { const a = audioRef.current; if (a) a.volume = volume / 100; }, [volume]);

  // ------- WebAudio EQ graph -------
  const ctxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const lowRef = useRef<BiquadFilterNode | null>(null);
  const midRef = useRef<BiquadFilterNode | null>(null);
  const highRef = useRef<BiquadFilterNode | null>(null);
  const masterRef = useRef<GainNode | null>(null);

  function ensureEQGraph() {
    const a = audioRef.current; if (!a) return;
    if (!ctxRef.current) {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      ctxRef.current = ctx;
      const src = ctx.createMediaElementSource(a);
      const low = ctx.createBiquadFilter(); low.type = "lowshelf";  low.frequency.value = 200;
      const mid = ctx.createBiquadFilter(); mid.type = "peaking";   mid.frequency.value = 1000; mid.Q.value = 1;
      const high= ctx.createBiquadFilter(); high.type= "highshelf"; high.frequency.value = 4000;
      const master = ctx.createGain();

      src.connect(low); low.connect(mid); mid.connect(high); high.connect(master); master.connect(ctx.destination);

      sourceRef.current = src;
      lowRef.current = low; midRef.current = mid; highRef.current = high; masterRef.current = master;

      master.gain.value = gain / 100;
      low.gain.value = bass;
      mid.gain.value = midG;
      high.gain.value = treble;
    }
  }

  useEffect(() => { if (masterRef.current) masterRef.current.gain.value = gain / 100; }, [gain]);
  useEffect(() => { if (lowRef.current) lowRef.current.gain.value = bass; }, [bass]);
  useEffect(() => { if (midRef.current) midRef.current.gain.value = midG; }, [midG]);
  useEffect(() => { if (highRef.current) highRef.current.gain.value = treble; }, [treble]);

  // Keep shuffle pointer synced when user picks a track manually
  useEffect(() => {
    if (!shuffleRef.current || indexRef.current == null) return;
    const pos = orderRef.current.indexOf(indexRef.current);
    if (pos >= 0) setShuffledPos(pos);
  }, [currentIndex]);

  // ===== Playback core =====
  function playIndex(i: number) {
    const a = audioRef.current; if (!a) return;
    const pl = playlistRef.current;
    if (i < 0 || i >= pl.length) return;
    setCurrentIndex(i);
    a.src = pl[i].src;
    a.load();
    void a.play();
    setIsPlaying(true);
  }

  function togglePlay() {
    const a = audioRef.current; if (!a) return;
    const pl = playlistRef.current;
    if (!pl.length) return;
    if (indexRef.current == null) { playIndex(0); return; }
    if (playingRef.current) { a.pause(); setIsPlaying(false); }
    else { void a.play(); setIsPlaying(true); }
  }

  function seekBy(delta: number) {
    const a = audioRef.current; if (!a) return;
    const d = duration || 0;
    a.currentTime = Math.max(0, Math.min(d, a.currentTime + delta));
    setCurrentTime(a.currentTime);
  }

  function buildShuffleOrder(anchor: number) {
    const pl = playlistRef.current;
    const order = [...Array(pl.length).keys()].filter(i => i !== anchor);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const full = [anchor, ...order];
    setShuffledOrder(full);
    setShuffledPos(0);
  }

  function toggleShuffleUI() {
    setShuffle((s) => {
      const next = !s;
      if (next) buildShuffleOrder(indexRef.current ?? 0);
      return next;
    });
  }
  function cycleRepeat() {
    setRepeat((m) => (m === "off" ? "one" : m === "one" ? "all" : "off"));
  }

  function getNextIndex(): number | null {
    const pl = playlistRef.current;
    const idx = indexRef.current;
    const rep = repeatRef.current;
    const shf = shuffleRef.current;
    const order = orderRef.current;
    const pos = posRef.current;

    if (!pl.length) return null;
    if (rep === "one" && idx != null) return idx;

    if (shf) {
      if (idx == null) return 0;
      if (order.length === 0 || order.indexOf(idx) === -1) {
        buildShuffleOrder(idx);
        return idx;
      }
      const nextPos = pos + 1;
      if (nextPos < order.length) { setShuffledPos(nextPos); return order[nextPos]; }
      if (rep === "all") { setShuffledPos(0); return order[0]; }
      return null;
    } else {
      if (idx == null) return 0;
      if (idx < pl.length - 1) return idx + 1;
      if (rep === "all") return 0;
      return null;
    }
  }

  function getPrevIndex(): number | null {
    const pl = playlistRef.current;
    const idx = indexRef.current;
    const rep = repeatRef.current;
    const shf = shuffleRef.current;
    const order = orderRef.current;
    const pos = posRef.current;

    if (!pl.length) return null;

    if (shf) {
      if (idx == null) return 0;
      if (order.length === 0 || order.indexOf(idx) === -1) {
        buildShuffleOrder(idx);
        return idx;
      }
      const prevPos = pos - 1;
      if (prevPos >= 0) { setShuffledPos(prevPos); return order[prevPos]; }
      if (rep === "all") { const last = order.length - 1; setShuffledPos(last); return order[last]; }
      return null;
    } else {
      if (idx == null) return 0;
      if (idx > 0) return idx - 1;
      if (rep === "all") return pl.length - 1;
      return null;
    }
  }

  function handleNext() {
    const ni = getNextIndex();
    const a = audioRef.current;
    if (ni == null) { a?.pause(); setIsPlaying(false); return; }
    playIndex(ni);
  }
  function handlePrev() {
    const pi = getPrevIndex();
    if (pi == null) return;
    playIndex(pi);
  }
  function handleEnded() {
    const a = audioRef.current; if (!a) return;
    const rep = repeatRef.current;
    if (rep === "one") {
      a.currentTime = 0;
      void a.play();
      setIsPlaying(true);
      return;
    }
    const ni = getNextIndex();
    if (ni == null) { a.pause(); setIsPlaying(false); return; }
    playIndex(ni);
  }

  function removeTrack(idx: number) {
    const pl = [...playlistRef.current];
    if (idx < 0 || idx >= pl.length) return;
    pl.splice(idx, 1);

    const newOrder = orderRef.current.filter(i => i !== idx).map(i => (i > idx ? i - 1 : i));

    if (pl.length === 0) {
      const a = audioRef.current; if (a) { a.pause(); a.src = ""; }
      setPlaylist(pl);
      setCurrentIndex(null);
      setIsPlaying(false);
      setShuffledOrder([]);
      setShuffledPos(0);
      return;
    }

    if (indexRef.current === idx) {
      const ni = Math.min(idx, pl.length - 1);
      setPlaylist(pl);
      setShuffledOrder(newOrder);
      setShuffledPos(Math.max(0, newOrder.indexOf(ni)));
      playIndex(ni);
      return;
    }

    const adjustedCurrent =
      indexRef.current != null && idx < indexRef.current ? (indexRef.current - 1) : indexRef.current;

    setPlaylist(pl);
    setCurrentIndex(adjustedCurrent ?? null);
    setShuffledOrder(newOrder);
    if (adjustedCurrent != null) {
      const pos = newOrder.indexOf(adjustedCurrent);
      if (pos >= 0) setShuffledPos(pos);
    }
  }

  async function addSongs(files: FileList | null) {
    if (!files) return;
    const arr = Array.from(files);
    const tracks: TrackMeta[] = [];
    for (const f of arr) {
      const { title: tagTitle, artist: tagArtist, album: tagAlbum, artworkUrl } = await extractID3Metadata(f);
      const nameFallback = inferMetaFromFilename(f.name);
      const title = tagTitle?.trim() || nameFallback.title;
      const artist = (tagArtist && tagArtist.trim()) || nameFallback.artist || "Unknown Artist";
      const album = (tagAlbum && tagAlbum.trim()) || "Unknown Album";
      tracks.push({
        id: `${f.name}-${Math.random().toString(36).slice(2,8)}`,
        src: URL.createObjectURL(f),
        title,
        artist,
        album,
        artworkUrl
      });
    }
    const newPl = [...playlistRef.current, ...tracks];
    setPlaylist(newPl);
    if (shuffleRef.current && indexRef.current != null) {
      const anchor = indexRef.current;
      const order = [...Array(newPl.length).keys()].filter(i => i !== anchor);
      for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random()*(i+1)); [order[i], order[j]] = [order[j], order[i]]; }
      setShuffledOrder([anchor, ...order]);
      setShuffledPos(0);
    }
  }

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName?.toLowerCase();
      const isInput = tag === 'input' || tag === 'textarea' || (el as any)?.isContentEditable;
      if (isInput) return;
      if (e.code === 'Space' || e.key === ' ') { e.preventDefault(); togglePlay(); return; }
      switch (e.key) {
        case 'ArrowRight': e.preventDefault(); seekBy(5); break;
        case 'ArrowLeft': e.preventDefault(); seekBy(-5); break;
        case 'n': case 'N': handleNext(); break;
        case 'p': case 'P': handlePrev(); break;
        case '+': case '=': setVolume(v => Math.min(100, v + 5)); break;
        case '-': case '_': setVolume(v => Math.max(0, v - 5)); break;
        case 's': case 'S': toggleShuffleUI(); break;
        case 'r': case 'R': cycleRepeat(); break;
      }
    };
    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler as any, { capture: true } as any);
  }, []);

  const progress = duration ? (currentTime / duration) * 100 : 0;

  return (
    <div className="min-h-screen flex flex-col bg-neutral-950 text-neutral-100">
      <header className="flex items-center justify-between px-6 py-4 border-b border-white/10">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-xl bg-gradient-to-br from-rose-500 to-pink-500" />
          <h1 className="text-lg font-semibold">Music Player</h1>
        </div>
      </header>

      {/* Wider right column on large screens */}
      <main className="flex-1 grid grid-cols-1 lg:[grid-template-columns:1.4fr_1fr] gap-8 p-6 max-w-7xl mx-auto w-full">
        {/* Player */}
        <section>
          <div className="rounded-3xl border border-white/10 bg-neutral-900/70 shadow-xl p-8">
            <div className="flex items-center gap-5">
              <div className="h-28 w-28 rounded-2xl overflow-hidden bg-neutral-800 grid place-items-center">
                {currentTrack?.artworkUrl ? (
                  <img src={currentTrack.artworkUrl} alt="Album art" className="h-full w-full object-cover"/>
                ) : (
                  <IconNote className="h-8 w-8 text-neutral-500" />
                )}
              </div>
              <div className="min-w-0">
                <h2
                  className="text-3xl font-bold truncate"
                  title={currentTrack?.title || "Add songs to begin"}
                >
                  {currentTrack?.title || "Add songs to begin"}
                </h2>

                {/* >>> labeled only when known; tooltip always labeled */}
                {(() => {
                  const meta = buildMetaLine(currentTrack);
                  return (
                    <p className="text-sm text-neutral-400 truncate" title={meta.title}>
                      {meta.text}
                    </p>
                  );
                })()}
                {/* <<< End */}
              </div>
            </div>

            {/* Progress */}
            <div className="mt-6">
              <div className="flex items-center gap-3 text-xs mb-2">
                <span className="tabular-nums w-10 text-left">{formatTime(currentTime)}</span>
                <FilledSlider value={Math.round(progress)} onChange={(v) => {
                  const a = audioRef.current; if (!a || !duration) return;
                  a.currentTime = (v/100)*duration; setCurrentTime(a.currentTime);
                }} />
                <span className="tabular-nums w-10 text-right">{formatTime(duration)}</span>
              </div>
            </div>

            {/* Transport + Shuffle/Repeat */}
            <div className="mt-6 flex flex-wrap items-center justify-center gap-4">
              <button onClick={handlePrev} disabled={!playlist.length} className="relative h-11 w-11 rounded-full bg-neutral-800 grid place-items-center disabled:opacity-50" aria-label="Previous">
                <IconPrev className="h-5 w-5" />
              </button>

              <button
                onClick={() => (indexRef.current == null ? playIndex(0) : togglePlay())}
                disabled={!playlist.length}
                className="relative h-16 w-16 rounded-full bg-rose-500 text-white grid place-items-center shadow disabled:opacity-50"
                aria-label={isPlaying ? "Pause" : "Play"}>
                {isPlaying ? <IconPause className="h-7 w-7" /> : <IconPlay className="h-7 w-7" />}
              </button>

              <button onClick={handleNext} disabled={!playlist.length} className="relative h-11 w-11 rounded-full bg-neutral-800 grid place-items-center disabled:opacity-50" aria-label="Next">
                <IconNext className="h-5 w-5" />
              </button>

              <button
                onClick={toggleShuffleUI}
                className={`relative h-11 px-4 rounded-full border border-white/10 ${shuffle ? 'bg-rose-500 text-white' : 'bg-neutral-900'}`}
                title={shuffle ? "Shuffle: On (S)" : "Shuffle: Off (S)"}>
                <IconShuffle className="h-5 w-5"/>
              </button>

              <button
                onClick={cycleRepeat}
                className={`relative h-11 px-4 rounded-full border border-white/10 ${repeat !== 'off' ? 'bg-rose-500 text-white' : 'bg-neutral-900'}`}
                title={repeat === 'off' ? 'Repeat: Off (R)' : repeat === 'one' ? 'Repeat: One (R)' : 'Repeat: All (R)'}>
                <IconRepeat className="h-5 w-5"/>
                {repeat === "one" && (
                  <span className="absolute -right-1 -top-1 text-[10px] leading-none px-1.5 py-[2px] rounded-full bg-white text-rose-600 font-bold shadow">
                    1
                  </span>
                )}
                {repeat === "all" && (
                  <span className="absolute -right-1 -top-1 text-[10px] leading-none px-1.5 py-[2px] rounded-full bg-white text-rose-600 font-bold shadow">
                    ALL
                  </span>
                )}
              </button>
            </div>

            {/* Mode chips */}
            <div className="mt-3 flex items-center justify-center gap-2 text-[11px]">
              {shuffle && (
                <span className="px-2 py-1 rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/40">
                  Shuffle On
                </span>
              )}
              {repeat === "one" && (
                <span className="px-2 py-1 rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/40">
                  Repeat One
                </span>
              )}
              {repeat === "all" && (
                <span className="px-2 py-1 rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/40">
                  Repeat All
                </span>
              )}
            </div>

            {/* Volume */}
            <div className="mt-6">
              <div className="flex items-center gap-3">
                <span className="text-xs w-14 text-neutral-400">Volume</span>
                <div className="flex-1">
                  <FilledSlider value={volume} onChange={setVolume} />
                </div>
                <span className="text-xs w-10 text-right tabular-nums">{Math.round(volume)}%</span>
              </div>
            </div>

            {/* Sound Controls (EQ) */}
            <div className="mt-8">
              <button
                onClick={() => { if (!showEQ) ensureEQGraph(); setShowEQ(s => !s); }}
                className="px-4 py-2 rounded-full bg-neutral-800 border border-white/10 hover:bg-neutral-700 transition">
                {showEQ ? "Hide sound controls" : "Sound controls"}
              </button>
              {showEQ && (
                <div className="mt-4 grid grid-cols-1 sm:grid-cols-4 gap-4">
                  <div>
                    <div className="text-xs mb-1">Gain</div>
                    <FilledSlider value={gain} min={0} max={200} onChange={(v) => { if (!ctxRef.current) ensureEQGraph(); setGain(v); }} />
                  </div>
                  <div>
                    <div className="text-xs mb-1">Bass</div>
                    <FilledSlider value={bass + 15} min={0} max={30} onChange={(v) => { if (!ctxRef.current) ensureEQGraph(); setBass(v - 15); }} />
                  </div>
                  <div>
                    <div className="text-xs mb-1">Mid</div>
                    <FilledSlider value={midG + 15} min={0} max={30} onChange={(v) => { if (!ctxRef.current) ensureEQGraph(); setMidG(v - 15); }} />
                  </div>
                  <div>
                    <div className="text-xs mb-1">Treble</div>
                    <FilledSlider value={treble + 15} min={0} max={30} onChange={(v) => { if (!ctxRef.current) ensureEQGraph(); setTreble(v - 15); }} />
                  </div>
                </div>
              )}
            </div>

            <audio ref={audioRef} preload="metadata" />

            {/* Add songs*/}
            <div className="mt-8">
              <label className="cursor-pointer inline-flex items-center gap-2 px-5 py-2 rounded-full bg-neutral-800 border border-white/10 hover:bg-neutral-700 transition">
                <input type="file" accept="audio/*" multiple className="hidden"
                       onChange={(e) => addSongs(e.target.files)} />
                <span className="text-sm">Add songs</span>
              </label>
            </div>
          </div>
        </section>

        {/* Library */}
        <aside>
          <div className="rounded-3xl border border-white/10 bg-neutral-900/70 shadow-xl p-6">
            <h3 className="text-sm font-semibold mb-3">Library</h3>
            {playlist.length === 0 ? (
              <p className="text-sm text-neutral-400">No songs added.</p>
            ) : (
              <ul className="space-y-2">
                {playlist.map((t, idx) => {
                  const isCurrent = idx === currentIndex;
                  return (
                    <li key={t.id}
                        className={`flex items-center gap-3 px-3 py-2 rounded-xl border border-white/10 ${isCurrent ? "bg-rose-500/10" : ""}`}>
                      <button
                        onClick={() => {
                          if (isCurrent) togglePlay();
                          else {
                            playIndex(idx);
                            if (shuffleRef.current) {
                              if (orderRef.current.length === 0 || orderRef.current.indexOf(idx) === -1) {
                                buildShuffleOrder(idx);
                              } else {
                                setShuffledPos(orderRef.current.indexOf(idx));
                              }
                            }
                          }
                        }}
                        className={`h-8 w-8 rounded-full grid place-items-center ${isCurrent ? "bg-rose-500 text-white" : "bg-neutral-800"}`}
                        aria-label="Play/Pause">
                        {isCurrent && isPlaying ? <IconPause className="h-4 w-4" /> : <IconPlay className="h-4 w-4" />}
                      </button>

                      <div className="h-10 w-10 rounded-lg overflow-hidden bg-neutral-800 grid place-items-center">
                        {t.artworkUrl ? <img src={t.artworkUrl} alt="Art" className="h-full w-full object-cover"/> : <IconNote className="h-4 w-4 text-neutral-500"/>}
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate" title={t.title}>
                          {t.title}
                        </div>

                        {/* >>>  labeled only when known; tooltip always labeled */}
                        {(() => {
                          const meta = buildMetaLine(t);
                          return (
                            <div className="text-xs text-neutral-400 truncate" title={meta.title}>
                              {meta.text}
                            </div>
                          );
                        })()}
                        {/* <<< End  */}
                      </div>

                      <button onClick={() => removeTrack(idx)} className="shrink-0 h-8 w-8 rounded-full bg-neutral-800 grid place-items-center" aria-label="Remove">🗑️</button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </aside>
      </main>
    </div>
  );
}
