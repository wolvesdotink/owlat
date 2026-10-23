/**
 * Marketing notices in the foreground: the first answer is a backlog and stays
 * silent, every later new row becomes one toast with Open, and the desktop app
 * also shows a native notification unless its device switches say no.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, effectScope, nextTick, ref, watch, type EffectScope } from 'vue';
import type { MarketingNoticeView } from '~/lib/marketing/marketingNoticeRules';
import { useMarketingNotices } from '../useMarketingNotices';

const { sendDesktopNotification } = vi.hoisted(() => ({
	sendDesktopNotification: vi.fn(async (_title: string, _body: string) => {}),
}));
vi.mock('@owlat/desktop/src/notifications', () => ({ sendDesktopNotification }));

const rows = ref<MarketingNoticeView[] | undefined>(undefined);
const isDesktop = ref(false);
const notificationsEnabled = ref(true);
const showToast = vi.fn();
const navigateTo = vi.fn();

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
});

beforeEach(() => {
	vi.clearAllMocks();
	rows.value = undefined;
	isDesktop.value = false;
	notificationsEnabled.value = true;
	vi.stubGlobal('computed', computed);
	vi.stubGlobal('watch', watch);
	vi.stubGlobal('useDesktopContext', () => ({ isDesktop }));
	vi.stubGlobal('useToast', () => ({ showToast }));
	vi.stubGlobal('useI18n', () => ({
		t: (key: string, params?: Record<string, unknown>) =>
			params ? `${key} ${JSON.stringify(params)}` : key,
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
		await vi.waitFor(() => expect(sendDesktopNotification).toHaveBeenCalledTimes(1));
		expect(sendDesktopNotification.mock.calls[0]![0]).toContain('campaignFinished.title');

		notificationsEnabled.value = false;
		rows.value = [finished('d', 4), finished('c', 3)];
		await settle();
		expect(showToast).toHaveBeenCalledTimes(2);
		expect(sendDesktopNotification).toHaveBeenCalledTimes(1);
	});
});
