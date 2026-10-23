/**
 * Marketing notices in the foreground: the first answer is a backlog and stays
 * silent, every later new row becomes one toast with Open, and the desktop app
 * also shows a native notification unless its device switches say no. The
 * native one opens the notice's page in its workspace, keeps names off the
 * lock screen with private notifications on, and waits out quiet hours.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, effectScope, nextTick, ref, watch, type EffectScope } from 'vue';
import { setActiveWorkspace } from '~/lib/desktop/activeWorkspace';
import type { MarketingNoticeView } from '~/lib/marketing/marketingNoticeRules';
import type { PostboxQuietHours } from '~/utils/postboxQuietHours';
import { useMarketingNotices } from '../useMarketingNotices';

const { sendDesktopNotification, sendLinkNotification } = vi.hoisted(() => ({
	sendDesktopNotification: vi.fn(async (_title: string, _body: string) => {}),
	sendLinkNotification: vi.fn(
		async (_title: string, _body: string, _url: string, _workspaceId?: string | null) => {}
	),
}));
vi.mock('@owlat/desktop/src/notifications', () => ({
	sendDesktopNotification,
	sendLinkNotification,
}));

const rows = ref<MarketingNoticeView[] | undefined>(undefined);
const isDesktop = ref(false);
const notificationsEnabled = ref(true);
const hidePreview = ref(false);
const QUIET_OFF: PostboxQuietHours = { enabled: false, startMinute: 0, endMinute: 0, days: [] };
const NIGHTS: PostboxQuietHours = {
	enabled: true,
	startMinute: 22 * 60,
	endMinute: 7 * 60,
	days: [0, 1, 2, 3, 4, 5, 6],
};
const quietHours = ref<PostboxQuietHours>(QUIET_OFF);
const showToast = vi.fn();
const navigateTo = vi.fn();
/** The quiet-hours poll the composable starts on mount, run by hand. */
let pollQuietHours: (() => void) | null = null;

// Each case runs the composable in its own scope and stops it, so a watcher
// from an earlier case never reacts to the next case's rows.
let scope: EffectScope | null = null;
function start(): void {
	scope = effectScope();
	scope.run(() => useMarketingNotices());
}
afterEach(() => {
	scope?.stop();
	scope = null;
	vi.useRealTimers();
	setActiveWorkspace(null);
});

beforeEach(() => {
	vi.clearAllMocks();
	rows.value = undefined;
	isDesktop.value = false;
	notificationsEnabled.value = true;
	hidePreview.value = false;
	quietHours.value = QUIET_OFF;
	pollQuietHours = null;
	setActiveWorkspace({ id: 'ws-a' } as never);
	vi.stubGlobal('onMounted', (hook: () => void) => hook());
	vi.stubGlobal('onUnmounted', () => {});
	vi.stubGlobal('setInterval', (callback: () => void) => {
		pollQuietHours = callback;
		return 1;
	});
	vi.stubGlobal('clearInterval', () => {});
	vi.stubGlobal('usePostboxSettings', () => ({ quietHours, hidePreview }));
	vi.stubGlobal('computed', computed);
	vi.stubGlobal('watch', watch);
	vi.stubGlobal('useDesktopContext', () => ({ isDesktop }));
	vi.stubGlobal('useToast', () => ({ showToast }));
	vi.stubGlobal('useI18n', () => ({
		t: (key: string, params?: Record<string, unknown>) =>
			params ? `${key} ${JSON.stringify(params)}` : key,
		te: () => true,
	}));
	vi.stubGlobal('useDesktopNotificationPermission', () => ({ canSend: ref(true) }));
	vi.stubGlobal('useDesktopAppSettings', () => ({
		settings: computed(() => ({
			global: { notificationsEnabled: notificationsEnabled.value },
		})),
		workspaceLocal: () => ({ muteNotifications: false }),
	}));
	vi.stubGlobal('useDesktopWorkspaces', () => ({ activeId: ref('ws-a') }));
	vi.stubGlobal('useConvexQuery', () => ({ data: rows }));
	vi.stubGlobal('navigateTo', navigateTo);
});

const finished = (id: string, createdAt: number): MarketingNoticeView => ({
	id,
	kind: 'campaign_finished',
	createdAt,
	url: `/dashboard/campaigns/${id}/report`,
	name: `Campaign ${id}`,
	percent: 98,
});

const settle = async () => {
	await nextTick();
	await Promise.resolve();
	await Promise.resolve();
};

