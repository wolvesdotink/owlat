/**
 * The alert sounds composable against shallow query refs, the way
 * `useConvexQuery` delivers them. Pins: the first answer of each source is
 * silent, a burst of mixed alerts makes one sound, a re-delivery or a switch
 * flipped later never replays the backlog, an older item sliding into a
 * bounded window is no arrival, the next burst sounds again, quiet hours and
 * the desktop mute silence everything, and none of it needs Tauri or Web Push. The real player runs against a stubbed `Audio`; the burst clock
 * is the faked `Date`, never the real one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { defineComponent, h, nextTick, ref, shallowRef } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import type { AlertSoundPrefs } from '~/lib/alertSoundRules';
import { ALERT_SOUND_BURST_MS } from '~/lib/alertSoundRules';

const plays = vi.fn();
class MockAudio {
	volume = 1;
	preload = '';
	currentTime = 0;
	muted = false;
	paused = true;
	play = vi.fn(() => {
		this.paused = false;
		plays();
		return Promise.resolve();
	});
	pause = vi.fn();
}

const unread = shallowRef<unknown>(undefined);
const notices = shallowRef<unknown>(undefined);
const prefs = ref<AlertSoundPrefs>({ reply: true, assignment: true, question: true });
const quietHours = ref<unknown>(null);
const isDesktop = ref(false);
const desktopSettings = ref({ global: { notificationsEnabled: true } });
const muted = ref(false);
const queryArgs: unknown[] = [];

function stubNuxt(): void {
	vi.stubGlobal('Audio', MockAudio as unknown as typeof Audio);
	vi.stubGlobal('useDesktopContext', () => ({ isDesktop }));
	vi.stubGlobal('usePostboxSettings', () => ({ quietHours }));
	vi.stubGlobal('useAlertSoundPreferences', () => ({ alertSounds: prefs }));
	vi.stubGlobal('useDesktopAppSettings', () => ({
		settings: desktopSettings,
		workspaceLocal: () => ({ muteNotifications: muted.value }),
	}));
	vi.stubGlobal('useDesktopWorkspaces', () => ({ activeId: ref('ws-a') }));
	vi.stubGlobal('useConvexQuery', (_fn: unknown, args: () => unknown) => {
		queryArgs.push(args());
		return { data: notices };
	});
}

let mounted: VueWrapper | null = null;

async function mountDashboard(): Promise<void> {
	const { useAlertSounds } = await import('../useAlertSounds');
	mounted = mount(
		defineComponent({
			setup() {
				useAlertSounds({ data: unread, count: ref(null) } as never);
				return () => h('div');
			},
		})
	);
}

/** Let the pre-flush watchers run on the value just assigned. */
async function tick(): Promise<void> {
	await nextTick();
}

/**
 * Server arrival times, fixed per id on first use: every fixture made later in
 * a test arrived later, and a re-delivery keeps its time.
 */
const arrivedAt = new Map<string, number>();
function at(id: string): number {
	if (!arrivedAt.has(id)) arrivedAt.set(id, arrivedAt.size + 1);
	return arrivedAt.get(id)!;
}

function message(id: string, extra: { alerted?: boolean; muted?: boolean } = {}) {
	return {
		messageId: id,
		threadId: `t-${id}`,
		fromAddress: 'alice@example.com',
		subject: `Subject ${id}`,
		receivedAt: at(id),
		...extra,
	};
}

function notice(id: string, kind?: 'assignment' | 'clarification' | 'mention' | 'sla_breach') {
	return { id, kind, threadId: `t-${id}`, subject: id, assignedByName: 'Bob', createdAt: at(id) };
}

/** Advance the faked wall clock past one burst window. */
function nextBurst(): void {
	vi.setSystemTime(Date.now() + ALERT_SOUND_BURST_MS);
}

