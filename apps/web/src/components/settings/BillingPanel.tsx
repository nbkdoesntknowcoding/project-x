import { useEffect, useState } from 'react';

interface BillingState {
  plan: 'free' | 'pro' | 'team';
  subscription_status: string | null;
  current_period_end: string | null;
  has_razorpay_customer: boolean;
  // STRIPE: ENABLE WHEN APPROVED
  // has_stripe_customer: boolean;
}

export function BillingPanel(): JSX.Element {
  const [state, setState] = useState<BillingState | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelled, setCancelled] = useState(false);

  useEffect(() => {
    void (async () => {
      const response = await fetch('/api/billing/current', { credentials: 'include' });
      if (response.ok) setState(await response.json() as BillingState);
    })();
  }, []);

  async function cancelSubscription(): Promise<void> {
    if (!confirm('Cancel your subscription at the end of the current billing period?')) return;
    setCancelling(true);
    try {
      const response = await fetch('/api/billing/cancel', { method: 'POST', credentials: 'include' });
      const body = await response.json() as { cancelled?: boolean; error?: string };
      if (body.cancelled) {
        setCancelled(true);
        setState((prev) => prev ? { ...prev, subscription_status: 'pending_cancel' } : prev);
      } else {
        alert(body.error ?? 'Could not cancel subscription. Email support@theboringpeople.in for help.');
      }
    } finally {
      setCancelling(false);
    }
  }

  // STRIPE: ENABLE WHEN APPROVED
  // async function openPortal(): Promise<void> {
  //   const response = await fetch('/api/billing/portal', { method: 'POST', credentials: 'include' });
  //   const body = await response.json() as { url?: string; error?: string };
  //   if (body.url) window.location.href = body.url;
  //   else alert(body.error ?? 'Could not open billing portal.');
  // }

  if (!state) return <div style={{ color: 'var(--text-tertiary)', fontSize: '0.875rem' }}>Loading…</div>;

  const planLabel = state.plan === 'free' ? 'Free' : state.plan === 'pro' ? 'Pro' : 'Team';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <section style={{
        padding: '1.25rem',
        borderRadius: '0.5rem',
        border: '1px solid var(--border-default)',
        background: 'var(--surface-overlay)',
      }}>
        <div style={{ fontSize: '0.75rem', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-tertiary)', marginBottom: '0.5rem' }}>
          Current plan
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem' }}>
          <span style={{ fontSize: '1.5rem', fontWeight: 500, color: 'var(--text-primary)' }}>
            {planLabel}
          </span>
          {state.subscription_status && !['active', null].includes(state.subscription_status) && (
            <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
              ({state.subscription_status})
            </span>
          )}
        </div>
        {state.current_period_end && (
          <p style={{ marginTop: '0.5rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
            {state.subscription_status === 'pending_cancel'
              ? `Active until ${new Date(state.current_period_end).toLocaleDateString()}.`
              : `Renews on ${new Date(state.current_period_end).toLocaleDateString()}.`}
          </p>
        )}
      </section>

      {state.plan === 'free' ? (
        <section>
          <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
            Upgrade for autocomplete, larger workspaces, and higher MCP call limits.
          </p>
          <a
            href="/pricing"
            style={{
              display: 'inline-block',
              padding: '0.5rem 1rem',
              borderRadius: '0.375rem',
              background: 'var(--accent)',
              color: 'white',
              fontWeight: 500,
              textDecoration: 'none',
            }}
          >
            View plans
          </a>
        </section>
      ) : (
        <section>
          {cancelled || state.subscription_status === 'pending_cancel' ? (
            <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
              Your subscription will not renew. You retain access until the end of the billing period.
            </p>
          ) : (
            <>
              <button
                type="button"
                onClick={cancelSubscription}
                disabled={cancelling}
                style={{
                  padding: '0.5rem 1rem',
                  borderRadius: '0.375rem',
                  border: '1px solid var(--border-default)',
                  color: 'var(--text-primary)',
                  background: 'transparent',
                  cursor: cancelling ? 'wait' : 'pointer',
                  opacity: cancelling ? 0.5 : 1,
                }}
              >
                {cancelling ? 'Cancelling…' : 'Cancel subscription'}
              </button>
              <p style={{ marginTop: '0.75rem', fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                Cancels at end of billing period. For payment method changes, email{' '}
                <a href="mailto:support@theboringpeople.in" style={{ color: 'inherit', textDecoration: 'underline' }}>
                  support@theboringpeople.in
                </a>.
              </p>
            </>
          )}
        </section>
      )}
    </div>
  );
}
