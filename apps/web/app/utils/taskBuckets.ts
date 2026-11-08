/**
 * Grouping a task list into headings: open tasks by when they are due, done
 * tasks by when they were finished. Calendar days are the viewer's own (the
 * browser's time zone), and a week runs Monday to Sunday.
 *
 * A due date is a day, not a moment. It is stored as noon of that local day
 * (`taskDueFromDateInput`), so a teammate up to eleven hours away still reads
 * the same date.
 */

export type TaskDueBucket = 'overdue' | 'today' | 'thisWeek' | 'later' | 'none';
export type TaskDoneBucket = 'today' | 'yesterday' | 'thisWeek' | 'earlier';

export const TASK_DUE_BUCKETS: readonly TaskDueBucket[] = [
	'overdue',
	'today',
	'thisWeek',
	'later',
	'none',
];
export const TASK_DONE_BUCKETS: readonly TaskDoneBucket[] = [
	'today',
	'yesterday',
	'thisWeek',
	'earlier',
];

export interface TaskBucketGroup<K extends string, T> {
	bucket: K;
	tasks: T[];
}

function startOfLocalDay(at: number): number {
	const date = new Date(at);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

function addLocalDays(dayStart: number, days: number): number {
	const date = new Date(dayStart);
	date.setDate(date.getDate() + days);
	return date.getTime();
}

/** The start of the Monday after the week `now` falls in. */
function startOfNextWeek(now: number): number {
	const today = startOfLocalDay(now);
	const weekday = (new Date(today).getDay() + 6) % 7;
	return addLocalDays(today, 7 - weekday);
}

/** Which due heading a task falls under. */
export function taskDueBucket(dueAt: number | null, now: number): TaskDueBucket {
	if (dueAt === null) return 'none';
	const today = startOfLocalDay(now);
	if (dueAt < today) return 'overdue';
	if (dueAt < addLocalDays(today, 1)) return 'today';
	if (dueAt < startOfNextWeek(now)) return 'thisWeek';
	return 'later';
}

/** Which heading a finished task falls under. */
export function taskDoneBucket(completedAt: number, now: number): TaskDoneBucket {
	const today = startOfLocalDay(now);
	if (completedAt >= today) return 'today';
	if (completedAt >= addLocalDays(today, -1)) return 'yesterday';
	if (completedAt >= addLocalDays(startOfNextWeek(now), -7)) return 'thisWeek';
	return 'earlier';
}

function groupInOrder<K extends string, T>(
	order: readonly K[],
	tasks: readonly T[],
	bucketOf: (task: T) => K
): TaskBucketGroup<K, T>[] {
	const byBucket = new Map<K, T[]>();
	for (const task of tasks) {
		const bucket = bucketOf(task);
		const list = byBucket.get(bucket);
		if (list) list.push(task);
		else byBucket.set(bucket, [task]);
	}
	return order.flatMap((bucket) => {
		const list = byBucket.get(bucket);
		return list ? [{ bucket, tasks: list }] : [];
	});
}

/** Open tasks under their due headings, headings in order, empty ones left out. Keeps the list order inside a heading. */
export function groupTasksByDue<T extends { dueAt: number | null }>(
	tasks: readonly T[],
	now: number
): TaskBucketGroup<TaskDueBucket, T>[] {
	return groupInOrder(TASK_DUE_BUCKETS, tasks, (task) => taskDueBucket(task.dueAt, now));
}

/** Finished tasks under when they were finished, most recent first. */
export function groupTasksByCompletion<T extends { completedAt: number | null; updatedAt: number }>(
	tasks: readonly T[],
	now: number
): TaskBucketGroup<TaskDoneBucket, T>[] {
	const finishedAt = (task: T) => task.completedAt ?? task.updatedAt;
	const sorted = [...tasks].sort((a, b) => finishedAt(b) - finishedAt(a));
	return groupInOrder(TASK_DONE_BUCKETS, sorted, (task) => taskDoneBucket(finishedAt(task), now));
}

/** A date field's value (`YYYY-MM-DD`) as a due moment: noon of that local day. Null for an empty or malformed value. */
export function taskDueFromDateInput(value: string): number | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
	if (!match) return null;
	const [, year, month, day] = match;
	const date = new Date(Number(year), Number(month) - 1, Number(day), 12, 0, 0, 0);
	return Number.isNaN(date.getTime()) ? null : date.getTime();
}

/** A due moment as a date field's value (`YYYY-MM-DD`, local day), or '' for none. */
export function taskDueToDateInput(dueAt: number | null): string {
	if (dueAt === null) return '';
	const date = new Date(dueAt);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** How many calendar days `at` lies from today: 0 today, 1 tomorrow, -1 yesterday. */
export function taskDayOffset(at: number, now: number): number {
	const a = new Date(startOfLocalDay(at));
	const b = new Date(startOfLocalDay(now));
	const utc = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
	return Math.round((utc(a) - utc(b)) / 86_400_000);
}
