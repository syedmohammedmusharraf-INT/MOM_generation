interface TimerDisplayProps {
  seconds: number;
  isRecording: boolean;
}

const padTwo = (n: number) => String(n).padStart(2, '0');

export default function TimerDisplay({ seconds, isRecording }: TimerDisplayProps) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;

  return (
    <div className="timer-wrap">
      <div className="timer-digits">
        <span className={`timer-seg ${isRecording ? 'recording' : ''}`}>{padTwo(mins)}</span>
        <span className={`timer-colon ${isRecording ? 'recording' : ''}`}>:</span>
        <span className={`timer-seg ${isRecording ? 'recording' : ''}`}>{padTwo(secs)}</span>
      </div>
      <div className="timer-footer">
        <div className={`timer-status-dot ${isRecording ? 'recording' : ''}`} />
        <span className="timer-label">{isRecording ? 'elapsed' : 'duration'}</span>
      </div>
    </div>
  );
}
