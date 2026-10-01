import { describe, it, expect } from 'vitest';
import { nextTick, ref } from 'vue';
import { flushPromises } from '@vue/test-utils';
import { useStepOrderSync } from '../useStepOrderSync';

type Step = { _id: string; label?: string };
const steps = (...ids: string[]) => ids.map((_id) => ({ _id }));
const idsOf = (list: Step[]) => list.map((step) => step._id);

function setup() {
	const server = ref<Step[]>(steps('a', 'b', 'c'));
	const pending: ((ok: boolean) => void)[] = [];
	const saved: string[][] = [];
	const previewing = ref(false);
	const sync = useStepOrderSync<Step>({
		server,
		save: (ids) => {
			saved.push(ids);
			return new Promise((resolve) => pending.push(resolve));
		},
		whenReady: (proceed) => proceed(),
		isPreviewing: () => previewing.value,
	});
	return { server, pending, saved, previewing, sync };
}

describe('useStepOrderSync', () => {
	it('while a save is pending, a snapshot refreshes step data in the order on screen', async () => {
		const { server, sync } = setup();
		sync.items.value = steps('b', 'a', 'c');
		void sync.persist();

		server.value = [{ _id: 'a', label: 'renamed' }, ...steps('b', 'c')];
		await nextTick();
		expect(idsOf(sync.items.value)).toEqual(['b', 'a', 'c']);
		expect(sync.items.value[1]!.label).toBe('renamed');
	});

	it('while a save is pending, steps the server lost drop out and new ones appear', async () => {
		const { server, sync } = setup();
		sync.items.value = steps('c', 'a', 'b');
		void sync.persist();

		server.value = steps('a', 'd', 'c');
		await nextTick();
		expect(idsOf(sync.items.value)).toEqual(['c', 'd', 'a']);
	});

	it('does not save an order the server already has', async () => {
		const { saved, sync } = setup();
		let announced = false;
		await sync.persist(() => {
			announced = true;
		});
		expect(saved).toHaveLength(0);
		expect(announced).toBe(true);
	});

	it('takes the server order verbatim once nothing is pending', async () => {
		const { server, pending, sync } = setup();
		sync.items.value = steps('b', 'a', 'c');
		const done = sync.persist();
		pending[0]!(true);
		await done;
		await flushPromises();
		expect(sync.isSaving.value).toBe(false);

		server.value = steps('c', 'b', 'a');
		await nextTick();
		expect(idsOf(sync.items.value)).toEqual(['c', 'b', 'a']);
	});

	it('saves the order committed last, not a preview shown after it', async () => {
		const { pending, saved, previewing, sync } = setup();
		sync.items.value = steps('b', 'a', 'c');
		void sync.persist();
		sync.items.value = steps('b', 'c', 'a');
		void sync.persist();
		// A preview on top of the second commit.
		previewing.value = true;
		sync.items.value = steps('c', 'b', 'a');

		pending[0]!(true);
		await flushPromises();
		expect(saved).toEqual([
			['b', 'a', 'c'],
			['b', 'c', 'a'],
		]);
		sync.showCommitted();
		expect(idsOf(sync.items.value)).toEqual(['b', 'c', 'a']);
	});
});
