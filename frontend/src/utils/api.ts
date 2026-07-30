// ─── AEGIS GLOBAL — Typed API Client ─────────────────────────────────────────
import axios, { AxiosInstance, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import type {
  Disaster, Alert, Prediction, SOSReport, ResponseTeam, Shelter,
  Resource, SocialSignal, User, AuthTokens, HistoricalEvent,
  CountryRiskScore, ApiResponse, PaginatedResponse, DisasterQuery
} from '../types';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';

// ─── Token management ─────────────────────────────────────────────────────────
class TokenStore {
  private static ACCESS_KEY  = 'aegis_access_token';
  private static REFRESH_KEY = 'aegis_refresh_token';

  static getAccess():  string | null { return localStorage.getItem(this.ACCESS_KEY); }
  static getRefresh(): string | null { return localStorage.getItem(this.REFRESH_KEY); }

  static setTokens(tokens: AuthTokens) {
    localStorage.setItem(this.ACCESS_KEY,  tokens.accessToken);
    localStorage.setItem(this.REFRESH_KEY, tokens.refreshToken);
  }

  static clear() {
    localStorage.removeItem(this.ACCESS_KEY);
    localStorage.removeItem(this.REFRESH_KEY);
  }
}

// ─── Axios instance ───────────────────────────────────────────────────────────
const api: AxiosInstance = axios.create({
  baseURL: `${BASE_URL}/api/v1`,
  timeout: 30_000,
  headers: { 'Content-Type': 'application/json' }
});

// Request interceptor — attach access token
api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = TokenStore.getAccess();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

let isRefreshing = false;
let failedQueue: Array<{ resolve: (token: string) => void; reject: (err: unknown) => void }> = [];

function processQueue(error: unknown, token: string | null = null) {
  failedQueue.forEach(({ resolve, reject }) => (error ? reject(error) : resolve(token!)));
  failedQueue = [];
}

// ─── snake_case → camelCase normalization ─────────────────────────────────────
// Backend services (alert-service, etc.) return raw Postgres column names
// (started_at, economic_loss_usd, ...) but the frontend's types (Disaster,
// Alert, ...) are declared in camelCase (startedAt, economicLossUsd, ...).
// Without this, those fields are `undefined`, and anything that does
// `new Date(disaster.startedAt)` gets an Invalid Date, which throws a
// RangeError inside date-fns formatters and crashes the component tree.
function toCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function camelizeDeep(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(camelizeDeep);
  if (input && typeof input === 'object' && !(input instanceof Date)) {
    return Object.entries(input as Record<string, unknown>).reduce((acc, [k, v]) => {
      acc[toCamel(k)] = camelizeDeep(v);
      return acc;
    }, {} as Record<string, unknown>);
  }
  return input;
}

// Response interceptor — auto-refresh on 401
api.interceptors.response.use(
  (r) => {
    if (r.data && typeof r.data === 'object') {
      r.data = camelizeDeep(r.data);
    }
    return r;
  },
  async (error) => {
    const original = error.config;

    if (error.response?.status === 401 && !original._retry) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        }).then((token) => {
          original.headers.Authorization = `Bearer ${token}`;
          return api(original);
        });
      }

      original._retry = true;
      isRefreshing    = true;

      const refreshToken = TokenStore.getRefresh();
      if (!refreshToken) {
        TokenStore.clear();
        window.location.href = '/login';
        return Promise.reject(error);
      }

      try {
        const { data } = await axios.post(`${BASE_URL}/api/v1/auth/refresh`, { refreshToken });
        const tokens: AuthTokens = data.data.tokens;
        TokenStore.setTokens(tokens);
        processQueue(null, tokens.accessToken);
        original.headers.Authorization = `Bearer ${tokens.accessToken}`;
        return api(original);
      } catch (refreshError) {
        processQueue(refreshError);
        TokenStore.clear();
        window.location.href = '/login';
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  }
);

function unwrap<T>(response: AxiosResponse<ApiResponse<T>>): T {
  if (!response.data.data) throw new Error(response.data.message || 'No data returned');
  return response.data.data;
}

function unwrapList<T>(response: AxiosResponse<PaginatedResponse<T>>) {
  return { data: response.data.data, total: response.data.total, hasMore: response.data.hasMore };
}

