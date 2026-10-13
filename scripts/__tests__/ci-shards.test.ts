import { expect, it } from 'vitest';
import { assertShards, type ShardIdentity } from '../ci/shards';
const expected = { sha: 'abc', run: '123', attempt: '2', workspace: 'web', total: 2, passed: true };
const identities: ShardIdentity[] = [
	{ ...expected, attempt: '1', shard: 1, report: 'blob-1.json' },
	{ ...expected, shard: 2, report: 'blob-2.json' },
];
const reports = ['blob-1.json', 'blob-2.json'];
it('accepts successful same-run shards retained during a partial rerun', () =>
	expect(() => assertShards(identities, expected, reports)).not.toThrow());
it('fails closed on missing, duplicate, failed, mismatched or future shards', () => {
	expect(() => assertShards(identities.slice(1), expected, reports)).toThrow();
	expect(() => assertShards([identities[0]!, identities[0]!], expected, reports)).toThrow();
	for (const patch of [
		{ sha: 'other' },
		{ run: 'other' },
		{ attempt: '3' },
		{ workspace: 'api' },
		{ passed: false },
		{ report: '../other.json' },
	])
		expect(() =>
			assertShards([{ ...identities[0]!, ...patch }, identities[1]!], expected, reports)
		).toThrow();
	expect(() => assertShards(identities, expected, ['blob-1.json', 'unrelated.json'])).toThrow();
});
