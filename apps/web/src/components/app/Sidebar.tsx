import {
  ChevronDown,
  Code,
  CreditCard,
  FileText,
  HardDrive,
  Hash,
  MessageSquare,
  Plug,
  Settings,
  Users,
  Workflow,
} from 'lucide-react';
import { MonoLabel } from '../ui/typography';
import { SidebarItem } from './SidebarItem';

interface Props {
  workspaceName: string;
  /** The current URL pathname — drives the active highlight server-side. */
  currentPath: string;
  /**
   * Per-type doc counts. Filter chips (Engineering / Instructions / Snippets)
   * only render for types that have at least one doc — keeps the sidebar
   * honest about what's in the workspace right now.
   */
  typeCounts?: {
    doc?: number;
    engineering?: number;
    instruction?: number;
    snippet?: number;
  };
}

/**
 * Phase 5 in-app sidebar.
 *
 * Three labeled regions (not collapsible accordions — they're sections),
 * each preceded by a MonoLabel header:
 *
 *   CONTENT     all docs, plus optional type filters
 *   FLOWS       all flows (empty placeholder until Phase 6 ships)
 *   CONNECTIONS Claude (live), Google Drive (Phase 10 placeholder)
 *
 * Plus a footer group with Settings / Members / Billing.
 *
 * The IA is the load-bearing change for Phase 5 — Content lives next to
 * Flows lives next to Connections, signaling that Mnema is a context
 * engine, not a doc editor with an MCP plugin.
 */
export function Sidebar({ workspaceName, currentPath, typeCounts = {} }: Props) {
  // Active resolver. The doc editor lives under /app/content/<id> so we
  // highlight "All docs" for any /app/content/* path that isn't a typed view.
  const isOnContent =
    currentPath === '/app/content' || currentPath.startsWith('/app/content');
  const typeParam = new URLSearchParams(
    currentPath.includes('?') ? currentPath.split('?')[1] : '',
  ).get('type');

  const showEng = (typeCounts.engineering ?? 0) > 0;
  const showInst = (typeCounts.instruction ?? 0) > 0;
  const showSnip = (typeCounts.snippet ?? 0) > 0;

  return (
    <aside
      className="w-60 h-screen flex flex-col flex-shrink-0"
      style={{
        background: 'var(--surface-base)',
        borderRight: '1px solid var(--border-subtle)',
      }}
    >
      {/* Workspace switcher row */}
      <div
        className="px-3 h-12 flex items-center"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
      >
        <button
          type="button"
          className="flex items-center gap-2 text-[14px] font-medium"
          style={{ color: 'var(--text-primary)' }}
        >
          <span className="truncate max-w-[160px]">{workspaceName}</span>
          <ChevronDown size={14} style={{ color: 'var(--text-tertiary)' }} />
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto py-4 px-2 space-y-6">
        {/* === CONTENT === */}
        <section>
          <div className="px-2 mb-2">
            <MonoLabel>Content</MonoLabel>
          </div>
          <SidebarItem
            icon={<FileText size={14} />}
            label="All docs"
            href="/app/content"
            active={isOnContent && !typeParam}
          />
          {showEng && (
            <SidebarItem
              icon={<Code size={14} />}
              label="Engineering"
              href="/app/content?type=engineering"
              indent
              active={typeParam === 'engineering'}
            />
          )}
          {showInst && (
            <SidebarItem
              icon={<MessageSquare size={14} />}
              label="Instructions"
              href="/app/content?type=instruction"
              indent
              active={typeParam === 'instruction'}
            />
          )}
          {showSnip && (
            <SidebarItem
              icon={<Hash size={14} />}
              label="Snippets"
              href="/app/content?type=snippet"
              indent
              active={typeParam === 'snippet'}
            />
          )}
        </section>

        {/* === FLOWS === */}
        <section>
          <div className="px-2 mb-2">
            <MonoLabel>Flows</MonoLabel>
          </div>
          <SidebarItem
            icon={<Workflow size={14} />}
            label="All flows"
            href="/app/flows"
            active={currentPath.startsWith('/app/flows')}
          />
        </section>

        {/* === CONNECTIONS === */}
        <section>
          <div className="px-2 mb-2">
            <MonoLabel>Connections</MonoLabel>
          </div>
          <SidebarItem
            icon={<Plug size={14} />}
            label="Claude"
            href="/app/connections/claude"
            active={currentPath === '/app/connections/claude'}
          />
          <SidebarItem
            icon={<HardDrive size={14} />}
            label="Google Drive"
            href="/app/connections/drive"
            active={currentPath === '/app/connections/drive'}
          />
        </section>
      </nav>

      {/* Footer — admin items */}
      <div
        className="py-2 px-2"
        style={{ borderTop: '1px solid var(--border-subtle)' }}
      >
        <SidebarItem
          icon={<Settings size={14} />}
          label="Settings"
          href="/app/settings"
          active={currentPath === '/app/settings'}
        />
        <SidebarItem
          icon={<Users size={14} />}
          label="Members"
          href="/app/settings/members"
          active={currentPath === '/app/settings/members'}
        />
        <SidebarItem
          icon={<CreditCard size={14} />}
          label="Billing"
          href="/app/settings/billing"
          active={currentPath === '/app/settings/billing'}
        />
      </div>
    </aside>
  );
}
