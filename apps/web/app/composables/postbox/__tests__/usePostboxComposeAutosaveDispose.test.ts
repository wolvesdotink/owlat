/**
 * A composer that goes away before its first save must not create a draft row
 * afterwards. Answer mode unmounts its composer on Esc; a debounced write armed
 * in the last 1.5 s would otherwise run after the unmount and leave a row that
 * is neither in the URL nor offered back by the "Draft saved" bar.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import { usePostboxComposeAutosave } from '../usePostboxComposeAutosave';

function setup(draftId: string | null = null) {
	const createRun = vi.fn(async () => ({ ok: true, result: { draftId: 'draft-new' } }));
	const updateRun = vi.fn(async () => ({ ok: true, result: { savedAt: 1 } }));
	const bodyHtml = ref('<p>seed</p>');
	const scope = effectScope();
	scope.run(() =>
		usePostboxComposeAutosave({
			mailboxId: 'mbx-1' as never,
			inReplyToMessageId: 'msg-1' as never,
			draftId: ref(draftId as never),
			draftState: ref('draft'),
			initialHydration: ref('ready'),
			ensuring: ref(false),
			isSaving: ref(false),
			lastSavedAt: ref(null),
			toAddresses: ref(['jonas@example.com']),
			ccAddresses: ref([]),
			bccAddresses: ref([]),
			subject: ref('Re: Invoice'),
			bodyHtml,
			bodyBlocks: ref([]),
			composerMode: ref('simple'),
			followUpRemindAt: ref(null),
			createDraft: { run: createRun } as never,
			updateDraft: { run: updateRun } as never,
		})
	);
	return { scope, bodyHtml, createRun, updateRun };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('usePostboxComposeAutosave — after the composer is gone', () => {
	it('creates no row when the composer unmounts inside the debounce window', async () => {
		const { scope, bodyHtml, createRun, updateRun } = setup();
		bodyHtml.value = '<p>seed</p><p>x</p>';
		await nextTick();

		scope.stop();
		await vi.advanceTimersByTimeAsync(2000);

		expect(createRun).not.toHaveBeenCalled();
		expect(updateRun).not.toHaveBeenCalled();
	});

	it('still saves while mounted', async () => {
		const { bodyHtml, createRun, updateRun } = setup();
		bodyHtml.value = '<p>seed</p><p>x</p>';
		await nextTick();

		await vi.advanceTimersByTimeAsync(2000);

		expect(createRun).toHaveBeenCalledOnce();
		expect(updateRun).toHaveBeenCalledOnce();
	});

	it('keeps the pending write of a composer that already has its row', async () => {
		const { scope, bodyHtml, createRun, updateRun } = setup('draft-1');
		bodyHtml.value = '<p>seed</p><p>x</p>';
		await nextTick();

		scope.stop();
		await vi.advanceTimersByTimeAsync(2000);

		expect(createRun).not.toHaveBeenCalled();
		expect(updateRun).toHaveBeenCalledOnce();
	});
});