describe('useMarketingNotices', () => {
	it('stays silent for the backlog and toasts each new notice once, with Open', async () => {
		start();
		rows.value = [finished('a', 1)];
		await settle();
		expect(showToast).not.toHaveBeenCalled();

		rows.value = [finished('b', 2), finished('a', 1)];
		await settle();
		rows.value = [finished('b', 2), finished('a', 1)];
		await settle();
		expect(showToast).toHaveBeenCalledTimes(1);
		const [message, type, options] = showToast.mock.calls[0]!;
		expect(type).toBe('success');
		expect(message).toContain('shared.marketingNotices.toast');
		expect(message).toContain('Campaign b');
		options.action.onAction();
		expect(navigateTo).toHaveBeenCalledWith('/dashboard/campaigns/b/report');
		expect(sendDesktopNotification).not.toHaveBeenCalled();
	});

	it('keeps a reminder up longer than other notices', async () => {
		start();
		rows.value = [];
		await settle();
		rows.value = [
			{
				id: 'r',
				kind: 'campaign_reminder',
				createdAt: 1,
				url: '/dashboard/campaigns/r/edit',
				name: 'Webinar',
				scheduledAt: Date.now() + 15 * 60_000,
			},
		];
		await settle();
		expect(showToast.mock.calls[0]![2]).toMatchObject({ durationMs: 15_000 });
	});

	it('also notifies natively on the desktop app, unless notifications are off there', async () => {
		isDesktop.value = true;
		start();
		rows.value = [];
		await settle();
		rows.value = [finished('c', 3)];
		await settle();
		await vi.waitFor(() => expect(sendLinkNotification).toHaveBeenCalledTimes(1));
		const [title, body, url, workspaceId] = sendLinkNotification.mock.calls[0]!;
		expect(title).toContain('campaignFinished.title');
		expect(body).toContain('Campaign c');
		// Clicking it opens the report, in the workspace that sent it.
		expect(url).toBe('/dashboard/campaigns/c/report');
		expect(workspaceId).toBe('ws-a');

		notificationsEnabled.value = false;
		rows.value = [finished('d', 4), finished('c', 3)];
		await settle();
		expect(showToast).toHaveBeenCalledTimes(2);
		expect(sendLinkNotification).toHaveBeenCalledTimes(1);
	});

	it('keeps names out of the native notification when notifications are private', async () => {
		isDesktop.value = true;
		hidePreview.value = true;
		start();
		rows.value = [];
		await settle();
		rows.value = [finished('c', 3)];
		await settle();
		await vi.waitFor(() => expect(sendLinkNotification).toHaveBeenCalledTimes(1));
		const [, body, url] = sendLinkNotification.mock.calls[0]!;
		expect(body).toContain('shared.marketingNotices.campaignFinished.private');
		expect(body).not.toContain('Campaign c');
		expect(url).toBe('/dashboard/campaigns/c/report');
		// The toast is in front of the person already and keeps the name.
		expect(showToast.mock.calls[0]![0]).toContain('Campaign c');
	});

	it('holds the native notification through quiet hours and sends what still holds after', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date(2026, 9, 22, 23, 30));
		isDesktop.value = true;
		quietHours.value = NIGHTS;
		start();
		rows.value = [];
		await settle();
		rows.value = [finished('c', 3)];
		await settle();
		expect(showToast).toHaveBeenCalledTimes(1);

		// Still night: the poll keeps holding it.
		pollQuietHours!();
		await settle();
		expect(sendLinkNotification).not.toHaveBeenCalled();

		vi.setSystemTime(new Date(2026, 9, 23, 7, 5));
		pollQuietHours!();
		await vi.waitFor(() => expect(sendLinkNotification).toHaveBeenCalledTimes(1));
		expect(sendLinkNotification.mock.calls[0]![2]).toBe('/dashboard/campaigns/c/report');

		// Released once: a later poll sends nothing more.
		pollQuietHours!();
		await settle();
		expect(sendLinkNotification).toHaveBeenCalledTimes(1);
	});

	it('sums several held notices up, and drops a reminder whose campaign has started', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date(2026, 9, 22, 6, 30));
		isDesktop.value = true;
		quietHours.value = NIGHTS;
		start();
		rows.value = [];
		await settle();
		const reminder: MarketingNoticeView = {
			id: 'r',
			kind: 'campaign_reminder',
			createdAt: 1,
			url: '/dashboard/campaigns/r/edit',
			name: 'Webinar',
			scheduledAt: new Date(2026, 9, 22, 6, 45).getTime(),
		};
		rows.value = [reminder, finished('a', 2), finished('b', 3)];
		await settle();

		vi.setSystemTime(new Date(2026, 9, 22, 7, 1));
		pollQuietHours!();
		await vi.waitFor(() => expect(sendDesktopNotification).toHaveBeenCalledTimes(1));
		const [title, body] = sendDesktopNotification.mock.calls[0]!;
		expect(title).toBe('shared.marketingNotices.quietSummary.title');
		expect(body).toContain('"count":2');
		expect(sendLinkNotification).not.toHaveBeenCalled();
	});

	it('drops a held delivery hold whose breaker snapshot went stale before the window closed', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date(2026, 9, 22, 6, 30));
		isDesktop.value = true;
		quietHours.value = NIGHTS;
		start();
		rows.value = [];
		await settle();
		// The reader answered at 06:30 and, with no new snapshot, never again:
		// the kept answer still lists the hold, trusted only until 06:40.
		const hold: MarketingNoticeView = {
			id: 'h',
			kind: 'delivery_hold',
			createdAt: 1,
			url: '/dashboard/deliverability',
			name: 'gmail',
			liveUntil: new Date(2026, 9, 22, 6, 40).getTime(),
		};
		rows.value = [hold, finished('a', 2)];
		await settle();

		vi.setSystemTime(new Date(2026, 9, 22, 7, 1));
		pollQuietHours!();
		await vi.waitFor(() => expect(sendLinkNotification).toHaveBeenCalledTimes(1));
		expect(sendLinkNotification.mock.calls[0]![2]).toBe('/dashboard/campaigns/a/report');
		expect(sendDesktopNotification).not.toHaveBeenCalled();
	});
});
