import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref, nextTick, type Ref } from 'vue';
import { useInboxAssigneePresence } from '../useInboxAssigneePresence';

/**
 * The Team Inbox presence ring comes from its own small query, not from the
 * thread list (plan C9): only assigned rows are asked about, in a stable order,
 * and nothing subscribes when no row is assigned.
 */
describe('useInboxAssigneePresence', () => {
	let handle: { data: Ref<unknown>; args: () => unknown; options: unknown };

	beforeEach(() => {
		vi.stubGlobal('useConvexQuery', (_query: unknown, args: () => unknown, options: unknown) => {
			handle = { data: ref<unknown>(undefined), args, options };
			return handle;
		});
	});

	type Row = { _id: string; assignedTo?: string | null };

	it('asks only about assigned rows, sorted by thread id', () => {
		const threads = ref<Row[]>([
			{ _id: 'b', assignedTo: 'u2' },
			{ _id: 'c' },
			{ _id: 'a', assignedTo: 'u1' },
			{ _id: 'd', assignedTo: null },
		]);
		useInboxAssigneePresence(threads);
		expect(handle.args()).toEqual({
			rows: [
				{ threadId: 'a', assigneeId: 'u1' },
				{ threadId: 'b', assigneeId: 'u2' },
			],
		});
		expect(handle.options).toEqual({ keepPreviousData: true });
	});

	it('keeps the same args when the list only re-sorts', () => {
		const threads = ref<Row[]>([
			{ _id: 'a', assignedTo: 'u1' },
			{ _id: 'b', assignedTo: 'u2' },
		]);
		useInboxAssigneePresence(threads);
		const before = JSON.stringify(handle.args());
		threads.value = [...threads.value].reverse();
		expect(JSON.stringify(handle.args())).toBe(before);
	});

	it('skips the query when no row is assigned', () => {
		useInboxAssigneePresence(ref<Row[]>([{ _id: 'a' }]));
		expect(handle.args()).toBe('skip');
	});

	it('answers per row from the returned thread ids', async () => {
		const threads = ref<Row[]>([
			{ _id: 'a', assignedTo: 'u1' },
			{ _id: 'b', assignedTo: 'u2' },
		]);
		const isPresent = useInboxAssigneePresence(threads);
		expect(isPresent('a')).toBe(false);

		handle.data.value = ['b'];
		await nextTick();
		expect(isPresent('a')).toBe(false);
		expect(isPresent('b')).toBe(true);

		// Once no row is assigned any more, kept data must not light a ring.
		threads.value = [{ _id: 'b' }];
		await nextTick();
		expect(isPresent('b')).toBe(false);
	});
});
