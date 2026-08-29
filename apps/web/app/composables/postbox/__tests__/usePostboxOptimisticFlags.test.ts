/**
 * Optimistic star / mark-read painting: the override shows up in the rendered
 * rows immediately, survives until the live subscription agrees with it, and is
 * dropped explicitly when the mutation failed.
 */
import { describe, it, expect } from 'vitest';
import { ref, nextTick } from 'vue';
import { usePostboxOptimisticFlags } from '../usePostboxOptimisticFlags';

const row = (id: string, flags?: { flagSeen?: boolean; flagFlagged?: boolean }) => ({
	_id: id,
	flagSeen: flags?.flagSeen ?? false,
	flagFlagged: flags?.flagFlagged ?? false,
});

describe('usePostboxOptimisticFlags', () => {
	it('paints a flag change immediately, leaving the other rows untouched', () => {
		const items = ref([row('a'), row('b')]);
		const { rows, setFlags } = usePostboxOptimisticFlags(items);
		expect(rows.value.map((m) => m.flagFlagged)).toEqual([false, false]);

		setFlags('a', { flagFlagged: true });
		expect(rows.value.map((m) => m.flagFlagged)).toEqual([true, false]);
		// The source rows themselves are never mutated — the override is a view.
		expect(items.value[0]!.flagFlagged).toBe(false);
	});

	it('merges a second field into an existing claim', () => {
		const items = ref([row('a')]);
		const { rows, setFlags } = usePostboxOptimisticFlags(items);
		setFlags('a', { flagFlagged: true });
		setFlags('a', { flagSeen: true });
		expect(rows.value[0]).toMatchObject({ flagFlagged: true, flagSeen: true });
	});

	it('snaps back to the server value when the mutation failed', () => {
		const items = ref([row('a')]);
		const { rows, setFlags, clearFlags } = usePostboxOptimisticFlags(items);
		setFlags('a', { flagFlagged: true });
		clearFlags('a');
		expect(rows.value[0]!.flagFlagged).toBe(false);
	});

	it('prunes the claim once the live row confirms it', async () => {
		const items = ref([row('a')]);
		const { rows, setFlags } = usePostboxOptimisticFlags(items);
		setFlags('a', { flagSeen: true });

		// Subscription delivers the mutated row.
		items.value = [row('a', { flagSeen: true })];
		await nextTick();
		expect(rows.value[0]!.flagSeen).toBe(true);

		// The claim is gone: a later server-side change (another client marking it
		// unread again) is no longer masked by a stale override.
		items.value = [row('a', { flagSeen: false })];
		await nextTick();
		expect(rows.value[0]!.flagSeen).toBe(false);
	});

	it('keeps a still-pending field while pruning the confirmed one', async () => {
		const items = ref([row('a')]);
		const { rows, setFlags } = usePostboxOptimisticFlags(items);
		setFlags('a', { flagSeen: true, flagFlagged: true });

		// Only the read mutation landed so far.
		items.value = [row('a', { flagSeen: true, flagFlagged: false })];
		await nextTick();
		expect(rows.value[0]).toMatchObject({ flagSeen: true, flagFlagged: true });

		items.value = [row('a', { flagSeen: true, flagFlagged: true })];
		await nextTick();
		items.value = [row('a', { flagSeen: true, flagFlagged: false })];
		await nextTick();
		expect(rows.value[0]!.flagFlagged).toBe(false);
	});

	it('keeps a re-toggle that the confirmation of the first toggle would undo', async () => {
		const items = ref([row('a')]);
		const { rows, setFlags } = usePostboxOptimisticFlags(items);
		setFlags('a', { flagFlagged: true });
		setFlags('a', { flagFlagged: false }); // user toggled again, first still in flight

		items.value = [row('a', { flagFlagged: true })]; // first mutation lands
		await nextTick();
		expect(rows.value[0]!.flagFlagged).toBe(false);
	});

	it('drops the claim of a row that left the list', async () => {
		const items = ref([row('a'), row('b')]);
		const { rows, setFlags } = usePostboxOptimisticFlags(items);
		setFlags('a', { flagFlagged: true });

		items.value = [row('b')];
		await nextTick();
		// 'a' comes back (undo, or a folder move) with the server's own flags.
		items.value = [row('a'), row('b')];
		await nextTick();
		expect(rows.value[0]!.flagFlagged).toBe(false);
	});
});
