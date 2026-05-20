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
    <div className="absolute top-0 left-0 right-0 z-10 bg-[var(--surface-base)]/80 backdrop-blur-sm border-b border-[var(--border-subtle)]">
      <div className="flex items-center justify-between px-6 h-14">
        <div className="flex items-center gap-4">
          <a
            href="/app/flows"
            className="flex items-center gap-1.5 text-[13px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
          >
            <ArrowLeft size={14} strokeWidth={1.75} />
            All flows
          </a>
          <div className="h-4 w-px bg-[var(--border-default)]" />
          <div className="flex items-center gap-3">
            <h1 className="text-[14px] font-medium text-[var(--text-primary)]">{flow.name}</h1>
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
              <span className="flex items-center gap-1 text-[var(--text-tertiary)]">
                <Loader2 size={11} strokeWidth={1.75} className="animate-spin" />
                Saving…
              </span>
            )}
            {saveState === 'saved' && lastSavedAt && (
              <span className="flex items-center gap-1 text-[var(--text-tertiary)]">
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
        <div className="px-6 pb-3 text-[12px] text-[var(--text-tertiary)] leading-[1.5] max-w-3xl">
          {flow.description}
        </div>
      )}
    </div>
  );
}
