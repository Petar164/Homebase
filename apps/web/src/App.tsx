import type { SessionInfo } from "@homebase/shared";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api.ts";
import { Brain } from "./components/Brain.tsx";
import { Main } from "./MainScreen.tsx";
import { SalesScreen } from "./SalesScreen.tsx";

/**
 * Decides between the login page and the main screen. This is a courtesy to
 * the person in front of it, not the protection: the core refuses every
 * data request without a valid session, whatever this page shows.
 */
export function App() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  // Which screen is showing follows the address (#/sales), so the browser's
  // back button and a bookmark both work.
  const [route, setRoute] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setRoute(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  const refresh = useCallback(() => {
    api<SessionInfo>("GET", "/api/auth/session")
      .then(setSession)
      .catch(() => setSession({ authenticated: false, ownerExists: true, elevated: false, username: null }));
  }, []);
  useEffect(refresh, [refresh]);

  if (!session) return <div className="h-full bg-void" />;
  if (!session.authenticated) return <Login session={session} onDone={refresh} />;
  if (route === "#/sales") return <SalesScreen onBack={() => (window.location.hash = "")} />;
  return <Main onLoggedOut={refresh} />;
}

function Login({ session, onDone }: { session: SessionInfo; onDone: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("POST", "/api/auth/login", { username, password });
      onDone();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "The core is not answering.");
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  const field = "w-full rounded-md border border-line bg-ink px-4 py-3 text-base text-bone outline-none focus:border-salmon/60";

  return (
    <div className="relative flex h-full items-center justify-center overflow-hidden bg-void px-6">
      <div className="pointer-events-none absolute inset-0 opacity-40">
        <Brain state="idle" />
      </div>
      <div className="relative w-full max-w-sm">
        <p className="label">Home Base</p>
        <h1 className="mt-2 text-4xl font-light tracking-tight">HELIOS</h1>

        {session.ownerExists ? (
          <form onSubmit={submit} className="mt-8 space-y-4">
            <label className="block">
              <span className="label">Username</span>
              <input className={`${field} mt-2`} value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoFocus required />
            </label>
            <label className="block">
              <span className="label">Password</span>
              <input className={`${field} mt-2`} type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
            </label>
            {error && (
              <p role="alert" className="text-sm text-salmon">
                {error}
              </p>
            )}
            <button type="submit" disabled={busy} className="w-full rounded-md bg-bone px-4 py-3 text-base font-medium text-void transition hover:bg-white disabled:opacity-50">
              {busy ? "Checking…" : "Log in"}
            </button>
          </form>
        ) : (
          <div className="mt-8 space-y-3 text-base text-soft">
            <p>There is no owner account yet. Accounts are created on this machine, never through this page.</p>
            <p>In the Home Base folder, run:</p>
            <pre className="rounded-md border border-line bg-ink px-4 py-3 font-mono text-sm text-bone">npm run homebase -- owner set-password</pre>
            <button type="button" onClick={onDone} className="rounded-md border border-line px-4 py-2 text-sm text-bone hover:border-mute">
              I have done that
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
