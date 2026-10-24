-- Additive independent review storage. Content and receipts are append-only.
CREATE TABLE IF NOT EXISTS result_candidates (
 id TEXT PRIMARY KEY, chain_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 parent_id TEXT REFERENCES result_candidates(id),
 subject_kind TEXT NOT NULL CHECK(subject_kind IN ('match','individual')),
 subject_id INTEGER NOT NULL, category_id INTEGER NOT NULL REFERENCES categories(id),
 operation TEXT NOT NULL CHECK(operation IN ('initial','correction','cancel','reset_review','resolve_dispute')),
 base_version INTEGER NOT NULL CHECK(base_version>=0),
 payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL, candidate_hash TEXT NOT NULL,
 context_json TEXT NOT NULL, authors_json TEXT NOT NULL,
 created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
 UNIQUE(chain_id, revision)
);
CREATE TABLE IF NOT EXISTS candidate_heads (
 candidate_id TEXT PRIMARY KEY REFERENCES result_candidates(id),
 subject_kind TEXT NOT NULL, subject_id INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('submitted','approved','returned','withdrawn')),
 updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_candidate_active ON candidate_heads(subject_kind,subject_id)
 WHERE status='submitted';
CREATE INDEX IF NOT EXISTS idx_candidate_category ON result_candidates(category_id,created_at,id);
CREATE TABLE IF NOT EXISTS review_receipts (
 uid TEXT PRIMARY KEY, actor_id INTEGER NOT NULL REFERENCES users(id),
 action TEXT NOT NULL, subject_kind TEXT NOT NULL, subject_id INTEGER NOT NULL,
 payload_hash TEXT NOT NULL, identity_json TEXT NOT NULL, result_json TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS review_decisions (
 id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL UNIQUE REFERENCES result_candidates(id),
 action TEXT NOT NULL CHECK(action IN ('approve','return','withdraw')),
 reason TEXT NOT NULL, actor_id INTEGER NOT NULL REFERENCES users(id),
 uid TEXT NOT NULL UNIQUE REFERENCES review_receipts(uid) DEFERRABLE INITIALLY DEFERRED,
 candidate_hash TEXT NOT NULL, base_version INTEGER NOT NULL,
 applied_version INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS review_grants (
 user_id INTEGER NOT NULL REFERENCES users(id), event_id INTEGER NOT NULL,
 scope_kind TEXT NOT NULL CHECK(scope_kind IN ('event','category')), scope_id INTEGER NOT NULL,
 version INTEGER NOT NULL CHECK(version>0), active INTEGER NOT NULL CHECK(active IN (0,1)),
 granted_by INTEGER NOT NULL REFERENCES users(id), reason TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(user_id,event_id,scope_kind,scope_id)
);
CREATE TABLE IF NOT EXISTS recording_epochs (
 subject_kind TEXT NOT NULL, subject_id INTEGER NOT NULL, epoch INTEGER NOT NULL CHECK(epoch>0),
 authors_json TEXT NOT NULL, PRIMARY KEY(subject_kind,subject_id)
);
CREATE TABLE IF NOT EXISTS official_versions (
 subject_kind TEXT NOT NULL, subject_id INTEGER NOT NULL, version INTEGER NOT NULL,
 snapshot_json TEXT NOT NULL, authors_json TEXT NOT NULL,
 candidate_id TEXT REFERENCES result_candidates(id), reviewer_id INTEGER REFERENCES users(id),
 decision_uid TEXT, legacy INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
 PRIMARY KEY(subject_kind,subject_id,version)
);
CREATE TABLE IF NOT EXISTS result_disputes (
 id TEXT PRIMARY KEY, category_id INTEGER NOT NULL REFERENCES categories(id),
 subject_kind TEXT NOT NULL, subject_id INTEGER NOT NULL,
 candidate_id TEXT NOT NULL REFERENCES result_candidates(id),
 affected_json TEXT NOT NULL, reason TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('open','resolved')), updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_disputes_open ON result_disputes(category_id,status);
CREATE TABLE IF NOT EXISTS review_recusals (
 candidate_id TEXT NOT NULL REFERENCES result_candidates(id), user_id INTEGER NOT NULL REFERENCES users(id),
 reason TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(candidate_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS candidate_no_update BEFORE UPDATE ON result_candidates
 BEGIN SELECT RAISE(ABORT,'candidate content is immutable'); END;
CREATE TRIGGER IF NOT EXISTS candidate_no_delete BEFORE DELETE ON result_candidates
 BEGIN SELECT RAISE(ABORT,'candidate content is immutable'); END;
CREATE TRIGGER IF NOT EXISTS official_no_update BEFORE UPDATE ON official_versions
 BEGIN SELECT RAISE(ABORT,'official history is immutable'); END;
CREATE TRIGGER IF NOT EXISTS official_no_delete BEFORE DELETE ON official_versions
 BEGIN SELECT RAISE(ABORT,'official history is immutable'); END;
CREATE TRIGGER IF NOT EXISTS decision_no_update BEFORE UPDATE ON review_decisions
 BEGIN SELECT RAISE(ABORT,'review decision is immutable'); END;
CREATE TRIGGER IF NOT EXISTS decision_no_delete BEFORE DELETE ON review_decisions
 BEGIN SELECT RAISE(ABORT,'review decision is immutable'); END;
CREATE TRIGGER IF NOT EXISTS review_receipt_no_update BEFORE UPDATE ON review_receipts
 BEGIN SELECT RAISE(ABORT,'review receipt is immutable'); END;
CREATE TRIGGER IF NOT EXISTS review_receipt_no_delete BEFORE DELETE ON review_receipts
 BEGIN SELECT RAISE(ABORT,'review receipt is immutable'); END;
