/**
 * A composer that goes away with a debounced write still armed: a popup docked,
 * or Answer mode left by the browser's Back, within the 1.5 s debounce. The
 * edit exists nowhere else, so it is saved as the composer goes (creating the
 * row if there was none). Only a row-less composer's timer that holds nothing
 * the person wrote is dropped, so no empty draft is left behind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import { usePostboxComposeAutosave } from '../usePostboxComposeAutosave';

function setup(draftId: string | null = null) {
	const createRun = vi.fn(async () => ({ ok: true, result: { draftId: 'draft-new' } }));
	const updateRun = vi.fn(async () => ({ ok: true, result: { savedAt: 1 } }));
	const bodyHtml = ref(
		'<div class="gmail_quote"><blockquote>Could you send the invoice?</blockquote></div>'
	);
	const subject = ref('Re: Invoice');
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
			subject,
			bodyHtml,
			bodyBlocks: ref([]),
			composerMode: ref('simple'),
			followUpRemindAt: ref(null),
			createDraft: { run: createRun } as never,
			updateDraft: { run: updateRun } as never,
		})
	);
	return { scope, bodyHtml, subject, createRun, updateRun };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const QUOTE = '<div class="gmail_quote"><blockquote>Could you send the invoice?</blockquote></div>';

describe('usePostboxComposeAutosave — after the composer is gone', () => {
	it('saves an edit made in the last debounce window, creating the row (popup docked, Back)', async () => {
		const { scope, bodyHtml, createRun, updateRun } = setup();
		bodyHtml.value = `<p>Attached.</p>${QUOTE}`;
		await nextTick();

		scope.stop();
		await vi.advanceTimersByTimeAsync(0);

		expect(createRun).toHaveBeenCalledOnce();
		expect(updateRun).toHaveBeenCalledOnce();
		expect(updateRun.mock.calls[0]![0]).toMatchObject({ bodyHtml: `<p>Attached.</p>${QUOTE}` });
		// Saved once, not again when the debounce would have fired.
		await vi.advanceTimersByTimeAsync(2000);
		expect(updateRun).toHaveBeenCalledOnce();
	});

	it('saves an envelope-only edit too (a subject typed)', async () => {
		const { scope, subject, createRun } = setup();
		subject.value = 'Re: Invoice, PO inside';
		await nextTick();

		scope.stop();
		await vi.advanceTimersByTimeAsync(0);

		expect(createRun).toHaveBeenCalledOnce();
	});

	it('creates no row for an armed timer that holds nothing written (quote only)', async () => {
		const { scope, bodyHtml, createRun, updateRun } = setup();
		// A re-serialized quote, as a signature or hydration pass might write it.
		bodyHtml.value = `${QUOTE}<p><br></p>`;
		await nextTick();

		scope.stop();
		await vi.advanceTimersByTimeAsync(2000);

		expect(createRun).not.toHaveBeenCalled();
		expect(updateRun).not.toHaveBeenCalled();
	});

	it('still saves while mounted', async () => {
		const { bodyHtml, createRun, updateRun } = setup();
		bodyHtml.value = `<p>x</p>${QUOTE}`;
		await nextTick();

		await vi.advanceTimersByTimeAsync(2000);

		expect(createRun).toHaveBeenCalledOnce();
		expect(updateRun).toHaveBeenCalledOnce();
	});

	it('saves the pending write of a composer that already has its row, at once', async () => {
		const { scope, bodyHtml, createRun, updateRun } = setup('draft-1');
		bodyHtml.value = `<p>x</p>${QUOTE}`;
		await nextTick();

		scope.stop();
		await vi.advanceTimersByTimeAsync(0);

		expect(createRun).not.toHaveBeenCalled();
		expect(updateRun).toHaveBeenCalledOnce();
	});
});
