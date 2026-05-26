import { type JSX, useEffect, useRef, useState } from 'react';
import { TIERS } from '../../lib/pricing';
import type { BillingCycle, Currency } from '../../lib/pricing';

type PlanSlug = 'individual' | 'team' | 'business';

interface BillingStatus {
  plan: string;
  subscription_status: string | null;
  plan_slug: string | null;
  cycle: BillingCycle;
  currency: Currency;
  billable_seats: number;
  writer_seats: number;
  reader_seats: number;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  prices: {
    monthly_usd: number;
    annual_usd: number;
    monthly_inr: number;
    annual_inr: number;
  } | null;
  detected_currency: Currency;
}

interface Invoice {
  id: string;
  date: string | null;
  description: string;
  amount_paid: number;   // paise or cents
  amount_due: number;
  currency: string;
  status: string;
  download_url: string | null;
}

// Tier rank for upgrade / downgrade labelling
const TIER_RANK: Record<string, number> = { free: 0, individual: 1, team: 2, business: 3 };

const PAID_PLAN_SLUGS: PlanSlug[] = ['individual', 'team', 'business'];

function formatAmount(paise: number, currency: string): string {
  // Razorpay amounts are in smallest unit (paise for INR, cents for USD)
  const amount = paise / 100;
  if (currency === 'INR' || currency === 'inr') {
    return `₹${amount.toLocaleString('en-IN')}`;
  }
  return `$${amount.toFixed(2)}`;
}

function formatPrice(amount: number, currency: Currency): string {
  if (currency === 'INR') return `₹${amount.toLocaleString('en-IN')}`;
  return `$${amount}`;
}

function StatusBadge({ status }: { status: string }): JSX.Element {
  const map: Record<string, { label: string; color: string; bg: string }> = {
    active:    { label: 'Active',      color: '#4ade80', bg: 'rgba(74,222,128,0.12)' },
    created:   { label: 'Active',      color: '#4ade80', bg: 'rgba(74,222,128,0.12)' },
    trialing:  { label: 'Trial',       color: '#60a5fa', bg: 'rgba(96,165,250,0.12)' },
    halted:    { label: 'Past due',    color: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
    cancelled: { label: 'Cancelled',   color: '#f87171', bg: 'rgba(248,113,113,0.12)' },
    expired:   { label: 'Expired',     color: '#f87171', bg: 'rgba(248,113,113,0.12)' },
    pending:   { label: 'Pending',     color: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
    cancelling:{ label: 'Cancelling',  color: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
  };
  const style = map[status] ?? { label: status, color: 'rgba(255,255,255,0.55)', bg: 'rgba(255,255,255,0.07)' };
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: 6,
      fontSize: '0.6875rem',
      fontWeight: 600,
      letterSpacing: '0.05em',
      textTransform: 'uppercase',
      background: style.bg,
      color: style.color,
    }}>
      {style.label}
    </span>
  );
}

function InvoiceStatusBadge({ status }: { status: string }): JSX.Element {
  const paid = status === 'paid';
  const failed = status === 'cancelled' || status === 'expired';
  const color = paid ? '#4ade80' : failed ? '#f87171' : '#f59e0b';
  const bg = paid ? 'rgba(74,222,128,0.12)' : failed ? 'rgba(248,113,113,0.12)' : 'rgba(245,158,11,0.12)';
  const label = paid ? 'Paid' : failed ? 'Failed' : 'Pending';
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: 6,
      fontSize: '0.6875rem',
      fontWeight: 600,
      letterSpacing: '0.05em',
      textTransform: 'uppercase',
      background: bg,
      color,
    }}>
      {label}
    </span>
  );
}

const cardStyle = {
  padding: '1.25rem',
  borderRadius: '0.5rem',
  border: '1px solid var(--border-default)',
  background: 'var(--surface-overlay)',
} satisfies React.CSSProperties;

