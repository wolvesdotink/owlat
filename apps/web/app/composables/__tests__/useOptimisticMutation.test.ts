import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { ConvexError } from 'convex/values';
import { useOptimisticMutation } from '../useOptimisticMutation';

const fakeOp = 'api.test.update' as unknown as Parameters<typeof useOptimisticMutation>[0];

describe('useOptimisticMutation', () => {
	let mutation: ReturnType<typeof vi.fn>;
	let showToast: ReturnType<typeof vi.fn>;
	let captureError: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mutation = vi.fn();
		showToast = vi.fn(() => 'toast-id');
		captureError = vi.fn();
		vi.stubGlobal('useConvex', () => ({ mutation, action: vi.fn() }));
		vi.stubGlobal('useToast', () => ({ showToast }));
		vi.stubGlobal('usePostHog', () => ({ captureError }));
		vi.stubGlobal('navigateTo', vi.fn());
	});

	it('applies optimistically and keeps the change when the write succeeds', async () => {
		mutation.mockResolvedValue({ ok: true });
		const value = ref(false);
		const { run } = useOptimisticMutation(fakeOp, { label: 'toggle' });

		const result = await run(
			{ enabled: true },
			{
				apply: () => {
					const previous = value.value;
					value.value = true;
					return () => {
						value.value = previous;
					};
				},
			}
		);

		expect(result).toEqual({ ok: true });
		expect(value.value).toBe(true); // not reverted
		expect(mutation).toHaveBeenCalledWith(fakeOp, { enabled: true });
	});

	it('rolls back the optimistic change and toasts when the write fails', async () => {
		mutation.mockRejectedValue(new ConvexError({ category: 'forbidden', message: 'No access' }));
		const value = ref(false);
		const { run } = useOptimisticMutation(fakeOp, { label: 'toggle' });

		const result = await run(
			{ enabled: true },
			{
				apply: () => {
					const previous = value.value;
					value.value = true;
					return () => {
						value.value = previous;
					};
				},
			}
		);

		expect(result).toBeUndefined();
		expect(value.value).toBe(false); // reverted to the pre-apply value
		expect(showToast).toHaveBeenCalledWith('No access', 'error');
	});

	it('applies before awaiting the write (the action feels done on click)', async () => {
		let resolve!: (v: unknown) => void;
		mutation.mockReturnValue(new Promise((r) => (resolve = r)));
		const value = ref(false);
		const { run } = useOptimisticMutation(fakeOp, { label: 'toggle' });

		const pending = run(
			{ enabled: true },
			{
				apply: () => {
					value.value = true;
					return () => {
						value.value = false;
					};
				},
			}
		);

		// Optimistic change is visible immediately, before the write settles.
		expect(value.value).toBe(true);
		resolve({ ok: true });
		await pending;
		expect(value.value).toBe(true);
	});

	it('offers an Undo toast after a successful write and runs the inverse once', async () => {
		mutation.mockResolvedValue({ ok: true });
		const inverse = vi.fn();
		const { run } = useOptimisticMutation(fakeOp, { label: 'toggle' });

		await run(
			{ enabled: false },
			{
				apply: () => () => {},
				undo: { label: 'Sender disabled', inverse },
			}
		);

		const undoCall = showToast.mock.calls.find((c) => c[0] === 'Sender disabled');
		expect(undoCall).toBeDefined();
		const options = undoCall?.[2] as
			| { action?: { label: string; onAction: () => void } }
			| undefined;
		expect(options?.action?.label).toBe('Undo');
		options?.action?.onAction();
		options?.action?.onAction(); // second click is a no-op
		expect(inverse).toHaveBeenCalledTimes(1);
	});

	it('does not offer Undo when the write fails', async () => {
		mutation.mockRejectedValue(new ConvexError({ category: 'internal', message: 'boom' }));
		const inverse = vi.fn();
		const { run } = useOptimisticMutation(fakeOp, { label: 'toggle' });

		await run(
			{ enabled: false },
			{
				apply: () => () => {},
				undo: { label: 'Sender disabled', inverse },
			}
		);

		expect(showToast).not.toHaveBeenCalledWith('Sender disabled', 'success', expect.anything());
		expect(inverse).not.toHaveBeenCalled();
	});
});
