import './sidebar.css';

interface Props {
  workspaceName: string;
  currentPath: string;
  workspaceMode?: string;
  typeCounts?: {
    doc?: number;
    engineering?: number;
    instruction?: number;
    snippet?: number;
  };
}

export function Sidebar({ currentPath, workspaceMode, typeCounts = {} }: Props) {
  const typeParam = currentPath.includes('?')
    ? new URLSearchParams(currentPath.split('?')[1]).get('type')
    : null;

  const isOnContent =
    currentPath === '/app/content' || currentPath.startsWith('/app/content');
  const isOnFlows = currentPath.startsWith('/app/flows');
  const isOnClaude = currentPath === '/app/connections/claude';
  const isOnDrive = currentPath === '/app/connections/drive';
  const isOnKanban    = currentPath.startsWith('/app/kanban');
  const isOnSessions  = currentPath.startsWith('/app/sessions');
  const isOnCost      = currentPath.startsWith('/app/cost');
  const isOnOptimize  = currentPath.startsWith('/app/optimize');
  const isOnTeam      = currentPath.startsWith('/app/team');

  const isDevProject = workspaceMode === 'dev_project';

  const showEng = (typeCounts.engineering ?? 0) > 0;
  const showInst = (typeCounts.instruction ?? 0) > 0;
  const showSnip = (typeCounts.snippet ?? 0) > 0;

  const totalDocs =
    (typeCounts.doc ?? 0) +
    (typeCounts.engineering ?? 0) +
    (typeCounts.instruction ?? 0) +
    (typeCounts.snippet ?? 0);

  return (
    <aside className="sb-aside">

      {/* ── CONTENT ──────────────────────────────── */}
      <div className="sb-section">
        <div className="sb-section-head"><span>Content</span></div>

        <a
          href="/app/content"
          className={`sb-row${isOnContent && !typeParam ? ' active' : ''}`}
        >
          <span className="sb-l">
            <span className="sb-icon">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
              </svg>
            </span>
            <span className="sb-label">All docs</span>
          </span>
          {totalDocs > 0 && <span className="sb-count">{totalDocs}</span>}
        </a>

        {showEng && (
          <a
            href="/app/content?type=engineering"
            className={`sb-row indent-1${typeParam === 'engineering' ? ' active' : ''}`}
          >
            <span className="sb-l">
              <span className="sb-icon">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
                </svg>
              </span>
              <span className="sb-label">Engineering</span>
            </span>
            <span className="sb-count">{typeCounts.engineering}</span>
          </a>
        )}

        {showInst && (
          <a
            href="/app/content?type=instruction"
            className={`sb-row indent-1${typeParam === 'instruction' ? ' active' : ''}`}
          >
            <span className="sb-l">
              <span className="sb-icon">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                </svg>
              </span>
              <span className="sb-label">Instructions</span>
            </span>
            <span className="sb-count">{typeCounts.instruction}</span>
          </a>
        )}

        {showSnip && (
          <a
            href="/app/content?type=snippet"
            className={`sb-row indent-1${typeParam === 'snippet' ? ' active' : ''}`}
          >
            <span className="sb-l">
              <span className="sb-icon">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="10" x2="14" y2="10"/><line x1="4" y1="14" x2="18" y2="14"/><line x1="4" y1="18" x2="12" y2="18"/>
                </svg>
              </span>
              <span className="sb-label">Snippets</span>
            </span>
            <span className="sb-count">{typeCounts.snippet}</span>
          </a>
        )}
      </div>

      {/* ── FLOWS ────────────────────────────────── */}
      <div className="sb-section">
        <div className="sb-section-head"><span>Flows</span></div>

        <a
          href="/app/flows"
          className={`sb-row${isOnFlows ? ' active' : ''}`}
        >
          <span className="sb-l">
            <span className="sb-icon">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="3" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/>
                <path d="M6 9v3a3 3 0 0 0 3 3h3M15 6h-3"/><path d="M18 15v-3"/>
              </svg>
            </span>
            <span className="sb-label">All flows</span>
          </span>
        </a>
      </div>

      {/* ── DEV (dev_project workspaces only) ───── */}
      {isDevProject && (
        <div className="sb-section">
          <div className="sb-section-head"><span>Dev</span></div>

          <a href="/app/kanban" className={`sb-row${isOnKanban ? ' active' : ''}`}>
            <span className="sb-l">
              <span className="sb-icon">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="5" height="18" rx="1"/>
                  <rect x="10" y="3" width="5" height="13" rx="1"/>
                  <rect x="17" y="3" width="5" height="9" rx="1"/>
                </svg>
              </span>
              <span className="sb-label">Kanban</span>
            </span>
          </a>

          <a href="/app/sessions" className={`sb-row${isOnSessions ? ' active' : ''}`}>
            <span className="sb-l">
              <span className="sb-icon">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 15"/>
                </svg>
              </span>
              <span className="sb-label">Sessions</span>
            </span>
          </a>

          <a href="/app/cost" className={`sb-row${isOnCost ? ' active' : ''}`}>
            <span className="sb-l">
              <span className="sb-icon">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
                </svg>
              </span>
              <span className="sb-label">Cost</span>
            </span>
          </a>

          <a href="/app/optimize" className={`sb-row${isOnOptimize ? ' active' : ''}`}>
            <span className="sb-l">
              <span className="sb-icon">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
                </svg>
              </span>
              <span className="sb-label">Optimize</span>
            </span>
          </a>

          <a href="/app/team" className={`sb-row${isOnTeam ? ' active' : ''}`}>
            <span className="sb-l">
              <span className="sb-icon">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                </svg>
              </span>
              <span className="sb-label">Team</span>
            </span>
          </a>
        </div>
      )}

      {/* ── CONNECTIONS ──────────────────────────── */}
      <div className="sb-section">
        <div className="sb-section-head"><span>Connections</span></div>

        <a
          href="/app/connections/claude"
          className={`sb-row${isOnClaude ? ' active' : ''}`}
        >
          <span className="sb-l">
            <span className="sb-icon">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5"/>
              </svg>
            </span>
            <span className="sb-label">Claude</span>
          </span>
        </a>

        <a
          href="/app/connections/drive"
          className={`sb-row${isOnDrive ? ' active' : ''}`}
        >
          <span className="sb-l">
            <span className="sb-icon">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>
              </svg>
            </span>
            <span className="sb-label">Google Drive</span>
          </span>
        </a>
      </div>

      {/* ── FOOTER ───────────────────────────────── */}
      <div className="sb-foot">
        <span>MCP usage</span>
        <span><span className="sb-v">—</span></span>
      </div>

    </aside>
  );
}
