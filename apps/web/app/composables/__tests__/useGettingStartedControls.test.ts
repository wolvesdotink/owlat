/**
 * Hiding and bringing back Getting started. Dismissing used to be one way:
 * nothing offered Undo and nothing led back. Pinned here: Undo restores exactly
 * the writes that landed, with their tokens; a failed or refused restore is not
 * reported as undone; "Show setup checklist" restores within the viewer's own
 * boundary (instance-wide only for admins, once the role is known), leaves Zen
 * and opens Today; an older show or dismiss never overrules a newer one, and
 * one person's request never opens the card for the next person signed in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref, type Ref } from 'vue';
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
let isAdmin: Ref<boolean>;
let isRoleLoading: Ref<boolean>;
let currentUser: Ref<{ id: string } | null>;

const DISMISS_INSTANCE = getFunctionName(api.auth.onboarding.dismiss);
const DISMISS_USER = getFunctionName(api.auth.userOnboarding.dismiss);
const RESTORE_INSTANCE = getFunctionName(api.auth.onboarding.restore);
const RESTORE_USER = getFunctionName(api.auth.userOnboarding.restore);

beforeEach(() => {
	sessionStorage.clear();
	toasts = [];
	navigations = [];
	path = '/dashboard/postbox/inbox';
	isAdmin = ref(false);
	isRoleLoading = ref(false);
	currentUser = ref({ id: 'user-a' });
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
	vi.stubGlobal('useAuth', () => ({ user: currentUser }));
	vi.stubGlobal('usePermissions', () => ({ isAdmin, isRoleLoading }));
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

/** A mutation that settles when the test says so. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
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
		isAdmin.value = true;
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
		currentUser.value = null;
		const { showChecklist, reopenRequest } = await controls();

		await showChecklist();

		expect(reopenRequest.value).toBe(0);
		expect(runs[RESTORE_USER]).not.toHaveBeenCalled();
		expect(navigations).toEqual([]);
	});
});

describe('newer decisions win', () => {
	it('keeps a checklist asked for again while an older dismissal was in flight', async () => {
		const dismissal = deferred<{ ok: true; result: { dismissedAt: number } }>();
		runs[DISMISS_USER] = vi.fn(() => dismissal.promise);
		const { showChecklist, dismiss, reopenRequest } = await controls();

		await showChecklist();
		const dismissing = dismiss('user', 'user-a');
		await showChecklist();
		dismissal.resolve({ ok: true, result: { dismissedAt: 222 } });
		await dismissing;

		expect(reopenRequest.value).toBe(2);
		// Nothing is hidden, so nothing is announced or offered for Undo.
		expect(toasts).toEqual([]);
		expect(runs[RESTORE_USER]).toHaveBeenCalledTimes(2);
	});

	it('does not restore what was dismissed while it waited for the role', async () => {
		isRoleLoading.value = true;
		const { showChecklist, dismiss, reopenRequest } = await controls();

		const showing = showChecklist();
		await dismiss('user', 'user-a');
		isRoleLoading.value = false;
		await showing;

		expect(runs[RESTORE_USER]).not.toHaveBeenCalled();
		expect(reopenRequest.value).toBe(0);
		expect(toasts).toHaveLength(1);
	});

	it('does not reopen through an Undo once the checklist was asked for since', async () => {
		const { showChecklist, dismiss, reopenRequest } = await controls();

		await showChecklist();
		await dismiss('user', 'user-a');
		await showChecklist();
		await dismiss('user', 'user-a');

		expect(await undoOf(0).run()).toBe(true);
		expect(reopenRequest.value).toBe(0);
	});
});

describe('role resolution', () => {
	it('waits for the role, so an admin also clears the instance dismissal', async () => {
		isRoleLoading.value = true;
		const { showChecklist, reopenRequest } = await controls();

		const showing = showChecklist();
		// The card opens at once; only the writes wait.
		expect(reopenRequest.value).toBe(1);
		await Promise.resolve();
		expect(runs[RESTORE_USER]).not.toHaveBeenCalled();

		isAdmin.value = true;
		isRoleLoading.value = false;
		await showing;

		expect(runs[RESTORE_USER]).toHaveBeenCalledWith({ userId: 'user-a' });
		expect(runs[RESTORE_INSTANCE]).toHaveBeenCalledWith({ userId: 'user-a' });
	});
});

describe('change of signed-in user', () => {
	it("does not open the next person's checklist", async () => {
		const { showChecklist, reopenRequest } = await controls();

		await showChecklist();
		expect(reopenRequest.value).toBe(1);

		currentUser.value = null;
		await nextTick();
		currentUser.value = { id: 'user-b' };
		await nextTick();
		expect(reopenRequest.value).toBe(0);

		// Nor does the first person's request come back when they sign in again.
		currentUser.value = { id: 'user-a' };
		await nextTick();
		expect(reopenRequest.value).toBe(0);
	});

	it("leaves the next person's checklist alone when an old request completes", async () => {
		isRoleLoading.value = true;
		const { showChecklist } = await controls();

		const showing = showChecklist();
		currentUser.value = { id: 'user-b' };
		await nextTick();
		isRoleLoading.value = false;
		await showing;

		expect(runs[RESTORE_USER]).not.toHaveBeenCalled();
		expect(runs[RESTORE_INSTANCE]).not.toHaveBeenCalled();
	});

	it("does not run an earlier person's Undo in the next session", async () => {
		const { showChecklist, dismiss, reopenRequest } = await controls();

		await showChecklist();
		await dismiss('user', 'user-a');
		currentUser.value = { id: 'user-b' };
		await nextTick();

		expect(await undoOf().run()).toBe(false);
		expect(runs[RESTORE_USER]).toHaveBeenCalledTimes(1);
		expect(reopenRequest.value).toBe(0);
	});
});
