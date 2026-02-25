import { useState } from 'react';
import RecorderPage, { AudioMeta } from './RecorderPage';
import DetailsPage, { MeetingDetails } from './DetailsPage';
import ConfirmationPage from './ConfirmationPage';

const PAGES = { RECORDER: 'recorder', DETAILS: 'details', CONFIRM: 'confirm' } as const;
type Page = typeof PAGES[keyof typeof PAGES];

const stepLabels = ['Record', 'Details', 'Done'];

export default function Index() {
  const [page, setPage]           = useState<Page>(PAGES.RECORDER);
  const [audioMeta, setAudioMeta] = useState<AudioMeta | null>(null);
  const [details, setDetails]     = useState<MeetingDetails | null>(null);

  const stepIndex = page === PAGES.RECORDER ? 0 : page === PAGES.DETAILS ? 1 : 2;

  return (
    <div className="shell">
      {/* Topbar */}
      <header className="topbar">
        <a className="topbar-brand" href="#">
          <div className="topbar-logo">◎</div>
          <span className="topbar-name">MoM-ai</span>
        </a>

        <div className="topbar-steps">
          {stepLabels.map((label, i) => (
            <div
              key={label}
              className={`step-item ${i === stepIndex ? 'active' : ''} ${i < stepIndex ? 'done' : ''}`}
            >
              <div className="step-dot">{i < stepIndex ? '✓' : i + 1}</div>
              <span className="step-label">{label}</span>
              {i < stepLabels.length - 1 && <div className="step-line" />}
            </div>
          ))}
        </div>

        <div className="topbar-right">
          <div className="topbar-badge">INT.</div>
        </div>
      </header>

      {/* Main */}
      <main className="main">
        {page === PAGES.RECORDER && (
          <RecorderPage
            onAudioReady={(meta) => { setAudioMeta(meta); setPage(PAGES.DETAILS); }}
          />
        )}
        {page === PAGES.DETAILS && (
          <DetailsPage
            audioMeta={audioMeta}
            onSubmit={(det) => { setDetails(det); setPage(PAGES.CONFIRM); }}
          />
        )}
        {page === PAGES.CONFIRM && details && (
          <ConfirmationPage
            details={details}
            onHome={() => { setPage(PAGES.RECORDER); setAudioMeta(null); setDetails(null); }}
          />
        )}
      </main>

      {/* Footer */}
      <footer>
        <span className="footer-text">© 2026 MoM-ai · All rights reserved</span>
      </footer>
    </div>
  );
}
