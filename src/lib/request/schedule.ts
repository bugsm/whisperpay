/**
 * Recurring payment requests.
 *
 * A subscription here is *not* a standing authorisation, and can't be. Nothing
 * in the STRK20 pool lets a recipient pull funds: every private transfer is a
 * zero-knowledge proof the payer's own wallet generates, so an auto-charge
 * would mean a server holding the payer's key. Whisper Pay doesn't do that, and
 * shouldn't.
 *
 * What repeats is the *request*. One link carries a schedule, and each period
 * that link presents that period's installment — same URL, new payment due. The
 * payer approves each one in their wallet. This keeps the property M1 was built
 * on: the schedule rides in the link, so there is still no server-side list of
 * who is billing whom, and no cron job that would need anyone's key.
 *
 * Time is UTC. Days and weeks are fixed spans of seconds; months are calendar
 * months, because "monthly" means the 3rd of every month, not every 30 days. An
 * anchor day the target month doesn't have (Jan 31 → February) clamps to that
 * month's last day.
 */

const DAY_SECONDS = 86_400;
const WEEK_SECONDS = 7 * DAY_SECONDS;

export type PeriodUnit = "day" | "week" | "month";

export interface Schedule {
  unit: PeriodUnit;
  /** Units between installments. At least 1. */
  every: number;
  /** Total installments, or `null` for open-ended ("until cancelled"). */
  count: number | null;
  /** Unix seconds — when installment #1 falls due. */
  anchor: number;
}

/** A schedule of one payment is a one-off, so recurring links start at two. */
export const MIN_INSTALLMENTS = 2;

/** Ten years of monthly billing. Past this, make a fresh link. */
export const MAX_INSTALLMENTS = 120;

/** Upper bound on `every`, so "every 2 weeks" works but "every 900" doesn't. */
export const MAX_EVERY = 52;

export interface SchedulePreset {
  label: string;
  /** `null` is the one-off case — no schedule at all. */
  spec: Pick<Schedule, "unit" | "every"> | null;
}

/** Offered on the create form. Anchored to creation time. */
export const SCHEDULE_PRESETS: SchedulePreset[] = [
  { label: "One-off", spec: null },
  { label: "Weekly", spec: { unit: "week", every: 1 } },
  { label: "Every 2 weeks", spec: { unit: "week", every: 2 } },
  { label: "Monthly", spec: { unit: "month", every: 1 } },
];

const UNITS: PeriodUnit[] = ["day", "week", "month"];

export function isValidSchedule(value: unknown): value is Schedule {
  if (typeof value !== "object" || value === null) return false;
  const schedule = value as Partial<Schedule>;

  if (typeof schedule.unit !== "string" || !UNITS.includes(schedule.unit)) {
    return false;
  }
  if (
    typeof schedule.every !== "number" ||
    !Number.isInteger(schedule.every) ||
    schedule.every < 1 ||
    schedule.every > MAX_EVERY
  ) {
    return false;
  }
  if (
    schedule.count !== null &&
    (typeof schedule.count !== "number" ||
      !Number.isInteger(schedule.count) ||
      schedule.count < MIN_INSTALLMENTS ||
      schedule.count > MAX_INSTALLMENTS)
  ) {
    return false;
  }
  return (
    typeof schedule.anchor === "number" &&
    Number.isInteger(schedule.anchor) &&
    schedule.anchor > 0
  );
}

/**
 * `unixSeconds` shifted by whole calendar months, clamping the day of month.
 * Adding one month to January 31 gives February 28 (or 29), not March 3.
 */
function addMonths(unixSeconds: number, months: number): number {
  const from = new Date(unixSeconds * 1000);
  const day = from.getUTCDate();

  // Day 1 first, so the intermediate date can't overflow into the next month.
  const shifted = new Date(
    Date.UTC(
      from.getUTCFullYear(),
      from.getUTCMonth() + months,
      1,
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds()
    )
  );
  const lastDay = new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0)
  ).getUTCDate();
  shifted.setUTCDate(Math.min(day, lastDay));

  return Math.floor(shifted.getTime() / 1000);
}

