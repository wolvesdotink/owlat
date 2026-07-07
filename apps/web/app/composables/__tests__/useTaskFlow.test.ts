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
