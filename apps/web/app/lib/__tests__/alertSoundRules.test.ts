import { describe, expect, it } from 'vitest';
import {
	ALERT_SOUND_BURST_MS,
	ALERT_SOUND_KINDS,
	alertKindsOf,
	alertSoundKindsFor,
	alertSoundPatch,
	isNewAlertBurst,
	noticeAlertKind,
	resolveAlertSoundPrefs,
	shouldPlayAlertSound,
	takeArrivals,
	unreadAlertKind,
	type AlertSoundPrefs,
	type ArrivalMemory,
} from '../alertSoundRules';

const ALL_ON: AlertSoundPrefs = { reply: true, assignment: true, question: true };
const ALL_OFF: AlertSoundPrefs = { reply: false, assignment: false, question: false };

describe('resolveAlertSoundPrefs', () => {
	it('reads an unsaved row, and every unset switch, as off', () => {
		expect(resolveAlertSoundPrefs(undefined)).toEqual(ALL_OFF);
		expect(resolveAlertSoundPrefs(null)).toEqual(ALL_OFF);
		expect(resolveAlertSoundPrefs({})).toEqual(ALL_OFF);
		expect(resolveAlertSoundPrefs({ isAssignmentSoundOn: true })).toEqual({
			reply: false,
			assignment: true,
			question: false,
		});
	});
});

describe('alertSoundPatch', () => {
	it('writes exactly the one field of the switch that moved', () => {
		expect(alertSoundPatch('reply', true)).toEqual({ isReplyAlertSoundOn: true });
		expect(alertSoundPatch('assignment', false)).toEqual({ isAssignmentSoundOn: false });
		expect(alertSoundPatch('question', true)).toEqual({ isQuestionSoundOn: true });
	});

	it('round-trips through the resolver for every kind', () => {
		for (const kind of ALERT_SOUND_KINDS) {
			const prefs = resolveAlertSoundPrefs(alertSoundPatch(kind, true));
			expect(prefs[kind]).toBe(true);
			expect(Object.values(prefs).filter(Boolean)).toHaveLength(1);
		}
	});
});

describe('alertSoundKindsFor', () => {
	const flags =
		(...on: string[]) =>
		(flag: string) =>
			on.includes(flag);

	it('lists the reply sound wherever personal mail exists, whatever the role', () => {
		expect(alertSoundKindsFor({ isFeatureEnabled: flags('postbox'), role: 'editor' })).toEqual([
			'reply',
		]);
		expect(alertSoundKindsFor({ isFeatureEnabled: flags('mail.external') })).toEqual(['reply']);
	});

	it('lists the Team inbox sounds for its readers only', () => {
		const inbox = flags('inbox');
		expect(alertSoundKindsFor({ isFeatureEnabled: inbox, role: 'owner' })).toEqual([
			'assignment',
			'question',
		]);
		expect(alertSoundKindsFor({ isFeatureEnabled: inbox, role: 'admin' })).toEqual([
			'assignment',
			'question',
		]);
		expect(alertSoundKindsFor({ isFeatureEnabled: inbox, role: 'editor' })).toEqual([]);
		expect(alertSoundKindsFor({ isFeatureEnabled: inbox, role: null })).toEqual([]);
		expect(alertSoundKindsFor({ isFeatureEnabled: inbox })).toEqual([]);
	});

	it('lists all three in card order, and none without mail or the Team inbox', () => {
		expect(alertSoundKindsFor({ isFeatureEnabled: () => true, role: 'admin' })).toEqual(
			ALERT_SOUND_KINDS
		);
		expect(alertSoundKindsFor({ isFeatureEnabled: flags('campaigns'), role: 'owner' })).toEqual([]);
	});
});

describe('takeArrivals', () => {
	interface Item {
		id: string;
		at: number;
	}
	const take = (memory: ArrivalMemory, items: Item[]) =>
		takeArrivals(
			memory,
			items,
			(item) => item.id,
			(item) => item.at
		).map((item) => item.id);
	const fresh = (): ArrivalMemory => ({ seen: new Set(), newestAt: null });

	it('counts unseen items newer than anything seen before', () => {
		const memory = fresh();
		expect(
			take(memory, [
				{ id: 'b', at: 20 },
				{ id: 'a', at: 10 },
			])
		).toEqual(['b', 'a']);
		expect(memory.newestAt).toBe(20);
		expect(
			take(memory, [
				{ id: 'c', at: 30 },
				{ id: 'b', at: 20 },
			])
		).toEqual(['c']);
		expect(memory.newestAt).toBe(30);
	});

	it('never counts an older item that slides into the window as an arrival', () => {
		const memory = fresh();
		take(memory, [
			{ id: 'e', at: 50 },
			{ id: 'd', at: 40 },
		]);
		// The newest is read: an older unread one slides in from below.
		expect(
			take(memory, [
				{ id: 'd', at: 40 },
				{ id: 'c', at: 30 },
			])
		).toEqual([]);
		// The watermark holds after the newest left the window.
		expect(memory.newestAt).toBe(50);
		expect(
			take(memory, [
				{ id: 'f', at: 60 },
				{ id: 'd', at: 40 },
			])
		).toEqual(['f']);
	});

	it('never counts a re-delivery, and seeds from an empty window by id alone', () => {
		const memory = fresh();
		expect(take(memory, [])).toEqual([]);
		expect(memory.newestAt).toBeNull();
		expect(take(memory, [{ id: 'a', at: 5 }])).toEqual(['a']);
		expect(take(memory, [{ id: 'a', at: 5 }])).toEqual([]);
	});
});

