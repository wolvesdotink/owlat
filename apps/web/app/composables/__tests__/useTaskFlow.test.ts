import { describe, it, expect } from 'vitest';
import { ref, nextTick } from 'vue';
import { useTaskFlow } from '../useTaskFlow';
import type { TaskFlowKind, TaskFlowOrderKey } from '~/utils/taskFlow';

interface Task {
	id: string;
	kind: TaskFlowKind;
	threadId?: string;
	contactKey?: string;
}
const key = (t: Task): TaskFlowOrderKey => t;

function setup(initial: Task[]) {
	const source = ref<Task[]>(initial);
	const flow = useTaskFlow(source, { key });
	flow.start();
	return { source, flow };
}

describe('useTaskFlow — snapshot + ordering', () => {
	it('orders the queue at start (questions first, thread-adjacent)', () => {
		const { flow } = setup([
			{ id: 'r-T', kind: 'reply', threadId: 'T' },
			{ id: 'q-T', kind: 'question', threadId: 'T' },
			{ id: 'd-X', kind: 'draft_review', threadId: 'X' },
		]);
		expect(flow.current.value?.id).toBe('q-T');
		expect(flow.nextItem.value?.id).toBe('r-T');
		expect(flow.total.value).toBe(3);
		expect(flow.position.value).toBe(1);
	});

	it('appends live arrivals to the end and never moves the current card', async () => {
		const { source, flow } = setup([{ id: 'a', kind: 'reply' }]);
		expect(flow.current.value?.id).toBe('a');
		source.value = [
			{ id: 'a', kind: 'reply' },
			// A brand-new QUESTION would sort first, but snapshot semantics keep it
			// at the end — it must not jump ahead of the card in focus.
			{ id: 'z', kind: 'question' },
		];
		await nextTick();
		expect(flow.current.value?.id).toBe('a');
		expect(flow.total.value).toBe(2);
		expect(flow.newCount.value).toBe(1);
	});

	it('grows total (m) without pushing position backwards', async () => {
		const { source, flow } = setup([
			{ id: 'a', kind: 'reply' },
			{ id: 'b', kind: 'reply' },
		]);
		flow.complete('a', { outcome: 'done' });
		expect(flow.position.value).toBe(2);
		source.value = [
			{ id: 'b', kind: 'reply' },
			{ id: 'c', kind: 'reply' },
		];
		await nextTick();
		// New arrival grew the total; position held.
		expect(flow.total.value).toBe(3);
		expect(flow.position.value).toBe(2);
		expect(flow.newCount.value).toBe(1);
	});

	it('marks an externally-resolved item as removed and skips it in the peek', async () => {
		const { source, flow } = setup([
			{ id: 'a', kind: 'reply' },
			{ id: 'b', kind: 'reply' },
			{ id: 'c', kind: 'reply' },
		]);
		// 'b' gets replied to in another tab and leaves the source.
		source.value = [
			{ id: 'a', kind: 'reply' },
			{ id: 'c', kind: 'reply' },
		];
		await nextTick();
		// Current ('a') is untouched; the peek skips the removed 'b' to 'c'.
		expect(flow.current.value?.id).toBe('a');
		expect(flow.nextItem.value?.id).toBe('c');
		flow.complete('a', { outcome: 'done' });
		// Advancing jumps over the removed 'b' straight to 'c'.
		expect(flow.current.value?.id).toBe('c');
	});

	it('keeps rendering the current card from cache after it leaves the source', async () => {
		const { source, flow } = setup([{ id: 'a', kind: 'reply' }]);
		source.value = [];
		await nextTick();
		expect(flow.current.value?.id).toBe('a');
	});
});