const sectionHeaderStyle = {
  fontSize: '0.6875rem',
  fontWeight: 600,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.08em',
  color: 'var(--text-tertiary)',
  marginBottom: '0.75rem',
};

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────
export function BillingPanel(): JSX.Element {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [invoicesLoading, setInvoicesLoading] = useState(false);
  const [cycle, setCycle] = useState<BillingCycle>('monthly');
  const [currency, setCurrency] = useState<Currency>('INR');
  const [cancelling, setCancelling] = useState(false);
  const [changingPlan, setChangingPlan] = useState<PlanSlug | null>(null);
  const [updatingPayment, setUpdatingPayment] = useState(false);
  const autoTriggered = useRef(false);

  // Detect return from Razorpay hosted checkout
  const checkoutSuccess =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('checkout') === 'success';

  // Read ?upgrade=PLAN&cycle=CYCLE — set by pricing page CTA after post-login redirect
  const upgradeParam =
    typeof window !== 'undefined'
      ? (new URLSearchParams(window.location.search).get('upgrade') as PlanSlug | null)
      : null;
  const cycleParam =
    typeof window !== 'undefined'
      ? (new URLSearchParams(window.location.search).get('cycle') as BillingCycle | null)
      : null;
  const validUpgrade: PlanSlug | null =
    upgradeParam && PAID_PLAN_SLUGS.includes(upgradeParam as PlanSlug)
      ? (upgradeParam as PlanSlug)
      : null;
  const validCycle: BillingCycle = cycleParam === 'annual' ? 'annual' : 'monthly';

  // Load billing status
  useEffect(() => {
    void (async () => {
      const res = await fetch('/api/billing/status', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json() as BillingStatus;
        setStatus(data);
        // Default cycle/currency to what the active subscription uses
        setCycle(data.cycle ?? 'monthly');
        setCurrency(data.detected_currency ?? 'INR');
      }
    })();
  }, []);

  // Load payment history
  useEffect(() => {
    setInvoicesLoading(true);
    void fetch('/api/billing/payments', { credentials: 'include' })
      .then((r) => r.json() as Promise<{ invoices: Invoice[] }>)
      .then((d) => setInvoices(d.invoices ?? []))
      .catch(() => setInvoices([]))
      .finally(() => setInvoicesLoading(false));
  }, []);

  // Clean up ?checkout=success from URL
  useEffect(() => {
    if (checkoutSuccess && typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.delete('checkout');
      window.history.replaceState({}, '', url.toString());
    }
  }, [checkoutSuccess]);

  // Auto-trigger checkout when ?upgrade= is present and billing status is loaded
  useEffect(() => {
    if (!status || !validUpgrade || autoTriggered.current) return;
    const isAlreadySubscribed =
      status.plan !== 'free' &&
      status.subscription_status &&
      ['active', 'trialing', 'created'].includes(status.subscription_status);
    if (isAlreadySubscribed) return;
    autoTriggered.current = true;
    const url = new URL(window.location.href);
    url.searchParams.delete('upgrade');
    url.searchParams.delete('cycle');
    window.history.replaceState({}, '', url.toString());
    void startNewSubscription(validUpgrade, validCycle);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, validUpgrade]);

  // ── Checkout helpers ──────────────────────────────────────────────────────

  async function startNewSubscription(plan: PlanSlug, billingCycle: BillingCycle = 'monthly'): Promise<void> {
    setChangingPlan(plan);
    try {
      const res = await fetch('/api/billing/subscribe', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan, cycle: billingCycle }),
      });
      const body = await res.json() as { short_url?: string; error?: string; detail?: string };
      if (body.short_url) {
        window.location.href = body.short_url;
      } else {
        alert(body.error ?? body.detail ?? 'Could not start checkout. Please email support@theboringpeople.in.');
        setChangingPlan(null);
      }
    } catch {
      alert('Network error. Please check your connection and try again.');
      setChangingPlan(null);
    }
  }

  async function changePlan(plan: PlanSlug, billingCycle: BillingCycle): Promise<void> {
    setChangingPlan(plan);
    try {
      const res = await fetch('/api/billing/change-plan', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan, cycle: billingCycle }),
      });
      const body = await res.json() as { short_url?: string; error?: string; detail?: string };
      if (body.short_url) {
        window.location.href = body.short_url;
      } else {
        alert(body.error ?? body.detail ?? 'Could not change plan. Please email support@theboringpeople.in.');
        setChangingPlan(null);
      }
    } catch {
      alert('Network error. Please check your connection and try again.');
      setChangingPlan(null);
    }
  }

  async function cancelSubscription(): Promise<void> {
    if (!confirm('Cancel your subscription at the end of the current billing period?\n\nYou will keep access until then.')) return;
    setCancelling(true);
    try {
      const res = await fetch('/api/billing/cancel', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cancelAtPeriodEnd: true }),
      });
      const body = await res.json() as { cancelled?: boolean; error?: string };
      if (body.cancelled) {
        setStatus((prev) => prev ? { ...prev, cancel_at_period_end: true } : prev);
      } else {
        alert(body.error ?? 'Could not cancel. Please email support@theboringpeople.in.');
      }
    } finally {
      setCancelling(false);
    }
  }

  async function updatePaymentMethod(): Promise<void> {
    setUpdatingPayment(true);
    try {
      const res = await fetch('/api/billing/update-payment-method', {
        method: 'POST',
        credentials: 'include',
      });
      const body = await res.json() as { manage_url?: string; error?: string };
      if (body.manage_url) {
        window.open(body.manage_url, '_blank', 'noopener,noreferrer');
      } else {
        alert(body.error ?? 'Could not open payment management page. Please email support@theboringpeople.in.');
      }
    } catch {
      alert('Network error. Please check your connection and try again.');
    } finally {
      setUpdatingPayment(false);
    }
  }

  // ── Loading / redirect states ─────────────────────────────────────────────

  if (!status || (validUpgrade && !autoTriggered.current)) {
    const tierLabel = validUpgrade
      ? (TIERS.find((t) => t.slug === validUpgrade)?.name ?? validUpgrade)
      : null;
    return (
      <div style={{ color: 'var(--text-tertiary)', fontSize: '0.875rem' }}>
        {tierLabel ? `Preparing ${tierLabel} checkout…` : 'Loading…'}
      </div>
    );
  }

  if (changingPlan && validUpgrade) {
    const tierLabel = TIERS.find((t) => t.slug === validUpgrade)?.name ?? validUpgrade;
    return (
      <div style={{ color: 'var(--text-tertiary)', fontSize: '0.875rem' }}>
        Redirecting to {tierLabel} checkout…
      </div>
    );
  }

  // ── Derived state ─────────────────────────────────────────────────────────

  const isFreePlan = status.plan === 'free' || !status.subscription_status || !['active', 'trialing', 'created'].includes(status.subscription_status);
  const isActiveSub = !isFreePlan;
  const isCancelPending = status.cancel_at_period_end;
  const currentPlanSlug = (status.plan_slug ?? status.plan) as string;

  // Price to display for current subscription
  function getCurrentPriceDisplay(): string {
    if (!status?.prices) return '—';
    const pricePerSeat = cycle === 'annual'
      ? (currency === 'INR' ? status.prices.annual_inr : status.prices.annual_usd)
      : (currency === 'INR' ? status.prices.monthly_inr : status.prices.monthly_usd);
    const total = pricePerSeat * (status.billable_seats ?? 1);
    return formatPrice(total, currency);
  }

  // ── Section B helpers ─────────────────────────────────────────────────────

  function getPlanPrice(slug: PlanSlug): number | null {
    const tier = TIERS.find((t) => t.slug === slug);
    if (!tier) return null;
    if (cycle === 'annual') return currency === 'INR' ? tier.inr_annual : tier.usd_annual;
    return currency === 'INR' ? tier.inr_monthly : tier.usd_monthly;
  }

  function getPlanButtonLabel(slug: PlanSlug): string {
    if (changingPlan === slug) return 'Redirecting…';
    if (slug === currentPlanSlug) return 'Current plan';
    const currentRank = TIER_RANK[currentPlanSlug] ?? 0;
    const targetRank = TIER_RANK[slug] ?? 0;
    if (isFreePlan) return 'Subscribe →';
    return targetRank > currentRank ? 'Upgrade →' : 'Downgrade →';
  }

  function handlePlanClick(slug: PlanSlug): void {
    if (slug === currentPlanSlug || changingPlan) return;
    if (isFreePlan) {
      void startNewSubscription(slug, cycle);
    } else {
      void changePlan(slug, cycle);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem', maxWidth: 720 }}>

      {/* ── Checkout success banner ── */}
      {checkoutSuccess && (
        <div style={{
          padding: '0.875rem 1rem',
          borderRadius: '0.5rem',
          background: 'rgba(74,222,128,0.08)',
          border: '1px solid rgba(74,222,128,0.20)',
          fontSize: '0.875rem',
          color: 'var(--text-primary)',
        }}>
          🎉 Payment received — your subscription is activating. It may take a moment to reflect below.
        </div>
      )}

      {/* ══ SECTION A — Current Plan ══════════════════════════════════════════ */}
      <section style={cardStyle}>
        <div style={sectionHeaderStyle}>Current plan</div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
          <span style={{ fontSize: '1.5rem', fontWeight: 500, color: 'var(--text-primary)' }}>
            {TIERS.find((t) => t.slug === (status.plan_slug ?? status.plan))?.name
              ?? status.plan_slug
              ?? status.plan}
          </span>
          {status.subscription_status && (
            <StatusBadge status={isCancelPending ? 'cancelling' : status.subscription_status} />
          )}
        </div>

        {/* Seat breakdown */}
        {isActiveSub && (
          <div style={{ display: 'flex', gap: '1.5rem', marginBottom: '0.75rem' }}>
            <div>
              <div style={{ fontSize: '1.125rem', fontWeight: 500, color: 'var(--text-primary)' }}>
                {status.writer_seats}
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                {status.writer_seats === 1 ? 'writer' : 'writers'} (billed)
              </div>
            </div>
            <div>
              <div style={{ fontSize: '1.125rem', fontWeight: 500, color: 'var(--text-primary)' }}>
                {status.reader_seats}
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                {status.reader_seats === 1 ? 'reader' : 'readers'} (free)
              </div>
            </div>
            {status.prices && !isCancelPending && (
              <div>
                <div style={{ fontSize: '1.125rem', fontWeight: 500, color: 'var(--text-primary)' }}>
                  {getCurrentPriceDisplay()}
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                  next charge
                </div>
              </div>
            )}
          </div>
        )}

        {/* Renewal / expiry date */}
        {status.current_period_end && (
          <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', margin: 0 }}>
            {isCancelPending
              ? `Access until ${new Date(status.current_period_end).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}.`
              : `Renews on ${new Date(status.current_period_end).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}.`}
          </p>
        )}
        {isFreePlan && !status.current_period_end && (
          <p style={{ fontSize: '0.875rem', color: 'var(--text-tertiary)', margin: 0 }}>
            No active subscription.
          </p>
        )}
      </section>

      {/* ══ SECTION B — Change Plan ═══════════════════════════════════════════ */}
      <section>
        <div style={sectionHeaderStyle}>
          {isFreePlan ? 'Upgrade plan' : 'Change plan'}
        </div>

        {/* Cycle + Currency toggles */}
        <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
          {/* Cycle */}
          <div style={{
            display: 'flex',
            background: 'var(--surface-overlay)',
            border: '1px solid var(--border-default)',
            borderRadius: 8,
            padding: 3,
            gap: 2,
          }}>
            {(['monthly', 'annual'] as BillingCycle[]).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCycle(c)}
                style={{
                  padding: '3px 12px',
                  borderRadius: 6,
                  fontSize: '0.75rem',
                  fontWeight: 500,
                  border: 'none',
                  cursor: 'pointer',
                  background: cycle === c ? 'var(--interactive-primary)' : 'transparent',
                  color: cycle === c ? 'var(--interactive-primary-fg)' : 'var(--text-secondary)',
                  transition: 'background 0.15s, color 0.15s',
                }}
              >
                {c === 'monthly' ? 'Monthly' : 'Annual'}
                {c === 'annual' && (
                  <span style={{
                    marginLeft: 5,
                    fontSize: '0.6rem',
                    background: 'rgba(74,222,128,0.15)',
                    color: '#4ade80',
                    padding: '1px 4px',
                    borderRadius: 4,
                    fontWeight: 700,
                    letterSpacing: '0.04em',
                  }}>
                    −20%
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Currency */}
          <div style={{
            display: 'flex',
            background: 'var(--surface-overlay)',
            border: '1px solid var(--border-default)',
            borderRadius: 8,
            padding: 3,
            gap: 2,
          }}>
            {(['INR', 'USD'] as Currency[]).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCurrency(c)}
                style={{
                  padding: '3px 12px',
                  borderRadius: 6,
                  fontSize: '0.75rem',
                  fontWeight: 500,
                  border: 'none',
                  cursor: 'pointer',
                  background: currency === c ? 'var(--interactive-primary)' : 'transparent',
                  color: currency === c ? 'var(--interactive-primary-fg)' : 'var(--text-secondary)',
                  transition: 'background 0.15s, color 0.15s',
                }}
              >
                {c === 'INR' ? '₹ INR' : '$ USD'}
              </button>
            ))}
          </div>
        </div>

        {/* Plan mini-cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem' }}>
          {PAID_PLAN_SLUGS.map((slug) => {
            const tier = TIERS.find((t) => t.slug === slug)!;
            const price = getPlanPrice(slug);
            const isCurrent = slug === currentPlanSlug;
            const isHighlighted = tier.highlighted;
            const buttonLabel = getPlanButtonLabel(slug);
            const isRedirecting = changingPlan === slug;

            return (
              <div
                key={slug}
                style={{
                  padding: '1rem',
                  borderRadius: '0.5rem',
                  border: isCurrent
                    ? '1px solid var(--interactive-primary)'
                    : '1px solid var(--border-default)',
                  background: isCurrent
                    ? 'rgba(var(--interactive-primary-rgb, 99,102,241), 0.06)'
                    : 'var(--surface-overlay)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.5rem',
                  position: 'relative',
                }}
              >
                {isHighlighted && (
                  <div style={{
                    position: 'absolute',
                    top: 10,
                    right: 10,
                    fontSize: '0.6rem',
                    fontWeight: 700,
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    background: 'rgba(var(--interactive-primary-rgb, 99,102,241), 0.15)',
                    color: 'var(--interactive-primary)',
                    padding: '1px 6px',
                    borderRadius: 4,
                  }}>
                    Popular
                  </div>
                )}
                <div style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                  {tier.name}
                </div>
                <div style={{ fontSize: '1.25rem', fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1 }}>
                  {price !== null ? formatPrice(price, currency) : '—'}
                  <span style={{ fontSize: '0.7rem', fontWeight: 400, color: 'var(--text-tertiary)', marginLeft: 3 }}>
                    / {tier.perSeat ? 'writer' : ''} mo
                  </span>
                </div>
                {cycle === 'annual' && price !== null && (
                  <div style={{ fontSize: '0.6875rem', color: 'var(--text-tertiary)' }}>
                    Billed{' '}
                    {currency === 'INR'
                      ? `₹${(tier.inr_annual_total ?? 0).toLocaleString('en-IN')}`
                      : `$${tier.usd_annual_total ?? 0}`
                    } / yr
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => handlePlanClick(slug)}
                  disabled={isCurrent || !!changingPlan}
                  style={{
                    marginTop: '0.25rem',
                    padding: '0.375rem 0.75rem',
                    borderRadius: '0.375rem',
                    fontSize: '0.8125rem',
                    fontWeight: 500,
                    border: 'none',
                    cursor: isCurrent || changingPlan ? 'default' : 'pointer',
                    background: isCurrent
                      ? 'var(--surface-inset)'
                      : 'var(--interactive-primary)',
                    color: isCurrent
                      ? 'var(--text-tertiary)'
                      : 'var(--interactive-primary-fg)',
                    opacity: changingPlan && !isRedirecting ? 0.6 : 1,
                    transition: 'opacity 0.15s',
                  }}
                >
                  {isRedirecting ? 'Redirecting…' : buttonLabel}
                </button>
              </div>
            );
          })}
        </div>

        <p style={{ marginTop: '0.75rem', fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
          Readers (viewers) are always free.{' '}
          <a href="/pricing" style={{ color: 'inherit', textDecoration: 'underline' }}>
            See full pricing →
          </a>
        </p>
      </section>

      {/* ══ SECTION C — Payment Method ════════════════════════════════════════ */}
      {isActiveSub && (
        <section style={cardStyle}>
          <div style={sectionHeaderStyle}>Payment method</div>
          <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
            To update your saved card or UPI, open the Razorpay-hosted payment management page.
          </p>
          <button
            type="button"
            onClick={() => void updatePaymentMethod()}
            disabled={updatingPayment}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.375rem',
              padding: '0.5rem 1rem',
              borderRadius: '0.375rem',
              border: '1px solid var(--border-default)',
              background: 'var(--surface-overlay)',
              color: 'var(--text-primary)',
              fontSize: '0.875rem',
              fontWeight: 500,
              cursor: updatingPayment ? 'wait' : 'pointer',
              opacity: updatingPayment ? 0.6 : 1,
            }}
          >
            {updatingPayment ? 'Opening…' : 'Update payment method ↗'}
          </button>
        </section>
      )}

      {/* ══ SECTION D — Payment History ═══════════════════════════════════════ */}
      <section style={cardStyle}>
        <div style={sectionHeaderStyle}>Payment history</div>

        {invoicesLoading ? (
          <div style={{ color: 'var(--text-tertiary)', fontSize: '0.875rem' }}>Loading payments…</div>
        ) : !invoices || invoices.length === 0 ? (
          <p style={{ fontSize: '0.875rem', color: 'var(--text-tertiary)', margin: 0 }}>
            No payments yet.
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8125rem' }}>
              <thead>
                <tr>
                  {['Date', 'Description', 'Amount', 'Status', ''].map((h) => (
                    <th
                      key={h}
                      style={{
                        textAlign: 'left',
                        padding: '0 0.75rem 0.5rem 0',
                        fontSize: '0.6875rem',
                        fontWeight: 600,
                        letterSpacing: '0.05em',
                        textTransform: 'uppercase',
                        color: 'var(--text-tertiary)',
                        whiteSpace: 'nowrap',
                        borderBottom: '1px solid var(--border-default)',
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.id} style={{ borderBottom: '1px solid var(--border-subtle, rgba(255,255,255,0.05))' }}>
                    <td style={{ padding: '0.625rem 0.75rem 0.625rem 0', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                      {inv.date
                        ? new Date(inv.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
                        : '—'}
                    </td>
                    <td style={{ padding: '0.625rem 0.75rem 0.625rem 0', color: 'var(--text-primary)' }}>
                      {inv.description}
                    </td>
                    <td style={{ padding: '0.625rem 0.75rem 0.625rem 0', color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>
                      {inv.amount_paid > 0
                        ? formatAmount(inv.amount_paid, inv.currency)
                        : inv.amount_due > 0
                          ? formatAmount(inv.amount_due, inv.currency)
                          : '—'}
                    </td>
                    <td style={{ padding: '0.625rem 0.75rem 0.625rem 0' }}>
                      <InvoiceStatusBadge status={inv.status} />
                    </td>
                    <td style={{ padding: '0.625rem 0 0.625rem 0', textAlign: 'right' }}>
                      {inv.download_url ? (
                        <a
                          href={inv.download_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{
                            fontSize: '0.75rem',
                            color: 'var(--text-secondary)',
                            textDecoration: 'none',
                            padding: '2px 8px',
                            border: '1px solid var(--border-default)',
                            borderRadius: 4,
                          }}
                        >
                          ↓ Invoice
                        </a>
                      ) : (
                        <span style={{ color: 'var(--text-tertiary)', fontSize: '0.75rem' }}>—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ══ SECTION E — Danger Zone ═══════════════════════════════════════════ */}
      {isActiveSub && !isCancelPending && (
        <section style={{
          ...cardStyle,
          border: '1px solid rgba(248,113,113,0.20)',
        }}>
          <div style={{ ...sectionHeaderStyle, color: '#f87171' }}>Danger zone</div>
          <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
            Cancelling ends your subscription at the close of the current billing period.
            You will keep access until then.
          </p>
          <button
            type="button"
            onClick={() => void cancelSubscription()}
            disabled={cancelling}
            style={{
              padding: '0.5rem 1rem',
              borderRadius: '0.375rem',
              border: '1px solid rgba(248,113,113,0.40)',
              background: 'transparent',
              color: '#f87171',
              fontSize: '0.875rem',
              fontWeight: 500,
              cursor: cancelling ? 'wait' : 'pointer',
              opacity: cancelling ? 0.5 : 1,
            }}
          >
            {cancelling ? 'Cancelling…' : 'Cancel subscription'}
          </button>
        </section>
      )}

      {/* Cancellation pending notice (replaces danger zone) */}
      {isActiveSub && isCancelPending && (
        <section style={{ ...cardStyle, border: '1px solid rgba(245,158,11,0.20)' }}>
          <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', margin: 0 }}>
            ⚠️ Your subscription is set to cancel at the end of the billing period. You retain access until then.
            To reactivate, email{' '}
            <a href="mailto:support@theboringpeople.in" style={{ color: 'inherit', textDecoration: 'underline' }}>
              support@theboringpeople.in
            </a>.
          </p>
        </section>
      )}

    </div>
  );
}
