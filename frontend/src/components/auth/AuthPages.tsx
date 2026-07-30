// ─── AEGIS GLOBAL — Auth Pages ───────────────────────────────────────────────
import React, { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { authApi } from '../../utils/api';
import { useAuthStore, useUIStore } from '../../store';

// ─── Shared form input ────────────────────────────────────────────────────────
function Field({
  label, type = 'text', value, onChange, placeholder, required = false, hint
}: {
  label: string; type?: string; value: string; onChange: (v: string) => void;
  placeholder?: string; required?: boolean; hint?: string;
}) {
  return (
    <div>
      <label className="block text-xs text-slate-400 mb-1">{label}{required && <span className="text-red-400 ml-0.5">*</span>}</label>
      <input
        type={type} value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder} required={required}
        className="w-full bg-[#141b2d] border border-[#1e2d4a] rounded-lg px-3 py-2.5 text-sm text-slate-200 placeholder-slate-600 outline-none focus:border-blue-500/60 transition-colors"
      />
      {hint && <div className="text-xs text-slate-600 mt-1">{hint}</div>}
    </div>
  );
}

// ─── Logo block ───────────────────────────────────────────────────────────────
function AuthLogo() {
  return (
    <div className="text-center mb-8">
      <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-2xl mx-auto mb-3 shadow-lg shadow-blue-500/25">🌍</div>
      <div className="text-xl font-bold tracking-wide">AEGIS GLOBAL</div>
      <div className="text-xs text-slate-500 mt-0.5 uppercase tracking-wider">Disaster Intelligence Platform</div>
    </div>
  );
}

// ─── LOGIN PAGE ───────────────────────────────────────────────────────────────
export function LoginPage() {
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [totp,     setTotp]     = useState('');
  const [mfaMode,  setMfaMode]  = useState(false);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState('');

  const { setUser }           = useAuthStore();
  const { addNotification }   = useUIStore();
  const navigate              = useNavigate();
  const location              = useLocation();
  const from                  = (location.state as any)?.from?.pathname || '/';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await authApi.login(email, password, mfaMode ? totp : undefined);
      if ((result as any).mfaRequired) {
        setMfaMode(true);
        setLoading(false);
        return;
      }
      setUser((result as any).user);
      addNotification(`Welcome back, ${(result as any).user.name}`, 'success');
      navigate(from, { replace: true });
    } catch (err: any) {
      setError(err.response?.data?.message || 'Login failed. Please check your credentials.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0e1a] flex items-center justify-center p-4">
      {/* Background gradient */}
      <div className="absolute inset-0 bg-gradient-to-br from-blue-950/30 via-transparent to-purple-950/20 pointer-events-none" />

      <div className="w-full max-w-sm relative">
        <AuthLogo />

        <div className="bg-[#0f1523] border border-[#1e2d4a] rounded-2xl p-6 shadow-2xl">
          {!mfaMode ? (
            <>
              <div className="text-base font-semibold mb-5">Sign in to your account</div>
              <form onSubmit={handleSubmit} className="space-y-4">
                <Field label="Email address" type="email" value={email} onChange={setEmail}
                  placeholder="you@organisation.gov" required />
                <Field label="Password" type="password" value={password} onChange={setPassword}
                  placeholder="••••••••••••" required />

                {error && (
                  <div className="bg-red-950/40 border border-red-800 rounded-lg px-3 py-2 text-xs text-red-400">{error}</div>
                )}

                <button type="submit" disabled={loading || !email || !password}
                  className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white rounded-lg py-2.5 text-sm font-semibold transition-colors">
                  {loading ? 'Signing in…' : 'Sign in'}
                </button>
              </form>
            </>
          ) : (
            <>
              <div className="text-base font-semibold mb-2">Two-factor authentication</div>
              <div className="text-xs text-slate-500 mb-5">Enter the 6-digit code from your authenticator app</div>
              <form onSubmit={handleSubmit} className="space-y-4">
                <Field label="Authenticator code" value={totp} onChange={setTotp}
                  placeholder="000000" hint="6-digit TOTP code" required />
                {error && (
                  <div className="bg-red-950/40 border border-red-800 rounded-lg px-3 py-2 text-xs text-red-400">{error}</div>
                )}
                <button type="submit" disabled={loading || totp.length !== 6}
                  className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white rounded-lg py-2.5 text-sm font-semibold transition-colors">
                  {loading ? 'Verifying…' : 'Verify'}
                </button>
                <button type="button" onClick={() => { setMfaMode(false); setTotp(''); }}
                  className="w-full text-xs text-slate-500 hover:text-slate-300">
                  ← Back to login
                </button>
              </form>
            </>
          )}

          <div className="mt-5 pt-4 border-t border-[#1e2d4a] text-center">
            <span className="text-xs text-slate-600">Don't have an account? </span>
            <a href="/register" className="text-xs text-blue-400 hover:text-blue-300">Register</a>
          </div>
        </div>

        {/* Demo credentials hint */}
        <div className="mt-4 bg-[#0f1523]/80 border border-[#1e2d4a] rounded-xl p-3 text-center">
          <div className="text-xs text-slate-500 mb-1">Demo credentials</div>
          <div className="text-xs font-mono text-slate-400">admin@aegisglobal.io</div>
          <div className="text-xs font-mono text-slate-400">AegisAdmin2025!</div>
        </div>
      </div>
    </div>
  );
}

