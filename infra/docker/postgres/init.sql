-- AEGIS GLOBAL — PostgreSQL Schema
-- Run on first init via Docker entrypoint

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_topology;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ─── Databases ───────────────────────────────────────────────────────────────
CREATE DATABASE aegis_historical;
CREATE DATABASE aegis_resources;

\c aegis_core;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS postgis;

-- ─── ENUMS ───────────────────────────────────────────────────────────────────
CREATE TYPE disaster_type AS ENUM (
  'earthquake','tsunami','flood','flash_flood','cyclone','hurricane','typhoon',
  'tornado','wildfire','volcano','landslide','avalanche','drought','heatwave',
  'cold_wave','pandemic','disease_outbreak','industrial','chemical_leak',
  'nuclear','infrastructure_failure','terror_attack','humanitarian_crisis'
);

CREATE TYPE severity_level AS ENUM ('critical','high','medium','low','monitoring');
CREATE TYPE disaster_status AS ENUM ('active','contained','recovering','closed');
CREATE TYPE alert_channel AS ENUM ('push','sms','email','voice','radio','whatsapp','satellite');
CREATE TYPE user_role AS ENUM ('global_admin','national_admin','regional_admin','emergency_coordinator','ngo_coordinator','research_analyst','first_responder','citizen');
CREATE TYPE sos_status AS ENUM ('pending','acknowledged','dispatched','resolved','false_alarm');
CREATE TYPE resource_category AS ENUM ('sar_team','medical_unit','aerial','boat','fire_unit','supply_food','supply_water','supply_medical','drone','communication');
CREATE TYPE drone_status AS ENUM ('active','standby','rtb','charging','maintenance','offline');
CREATE TYPE drone_mission AS ENUM ('sar','damage_assessment','supply_delivery','surveillance','infrastructure','mapping');
CREATE TYPE shelter_status AS ENUM ('open','full','closed','preparing');

-- ─── USERS ───────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email             VARCHAR(255) UNIQUE NOT NULL,
  password_hash     VARCHAR(255) NOT NULL,
  name              VARCHAR(255) NOT NULL,
  role              user_role NOT NULL DEFAULT 'citizen',
  organisation      VARCHAR(255),
  country           VARCHAR(2),
  home_location     GEOGRAPHY(POINT, 4326),
  mfa_enabled       BOOLEAN DEFAULT FALSE,
  mfa_secret        VARCHAR(255),
  preferred_lang    VARCHAR(10) DEFAULT 'en',
  phone             VARCHAR(50),
  push_token        TEXT,
  is_active         BOOLEAN DEFAULT TRUE,
  last_login        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_country ON users(country);
CREATE INDEX idx_users_location ON users USING GIST(home_location);

-- ─── REFRESH TOKENS ──────────────────────────────────────────────────────────
CREATE TABLE refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  VARCHAR(255) UNIQUE NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  ip_address  INET,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_expires ON refresh_tokens(expires_at);

