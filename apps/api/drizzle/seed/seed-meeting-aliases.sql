-- seed-meeting-aliases.sql — let the meeting bot recognize workspace members live.
--
-- The bot identifies the active speaker by their meeting DISPLAY NAME (Recall
-- rarely gives an email). The server maps that name → a Mnema user via
-- participant_aliases; with no alias the speaker is treated as a guest and the
-- bot answers nothing. This seeds an alias per member: users.display_name → user.
--
-- IMPORTANT: the alias display_name must match the name shown in the Google Meet
-- (e.g. "Nischay B K"). If your Meet name differs from your Mnema display name,
-- add a row for that name too (or rename in one place so they match).
--
-- Idempotent. Run on the VPS:
--   $C exec -T postgres psql -U boppl -d boppl_context < apps/api/drizzle/seed/seed-meeting-aliases.sql

INSERT INTO participant_aliases (workspace_id, display_name, user_id, created_by)
SELECT wm.workspace_id, trim(u.display_name), u.id, u.id
FROM workspace_members wm
JOIN users u ON u.id = wm.user_id
WHERE COALESCE(NULLIF(trim(u.display_name), ''), '') <> ''
ON CONFLICT (workspace_id, display_name) DO NOTHING;

-- Show what the bot will now recognize.
SELECT pa.display_name, u.email
FROM participant_aliases pa
JOIN users u ON u.id = pa.user_id
ORDER BY pa.display_name;
