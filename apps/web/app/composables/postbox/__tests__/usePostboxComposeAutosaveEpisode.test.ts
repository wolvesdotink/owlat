/**
 * The composer's autosave and the app-wide "All changes saved": an edit is
 * only saved once its write has landed. An edit still waiting for its debounce
 * keeps a slow episode open, and an edit whose write failed vetoes the next
 * episode's "saved" until a later write lands.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { api } from '@owlat/api';
import { withSetup } from '~/__tests__/withSetup';
import { createTestI18n } from '~/__tests__/i18n';
import { useBackendOperation } from '~/composables/useBackendOperation';
import { usePostboxComposeAutosave } from '../usePostboxComposeAutosave';
import { usePostboxComposeTouched } from '../usePostboxComposeTouched';
import {
	EPISODE_QUIET_MS,
	onSlowEpisodeEnd,
	resetPendingOperations,
	SLOW_OPERATION_MS,
	trackPendingOperation,
	type SlowEpisodeOutcome,
} from '~/lib/pendingOperations';

const DEBOUNCE_MS = 1500;
const i18n = createTestI18n();

let mutation: ReturnType<typeof vi.fn>;
let outcomes: SlowEpisodeOutcome[];
let cleanup: () => void;
let stopListening: () => void;

function mountComposer() {
	const fields = {
		toAddresses: ref(['reader@owlat.example']),
		ccAddresses: ref<string[]>([]),
		bccAddresses: ref<string[]>([]),
		subject: ref('Draft'),
		bodyHtml: ref(''),
		bodyBlocks: ref([]),
		composerMode: ref<'simple' | 'full'>('simple'),
		followUpRemindAt: ref<number | null>(null),
	};
	const mounted = withSetup(() =>
		usePostboxComposeAutosave({
			mailboxId: 'mailbox-1' as never,
			draftId: ref('draft-1' as never),
			draftState: ref('draft'),
			initialHydration: ref('ready'),
			ensuring: ref(false),
			isSaving: ref(false),
			lastSavedAt: ref(null),
			touched: usePostboxComposeTouched(fields, ['toAddresses', 'subject', 'bodyHtml']),
			onReopenExisting: () => {},
			onGone: () => {},
			...fields,
			createDraft: useBackendOperation(api.mail.drafts.create, {
				label: 'Create draft',
				announce: false,
			}),
			updateDraft: useBackendOperation(api.mail.drafts.update, {
				label: 'Save draft',
				announce: false,
			}),
		})
	);
	cleanup = () => {
		mounted.result.cancelAutosave();
		mounted.unmount();
	};
	return { ...mounted.result, bodyHtml: fields.bodyHtml };
}

/** Hold the next draft write open; resolve it through the returned function. */
function holdNextWrite(): (value: unknown) => void {
	let resolve!: (value: unknown) => void;
	mutation.mockImplementationOnce(
		() =>
			new Promise((settle) => {
				resolve = settle;
			})
	);
	return (value) => resolve(value);
}

beforeEach(() => {
	vi.useFakeTimers();
	mutation = vi.fn(async () => ({ savedAt: 1 }));
	vi.stubGlobal('useI18n', () => i18n.global);
	vi.stubGlobal('useConvex', () => ({ mutation }));
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	vi.stubGlobal('useAnnounce', () => ({ announce: vi.fn() }));
	vi.stubGlobal('usePostHog', () => ({ captureError: vi.fn() }));
	outcomes = [];
	stopListening = onSlowEpisodeEnd((outcome) => outcomes.push(outcome));
	cleanup = () => {};
});
afterEach(() => {
	cleanup();
	stopListening();
	resetPendingOperations();
	vi.useRealTimers();
});

describe('usePostboxComposeAutosave and the slow-save episode', () => {
	it('confirms nothing while a newer edit waits for its debounce, then confirms once it lands', async () => {
		const { bodyHtml } = mountComposer();
		const resolveFirst = holdNextWrite();
		bodyHtml.value = '<p>First edit</p>';
		await nextTick();
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
		await vi.advanceTimersByTimeAsync(SLOW_OPERATION_MS);

		// Edited just before the slow write lands.
		bodyHtml.value = '<p>Newer edit</p>';
		await nextTick();
		resolveFirst({ savedAt: 1 });
		await vi.advanceTimersByTimeAsync(EPISODE_QUIET_MS);
		expect(mutation).toHaveBeenCalledOnce();
		expect(outcomes).toEqual([]);

		// The debounce fires and the newer edit lands: now everything is saved.
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - EPISODE_QUIET_MS);
		expect(mutation).toHaveBeenCalledTimes(2);
		expect(mutation.mock.calls[1]![1]).toMatchObject({ bodyHtml: '<p>Newer edit</p>' });
		await vi.advanceTimersByTimeAsync(EPISODE_QUIET_MS);
		expect(outcomes).toEqual(['saved']);
	});

	it('an edit whose write failed vetoes a later episode until a write lands', async () => {
		const { bodyHtml } = mountComposer();
		mutation.mockRejectedValueOnce(new Error('offline'));
		bodyHtml.value = '<p>Lost edit</p>';
		await nextTick();
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + EPISODE_QUIET_MS);
		expect(mutation).toHaveBeenCalledOnce();

		const other = trackPendingOperation(() => 'Archive');
		await vi.advanceTimersByTimeAsync(SLOW_OPERATION_MS);
		other(true);
		await vi.advanceTimersByTimeAsync(EPISODE_QUIET_MS);
		expect(outcomes).toEqual(['unconfirmed']);

		bodyHtml.value = '<p>Lost edit, again</p>';
		await nextTick();
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + EPISODE_QUIET_MS);
		const next = trackPendingOperation(() => 'Archive');
		await vi.advanceTimersByTimeAsync(SLOW_OPERATION_MS);
		next(true);
		await vi.advanceTimersByTimeAsync(EPISODE_QUIET_MS);
		expect(outcomes).toEqual(['unconfirmed', 'saved']);
	});

	it('a dropped debounce (discard) no longer holds the episode open', async () => {
		const { bodyHtml, cancelAutosave } = mountComposer();
		const other = trackPendingOperation(() => 'Archive');
		await vi.advanceTimersByTimeAsync(SLOW_OPERATION_MS);
		bodyHtml.value = '<p>About to be discarded</p>';
		await nextTick();
		other(true);
		await vi.advanceTimersByTimeAsync(EPISODE_QUIET_MS);
		expect(outcomes).toEqual([]);

		cancelAutosave();
		await vi.advanceTimersByTimeAsync(EPISODE_QUIET_MS);
		expect(outcomes).toEqual(['saved']);
		expect(mutation).not.toHaveBeenCalled();
	});
});
