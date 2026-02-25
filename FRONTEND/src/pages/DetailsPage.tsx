import { useState } from 'react';
import { AudioMeta } from './RecorderPage';

const formatFileSize = (bytes: number) => {
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
};

const localDatetimeValue = () => {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  const local = new Date(now.getTime() - offset * 60000);
  return local.toISOString().slice(0, 16);
};

export interface MeetingDetails {
  attendees: string;
  context: string;
  meetingDate: string;
}

interface DetailsPageProps {
  audioMeta: AudioMeta | null;
  onSubmit: (details: MeetingDetails) => void;
}

export default function DetailsPage({ audioMeta, onSubmit }: DetailsPageProps) {
  const [attendees, setAttendees]     = useState('');
  const [context, setContext]         = useState('');
  const [meetingDate, setMeetingDate] = useState(localDatetimeValue());
  const [saving, setSaving]           = useState(false);
  const [saveError, setSaveError]     = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!attendees.trim()) return;
    setSaving(true);
    setSaveError(null);

    try {
      const mongoId = audioMeta?.mongoId;
      if (mongoId) {
        const backendUrl = import.meta.env.VITE_BACKEND_URL || '';
        const res = await fetch(`${backendUrl}/api/meetings/${mongoId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            attendees,
            context: context || null,
            meeting_date: meetingDate || null,
          }),
        });
        if (!res.ok) {
          const err = await res.text();
          throw new Error(err);
        }
      }
      onSubmit({ attendees, context, meetingDate });
    } catch (err) {
      console.error('Failed to save meeting details:', err);
      setSaveError('Could not save details — please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-eyebrow">
          <span className="eyebrow-dot" style={{ background: '#34d399' }} />
          <span className="eyebrow-text">Audio ready · Step 2 of 2</span>
        </div>
        <h1 className="card-title">Meeting Details</h1>
        <p className="card-desc">Provide context to help MoM-ai generate accurate minutes.</p>
      </div>

      <div className="card-body">
        {audioMeta?.uploadedFile && (
          <div className="file-chip" style={{ marginBottom: '1.25rem' }}>
            <div className="file-chip-icon">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 18V5l12-2v13" />
                <circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
              </svg>
            </div>
            <div className="file-chip-info">
              <span className="file-chip-name">{audioMeta.uploadedFile.name}</span>
              <span className="file-chip-meta">{formatFileSize(audioMeta.uploadedFile.size)}</span>
            </div>
            <span className="file-chip-badge">✓ Synced</span>
          </div>
        )}

        <form className="details-form" onSubmit={handleSubmit}>
          <div className="field">
            <label className="field-label" htmlFor="attendees">
              Attendees <span className="field-required">*</span>
            </label>
            <p className="field-hint">Names or roles of meeting participants.</p>
            <textarea
              id="attendees"
              className="field-textarea"
              placeholder="e.g. Rahul (PM), Priya (Design), Ankit (Engineering)"
              value={attendees}
              onChange={e => setAttendees(e.target.value)}
              rows={3}
              required
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="context">Meeting Context</label>
            <p className="field-hint">What was the meeting about? Any agenda items or key topics.</p>
            <textarea
              id="context"
              className="field-textarea"
              placeholder="e.g. Q3 sprint planning, product roadmap review, client onboarding…"
              value={context}
              onChange={e => setContext(e.target.value)}
              rows={4}
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="meetingDate">
              Meeting Date &amp; Time
            </label>
            <p className="field-hint">Defaults to now — adjust if this was a past meeting.</p>
            <div className="date-row">
              <input
                id="meetingDate"
                type="datetime-local"
                className="field-input"
                value={meetingDate}
                onChange={e => setMeetingDate(e.target.value)}
              />
              <button
                type="button"
                className="btn-reset-date"
                title="Reset to current time"
                onClick={() => setMeetingDate(localDatetimeValue())}
              >
                ↺ Now
              </button>
            </div>
          </div>

          {saveError && (
            <div className="status-block error">
              <span className="status-icon">✕</span>
              {saveError}
            </div>
          )}

          <button type="submit" className="btn btn-start" disabled={saving}>
            {saving ? (
              <>
                <div className="spinner"
                  style={{ borderColor: 'rgba(0,0,0,0.3)', borderTopColor: 'transparent' }} />
                Saving…
              </>
            ) : (
              <>
                Generate Minutes
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
