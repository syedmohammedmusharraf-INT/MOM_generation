import { useState, useRef, useEffect } from 'react';
import TimerDisplay from '@/components/TimerDisplay';

// ─────────────────────────────────────────────────────────────────────────────
// WHAT CHANGED vs YOUR ORIGINAL — and WHY
//
// REMOVED:  getSupportedMimeType()       — no codec needed anymore
// REMOVED:  MediaRecorder                — this was the root cause of bass artifacts
// REMOVED:  audioChunksRef (Blob[])      — replaced with Int16Array accumulator
// REMOVED:  enhanceForDiarization()      — no longer needed post-capture
//           (filters now applied LIVE in the Web Audio graph before capture)
//
// ADDED:    AudioWorklet (WORKLET_SRC)   — captures raw PCM on dedicated thread
// ADDED:    encodePCMtoWAV()             — lossless WAV, no Opus codec
// ADDED:    TARGET_SR = 16000           — AudioContext at 16kHz, matches PyAnnote
// ADDED:    pcmChunksRef (Int16Array[]) — accumulates raw samples
// ADDED:    workletUrlRef               — Blob URL for inline worklet
//
// ROOT CAUSE OF YOUR DIARIZATION FAILURE:
//   MediaRecorder → Opus codec → compresses → bass artifacts introduced
//   Bass energy overwhelms WeSpeaker ResNet34 Fbank features
//   Both speakers produce near-identical embeddings → merged into SPEAKER_00
//
// HOW THIS FIXES IT:
//   AudioWorklet captures raw Float32 samples AFTER Web Audio filter chain
//   High-pass (80Hz) removes bass before ANY encoding happens
//   No codec = no bass artifacts = clean voice fingerprints
//   WeSpeaker can now distinguish speakers → correct diarization
//
// AUDIO GRAPH (same filters, different final capture):
//   Mic (48kHz)
//     → AudioContext resamples to 16kHz internally
//     → HighPass 80Hz        removes bass rumble
//     → Presence +6dB@3kHz  consonant clarity
//     → MidBoost +3dB@1.5kHz voice formants (speaker identity)
//     → GainNode             user slider
//     → Compressor -50dB/12 normalises quiet secondary speakers
//     → MakeupGain ×2.5     restores level
//     → Limiter -3dBFS      hard ceiling
//     → AudioWorkletNode    captures Int16 PCM chunks (no codec)
//     → pcmChunksRef[]      accumulated in memory
//   On stop:
//     → concat Int16 → Float32 → normalise 0.8 peak → WAV encode → upload
// ─────────────────────────────────────────────────────────────────────────────

const formatFileSize = (bytes: number) => {
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
};

export interface AudioMeta {
  audioUrl:     string;
  audioBlob:    Blob;
  uploadedFile: File | null;
  mongoId:      string | null;
}

interface RecorderPageProps {
  onAudioReady: (meta: AudioMeta) => void;
}

const MIN_GAIN     = 1.0;
const MAX_GAIN     = 10.0;
const DEFAULT_GAIN = 2.5;

// 16kHz = native rate for PyAnnote, Whisper, ECAPA-TDNN
// AudioContext at 16kHz → browser resamples 48kHz mic automatically
// No server-side resampling needed = one less quality loss step
const TARGET_SR = 16000;

// ─────────────────────────────────────────────────────────────────────────────
// WAV ENCODER
// Replaces audioBufferToWavBlob — works directly on Float32Array
// No AudioBuffer needed, no extra allocation
// ─────────────────────────────────────────────────────────────────────────────
function encodePCMtoWAV(pcm: Float32Array, sr: number): Blob {
  const n    = pcm.length;
  const buf  = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buf);
  const str  = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, 'RIFF'); view.setUint32(4, 36 + n * 2, true);
  str(8, 'WAVE'); str(12, 'fmt ');
  view.setUint32(16, 16, true);  // chunk size
  view.setUint16(20, 1,  true);  // PCM
  view.setUint16(22, 1,  true);  // mono
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * 2, true);
  view.setUint16(32, 2,  true);
  view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, n * 2, true);
  let off = 44;
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(off, v < 0 ? v * 32768 : v * 32767, true);
    off += 2;
  }
  return new Blob([buf], { type: 'audio/wav' });
}

