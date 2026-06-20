-- seed-org.sql — idempotent org/IAM seed for the current workspace.
--
-- Builds an agency + tech-development org for The Boring People:
--   Teams:   Leadership, Client Services, Engineering, Design & Creative, Operations
--   Folders: one team-root folder per team + a shared "Clients" folder
--   Roles:   Founder & CEO (owner), Account Manager, Engineer, Designer, Operations (editor)
--   Access:  CEO=admin everywhere; each role=write on its own folder, read elsewhere;
--            Account Manager=admin on the shared Clients folder.
--   People:  workspace owner -> Founder & CEO; existing members + ayesha@theboringpeople.in
--            spread across the teams (you fine-tune titles/managers in the Org UI later).
--
-- Safe to re-run: every write is guarded or upserted.
--
-- Run on the VPS:
--   C="docker compose -f infra/docker-compose.prod.yml --env-file infra/.env"
--   $C exec -T postgres psql -U boppl -d boppl_context -f - < apps/api/drizzle/seed/seed-org.sql
-- (or paste the heredoc form given in chat)

DO $$
DECLARE
  v_ws        uuid;
  v_owner     uuid;
  v_ayesha    uuid;
  v_team_lead uuid; v_team_cs uuid; v_team_eng uuid; v_team_design uuid; v_team_ops uuid;
  v_f_lead    uuid; v_f_cs uuid; v_f_eng uuid; v_f_design uuid; v_f_ops uuid; v_f_clients uuid;
  v_role_ceo  uuid; v_role_am uuid; v_role_eng uuid; v_role_designer uuid; v_role_ops uuid;
  r           record;
  v_idx       int := 0;
  v_role      uuid;
  v_role_slug text; v_title text; v_dept text; v_team uuid;
