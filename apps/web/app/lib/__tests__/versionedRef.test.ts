import { describe, it, expect } from 'vitest';
import { computed, isReactive, nextTick, watch } from 'vue';
import { versionedRef } from '../versionedRef';

describe('versionedRef', () => {
	it('counts every write, including one of the value it already holds', () => {
		const { ref: list, version } = versionedRef<number[]>([1]);
		const same = list.value;
		same.push(2);
		list.value = same;
		expect(version.value).toBe(1);
		list.value = [3];
		expect(version.value).toBe(2);
	});

	it('behaves like a deep ref for its readers', async () => {
		const { ref: list } = versionedRef<{ n: number }[]>([{ n: 1 }]);
		expect(isReactive(list.value)).toBe(true);
		const total = computed(() => list.value.reduce((sum, item) => sum + item.n, 0));
		expect(total.value).toBe(1);
		list.value[0]!.n = 5;
		expect(total.value).toBe(5);

		// Writing back the value it holds does not notify readers of the ref.
		let runs = 0;
		watch(list, () => runs++);
		const held = list.value;
		list.value = held;
		await nextTick();
		expect(runs).toBe(0);
		list.value = [{ n: 2 }];
		await nextTick();
		expect(runs).toBe(1);
	});
});
