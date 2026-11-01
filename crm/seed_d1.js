window.WORKER_SEED_SQL = `-- Delays (v3.29). See worker.js "Delays" for what each table is for.
CREATE TABLE line_review (
  key TEXT PRIMARY KEY,                 -- SO|product code|required date
  so TEXT NOT NULL,
  step TEXT, cause TEXT, ctrl TEXT,     -- stage where the time went, cause code, internal | external | customer
  note TEXT, prevent TEXT, why TEXT,    -- what happened, how to prevent it, why it is a review case
  is_case INTEGER NOT NULL DEFAULT 0,
  incl INTEGER,                         -- null = the short-lead rule decides, 1 = always count, 0 = never count
  status TEXT NOT NULL DEFAULT 'open',  -- open | proposed | confirmed
  updated_by TEXT, updated_at TEXT, confirmed_by TEXT, confirmed_at TEXT
);
CREATE INDEX line_review_so ON line_review (so);
CREATE TABLE so_step (
  so TEXT NOT NULL, step TEXT NOT NULL, src TEXT NOT NULL,   -- src: manual | kanban | wms
  started TEXT, done TEXT, note TEXT, cause TEXT,
  ask INTEGER NOT NULL DEFAULT 0,                            -- 1 = ask the department about this stage
  who TEXT, at TEXT,
  PRIMARY KEY (so, step, src)
);
CREATE TABLE setting (k TEXT PRIMARY KEY, v TEXT NOT NULL, who TEXT, at TEXT);
CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, who TEXT, kind TEXT NOT NULL, ref TEXT, body TEXT);
CREATE INDEX audit_ref ON audit (ref);
CREATE TABLE kanban_event (
  id TEXT PRIMARY KEY, board TEXT NOT NULL, card TEXT NOT NULL, title TEXT, type TEXT,
  from_col TEXT, to_col TEXT, labels TEXT, who TEXT, at TEXT NOT NULL, received_at TEXT NOT NULL
);
CREATE INDEX kanban_event_card ON kanban_event (board, card);
CREATE TABLE kanban_card (
  board TEXT NOT NULL, card TEXT NOT NULL, title TEXT, so_auto TEXT, so_manual TEXT, last_at TEXT,
  PRIMARY KEY (board, card)
);
CREATE TABLE kv_backup (day TEXT NOT NULL, key TEXT NOT NULL, part INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY (day, key, part));

INSERT INTO line_review (key, so, step, cause, ctrl, note, prevent, why, is_case, incl, status, updated_by, updated_at, confirmed_by, confirmed_at) VALUES ('SO20343|FG4034|2026-09-26', 'SO20343', 's3a', 'PU-2', 'external', 'Raw material arrived 3 weeks after the supplier date.', 'Ask for a second source on this ingredient.', NULL, 1, NULL, 'confirmed', 'planner@example.com', '2026-10-16T03:00:00.000Z', 'planner@example.com', '2026-10-16T03:00:00.000Z');
INSERT INTO line_review (key, so, step, cause, ctrl, note, prevent, why, is_case, incl, status, updated_by, updated_at, confirmed_by, confirmed_at) VALUES ('SO20016|FG4002|2026-08-08', 'SO20016', 's3b', 'SA-3', 'customer', 'Client approved the label artwork late.', 'Send artwork with the order confirmation.', NULL, 1, NULL, 'confirmed', 'planner@example.com', '2026-08-19T03:00:00.000Z', 'planner@example.com', '2026-08-19T03:00:00.000Z');
INSERT INTO line_review (key, so, step, cause, ctrl, note, prevent, why, is_case, incl, status, updated_by, updated_at, confirmed_by, confirmed_at) VALUES ('SO20040|FG4004|2026-06-25', 'SO20040', 's6', 'PL-1', 'internal', 'Slot pushed back for a larger order.', 'Flag short-lead orders in the weekly plan.', NULL, 1, NULL, 'confirmed', 'planner@example.com', '2026-07-14T03:00:00.000Z', 'planner@example.com', '2026-07-14T03:00:00.000Z');
INSERT INTO line_review (key, so, step, cause, ctrl, note, prevent, why, is_case, incl, status, updated_by, updated_at, confirmed_by, confirmed_at) VALUES ('SO20406|FG4040|2026-06-26', 'SO20406', 's4', 'QA-2', 'external', 'Material failed incoming QC and was retested.', NULL, NULL, 0, NULL, 'confirmed', 'planner@example.com', '2026-07-09T03:00:00.000Z', 'planner@example.com', '2026-07-09T03:00:00.000Z');
INSERT INTO line_review (key, so, step, cause, ctrl, note, prevent, why, is_case, incl, status, updated_by, updated_at, confirmed_by, confirmed_at) VALUES ('SO20129|FG4013|2026-06-16', 'SO20129', 's3c', 'PU-4', 'external', 'Bottles delivered late by the supplier.', 'Keep two weeks of bottle stock.', NULL, 0, NULL, 'proposed', 'planner@example.com', '2026-07-08T03:00:00.000Z', NULL, NULL);
INSERT INTO line_review (key, so, step, cause, ctrl, note, prevent, why, is_case, incl, status, updated_by, updated_at, confirmed_by, confirmed_at) VALUES ('SO20071|FG4007|2026-06-24', 'SO20071', 's7', 'PL-2', 'internal', 'Packing line short-staffed for a week.', NULL, NULL, 0, NULL, 'proposed', 'planner@example.com', '2026-07-05T03:00:00.000Z', NULL, NULL);
INSERT INTO line_review (key, so, step, cause, ctrl, note, prevent, why, is_case, incl, status, updated_by, updated_at, confirmed_by, confirmed_at) VALUES ('SO20007|FG4001|2026-05-11', 'SO20007', 's3a', 'PU-2', 'external', 'Raw material arrived 3 weeks after the supplier date.', 'Ask for a second source on this ingredient.', NULL, 0, NULL, 'proposed', 'planner@example.com', '2026-05-31T03:00:00.000Z', NULL, NULL);
INSERT INTO line_review (key, so, step, cause, ctrl, note, prevent, why, is_case, incl, status, updated_by, updated_at, confirmed_by, confirmed_at) VALUES ('SO20145|FG4015|2026-04-15', 'SO20145', NULL, NULL, NULL, NULL, 'Send artwork with the order confirmation.', NULL, 0, NULL, 'open', 'planner@example.com', '2026-05-01T03:00:00.000Z', NULL, NULL);
INSERT INTO line_review (key, so, step, cause, ctrl, note, prevent, why, is_case, incl, status, updated_by, updated_at, confirmed_by, confirmed_at) VALUES ('SO20026|FG4003|2026-04-12', 'SO20026', NULL, NULL, NULL, NULL, 'Flag short-lead orders in the weekly plan.', NULL, 0, NULL, 'open', 'planner@example.com', '2026-04-25T03:00:00.000Z', NULL, NULL);
`;