beforeEach(() => {
	vi.resetModules();
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date(2026, 9, 21, 12, 0));
	localStorage.clear();
	stubNuxt();
	plays.mockClear();
	unread.value = undefined;
	notices.value = undefined;
	prefs.value = { reply: true, assignment: true, question: true };
	quietHours.value = null;
	isDesktop.value = false;
	desktopSettings.value = { global: { notificationsEnabled: true } };
	muted.value = false;
	queryArgs.length = 0;
	arrivedAt.clear();
});

afterEach(() => {
	mounted?.unmount();
	mounted = null;
	vi.useRealTimers();
});

describe('useAlertSounds', () => {
	it('shares the notifier subscription to assignment notices', async () => {
		await mountDashboard();
		expect(queryArgs).toEqual([{ includeMentions: true, includeSlaBreaches: true }]);
	});

	it('seeds the first answer of each source silently', async () => {
		await mountDashboard();
		unread.value = { total: 1, messages: [message('m1', { alerted: true })] };
		notices.value = [notice('a1'), notice('q1', 'clarification')];
		await tick();
		expect(plays).not.toHaveBeenCalled();
	});

	it('chimes for a reply on an armed thread, in a browser without Tauri or push', async () => {
		await mountDashboard();
		unread.value = { total: 0, messages: [] };
		await tick();

		unread.value = { total: 1, messages: [message('m1', { alerted: true })] };
		await tick();
		expect(plays).toHaveBeenCalledTimes(1);
	});

	it('stays silent for ordinary mail and for a muted armed thread', async () => {
		await mountDashboard();
		unread.value = { total: 0, messages: [] };
		await tick();

		unread.value = {
			total: 2,
			messages: [message('m1'), message('m2', { alerted: true, muted: true })],
		};
		await tick();
		expect(plays).not.toHaveBeenCalled();
	});

	it('chimes for an assignment and for an agent question, never a mention or breach', async () => {
		await mountDashboard();
		notices.value = [];
		await tick();

		notices.value = [notice('x1', 'mention'), notice('x2', 'sla_breach')];
		await tick();
		expect(plays).not.toHaveBeenCalled();

		notices.value = [notice('a1')];
		await tick();
		expect(plays).toHaveBeenCalledTimes(1);

		nextBurst();
		notices.value = [notice('q1', 'clarification'), notice('a1')];
		await tick();
		expect(plays).toHaveBeenCalledTimes(2);
	});

	it('makes one sound for a mixed burst across both sources', async () => {
		await mountDashboard();
		unread.value = { total: 0, messages: [] };
		notices.value = [];
		await tick();

		unread.value = { total: 1, messages: [message('m1', { alerted: true })] };
		await tick();
		notices.value = [notice('a1'), notice('q1', 'clarification')];
		await tick();
		expect(plays).toHaveBeenCalledTimes(1);

		// The next alert after the window is a new burst.
		nextBurst();
		notices.value = [notice('a2'), notice('a1'), notice('q1', 'clarification')];
		await tick();
		expect(plays).toHaveBeenCalledTimes(2);
	});

	it('never replays an alert on a re-delivery', async () => {
		await mountDashboard();
		notices.value = [];
		await tick();
		notices.value = [notice('a1')];
		await tick();
		expect(plays).toHaveBeenCalledTimes(1);

		nextBurst();
		notices.value = [notice('a1')];
		await tick();
		expect(plays).toHaveBeenCalledTimes(1);
	});

	it('stays silent when reading the newest lets an older armed reply into the peek', async () => {
		// Six unread, oldest first; the peek shows the newest five.
		const ids = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];
		for (const id of ids) at(id);
		const peek = (shown: string[]) => ({
			total: shown.length + 1,
			messages: shown.map((id) => message(id, { alerted: true })),
		});
		await mountDashboard();
		unread.value = peek(['m6', 'm5', 'm4', 'm3', 'm2']);
		await tick();

		// m6 is read: m1, older than everything seen, slides in. No mail arrived.
		unread.value = peek(['m5', 'm4', 'm3', 'm2', 'm1']);
		await tick();
		expect(plays).not.toHaveBeenCalled();

		// A real arrival still sounds.
		unread.value = peek(['m7', 'm5', 'm4', 'm3', 'm2']);
		await tick();
		expect(plays).toHaveBeenCalledTimes(1);
	});

	it('stays silent when an older notice slides into the notice window', async () => {
		for (const id of ['a1', 'a2', 'a3']) at(id);
		await mountDashboard();
		notices.value = [notice('a3'), notice('a2')];
		await tick();

		notices.value = [notice('a2'), notice('a1')];
		await tick();
		expect(plays).not.toHaveBeenCalled();
	});

	it('plays only the kinds switched on, and turning one on later replays nothing', async () => {
		prefs.value = { reply: false, assignment: true, question: false };
		await mountDashboard();
		unread.value = { total: 0, messages: [] };
		notices.value = [];
		await tick();

		unread.value = { total: 1, messages: [message('m1', { alerted: true })] };
		notices.value = [notice('q1', 'clarification')];
		await tick();
		expect(plays).not.toHaveBeenCalled();

		prefs.value = { reply: true, assignment: true, question: true };
		await tick();
		unread.value = { total: 1, messages: [message('m1', { alerted: true })] };
		notices.value = [notice('q1', 'clarification')];
		await tick();
		expect(plays).not.toHaveBeenCalled();
	});

	it('stays silent with every switch off (the default)', async () => {
		prefs.value = { reply: false, assignment: false, question: false };
		await mountDashboard();
		notices.value = [];
		await tick();
		notices.value = [notice('a1')];
		await tick();
		expect(plays).not.toHaveBeenCalled();
	});

	it('stays silent in quiet hours, even for an armed reply', async () => {
		vi.setSystemTime(new Date(2026, 9, 21, 23, 0));
		quietHours.value = {
			enabled: true,
			startMinute: 22 * 60,
			endMinute: 7 * 60,
			days: [0, 1, 2, 3, 4, 5, 6],
		};
		await mountDashboard();
		unread.value = { total: 0, messages: [] };
		await tick();

		unread.value = { total: 1, messages: [message('m1', { alerted: true })] };
		await tick();
		expect(plays).not.toHaveBeenCalled();

		// Morning: the window is over, and the next alert sounds.
		vi.setSystemTime(new Date(2026, 9, 22, 8, 0));
		unread.value = {
			total: 2,
			messages: [message('m2', { alerted: true }), message('m1', { alerted: true })],
		};
		await tick();
		expect(plays).toHaveBeenCalledTimes(1);
	});

	it('follows the desktop master switch and the workspace mute', async () => {
		isDesktop.value = true;
		desktopSettings.value = { global: { notificationsEnabled: false } };
		await mountDashboard();
		notices.value = [];
		await tick();
		notices.value = [notice('a1')];
		await tick();
		expect(plays).not.toHaveBeenCalled();

		desktopSettings.value = { global: { notificationsEnabled: true } };
		muted.value = true;
		notices.value = [notice('a2'), notice('a1')];
		await tick();
		expect(plays).not.toHaveBeenCalled();

		muted.value = false;
		notices.value = [notice('a3'), notice('a2'), notice('a1')];
		await tick();
		expect(plays).toHaveBeenCalledTimes(1);
	});

	it('unlocks the chime on a gesture only while a sound is on, and stops listening on unmount', async () => {
		prefs.value = { reply: false, assignment: false, question: false };
		await mountDashboard();
		window.dispatchEvent(new Event('pointerdown'));
		expect(plays).not.toHaveBeenCalled();

		prefs.value = { reply: true, assignment: false, question: false };
		await tick();
		window.dispatchEvent(new Event('keydown'));
		// The unlock plays the element once, muted.
		expect(plays).toHaveBeenCalledTimes(1);

		const removed = vi.spyOn(window, 'removeEventListener');
		mounted?.unmount();
		mounted = null;
		expect(removed.mock.calls.map(([type]) => type).sort()).toEqual(['keydown', 'pointerdown']);
	});
});