describe('unreadAlertKind', () => {
	it('is a reply only for an armed thread that is not muted', () => {
		expect(unreadAlertKind({ alerted: true })).toBe('reply');
		expect(unreadAlertKind({ alerted: true, muted: true })).toBeNull();
		expect(unreadAlertKind({})).toBeNull();
		expect(unreadAlertKind({ alerted: false })).toBeNull();
	});
});

describe('noticeAlertKind', () => {
	it('maps assignments (with or without a kind) and agent questions', () => {
		expect(noticeAlertKind({})).toBe('assignment');
		expect(noticeAlertKind({ kind: 'assignment' })).toBe('assignment');
		expect(noticeAlertKind({ kind: 'clarification' })).toBe('question');
	});

	it('makes no sound for mentions or SLA breaches', () => {
		expect(noticeAlertKind({ kind: 'mention' })).toBeNull();
		expect(noticeAlertKind({ kind: 'sla_breach' })).toBeNull();
	});
});

describe('alertKindsOf', () => {
	it('collects each kind once and skips items that stand for none', () => {
		const kinds = alertKindsOf(
			[{ kind: 'assignment' }, { kind: 'mention' }, {}, { kind: 'clarification' }] as const,
			noticeAlertKind
		);
		expect(kinds.sort()).toEqual(['assignment', 'question']);
		expect(alertKindsOf([], noticeAlertKind)).toEqual([]);
	});
});

describe('shouldPlayAlertSound', () => {
	const base = { prefs: ALL_ON, quiet: false, silenced: false };

	it('plays each kind the user switched on', () => {
		for (const kind of ALERT_SOUND_KINDS) {
			expect(shouldPlayAlertSound({ ...base, kinds: [kind] })).toBe(true);
		}
	});

	it('stays silent for a kind that is off, even beside others that are on', () => {
		const prefs = { ...ALL_OFF, assignment: true };
		expect(shouldPlayAlertSound({ ...base, prefs, kinds: ['reply'] })).toBe(false);
		expect(shouldPlayAlertSound({ ...base, prefs, kinds: ['question'] })).toBe(false);
		expect(shouldPlayAlertSound({ ...base, prefs, kinds: ['reply', 'assignment'] })).toBe(true);
	});

	it('stays silent with nothing to announce', () => {
		expect(shouldPlayAlertSound({ ...base, kinds: [] })).toBe(false);
	});

	it('stays silent in quiet hours, an armed reply included', () => {
		expect(shouldPlayAlertSound({ ...base, quiet: true, kinds: ['reply'] })).toBe(false);
		expect(shouldPlayAlertSound({ ...base, quiet: true, kinds: ['assignment'] })).toBe(false);
	});

	it('stays silent while the desktop switches silence notifications', () => {
		expect(shouldPlayAlertSound({ ...base, silenced: true, kinds: ['question'] })).toBe(false);
	});
});

describe('isNewAlertBurst', () => {
	it('opens a burst with no earlier sound', () => {
		expect(isNewAlertBurst(null, 1_000)).toBe(true);
	});

	it('holds sounds back inside the window and lets the next one through after it', () => {
		const at = 50_000;
		expect(isNewAlertBurst(at, at)).toBe(false);
		expect(isNewAlertBurst(at, at + ALERT_SOUND_BURST_MS - 1)).toBe(false);
		expect(isNewAlertBurst(at, at + ALERT_SOUND_BURST_MS)).toBe(true);
	});

	it('does not let a stamp from a clock that jumped back hold sounds forever', () => {
		const now = 50_000;
		expect(isNewAlertBurst(now + 5, now)).toBe(false);
		expect(isNewAlertBurst(now + ALERT_SOUND_BURST_MS + 1, now)).toBe(true);
	});
});
