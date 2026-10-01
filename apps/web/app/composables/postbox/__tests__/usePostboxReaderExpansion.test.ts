import { describe, it, expect } from 'vitest';
import { nextTick, ref } from 'vue';
import {
	initialExpandedIds,
	usePostboxReaderExpansion,
	type ReaderExpansionMessage,
} from '../usePostboxReaderExpansion';

function msg(id: string, flagSeen = true): ReaderExpansionMessage {
	return { _id: id, flagSeen };
}

/** The reader's inputs as refs a test can drive like live query updates. */
function setup(opts: {
	threadKey?: string;
	activeId: string;
	messages?: ReaderExpansionMessage[];
}) {
	const threadKey = ref(opts.threadKey ?? 't1');
	const activeId = ref(opts.activeId);
	const messages = ref<ReaderExpansionMessage[] | undefined>(opts.messages);
	const expansion = usePostboxReaderExpansion({
		threadKey: () => threadKey.value,
		activeId: () => activeId.value,
		messages: () => messages.value,
	});
	const ids = () => [...expansion.expanded.value].sort();
	return { threadKey, activeId, messages, ids, ...expansion };
}

describe('initialExpandedIds', () => {
	it('expands the latest, the first of a longer thread, every unread and the active message', () => {
		const set = initialExpandedIds([msg('a'), msg('b'), msg('c', false), msg('d'), msg('e')], 'b');
		expect([...set].sort()).toEqual(['a', 'b', 'c', 'e']);
	});

	it('leaves the first message collapsed when asked to (Answer mode: newest and unread only)', () => {
		const set = initialExpandedIds(
			[msg('a'), msg('b'), msg('c', false), msg('d'), msg('e')],
			'e',
			true,
			false
		);
		expect([...set].sort()).toEqual(['c', 'e']);
	});

	it('leaves the first message collapsed in a two-message thread', () => {
		expect([...initialExpandedIds([msg('a'), msg('b')], 'b')]).toEqual(['b']);
	});

	it("leaves the oldest loaded message collapsed when it is not the thread's first (plan 3.3)", () => {
		const set = initialExpandedIds([msg('k'), msg('l'), msg('m')], 'm', false);
		expect([...set]).toEqual(['m']);
	});

	it('expands only the newest unread messages of a long unread thread', () => {
		const thread = Array.from({ length: 12 }, (_, i) => msg(`m${i}`, false));
		// The first, the last three unread (the latest among them) and the active one.
		expect([...initialExpandedIds(thread, 'm4')].sort()).toEqual(['m0', 'm10', 'm11', 'm4', 'm9']);
	});

	it('counts the cap in unread messages, skipping read ones between them', () => {
		const thread = [
			msg('a', false),
			msg('b', false),
			msg('c', false),
			msg('d'),
			msg('e', false),
			msg('f'),
			msg('g', false),
			msg('h'),
		];
		expect([...initialExpandedIds(thread, 'h')].sort()).toEqual(['a', 'c', 'e', 'g', 'h']);
	});
});

describe('usePostboxReaderExpansion', () => {
	it('keeps unread messages expanded after the mark-read round trip', async () => {
		const s = setup({
			activeId: 'd',
			messages: [msg('a'), msg('b', false), msg('c', false), msg('d', false)],
		});
		expect(s.ids()).toEqual(['a', 'b', 'c', 'd']);

		// Opening the thread marks it read; the query comes back with flagSeen set.
		s.messages.value = [msg('a'), msg('b'), msg('c'), msg('d')];
		await nextTick();
		expect(s.ids()).toEqual(['a', 'b', 'c', 'd']);
	});

	it('keeps manual expand and collapse across live updates', async () => {
		const s = setup({ activeId: 'c', messages: [msg('a'), msg('b'), msg('c')] });
		expect(s.ids()).toEqual(['a', 'c']);

		s.toggleExpanded('b');
		s.toggleExpanded('a');
		expect(s.ids()).toEqual(['b', 'c']);

		// Same messages, fresh objects: any live update (a label, a flag).
		s.messages.value = [msg('a'), msg('b'), msg('c')];
		await nextTick();
		expect(s.ids()).toEqual(['b', 'c']);
	});

	it('adds a newly arrived message and removes nothing', async () => {
		const s = setup({ activeId: 'c', messages: [msg('a'), msg('b'), msg('c')] });
		s.toggleExpanded('c');
		expect(s.ids()).toEqual(['a']);

		s.messages.value = [msg('a'), msg('b'), msg('c'), msg('d', false)];
		await nextTick();
		expect(s.ids()).toEqual(['a', 'd']);
	});

	it('builds the default set from the first loaded list, not the loading placeholder', async () => {
		const s = setup({ activeId: 'c', messages: undefined });
		expect(s.ids()).toEqual(['c']);

		s.messages.value = [msg('a'), msg('b'), msg('c'), msg('d')];
		await nextTick();
		// b was already there when the thread loaded: it is not a new arrival.
		expect(s.ids()).toEqual(['a', 'c', 'd']);
	});

	it('starts a fresh default set when the thread changes', async () => {
		const s = setup({ activeId: 'c', messages: [msg('a'), msg('b'), msg('c')] });
		s.toggleExpanded('b');
		expect(s.ids()).toEqual(['a', 'b', 'c']);

		s.threadKey.value = 't2';
		s.activeId.value = 'y';
		s.messages.value = undefined;
		await nextTick();
		expect(s.ids()).toEqual(['y']);

		s.messages.value = [msg('x'), msg('y')];
		await nextTick();
		expect(s.ids()).toEqual(['y']);
	});

	it('expands a newly active message of the same thread without resetting the rest', async () => {
		const s = setup({ activeId: 'd', messages: [msg('a'), msg('b'), msg('c'), msg('d')] });
		s.toggleExpanded('a');
		expect(s.ids()).toEqual(['d']);

		// Search preview: another hit from the same thread, re-queried.
		s.activeId.value = 'b';
		s.messages.value = undefined;
		await nextTick();
		s.messages.value = [msg('a'), msg('b'), msg('c'), msg('d')];
		await nextTick();
		expect(s.ids()).toEqual(['b', 'd']);
	});
});
