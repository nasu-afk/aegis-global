// ─── AEGIS GLOBAL — Shared TypeScript Types ──────────────────────────────────

export type DisasterType =
  | 'earthquake' | 'tsunami' | 'flood' | 'flash_flood' | 'cyclone'
  | 'hurricane' | 'typhoon' | 'tornado' | 'wildfire' | 'volcano'
  | 'landslide' | 'avalanche' | 'drought' | 'heatwave' | 'cold_wave'
  | 'pandemic' | 'disease_outbreak' | 'industrial' | 'chemical_leak'
  | 'nuclear' | 'infrastructure_failure' | 'terror_attack' | 'humanitarian_crisis';

export type SeverityLevel = 'critical' | 'high' | 'medium' | 'low' | 'monitoring';
export type DisasterStatus = 'active' | 'contained' | 'recovering' | 'closed';
export type UserRole =
  | 'global_admin' | 'national_admin' | 'regional_admin'
  | 'emergency_coordinator' | 'ngo_coordinator' | 'research_analyst'
  | 'first_responder' | 'citizen';
export type AlertChannel = 'push' | 'sms' | 'email' | 'voice' | 'radio' | 'whatsapp' | 'satellite';
export type SOSStatus = 'pending' | 'acknowledged' | 'dispatched' | 'resolved' | 'false_alarm';
export type DroneStatus = 'active' | 'standby' | 'rtb' | 'charging' | 'maintenance' | 'offline';
export type DroneMission = 'sar' | 'damage_assessment' | 'supply_delivery' | 'surveillance' | 'infrastructure' | 'mapping';
export type ShelterStatus = 'open' | 'full' | 'closed' | 'preparing';

export interface GeoPoint {
  type: 'Point';
  coordinates: [number, number]; // [lng, lat]
}

export interface GeoPolygon {
  type: 'Polygon';
  coordinates: [number, number][][];
}

