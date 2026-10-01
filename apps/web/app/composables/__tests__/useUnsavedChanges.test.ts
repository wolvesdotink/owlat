import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withSetup as mountSetup } from '~/__tests__/withSetup';

// useUnsavedChanges imports `onBeforeRouteLeave`/`useRouter` from vue-router.
// Capture the registered leave guard and a router push spy so we can drive the
// guard directly and assert what it does — without mounting a routed component.
const h = vi.hoisted(() => ({
	guard: null as null | ((to: unknown, from: unknown, next: (v?: unknown) => void) => void),
	push: vi.fn(),
}));

vi.mock('vue-router', () => ({
	onBeforeRouteLeave: (cb: (typeof h)['guard']) => {
		h.guard = cb;
	},
	useRouter: () => ({ push: h.push }),
}));

import { useUnsavedChanges } from '../useUnsavedChanges';

// Every mount is torn down after its test, so a `beforeunload` listener left by
// one test cannot answer for another.
const mounts: Array<() => void> = [];
function withSetup<T>(factory: () => T) {
	const setup = mountSetup(factory);
	let live = true;
	const unmount = () => {
		if (live) setup.unmount();
		live = false;
	};
	mounts.push(unmount);
	return { result: setup.result, unmount };
}
afterEach(() => {
	for (const unmount of mounts.splice(0)) unmount();
});

describe('useUnsavedChanges navigation guard', () => {
	beforeEach(() => {
		h.guard = null;
		h.push.mockClear();
	});

	it('allows navigation and never prompts while there are no unsaved changes', () => {
		const guarded = withSetup(() => useUnsavedChanges()).result;
		const next = vi.fn();

		h.guard?.({ fullPath: '/somewhere' }, {}, next);

		expect(guarded.showDialog.value).toBe(false);
		// next() called with no argument → navigation proceeds.
		expect(next).toHaveBeenCalledTimes(1);
		expect(next).toHaveBeenCalledWith();
		expect(h.push).not.toHaveBeenCalled();
	});

	it('prompts and blocks navigation only when genuinely dirty', () => {
		const guarded = withSetup(() => useUnsavedChanges()).result;
		guarded.setHasChanges(true);
		const next = vi.fn();

		h.guard?.({ fullPath: '/target' }, {}, next);

		expect(guarded.showDialog.value).toBe(true);
		expect(guarded.pendingRoute.value).toBe('/target');
		// next(false) → navigation cancelled until the user resolves the dialog.
		expect(next).toHaveBeenCalledWith(false);
	});

	it('confirmDiscard clears the dirty state and navigates to the pending route', () => {
		const guarded = withSetup(() => useUnsavedChanges()).result;
		guarded.setHasChanges(true);
		h.guard?.({ fullPath: '/target' }, {}, vi.fn());

		guarded.confirmDiscard();

		expect(guarded.showDialog.value).toBe(false);
		expect(guarded.hasUnsavedChanges.value).toBe(false);
		expect(guarded.pendingRoute.value).toBeNull();
		expect(h.push).toHaveBeenCalledWith('/target');
	});

	it('confirmSave runs onSave, then navigates once the owner reports the draft clean', async () => {
		let guarded!: ReturnType<typeof useUnsavedChanges>;
		// The owner's save acknowledges the draft through its dirty feed.
		const onSave = vi.fn(async () => guarded.setHasChanges(false));
		guarded = withSetup(() => useUnsavedChanges({ onSave })).result;
		guarded.setHasChanges(true);
		h.guard?.({ fullPath: '/target' }, {}, vi.fn());

		await guarded.confirmSave();

		expect(onSave).toHaveBeenCalledTimes(1);
		expect(guarded.hasUnsavedChanges.value).toBe(false);
		expect(guarded.showDialog.value).toBe(false);
		expect(h.push).toHaveBeenCalledTimes(1);
		expect(h.push).toHaveBeenCalledWith('/target');
	});

	it('cancelNavigation dismisses the dialog and stays put', () => {
		const guarded = withSetup(() => useUnsavedChanges()).result;
		guarded.setHasChanges(true);
		h.guard?.({ fullPath: '/target' }, {}, vi.fn());

		guarded.cancelNavigation();

		expect(guarded.showDialog.value).toBe(false);
		expect(guarded.pendingRoute.value).toBeNull();
		// Still dirty — the user only dismissed the prompt.
		expect(guarded.hasUnsavedChanges.value).toBe(true);
		expect(h.push).not.toHaveBeenCalled();
	});
});

/** A save the test settles by hand. */
function deferredSave() {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { onSave: vi.fn(() => promise), resolve, reject };
}

function beforeUnloadPrevented() {
	const event = new Event('beforeunload', { cancelable: true });
	window.dispatchEvent(event);
	return event.defaultPrevented;
}

