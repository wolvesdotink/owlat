/**
 * The Workbench's explanation for a bounce from a switched-off page.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, reactive, ref } from 'vue';
import { createTestI18n } from '~/__tests__/i18n';
import { useFeatureOffNotice } from '../useFeatureOffNotice';

const i18n = createTestI18n();

interface ShownToast {
	message: string;
	type: string;
	options?: { action?: { label: string; onAction: () => void } };
}

let route: { query: Record<string, string | undefined> };
let toasts: ShownToast[];
let pushed: string[];
let replaced: Array<Record<string, unknown>>;
const isAdmin = ref(false);
const isRoleLoading = ref(false);

beforeEach(() => {
	route = reactive({ query: { disabled: 'chat' } });
	toasts = [];
	pushed = [];
	replaced = [];
	isAdmin.value = false;
	isRoleLoading.value = false;
	vi.stubGlobal('useI18n', () => i18n.global);
	vi.stubGlobal('useRoute', () => route);
	vi.stubGlobal('useRouter', () => ({
		replace: (to: { query: Record<string, string | undefined> }) => {
			replaced.push(to.query);
			route.query = to.query;
			return Promise.resolve();
		},
		push: (to: string) => {
			pushed.push(to);
			return Promise.resolve();
		},
	}));
	vi.stubGlobal('usePermissions', () => ({ isAdmin, isRoleLoading }));
	vi.stubGlobal('useToast', () => ({
		showToast: (message: string, type: string, options?: ShownToast['options']) =>
			toasts.push({ message, type, ...(options ? { options } : {}) }),
	}));
});

function mountNotice() {
	effectScope().run(() => useFeatureOffNotice());
}

describe('useFeatureOffNotice', () => {
	it('tells a member which feature is off, once, with no link', async () => {
		mountNotice();
		await nextTick();

		expect(toasts).toHaveLength(1);
		expect(toasts[0]!.message).toBe('Chat is turned off in this workspace.');
		expect(toasts[0]!.options?.action).toBeUndefined();
	});

	it('drops the parameter from the URL, keeping the rest, so a reload says nothing', async () => {
		route.query = { disabled: 'chat', inbox: 'team' };
		mountNotice();
		await nextTick();

		expect(replaced).toEqual([{ inbox: 'team' }]);
		expect(toasts).toHaveLength(1);

		// The reload: the same page, without the parameter.
		mountNotice();
		await nextTick();
		expect(toasts).toHaveLength(1);
	});

	it('gives an admin the way to Settings → Features', async () => {
		isAdmin.value = true;
		mountNotice();
		await nextTick();

		const action = toasts[0]!.options?.action;
		expect(action?.label).toBe('Open Features');
		action!.onAction();
		expect(pushed).toEqual(['/dashboard/admin/instance/features']);
	});

	it('waits for the role, so an admin is not shown the member sentence', async () => {
		isRoleLoading.value = true;
		mountNotice();
		await nextTick();
		expect(toasts).toEqual([]);

		isAdmin.value = true;
		isRoleLoading.value = false;
		await nextTick();
		expect(toasts).toHaveLength(1);
		expect(toasts[0]!.options?.action?.label).toBe('Open Features');
	});

	it('says nothing about a flag it cannot name, and still cleans the URL', async () => {
		route.query = { disabled: 'free-money' };
		mountNotice();
		await nextTick();

		expect(toasts).toEqual([]);
		expect(replaced).toEqual([{}]);
	});
});