// ─── Auth API ─────────────────────────────────────────────────────────────────
export const authApi = {
  register: async (payload: {
    email: string; password: string; name: string;
    role?: string; organisation?: string; country?: string; phone?: string;
  }) => {
    const r = await api.post<ApiResponse<{ user: User; tokens: AuthTokens }>>('/auth/register', payload);
    const { user, tokens } = unwrap(r);
    TokenStore.setTokens(tokens);
    return user;
  },

  login: async (email: string, password: string, totpCode?: string) => {
    const r = await api.post<ApiResponse<{ user: User; tokens: AuthTokens }>>('/auth/login', { email, password, totpCode });
    if (r.data.status === 'mfa_required') return { mfaRequired: true };
    const { user, tokens } = unwrap(r);
    TokenStore.setTokens(tokens);
    return { user, mfaRequired: false };
  },

  logout: async () => {
    await api.post('/auth/logout').catch(() => {});
    TokenStore.clear();
  },

  getMe: async (): Promise<User> => {
    const r = await api.get<ApiResponse<{ user: User }>>('/auth/me');
    return unwrap(r).user;
  },

  setupMFA: async () => {
    const r = await api.post<ApiResponse<{ secret: string; qrCode: string }>>('/auth/mfa/setup');
    return unwrap(r);
  },

  verifyMFA: async (code: string) => {
    await api.post('/auth/mfa/verify', { code });
  },

  changePassword: async (currentPassword: string, newPassword: string) => {
    await api.put('/auth/password', { currentPassword, newPassword });
  }
};

// ─── Disasters API ────────────────────────────────────────────────────────────
export const disastersApi = {
  list: async (query: DisasterQuery = {}) => {
    const r = await api.get<PaginatedResponse<Disaster>>('/disasters', { params: query });
    return unwrapList(r);
  },

  public: async (params: { type?: string; limit?: number } = {}) => {
    const r = await api.get<PaginatedResponse<Disaster>>('/disasters/public', { params });
    return unwrapList(r);
  },

  get: async (id: string): Promise<Disaster> => {
    const r = await api.get<ApiResponse<Disaster>>(`/disasters/${id}`);
    return unwrap(r);
  },

  create: async (payload: Partial<Disaster> & { lat?: number; lng?: number }): Promise<Disaster> => {
    const r = await api.post<ApiResponse<Disaster>>('/disasters', payload);
    return unwrap(r);
  },

  update: async (id: string, payload: Partial<Disaster>): Promise<Disaster> => {
    const r = await api.patch<ApiResponse<Disaster>>(`/disasters/${id}`, payload);
    return unwrap(r);
  }
};

// ─── Alerts API ───────────────────────────────────────────────────────────────
export const alertsApi = {
  list: async (params: { disasterId?: string; severity?: string; limit?: number } = {}) => {
    const r = await api.get<PaginatedResponse<Alert>>('/alerts', { params });
    return unwrapList(r);
  },

  public: async (params: { limit?: number } = {}) => {
    const r = await api.get<PaginatedResponse<Alert>>('/alerts/public', { params });
    return unwrapList(r);
  },

  create: async (payload: {
    disasterId?: string; title: string; message: string; severity: string;
    lat?: number; lng?: number; radiusKm?: number; channels?: string[]; languages?: string[];
  }): Promise<Alert> => {
    const r = await api.post<ApiResponse<Alert>>('/alerts', payload);
    return unwrap(r);
  }
};

// ─── Predictions API ──────────────────────────────────────────────────────────
export const predictionsApi = {
  list: async (params: { disasterType?: string; active?: boolean } = {}) => {
    const r = await api.get<PaginatedResponse<Prediction>>('/predictions', { params });
    return unwrapList(r);
  }
};

