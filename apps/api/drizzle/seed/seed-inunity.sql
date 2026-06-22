-- seed-inunity.sql — provision the Inunity org + two users (idempotent).
--
-- End state:
--   • Workspace "Inunity" (slug 'inunity')  — on the TEAM plan
--       - plan label set to 'team' (cosmetic) AND a comp subscription row
--         (status 'active', plan_key 'team') which is what actually unlocks
--         paid entitlements + makes it the default landing workspace.
--   • Users johnson@inunity.in and preetham@inunity.in
--       - both OWNERS of Inunity
--       - each ALSO gets their own personal workspace (owner), free plan
--   • 3 workspaces total: Inunity (team) + 2 personal (free)
--
-- Login is Google-only via WorkOS (GoogleOAuth) — these rows just make Mnema
-- recognise the users by email and drop them straight into Inunity on first
-- sign-in (bootstrapUserAndWorkspace returns existing memberships; the paid
-- Inunity workspace wins pickDefaultWorkspaceId). No password / magic-link.
--
-- Safe to re-run: every write is guarded or upserted.
--
-- Run on the VPS:
--   C="docker compose -f infra/docker-compose.prod.yml --env-file infra/.env"
--   $C exec -T postgres psql -U boppl -d boppl_context -f - < apps/api/drizzle/seed/seed-inunity.sql

BEGIN;

-- 1. Users (email is CITEXT — case-insensitive unique)
INSERT INTO users (email, display_name) VALUES
  ('johnson@inunity.in',  'Johnson'),
  ('preetham@inunity.in', 'Preetham')
ON CONFLICT (email) DO NOTHING;

-- 2. Inunity org workspace (label as 'team'; entitlement comes from the sub below)
INSERT INTO workspaces (slug, name, plan)
VALUES ('inunity', 'Inunity', 'team')
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, plan = EXCLUDED.plan;

-- 3. Comp subscription → grants the Team plan (active status bypasses free limits)
INSERT INTO subscriptions (
  workspace_id, razorpay_subscription_id, status, plan_id, plan_key,
  quantity, current_period_end
)
SELECT w.id, 'comp_inunity_team', 'active', 'comp_team', 'team',
       2, now() + interval '100 years'
FROM workspaces w WHERE w.slug = 'inunity'
ON CONFLICT (razorpay_subscription_id)
  DO UPDATE SET status = 'active', plan_key = 'team', quantity = 2,
               current_period_end = now() + interval '100 years';

-- 4. Inunity memberships — both owners
INSERT INTO workspace_members (workspace_id, user_id, role)
SELECT w.id, u.id, 'owner'::workspace_role
FROM workspaces w
JOIN users u ON u.email IN ('johnson@inunity.in', 'preetham@inunity.in')
WHERE w.slug = 'inunity'
ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role;

-- 5. Personal workspaces (free plan) — one per user
INSERT INTO workspaces (slug, name, plan) VALUES
  ('johnson-personal',  'Johnson''s Workspace',  'free'),
  ('preetham-personal', 'Preetham''s Workspace', 'free')
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name;

-- 6. Personal memberships — each user owns their own personal workspace
INSERT INTO workspace_members (workspace_id, user_id, role)
SELECT w.id, u.id, 'owner'::workspace_role
FROM (VALUES
  ('johnson-personal',  'johnson@inunity.in'),
  ('preetham-personal', 'preetham@inunity.in')
) AS pair(ws_slug, user_email)
JOIN workspaces w ON w.slug = pair.ws_slug
JOIN users u      ON u.email = pair.user_email
ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role;

-- 7. Verify
SELECT u.email,
       w.slug  AS workspace,
       w.name,
       w.plan,
       m.role,
       CASE WHEN s.status IS NOT NULL THEN s.plan_key || ' (' || s.status || ')'
            ELSE '—' END AS subscription
FROM workspace_members m
JOIN users u            ON u.id = m.user_id
JOIN workspaces w       ON w.id = m.workspace_id
LEFT JOIN subscriptions s ON s.workspace_id = w.id
WHERE u.email IN ('johnson@inunity.in', 'preetham@inunity.in')
ORDER BY u.email, (w.slug <> 'inunity'), w.slug;

COMMIT;
