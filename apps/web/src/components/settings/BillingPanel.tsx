import { type JSX, useEffect, useState } from 'react';

interface BillingState {
  plan: 'free' | 'pro' | 'team';
  subscription_status: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  has_razorpay_customer: boolean;
  // STRIPE: ENABLE WHEN APPROVED
  // has_stripe_customer: boolean;
}

export function BillingPanel(): JSX.Element {
  const [state, setState] = useState<BillingState | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [upgrading, setUpgrading] = useState(false);

  // Detect return from Razorpay hosted checkout
  const checkoutSuccess =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('checkout') === 'success';

  useEffect(() => {
    void (async () => {
      const response = await fetch('/api/billing/current', { credentials: 'include' });
      if (response.ok) setState(await response.json() as BillingState);
    })();
  }, []);

  // Clean up ?checkout=success from URL after displaying the banner
  useEffect(() => {
    if (checkoutSuccess && typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.delete('checkout');
      window.history.replaceState({}, '', url.toString());
    }
  }, [checkoutSuccess]);

  async function startUpgrade(planKey: 'pro' | 'team'): Promise<void> {
    setUpgrading(true);
    try {
      const response = await fetch('/api/billing/subscribe', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan_key: planKey }),
      });
      const body = await response.json() as { short_url?: string; subscription_id?: string; error?: string };
      if (body.short_url) {
        // Redirect to Razorpay hosted checkout page.
        // After payment Razorpay will redirect back to /app/settings/billing?checkout=success.
        window.location.href = body.short_url;
      } else {
        alert(body.error ?? 'Could not start checkout. Please try again or email support@theboringpeople.in.');
        setUpgrading(false);
      }
    } catch {
      alert('Network error. Please check your connection and try again.');
      setUpgrading(false);
    }
  }

  async function cancelSubscription(): Promise<void> {
    if (!confirm('Cancel your subscription at the end of the current billing period?')) return;
    setCancelling(true);
    try {
      const response = await fetch('/api/billing/cancel', { method: 'POST', credentials: 'include' });
      const body = await response.json() as { cancelled?: boolean; error?: string };
      if (body.cancelled) {
        setState((prev) => prev ? { ...prev, cancel_at_period_end: true } : prev);
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
  // Use the server-sourced cancel_at_period_end flag (survives page reloads)
  const isCancelPending = state.cancel_at_period_end;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>

      {/* Checkout success banner */}
      {checkoutSuccess && (
        <div style={{
          padding: '0.875rem 1rem',
          borderRadius: '0.5rem',
          background: 'var(--surface-overlay)',
          border: '1px solid var(--border-default)',
          fontSize: '0.875rem',
          color: 'var(--text-primary)',
        }}>
          🎉 Payment received — your subscription is activating. This may take a moment to reflect below.
        </div>
      )}

      {/* Current plan card */}
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
          {state.subscription_status && !['active', 'created', null].includes(state.subscription_status) && (
            <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
              ({state.subscription_status})
            </span>
          )}
        </div>
        {state.current_period_end && (
          <p style={{ marginTop: '0.5rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
            {isCancelPending
              ? `Active until ${new Date(state.current_period_end).toLocaleDateString()}.`
              : `Renews on ${new Date(state.current_period_end).toLocaleDateString()}.`}
          </p>
        )}
      </section>

      {/* Actions */}
      {state.plan === 'free' ? (
        <section>
          <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
            Upgrade for AI autocomplete, larger workspaces, and higher MCP call limits.
          </p>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => void startUpgrade('pro')}
              disabled={upgrading}
              style={{
                padding: '0.5rem 1.25rem',
                borderRadius: '0.375rem',
                background: 'var(--interactive-primary)',
                color: 'var(--interactive-primary-fg)',
                fontWeight: 500,
                fontSize: '0.875rem',
                border: 'none',
                cursor: upgrading ? 'wait' : 'pointer',
                opacity: upgrading ? 0.6 : 1,
              }}
            >
              {upgrading ? 'Redirecting to checkout…' : 'Upgrade to Pro — $15 / seat / mo'}
            </button>
            <a
              href="mailto:hello@theboringpeople.in"
              style={{
                padding: '0.5rem 1.25rem',
                borderRadius: '0.375rem',
                border: '1px solid var(--border-default)',
                color: 'var(--text-primary)',
                fontWeight: 500,
                fontSize: '0.875rem',
                textDecoration: 'none',
                background: 'transparent',
              }}
            >
              Team plan →
            </a>
          </div>
        </section>
      ) : (
        <section>
          {isCancelPending ? (
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
                  fontSize: '0.875rem',
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
