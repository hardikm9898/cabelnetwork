-- Phase 2 foundation: identity, geography, customers, agent assignments, audit, settings.
-- See docs/DATABASE_DESIGN.md. Requires PostgreSQL 18+ (uuidv7()).

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% not allowed)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------
CREATE TYPE user_role AS ENUM ('SUPER_ADMIN', 'ADMIN', 'AGENT');
CREATE TYPE user_status AS ENUM ('ACTIVE', 'SUSPENDED', 'DEACTIVATED');

CREATE TABLE users (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  full_name            text NOT NULL CHECK (length(full_name) BETWEEN 1 AND 120),
  mobile               varchar(15) NOT NULL,
  email                citext,
  password_hash        text NOT NULL,
  role                 user_role NOT NULL,
  status               user_status NOT NULL DEFAULT 'ACTIVE',
  must_change_password boolean NOT NULL DEFAULT true,
  failed_login_count   integer NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  last_login_at        timestamptz,
  password_changed_at  timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid REFERENCES users (id),
  updated_by           uuid REFERENCES users (id)
);
CREATE UNIQUE INDEX users_mobile_uq ON users (mobile);
CREATE UNIQUE INDEX users_email_uq ON users (email) WHERE email IS NOT NULL;
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE agent_profiles (
  user_id           uuid PRIMARY KEY REFERENCES users (id),
  agent_code        varchar(10) NOT NULL,
  photo_url         text,
  joining_date      date,
  employment_status text NOT NULL DEFAULT 'ACTIVE' CHECK (employment_status IN ('ACTIVE', 'ON_LEAVE', 'LEFT')),
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX agent_profiles_code_uq ON agent_profiles (upper(agent_code));
CREATE TRIGGER agent_profiles_updated_at BEFORE UPDATE ON agent_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE devices (
  id            uuid PRIMARY KEY,                 -- generated on the device at install
  user_id       uuid NOT NULL REFERENCES users (id),
  platform      text,
  model         text,
  app_version   text,
  push_token    text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz
);
CREATE INDEX devices_user_idx ON devices (user_id);

-- One row per refresh token. Rows sharing family_id form one login session.
CREATE TABLE sessions (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id            uuid NOT NULL REFERENCES users (id),
  family_id          uuid NOT NULL,
  device_id          uuid REFERENCES devices (id),
  refresh_token_hash char(64) NOT NULL UNIQUE,    -- sha256 hex of the opaque token
  ip                 inet,
  user_agent         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  rotated_at         timestamptz,
  revoked_at         timestamptz,
  revoke_reason      text
);
CREATE INDEX sessions_family_idx ON sessions (family_id);
CREATE INDEX sessions_user_active_idx ON sessions (user_id) WHERE revoked_at IS NULL AND rotated_at IS NULL;

-- ---------------------------------------------------------------------------
-- Geography
-- ---------------------------------------------------------------------------
CREATE TABLE areas (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  description text,
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users (id),
  updated_by  uuid REFERENCES users (id)
);
CREATE UNIQUE INDEX areas_name_uq ON areas (lower(name));
CREATE TRIGGER areas_updated_at BEFORE UPDATE ON areas FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE societies (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  area_id        uuid REFERENCES areas (id),
  name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  legacy_name    text,                            -- exactly as typed in the Excel workbook
  collection_day smallint CHECK (collection_day BETWEEN 1 AND 31),
  status         text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES users (id),
  updated_by     uuid REFERENCES users (id)
);
CREATE UNIQUE INDEX societies_name_uq ON societies (lower(name));
CREATE INDEX societies_area_idx ON societies (area_id);
CREATE TRIGGER societies_updated_at BEFORE UPDATE ON societies FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Customers
-- ---------------------------------------------------------------------------
CREATE TYPE customer_status AS ENUM ('ACTIVE', 'SUSPENDED', 'INACTIVE', 'DISCONNECTED');

CREATE TABLE customers (
  id                        uuid PRIMARY KEY DEFAULT uuidv7(),
  customer_code             varchar(20) NOT NULL,
  name                      text NOT NULL CHECK (length(name) BETWEEN 1 AND 150),
  mobile                    varchar(15),
  mobile_valid              boolean NOT NULL DEFAULT true,
  alt_mobile                varchar(15),
  address_line              text NOT NULL,
  landmark                  text,
  society_id                uuid NOT NULL REFERENCES societies (id),
  latitude                  numeric(9, 6),
  longitude                 numeric(9, 6),
  collection_day            smallint CHECK (collection_day BETWEEN 1 AND 31),
  payment_preference_months smallint CHECK (payment_preference_months BETWEEN 1 AND 24),
  status                    customer_status NOT NULL DEFAULT 'ACTIVE',
  status_reason             text,
  notes                     text,
  import_batch_id           uuid,                 -- FK added with import tables (Phase 7)
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid REFERENCES users (id),
  updated_by                uuid REFERENCES users (id),
  deactivated_at            timestamptz
);
CREATE UNIQUE INDEX customers_code_uq ON customers (lower(customer_code));
CREATE INDEX customers_society_idx ON customers (society_id);
CREATE INDEX customers_mobile_idx ON customers (mobile);
CREATE INDEX customers_alt_mobile_idx ON customers (alt_mobile);
CREATE INDEX customers_status_idx ON customers (status);
CREATE INDEX customers_name_trgm ON customers USING gin (name gin_trgm_ops);
CREATE TRIGGER customers_updated_at BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE customer_connections (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  customer_id uuid NOT NULL REFERENCES customers (id),
  stb_number  varchar(30) NOT NULL,
  mq_number   varchar(30),
  active_from date NOT NULL,
  active_to   date,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users (id),
  CHECK (active_to IS NULL OR active_to >= active_from)
);
CREATE UNIQUE INDEX customer_connections_active_stb_uq ON customer_connections (upper(stb_number)) WHERE active_to IS NULL;
CREATE INDEX customer_connections_customer_idx ON customer_connections (customer_id);
CREATE INDEX customer_connections_stb_idx ON customer_connections (upper(stb_number));

-- ---------------------------------------------------------------------------
-- Agent assignment (effective-dated history; see DATABASE_DESIGN §3)
-- ---------------------------------------------------------------------------
CREATE TABLE area_agent_assignments (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  area_id      uuid NOT NULL REFERENCES areas (id),
  agent_id     uuid NOT NULL REFERENCES agent_profiles (user_id),
  valid_during tstzrange NOT NULL CHECK (NOT isempty(valid_during)),
  reason       text,
  created_by   uuid NOT NULL REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  ended_by     uuid REFERENCES users (id),
  ended_reason text,
  EXCLUDE USING gist (area_id WITH =, valid_during WITH &&)
);

CREATE TABLE temp_reassignments (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  from_agent_id uuid NOT NULL REFERENCES agent_profiles (user_id),
  to_agent_id   uuid NOT NULL REFERENCES agent_profiles (user_id),
  scope         text NOT NULL CHECK (scope IN ('ALL_OF_AGENT', 'SOCIETIES', 'CUSTOMERS')),
  scope_ids     uuid[],
  starts_on     date NOT NULL,
  ends_on       date NOT NULL,
  reason        text NOT NULL,
  customer_count integer NOT NULL,
  created_by    uuid NOT NULL REFERENCES users (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_by    uuid REFERENCES users (id),
  revoked_at    timestamptz,
  revoke_reason text,
  CHECK (to_agent_id <> from_agent_id),
  CHECK (ends_on >= starts_on)
);
CREATE INDEX temp_reassignments_agents_idx ON temp_reassignments (from_agent_id, to_agent_id);

CREATE TYPE assignment_kind AS ENUM ('PRIMARY', 'TEMPORARY');
CREATE TYPE assignment_source AS ENUM ('AREA_DEFAULT', 'MANUAL', 'IMPORT', 'TEMP_REASSIGNMENT');

CREATE TABLE customer_agent_assignments (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  customer_id          uuid NOT NULL REFERENCES customers (id),
  agent_id             uuid NOT NULL REFERENCES agent_profiles (user_id),
  kind                 assignment_kind NOT NULL,
  source               assignment_source NOT NULL,
  valid_during         tstzrange NOT NULL,        -- [from, to); empty once revoked before start
  temp_reassignment_id uuid REFERENCES temp_reassignments (id),
  reason               text,
  created_by           uuid NOT NULL REFERENCES users (id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  ended_by             uuid REFERENCES users (id),
  ended_at             timestamptz,
  ended_reason         text,
  CHECK ((kind = 'TEMPORARY') = (temp_reassignment_id IS NOT NULL)),
  EXCLUDE USING gist (customer_id WITH =, kind WITH =, valid_during WITH &&)
);
CREATE INDEX customer_agent_assignments_agent_idx ON customer_agent_assignments USING gist (agent_id, valid_during);
CREATE INDEX customer_agent_assignments_customer_idx ON customer_agent_assignments (customer_id);
CREATE INDEX customer_agent_assignments_temp_idx ON customer_agent_assignments (temp_reassignment_id);

-- History may only be *shortened* (end a range early); everything else is immutable.
CREATE FUNCTION guard_assignment_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['valid_during', 'ended_by', 'ended_at', 'ended_reason'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['valid_during', 'ended_by', 'ended_at', 'ended_reason']) THEN
    RAISE EXCEPTION 'Only the end of an assignment range may change' USING ERRCODE = 'restrict_violation';
  END IF;
  -- (NULL-safe: an unbounded new end must not slip through a NULL comparison.)
  IF NOT isempty(NEW.valid_during) AND NOT coalesce(
       lower(NEW.valid_during) = lower(OLD.valid_during)
       AND (upper_inf(OLD.valid_during)
            OR (NOT upper_inf(NEW.valid_during) AND upper(NEW.valid_during) <= upper(OLD.valid_during))),
       false
     ) THEN
    RAISE EXCEPTION 'An assignment range may only be shortened' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_agent_assignments_guard BEFORE UPDATE ON customer_agent_assignments
  FOR EACH ROW EXECUTE FUNCTION guard_assignment_update();
CREATE TRIGGER customer_agent_assignments_no_delete BEFORE DELETE ON customer_agent_assignments
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER area_agent_assignments_guard BEFORE UPDATE ON area_agent_assignments
  FOR EACH ROW EXECUTE FUNCTION guard_assignment_update();
CREATE TRIGGER area_agent_assignments_no_delete BEFORE DELETE ON area_agent_assignments
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Effective agent right now: an active TEMPORARY assignment wins over PRIMARY.
CREATE VIEW customer_current_agent AS
SELECT DISTINCT ON (a.customer_id)
       a.customer_id, a.agent_id, a.kind, a.source, a.id AS assignment_id, a.temp_reassignment_id
FROM customer_agent_assignments a
WHERE a.valid_during @> now()
ORDER BY a.customer_id, (a.kind = 'TEMPORARY') DESC;

-- Current PRIMARY assignment (ignores temporary overlays).
CREATE VIEW customer_primary_agent AS
SELECT a.customer_id, a.agent_id, a.source, a.id AS assignment_id
FROM customer_agent_assignments a
WHERE a.kind = 'PRIMARY' AND a.valid_during @> now();

-- ---------------------------------------------------------------------------
-- Audit, notifications, settings
-- ---------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid REFERENCES users (id),
  actor_role    user_role,
  action        text NOT NULL,
  entity_type   text NOT NULL,
  entity_id     text,
  before        jsonb,
  after         jsonb,
  reason        text,
  request_id    text,
  ip            inet,
  user_agent    text,
  device_id     uuid,
  session_id    uuid
);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_user_id, occurred_at DESC);
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id    uuid NOT NULL REFERENCES users (id),
  type       text NOT NULL,
  title      text NOT NULL,
  body       text NOT NULL,
  data       jsonb,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

CREATE TABLE business_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by uuid REFERENCES users (id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
