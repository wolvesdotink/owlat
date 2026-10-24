/**
 * Bulk topic edits on the contacts list: the toast counts what the server
 * actually changed (its receipt), and offers an Undo on the app's undo stack
 * that hands exactly that receipt back, in batches. A partial failure still
 * offers the undo of the batches that landed; a no-op offers none.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import { createTestI18n } from '~/__tests__/i18n';
import { BATCH_SIZES } from '~/constants/operations';

interface StubToast {
	id: string;
	message: string;
	type: string;
	action?: { label: string; onAction: () => void };
	shortcutHint?: string;
}

const toasts: StubToast[] = [];
let toastSeq = 0;
const showToast = vi.fn(
	(message: string, type = 'success', options?: { action?: StubToast['action'] }): string => {
		const id = `toast-${++toastSeq}`;
		toasts.push({ id, message, type, ...(options?.action ? { action: options.action } : {}) });
		return id;
	}
);
const removeToast = (id: string) => {
	const index = toasts.findIndex((t) => t.id === id);
	if (index > -1) toasts.splice(index, 1);
};
const setToastShortcutHint = (id: string, hint: string | undefined) => {
	const toast = toasts.find((t) => t.id === id);
	if (toast) toast.shortcutHint = hint;
};
const updateToast = (id: string, patch: { message?: string; action?: StubToast['action'] }) => {
	const toast = toasts.find((t) => t.id === id);
	if (!toast) return;
	if (patch.message !== undefined) toast.message = patch.message;
	if (patch.action) toast.action = patch.action;
};
vi.stubGlobal('useToast', () => ({ showToast, removeToast, setToastShortcutHint, updateToast }));

let stateBuckets = new Map<string, ReturnType<typeof ref>>();
vi.stubGlobal('useState', (key: string, init: () => unknown) => {
	if (!stateBuckets.has(key)) stateBuckets.set(key, ref(init()));
	return stateBuckets.get(key);
});

const i18n = createTestI18n();
vi.stubGlobal('useI18n', () => i18n.global);
vi.stubGlobal('useConvex', () => ({}));

/** Every backend call, by the operation's label, with a scripted answer. */
const calls: Array<{ label: string; args: Record<string, unknown> }> = [];
let answer: (label: string, args: Record<string, unknown>) => unknown;
vi.stubGlobal(
	'useBackendOperation',
	(_reference: unknown, options: { label: string | (() => string) }) => ({
		run: async (args: Record<string, unknown>) => {
			const label = typeof options.label === 'function' ? options.label() : options.label;
			calls.push({ label, args });
			return answer(label, args);
		},
	})
);

const { useBulkOperation } = await import('../useBulkOperation');
vi.stubGlobal('useBulkOperation', useBulkOperation);
const { useContactBulkOperations } = await import('../useContactBulkOperations');
const { usePostboxTriageUndo } = await import('../postbox/usePostboxTriageUndo');

const TOPIC = 'topic_1' as Id<'topics'>;
const ids = (n: number) => Array.from({ length: n }, (_, i) => `c${i}` as Id<'contacts'>);

function setup(selected: Id<'contacts'>[]) {
	const clearSelection = vi.fn();
	const bulkSelection = {
		selectedIds: ref(new Set(selected)),
		getSelectedArray: () => [...selected],
		clearSelection,
	};
	const ops = useContactBulkOperations({
		bulkSelection: bulkSelection as never,
		topics: ref([{ _id: TOPIC, name: 'Newsletter' }]),
		contactProperties: ref([]),
		debouncedSearch: ref(''),
	});
	return { ops, clearSelection };
}

const labelled = (label: string) => calls.filter((c) => c.label === label);

beforeEach(() => {
	vi.useFakeTimers();
	stateBuckets = new Map();
	toasts.length = 0;
	calls.length = 0;
	showToast.mockClear();
	usePostboxTriageUndo().dismiss();
});

afterEach(() => {
	usePostboxTriageUndo().dismiss();
	vi.useRealTimers();
});

