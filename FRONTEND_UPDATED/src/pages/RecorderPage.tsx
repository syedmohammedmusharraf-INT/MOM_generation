import { useState, useRef, useEffect } from 'react';
import TimerDisplay from '@/components/TimerDisplay';

const formatFileSize = (bytes: number) => {
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
};

export interface AudioMeta {
  audioUrl: string;
  audioBlob: Blob;
  uploadedFile: File | null;
  mongoId: string | null;
}

interface RecorderPageProps {
  onAudioReady: (meta: AudioMeta) => void;
}

// ─── Codec helper ────────────────────────────────────────────────────────────
const getSupportedMimeType = (): string => {
  const types = [
    'audio/webm;codecs=opus',
    'audio/ogg;codecs=opus',
    'audio/webm',
  ];
  return types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
};

// ─── Gain limits ─────────────────────────────────────────────────────────────
const MIN_GAIN = 1.0;
const MAX_GAIN = 10.0;       // up to 10× for very large rooms / far speakers
const DEFAULT_GAIN = 2.5;

export default function RecorderPage({ onAudioReady }: RecorderPageProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [uploadStatus, setUploadStatus] = useState<'uploading' | 'success' | 'error' | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [recordingTime, setRecordingTime] = useState(0);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [mongoId, setMongoId] = useState<string | null>(null);
  const [gainValue, setGainValue] = useState<number>(DEFAULT_GAIN);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);

  useEffect(() => {
    if (isRecording) {
      timerRef.current = setInterval(() => setRecordingTime((t) => t + 1), 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isRecording]);

  // Update gain in real-time while recording
  useEffect(() => {
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = gainValue;
    }
  }, [gainValue]);

  // Cleanup AudioContext on unmount
  useEffect(() => {
    return () => {
      if (audioContextRef.current) {
        audioContextRef.current.close();
      }
    };
  }, []);

  const startRecording = async () => {
    try {
      // ── Step 1: High-quality, far-field audio constraints ──────────────────
      // We use a typed interface to safely include Chrome-specific goog* hints
      // that are not part of the standard MediaTrackConstraints spec.
      interface ChromeAudioConstraints extends MediaTrackConstraints {
        googEchoCancellation?: boolean;
        googAutoGainControl?: boolean;
        googNoiseSuppression?: boolean;
        googHighpassFilter?: boolean;
        googNoiseSuppression2?: boolean;
        googAutoGainControl2?: boolean;
      }

      const audioConstraints: ChromeAudioConstraints = {
        sampleRate: 48000,
        sampleSize: 16,
        channelCount: 1,           // Mono is better for speech at distance

        echoCancellation: true,    // Remove room echo / reflections
        noiseSuppression: true,    // Kill background hiss and hum
        autoGainControl: true,     // Boost mic gain automatically when far

        // Chrome-specific advanced hints (ignored silently on other browsers)
        googEchoCancellation: true,
        googAutoGainControl: true,
        googNoiseSuppression: true,
        googHighpassFilter: true,   // Remove low-freq rumble from AC/fans
        googNoiseSuppression2: true,
        googAutoGainControl2: true,
      };

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
      });

      // ── Step 2: Web Audio pipeline: source → gain → destination ───────────
      const audioContext = new AudioContext({ sampleRate: 48000 });
      audioContextRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);

      // ── High-pass filter: cut rumble, hum, and low-freq noise below 150Hz ─
      const highpass = audioContext.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.setValueAtTime(150, audioContext.currentTime);
      highpass.Q.setValueAtTime(0.7, audioContext.currentTime);

      // ── User gain slider ───────────────────────────────────────────────────
      const gainNode = audioContext.createGain();
      gainNode.gain.value = gainValue;
      gainNodeRef.current = gainNode;

      // ── Compressor: boost speech, ignore noise floor ───────────────────────
      const compressor = audioContext.createDynamicsCompressor();
      compressor.threshold.setValueAtTime(-26, audioContext.currentTime);  // Only compress speech-level signals
      compressor.knee.setValueAtTime(10, audioContext.currentTime);        // Narrow knee — sharper transition
      compressor.ratio.setValueAtTime(4, audioContext.currentTime);        // Moderate compression
      compressor.attack.setValueAtTime(0.003, audioContext.currentTime);   // 3ms attack — catches speech onsets
      compressor.release.setValueAtTime(0.15, audioContext.currentTime);   // Quick release between words

      // ── Moderate makeup gain to lift compressed signal ──────────────────────
      const makeupGain = audioContext.createGain();
      makeupGain.gain.value = 1.5;  // Gentle +3.5dB lift, not noisy

      const destination = audioContext.createMediaStreamDestination();
      source.connect(highpass);
      highpass.connect(gainNode);
      gainNode.connect(compressor);
      compressor.connect(makeupGain);
      makeupGain.connect(destination);

      // ── Step 3: Record from the PROCESSED stream with best codec ──────────
      const mimeType = getSupportedMimeType();
      const mediaRecorder = new MediaRecorder(destination.stream, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: 256000,  // 256 kbps: better quality for speech
      });

      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = () => {
        const finalMime = mimeType || 'audio/webm';
        const blob = new Blob(audioChunksRef.current, { type: finalMime });
        setAudioBlob(blob);
        setAudioUrl(URL.createObjectURL(blob));
        setUploadedFile(null);
        uploadToDrive(blob, null);

        // Tear down audio context
        audioContext.close();
        audioContextRef.current = null;
        gainNodeRef.current = null;
      };

      // ── Step 4: Collect data every 250 ms to avoid loss on long recordings ─
      mediaRecorder.start(250);

      setIsRecording(true);
      setRecordingTime(0);
      setAudioUrl(null);
      setAudioBlob(null);
      setUploadStatus(null);
      setUploadProgress(0);
      setUploadError(null);
      setUploadedFile(null);
      setMongoId(null);
    } catch (err) {
      console.error('Microphone error:', err);
      alert('Microphone access denied or unavailable.');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach((t) => t.stop());
      setIsRecording(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const objectUrl = URL.createObjectURL(file);
    setUploadedFile(file);
    setAudioUrl(objectUrl);
    setAudioBlob(file);
    setUploadStatus(null);
    setUploadProgress(0);
    setUploadError(null);
    setMongoId(null);
    e.target.value = '';
    uploadToDrive(file, file);
  };

  const clearFile = () => {
    setUploadedFile(null);
    setAudioUrl(null);
    setAudioBlob(null);
    setUploadStatus(null);
    setUploadProgress(0);
    setUploadError(null);
    setMongoId(null);
  };

  /**
   * HIGH-SPEED UPLOAD: Browser -> S3 Directly
   * 1. GET /api/presign
   * 2. PUT to S3 (tracked with real progress)
   * 3. POST /api/meetings/register
   */
  const uploadToDrive = async (blobArg: Blob | null, fileArg: File | null | undefined) => {
    const source = blobArg || audioBlob;
    const file = fileArg !== undefined ? fileArg : uploadedFile;
    if (!source || source.size === 0) return;

    setUploadStatus('uploading');
    setUploadProgress(0);
    setUploadError(null);

    const now = new Date();
    const dateStr = now.toLocaleDateString('en-GB').split('/').reverse().join('-');
    const timeStr = now.toLocaleTimeString('en-GB', { hour12: false }).replace(/:/g, '-');
    const filename = file?.name || `Meeting_${dateStr}_${timeStr}.webm`;
    const mimeType = (source as File).type || getSupportedMimeType() || 'audio/webm';

    const backendUrl = import.meta.env.VITE_BACKEND_URL || '';

    try {
      // 1. Get Ticket (Presigned URL)
      const presignRes = await fetch(
        `${backendUrl}/api/presign?filename=${encodeURIComponent(filename)}&content_type=${encodeURIComponent(mimeType)}`
      );
      if (!presignRes.ok) throw new Error(`Presign failed: ${await presignRes.text()}`);

      const { presigned_url, s3_key, file_url } = await presignRes.json();
      console.log(`[UPLOAD] Starting direct S3 PUT for ${filename}...`);

      // 2. Direct PUT to S3 with Progress
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setUploadProgress(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () =>
          xhr.status >= 200 && xhr.status < 300
            ? resolve()
            : reject(new Error(`S3 error: ${xhr.status}`));
        xhr.onerror = () => reject(new Error('S3 Network error'));
        xhr.open('PUT', presigned_url);
        xhr.setRequestHeader('Content-Type', mimeType);
        xhr.send(source);
      });

      // 3. Register in MongoDB
      const regRes = await fetch(`${backendUrl}/api/meetings/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, s3_key, file_url }),
      });
      if (!regRes.ok) throw new Error(`DB Register failed: ${await regRes.text()}`);

      const data = await regRes.json();
      setUploadStatus('success');
      setMongoId(data.mongo_id || null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[UPLOAD] Error:', msg);
      setUploadError(msg);
      setUploadStatus('error');
    }
  };

  const hasAudio = audioUrl && !isRecording;
  const canProceed = hasAudio && (uploadStatus === 'success' || uploadStatus === null);

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-eyebrow">
          <span className={`eyebrow-dot ${isRecording ? 'live' : ''}`} />
          <span className="eyebrow-text">
            {isRecording ? 'Recording in progress' : 'Ready'}
          </span>
        </div>
        <h1 className="card-title">Meeting Recorder</h1>
        <p className="card-desc">Capture audio and sync securely to MoM-ai.</p>
      </div>

      <div className="card-body">
        <div className="timer-section">
          {(!uploadedFile || isRecording) && (
            <TimerDisplay seconds={recordingTime} isRecording={isRecording} />
          )}
          {uploadedFile && !isRecording && (
            <div className="file-chip" style={{ width: '100%' }}>
              <div className="file-chip-icon">
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M9 18V5l12-2v13" />
                  <circle cx="6" cy="18" r="3" />
                  <circle cx="18" cy="16" r="3" />
                </svg>
              </div>
              <div className="file-chip-info">
                <span className="file-chip-name">{uploadedFile.name}</span>
                <span className="file-chip-meta">{formatFileSize(uploadedFile.size)}</span>
              </div>
              <button className="file-chip-remove" title="Remove" onClick={clearFile}>
                ✕
              </button>
            </div>
          )}
        </div>

        {/* ── Gain / Room Size Slider ─────────────────────────────────────── */}
        <div
          className="gain-control"
          style={{
            marginBottom: '1rem',
            padding: '0.75rem 1rem',
            background: 'rgba(255,255,255,0.05)',
            borderRadius: '10px',
            border: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '0.5rem',
            }}
          >
            <label style={{ fontSize: '0.78rem', opacity: 0.75, fontWeight: 500 }}>
              🎙️ Room Distance / Gain Boost
            </label>
            <span
              style={{
                fontSize: '0.75rem',
                opacity: 0.6,
                fontFamily: 'monospace',
              }}
            >
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
              type="range"
              min={MIN_GAIN}
              max={MAX_GAIN}
              step={0.1}
              value={gainValue}
              onChange={(e) => setGainValue(parseFloat(e.target.value))}
              style={{ flex: 1, accentColor: '#6366f1', cursor: 'pointer' }}
            />
            <span style={{ fontSize: '0.7rem', opacity: 0.5 }}>Far</span>
          </div>
          <p
            style={{
              fontSize: '0.68rem',
              opacity: 0.45,
              marginTop: '0.4rem',
              marginBottom: 0,
            }}
          >
            Increase for large conference rooms or when device is far from speakers.
            {isRecording && ' Adjustments apply instantly.'}
          </p>
        </div>

        <div className="controls-section">
          {uploadStatus === 'uploading' && (
            <div className="status-block uploading">
              <div style={{ width: '100%' }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    marginBottom: '0.4rem',
                  }}
                >
                  <div className="spinner" />
                  <span>Uploading to S3… {uploadProgress}%</span>
                </div>
                <div
                  style={{
                    width: '100%',
                    height: '6px',
                    background: 'rgba(255,255,255,0.15)',
                    borderRadius: '99px',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      height: '100%',
                      width: `${uploadProgress}%`,
                      background: 'linear-gradient(90deg, #6366f1, #8b5cf6)',
                      borderRadius: '99px',
                      transition: 'width 0.3s ease',
                    }}
                  />
                </div>
              </div>
            </div>
          )}
          {uploadStatus === 'success' && (
            <div className="status-block success">
              <span className="status-icon">✓</span>
              File synced successfully.
            </div>
          )}
          {uploadStatus === 'error' && (
            <div className="status-block error">
              <span className="status-icon">✕</span>
              <div>
                <div>Upload failed — please retry.</div>
                {uploadError && (
                  <div
                    style={{
                      fontSize: '0.72rem',
                      opacity: 0.7,
                      marginTop: '0.2rem',
                      wordBreak: 'break-word',
                    }}
                  >
                    {uploadError}
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="controls">
            {!isRecording ? (
              <button className="btn btn-start" onClick={startRecording}>
                <span className="rec-dot" />
                Start Recording
              </button>
            ) : (
              <button className="btn btn-stop" onClick={stopRecording}>
                <span className="stop-square" />
                Stop Recording
              </button>
            )}

            {!isRecording && (
              <>
                <div className="divider">
                  <span className="divider-label">or</span>
                </div>
                <button
                  className="btn btn-upload"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  Upload Audio File
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="audio/*"
                  style={{ display: 'none' }}
                  onChange={handleFileChange}
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
                  <button
                    className="btn btn-sync"
                    onClick={() => uploadToDrive(audioBlob, uploadedFile)}
                  >
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="23 4 23 10 17 10" />
                      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                    </svg>
                    {uploadStatus === 'error' ? 'Retry Upload' : 'Upload to MoM-ai'}
                  </button>
                )}
                <button className="btn btn-secondary" onClick={startRecording}>
                  New Recording
                </button>
              </div>

              {canProceed && (
                <button
                  className="btn btn-proceed"
                  onClick={() =>
                    onAudioReady({
                      audioUrl: audioUrl!,
                      audioBlob: audioBlob!,
                      uploadedFile,
                      mongoId,
                    })
                  }
                >
                  Continue to Meeting Details
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
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