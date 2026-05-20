import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, X, Copy, Check } from 'lucide-react';
import { Button } from '../ui/Button';
import { MonoLabel } from '../ui/typography';
import { StatusPill } from '../ui/StatusPill';

interface PreviewStep {
  step_index: number;
  node_id: string;
  title: string;
  kind: string;
  instruction: string;
  content: string;
  content_type: string;
  source: { doc_id: string; doc_title: string } | null;
}

interface PreviewResponse {
  flow_id: string;
  flow_name: string;
  version_id: string;
  is_published: boolean;
  total_steps: number;
  steps: PreviewStep[];
}

interface Props {
  flowSlug: string;
  version: 'draft' | 'published';
  onClose: () => void;
}

export function WalkSimulator({ flowSlug, version, onClose }: Props) {
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentStep, setCurrentStep] = useState(0);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch(`/api/flows/${flowSlug}/preview?version=${version}`, {
      credentials: 'include',
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(await r.text());
        return r.json() as Promise<PreviewResponse>;
      })
      .then(setPreview)
      .catch((e: unknown) => setError(String((e as Error).message ?? e)));
  }, [flowSlug, version]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
      if (!preview) return;
      if (e.key === 'ArrowRight' && currentStep < preview.steps.length - 1) {
        setCurrentStep((s) => s + 1);
      }
      if (e.key === 'ArrowLeft' && currentStep > 0) {
        setCurrentStep((s) => s - 1);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [preview, currentStep, onClose]);

  function copyStep() {
    if (!preview) return;
    const step = preview.steps[currentStep];
    if (!step) return;
    const payload = step.content
      ? `## ${step.title}\n\n${step.instruction}\n\n---\n\n${step.content}`
      : `## ${step.title}\n\n${step.instruction}`;
    void navigator.clipboard.writeText(payload);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="fixed inset-0 z-50 bg-[var(--surface-base)]/80 backdrop-blur-sm flex items-center justify-center p-8">
      <div className="bg-[var(--surface-overlay)] border border-[var(--border-default)] rounded-[var(--radius-lg)] w-full max-w-3xl max-h-[85vh] flex flex-col [box-shadow:var(--shadow-lg)]">
        <div className="flex items-center justify-between px-6 h-14 border-b border-[var(--border-subtle)]">
          <div className="flex items-center gap-3">
            <MonoLabel>Walk this flow</MonoLabel>
            <h2 className="text-[14px] font-medium text-[var(--text-primary)]">
              {preview?.flow_name ?? flowSlug}
            </h2>
            {preview && (
              <StatusPill tone="neutral">
                Step {currentStep + 1} of {preview.total_steps}
              </StatusPill>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
            aria-label="Close walk simulator"
          >
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-6">
          {error ? (
            <div className="text-center py-12">
              <p className="text-[14px] text-[var(--status-error)] mb-2">
                Couldn't load preview
              </p>
              <code className="text-[12px] font-mono text-[var(--text-tertiary)]">{error}</code>
            </div>
          ) : !preview ? (
            <div className="text-center py-12">
              <p className="text-[13px] text-[var(--text-tertiary)]">Loading preview…</p>
            </div>
          ) : preview.steps.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-[13px] text-[var(--text-tertiary)]">
                This flow has no steps to walk yet.
              </p>
            </div>
          ) : (
            <StepView step={preview.steps[currentStep]!} />
          )}
        </div>

        {preview && preview.steps.length > 0 && (
          <div className="flex items-center justify-between px-6 h-14 border-t border-[var(--border-subtle)]">
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setCurrentStep((s) => Math.max(0, s - 1))}
                disabled={currentStep === 0}
              >
                <ChevronLeft size={12} strokeWidth={2} />
                Previous
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  setCurrentStep((s) => Math.min(preview.steps.length - 1, s + 1))
                }
                disabled={currentStep >= preview.steps.length - 1}
              >
                Next
                <ChevronRight size={12} strokeWidth={2} />
              </Button>
            </div>
            <Button variant="ghost" size="sm" onClick={copyStep}>
              {copied ? (
                <>
                  <Check size={12} strokeWidth={2} className="text-[var(--status-success)]" />
                  Copied
                </>
              ) : (
                <>
                  <Copy size={12} strokeWidth={2} />
                  Copy step
                </>
              )}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function StepView({ step }: { step: PreviewStep }) {
  return (
    <div>
      <MonoLabel className="block mb-1.5">
        Step {step.step_index} · {step.kind}
      </MonoLabel>
      <h3 className="text-[18px] font-medium text-[var(--text-primary)] mb-4 leading-[1.3]">
        {step.title}
      </h3>

      {step.instruction && (
        <div className="mb-6 p-4 bg-[var(--surface-sunken)] border border-[var(--border-subtle)] rounded-[var(--radius-md)]">
          <MonoLabel className="block mb-1.5">Instruction (read first)</MonoLabel>
          <p className="text-[13px] leading-[1.65] text-[var(--text-primary)] italic">
            {step.instruction}
          </p>
        </div>
      )}

      {step.content && (
        <div>
          <MonoLabel className="block mb-1.5">Content</MonoLabel>
          <div className="text-[13px] leading-[1.7] text-[var(--text-secondary)] whitespace-pre-wrap font-sans">
            {step.content}
          </div>
          {step.source && (
            <p className="mt-4 text-[11px] text-[var(--text-tertiary)] font-mono">
              source: {step.source.doc_title}
            </p>
          )}
        </div>
      )}

      {!step.content && step.kind !== 'instruction' && (
        <p className="text-[13px] text-[var(--text-quaternary)] italic">
          No content rendered for this step.
        </p>
      )}
    </div>
  );
}
