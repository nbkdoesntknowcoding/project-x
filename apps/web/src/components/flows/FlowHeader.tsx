import { Play, ArrowLeft, Clock, CheckCircle, AlertCircle, Loader2, Save } from 'lucide-react';
import { Button } from '../ui/Button';
import { StatusPill } from '../ui/StatusPill';
import { MonoLabel } from '../ui/typography';
import type { Flow } from './FlowCanvas';
import { relativeTime } from '../../lib/relative-time';

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

interface Props {
  flow: Flow;
  onWalkClick: () => void;
  // Editor props
  saveState: SaveState;
  isDirty: boolean;
  onSaveNow: () => void;
  lastSavedAt: Date | null;
  hasUnpublishedChanges: boolean;
  historyOpen: boolean;
  onHistoryToggle: () => void;
  onPublishClick: () => void;
}

export function FlowHeader({
  flow,
  onWalkClick,
  saveState,
  isDirty,
  onSaveNow,
  lastSavedAt,
  hasUnpublishedChanges,
  historyOpen,
  onHistoryToggle,
  onPublishClick,
}: Props) {
  return (
    <div className="shrink-0 bg-[var(--surface)] border-b border-[var(--line)] z-10">
      <div className="flex items-center justify-between px-6 h-14">
        <div className="flex items-center gap-4">
          <a
            href="/app/flows"
            className="flex items-center gap-1.5 text-[13px] text-[var(--ink-muted)] hover:text-[var(--ink)] transition-colors"
          >
            <ArrowLeft size={14} strokeWidth={1.75} />
            All flows
          </a>
          <div className="h-4 w-px bg-[var(--line-strong)]" />
          <div className="flex items-center gap-3">
            <h1 className="text-[14px] font-medium text-[var(--ink)]">{flow.name}</h1>
            {flow.is_published ? (
              <StatusPill tone="success">Published</StatusPill>
            ) : (
              <StatusPill tone="neutral">Draft</StatusPill>
            )}
            {hasUnpublishedChanges && (
              <StatusPill tone="warning">Unsaved changes</StatusPill>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Save state indicator */}
          <div className="flex items-center gap-1.5 text-[12px]">
            {saveState === 'saving' && (
              <span className="flex items-center gap-1 text-[var(--ink-muted)]">
                <Loader2 size={11} strokeWidth={1.75} className="animate-spin" />
                Saving…
              </span>
            )}
            {saveState === 'saved' && lastSavedAt && (
              <span className="flex items-center gap-1 text-[var(--ink-muted)]">
                <CheckCircle size={11} strokeWidth={1.75} className="text-[var(--status-success)]" />
                Saved {relativeTime(lastSavedAt)}
              </span>
            )}
            {saveState === 'error' && (
              <span className="flex items-center gap-1 text-[var(--status-error)]">
                <AlertCircle size={11} strokeWidth={1.75} />
                Save failed
              </span>
            )}
          </div>

          <Button
            variant="secondary"
            size="sm"
            onClick={onSaveNow}
            disabled={!isDirty || saveState === 'saving'}
            title="Save draft now"
          >
            <Save size={12} strokeWidth={1.75} />
            Save
          </Button>

          <Button
            variant="secondary"
            size="sm"
            onClick={onWalkClick}
            disabled={!flow.is_published}
          >
            <Play size={12} strokeWidth={2} />
            Walk
          </Button>

          <Button
            variant={historyOpen ? 'primary' : 'secondary'}
            size="sm"
            onClick={onHistoryToggle}
            title="Version history"
          >
            <Clock size={12} strokeWidth={1.75} />
            History
          </Button>

          <Button
            variant="primary"
            size="sm"
            onClick={onPublishClick}
            disabled={!hasUnpublishedChanges && flow.is_published}
          >
            Publish
          </Button>
        </div>
      </div>

      {flow.description && (
        <div className="px-6 pb-3 text-[12px] text-[var(--ink-muted)] leading-[1.5] max-w-3xl">
          {flow.description}
        </div>
      )}
    </div>
  );
}