describe('useUnsavedChanges while a Save is in flight', () => {
	beforeEach(() => {
		h.guard = null;
		h.push.mockClear();
	});

	function setupDirty(onSave: () => Promise<void>) {
		const setup = withSetup(() => useUnsavedChanges({ onSave }));
		const guarded = setup.result;
		guarded.setHasChanges(true);
		h.guard?.({ fullPath: '/target' }, {}, vi.fn());
		return { guarded, unmount: setup.unmount };
	}

	it('never pushes a route the user cancelled, and keeps edits made after Cancel protected', async () => {
		const save = deferredSave();
		const { guarded } = setupDirty(save.onSave);

		const saving = guarded.confirmSave();
		expect(guarded.isSavingBeforeLeave.value).toBe(true);
		guarded.cancelNavigation();
		expect(guarded.showDialog.value).toBe(false);

		// A newer edit: the owner's tracker keeps (and re-reports) the draft dirty.
		guarded.setHasChanges(true);
		save.resolve();
		await saving;

		expect(h.push).not.toHaveBeenCalled();
		expect(guarded.isSavingBeforeLeave.value).toBe(false);
		expect(guarded.hasUnsavedChanges.value).toBe(true);
		expect(guarded.showDialog.value).toBe(false);
		expect(beforeUnloadPrevented()).toBe(true);
		// The route guard still prompts for the newer edit.
		const next = vi.fn();
		h.guard?.({ fullPath: '/later' }, {}, next);
		expect(next).toHaveBeenCalledWith(false);
		expect(guarded.pendingRoute.value).toBe('/later');
	});

	it('stays and asks again when the draft was edited while the save ran', async () => {
		const save = deferredSave();
		const { guarded } = setupDirty(save.onSave);

		const saving = guarded.confirmSave();
		// No Cancel: the dialog stays up, and the user edits nothing new here, but
		// the owner reports that the draft moved on past what was submitted.
		save.resolve();
		await saving;

		expect(h.push).not.toHaveBeenCalled();
		expect(guarded.hasUnsavedChanges.value).toBe(true);
		expect(guarded.showDialog.value).toBe(true);
		expect(guarded.pendingRoute.value).toBe('/target');
		expect(beforeUnloadPrevented()).toBe(true);
	});

	it('submits once and navigates once however often Save is clicked', async () => {
		const save = deferredSave();
		let guarded!: ReturnType<typeof useUnsavedChanges>;
		const onSave = vi.fn(async () => {
			await save.onSave();
			guarded.setHasChanges(false);
		});
		guarded = setupDirty(onSave).guarded;

		const first = guarded.confirmSave();
		const second = guarded.confirmSave();
		const third = guarded.confirmSave();
		save.resolve();
		await Promise.all([first, second, third]);

		expect(onSave).toHaveBeenCalledTimes(1);
		expect(h.push).toHaveBeenCalledTimes(1);
		expect(h.push).toHaveBeenCalledWith('/target');
	});

	it('does not replace a newer leave target with the older in-flight one', async () => {
		const save = deferredSave();
		let guarded!: ReturnType<typeof useUnsavedChanges>;
		const onSave = vi.fn(async () => {
			await save.onSave();
			guarded.setHasChanges(false);
		});
		guarded = setupDirty(onSave).guarded;

		const saving = guarded.confirmSave();
		// A second leave request (browser Back while the save is running).
		h.guard?.({ fullPath: '/newer' }, {}, vi.fn());
		save.resolve();
		await saving;

		expect(h.push).not.toHaveBeenCalled();
		expect(guarded.pendingRoute.value).toBe('/newer');
		expect(guarded.showDialog.value).toBe(true);
	});

	it('keeps the dialog and the edits when the save fails', async () => {
		const save = deferredSave();
		const { guarded } = setupDirty(save.onSave);

		const saving = guarded.confirmSave();
		save.reject(new Error('Save failed'));
		await expect(saving).rejects.toThrow('Save failed');

		expect(h.push).not.toHaveBeenCalled();
		expect(guarded.isSavingBeforeLeave.value).toBe(false);
		expect(guarded.showDialog.value).toBe(true);
		expect(guarded.pendingRoute.value).toBe('/target');
		expect(guarded.hasUnsavedChanges.value).toBe(true);
	});

	it('holds Discard until the save settles, then Discard leaves explicitly', async () => {
		const save = deferredSave();
		const { guarded } = setupDirty(save.onSave);

		const saving = guarded.confirmSave();
		guarded.confirmDiscard();
		expect(h.push).not.toHaveBeenCalled();
		expect(guarded.showDialog.value).toBe(true);

		save.resolve();
		await saving;
		expect(h.push).not.toHaveBeenCalled();

		guarded.confirmDiscard();
		expect(h.push).toHaveBeenCalledTimes(1);
		expect(h.push).toHaveBeenCalledWith('/target');
		expect(guarded.hasUnsavedChanges.value).toBe(false);
	});

	it('does not navigate when the page unmounted before the save settled', async () => {
		const save = deferredSave();
		let guarded!: ReturnType<typeof useUnsavedChanges>;
		const onSave = vi.fn(async () => {
			await save.onSave();
			guarded.setHasChanges(false);
		});
		const page = setupDirty(onSave);
		guarded = page.guarded;

		const saving = guarded.confirmSave();
		page.unmount();
		save.resolve();
		await saving;

		expect(h.push).not.toHaveBeenCalled();
	});
});