describe('bulk add to a topic', () => {
	it('counts the contacts actually added and undoes exactly those, in batches', async () => {
		const selected = ids(BATCH_SIZES.CONTACTS_ADD_TO_LIST + 10);
		// The server receipts every contact but the first of each batch, which
		// stands for one that was already a member.
		answer = (_label, args) => ({
			ok: true,
			result: {
				added: (args.contactIds as string[]).slice(1).map((id) => ({ membershipId: `m-${id}` })),
			},
		});
		const { ops, clearSelection } = setup(selected);

		await ops.handleBulkAddToList(TOPIC);

		const expected = selected.length - 2;
		expect(toasts.map((t) => [t.message, t.action?.label])).toEqual([
			[`Added ${expected} contacts to "Newsletter"`, 'Undo'],
		]);
		expect(clearSelection).toHaveBeenCalledTimes(1);

		answer = () => ({ ok: true, result: { reverted: 0 } });
		toasts[0]!.action!.onAction();
		await vi.advanceTimersByTimeAsync(0);

		const undone = labelled('Undo adding contacts to topic');
		expect(undone.map((c) => (c.args.added as unknown[]).length)).toEqual([
			BATCH_SIZES.CONTACTS_ADD_TO_LIST,
			expected - BATCH_SIZES.CONTACTS_ADD_TO_LIST,
		]);
		expect(undone.flatMap((c) => c.args.added as Array<{ membershipId: string }>)).toEqual(
			selected
				.filter((_, i) => i !== 0 && i !== BATCH_SIZES.CONTACTS_ADD_TO_LIST)
				.map((id) => ({ membershipId: `m-${id}` }))
		);
		expect(undone.every((c) => c.args.topicId === TOPIC)).toBe(true);
		expect(toasts).toHaveLength(0);
	});

	it('offers no undo when every contact was already a member', async () => {
		answer = () => ({ ok: true, result: { added: [] } });
		const { ops } = setup(ids(3));

		await ops.handleBulkAddToList(TOPIC);

		expect(toasts.map((t) => [t.message, t.type, t.action])).toEqual([
			['All selected contacts are already in "Newsletter"', 'info', undefined],
		]);
		expect(usePostboxTriageUndo().canUndo.value).toBe(false);
	});

	it('coalesces consecutive adds to the same topic into one notice', async () => {
		answer = (_label, args) => ({
			ok: true,
			result: { added: (args.contactIds as string[]).map((id) => ({ membershipId: `m-${id}` })) },
		});
		await setup(ids(2)).ops.handleBulkAddToList(TOPIC);
		await setup(ids(3)).ops.handleBulkAddToList(TOPIC);

		expect(toasts.map((t) => [t.message, t.action?.label])).toEqual([
			['Added 5 contacts to "Newsletter"', 'Undo all'],
		]);
	});
});

describe('bulk remove from a topic', () => {
	it('keeps the undo of the batches that landed before a failure', async () => {
		const selected = ids(BATCH_SIZES.CONTACTS_REMOVE_FROM_LIST + 5);
		let batch = 0;
		answer = (label, args) => {
			if (label !== 'Remove contacts from topic') return { ok: true, result: { restored: 0 } };
			batch += 1;
			if (batch > 1) return { ok: false };
			return {
				ok: true,
				result: {
					removed: (args.contactIds as string[])
						.slice(0, 4)
						.map((contactId) => ({ contactId, addedAt: 1 })),
				},
			};
		};
		const { ops, clearSelection } = setup(selected);

		await ops.handleBulkRemoveFromList(TOPIC);

		expect(toasts.map((t) => t.message)).toEqual(['Removed 4 contacts from "Newsletter"']);
		// The failed run keeps the selection, so the rest can be retried.
		expect(clearSelection).not.toHaveBeenCalled();

		await usePostboxTriageUndo().undo();
		const restored = labelled('Undo removing contacts from topic');
		expect(restored).toHaveLength(1);
		expect(restored[0]!.args).toEqual({
			topicId: TOPIC,
			removed: selected.slice(0, 4).map((contactId) => ({ contactId, addedAt: 1 })),
		});
	});

	it('stops the undo at the first batch that fails', async () => {
		const selected = ids(BATCH_SIZES.CONTACTS_REMOVE_FROM_LIST * 3);
		answer = (label, args) =>
			label === 'Remove contacts from topic'
				? {
						ok: true,
						result: {
							removed: (args.contactIds as string[]).map((contactId) => ({
								contactId,
								addedAt: 1,
							})),
						},
					}
				: { ok: false };
		await setup(selected).ops.handleBulkRemoveFromList(TOPIC);

		await usePostboxTriageUndo().undo();
		expect(labelled('Undo removing contacts from topic')).toHaveLength(1);
	});

	it('offers no undo when none of the contacts were members', async () => {
		answer = () => ({ ok: true, result: { removed: [] } });
		await setup(ids(2)).ops.handleBulkRemoveFromList(TOPIC);

		expect(toasts.map((t) => [t.message, t.type])).toEqual([
			['None of the selected contacts are in "Newsletter"', 'info'],
		]);
		expect(usePostboxTriageUndo().canUndo.value).toBe(false);
	});
});
