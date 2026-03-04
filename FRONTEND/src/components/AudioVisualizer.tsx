import { useEffect, useRef } from 'react';

interface AudioVisualizerProps {
    stream: MediaStream | null;
    isRecording: boolean;
}

export default function AudioVisualizer({ stream, isRecording }: AudioVisualizerProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const animRef = useRef<number>(0);
    const wrapRef = useRef<HTMLDivElement>(null);

    // Sync canvas intrinsic size to its CSS-rendered size
    const syncCanvasSize = () => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        if (rect.width > 0 && (canvas.width !== Math.round(rect.width) || canvas.height !== Math.round(rect.height))) {
            canvas.width = Math.round(rect.width);
            canvas.height = Math.round(rect.height);
        }
    };

    // ── Idle state: subtle flat sine bars ────────────────────────
    const drawIdle = () => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        syncCanvasSize();
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const W = canvas.width;
        const H = canvas.height;

        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = '#fdf9ee';
        ctx.fillRect(0, 0, W, H);

        const barCount = 60;
        const gap = 2;
        const barW = (W - gap * (barCount - 1)) / barCount;
        let x = 0;
        for (let i = 0; i < barCount; i++) {
            const h = 2 + Math.sin(i * 0.45) * 1.5;
            ctx.fillStyle = 'rgba(212, 160, 32, 0.18)';
            ctx.fillRect(x, H - h, barW, h);
            x += barW + gap;
        }
    };

    // ── Live recording: real frequency spectrogram ─────────────────
    useEffect(() => {
        if (!isRecording || !stream) {
            cancelAnimationFrame(animRef.current);
            // Small delay so canvas is laid out before we draw
            const id = setTimeout(drawIdle, 50);
            return () => clearTimeout(id);
        }

        syncCanvasSize();
        const canvas = canvasRef.current!;
        const ctx = canvas.getContext('2d')!;

        const audioCtx = new AudioContext();
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.82;

        const source = audioCtx.createMediaStreamSource(stream);
        source.connect(analyser);

        const bufferLength = analyser.frequencyBinCount; // 128
        const dataArray = new Uint8Array(bufferLength);

        const draw = () => {
            animRef.current = requestAnimationFrame(draw);
            analyser.getByteFrequencyData(dataArray);

            const W = canvas.width;
            const H = canvas.height;

            // Semi-transparent fill for motion blur trail
            ctx.fillStyle = 'rgba(253, 249, 238, 0.55)';
            ctx.fillRect(0, 0, W, H);

            const barCount = bufferLength;
            const gap = 2;
            const barW = (W - gap * (barCount - 1)) / barCount;
            let x = 0;

            for (let i = 0; i < barCount; i++) {
                const value = dataArray[i] / 255; // 0–1
                const barH = Math.max(2, value * H * 0.90);

                // Hue: 240 (indigo) → 280 (violet) → 320 (pink) as volume rises
                const hue = 35 + value * 15;
                const sat = 60 + value * 30;
                const lit = 45 + value * 25;

                // Shadow glow on hot bars
                ctx.shadowBlur = value > 0.5 ? 6 + value * 12 : 0;
                ctx.shadowColor = value > 0.5 ? `hsla(${hue}, ${sat}%, ${lit + 15}%, 0.5)` : 'transparent';

                // Gradient: bright top, darker bottom
                const grad = ctx.createLinearGradient(0, H - barH, 0, H);
                grad.addColorStop(0, `hsl(${hue}, ${sat}%, ${lit}%)`);
                grad.addColorStop(1, `hsl(${hue + 10}, ${sat - 10}%, ${Math.max(15, lit - 15)}%)`);

                ctx.fillStyle = grad;
                ctx.fillRect(x, H - barH, barW, barH);

                // Bright 2px cap at the top of each bar
                if (barH > 4) {
                    ctx.shadowBlur = 0;
                    ctx.fillStyle = `hsla(${hue - 10}, 90%, 70%, ${value * 0.75})`;
                    ctx.fillRect(x, H - barH - 2, barW, 2);
                }

                x += barW + gap;
            }
        };

        draw();

        return () => {
            cancelAnimationFrame(animRef.current);
            source.disconnect();
            audioCtx.close();
        };
    }, [isRecording, stream]);

    // Draw idle on first mount (after layout)
    useEffect(() => {
        const id = setTimeout(drawIdle, 80);
        return () => clearTimeout(id);
    }, []);

    return (
        <div className="visualizer-wrap" ref={wrapRef}>
            <div className="visualizer-label">
                <span className={`vis-dot ${isRecording ? 'live' : ''}`} />
                {isRecording ? 'Live Audio' : 'Waiting'}
            </div>
            <canvas
                ref={canvasRef}
                className="visualizer-canvas"
                style={{ display: 'block', width: '100%', height: '96px' }}
            />
        </div>
    );
}