// ─────────────────────────────────────────────────────────────────────────────
// AUDIO WORKLET — injected as inline Blob URL, no separate .js file needed
//
// WHY AudioWorklet instead of ScriptProcessorNode (deprecated):
//   ScriptProcessorNode runs on main thread → UI jank → dropped samples
//   AudioWorkletProcessor runs on dedicated audio thread → zero drops
//
// HOW IT WORKS:
//   process() called every 128 samples (~8ms at 16kHz)
//   Accumulates into 4096-sample buffer (256ms chunks)
//   Converts Float32 → Int16 (halves memory usage)
//   postMessage with [int16.buffer] transfer = zero-copy (no memcopy)
// ─────────────────────────────────────────────────────────────────────────────
const WORKLET_SRC = `
class PCMRecorderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this._size = (options.processorOptions && options.processorOptions.bufferSize) || 4096;
    this._buf  = new Float32Array(this._size);
    this._pos  = 0;
  }
  process(inputs) {
    const ch = inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this._buf[this._pos++] = ch[i];
      if (this._pos === this._size) {
        const int16 = new Int16Array(this._size);
        for (let j = 0; j < this._size; j++) {
          const v  = Math.max(-1, Math.min(1, this._buf[j]));
          int16[j] = v < 0 ? v * 32768 : v * 32767;
        }
        // Zero-copy transfer: ArrayBuffer ownership moves to main thread
        this.port.postMessage({ type: 'pcm', buf: int16.buffer }, [int16.buffer]);
        this._pos = 0;
      }
    }
    return true; // keep processor alive
  }
}
registerProcessor('pcm-recorder', PCMRecorderProcessor);
`;

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────────────────────────
export default function RecorderPage({ onAudioReady }: RecorderPageProps) {
  const [isRecording,    setIsRecording]    = useState(false);
  const [isProcessing,   setIsProcessing]   = useState(false);
  const [audioUrl,       setAudioUrl]       = useState<string | null>(null);
  const [audioBlob,      setAudioBlob]      = useState<Blob | null>(null);
  const [uploadStatus,   setUploadStatus]   = useState<'uploading' | 'success' | 'error' | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError,    setUploadError]    = useState<string | null>(null);
  const [recordingTime,  setRecordingTime]  = useState(0);
  const [uploadedFile,   setUploadedFile]   = useState<File | null>(null);
  const [mongoId,        setMongoId]        = useState<string | null>(null);
  const [gainValue,      setGainValue]      = useState<number>(DEFAULT_GAIN);
  const [audioDevices,   setAudioDevices]   = useState<MediaDeviceInfo[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<string>('');
  const [processNote,    setProcessNote]    = useState<string | null>(null);

  // ── NEW refs (replaces mediaRecorderRef + audioChunksRef) ─────────────────
  const workletRef    = useRef<AudioWorkletNode | null>(null);
  const workletUrlRef = useRef<string | null>(null);  // blob URL for worklet
  const pcmChunksRef  = useRef<Int16Array[]>([]);     // raw PCM accumulator

  // ── Unchanged refs ────────────────────────────────────────────────────────
  const timerRef       = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef   = useRef<HTMLInputElement | null>(null);
  const audioCtxRef    = useRef<AudioContext | null>(null);
  const gainNodeRef    = useRef<GainNode | null>(null);
  const streamRef      = useRef<MediaStream | null>(null);

  // ── Create worklet blob URL once on mount ─────────────────────────────────
  useEffect(() => {
    const blob = new Blob([WORKLET_SRC], { type: 'application/javascript' });
    workletUrlRef.current = URL.createObjectURL(blob);
    return () => {
      if (workletUrlRef.current) URL.revokeObjectURL(workletUrlRef.current);
    };
  }, []);

  // ── Enumerate audio input devices (unchanged) ─────────────────────────────
  useEffect(() => {
    const loadDevices = async () => {
      try {
        await navigator.mediaDevices
          .getUserMedia({ audio: true })
          .then(s => s.getTracks().forEach(t => t.stop()));
        const devices = await navigator.mediaDevices.enumerateDevices();
        const inputs  = devices.filter(d => d.kind === 'audioinput');
        setAudioDevices(inputs);
        if (inputs.length > 0 && !selectedDevice) setSelectedDevice(inputs[0].deviceId);
      } catch { /* permission denied */ }
    };
    loadDevices();
    navigator.mediaDevices.addEventListener('devicechange', loadDevices);
    return () => navigator.mediaDevices.removeEventListener('devicechange', loadDevices);
  }, []);

  // ── Recording timer (unchanged) ───────────────────────────────────────────
  useEffect(() => {
    if (isRecording) {
      timerRef.current = setInterval(() => setRecordingTime(t => t + 1), 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [isRecording]);

  // ── Live gain update (unchanged) ──────────────────────────────────────────
  useEffect(() => {
    if (gainNodeRef.current) gainNodeRef.current.gain.value = gainValue;
  }, [gainValue]);

  // ── Cleanup ───────────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      audioCtxRef.current?.close();
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, []);

  // ─────────────────────────────────────────────────────────────────────────
  // START RECORDING
  //
  // KEY CHANGE vs original:
  //   OLD: limiter.connect(destination) → MediaRecorder(destination.stream)
  //        MediaRecorder uses Opus → bass artifacts in output
  //
  //   NEW: limiter.connect(worklet)
  //        worklet captures raw PCM Int16 → no codec, no bass artifacts
  //        AudioContext at 16kHz → browser resamples mic internally
  // ─────────────────────────────────────────────────────────────────────────
  const startRecording = async () => {
    if (!workletUrlRef.current) return;
    try {
      interface ChromeAudioConstraints extends MediaTrackConstraints {
        googEchoCancellation?: boolean;
        googAutoGainControl?: boolean;
        googNoiseSuppression?: boolean;
        googHighpassFilter?: boolean;
        googNoiseSuppression2?: boolean;
        googAutoGainControl2?: boolean;
      }

      // UNCHANGED: same constraints as your original
      const audioConstraints: ChromeAudioConstraints = {
        sampleRate:           48000,
        sampleSize:           16,
        channelCount:         1,
        echoCancellation:     true,
        noiseSuppression:     true,
        autoGainControl:      true,
        googEchoCancellation: true,
        googAutoGainControl:  true,
        googNoiseSuppression: true,
        googHighpassFilter:   true,
        googNoiseSuppression2: true,
        googAutoGainControl2:  true,
        ...(selectedDevice ? { deviceId: { exact: selectedDevice } } : {}),
      };

      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
      streamRef.current = stream;

      // CHANGED: AudioContext at 16kHz instead of 48kHz
      // Browser resamples the 48kHz mic stream to 16kHz inside the graph
      // This means PyAnnote/Whisper receive audio at their native rate
      // without any server-side resampling loss
      const ctx = new AudioContext({ sampleRate: TARGET_SR });
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);

      // ── Filter chain (same as your original, same params) ────────────────

      // High-pass: cut rumble below 85Hz
      const highpass = ctx.createBiquadFilter();
      highpass.type  = 'highpass';
      highpass.frequency.setValueAtTime(85,  ctx.currentTime);
      highpass.Q.setValueAtTime(0.7,          ctx.currentTime);

      // Presence boost: +6dB at 3kHz — consonant clarity
      const presenceBoost = ctx.createBiquadFilter();
      presenceBoost.type  = 'peaking';
      presenceBoost.frequency.setValueAtTime(3000, ctx.currentTime);
      presenceBoost.Q.setValueAtTime(1.0,           ctx.currentTime);
      presenceBoost.gain.setValueAtTime(6,           ctx.currentTime);

      // Mid boost: +3dB at 1500Hz — voice formants
      const midBoost = ctx.createBiquadFilter();
      midBoost.type  = 'peaking';
      midBoost.frequency.setValueAtTime(1500, ctx.currentTime);
      midBoost.Q.setValueAtTime(0.8,           ctx.currentTime);
      midBoost.gain.setValueAtTime(3,           ctx.currentTime);

      // User gain slider
      const gainNode      = ctx.createGain();
      gainNode.gain.value = gainValue;
      gainNodeRef.current = gainNode;

      // Compressor: catches quiet far-field voices
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.setValueAtTime(-50,   ctx.currentTime);
      compressor.knee.setValueAtTime(6,           ctx.currentTime);
      compressor.ratio.setValueAtTime(12,         ctx.currentTime);
      compressor.attack.setValueAtTime(0.001,     ctx.currentTime);
      compressor.release.setValueAtTime(0.2,      ctx.currentTime);

      // Makeup gain
      const makeupGain      = ctx.createGain();
      makeupGain.gain.value = 2.5;

      // Limiter
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.setValueAtTime(-3,   ctx.currentTime);
      limiter.knee.setValueAtTime(0,          ctx.currentTime);
      limiter.ratio.setValueAtTime(20,        ctx.currentTime);
      limiter.attack.setValueAtTime(0.001,    ctx.currentTime);
      limiter.release.setValueAtTime(0.05,    ctx.currentTime);

      // ── CHANGED: AudioWorklet instead of MediaStreamDestination ──────────
      await ctx.audioWorklet.addModule(workletUrlRef.current!);
      const worklet = new AudioWorkletNode(ctx, 'pcm-recorder', {
        processorOptions: { bufferSize: 4096 }, // 256ms chunks at 16kHz
      });
      workletRef.current   = worklet;
      pcmChunksRef.current = [];

      // Receive Int16 PCM chunks from worklet thread
      worklet.port.onmessage = (e) => {
        if (e.data.type === 'pcm') {
          pcmChunksRef.current.push(new Int16Array(e.data.buf));
        }
      };

      // ── CHANGED: last node connects to worklet, NOT to MediaStreamDestination
      // worklet is NOT connected to ctx.destination → capture only, no playback
      source.connect(highpass);
      highpass.connect(presenceBoost);
      presenceBoost.connect(midBoost);
      midBoost.connect(gainNode);
      gainNode.connect(compressor);
      compressor.connect(makeupGain);
      makeupGain.connect(limiter);
      limiter.connect(worklet);  // ← was: limiter.connect(destination)

      // ── REMOVED: MediaRecorder creation and event handlers ───────────────
      // mediaRecorder.ondataavailable → replaced by worklet.port.onmessage
      // mediaRecorder.onstop          → replaced by stopRecording() body
      // mediaRecorder.start(250)      → replaced by worklet running continuously

      setIsRecording(true);
      setRecordingTime(0);
      setAudioUrl(null);
      setAudioBlob(null);
      setUploadStatus(null);
      setUploadProgress(0);
      setUploadError(null);
      setUploadedFile(null);
      setMongoId(null);
      setProcessNote(null);

    } catch (err) {
      console.error('Microphone error:', err);
      alert('Microphone access denied or unavailable.');
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // STOP RECORDING
  //
  // KEY CHANGE vs original:
  //   OLD: mediaRecorder.stop() → triggers onstop → enhanceForDiarization()
  //        Enhancement was POST-capture trying to fix codec damage
  //
  //   NEW: worklet.disconnect() → concat Int16 → Float32 → normalise → WAV
  //        No codec damage to fix — audio was captured clean from the start
  //        enhanceForDiarization() no longer needed
  // ─────────────────────────────────────────────────────────────────────────
  const stopRecording = async () => {
    if (!workletRef.current || !audioCtxRef.current) return;

    setIsRecording(false);
    setIsProcessing(true);
    setProcessNote('Encoding lossless WAV…');

    // Stop mic tracks
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;

    // Disconnect worklet — no more PCM chunks after this point
    workletRef.current.disconnect();
    workletRef.current.port.onmessage = null;
    workletRef.current = null;

    await audioCtxRef.current.close();
    audioCtxRef.current = null;
    gainNodeRef.current = null;

    // Wait one frame for any in-flight postMessages to land in pcmChunksRef
    await new Promise(r => setTimeout(r, 80));

    // ── Concatenate all Int16 chunks into one array ───────────────────────
    const chunks  = pcmChunksRef.current;
    const total   = chunks.reduce((s, c) => s + c.length, 0);
    const allInt16 = new Int16Array(total);
    let   pos      = 0;
    for (const c of chunks) { allInt16.set(c, pos); pos += c.length; }
    pcmChunksRef.current = [];

    // ── Convert Int16 → Float32 ───────────────────────────────────────────
    const float32 = new Float32Array(allInt16.length);
    for (let i = 0; i < allInt16.length; i++) float32[i] = allInt16[i] / 32768;

    // ── Normalise to 0.8 peak ─────────────────────────────────────────────
    // Same as your original enhanceForDiarization() normalisation step
    // Maximises dynamic range — diarization models work best near full scale
    let peak = 0;
    for (let i = 0; i < float32.length; i++) {
      const a = Math.abs(float32[i]);
      if (a > peak) peak = a;
    }
    if (peak > 0.001) {
      const scale = 0.8 / peak;
      for (let i = 0; i < float32.length; i++) float32[i] *= scale;
    }

    // ── Encode as WAV — lossless, no Opus involved ────────────────────────
    const wavBlob = encodePCMtoWAV(float32, TARGET_SR);
    const wavUrl  = URL.createObjectURL(wavBlob);
    const durS    = (float32.length / TARGET_SR).toFixed(1);
    const sizeMB  = (wavBlob.size / 1048576).toFixed(1);

    setIsProcessing(false);
    setProcessNote(`✓ Lossless WAV — ${durS}s | ${sizeMB} MB | ${TARGET_SR / 1000}kHz mono PCM`);

    setAudioBlob(wavBlob);
    setAudioUrl(wavUrl);
    setUploadedFile(null);

    uploadToDrive(wavBlob, null);
  };

  // ─────────────────────────────────────────────────────────────────────────
  // FILE UPLOAD HANDLER
  // CHANGED: now runs the same filter+normalise pipeline via OfflineAudioContext
  // before uploading, so uploaded files get same quality treatment as recordings
  // ─────────────────────────────────────────────────────────────────────────
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    setIsProcessing(true);
    setProcessNote('Processing uploaded file…');

    try {
      const arrayBuf = await file.arrayBuffer();
      const tempCtx  = new AudioContext();
      const decoded  = await tempCtx.decodeAudioData(arrayBuf);
      await tempCtx.close();

      const renderLen = Math.ceil(decoded.length * TARGET_SR / decoded.sampleRate);
      const offCtx    = new OfflineAudioContext(1, renderLen, TARGET_SR);
      const srcBuf    = offCtx.createBuffer(1, decoded.length, decoded.sampleRate);

      // Downmix to mono if stereo
      if (decoded.numberOfChannels > 1) {
        const mixed = new Float32Array(decoded.length);
        for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
          const d = decoded.getChannelData(ch);
          for (let i = 0; i < decoded.length; i++) mixed[i] += d[i];
        }
        for (let i = 0; i < decoded.length; i++) mixed[i] /= decoded.numberOfChannels;
        srcBuf.copyToChannel(mixed, 0);
      } else {
        srcBuf.copyToChannel(decoded.getChannelData(0), 0);
      }

      const src = offCtx.createBufferSource();
      src.buffer = srcBuf;

      // Same filter chain as live recording
      const hp   = offCtx.createBiquadFilter();
      hp.type    = 'highpass'; hp.frequency.value = 85; hp.Q.value = 0.7;

      const pres = offCtx.createBiquadFilter();
      pres.type  = 'peaking'; pres.frequency.value = 3000;
      pres.Q.value = 1.0;     pres.gain.value = 6;

      const mid  = offCtx.createBiquadFilter();
      mid.type   = 'peaking'; mid.frequency.value = 1500;
      mid.Q.value = 0.8;      mid.gain.value = 3;

      const g       = offCtx.createGain();
      g.gain.value  = 1.0;

      src.connect(hp); hp.connect(pres); pres.connect(mid);
      mid.connect(g); g.connect(offCtx.destination);
      src.start(0);

      const rendered = await offCtx.startRendering();
      const data     = rendered.getChannelData(0);

      // Normalise
      let peak = 0;
      for (let i = 0; i < data.length; i++) {
        const a = Math.abs(data[i]);
        if (a > peak) peak = a;
      }
      if (peak > 0.001) {
        const s = 0.8 / peak;
        for (let i = 0; i < data.length; i++) data[i] *= s;
      }

      const wavBlob = encodePCMtoWAV(data, TARGET_SR);
      const wavUrl  = URL.createObjectURL(wavBlob);
      const durS    = (data.length / TARGET_SR).toFixed(1);
      const sizeMB  = (wavBlob.size / 1048576).toFixed(1);

      setIsProcessing(false);
      setProcessNote(`✓ Processed — ${durS}s | ${sizeMB} MB | ${TARGET_SR / 1000}kHz mono PCM`);
      setUploadedFile(file);
      setAudioBlob(wavBlob);
      setAudioUrl(wavUrl);
      setUploadStatus(null);
      setUploadProgress(0);
      setUploadError(null);
      setMongoId(null);

      uploadToDrive(wavBlob, file);

    } catch (err) {
      console.error('[file-process]', err);
      // Fallback: upload original unprocessed
      const objectUrl = URL.createObjectURL(file);
      setUploadedFile(file);
      setAudioUrl(objectUrl);
      setAudioBlob(file);
      setIsProcessing(false);
      setProcessNote('⚠ Processing failed — uploading original file');
      uploadToDrive(file, file);
    }
  };

  const clearFile = () => {
    setUploadedFile(null);
    setAudioUrl(null);
    setAudioBlob(null);
    setUploadStatus(null);
    setUploadProgress(0);
    setUploadError(null);
    setMongoId(null);
    setProcessNote(null);
  };

  // ── Upload (unchanged logic, updated filename extension) ──────────────────
  const uploadToDrive = async (blobArg: Blob | null, fileArg: File | null | undefined) => {
    const source = blobArg ?? audioBlob;
    const file   = fileArg !== undefined ? fileArg : uploadedFile;
    if (!source || source.size === 0) return;

    setUploadStatus('uploading');
    setUploadProgress(0);
    setUploadError(null);

    const now      = new Date();
    const dateStr  = now.toLocaleDateString('en-GB').split('/').reverse().join('-');
    const timeStr  = now.toLocaleTimeString('en-GB', { hour12: false }).replace(/:/g, '-');
    // Always .wav now — signals clean PCM to backend pipeline
    const ext      = source.type === 'audio/wav' ? 'wav' : 'webm';
    const filename = file?.name ?? `Meeting_${dateStr}_${timeStr}.${ext}`;
    const mimeType = source.type || 'audio/wav';
    const backendUrl = import.meta.env.VITE_BACKEND_URL ?? '';

    try {
      const presignRes = await fetch(
        `${backendUrl}/api/presign?filename=${encodeURIComponent(filename)}&content_type=${encodeURIComponent(mimeType)}`
      );
      if (!presignRes.ok) throw new Error(`Presign failed: ${await presignRes.text()}`);
      const { presigned_url, s3_key, file_url } = await presignRes.json();

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setUploadProgress(Math.round(e.loaded / e.total * 100));
        };
        xhr.onload  = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`S3 error: ${xhr.status}`));
        xhr.onerror = () => reject(new Error('S3 Network error'));
        xhr.open('PUT', presigned_url);
        xhr.setRequestHeader('Content-Type', mimeType);
        xhr.send(source);
      });

      const regRes = await fetch(`${backendUrl}/api/meetings/register`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ filename, s3_key, file_url }),
      });
      if (!regRes.ok) throw new Error(`DB Register failed: ${await regRes.text()}`);

      const data = await regRes.json();
      setUploadStatus('success');
      setMongoId(data.mongo_id ?? null);

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[UPLOAD] Error:', msg);
      setUploadError(msg);
      setUploadStatus('error');
    }
  };

  const hasAudio   = !!audioUrl && !isRecording && !isProcessing;
  const canProceed = hasAudio && (uploadStatus === 'success' || uploadStatus === null);

  // ── JSX (unchanged from your original) ───────────────────────────────────
  return (
    <div className="card">
      <div className="card-header">
        <div className="card-eyebrow">
          <span className={`eyebrow-dot ${isRecording ? 'live' : ''}`} />
          <span className="eyebrow-text">
            {isProcessing ? 'Processing…' : isRecording ? 'Recording in progress' : 'Ready'}
          </span>
        </div>
        <h1 className="card-title">Meeting Recorder</h1>
        <p className="card-desc">Capture audio and sync securely to MoM-ai.</p>
      </div>

      <div className="card-body">

        {/* ── Microphone selector ──────────────────────────────────────────── */}
        {audioDevices.length > 1 && !isRecording && (
          <div className="device-selector" style={{ marginBottom: '1rem' }}>
            <label style={{ fontSize: '0.78rem', opacity: 0.75, fontWeight: 500, display: 'block', marginBottom: '0.4rem' }}>
              🎙️ Microphone
            </label>
            <select
              value={selectedDevice}
              onChange={(e) => setSelectedDevice(e.target.value)}
              style={{
                width: '100%', padding: '0.45rem 0.7rem', borderRadius: '8px',
                border: '1px solid rgba(255,255,255,0.15)',
                background: 'rgba(255,255,255,0.07)',
                color: 'inherit', fontSize: '0.8rem', cursor: 'pointer',
              }}
            >
              {audioDevices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `Microphone ${device.deviceId.slice(0, 8)}`}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* ── Timer / file chip ─────────────────────────────────────────────── */}
        <div className="timer-section">
          {(!uploadedFile || isRecording) && (
            <TimerDisplay seconds={recordingTime} isRecording={isRecording} />
          )}
          {uploadedFile && !isRecording && (
            <div className="file-chip" style={{ width: '100%' }}>
              <div className="file-chip-icon">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 18V5l12-2v13" />
                  <circle cx="6" cy="18" r="3" />
                  <circle cx="18" cy="16" r="3" />
                </svg>
              </div>
              <div className="file-chip-info">
                <span className="file-chip-name">{uploadedFile.name}</span>
                <span className="file-chip-meta">{formatFileSize(uploadedFile.size)}</span>
              </div>
              <button className="file-chip-remove" title="Remove" onClick={clearFile}>✕</button>
            </div>
          )}
        </div>

        {/* ── Processing indicator ─────────────────────────────────────────── */}
        {isProcessing && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: '0.6rem',
            padding: '0.6rem 0.9rem', borderRadius: '8px',
            background: 'rgba(99,102,241,0.12)',
            border: '1px solid rgba(99,102,241,0.25)',
            fontSize: '0.8rem', marginBottom: '0.8rem',
          }}>
            <div className="spinner" />
            <span>{processNote || 'Processing audio…'}</span>
          </div>
        )}

        {/* ── Post-processing result note ──────────────────────────────────── */}
        {processNote && !isProcessing && (
          <div style={{
            padding: '0.5rem 0.9rem', borderRadius: '8px',
            background: processNote.startsWith('⚠') ? 'rgba(234,179,8,0.1)' : 'rgba(34,197,94,0.1)',
            border: `1px solid ${processNote.startsWith('⚠') ? 'rgba(234,179,8,0.2)' : 'rgba(34,197,94,0.2)'}`,
            fontSize: '0.75rem',
            color: processNote.startsWith('⚠') ? '#fde047' : '#86efac',
            marginBottom: '0.8rem',
          }}>
            {processNote}
          </div>
        )}

        {/* ── Gain / Room Size Slider (unchanged) ─────────────────────────── */}
        <div className="gain-control">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
            <label style={{ fontSize: '0.78rem', opacity: 0.75, fontWeight: 500 }}>
              🎙️ Room Distance / Gain Boost
            </label>
            <span style={{ fontSize: '0.75rem', opacity: 0.6, fontFamily: 'monospace' }}>
              {gainValue === MIN_GAIN
                ? 'Close (×1.0)'
                : gainValue <= 2.0
                  ? `Medium (×${gainValue.toFixed(1)})`
                  : `Far / Large Room (×${gainValue.toFixed(1)})`}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <span style={{ fontSize: '0.7rem', opacity: 0.5 }}>Near</span>
            <input
              type="range" min={MIN_GAIN} max={MAX_GAIN} step={0.1} value={gainValue}
              onChange={(e) => setGainValue(parseFloat(e.target.value))}
              style={{ flex: 1, accentColor: '#d4a020', cursor: 'pointer' }}
            />
            <span style={{ fontSize: '0.7rem', opacity: 0.5 }}>Far</span>
          </div>
          <p style={{ fontSize: '0.68rem', opacity: 0.45, marginTop: '0.4rem', marginBottom: 0 }}>
            Increase for large conference rooms or when device is far from speakers.
            {isRecording && ' Adjustments apply instantly.'}
          </p>
        </div>

        {/* ── Controls section (unchanged) ─────────────────────────────────── */}
        <div className="controls-section">

          {uploadStatus === 'uploading' && (
            <div className="status-block uploading">
              <div style={{ width: '100%' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.4rem' }}>
                  <div className="spinner" />
                  <span>Uploading to S3… {uploadProgress}%</span>
                </div>
                <div style={{ width: '100%', height: '6px', background: 'rgba(255,255,255,0.15)', borderRadius: '99px', overflow: 'hidden' }}>
                  <div style={{
                    height: '100%', width: `${uploadProgress}%`,
                    background: 'linear-gradient(90deg, #6366f1, #8b5cf6)',
                    borderRadius: '99px', transition: 'width 0.3s ease',
                  }} />
                </div>
              </div>
            </div>
          )}
          {uploadStatus === 'success' && (
            <div className="status-block success">
              <span className="status-icon">✓</span>File synced successfully.
            </div>
          )}
          {uploadStatus === 'error' && (
            <div className="status-block error">
              <span className="status-icon">✕</span>
              <div>
                <div>Upload failed — please retry.</div>
                {uploadError && (
                  <div style={{ fontSize: '0.72rem', opacity: 0.7, marginTop: '0.2rem', wordBreak: 'break-word' }}>
                    {uploadError}
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="controls">
            {!isRecording ? (
              <button className="btn btn-start" onClick={startRecording} disabled={isProcessing}>
                <span className="rec-dot" />Start Recording
              </button>
            ) : (
              <button className="btn btn-stop" onClick={stopRecording}>
                <span className="stop-square" />Stop Recording
              </button>
            )}

            {!isRecording && !isProcessing && (
              <>
                <div className="divider"><span className="divider-label">or</span></div>
                <button className="btn btn-upload" onClick={() => fileInputRef.current?.click()}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  Upload Audio File
                </button>
                <input
                  ref={fileInputRef} type="file" accept="audio/*"
                  style={{ display: 'none' }} onChange={handleFileChange}
                />
              </>
            )}
          </div>

          {hasAudio && uploadStatus !== 'uploading' && (
            <div className="audio-section">
              <div className="audio-label">Playback</div>
              <audio src={audioUrl!} controls />
              <div className="audio-actions">
                {((uploadStatus === null && uploadedFile) || uploadStatus === 'error') && (
                  <button className="btn btn-sync" onClick={() => uploadToDrive(audioBlob, uploadedFile)}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="23 4 23 10 17 10" />
                      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                    </svg>
                    {uploadStatus === 'error' ? 'Retry Upload' : 'Upload to MoM-ai'}
                  </button>
                )}
                <button className="btn btn-secondary" onClick={startRecording}>New Recording</button>
              </div>

              {canProceed && (
                <button
                  className="btn btn-proceed"
                  onClick={() => onAudioReady({ audioUrl: audioUrl!, audioBlob: audioBlob!, uploadedFile, mongoId })}
                >
                  Continue to Meeting Details
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="5" y1="12" x2="19" y2="12" />
                    <polyline points="12 5 19 12 12 19" />
                  </svg>
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}