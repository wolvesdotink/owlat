import { describe, it, expect } from 'vitest';
import { ref } from 'vue';
import { useReviewQueueKeyboard } from '../useReviewQueueKeyboard';

type Row = { _id: string };

function key(k: string, target?: EventTarget): KeyboardEvent {
	const event = new KeyboardEvent('keydown', { key: k });
	if (target) Object.defineProperty(event, 'target', { value: target, configurable: true });
	return event;
}

function harness(items = [{ _id: 'a' }, { _id: 'b' }, { _id: 'c' }]) {
	const calls: Array<[string, string]> = [];
	const kb = useReviewQueueKeyboard<Row>({
		items: ref(items),
		resetKey: ref('ready'),
		rowDomId: (r) => `review-row-${r._id}`,
		onOpen: (r) => calls.push(['open', r._id]),
		onApprove: (r) => calls.push(['approve', r._id]),
		onEdit: (r) => calls.push(['edit', r._id]),
		onReject: (r) => calls.push(['reject', r._id]),
	});
	return { kb, calls };
}

describe('useReviewQueueKeyboard', () => {
	it('navigates with j/k and opens with Enter (reusing the Postbox list keyboard)', () => {
		const { kb, calls } = harness();
		kb.onKeydown(key('j'));
		expect(kb.focusedIndex.value).toBe(0);
		kb.onKeydown(key('j'));
		expect(kb.focusedIndex.value).toBe(1);
		kb.onKeydown(key('k'));
		expect(kb.focusedIndex.value).toBe(0);
		kb.onKeydown(key('Enter'));
		expect(calls).toEqual([['open', 'a']]);
	});

	it('maps a → approve, e → edit, x/# → reject on the focused row', () => {
		const { kb, calls } = harness();
		kb.onKeydown(key('j')); // focus 'a'
		kb.onKeydown(key('a'));
		kb.onKeydown(key('e'));
		kb.onKeydown(key('x'));
		kb.onKeydown(key('#'));
		expect(calls).toEqual([
			['approve', 'a'],
			['edit', 'a'],
			['reject', 'a'],
			['reject', 'a'],
		]);
	});

	it('the approve key routes through the SAME onApprove callback the button uses', () => {
		// The page wires onApprove to the undo-guarded send (onApproveClick →
		// approveDraft); pressing `a` must dispatch to that exact callback so a
		// mis-key is as recoverable as a mis-click — never a separate send path.
		let approved: string | null = null;
		const kb = useReviewQueueKeyboard<Row>({
			items: ref([{ _id: 'msg-1' }]),
			resetKey: ref('ready'),
			rowDomId: (r) => r._id,
			onOpen: () => {},
			onApprove: (r) => {
				approved = r._id;
			},
			onEdit: () => {},
			onReject: () => {},
		});
		kb.onKeydown(key('j'));
		kb.onKeydown(key('a'));
		expect(approved).toBe('msg-1');
	});

	it('is inert while an input has focus (typing a reply must not trigger triage)', () => {
		const { kb, calls } = harness();
		kb.onKeydown(key('j')); // focus a row first
		const input = document.createElement('input');
		kb.onKeydown(key('a', input));
		kb.onKeydown(key('x', input));
		kb.onKeydown(key('j', input));
		expect(calls).toEqual([]); // no approve/reject dispatched
		expect(kb.focusedIndex.value).toBe(0); // j ignored, focus unchanged
	});

	it('is inert while a contenteditable has focus', () => {
		const { kb, calls } = harness();
		kb.onKeydown(key('j'));
		const div = document.createElement('div');
		Object.defineProperty(div, 'isContentEditable', { value: true, configurable: true });
		kb.onKeydown(key('a', div));
		expect(calls).toEqual([]);
	});

	it('ignores Cmd/Ctrl/Alt chords (delegates that filter to the reused list keyboard)', () => {
		const { kb, calls } = harness();
		kb.onKeydown(key('j'));
		kb.onKeydown(new KeyboardEvent('keydown', { key: 'a', metaKey: true }));
		kb.onKeydown(new KeyboardEvent('keydown', { key: 'x', ctrlKey: true }));
		kb.onKeydown(new KeyboardEvent('keydown', { key: 'e', altKey: true }));
		expect(calls).toEqual([]);
	});
});
