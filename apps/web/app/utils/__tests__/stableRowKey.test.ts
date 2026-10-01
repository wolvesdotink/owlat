import { describe, it, expect } from 'vitest';
import { reactive } from 'vue';
import { stableRowKey } from '../stableRowKey';

describe('stableRowKey', () => {
	it('gives each row its own key and keeps it through a move', () => {
		const rows = reactive([{ v: 'a' }, { v: 'b' }, { v: 'c' }]);
		const before = rows.map(stableRowKey);
		expect(new Set(before).size).toBe(3);

		const [moved] = rows.splice(0, 1);
		rows.push(moved!);
		expect(rows.map(stableRowKey)).toEqual([before[1], before[2], before[0]]);
	});

	it('is the same key through the proxy and the raw object, and adds nothing to the row', () => {
		const raw = { ip: '', hostname: '' };
		const proxied = reactive(raw);
		expect(stableRowKey(proxied)).toBe(stableRowKey(raw));
		expect(Object.keys(raw)).toEqual(['ip', 'hostname']);
	});
});
