import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, nextTick, reactive, shallowRef } from 'vue';
import { useToast } from '@owlat/ui/composables/useToast';
import { createTestI18n } from '~/__tests__/i18n';
import { withSetup } from '~/__tests__/withSetup';
import { AI_SETTINGS_PATH, useAiKeyRefusedNotice } from '../useAiKeyRefusedNotice';

const i18n = createTestI18n();
const en = (key: string) => i18n.global.t(key);

type Refusal = { firstSeenAt: number; lastSeenAt: number } | null | undefined;

let refusal: ReturnType<typeof shallowRef<Refusal>>;
let role: ReturnType<typeof shallowRef<'owner' | 'member'>>;
let route: { path: string };
let queriedArgs: Array<unknown>;
const navigateTo = vi.fn();

const notice = () =>
	useToast().toasts.value.find(
		(toast) => toast.message === en('shared.backendStatus.aiKeyRefused')
	);

beforeEach(() => {
	refusal = shallowRef<Refusal>(undefined);
	role = shallowRef<'owner' | 'member'>('owner');
	route = reactive({ path: '/dashboard' });
	queriedArgs = [];
	navigateTo.mockReset();
	vi.stubGlobal('useI18n', () => i18n.global);
	vi.stubGlobal('useToast', useToast);
	vi.stubGlobal('useRoute', () => route);
	vi.stubGlobal('navigateTo', navigateTo);
	vi.stubGlobal('usePermissions', () => ({
		isAdmin: computed(() => role.value === 'owner'),
	}));
	vi.stubGlobal('useOrganizationQuery', (_query: unknown, args: () => unknown) => {
		queriedArgs.push(args());
		return { data: computed(() => (args() === undefined ? undefined : refusal.value)) };
	});
	try {
		localStorage.clear();
	} catch {
		// No storage in this environment: dismissal is per load.
	}
	useToast().clearToasts();
});

const mounted: Array<() => void> = [];
afterEach(() => {
	for (const unmount of mounted.splice(0)) unmount();
	useToast().clearToasts();
});

function mountNotice() {
	const m = withSetup(() => useAiKeyRefusedNotice());
	mounted.push(m.unmount);
	return m;
}

describe('useAiKeyRefusedNotice', () => {
	it('tells an admin once, with the way to AI settings', async () => {
		mountNotice();
		expect(notice()).toBeUndefined();
		refusal.value = { firstSeenAt: 1, lastSeenAt: 1 };
		await nextTick();
		expect(notice()).toMatchObject({
			type: 'warning',
			action: { label: en('shared.backendStatus.aiSettings') },
		});
		notice()?.action?.onAction();
		expect(navigateTo).toHaveBeenCalledWith(AI_SETTINGS_PATH);
		refusal.value = { firstSeenAt: 1, lastSeenAt: 2 };
		await nextTick();
		expect(useToast().toasts.value.filter((t) => t.type === 'warning')).toHaveLength(1);
	});

	it('never asks for or shows it to a member', async () => {
		role.value = 'member';
		refusal.value = { firstSeenAt: 1, lastSeenAt: 1 };
		mountNotice();
		await nextTick();
		expect(queriedArgs.every((args) => args === undefined)).toBe(true);
		expect(notice()).toBeUndefined();
	});

	it('goes away when the refusal is closed, and on the AI settings page', async () => {
		refusal.value = { firstSeenAt: 1, lastSeenAt: 1 };
		mountNotice();
		await nextTick();
		expect(notice()).toBeDefined();
		route.path = AI_SETTINGS_PATH;
		await nextTick();
		expect(notice()).toBeUndefined();
		route.path = '/dashboard';
		await nextTick();
		expect(notice()).toBeDefined();
		refusal.value = null;
		await nextTick();
		expect(notice()).toBeUndefined();
	});

	it('stays closed once closed, until the provider refuses the key anew', async () => {
		refusal.value = { firstSeenAt: 1, lastSeenAt: 1 };
		mountNotice();
		await nextTick();
		const shown = notice();
		if (!shown) throw new Error('no notice');
		useToast().removeToast(shown.id);
		refusal.value = { firstSeenAt: 1, lastSeenAt: 5 };
		await nextTick();
		expect(notice()).toBeUndefined();
		refusal.value = { firstSeenAt: 9, lastSeenAt: 9 };
		await nextTick();
		expect(notice()).toBeDefined();
	});
});
