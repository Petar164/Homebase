import type { Config } from "../config.ts";
import type { Manifest } from "./store.ts";

type Policy = Config["backup"]["retention"];
type Snapshot = Pick<Manifest, "id" | "createdAt" | "kind">;

const DAY_MS = 24 * 60 * 60 * 1000;

/** "2026-W46": the ISO week a date falls in. */
function weekKey(date: Date): string {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  return `${day.getUTCFullYear()}-W${Math.ceil(((day.getTime() - yearStart) / DAY_MS + 1) / 7)}`;
}

/**
 * Decides which snapshots are old enough to remove. The schedule thins out
 * with age:
 *
 *   - everything from the last `dailyDays` days is kept
 *   - then the newest snapshot of each week, for `weeklyWeeks` weeks
 *   - then the newest snapshot of each month, for `monthlyMonths` months
 *   - safety snapshots (taken before a migration, update or restore) are
 *     kept for `safetyDays` days and are not part of the thinning
 *   - the newest snapshot is always kept, whatever its age
 */
export function snapshotsToDelete(snapshots: Snapshot[], now: Date, policy: Policy): string[] {
  const sorted = [...snapshots].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); // newest first
  const keep = new Set<string>();
  if (sorted[0]) keep.add(sorted[0].id);

  const weeksSeen = new Set<string>();
  const monthsSeen = new Set<string>();
  for (const snapshot of sorted) {
    const taken = new Date(snapshot.createdAt);
    const ageDays = (now.getTime() - taken.getTime()) / DAY_MS;

    if (snapshot.kind.startsWith("pre_")) {
      if (ageDays <= policy.safetyDays) keep.add(snapshot.id);
      continue;
    }
    // Three independent rules; a snapshot is kept if any of them keeps it.
    // The list is newest first, so the first snapshot seen for a week or a
    // month is the newest one of that week or month.
    if (ageDays <= policy.dailyDays) keep.add(snapshot.id);

    const week = weekKey(taken);
    if (!weeksSeen.has(week)) {
      weeksSeen.add(week);
      if (ageDays <= policy.dailyDays + policy.weeklyWeeks * 7) keep.add(snapshot.id);
    }
    const month = snapshot.createdAt.slice(0, 7);
    if (!monthsSeen.has(month)) {
      monthsSeen.add(month);
      if (ageDays <= policy.monthlyMonths * 31) keep.add(snapshot.id);
    }
  }
  return sorted.filter((snapshot) => !keep.has(snapshot.id)).map((snapshot) => snapshot.id);
}

/** True when it is time for the next scheduled snapshot. */
export function scheduledSnapshotDue(snapshots: Snapshot[], now: Date, intervalHours: number): boolean {
  const last = snapshots
    .filter((snapshot) => snapshot.kind === "scheduled" || snapshot.kind === "manual")
    .map((snapshot) => new Date(snapshot.createdAt).getTime())
    .sort((a, b) => b - a)[0];
  return last === undefined || now.getTime() - last >= intervalHours * 60 * 60 * 1000;
}
