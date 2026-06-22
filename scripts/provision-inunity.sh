#!/usr/bin/env bash
# provision-inunity.sh — email Johnson & Preetham their Mnema login link.
#
# Login is Google-only. WorkOS auto-provisions the user on first "Continue with
# Google", and seed-inunity.sql already created the Mnema workspaces/memberships
# — so there is nothing to pre-create. This script just sends each person an
# automatic email with the login link (via Resend, same sender Mnema uses).
#
# Run AFTER seed-inunity.sql, on the VPS (loads RESEND_* from infra/.env):
#   set -a; . infra/.env; set +a
#   bash scripts/provision-inunity.sh
#
# Flags:
#   --dry-run   print the recipients + rendered email, send nothing.

set -euo pipefail

LOGIN_URL="https://mnema.theboringpeople.in/login"
RESEND_API="https://api.resend.com/emails"
FROM="${RESEND_FROM_ADDRESS:-noreply@theboringpeople.in}"
DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

command -v jq >/dev/null || { echo "jq is required (apt install jq)"; exit 1; }
$DRY_RUN || : "${RESEND_API_KEY:?RESEND_API_KEY not set — run: set -a; . infra/.env; set +a}"

# email|first name
USERS=(
  "johnson@inunity.in|Johnson"
  "preetham@inunity.in|Preetham"
)

html_for() {  # html_for "First"
  local name="$1"
  cat <<HTML
<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;color:#111">
  <h2 style="margin:0 0 12px">Welcome to Mnema, ${name}</h2>
  <p style="margin:0 0 16px;line-height:1.5;color:#444">
    Your <strong>Inunity</strong> workspace is ready, along with a personal
    workspace for your own files. Sign in to get started:
  </p>
  <p style="margin:0 0 20px">
    <a href="${LOGIN_URL}"
       style="background:#111;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;display:inline-block;font-weight:600">
      Sign in to Mnema
    </a>
  </p>
  <p style="margin:0 0 8px;line-height:1.5;color:#444">
    On the sign-in page, choose <strong>Continue with Google</strong> and use
    your <strong>@inunity.in</strong> Google account. That's the only login
    method for your account.
  </p>
  <p style="margin:16px 0 0;font-size:12px;color:#999">Or paste this link: ${LOGIN_URL}</p>
</div>
HTML
}

for entry in "${USERS[@]}"; do
  IFS='|' read -r email name <<< "$entry"
  subject="Your Inunity workspace on Mnema is ready"
  body=$(jq -nc \
    --arg from "Mnema <${FROM}>" \
    --arg to "$email" \
    --arg subject "$subject" \
    --arg html "$(html_for "$name")" \
    '{from:$from, to:[$to], subject:$subject, html:$html}')

  if $DRY_RUN; then
    echo "── would email ${email}"; echo "$body" | jq '{from,to,subject}'
    continue
  fi

  resp=$(curl -sS -X POST "$RESEND_API" \
    -H "Authorization: Bearer ${RESEND_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "$body")
  if echo "$resp" | jq -e '.id' >/dev/null 2>&1; then
    echo "── emailed ${email} (id: $(echo "$resp" | jq -r '.id'))"
  else
    echo "── ERROR emailing ${email}:"; echo "$resp" | jq .; exit 1
  fi
done

echo
$DRY_RUN && echo "Dry run — no emails sent." || echo "Done. Login link sent to both."
echo "Login page: ${LOGIN_URL}  → \"Continue with Google\" (@inunity.in)"