// ─── SOS API ──────────────────────────────────────────────────────────────────
export const sosApi = {
  submit: async (payload: {
    type: string; lat: number; lng: number; address?: string; peopleCount?: number;
    description?: string; contactPhone?: string; mediaUrls?: string[]; isAnonymous?: boolean;
  }) => {
    const r = await api.post<ApiResponse<{
      sosId: string; status: string; aiSeverity: string; aiConfidence: number;
      immediateActions: string[]; safetyGuidance: string; recommendedTeam: string;
      trackingUrl: string; disasterId?: string;
    }>>('/sos', payload);
    return unwrap(r);
  },

  list: async (params: { status?: string; severity?: string; disasterId?: string; limit?: number } = {}) => {
    const r = await api.get<PaginatedResponse<SOSReport>>('/sos/reports', { params });
    return unwrapList(r);
  },

  get: async (id: string): Promise<SOSReport> => {
    const r = await api.get<ApiResponse<SOSReport>>(`/sos/reports/${id}`);
    return unwrap(r);
  },

  update: async (id: string, payload: { status?: string; assignedTeamId?: string }): Promise<SOSReport> => {
    const r = await api.patch<ApiResponse<SOSReport>>(`/sos/reports/${id}`, payload);
    return unwrap(r);
  },

  getStats: async () => {
    const r = await api.get<ApiResponse<Record<string, number>>>('/sos/stats');
    return unwrap(r);
  }
};

// ─── Shelters API ─────────────────────────────────────────────────────────────
export const sheltersApi = {
  list: async (params: { disasterId?: string; lat?: number; lng?: number; radiusKm?: number; status?: string } = {}) => {
    const r = await api.get<PaginatedResponse<Shelter>>('/shelters', { params });
    return unwrapList(r);
  }
};

// ─── Resources API ────────────────────────────────────────────────────────────
export const resourcesApi = {
  list: async (params: { category?: string; disasterId?: string } = {}) => {
    const r = await api.get<PaginatedResponse<Resource>>('/resources', { params });
    return unwrapList(r);
  }
};

// ─── AI API ───────────────────────────────────────────────────────────────────
export const aiApi = {
  analyse: async (payload: {
    disasterId?: string; query: string; context?: string;
    includeHistorical?: boolean; outputFormat?: 'narrative' | 'structured' | 'brief'; sessionId?: string;
  }) => {
    const r = await api.post<ApiResponse<{ analysisId: string; analysis: string; sessionId: string }>>('/ai/analyse', payload);
    return unwrap(r);
  },

  similarity: async (payload: {
    disasterType: string; magnitude?: number; country?: string;
    affectedPop?: number; description: string;
  }) => {
    const r = await api.post<ApiResponse<{ similarEvents: string; query: unknown }>>('/ai/similarity', payload);
    return unwrap(r);
  },

  situationReport: async (disasterData: Disaster, audience?: string) => {
    const r = await api.post<ApiResponse<{ sitrep: string; generatedAt: string }>>('/ai/situation-report', { disasterData, audience });
    return unwrap(r);
  },

  policyBrief: async (payload: { country: string; focusAreas?: string[]; timeHorizon?: string }) => {
    const r = await api.post<ApiResponse<{ briefId: string; country: string; brief: string }>>('/ai/policy-brief', payload);
    return unwrap(r);
  }
};

// ─── Historical API ───────────────────────────────────────────────────────────
export const historicalApi = {
  list: async (params: { type?: string; country?: string; year?: number; limit?: number } = {}) => {
    const r = await api.get<PaginatedResponse<HistoricalEvent>>('/historical', { params });
    return unwrapList(r);
  },
  stats: async () => {
    const r = await api.get<ApiResponse<any>>('/historical/stats/aggregate');
    return unwrap(r);
  }
};

// ─── System health API (Admin Portal) ─────────────────────────────────────────
export const systemApi = {
  health: async () => {
    const r = await api.get<ApiResponse<any>>('/system/health');
    return unwrap(r);
  }
};

// ─── GIS / Risk API ───────────────────────────────────────────────────────────
export const riskApi = {
  listCountries: async () => {
    const r = await api.get<PaginatedResponse<CountryRiskScore>>('/risk/countries');
    return unwrapList(r);
  },

  getCountry: async (iso2: string): Promise<CountryRiskScore> => {
    const r = await api.get<ApiResponse<CountryRiskScore>>(`/risk/countries/${iso2}`);
    return unwrap(r);
  }
};

// ─── Social Intelligence API ──────────────────────────────────────────────────
export const socialApi = {
  list: async (params: { disasterId?: string; verified?: boolean; limit?: number } = {}) => {
    const r = await api.get<PaginatedResponse<SocialSignal>>('/social', { params });
    return unwrapList(r);
  }
};

export { TokenStore };
export default api;
