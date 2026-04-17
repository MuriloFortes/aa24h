CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "postgis";

CREATE TABLE IF NOT EXISTS attendances (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  caller_id TEXT,
  customer_name TEXT,
  vehicle_plate TEXT,
  service_type TEXT,
  status TEXT NOT NULL DEFAULT 'in_progress',
  channel TEXT DEFAULT 'whatsapp',
  location TEXT,
  location_point GEOGRAPHY(Point, 4326),
  vehicle_type TEXT,
  problem_type TEXT,
  urgency TEXT DEFAULT 'normal',
  sga_response JSONB,
  notes JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS attendance_logs (
  id SERIAL PRIMARY KEY,
  attendance_id UUID REFERENCES attendances(id) ON DELETE CASCADE,
  step TEXT,
  question TEXT,
  answer TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS services (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  attendance_id UUID REFERENCES attendances(id) ON DELETE CASCADE,
  plate TEXT,
  service_type TEXT,
  customer_name TEXT,
  customer_phone TEXT,
  provider_id UUID,
  provider_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  price NUMERIC(10,2),
  eta_minutes INTEGER,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS providers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  phone TEXT,
  whatsapp TEXT,
  services TEXT,
  location GEOGRAPHY(Point, 4326),
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  rating NUMERIC(3,2) DEFAULT 5.00,
  total_ratings INTEGER DEFAULT 0,
  vehicle_types TEXT,
  max_distance_km INTEGER DEFAULT 30,
  price_base NUMERIC(10,2) DEFAULT 100.00,
  price_per_km NUMERIC(10,2) DEFAULT 5.00,
  available BOOLEAN DEFAULT true,
  active BOOLEAN DEFAULT true,
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  phone TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'inbound',
  content TEXT,
  message_type TEXT DEFAULT 'text',
  attendance_id UUID REFERENCES attendances(id) ON DELETE SET NULL,
  raw_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS negotiations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  provider_id UUID NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  offered_price NUMERIC(10,2),
  counter_price NUMERIC(10,2),
  final_price NUMERIC(10,2),
  status TEXT NOT NULL DEFAULT 'pending',
  contacted_at TIMESTAMPTZ,
  responded_at TIMESTAMPTZ,
  timeout_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  amount NUMERIC(10,2) NOT NULL,
  method TEXT NOT NULL,
  gateway TEXT,
  gateway_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  pix_code TEXT,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  actor TEXT,
  data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_attendances_status ON attendances(status);
CREATE INDEX IF NOT EXISTS idx_attendances_caller ON attendances(caller_id);
CREATE INDEX IF NOT EXISTS idx_attendances_created ON attendances(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_services_status ON services(status);
CREATE INDEX IF NOT EXISTS idx_services_attendance ON services(attendance_id);

CREATE INDEX IF NOT EXISTS idx_providers_active ON providers(active, available);
CREATE INDEX IF NOT EXISTS idx_providers_location ON providers USING GIST(location);
CREATE INDEX IF NOT EXISTS idx_providers_rating ON providers(rating DESC);

CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_negotiations_service ON negotiations(service_id);
CREATE INDEX IF NOT EXISTS idx_negotiations_provider ON negotiations(provider_id);
CREATE INDEX IF NOT EXISTS idx_negotiations_status ON negotiations(status);

CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);

-- Auto-update location point when lat/lng change on providers
CREATE OR REPLACE FUNCTION update_provider_location()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.latitude IS NOT NULL AND NEW.longitude IS NOT NULL THEN
    NEW.location = ST_SetSRID(ST_MakePoint(NEW.longitude, NEW.latitude), 4326)::geography;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_provider_location ON providers;
CREATE TRIGGER trg_provider_location
  BEFORE INSERT OR UPDATE OF latitude, longitude ON providers
  FOR EACH ROW EXECUTE FUNCTION update_provider_location();

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_attendances_updated ON attendances;
CREATE TRIGGER trg_attendances_updated
  BEFORE UPDATE ON attendances
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();

DROP TRIGGER IF EXISTS trg_services_updated ON services;
CREATE TRIGGER trg_services_updated
  BEFORE UPDATE ON services
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();