describe('useTaskFlow — completion, undo, summary', () => {
	it('auto-advances and reaches the complete end state', () => {
		const { flow } = setup([
			{ id: 'a', kind: 'reply' },
			{ id: 'b', kind: 'reply' },
		]);
		flow.complete('a', { outcome: 'sent' });
		expect(flow.current.value?.id).toBe('b');
		expect(flow.isComplete.value).toBe(false);
		flow.complete('b', { outcome: 'sent' });
		expect(flow.isComplete.value).toBe(true);
		expect(flow.summary.value).toBe('2 sent');
	});

	it('ignores a stale complete() for a card that is not current', () => {
		const { flow } = setup([
			{ id: 'a', kind: 'reply' },
			{ id: 'b', kind: 'reply' },
		]);
		flow.complete('b', { outcome: 'sent' }); // not the current card
		expect(flow.current.value?.id).toBe('a');
		expect(flow.summary.value).toBe('');
	});

	it('undo restores the prior card, position, tally, and runs the inverse', async () => {
		const { flow } = setup([
			{ id: 'a', kind: 'reply' },
			{ id: 'b', kind: 'reply' },
		]);
		let inverseRan = false;
		flow.complete('a', { outcome: 'answered', inverse: () => void (inverseRan = true) });
		expect(flow.current.value?.id).toBe('b');
		expect(flow.summary.value).toBe('1 answered');
		expect(flow.canUndo.value).toBe(true);

		const did = await flow.undo();
		expect(did).toBe(true);
		expect(inverseRan).toBe(true);
		expect(flow.current.value?.id).toBe('a');
		expect(flow.position.value).toBe(1);
		expect(flow.summary.value).toBe('');
		expect(flow.canUndo.value).toBe(false);
	});

	it('undo returns false when there is nothing to undo', async () => {
		const { flow } = setup([{ id: 'a', kind: 'reply' }]);
		expect(await flow.undo()).toBe(false);
	});

	it('skip advances without recording an outcome or an undo', () => {
		const { flow } = setup([
			{ id: 'a', kind: 'reply' },
			{ id: 'b', kind: 'reply' },
		]);
		flow.skip('a');
		expect(flow.current.value?.id).toBe('b');
		expect(flow.summary.value).toBe('');
		expect(flow.canUndo.value).toBe(false);
	});

	it('undo awaits an ASYNC inverse before resolving (the un-send mutation)', async () => {
		// Piece C1: the review focus flow registers a true inverse that calls the
		// `undoAutoSend` mutation. The undo must await it so callers observe the
		// un-send having actually happened, not just the UI rewind.
		const { flow } = setup([
			{ id: 'a', kind: 'draft_review' },
			{ id: 'b', kind: 'draft_review' },
		]);
		let settled = false;
		flow.complete('a', {
			outcome: 'approved',
			inverse: async () => {
				await Promise.resolve();
				settled = true;
			},
		});
		const did = await flow.undo();
		expect(did).toBe(true);
		expect(settled).toBe(true);
		expect(flow.current.value?.id).toBe('a');
	});

	it('Cmd/Ctrl+Z (onWindowKeydown) runs the registered inverse and restores the card', async () => {
		// The focus flow's keyboard undo path: complete with an inverse (the
		// un-send), then a window-level Cmd+Z must fire that inverse — not merely
		// rewind the cursor.
		const { flow } = setup([
			{ id: 'a', kind: 'draft_review' },
			{ id: 'b', kind: 'draft_review' },
		]);
		let unSent = false;
		flow.complete('a', { outcome: 'approved', inverse: () => void (unSent = true) });
		expect(flow.current.value?.id).toBe('b');

		flow.onWindowKeydown(
			new KeyboardEvent('keydown', { key: 'z', metaKey: true, cancelable: true })
		);
		// undo() is fired async from the handler; let the microtask settle.
		await nextTick();

		expect(unSent).toBe(true);
		expect(flow.current.value?.id).toBe('a');
		expect(flow.summary.value).toBe('');
	});

	it('Cmd+Z stays inert while typing in an editable target', async () => {
		const { flow } = setup([
			{ id: 'a', kind: 'draft_review' },
			{ id: 'b', kind: 'draft_review' },
		]);
		let unSent = false;
		flow.complete('a', { outcome: 'approved', inverse: () => void (unSent = true) });

		const textarea = document.createElement('textarea');
		document.body.appendChild(textarea);
		const event = new KeyboardEvent('keydown', { key: 'z', metaKey: true, cancelable: true });
		Object.defineProperty(event, 'target', { value: textarea });
		flow.onWindowKeydown(event);
		await nextTick();

		expect(unSent).toBe(false);
		expect(flow.current.value?.id).toBe('b');
		textarea.remove();
	});

	it('undoById targets the RIGHT card: a later decision on another card stands', async () => {
		// Regression: the focus flow's countdown toast is bound to the APPROVED
		// card. Approve 'a' (toast up), reject 'b' within the window, click Undo —
		// 'a''s inverse (the un-send) must run and 'b''s rejection must stand. A
		// blanket undo() would pop 'b''s entry instead (UI-only rewind while 'a''s
		// held send still fires).
		const { flow } = setup([
			{ id: 'a', kind: 'draft_review' },
			{ id: 'b', kind: 'draft_review' },
			{ id: 'c', kind: 'draft_review' },
		]);
		let aUnsent = false;
		let bUndone = false;
		flow.complete('a', { outcome: 'approved', inverse: () => void (aUnsent = true) });
		flow.complete('b', { outcome: 'rejected', inverse: () => void (bUndone = true) });
		expect(flow.current.value?.id).toBe('c');

		const did = await flow.undoById('a');
		expect(did).toBe(true);
		expect(aUnsent).toBe(true);
		expect(bUndone).toBe(false);
		// 'b''s completion stands: the tally keeps its rejection, drops the approve.
		expect(flow.summary.value).toBe('1 rejected');
		// The current card is untouched; 'a' comes back around at the end.
		expect(flow.current.value?.id).toBe('c');
		flow.complete('c', { outcome: 'approved' });
		expect(flow.current.value?.id).toBe('a');
		expect(flow.isComplete.value).toBe(false);
	});

	it('undoById of the most recent completion behaves exactly like undo()', async () => {
		const { flow } = setup([
			{ id: 'a', kind: 'draft_review' },
			{ id: 'b', kind: 'draft_review' },
		]);
		let aUnsent = false;
		flow.complete('a', { outcome: 'approved', inverse: () => void (aUnsent = true) });
		expect(flow.current.value?.id).toBe('b');

		expect(await flow.undoById('a')).toBe(true);
		expect(aUnsent).toBe(true);
		expect(flow.current.value?.id).toBe('a');
		expect(flow.position.value).toBe(1);
		expect(flow.summary.value).toBe('');
		expect(flow.canUndo.value).toBe(false);
	});

	it('undoById returns false for an id that was never completed', async () => {
		const { flow } = setup([
			{ id: 'a', kind: 'draft_review' },
			{ id: 'b', kind: 'draft_review' },
		]);
		flow.complete('a', { outcome: 'approved' });
		expect(await flow.undoById('zz')).toBe(false);
		expect(await flow.undoById('b')).toBe(false); // current, not completed
		expect(flow.summary.value).toBe('1 approved');
	});

	it('after a mid-stack undoById, Cmd/Ctrl+Z still undoes the remaining action correctly', async () => {
		const { flow } = setup([
			{ id: 'a', kind: 'draft_review' },
			{ id: 'b', kind: 'draft_review' },
			{ id: 'c', kind: 'draft_review' },
		]);
		flow.complete('a', { outcome: 'approved' });
		flow.complete('b', { outcome: 'rejected' });
		await flow.undoById('a'); // 'a' re-queued at the end
		expect(flow.current.value?.id).toBe('c');

		// The stack now holds only 'b'; a plain undo restores exactly it.
		expect(await flow.undo()).toBe(true);
		expect(flow.current.value?.id).toBe('b');
		expect(flow.summary.value).toBe('');
	});

	it('undoById from the complete end state re-opens the flow on the restored card', async () => {
		const { flow } = setup([
			{ id: 'a', kind: 'draft_review' },
			{ id: 'b', kind: 'draft_review' },
		]);
		let aUnsent = false;
		flow.complete('a', { outcome: 'approved', inverse: () => void (aUnsent = true) });
		flow.complete('b', { outcome: 'rejected' });
		expect(flow.isComplete.value).toBe(true);

		expect(await flow.undoById('a')).toBe(true);
		expect(aUnsent).toBe(true);
		expect(flow.isComplete.value).toBe(false);
		expect(flow.current.value?.id).toBe('a');
		expect(flow.summary.value).toBe('1 rejected');
	});

	it('tallies distinct outcomes in first-seen order', () => {
		const { flow } = setup([
			{ id: 'a', kind: 'question' },
			{ id: 'b', kind: 'draft_review' },
			{ id: 'c', kind: 'question' },
		]);
		// snapshot order: a(question), c(question), b(draft_review)
		flow.complete(flow.currentId.value!, { outcome: 'answered' });
		flow.complete(flow.currentId.value!, { outcome: 'answered' });
		flow.complete(flow.currentId.value!, { outcome: 'approved' });
		expect(flow.summary.value).toBe('2 answered · 1 approved');
	});
});
