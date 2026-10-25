import de from '~~/i18n/locales/de.json';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ref } from 'vue';
import { ConvexError } from 'convex/values';
import { useI18n } from 'vue-i18n';
import { useAnnounce } from '../useAnnounce';
import { useBackendOperation } from '../useBackendOperation';
import { createTestI18n } from '~/__tests__/i18n';
import { withSetup } from '~/__tests__/withSetup';
import {
	EPISODE_QUIET_MS,
	onSlowEpisodeEnd,
	resetPendingOperations,
	slowOperations,
	SLOW_OPERATION_MS,
} from '~/lib/pendingOperations';

/** The real catalog behind the `useI18n` auto-import the composable calls. */
const i18n = createTestI18n();
i18n.global.setLocaleMessage('de', de);

const fakeOp = 'api.test.create' as unknown as Parameters<typeof useBackendOperation>[0];

/**
 * Built inside a component `setup()`, as every page builds it: the composable
 * resolves the catalog only where a component instance exists (a route guard
 * reaching it through `useOrganization()` gets the key fallback instead).
 */
function build(...args: Parameters<typeof useBackendOperation>) {
	return withSetup(() => useBackendOperation(...args)).result;
}

describe('useBackendOperation', () => {
	let mutation: ReturnType<typeof vi.fn>;
	let action: ReturnType<typeof vi.fn>;
	let showToast: ReturnType<typeof vi.fn>;
	let captureError: ReturnType<typeof vi.fn>;
	let navigate: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		i18n.global.locale.value = 'en';
		mutation = vi.fn();
		action = vi.fn();
		showToast = vi.fn();
		captureError = vi.fn();
		navigate = vi.fn();
		vi.stubGlobal('useI18n', () => i18n.global);
		vi.stubGlobal('useConvex', () => ({ mutation, action }));
		vi.stubGlobal('useToast', () => ({ showToast }));
		vi.stubGlobal('usePostHog', () => ({ captureError }));
		vi.stubGlobal('navigateTo', navigate);
		// The REAL announcer: what a successful write says into the live region
		// is behaviour this composable owns, and a spy would only prove it called
		// something.
		vi.stubGlobal('useAnnounce', useAnnounce);
		useAnnounce().clear();
	});

	it('reads the current locale when an already-created operation fails', async () => {
		const { run } = build(fakeOp, { label: 'change' });
		i18n.global.locale.value = 'de';
		mutation.mockRejectedValue(
			new ConvexError({ category: 'forbidden', message: 'Backend English' })
		);
		await run({});
		expect(showToast).toHaveBeenCalledWith(de.shared.operationError.categories.forbidden, 'error');
	});

	describe('outside a component (route middleware)', () => {
		it('builds without a catalog instead of throwing, and still runs the operation', async () => {
			// vue-i18n's real useI18n: throws unless called inside a component setup.
			vi.stubGlobal('useI18n', useI18n);
			mutation.mockResolvedValue({ id: '1' });

			const { run } = useBackendOperation(fakeOp, { label: 'create' });

			expect(await run({ name: 'x' })).toEqual({ ok: true, result: { id: '1' } });
		});
	});

	describe('success path', () => {
		it('returns an ok envelope around the result and surfaces nothing', async () => {
			mutation.mockResolvedValue({ id: '1' });
			const { run, isLoading, inlineError } = build(fakeOp, { label: 'create' });

			const result = await run({ name: 'x' });

			expect(result).toEqual({ ok: true, result: { id: '1' } });
			expect(mutation).toHaveBeenCalledWith(fakeOp, { name: 'x' });
			expect(showToast).not.toHaveBeenCalled();
			expect(captureError).not.toHaveBeenCalled();
			expect(isLoading.value).toBe(false);
			expect(inlineError.value).toBeNull();
		});

		it('tells a successful `undefined` return apart from a failure', async () => {
			// The reason `run` hands back an envelope at all: plenty of mutations
			// resolve `undefined`/`null` on a perfectly good write, and the old
			// `T | undefined` signature made that indistinguishable from "failed".
			mutation.mockResolvedValue(undefined);
			const { run } = build(fakeOp, { label: 'create' });

			expect(await run({})).toEqual({ ok: true, result: undefined });
			expect(showToast).not.toHaveBeenCalled();
		});

		it('toggles isLoading during the call', async () => {
			let resolve!: (v: unknown) => void;
			mutation.mockReturnValue(new Promise((r) => (resolve = r)));
			const { run, isLoading } = build(fakeOp, { label: 'create' });

			const p = run({});
			expect(isLoading.value).toBe(true);
			resolve({ ok: true });
			await p;
			expect(isLoading.value).toBe(false);
		});

		it('dispatches to client.action when type is action', async () => {
			action.mockResolvedValue('done');
			const { run } = build(fakeOp, { label: 'send', type: 'action' });

			await run({});

			expect(action).toHaveBeenCalledOnce();
			expect(mutation).not.toHaveBeenCalled();
		});
	});

	/**
	 * Most of this app's saves repaint nothing louder than a button label, so
	 * without this a screen-reader user gets no confirmation that a write landed
	 * at all. Announcing HERE rather than at the call sites is the point: this is
	 * the one place every successful mutation in the app passes through.
	 */
	describe('announcement', () => {
		it('announces a completed write with the operation label', async () => {
			mutation.mockResolvedValue(null);
			const { run } = build(fakeOp, { label: 'Save signature' });

			await run({});

			expect(useAnnounce().politeMessage.value).toBe('Done: Save signature');
		});

		it('calls a getter label at announcement time, not at setup time', async () => {
			mutation.mockResolvedValue(null);
			let label = 'Save signature';
			const { run } = build(fakeOp, { label: () => label });

			label = 'Save snippet';
			await run({});

			expect(useAnnounce().politeMessage.value).toBe('Done: Save snippet');
		});

		it('re-announces an identical save so the second one is not silent', async () => {
			mutation.mockResolvedValue(null);
			const { run } = build(fakeOp, { label: 'Save signature' });

			await run({});
			const first = useAnnounce().politeMessage.value;
			await run({});

			// Same words, different DOM text — a live region only speaks on change.
			expect(useAnnounce().politeMessage.value).not.toBe(first);
			expect(useAnnounce().politeMessage.value.trim()).toBe('Done: Save signature');
		});

		it('stays quiet when the caller opts out', async () => {
			mutation.mockResolvedValue(null);
			const { run } = build(fakeOp, { label: 'Autosave draft', announce: false });

			await run({});

			expect(useAnnounce().politeMessage.value).toBe('');
		});

		it('says nothing on a failure — the toast already does, assertively', async () => {
			mutation.mockRejectedValue(new ConvexError({ category: 'forbidden', message: 'No access' }));
			const { run } = build(fakeOp, { label: 'Save signature' });

			await run({});

			expect(showToast).toHaveBeenCalled();
			expect(useAnnounce().politeMessage.value).toBe('');
		});
	});

	describe('treatment policy', () => {
		it('toasts a forbidden error with the backend message and does not report', async () => {
			mutation.mockRejectedValue(new ConvexError({ category: 'forbidden', message: 'No access' }));
			const { run } = build(fakeOp, { label: 'create' });

			const result = await run({});

			expect(result).toEqual({ ok: false });
			expect(showToast).toHaveBeenCalledWith('No access', 'error');
			expect(captureError).not.toHaveBeenCalled();
			expect(navigate).not.toHaveBeenCalled();
		});

		it('toasts generic copy and reports for an internal (non-Operation) throw', async () => {
			mutation.mockRejectedValue(new Error('TypeError: boom'));
			const { run } = build(fakeOp, { label: 'create' });

			await run({});

			expect(showToast).toHaveBeenCalledWith('Something went wrong. Please try again.', 'error');
			expect(captureError).toHaveBeenCalledOnce();
		});

		it('toasts and reports for a network (transport) failure', async () => {
			mutation.mockRejectedValue(new TypeError('Failed to fetch'));
			const { run } = build(fakeOp, { label: 'create' });

			await run({});

			expect(showToast).toHaveBeenCalledWith(
				expect.stringContaining('Connection problem'),
				'error'
			);
			expect(captureError).toHaveBeenCalledOnce();
		});

		it('redirects to login on unauthenticated', async () => {
			mutation.mockRejectedValue(new ConvexError({ category: 'unauthenticated', message: 'nope' }));
			const { run } = build(fakeOp, { label: 'create' });

			await run({});

			expect(navigate).toHaveBeenCalledWith('/auth/login');
			expect(showToast).toHaveBeenCalledWith(
				expect.stringContaining('session has expired'),
				'error'
			);
			expect(captureError).not.toHaveBeenCalled();
		});
	});

	describe('inlineTarget', () => {
		it('writes inlineError on invalid_input when a target is bound (no toast)', async () => {
			mutation.mockRejectedValue(
				new ConvexError({ category: 'invalid_input', message: 'Email is invalid' })
			);
			const target = ref<string | null>(null);
			const { run, inlineError } = build(fakeOp, {
				label: 'create',
				inlineTarget: target,
			});

			await run({});

			expect(target.value).toBe('Email is invalid');
			expect(inlineError.value).toBe('Email is invalid');
			expect(showToast).not.toHaveBeenCalled();
		});

		it('falls back to a toast on invalid_input when no target is bound', async () => {
			mutation.mockRejectedValue(
				new ConvexError({ category: 'already_exists', message: 'Already taken' })
			);
			const { run, inlineError } = build(fakeOp, { label: 'create' });

			await run({});

			expect(showToast).toHaveBeenCalledWith('Already taken', 'error');
			expect(inlineError.value).toBeNull();
		});

		it('clears a previous inline error at the start of each run', async () => {
			const target = ref<string | null>('stale');
			mutation.mockResolvedValue({ ok: true });
			const { run } = build(fakeOp, { label: 'create', inlineTarget: target });

			await run({});

			expect(target.value).toBeNull();
		});
	});

	describe('onError claim', () => {
		it('suppresses the default surface when the caller claims the failure', async () => {
			mutation.mockRejectedValue(
				new ConvexError({
					category: 'invalid_state',
					message: 'This campaign is larger than your sending capacity allows in one go.',
					data: { reason: 'exceeds_sending_capacity', capacityPlan: { days: 5 } },
				})
			);
			const seen: unknown[] = [];
			const { run } = build(fakeOp, {
				label: 'send',
				onError: (op) => {
					seen.push(op.data);
					return true;
				},
			});

			const result = await run({});

			expect(result).toEqual({ ok: false });
			expect(seen).toEqual([{ reason: 'exceeds_sending_capacity', capacityPlan: { days: 5 } }]);
			expect(showToast).not.toHaveBeenCalled();
			expect(captureError).not.toHaveBeenCalled();
		});

		it('falls through to the normal treatment when the caller declines', async () => {
			mutation.mockRejectedValue(
				new ConvexError({ category: 'invalid_state', message: 'No template' })
			);
			const { run } = build(fakeOp, {
				label: 'send',
				onError: () => false,
			});

			await run({});

			expect(showToast).toHaveBeenCalledWith('No template', 'error');
		});

		it("uses a run's own claim instead of the operation's", async () => {
			mutation.mockRejectedValue(
				new ConvexError({ category: 'invalid_state', message: 'No template' })
			);
			const { run } = build(fakeOp, { label: 'send', onError: () => true });

			await run({}, { onError: () => false });
			expect(showToast).toHaveBeenCalledWith('No template', 'error');

			showToast.mockClear();
			await run({});
			expect(showToast).not.toHaveBeenCalled();
		});

		it('does not suppress reporting on a genuine fault the caller declines', async () => {
			mutation.mockRejectedValue(new Error('kaboom'));
			const { run } = build(fakeOp, { label: 'send', onError: () => false });

			await run({});

			expect(captureError).toHaveBeenCalledOnce();
		});
	});

	describe('optimisticUpdate', () => {
		it("hands the operation's optimistic update to client.mutation", async () => {
			mutation.mockResolvedValue(null);
			const optimisticUpdate = vi.fn();
			const { run } = build(fakeOp, { label: 'star', optimisticUpdate });

			await run({ id: 'm1' });

			expect(mutation).toHaveBeenCalledWith(fakeOp, { id: 'm1' }, { optimisticUpdate });
		});

		it('lets one run use its own optimistic update instead', async () => {
			mutation.mockResolvedValue(null);
			const own = vi.fn();
			const perRun = vi.fn();
			const { run } = build(fakeOp, { label: 'star', optimisticUpdate: own });

			await run({ id: 'm1' }, { optimisticUpdate: perRun });

			expect(mutation).toHaveBeenCalledWith(fakeOp, { id: 'm1' }, { optimisticUpdate: perRun });
		});

		it('keeps the plain two-argument call without one', async () => {
			mutation.mockResolvedValue(null);
			const { run } = build(fakeOp, { label: 'star' });

			await run({ id: 'm1' }, {});

			expect(mutation.mock.calls[0]).toEqual([fakeOp, { id: 'm1' }]);
		});

		it('still applies the failure policy when an optimistic write fails', async () => {
			mutation.mockRejectedValue(
				new ConvexError({ category: 'forbidden', message: 'Backend English' })
			);
			const { run } = build(fakeOp, { label: 'star', optimisticUpdate: vi.fn() });

			expect(await run({ id: 'm1' })).toEqual({ ok: false });
			expect(showToast).toHaveBeenCalledWith(expect.any(String), 'error');
		});
	});

	describe('null client', () => {
		it('toasts and returns a failure envelope without throwing', async () => {
			vi.stubGlobal('useConvex', () => null);
			const { run } = build(fakeOp, { label: 'create' });

			const result = await run({});

			expect(result).toEqual({ ok: false });
			expect(showToast).toHaveBeenCalledWith('Something went wrong. Please try again.', 'error');
		});
	});
	/**
	 * Every mutation run is registered app-wide, so the shell can say when
	 * saving is slow and confirm when it landed (lib/pendingOperations.ts).
	 */
	describe('pending-operation tracking', () => {
		afterEach(() => {
			resetPendingOperations();
			vi.useRealTimers();
		});

		/** A promise the test settles by hand, so nothing waits on the real clock. */
		function deferred<T>() {
			let resolve!: (value: T) => void;
			let reject!: (error: unknown) => void;
			const promise = new Promise<T>((res, rej) => {
				resolve = res;
				reject = rej;
			});
			return { promise, resolve, reject };
		}

		it('lists a mutation still pending after the threshold, under its current label', async () => {
			vi.useFakeTimers();
			const pending = deferred<unknown>();
			mutation.mockReturnValue(pending.promise);
			let label = 'Archive';
			const { run } = build(fakeOp, { label: () => label });

			const result = run({});
			label = 'Archivieren';
			vi.advanceTimersByTime(SLOW_OPERATION_MS);
			expect(slowOperations.value.map((op) => op.label)).toEqual(['Archivieren']);

			pending.resolve({ ok: 1 });
			await result;
			expect(slowOperations.value).toEqual([]);
		});

		it('settles overlapping runs of one operation independently', async () => {
			vi.useFakeTimers();
			const first = deferred<unknown>();
			const second = deferred<unknown>();
			mutation.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
			const outcomes: string[] = [];
			const stop = onSlowEpisodeEnd((outcome) => outcomes.push(outcome));
			const { run, isLoading } = build(fakeOp, { label: 'save' });

			const a = run({});
			const b = run({});
			vi.advanceTimersByTime(SLOW_OPERATION_MS);
			expect(slowOperations.value).toHaveLength(2);

			first.resolve(1);
			await a;
			// The shared loading flag already reads false; the registry still knows b.
			expect(isLoading.value).toBe(false);
			expect(slowOperations.value).toHaveLength(1);
			expect(outcomes).toEqual([]);

			second.resolve(2);
			await b;
			vi.advanceTimersByTime(EPISODE_QUIET_MS);
			expect(outcomes).toEqual(['saved']);
			stop();
		});

		it('records a rejected mutation as failed, after its error treatment', async () => {
			vi.useFakeTimers();
			const pending = deferred<unknown>();
			mutation.mockReturnValue(pending.promise);
			const outcomes: string[] = [];
			const stop = onSlowEpisodeEnd((outcome) => outcomes.push(outcome));
			const { run } = build(fakeOp, { label: 'save' });

			const result = run({});
			vi.advanceTimersByTime(SLOW_OPERATION_MS);
			pending.reject(new ConvexError({ category: 'forbidden', message: 'No' }));

			expect(await result).toEqual({ ok: false });
			expect(showToast).toHaveBeenCalledWith(expect.any(String), 'error');
			vi.advanceTimersByTime(EPISODE_QUIET_MS);
			expect(outcomes).toEqual(['failed']);
			stop();
		});

		/**
		 * The Team inbox follow-up's collision answer: the write resolves, but
		 * the reply was not sent, so the slow episode must not end in "saved".
		 */
		it('records a refusal returned as a value as not saved, and still hands it back', async () => {
			vi.useFakeTimers();
			const pending = deferred<unknown>();
			mutation.mockReturnValue(pending.promise);
			const outcomes: string[] = [];
			const stop = onSlowEpisodeEnd((outcome) => outcomes.push(outcome));
			const { run } = build(fakeOp, { label: 'send follow-up' });

			const result = run({});
			vi.advanceTimersByTime(SLOW_OPERATION_MS);
			const refusal = { success: false, reason: 'reply_in_progress', heldByName: 'Jordan' };
			pending.resolve(refusal);

			expect(await result).toEqual({ ok: true, result: refusal });
			expect(showToast).not.toHaveBeenCalled();
			vi.advanceTimersByTime(EPISODE_QUIET_MS);
			expect(outcomes).toEqual(['failed']);
			stop();
		});

		it.each([
			['an `ok: false` answer', { ok: false, refusal: 'invalid-address' }],
			['a non-null `refusal` field', { applied: false, refusal: 'ramp_paused' }],
		])('reads %s as a refusal by default', async (_name, answer) => {
			vi.useFakeTimers();
			const pending = deferred<unknown>();
			mutation.mockReturnValue(pending.promise);
			const outcomes: string[] = [];
			const stop = onSlowEpisodeEnd((outcome) => outcomes.push(outcome));
			const { run } = build(fakeOp, { label: 'save' });

			const result = run({});
			vi.advanceTimersByTime(SLOW_OPERATION_MS);
			pending.resolve(answer);
			expect(await result).toEqual({ ok: true, result: answer });
			vi.advanceTimersByTime(EPISODE_QUIET_MS);
			expect(outcomes).toEqual(['failed']);
			stop();
		});

		it.each([
			['`success: true`', { success: true }],
			['a null `refusal`', { applied: false, refusal: null, phaseCeiling: 3 }],
			['a bare value', false],
		])('confirms a result with %s as saved', async (_name, answer) => {
			vi.useFakeTimers();
			const pending = deferred<unknown>();
			mutation.mockReturnValue(pending.promise);
			const outcomes: string[] = [];
			const stop = onSlowEpisodeEnd((outcome) => outcomes.push(outcome));
			const { run } = build(fakeOp, { label: 'save' });

			const result = run({});
			vi.advanceTimersByTime(SLOW_OPERATION_MS);
			pending.resolve(answer);
			await result;
			vi.advanceTimersByTime(EPISODE_QUIET_MS);
			expect(outcomes).toEqual(['saved']);
			stop();
		});

		it('lets the caller classify its own refusal shape instead of the default', async () => {
			vi.useFakeTimers();
			const first = deferred<unknown>();
			const second = deferred<unknown>();
			mutation.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
			const outcomes: string[] = [];
			const stop = onSlowEpisodeEnd((outcome) => outcomes.push(outcome));
			const { run } = build(fakeOp, {
				label: 'resend',
				isRefusal: (answer) => (answer as { sent?: boolean }).sent === false,
			});

			// The default would read `success: false` as a refusal; this caller says
			// it is not one.
			const a = run({});
			vi.advanceTimersByTime(SLOW_OPERATION_MS);
			first.resolve({ success: false, sent: true });
			await a;
			vi.advanceTimersByTime(EPISODE_QUIET_MS);
			expect(outcomes).toEqual(['saved']);

			const b = run({});
			vi.advanceTimersByTime(SLOW_OPERATION_MS);
			second.resolve({ sent: false });
			expect(await b).toEqual({ ok: true, result: { sent: false } });
			vi.advanceTimersByTime(EPISODE_QUIET_MS);
			expect(outcomes).toEqual(['saved', 'failed']);
			stop();
		});

		it('withholds "saved" without changing the envelope when the classifier throws', async () => {
			vi.useFakeTimers();
			const pending = deferred<unknown>();
			mutation.mockReturnValue(pending.promise);
			const outcomes: string[] = [];
			const stop = onSlowEpisodeEnd((outcome) => outcomes.push(outcome));
			const { run } = build(fakeOp, {
				label: 'save',
				isRefusal: () => {
					throw new Error('unexpected shape');
				},
			});

			const result = run({});
			vi.advanceTimersByTime(SLOW_OPERATION_MS);
			pending.resolve({ id: 'x' });
			expect(await result).toEqual({ ok: true, result: { id: 'x' } });
			expect(showToast).not.toHaveBeenCalled();
			vi.advanceTimersByTime(EPISODE_QUIET_MS);
			expect(outcomes).toEqual(['failed']);
			stop();
		});

		it('leaves upload-URL mints out: minting saves nothing, so it confirms nothing', async () => {
			vi.useFakeTimers();
			const pending = deferred<unknown>();
			mutation.mockReturnValue(pending.promise);
			const outcomes: string[] = [];
			const stop = onSlowEpisodeEnd((outcome) => outcomes.push(outcome));
			const mint = 'storage:generateUploadUrl' as unknown as Parameters<
				typeof useBackendOperation
			>[0];
			const { run } = build(mint, { label: 'get upload URL' });

			const result = run({});
			vi.advanceTimersByTime(SLOW_OPERATION_MS * 2);
			expect(slowOperations.value).toEqual([]);

			pending.resolve('https://upload.owlat.example/1');
			await result;
			vi.advanceTimersByTime(EPISODE_QUIET_MS);
			expect(outcomes).toEqual([]);
			stop();
		});

		it('leaves actions out: a long AI or provider call is not slow saving', async () => {
			vi.useFakeTimers();
			const pending = deferred<unknown>();
			action.mockReturnValue(pending.promise);
			const { run } = build(fakeOp, { label: 'draft', type: 'action' });

			const result = run({});
			vi.advanceTimersByTime(SLOW_OPERATION_MS * 3);
			expect(slowOperations.value).toEqual([]);

			pending.resolve('done');
			await result;
		});
	});
});
