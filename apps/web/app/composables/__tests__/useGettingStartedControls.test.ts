/**
 * Hiding and bringing back Getting started. Dismissing used to be one way:
 * nothing offered Undo and nothing led back. Pinned here: Undo restores exactly
 * the writes that landed, with their tokens; a failed or refused restore is not
 * reported as undone; "Show setup checklist" restores within the viewer's own
 * boundary (instance-wide only for admins), leaves Zen and opens Today.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { api } from '@owlat/api';
import { getFunctionName, type FunctionReference } from 'convex/server';
import type { ToastOptions } from '@owlat/ui/composables/useToast';
import { createTestI18n } from '~/__tests__/i18n';

const { t } = createTestI18n().global;

type Run = ReturnType<typeof vi.fn>;
let runs: Record<string, Run>;
let toasts: { message: string; type: string; options?: ToastOptions }[];
let navigations: unknown[];
let path: string;
let isAdmin: boolean;

const DISMISS_INSTANCE = getFunctionName(api.auth.onboarding.dismiss);
const DISMISS_USER = getFunctionName(api.auth.userOnboarding.dismiss);
const RESTORE_INSTANCE = getFunctionName(api.auth.onboarding.restore);
const RESTORE_USER = getFunctionName(api.auth.userOnboarding.restore);

beforeEach(() => {
	sessionStorage.clear();
	toasts = [];
	navigations = [];
	path = '/dashboard/postbox/inbox';
	isAdmin = false;
	runs = {
		[DISMISS_INSTANCE]: vi.fn(async () => ({ ok: true, result: { dismissedAt: 111 } })),
		[DISMISS_USER]: vi.fn(async () => ({ ok: true, result: { dismissedAt: 222 } })),
		[RESTORE_INSTANCE]: vi.fn(async () => ({ ok: true, result: { isDismissed: false } })),
		[RESTORE_USER]: vi.fn(async () => ({ ok: true, result: { isDismissed: false } })),
	};
	vi.stubGlobal('useI18n', () => ({ t }));
	vi.stubGlobal('useToast', () => ({
		showToast: (message: string, type: string, options?: ToastOptions) => {
			toasts.push({ message, type, ...(options ? { options } : {}) });
			return 'toast-1';
		},
	}));
	vi.stubGlobal('useAuth', () => ({ user: ref({ id: 'user-a' }) }));
	vi.stubGlobal('usePermissions', () => ({ isAdmin: ref(isAdmin) }));
	vi.stubGlobal('useRoute', () => ({ path }));
	vi.stubGlobal('useBackendOperation', (fn: FunctionReference<'mutation'>) => ({
		run: runs[getFunctionName(fn)],
	}));
	vi.stubGlobal('navigateTo', (to: unknown) => {
		navigations.push(to);
		return Promise.resolve();
	});
});

async function controls() {
	vi.resetModules();
	const { useGettingStartedControls } = await import('../useGettingStartedControls');
	const { useZenMode } = await import('../useZenMode');
	return { ...useGettingStartedControls(), zen: useZenMode() };
}

function undoOf(index = 0) {
	const action = toasts[index]?.options?.observedAction;
	if (!action) throw new Error('no Undo offered');
	return action;
}

describe('dismiss', () => {
	it('hides both sections and offers an Undo that restores each with its token', async () => {
		const { dismiss } = await controls();

		await dismiss('both', 'user-a');

		expect(runs[DISMISS_INSTANCE]).toHaveBeenCalledWith({ userId: 'user-a' });
		expect(runs[DISMISS_USER]).toHaveBeenCalledWith({ userId: 'user-a' });
		expect(toasts).toHaveLength(1);
		expect(toasts[0]?.message).toBe('Getting started hidden.');
		expect(undoOf().label).toBe('Undo');

		expect(await undoOf().run()).toBe(true);
		expect(runs[RESTORE_INSTANCE]).toHaveBeenCalledWith({ userId: 'user-a', dismissedAt: 111 });
		expect(runs[RESTORE_USER]).toHaveBeenCalledWith({ userId: 'user-a', dismissedAt: 222 });
	});

	it('says a partial dismissal was partial and undoes only what landed', async () => {
		runs[DISMISS_USER] = vi.fn(async () => ({ ok: false }));
		const { dismiss } = await controls();

		await dismiss('both', 'user-a');

		expect(toasts[0]?.message).toBe('Getting started partly hidden.');
		await undoOf().run();
		expect(runs[RESTORE_INSTANCE]).toHaveBeenCalledTimes(1);
		expect(runs[RESTORE_USER]).not.toHaveBeenCalled();
	});

	it('offers nothing when no dismissal landed', async () => {
		runs[DISMISS_USER] = vi.fn(async () => ({ ok: false }));
		const { dismiss } = await controls();

		await dismiss('user', 'user-a');

		expect(toasts).toEqual([]);
		expect(runs[DISMISS_INSTANCE]).not.toHaveBeenCalled();
	});

	it('writes nothing for an empty scope', async () => {
		const { dismiss } = await controls();

		await dismiss('none', 'user-a');

		expect(runs[DISMISS_INSTANCE]).not.toHaveBeenCalled();
		expect(runs[DISMISS_USER]).not.toHaveBeenCalled();
		expect(toasts).toEqual([]);
	});

	it('does not call a refused restore undone (a later dismissal stands)', async () => {
		runs[RESTORE_USER] = vi.fn(async () => ({ ok: true, result: { isDismissed: true } }));
		const { dismiss } = await controls();

		await dismiss('user', 'user-a');

		expect(await undoOf().run()).toBe(false);
		expect(undoOf().failedNote).toBe('Not undone.');
	});

	it('does not call a failed restore undone', async () => {
		runs[RESTORE_INSTANCE] = vi.fn(async () => ({ ok: false }));
		const { dismiss } = await controls();

		await dismiss('instance', 'user-a');

		expect(await undoOf().run()).toBe(false);
	});
});

describe('showChecklist', () => {
	it("restores a member's own checklist only, leaves Zen and opens Today", async () => {
		const { showChecklist, reopenRequest, zen } = await controls();
		zen.enterZen();

		await showChecklist();

		expect(runs[RESTORE_USER]).toHaveBeenCalledWith({ userId: 'user-a' });
		expect(runs[RESTORE_INSTANCE]).not.toHaveBeenCalled();
		expect(navigations).toEqual(['/dashboard']);
		expect(zen.isZen.value).toBe(false);
		expect(reopenRequest.value).toBe(1);
	});

	it('restores the instance surface too for an admin, without navigating from Today', async () => {
		isAdmin = true;
		path = '/dashboard';
		const { showChecklist, reopenRequest } = await controls();

		await showChecklist();
		await showChecklist();

		expect(runs[RESTORE_INSTANCE]).toHaveBeenCalledWith({ userId: 'user-a' });
		expect(runs[RESTORE_USER]).toHaveBeenCalledWith({ userId: 'user-a' });
		expect(navigations).toEqual([]);
		// Every ask counts, so an already-open card still expands and scrolls.
		expect(reopenRequest.value).toBe(2);
	});

	it('ends with a dismissal, and Undo brings the reopened card back', async () => {
		const { showChecklist, dismiss, reopenRequest } = await controls();

		await showChecklist();
		await dismiss('user', 'user-a');
		expect(reopenRequest.value).toBe(0);

		await undoOf().run();
		expect(reopenRequest.value).toBeGreaterThan(0);
	});

	it('does nothing before the session has a user', async () => {
		vi.stubGlobal('useAuth', () => ({ user: ref(null) }));
		const { showChecklist, reopenRequest } = await controls();

		await showChecklist();

		expect(reopenRequest.value).toBe(0);
		expect(runs[RESTORE_USER]).not.toHaveBeenCalled();
		expect(navigations).toEqual([]);
	});
});
