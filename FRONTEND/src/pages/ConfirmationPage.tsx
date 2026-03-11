import { MeetingDetails } from './DetailsPage';

interface ConfirmationPageProps {
  details: MeetingDetails;
  onHome: () => void;
}

export default function ConfirmationPage({ details, onHome }: ConfirmationPageProps) {
  const displayDate = details.meetingDate
    ? new Date(details.meetingDate).toLocaleString('en-IN', {
      dateStyle: 'long', timeStyle: 'short'
    })
    : '—';

  return (
    <div className="card">
      <div className="confirm-body">
        <div className="confirm-icon-wrap">
          <div className="confirm-icon">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
        </div>

        <h2 className="confirm-title">Your MOM will be generated shortly.</h2>
        <p className="confirm-desc">
          We've received your audio and meeting details. Minutes of the Meeting
          will be ready soon and delivered to your workspace.
        </p>

        <div className="confirm-meta">
          <div className="confirm-meta-item">
            <span className="confirm-meta-label">Attendees</span>
            <span className="confirm-meta-value">{details.attendees}</span>
          </div>
          {details.context && (
            <div className="confirm-meta-item">
              <span className="confirm-meta-label">Context</span>
              <span className="confirm-meta-value">{details.context}</span>
            </div>
          )}
          <div className="confirm-meta-item">
            <span className="confirm-meta-label">Meeting Date</span>
            <span className="confirm-meta-value">{displayDate}</span>
          </div>
          <div className="confirm-meta-item">
            <span className="confirm-meta-label">Speakers</span>
            <span className="confirm-meta-value">{details.numberOfSpeakers}</span>
          </div>
        </div>

        <button className="btn btn-home" onClick={onHome}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <polyline points="9 22 9 12 15 12 15 22" />
          </svg>
          Return to Home
        </button>
      </div>
    </div>
  );
}
