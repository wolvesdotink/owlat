import { expect, it } from 'vitest';
import { assertShards, parseShardIdentity, type ShardIdentity } from '../ci/shards';
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
it('reads a shard identity file only in the shape run-shard writes', () => {
	const identity = identities[1]!;
	expect(parseShardIdentity(JSON.stringify(identity), '2.json')).toEqual(identity);
	for (const [patch, message] of [
		[{ shard: '2' }, '2.json.shard must be an integer'],
		[{ passed: 'true' }, '2.json.passed must be a boolean'],
		[{ attempt: 2 }, '2.json.attempt must be a string'],
		[{ sha: undefined }, '2.json.sha must be a string'],
	] as const)
		expect(() => parseShardIdentity(JSON.stringify({ ...identity, ...patch }), '2.json')).toThrow(
			message
		);
	expect(() => parseShardIdentity('[]', '2.json')).toThrow('2.json must be an object');
});