// ─── REGISTER PAGE ────────────────────────────────────────────────────────────
export function RegisterPage() {
  const [form, setForm] = useState({
    email: '', password: '', confirmPassword: '', name: '',
    role: 'citizen' as string, organisation: '', country: '', phone: ''
  });
  const [loading, setLoading]   = useState(false);
  const [error,   setError]     = useState('');
  const [success, setSuccess]   = useState(false);

  const { setUser }           = useAuthStore();
  const { addNotification }   = useUIStore();
  const navigate              = useNavigate();

  const set = (k: keyof typeof form) => (v: string) => setForm(p => ({ ...p, [k]: v }));

  const validate = (): string | null => {
    if (!form.email)    return 'Email is required';
    if (!form.name)     return 'Name is required';
    if (!form.password) return 'Password is required';
    if (form.password.length < 8) return 'Password must be at least 8 characters';
    if (!/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])/.test(form.password))
      return 'Password needs uppercase, lowercase, number, and special character';
    if (form.password !== form.confirmPassword) return 'Passwords do not match';
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const validationError = validate();
    if (validationError) { setError(validationError); return; }
    setError('');
    setLoading(true);
    try {
      const user = await authApi.register({
        email:        form.email,
        password:     form.password,
        name:         form.name,
        role:         form.role,
        organisation: form.organisation || undefined,
        country:      form.country      || undefined,
        phone:        form.phone        || undefined
      });
      setUser(user);
      setSuccess(true);
      addNotification(`Welcome to AEGIS, ${user.name}!`, 'success');
      setTimeout(() => navigate('/'), 1500);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Registration failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="min-h-screen bg-[#0a0e1a] flex items-center justify-center">
        <div className="text-center">
          <div className="text-4xl mb-3">✓</div>
          <div className="text-lg font-semibold text-green-400">Account created!</div>
          <div className="text-sm text-slate-500 mt-1">Redirecting to dashboard…</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0e1a] flex items-center justify-center p-4 py-10">
      <div className="absolute inset-0 bg-gradient-to-br from-blue-950/20 via-transparent to-purple-950/10 pointer-events-none" />

      <div className="w-full max-w-md relative">
        <AuthLogo />

        <div className="bg-[#0f1523] border border-[#1e2d4a] rounded-2xl p-6 shadow-2xl">
          <div className="text-base font-semibold mb-5">Create your account</div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <Field label="Full name" value={form.name} onChange={set('name')}
                  placeholder="Dr. Jane Smith" required />
              </div>
              <div className="col-span-2">
                <Field label="Email address" type="email" value={form.email} onChange={set('email')}
                  placeholder="you@organisation.gov" required />
              </div>
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1">Role <span className="text-red-400">*</span></label>
              <select value={form.role} onChange={e => set('role')(e.target.value)}
                className="w-full bg-[#141b2d] border border-[#1e2d4a] rounded-lg px-3 py-2.5 text-sm text-slate-200 outline-none focus:border-blue-500/60">
                <option value="citizen">Citizen</option>
                <option value="first_responder">First Responder</option>
                <option value="ngo_coordinator">NGO Coordinator</option>
                <option value="research_analyst">Research Analyst</option>
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Organisation" value={form.organisation} onChange={set('organisation')}
                placeholder="FEMA / UN OCHA / etc." />
              <div>
                <label className="block text-xs text-slate-400 mb-1">Country</label>
                <input type="text" value={form.country} onChange={e => set('country')(e.target.value.toUpperCase().slice(0, 2))}
                  placeholder="US" maxLength={2}
                  className="w-full bg-[#141b2d] border border-[#1e2d4a] rounded-lg px-3 py-2.5 text-sm text-slate-200 placeholder-slate-600 outline-none focus:border-blue-500/60 uppercase" />
              </div>
            </div>

            <Field label="Phone (optional)" type="tel" value={form.phone} onChange={set('phone')}
              placeholder="+1 555 000 0000"
              hint="Used for emergency SMS alerts" />

            <Field label="Password" type="password" value={form.password} onChange={set('password')}
              placeholder="Min 8 chars, upper + lower + number + symbol" required />

            <Field label="Confirm password" type="password" value={form.confirmPassword} onChange={set('confirmPassword')}
              placeholder="Re-enter password" required />

            {error && (
              <div className="bg-red-950/40 border border-red-800 rounded-lg px-3 py-2 text-xs text-red-400">{error}</div>
            )}

            <button type="submit" disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white rounded-lg py-2.5 text-sm font-semibold transition-colors">
              {loading ? 'Creating account…' : 'Create account'}
            </button>
          </form>

          <div className="mt-5 pt-4 border-t border-[#1e2d4a] text-center">
            <span className="text-xs text-slate-600">Already have an account? </span>
            <a href="/login" className="text-xs text-blue-400 hover:text-blue-300">Sign in</a>
          </div>
        </div>
      </div>
    </div>
  );
}