export interface Disaster {
  id: string;
  name: string;
  type: DisasterType;
  severity: SeverityLevel;
  status: DisasterStatus;
  country?: string;
  iso2?: string;
  region?: string;
  coordinates?: GeoPoint;
  affectedArea?: GeoPolygon;
  startedAt: string;
  endedAt?: string;
  deaths: number;
  injured: number;
  missing: number;
  affected: number;
  displaced: number;
  economicLossUsd: number;
  magnitude?: number;
  depthKm?: number;
  windSpeedKmh?: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Alert {
  id: string;
  disasterId?: string;
  title: string;
  message: string;
  severity: SeverityLevel;
  category?: string;
  geoCenter?: GeoPoint;
  geoPolygon?: GeoPolygon;
  radiusKm?: number;
  languages: string[];
  translations: Record<string, { title: string; message: string }>;
  channels: AlertChannel[];
  recipientsTargeted: number;
  recipientsDelivered: number;
  deliveryRate?: number;
  issuedBy?: string;
  issuedAt: string;
  expiresAt?: string;
}

export interface Prediction {
  id: string;
  disasterId?: string;
  modelName: string;
  modelVersion: string;
  disasterType: DisasterType;
  confidence: number;
  predictedSeverity?: SeverityLevel;
  estimatedAffected?: number;
  economicForecast?: number;
  onsetMin?: string;
  onsetMax?: string;
  location?: GeoPoint;
  affectedArea?: GeoPolygon;
  contributingFactors: string[];
  riskScore?: number;
  isActive: boolean;
  createdAt: string;
  expiresAt?: string;
}

export interface SOSReport {
  id: string;
  userId?: string;
  disasterId?: string;
  type: string;
  location: GeoPoint;
  address?: string;
  peopleCount: number;
  description?: string;
  status: SOSStatus;
  aiSeverity?: SeverityLevel;
  aiConfidence?: number;
  aiAnalysis?: string;
  assignedTeamId?: string;
  mediaUrls: string[];
  contactPhone?: string;
  isAnonymous: boolean;
  resolvedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResponseTeam {
  id: string;
  name: string;
  type: string;
  specialisation?: string;
  personnelCount: number;
  status: string;
  currentLocation?: GeoPoint;
  disasterId?: string;
  shelterId?: string;
  commanderId?: string;
  organisation?: string;
  contact: Record<string, string>;
  equipment: string[];
  deployedAt?: string;
}

export interface Shelter {
  id: string;
  name: string;
  location: GeoPoint;
  address?: string;
  disasterId?: string;
  capacityTotal: number;
  occupancyCurrent: number;
  medicalUnit: boolean;
  foodDaysRemaining: number;
  waterDaysRemaining: number;
  status: ShelterStatus;
  facilities: string[];
  openedAt: string;
  closedAt?: string;
}

export interface Resource {
  id: string;
  category: string;
  name: string;
  unit: string;
  quantityTotal: number;
  quantityAvailable: number;
  quantityDeployed: number;
  status: string;
  currentLocation?: GeoPoint;
  assignedTeamId?: string;
  disasterId?: string;
  metadata: Record<string, unknown>;
}

export interface Drone {
  id: string;
  callsign: string;
  model?: string;
  type: string;
  missionType?: DroneMission;
  status: DroneStatus;
  batteryPct: number;
  currentLocation?: GeoPoint;
  altitudeM?: number;
  speedMs?: number;
  headingDeg?: number;
  disasterId?: string;
  operatorId?: string;
  telemetry: Record<string, unknown>;
  missionLog: MissionLogEntry[];
  lastSeen?: string;
}

export interface MissionLogEntry {
  timestamp: string;
  event: string;
  details?: string;
  location?: GeoPoint;
}

export interface SocialSignal {
  id: string;
  platform: string;
  externalId?: string;
  content: string;
  location?: GeoPoint;
  hashtags: string[];
  aiCategory?: string;
  aiConfidence?: number;
  verificationStatus: 'verified' | 'investigating' | 'false' | 'unverified';
  disasterId?: string;
  postedAt: string;
  processedAt?: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  organisation?: string;
  country?: string;
  homeLocation?: GeoPoint;
  mfaEnabled: boolean;
  preferredLang: string;
  phone?: string;
  isActive: boolean;
  lastLogin?: string;
  createdAt: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: 'Bearer';
}

export interface HistoricalEvent {
  id: string;
  name: string;
  type: DisasterType;
  country: string;
  coordinates?: GeoPoint;
  eventDate: string;
  durationDays?: number;
  magnitude?: number;
  deaths: number;
  injuries: number;
  affected: number;
  economicLossUsd?: number;
  recoveryMonths?: number;
  dataSource: string;
}

export interface CountryRiskScore {
  id: string;
  iso2: string;
  countryName: string;
  gdisScore: number;
  disasterFrequency: number;
  infrastructureScore: number;
  climateRisk: number;
  preparednessScore: number;
  responseEfficiency: number;
  recoveryPerformance: number;
  economicVulnerability: number;
  populationDensityRisk: number;
  rank: number;
  updatedAt: string;
}

// ─── API Response wrappers ────────────────────────────────────────────────────
export interface ApiResponse<T> {
  status: 'success' | 'error';
  data?: T;
  message?: string;
  errors?: Record<string, string[]>;
}

export interface PaginatedResponse<T> {
  status: 'success';
  data: T[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

export interface PaginationQuery {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface DisasterQuery extends PaginationQuery {
  type?: DisasterType;
  severity?: SeverityLevel;
  status?: DisasterStatus;
  country?: string;
  lat?: number;
  lng?: number;
  radiusKm?: number;
  startDate?: string;
  endDate?: string;
}

// ─── Kafka event types ────────────────────────────────────────────────────────
export interface KafkaEvent<T = unknown> {
  eventId: string;
  eventType: string;
  timestamp: string;
  source: string;
  payload: T;
}

export type DisasterCreatedEvent = KafkaEvent<Disaster>;
export type AlertIssuedEvent = KafkaEvent<Alert>;
export type SOSCreatedEvent = KafkaEvent<SOSReport>;
export type DroneUpdateEvent = KafkaEvent<Drone>;

// ─── WebSocket message types ──────────────────────────────────────────────────
export interface WSMessage<T = unknown> {
  type: string;
  channel: string;
  payload: T;
  timestamp: string;
}

export type WSDisasterUpdate  = WSMessage<Disaster>;
export type WSAlertBroadcast  = WSMessage<Alert>;
export type WSSOSUpdate        = WSMessage<SOSReport>;
export type WSDroneTelemetry  = WSMessage<Drone>;
