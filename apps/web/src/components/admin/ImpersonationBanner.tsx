/**
 * Non-dismissable banner shown while a staff member is impersonating a user.
 * One-click return restores the admin session. Always visible — there is no close.
 */
import { type JSX, useState } from 'react';

export function ImpersonationBanner({ byEmail, targetEmail, until }: {
  byEmail: string; targetEmail: string; until: number;
}): JSX.Element {
  const [leaving, setLeaving] = useState(false);
  const minsLeft = Math.max(0, Math.round((until - Date.now()) / 60000));

  async function stop() {
    setLeaving(true);
    try { await fetch('/api/admin/stop-impersonate', { method: 'POST' }); }
    finally { window.location.href = '/app/admin'; }
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '8px 16px',
      background: '#7c2d12', color: '#fed7aa', fontSize: 13, fontWeight: 500,
      borderBottom: '1px solid #9a3412',
    }}>
      <span style={{ display: 'inline-flex', width: 8, height: 8, borderRadius: 8, background: '#fb923c' }} />
      <span>
        Viewing as <strong style={{ color: '#fff' }}>{targetEmail}</strong> — impersonated by {byEmail}
        {minsLeft > 0 ? ` · ${minsLeft} min left` : ' · expiring'}
      </span>
      <button onClick={stop} disabled={leaving} style={{
        marginLeft: 'auto', fontSize: 12.5, fontWeight: 600, color: '#7c2d12', background: '#fed7aa',
        border: 'none', borderRadius: 7, padding: '4px 12px', cursor: 'pointer',
      }}>{leaving ? 'Returning…' : 'Return to admin'}</button>
    </div>
  );
}
