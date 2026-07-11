import { describe, it, expect, vi, beforeEach } from 'vitest';

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

describe('useUnsavedChanges navigation guard', () => {
	beforeEach(() => {
		h.guard = null;
		h.push.mockClear();
	});

	it('allows navigation and never prompts while there are no unsaved changes', () => {
		const guarded = useUnsavedChanges();
		const next = vi.fn();

		h.guard?.({ fullPath: '/somewhere' }, {}, next);

		expect(guarded.showDialog.value).toBe(false);
		// next() called with no argument → navigation proceeds.
		expect(next).toHaveBeenCalledTimes(1);
		expect(next).toHaveBeenCalledWith();
		expect(h.push).not.toHaveBeenCalled();
	});

	it('prompts and blocks navigation only when genuinely dirty', () => {
		const guarded = useUnsavedChanges();
		guarded.setHasChanges(true);
		const next = vi.fn();

		h.guard?.({ fullPath: '/target' }, {}, next);

		expect(guarded.showDialog.value).toBe(true);
		expect(guarded.pendingRoute.value).toBe('/target');
		// next(false) → navigation cancelled until the user resolves the dialog.
		expect(next).toHaveBeenCalledWith(false);
	});

	it('confirmDiscard clears the dirty state and navigates to the pending route', () => {
		const guarded = useUnsavedChanges();
		guarded.setHasChanges(true);
		h.guard?.({ fullPath: '/target' }, {}, vi.fn());

		guarded.confirmDiscard();

		expect(guarded.showDialog.value).toBe(false);
		expect(guarded.hasUnsavedChanges.value).toBe(false);
		expect(guarded.pendingRoute.value).toBeNull();
		expect(h.push).toHaveBeenCalledWith('/target');
	});

	it('confirmSave runs onSave, clears dirty, then navigates', async () => {
		const onSave = vi.fn().mockResolvedValue(undefined);
		const guarded = useUnsavedChanges({ onSave });
		guarded.setHasChanges(true);
		h.guard?.({ fullPath: '/target' }, {}, vi.fn());

		await guarded.confirmSave();

		expect(onSave).toHaveBeenCalledTimes(1);
		expect(guarded.hasUnsavedChanges.value).toBe(false);
		expect(h.push).toHaveBeenCalledWith('/target');
	});

	it('cancelNavigation dismisses the dialog and stays put', () => {
		const guarded = useUnsavedChanges();
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