/** Unix seconds at which installment `index` (0-based) falls due. */
export function installmentDueAt(schedule: Schedule, index: number): number {
  if (index <= 0) return schedule.anchor;
  const steps = index * schedule.every;
  switch (schedule.unit) {
    case "day":
      return schedule.anchor + steps * DAY_SECONDS;
    case "week":
      return schedule.anchor + steps * WEEK_SECONDS;
    case "month":
      return addMonths(schedule.anchor, steps);
  }
}

/**
 * When a fixed-length schedule stops being payable: the moment the installment
 * *after* the last one would have fallen due. That gives the final installment
 * a full period to be paid in, same as every other one.
 *
 * `null` for open-ended schedules — those never expire on their own.
 */
export function scheduleEndsAt(schedule: Schedule): number | null {
  return schedule.count === null
    ? null
    : installmentDueAt(schedule, schedule.count);
}

/** Index of the installment `now` falls inside. Negative before the anchor. */
function indexAt(schedule: Schedule, now: number): number {
  if (now < schedule.anchor) return -1;

  if (schedule.unit !== "month") {
    const step =
      schedule.every * (schedule.unit === "day" ? DAY_SECONDS : WEEK_SECONDS);
    return Math.floor((now - schedule.anchor) / step);
  }

  // Calendar months don't divide, so estimate from the month difference and
  // then correct — day clamping and the time of day put the estimate off by at
  // most one either way.
  const anchor = new Date(schedule.anchor * 1000);
  const current = new Date(now * 1000);
  const months =
    (current.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
    (current.getUTCMonth() - anchor.getUTCMonth());

  let index = Math.max(0, Math.floor(months / schedule.every));
  while (index > 0 && installmentDueAt(schedule, index) > now) index -= 1;
  while (installmentDueAt(schedule, index + 1) <= now) index += 1;
  return index;
}

export interface Installment {
  /** 0-based index of the installment currently payable. */
  index: number;
  /** 1-based, for humans: "payment 3 of 12". */
  number: number;
  /** Unix seconds this installment fell due. */
  dueAt: number;
  /** Unix seconds the next one falls due — `null` when this is the last. */
  nextDueAt: number | null;
  /** Total installments, or `null` when open-ended. */
  total: number | null;
  /** True before the first installment is due. */
  notStarted: boolean;
  /** True once the last installment's period has passed. */
  ended: boolean;
}

/**
 * The installment a payer opening the link right now is being asked for.
 *
 * Reads the clock, so callers in React must defer it past hydration — the
 * server and the browser will not agree on `now`.
 */
export function currentInstallment(
  schedule: Schedule,
  now: number = Math.floor(Date.now() / 1000)
): Installment {
  const raw = indexAt(schedule, now);
  const total = schedule.count;

  const notStarted = raw < 0;
  const ended = total !== null && raw > total - 1;

  // Before the start and after the end, the installment on show is the nearest
  // real one — first and last respectively. Both cases are labelled in the UI,
  // and an ended schedule is expired anyway, so nothing can be paid twice.
  const index = notStarted ? 0 : ended ? total - 1 : raw;
  const isLast = total !== null && index >= total - 1;

  return {
    index,
    number: index + 1,
    dueAt: installmentDueAt(schedule, index),
    nextDueAt: isLast ? null : installmentDueAt(schedule, index + 1),
    total,
    notStarted,
    ended,
  };
}

/**
 * Status key for one installment of a recurring request.
 *
 * Status is per-installment: last month being paid says nothing about this
 * month. The `.n` suffix can't collide with a request id, which is base64url
 * and so never contains a dot.
 */
export function installmentStatusId(requestId: string, index: number): string {
  return `${requestId}.${index}`;
}

/** "Weekly", "Monthly", "Every 3 days". */
export function describePeriod(schedule: Schedule): string {
  if (schedule.every === 1) {
    return { day: "Daily", week: "Weekly", month: "Monthly" }[schedule.unit];
  }
  return `Every ${schedule.every} ${schedule.unit}s`;
}

/** "Monthly · 12 payments", "Weekly · until cancelled". */
export function describeSchedule(schedule: Schedule): string {
  const tail =
    schedule.count === null ? "until cancelled" : `${schedule.count} payments`;
  return `${describePeriod(schedule)} · ${tail}`;
}