-- ─── DISASTERS ───────────────────────────────────────────────────────────────
CREATE TABLE disasters (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                VARCHAR(500) NOT NULL,
  type                disaster_type NOT NULL,
  severity            severity_level NOT NULL DEFAULT 'medium',
  status              disaster_status NOT NULL DEFAULT 'active',
  country             VARCHAR(100),
  iso2                VARCHAR(2),
  region              VARCHAR(200),
  coordinates         GEOGRAPHY(POINT, 4326),
  affected_area       GEOGRAPHY(POLYGON, 4326),
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at            TIMESTAMPTZ,
  deaths              INTEGER DEFAULT 0,
  injured             INTEGER DEFAULT 0,
  missing             INTEGER DEFAULT 0,
  affected            BIGINT DEFAULT 0,
  displaced           BIGINT DEFAULT 0,
  economic_loss_usd   DECIMAL(20, 2) DEFAULT 0,
  magnitude           DECIMAL(5, 2),
  depth_km            DECIMAL(8, 2),
  wind_speed_kmh      DECIMAL(8, 2),
  metadata            JSONB DEFAULT '{}',
  source              VARCHAR(50) DEFAULT 'manual',
  external_id         VARCHAR(200),
  created_by          UUID REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_disasters_source_external ON disasters(source, external_id) WHERE external_id IS NOT NULL;

CREATE INDEX idx_disasters_type ON disasters(type);
CREATE INDEX idx_disasters_severity ON disasters(severity);
CREATE INDEX idx_disasters_status ON disasters(status);
CREATE INDEX idx_disasters_country ON disasters(country);
CREATE INDEX idx_disasters_started ON disasters(started_at DESC);
CREATE INDEX idx_disasters_coords ON disasters USING GIST(coordinates);
CREATE INDEX idx_disasters_area ON disasters USING GIST(affected_area);
CREATE INDEX idx_disasters_metadata ON disasters USING GIN(metadata);

-- ─── ALERTS ──────────────────────────────────────────────────────────────────
CREATE TABLE alerts (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  disaster_id           UUID REFERENCES disasters(id) ON DELETE CASCADE,
  title                 VARCHAR(500) NOT NULL,
  message               TEXT NOT NULL,
  severity              severity_level NOT NULL,
  category              VARCHAR(100),
  geo_center            GEOGRAPHY(POINT, 4326),
  geo_polygon           GEOGRAPHY(POLYGON, 4326),
  radius_km             DECIMAL(10, 2),
  languages             TEXT[] DEFAULT ARRAY['en'],
  translations          JSONB DEFAULT '{}',
  channels              alert_channel[] DEFAULT ARRAY['push']::alert_channel[],
  recipients_targeted   INTEGER DEFAULT 0,
  recipients_delivered  INTEGER DEFAULT 0,
  delivery_rate         DECIMAL(5, 2),
  issued_by             UUID REFERENCES users(id),
  issued_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_alerts_disaster ON alerts(disaster_id);
CREATE INDEX idx_alerts_severity ON alerts(severity);
CREATE INDEX idx_alerts_issued ON alerts(issued_at DESC);
CREATE INDEX idx_alerts_geo ON alerts USING GIST(geo_polygon);

-- ─── PREDICTIONS ─────────────────────────────────────────────────────────────
CREATE TABLE predictions (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  disaster_id           UUID REFERENCES disasters(id),
  model_name            VARCHAR(200) NOT NULL,
  model_version         VARCHAR(50) NOT NULL,
  disaster_type         disaster_type NOT NULL,
  confidence            DECIMAL(5, 4) NOT NULL,
  predicted_severity    severity_level,
  estimated_affected    INTEGER,
  economic_forecast     DECIMAL(20, 2),
  onset_min             TIMESTAMPTZ,
  onset_max             TIMESTAMPTZ,
  location              GEOGRAPHY(POINT, 4326),
  affected_area         GEOGRAPHY(POLYGON, 4326),
  contributing_factors  JSONB DEFAULT '[]',
  risk_score            DECIMAL(5, 2),
  is_active             BOOLEAN DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at            TIMESTAMPTZ
);

CREATE INDEX idx_predictions_disaster ON predictions(disaster_id);
CREATE INDEX idx_predictions_type ON predictions(disaster_type);
CREATE INDEX idx_predictions_confidence ON predictions(confidence DESC);
CREATE INDEX idx_predictions_active ON predictions(is_active, created_at DESC);
CREATE INDEX idx_predictions_location ON predictions USING GIST(location);

-- ─── SOS REPORTS ─────────────────────────────────────────────────────────────
CREATE TABLE sos_reports (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID REFERENCES users(id),
  disaster_id       UUID REFERENCES disasters(id),
  type              VARCHAR(100) NOT NULL,
  location          GEOGRAPHY(POINT, 4326) NOT NULL,
  address           TEXT,
  people_count      INTEGER DEFAULT 1,
  description       TEXT,
  status            sos_status NOT NULL DEFAULT 'pending',
  ai_severity       severity_level,
  ai_confidence     DECIMAL(5, 4),
  ai_analysis       TEXT,
  assigned_team_id  UUID,
  media_urls        TEXT[] DEFAULT '{}',
  contact_phone     VARCHAR(50),
  is_anonymous      BOOLEAN DEFAULT FALSE,
  resolved_by       UUID REFERENCES users(id),
  resolved_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sos_user ON sos_reports(user_id);
CREATE INDEX idx_sos_disaster ON sos_reports(disaster_id);
CREATE INDEX idx_sos_status ON sos_reports(status);
CREATE INDEX idx_sos_severity ON sos_reports(ai_severity);
CREATE INDEX idx_sos_location ON sos_reports USING GIST(location);
CREATE INDEX idx_sos_created ON sos_reports(created_at DESC);

-- ─── RESPONSE TEAMS ──────────────────────────────────────────────────────────
CREATE TABLE response_teams (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name              VARCHAR(300) NOT NULL,
  type              VARCHAR(100) NOT NULL,
  specialisation    VARCHAR(200),
  personnel_count   INTEGER NOT NULL DEFAULT 0,
  status            VARCHAR(50) DEFAULT 'standby',
  current_location  GEOGRAPHY(POINT, 4326),
  disaster_id       UUID REFERENCES disasters(id),
  shelter_id        UUID,
  commander_id      UUID REFERENCES users(id),
  organisation      VARCHAR(200),
  contact           JSONB DEFAULT '{}',
  equipment         JSONB DEFAULT '[]',
  deployed_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_teams_disaster ON response_teams(disaster_id);
CREATE INDEX idx_teams_status ON response_teams(status);
CREATE INDEX idx_teams_location ON response_teams USING GIST(current_location);

-- ─── SHELTERS ────────────────────────────────────────────────────────────────
CREATE TABLE shelters (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                  VARCHAR(300) NOT NULL,
  location              GEOGRAPHY(POINT, 4326) NOT NULL,
  address               TEXT,
  disaster_id           UUID REFERENCES disasters(id),
  capacity_total        INTEGER NOT NULL,
  occupancy_current     INTEGER DEFAULT 0,
  medical_unit          BOOLEAN DEFAULT FALSE,
  food_days_remaining   DECIMAL(5, 1) DEFAULT 0,
  water_days_remaining  DECIMAL(5, 1) DEFAULT 0,
  status                shelter_status DEFAULT 'open',
  facilities            JSONB DEFAULT '[]',
  contact               JSONB DEFAULT '{}',
  managed_by            UUID REFERENCES users(id),
  opened_at             TIMESTAMPTZ DEFAULT NOW(),
  closed_at             TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_shelters_disaster ON shelters(disaster_id);
CREATE INDEX idx_shelters_status ON shelters(status);
CREATE INDEX idx_shelters_location ON shelters USING GIST(location);
CREATE INDEX idx_shelters_capacity ON shelters(capacity_total, occupancy_current);

-- ─── RESOURCES ───────────────────────────────────────────────────────────────
CREATE TABLE resources (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  category            resource_category NOT NULL,
  name                VARCHAR(300) NOT NULL,
  unit                VARCHAR(50) DEFAULT 'unit',
  quantity_total      DECIMAL(15, 2) NOT NULL DEFAULT 0,
  quantity_available  DECIMAL(15, 2) NOT NULL DEFAULT 0,
  quantity_deployed   DECIMAL(15, 2) NOT NULL DEFAULT 0,
  status              VARCHAR(50) DEFAULT 'available',
  current_location    GEOGRAPHY(POINT, 4326),
  home_base           GEOGRAPHY(POINT, 4326),
  assigned_team_id    UUID REFERENCES response_teams(id),
  disaster_id         UUID REFERENCES disasters(id),
  metadata            JSONB DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_resources_category ON resources(category);
CREATE INDEX idx_resources_disaster ON resources(disaster_id);
CREATE INDEX idx_resources_status ON resources(status);
CREATE INDEX idx_resources_location ON resources USING GIST(current_location);

-- ─── DRONES ──────────────────────────────────────────────────────────────────
CREATE TABLE drones (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  callsign          VARCHAR(50) UNIQUE NOT NULL,
  model             VARCHAR(200),
  type              VARCHAR(100) NOT NULL,
  mission_type      drone_mission,
  status            drone_status NOT NULL DEFAULT 'standby',
  battery_pct       DECIMAL(5, 2) DEFAULT 100,
  current_location  GEOGRAPHY(POINT, 4326),
  altitude_m        DECIMAL(8, 2),
  speed_ms          DECIMAL(8, 2),
  heading_deg       DECIMAL(5, 2),
  disaster_id       UUID REFERENCES disasters(id),
  operator_id       UUID REFERENCES users(id),
  telemetry         JSONB DEFAULT '{}',
  mission_log       JSONB DEFAULT '[]',
  last_seen         TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_drones_disaster ON drones(disaster_id);
CREATE INDEX idx_drones_status ON drones(status);
CREATE INDEX idx_drones_location ON drones USING GIST(current_location);

-- ─── NOTIFICATION LOG ────────────────────────────────────────────────────────
CREATE TABLE notification_log (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  alert_id      UUID REFERENCES alerts(id) ON DELETE CASCADE,
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  channel       alert_channel NOT NULL,
  status        VARCHAR(50) DEFAULT 'pending',
  latency_ms    DECIMAL(10, 2),
  error_message TEXT,
  sent_at       TIMESTAMPTZ,
  delivered_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notif_alert ON notification_log(alert_id);
CREATE INDEX idx_notif_user ON notification_log(user_id);
CREATE INDEX idx_notif_status ON notification_log(status);
CREATE INDEX idx_notif_sent ON notification_log(sent_at DESC);

-- ─── COUNTRY RISK SCORES ─────────────────────────────────────────────────────
CREATE TABLE country_risk_scores (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  iso2                    VARCHAR(2) UNIQUE NOT NULL,
  country_name            VARCHAR(200) NOT NULL,
  gdis_score              DECIMAL(5, 2) NOT NULL,
  disaster_frequency      DECIMAL(5, 2),
  infrastructure_score    DECIMAL(5, 2),
  climate_risk            DECIMAL(5, 2),
  preparedness_score      DECIMAL(5, 2),
  response_efficiency     DECIMAL(5, 2),
  recovery_performance    DECIMAL(5, 2),
  economic_vulnerability  DECIMAL(5, 2),
  population_density_risk DECIMAL(5, 2),
  rank                    INTEGER,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_risk_iso2 ON country_risk_scores(iso2);
CREATE INDEX idx_risk_score ON country_risk_scores(gdis_score DESC);

-- ─── AUDIT LOG ───────────────────────────────────────────────────────────────
CREATE TABLE audit_log (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  action        VARCHAR(200) NOT NULL,
  resource_type VARCHAR(100),
  resource_id   UUID,
  old_value     JSONB,
  new_value     JSONB,
  ip_address    INET,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_user ON audit_log(user_id);
CREATE INDEX idx_audit_action ON audit_log(action);
CREATE INDEX idx_audit_resource ON audit_log(resource_type, resource_id);
CREATE INDEX idx_audit_created ON audit_log(created_at DESC);

-- ─── SEED DATA ────────────────────────────────────────────────────────────────
-- Default admin user (password: AegisAdmin2025!)
INSERT INTO users (id, email, password_hash, name, role, is_active, created_at, updated_at) VALUES
  (gen_random_uuid(), 'admin@aegisglobal.io', '$2b$12$GThiqhxSOXyvcAhZS0/TS.fkGvUdeIpfniKr81BQWAdM7v62wbLnW', 'AEGIS Administrator', 'global_admin', TRUE, NOW(), NOW())
  ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = TRUE;

-- Sample country risk scores
INSERT INTO country_risk_scores (iso2, country_name, gdis_score, disaster_frequency, infrastructure_score, climate_risk, preparedness_score, response_efficiency, recovery_performance, economic_vulnerability, population_density_risk, rank) VALUES
  ('BD', 'Bangladesh', 91.0, 95.0, 30.0, 90.0, 45.0, 50.0, 35.0, 85.0, 92.0, 1),
  ('PH', 'Philippines', 88.0, 92.0, 40.0, 88.0, 60.0, 58.0, 50.0, 70.0, 85.0, 2),
  ('ID', 'Indonesia', 84.0, 88.0, 48.0, 82.0, 55.0, 52.0, 52.0, 72.0, 80.0, 3),
  ('IN', 'India', 79.0, 82.0, 55.0, 78.0, 62.0, 60.0, 60.0, 65.0, 88.0, 4),
  ('JP', 'Japan', 72.0, 90.0, 92.0, 80.0, 95.0, 92.0, 88.0, 25.0, 70.0, 5),
  ('US', 'United States', 65.0, 75.0, 78.0, 68.0, 72.0, 75.0, 80.0, 30.0, 55.0, 6),
  ('MZ', 'Mozambique', 64.0, 70.0, 25.0, 75.0, 30.0, 35.0, 28.0, 90.0, 60.0, 7),
  ('TR', 'Turkey', 84.0, 80.0, 58.0, 72.0, 55.0, 62.0, 48.0, 45.0, 65.0, 8);

-- Sample active disaster
INSERT INTO disasters (name, type, severity, status, country, iso2, coordinates, deaths, injured, missing, affected, metadata) VALUES
  ('M7.2 Earthquake — Kahramanmaraş', 'earthquake', 'critical', 'active', 'Turkey', 'TR',
   ST_GeographyFromText('POINT(37.18 37.42)'), 847, 3241, 1180, 124000,
   '{"magnitude": 7.2, "depth_km": 12, "aftershocks": 23}');

COMMIT;