BEGIN
  -- 1) Resolve the workspace (prefer the one nischaybk owns) ------------------
  SELECT w.id INTO v_ws
  FROM workspaces w
  JOIN workspace_members m ON m.workspace_id = w.id
  JOIN users u ON u.id = m.user_id
  WHERE u.email = 'nischaybk@theboringpeople.in'
  ORDER BY (m.role = 'owner') DESC, w.created_at ASC
  LIMIT 1;

  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'No workspace found for nischaybk@theboringpeople.in — aborting seed';
  END IF;

  SELECT id INTO v_owner FROM users WHERE email = 'nischaybk@theboringpeople.in';

  -- 2) Ensure ayesha exists as a user + workspace member ---------------------
  INSERT INTO users (email, display_name)
  VALUES ('ayesha@theboringpeople.in', 'Ayesha')
  ON CONFLICT (email) DO UPDATE SET display_name = COALESCE(users.display_name, 'Ayesha')
  RETURNING id INTO v_ayesha;

  INSERT INTO workspace_members (workspace_id, user_id, role)
  VALUES (v_ws, v_ayesha, 'editor')
  ON CONFLICT (workspace_id, user_id) DO NOTHING;

  -- 3) Teams -----------------------------------------------------------------
  INSERT INTO teams (workspace_id, name, slug, description, color) VALUES
    (v_ws, 'Leadership', 'leadership', 'Founders & company leadership', '#f0997b')
  ON CONFLICT (workspace_id, slug) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, color = EXCLUDED.color
  RETURNING id INTO v_team_lead;

  INSERT INTO teams (workspace_id, name, slug, description, color) VALUES
    (v_ws, 'Client Services', 'client-services', 'Account management & client document delivery', '#6ea8fe')
  ON CONFLICT (workspace_id, slug) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, color = EXCLUDED.color
  RETURNING id INTO v_team_cs;

  INSERT INTO teams (workspace_id, name, slug, description, color) VALUES
    (v_ws, 'Engineering', 'engineering', 'Product & platform development', '#8b5cf6')
  ON CONFLICT (workspace_id, slug) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, color = EXCLUDED.color
  RETURNING id INTO v_team_eng;

  INSERT INTO teams (workspace_id, name, slug, description, color) VALUES
    (v_ws, 'Design & Creative', 'design-creative', 'Design, brand & creative delivery', '#34d399')
  ON CONFLICT (workspace_id, slug) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, color = EXCLUDED.color
  RETURNING id INTO v_team_design;

  INSERT INTO teams (workspace_id, name, slug, description, color) VALUES
    (v_ws, 'Operations', 'operations', 'Finance, people & operations', '#fbbf24')
  ON CONFLICT (workspace_id, slug) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, color = EXCLUDED.color
  RETURNING id INTO v_team_ops;

  -- 4) Team-root folders + shared Clients folder (folders has no unique slug,
  --    so guard each by existence) -------------------------------------------
  SELECT id INTO v_f_lead FROM folders WHERE workspace_id = v_ws AND slug = 'leadership' AND folder_type = 'team_root' LIMIT 1;
  IF v_f_lead IS NULL THEN
    INSERT INTO folders (workspace_id, name, slug, folder_type, team_id, is_deletable, created_by)
    VALUES (v_ws, 'Leadership', 'leadership', 'team_root', v_team_lead, false, v_owner) RETURNING id INTO v_f_lead;
  END IF;

  SELECT id INTO v_f_cs FROM folders WHERE workspace_id = v_ws AND slug = 'client-services' AND folder_type = 'team_root' LIMIT 1;
  IF v_f_cs IS NULL THEN
    INSERT INTO folders (workspace_id, name, slug, folder_type, team_id, is_deletable, created_by)
    VALUES (v_ws, 'Client Services', 'client-services', 'team_root', v_team_cs, false, v_owner) RETURNING id INTO v_f_cs;
  END IF;

  SELECT id INTO v_f_eng FROM folders WHERE workspace_id = v_ws AND slug = 'engineering' AND folder_type = 'team_root' LIMIT 1;
  IF v_f_eng IS NULL THEN
    INSERT INTO folders (workspace_id, name, slug, folder_type, team_id, is_deletable, created_by)
    VALUES (v_ws, 'Engineering', 'engineering', 'team_root', v_team_eng, false, v_owner) RETURNING id INTO v_f_eng;
  END IF;

  SELECT id INTO v_f_design FROM folders WHERE workspace_id = v_ws AND slug = 'design-creative' AND folder_type = 'team_root' LIMIT 1;
  IF v_f_design IS NULL THEN
    INSERT INTO folders (workspace_id, name, slug, folder_type, team_id, is_deletable, created_by)
    VALUES (v_ws, 'Design & Creative', 'design-creative', 'team_root', v_team_design, false, v_owner) RETURNING id INTO v_f_design;
  END IF;

  SELECT id INTO v_f_ops FROM folders WHERE workspace_id = v_ws AND slug = 'operations' AND folder_type = 'team_root' LIMIT 1;
  IF v_f_ops IS NULL THEN
    INSERT INTO folders (workspace_id, name, slug, folder_type, team_id, is_deletable, created_by)
    VALUES (v_ws, 'Operations', 'operations', 'team_root', v_team_ops, false, v_owner) RETURNING id INTO v_f_ops;
  END IF;

  SELECT id INTO v_f_clients FROM folders WHERE workspace_id = v_ws AND slug = 'clients' AND folder_type = 'team_root' LIMIT 1;
  IF v_f_clients IS NULL THEN
    INSERT INTO folders (workspace_id, name, slug, folder_type, team_id, is_deletable, created_by)
    VALUES (v_ws, 'Clients', 'clients', 'team_root', v_team_cs, false, v_owner) RETURNING id INTO v_f_clients;
  END IF;

  -- 5) Org roles (with default_folder_access mirroring the matrix below) ------
  INSERT INTO org_roles (workspace_id, team_id, name, slug, description, workspace_role, default_folder_access)
  VALUES (v_ws, v_team_lead, 'Founder & CEO', 'founder-ceo', 'Company founder / chief executive', 'owner',
    '[{"folder_slug":"leadership","permission":"admin"},{"folder_slug":"client-services","permission":"admin"},{"folder_slug":"engineering","permission":"admin"},{"folder_slug":"design-creative","permission":"admin"},{"folder_slug":"operations","permission":"admin"},{"folder_slug":"clients","permission":"admin"}]'::jsonb)
  ON CONFLICT (workspace_id, slug) DO UPDATE SET team_id = EXCLUDED.team_id, name = EXCLUDED.name, description = EXCLUDED.description, workspace_role = EXCLUDED.workspace_role, default_folder_access = EXCLUDED.default_folder_access
  RETURNING id INTO v_role_ceo;

  INSERT INTO org_roles (workspace_id, team_id, name, slug, description, workspace_role, default_folder_access)
  VALUES (v_ws, v_team_cs, 'Account Manager', 'account-manager', 'Owns client relationships & deliverables', 'editor',
    '[{"folder_slug":"client-services","permission":"write"},{"folder_slug":"clients","permission":"admin"},{"folder_slug":"engineering","permission":"read"},{"folder_slug":"design-creative","permission":"read"},{"folder_slug":"operations","permission":"read"}]'::jsonb)
  ON CONFLICT (workspace_id, slug) DO UPDATE SET team_id = EXCLUDED.team_id, name = EXCLUDED.name, description = EXCLUDED.description, workspace_role = EXCLUDED.workspace_role, default_folder_access = EXCLUDED.default_folder_access
  RETURNING id INTO v_role_am;

  INSERT INTO org_roles (workspace_id, team_id, name, slug, description, workspace_role, default_folder_access)
  VALUES (v_ws, v_team_eng, 'Engineer', 'engineer', 'Builds the product & platform', 'editor',
    '[{"folder_slug":"engineering","permission":"write"},{"folder_slug":"clients","permission":"read"},{"folder_slug":"client-services","permission":"read"},{"folder_slug":"design-creative","permission":"read"},{"folder_slug":"operations","permission":"read"}]'::jsonb)
  ON CONFLICT (workspace_id, slug) DO UPDATE SET team_id = EXCLUDED.team_id, name = EXCLUDED.name, description = EXCLUDED.description, workspace_role = EXCLUDED.workspace_role, default_folder_access = EXCLUDED.default_folder_access
  RETURNING id INTO v_role_eng;

  INSERT INTO org_roles (workspace_id, team_id, name, slug, description, workspace_role, default_folder_access)
  VALUES (v_ws, v_team_design, 'Designer', 'designer', 'Design, brand & creative', 'editor',
    '[{"folder_slug":"design-creative","permission":"write"},{"folder_slug":"clients","permission":"read"},{"folder_slug":"client-services","permission":"read"},{"folder_slug":"engineering","permission":"read"},{"folder_slug":"operations","permission":"read"}]'::jsonb)
  ON CONFLICT (workspace_id, slug) DO UPDATE SET team_id = EXCLUDED.team_id, name = EXCLUDED.name, description = EXCLUDED.description, workspace_role = EXCLUDED.workspace_role, default_folder_access = EXCLUDED.default_folder_access
  RETURNING id INTO v_role_designer;

  INSERT INTO org_roles (workspace_id, team_id, name, slug, description, workspace_role, default_folder_access)
  VALUES (v_ws, v_team_ops, 'Operations', 'operations', 'Finance, people & operations', 'editor',
    '[{"folder_slug":"operations","permission":"write"},{"folder_slug":"clients","permission":"read"},{"folder_slug":"client-services","permission":"read"},{"folder_slug":"engineering","permission":"read"},{"folder_slug":"design-creative","permission":"read"}]'::jsonb)
  ON CONFLICT (workspace_id, slug) DO UPDATE SET team_id = EXCLUDED.team_id, name = EXCLUDED.name, description = EXCLUDED.description, workspace_role = EXCLUDED.workspace_role, default_folder_access = EXCLUDED.default_folder_access
  RETURNING id INTO v_role_ops;

  -- 6) Access matrix: org_role x folder grants (doc_acl) ---------------------
  INSERT INTO doc_acl (workspace_id, resource_type, resource_id, principal_type, principal_id, permission, created_by)
  VALUES
    -- Founder & CEO: admin everywhere
    (v_ws,'folder',v_f_lead,   'org_role',v_role_ceo,     'admin', v_owner),
    (v_ws,'folder',v_f_cs,     'org_role',v_role_ceo,     'admin', v_owner),
    (v_ws,'folder',v_f_eng,    'org_role',v_role_ceo,     'admin', v_owner),
    (v_ws,'folder',v_f_design, 'org_role',v_role_ceo,     'admin', v_owner),
    (v_ws,'folder',v_f_ops,    'org_role',v_role_ceo,     'admin', v_owner),
    (v_ws,'folder',v_f_clients,'org_role',v_role_ceo,     'admin', v_owner),
    -- Account Manager
    (v_ws,'folder',v_f_cs,     'org_role',v_role_am,      'write', v_owner),
    (v_ws,'folder',v_f_clients,'org_role',v_role_am,      'admin', v_owner),
    (v_ws,'folder',v_f_eng,    'org_role',v_role_am,      'read',  v_owner),
    (v_ws,'folder',v_f_design, 'org_role',v_role_am,      'read',  v_owner),
    (v_ws,'folder',v_f_ops,    'org_role',v_role_am,      'read',  v_owner),
    -- Engineer
    (v_ws,'folder',v_f_eng,    'org_role',v_role_eng,     'write', v_owner),
    (v_ws,'folder',v_f_clients,'org_role',v_role_eng,     'read',  v_owner),
    (v_ws,'folder',v_f_cs,     'org_role',v_role_eng,     'read',  v_owner),
    (v_ws,'folder',v_f_design, 'org_role',v_role_eng,     'read',  v_owner),
    -- Designer
    (v_ws,'folder',v_f_design, 'org_role',v_role_designer,'write', v_owner),
    (v_ws,'folder',v_f_clients,'org_role',v_role_designer,'read',  v_owner),
    (v_ws,'folder',v_f_cs,     'org_role',v_role_designer,'read',  v_owner),
    (v_ws,'folder',v_f_eng,    'org_role',v_role_designer,'read',  v_owner),
    -- Operations
    (v_ws,'folder',v_f_ops,    'org_role',v_role_ops,     'write', v_owner),
    (v_ws,'folder',v_f_clients,'org_role',v_role_ops,     'read',  v_owner),
    (v_ws,'folder',v_f_cs,     'org_role',v_role_ops,     'read',  v_owner)
  ON CONFLICT (resource_type, resource_id, principal_type, principal_id)
    DO UPDATE SET permission = EXCLUDED.permission, updated_at = now();

  -- 7) Owner profile -> Founder & CEO ----------------------------------------
  INSERT INTO user_org_profiles (user_id, workspace_id, org_role_id, display_title, role_slug, manager_user_id, department, bot_display_name)
  VALUES (v_owner, v_ws, v_role_ceo, 'Founder & CEO', 'founder-ceo', NULL, 'Leadership',
          COALESCE((SELECT NULLIF(display_name,'') FROM users WHERE id = v_owner), 'Nischay'))
  ON CONFLICT (user_id, workspace_id) DO UPDATE
    SET org_role_id = EXCLUDED.org_role_id, display_title = EXCLUDED.display_title, role_slug = EXCLUDED.role_slug,
        manager_user_id = NULL, department = EXCLUDED.department, bot_display_name = EXCLUDED.bot_display_name;

  INSERT INTO team_members (team_id, user_id, role) VALUES (v_team_lead, v_owner, 'lead')
  ON CONFLICT (team_id, user_id) DO NOTHING;

  -- 8) Everyone else -> spread across the four teams, reporting to the owner --
  FOR r IN
    SELECT m.user_id, u.email::text AS email, u.display_name
    FROM workspace_members m JOIN users u ON u.id = m.user_id
    WHERE m.workspace_id = v_ws AND m.user_id <> v_owner
    ORDER BY u.created_at ASC, u.email ASC
  LOOP
    CASE (v_idx % 4)
      WHEN 0 THEN v_role := v_role_am;       v_role_slug := 'account-manager'; v_title := 'Account Manager'; v_dept := 'Client Services';   v_team := v_team_cs;
      WHEN 1 THEN v_role := v_role_eng;      v_role_slug := 'engineer';        v_title := 'Engineer';        v_dept := 'Engineering';       v_team := v_team_eng;
      WHEN 2 THEN v_role := v_role_designer; v_role_slug := 'designer';        v_title := 'Designer';        v_dept := 'Design & Creative'; v_team := v_team_design;
      WHEN 3 THEN v_role := v_role_ops;      v_role_slug := 'operations';      v_title := 'Operations';      v_dept := 'Operations';        v_team := v_team_ops;
    END CASE;

    INSERT INTO user_org_profiles (user_id, workspace_id, org_role_id, display_title, role_slug, manager_user_id, department, bot_display_name)
    VALUES (r.user_id, v_ws, v_role, v_title, v_role_slug, v_owner, v_dept,
            COALESCE(NULLIF(r.display_name, ''), split_part(r.email, '@', 1)))
    ON CONFLICT (user_id, workspace_id) DO UPDATE
      SET org_role_id = EXCLUDED.org_role_id, display_title = EXCLUDED.display_title, role_slug = EXCLUDED.role_slug,
          manager_user_id = EXCLUDED.manager_user_id, department = EXCLUDED.department, bot_display_name = EXCLUDED.bot_display_name;

    INSERT INTO team_members (team_id, user_id, role) VALUES (v_team, r.user_id, 'member')
    ON CONFLICT (team_id, user_id) DO NOTHING;

    v_idx := v_idx + 1;
  END LOOP;

  RAISE NOTICE 'Org seeded for workspace % — owner=% members assigned=%', v_ws, v_owner, v_idx + 1;
END $$;

-- Quick verification (resolve the workspace once, then count)
WITH ws AS (
  SELECT w.id FROM workspaces w
  JOIN workspace_members m ON m.workspace_id = w.id
  JOIN users u ON u.id = m.user_id
  WHERE u.email = 'nischaybk@theboringpeople.in'
  ORDER BY (m.role = 'owner') DESC, w.created_at ASC LIMIT 1
)
SELECT 'teams'  AS kind, count(*) FROM teams             WHERE workspace_id = (SELECT id FROM ws)
UNION ALL SELECT 'roles',  count(*) FROM org_roles         WHERE workspace_id = (SELECT id FROM ws)
UNION ALL SELECT 'folders', count(*) FROM folders          WHERE workspace_id = (SELECT id FROM ws) AND folder_type = 'team_root'
UNION ALL SELECT 'grants', count(*) FROM doc_acl           WHERE workspace_id = (SELECT id FROM ws) AND principal_type = 'org_role'
UNION ALL SELECT 'people', count(*) FROM user_org_profiles WHERE workspace_id = (SELECT id FROM ws);
