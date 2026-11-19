import { AREA_NAME, DAYS, type DayOverview, type HeliosState, type HeliosStatus, type Overview, relDay, type SystemStatus, type Task } from "@homebase/shared";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api.ts";
import { Brain } from "./components/Brain.tsx";
import { Conversation } from "./components/Conversation.tsx";

// The main screen: the brain in the middle, with what matters today around
// it. Built for a TV across the room, so it shows a little, large.

const OVERVIEW_SECONDS = 20;

/** How each state is named on screen. */
const STATE_LABEL: Record<HeliosState, string> = {
  idle: "Idle",
  listening: "Listening",
  transcribing: "Transcribing",
  thinking: "Thinking",
  retrieving: "Searching memory",
  browsing: "Searching the web",
  speaking: "Speaking",
  acting: "Working",
  presenting: "Presenting",
  error: "Something needs attention",
};
const STATUS_SECONDS = 60;

function useNow(everyMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

/** "3 min ago", "5 h ago", "2 d ago". */
function ago(iso: string | null, now: Date): string {
  if (!iso) return "never";
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 48) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} d ago`;
}

export function Main({ onLoggedOut }: { onLoggedOut: () => void }) {
  const now = useNow(1000);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [offline, setOffline] = useState(false);
  const [heliosState, setHeliosState] = useState<HeliosState>("idle");
  const [helios, setHelios] = useState<HeliosStatus | null>(null);

  const load = useCallback(
    async <T,>(path: string, set: (value: T) => void) => {
      try {
        set(await api<T>("GET", path));
        setOffline(false);
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) onLoggedOut();
        else setOffline(true);
      }
    },
    [onLoggedOut],
  );
  const loadOverview = useCallback(() => load<Overview>("/api/overview", setOverview), [load]);
  const loadStatus = useCallback(async () => {
    await load<SystemStatus>("/api/system/status", setStatus);
    await load<HeliosStatus>("/api/helios/status", setHelios);
  }, [load]);

  // When HELIOS finishes doing something, the numbers may have changed.
  const onHeliosState = useCallback(
    (state: HeliosState) => {
      setHeliosState(state);
      if (state === "idle") void loadOverview();
    },
    [loadOverview],
  );

  useEffect(() => {
    void loadOverview();
    void loadStatus();
    const overviewTimer = setInterval(loadOverview, OVERVIEW_SECONDS * 1000);
    const statusTimer = setInterval(loadStatus, STATUS_SECONDS * 1000);
    return () => {
      clearInterval(overviewTimer);
      clearInterval(statusTimer);
    };
  }, [loadOverview, loadStatus]);

  const complete = async (task: Task) => {
    await api("PATCH", `/api/tasks/${task.id}`, { done: true, doneAt: overview?.today ?? "" }).catch(() => {});
    void loadOverview();
  };
  const logout = async () => {
    await api("POST", "/api/auth/logout", {}).catch(() => {});
    onLoggedOut();
  };

  // After 21:00 (and until the morning) the screen dims.
  const ambient = now.getHours() >= 21 || now.getHours() < 6;
  const time = now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  const date = now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });

  return (
    <div className={`screen relative h-full min-h-[38rem] overflow-hidden bg-void ${ambient ? "ambient" : ""}`}>
      {/* The glow behind the brain, and the brain itself, fill the screen. */}
      <div className="pointer-events-none absolute inset-0" style={{ background: "radial-gradient(ellipse 55% 60% at 50% 48%, rgba(43, 27, 61, 0.55), transparent 70%)" }} />
      <div className="pointer-events-none absolute inset-x-[14%] inset-y-[6%]">
        <Brain state={heliosState} ambient={ambient} growth={0.05} />
      </div>

      {/* Everything else sits around it, inside margins that survive TV overscan. */}
      <div className="relative grid h-full grid-cols-[minmax(0,22rem)_1fr_minmax(0,18rem)] grid-rows-[auto_1fr_auto] gap-x-6 px-[4vw] py-[4vh]">
        <header className="drift col-span-1">
          <p className="text-7xl leading-none font-extralight tabular-nums tracking-tight">{time}</p>
          <p className="mt-2 text-lg text-soft">{date}</p>
        </header>

        <div className="col-start-3 row-start-1 text-right">
          <p className="label">Helios</p>
          <p className="mt-1 text-lg text-bone">
            <span className="mr-2 inline-block h-2 w-2 rounded-full bg-salmon align-middle" />
            {offline ? "Core not answering" : STATE_LABEL[heliosState]}
          </p>
          {status && (
            <div className="mt-3 space-y-1 text-sm text-mute">
              {helios && <ModelLine helios={helios} />}
              {helios?.cloud && <CloudLine cloud={helios.cloud} onChanged={loadStatus} />}
              {helios?.web && <WebLine web={helios.web} onChanged={loadStatus} />}
              <p>
                Last snapshot <span className="text-soft">{ago(status.snapshots.newestAt, now)}</span>
              </p>
              {status.mirrors.length === 0 ? (
                <p className="text-salmon/80">No second backup location</p>
              ) : (
                status.mirrors.map((mirror) => (
                  <p key={mirror.path} className={mirror.connected ? "" : "text-salmon/80"}>
                    External copy <span className="text-soft">{mirror.connected ? ago(mirror.newestAt, now) : "not connected"}</span>
                  </p>
                ))
              )}
              {!status.audit.ok && <p className="text-salmon">Audit log needs attention</p>}
              <p>
                v{status.version} · schema {status.schemaVersion}
              </p>
            </div>
          )}
        </div>

        <section className="col-start-1 row-start-2 mt-10 min-h-0 overflow-hidden">
          {overview ? <Planning overview={overview} onComplete={complete} onAdded={loadOverview} /> : <p className="text-mute">Loading…</p>}
        </section>

        <section className="col-start-2 row-start-2 min-h-0">
          <Conversation onState={onHeliosState} onChanged={loadOverview} />
        </section>

        <section className="col-start-3 row-start-2 mt-10 flex min-h-0 flex-col items-end gap-8 text-right">
          {overview && <Numbers overview={overview} />}
          <div className="mt-auto flex gap-5 text-xs tracking-widest uppercase">
            <a href="#/sales" className="text-mute hover:text-bone">
              Sales
            </a>
            <button type="button" onClick={logout} className="tracking-widest text-mute uppercase hover:text-bone">
              Log out
            </button>
          </div>
        </section>

        <footer className="col-span-3 row-start-3 mt-6">{overview && <Week days={overview.week} today={overview.today} />}</footer>
      </div>
    </div>
  );
}

/** Which model would answer right now, and what the cloud has cost this month. */
function ModelLine({ helios }: { helios: HeliosStatus }) {
  // A cloud model with a key counts only once the owner has switched cloud models on.
  const real = helios.models.filter((model) => model.id !== "standin" && model.available && (model.location === "local" || helios.cloudEnabled));
  const usesCloud = real.some((model) => model.location === "cloud");
  return (
    <>
      <p>
        Model <span className={real.length > 0 ? "text-soft" : "text-salmon/80"}>{real.length > 0 ? real.map((model) => model.model).join(", ") : "none connected (stand-in)"}</span>
      </p>
      {usesCloud && (
        <p className={helios.budget.state === "ok" ? "" : "text-salmon/80"}>
          Cloud this month{" "}
          <span className="text-soft">
            €{helios.budget.spentEur.toFixed(2)} of €{helios.budget.capEur.toFixed(0)}
          </span>
        </p>
      )}
    </>
  );
}

/**
 * Whether HELIOS may use the web, and the switch for it. Off works at once.
 * On lets more leave this machine, so the core asks for the password again.
 */
function WebLine({ web, onChanged }: { web: HeliosStatus["web"]; onChanged: () => void }) {
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const set = async (enabled: boolean) => {
    setError("");
    try {
      await api("PUT", "/api/web/settings", { enabled });
      setAsking(false);
      setPassword("");
      onChanged();
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 403) setAsking(true);
      else setError(caught instanceof ApiError ? caught.message : "The core is not answering.");
    }
  };
  const confirm = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api("POST", "/api/auth/elevate", { password });
    } catch (caught) {
      setPassword("");
      setError(caught instanceof ApiError ? caught.message : "The core is not answering.");
      return;
    }
    await set(true);
  };

  const state = !web.enabled ? "off" : web.ready ? `on · ${web.service}${web.confirmEvery ? " · asks every time" : ""}` : "on · no search key";
  return (
    <>
      <p>
        Web access <span className={web.enabled && !web.ready ? "text-salmon/80" : "text-soft"}>{state}</span>
        <button type="button" onClick={() => void set(!web.enabled)} aria-pressed={web.enabled} className="ml-3 text-xs tracking-widest text-mute uppercase hover:text-bone">
          Turn {web.enabled ? "off" : "on"}
        </button>
      </p>
      {asking && (
        <form onSubmit={confirm} className="flex items-center justify-end gap-2">
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            autoFocus
            required
            aria-label="Your password, to turn web access on"
            placeholder="Password, to turn it on"
            className="w-44 border-b border-line bg-transparent py-1 text-sm text-bone outline-none placeholder:text-mute focus:border-salmon/60"
          />
          <button type="submit" className="text-xs tracking-widest text-soft uppercase hover:text-bone">
            Confirm
          </button>
          <button type="button" onClick={() => setAsking(false)} className="text-xs tracking-widest text-mute uppercase hover:text-bone">
            Cancel
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="text-salmon">
          {error}
        </p>
      )}
    </>
  );
}

/**
 * Whether HELIOS may send a conversation to a cloud model, and the switch
 * for it. Off works at once. On lets conversations leave this machine and
 * can cost money, so the core asks for the password again.
 */
function CloudLine({ cloud, onChanged }: { cloud: HeliosStatus["cloud"]; onChanged: () => void }) {
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const set = async (enabled: boolean) => {
    setError("");
    try {
      await api("PUT", "/api/ai/cloud", { enabled });
      setAsking(false);
      setPassword("");
      onChanged();
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 403) setAsking(true);
      else setError(caught instanceof ApiError ? caught.message : "The core is not answering.");
    }
  };
  const confirm = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api("POST", "/api/auth/elevate", { password });
    } catch (caught) {
      setPassword("");
      setError(caught instanceof ApiError ? caught.message : "The core is not answering.");
      return;
    }
    await set(true);
  };

  const state = !cloud.enabled ? "off" : cloud.ready ? `on · ${cloud.service}` : `on · ${cloud.problem}`;
  return (
    <>
      <p>
        Cloud models <span className={cloud.enabled && !cloud.ready ? "text-salmon/80" : "text-soft"}>{state}</span>
        <button type="button" onClick={() => void set(!cloud.enabled)} aria-pressed={cloud.enabled} className="ml-3 text-xs tracking-widest text-mute uppercase hover:text-bone">
          Turn {cloud.enabled ? "off" : "on"}
        </button>
      </p>
      {asking && (
        <form onSubmit={confirm} className="flex items-center justify-end gap-2">
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            autoFocus
            required
            aria-label="Your password, to turn cloud models on"
            placeholder="Password, to turn it on"
            className="w-44 border-b border-line bg-transparent py-1 text-sm text-bone outline-none placeholder:text-mute focus:border-salmon/60"
          />
          <button type="submit" className="text-xs tracking-widest text-soft uppercase hover:text-bone">
            Confirm
          </button>
          <button type="button" onClick={() => setAsking(false)} className="text-xs tracking-widest text-mute uppercase hover:text-bone">
            Cancel
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="text-salmon">
          {error}
        </p>
      )}
    </>
  );
}

function TaskLine({ task, today, onComplete }: { task: Task; today: string; onComplete: (task: Task) => void }) {
  const late = task.due !== "" && task.due < today;
  return (
    <li className="flex items-start gap-3 py-1.5">
      <button
        type="button"
        onClick={() => onComplete(task)}
        aria-label={`Mark "${task.title}" as done`}
        className="mt-1 h-4 w-4 shrink-0 rounded-full border border-mute transition hover:border-salmon hover:bg-salmon/20"
      />
      <div className="min-w-0">
        <p className="truncate text-base text-bone">{task.title}</p>
        <p className={`text-xs ${late ? "text-salmon" : "text-mute"}`}>
          {AREA_NAME[task.area] ?? "Inbox"}
          {task.due && ` · ${relDay(task.due, today)}`}
        </p>
      </div>
    </li>
  );
}

function Planning({ overview, onComplete, onAdded }: { overview: Overview; onComplete: (task: Task) => void; onAdded: () => void }) {
  const [title, setTitle] = useState("");
  const { focus, today } = overview;
  const rest = [...overview.late, ...overview.dueThisWeek].filter((task) => task.id !== focus?.id);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    await api("POST", "/api/tasks", { title, area: "inbox" }).catch(() => {});
    setTitle("");
    onAdded();
  };

  return (
    <div className="flex h-full flex-col">
      <p className="label">Today's focus</p>
      {focus ? (
        <div className="mt-2 border-l border-salmon/70 pl-4">
          <p className="text-2xl leading-snug font-light text-bone">{focus.title}</p>
          <p className={`mt-1 text-sm ${focus.due && focus.due < today ? "text-salmon" : "text-soft"}`}>
            {AREA_NAME[focus.area] ?? "Inbox"}
            {focus.due && ` · ${relDay(focus.due, today)}`}
          </p>
          <button type="button" onClick={() => onComplete(focus)} className="mt-3 rounded-md border border-line px-3 py-1 text-xs tracking-widest text-soft uppercase hover:border-salmon hover:text-bone">
            Done
          </button>
        </div>
      ) : (
        <p className="mt-2 text-xl font-light text-soft">Nothing open. Add the next thing.</p>
      )}

      <p className="label mt-8">
        {overview.late.length > 0 ? `${overview.late.length} late · ` : ""}
        {overview.dueThisWeek.length} due this week
      </p>
      <ul className="mt-2 min-h-0 flex-1 overflow-hidden">
        {/* Due tasks first, then whatever is next, so a task that was just added is visible. */}
        {[...rest, ...overview.later.filter((task) => task.id !== focus?.id)].slice(0, 7).map((task) => (
          <TaskLine key={task.id} task={task} today={today} onComplete={onComplete} />
        ))}
      </ul>

      <form onSubmit={add} className="mt-3">
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={200}
          placeholder="Add a task…"
          aria-label="Add a task"
          className="w-full border-b border-line bg-transparent py-2 text-base text-bone outline-none placeholder:text-mute focus:border-salmon/60"
        />
      </form>
    </div>
  );
}

function Numbers({ overview }: { overview: Overview }) {
  const { have, goal } = overview.savings;
  const money = (amount: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: overview.currency, maximumFractionDigits: 0 }).format(amount);
  return (
    <>
      <div>
        <p className="label">Open</p>
        <p className="text-5xl font-extralight tabular-nums">{overview.openCount}</p>
      </div>
      <div>
        <p className="label">Done this week</p>
        <p className="text-5xl font-extralight tabular-nums">{overview.doneThisWeek}</p>
      </div>
      {goal > 0 && (
        <div className="w-full max-w-[14rem]">
          <p className="label">Savings</p>
          <p className="text-2xl font-light tabular-nums">
            {money(have)} <span className="text-base text-mute">of {money(goal)}</span>
          </p>
          <div className="mt-2 h-px w-full bg-line">
            <div className="h-px bg-salmon" style={{ width: `${Math.min(100, (have / goal) * 100)}%` }} />
          </div>
        </div>
      )}
    </>
  );
}

function Week({ days, today }: { days: DayOverview[]; today: string }) {
  return (
    <div className="grid grid-cols-7 gap-3 border-t border-line pt-3">
      {days.map((day, index) => {
        const isToday = day.date === today;
        const items = [
          ...day.classes.map((slot) => ({ time: slot.s, text: slot.name })),
          ...day.events.map((event) => ({ time: event.s, text: event.title })),
          ...day.training.map((session) => ({ time: session.time, text: session.kind === "mma" ? "MMA (logged)" : "Gym (logged)" })),
        ].sort((a, b) => a.time.localeCompare(b.time));
        return (
          <div key={day.date} className={isToday ? "" : "opacity-60"}>
            <p className={`text-xs tracking-widest uppercase ${isToday ? "text-salmon" : "text-mute"}`}>
              {DAYS[index]?.slice(0, 3)} {Number(day.date.slice(8))}
            </p>
            <ul className="mt-1 space-y-0.5 text-[0.8rem] leading-snug text-soft">
              {items.slice(0, 4).map((item, itemIndex) => (
                <li key={itemIndex} className="truncate">
                  {item.time && <span className="mr-1 text-mute tabular-nums">{item.time}</span>}
                  {item.text}
                </li>
              ))}
              {items.length > 4 && <li className="text-mute">+{items.length - 4} more</li>}
              {day.tasksDue > 0 && (
                <li className={isToday ? "text-salmon" : "text-mute"}>
                  {day.tasksDue} {day.tasksDue === 1 ? "task" : "tasks"} due
                </li>
              )}
              {items.length === 0 && day.tasksDue === 0 && <li className="text-mute/60">—</li>}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
