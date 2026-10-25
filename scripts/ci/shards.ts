import { boolean, decodeJson, type Decoder, integer, object, string } from '../json';
export interface ShardIdentity {
	sha: string;
	run: string;
	attempt: string;
	workspace: string;
	shard: number;
	total: number;
	report: string;
	passed: boolean;
}
const decodeShardIdentity: Decoder<ShardIdentity> = object({
	sha: string,
	run: string,
	attempt: string,
	workspace: string,
	shard: integer,
	total: integer,
	report: string,
	passed: boolean,
});
/** A shard's `.ci-shards/<n>.json` identity file. */
export function parseShardIdentity(text: string, label: string): ShardIdentity {
	return decodeJson(text, decodeShardIdentity, label);
}
export function assertShards(
	identities: ShardIdentity[],
	expected: Omit<ShardIdentity, 'shard' | 'report'>,
	reports: string[]
) {
	if (identities.length !== expected.total || reports.length !== expected.total)
		throw new Error('Missing or extra shard reports');
	const seen = new Set<number>();
	for (const identity of identities) {
		for (const key of ['sha', 'run', 'workspace', 'total', 'passed'] as const)
			if (identity[key] !== expected[key]) throw new Error(`Shard ${key} mismatch`);
		if (
			!Number.isInteger(identity.shard) ||
			identity.shard < 1 ||
			identity.shard > expected.total ||
			seen.has(identity.shard)
		)
			throw new Error('Duplicate or invalid shard');
		if (
			!/^\d+$/.test(identity.attempt) ||
			Number(identity.attempt) < 1 ||
			Number(identity.attempt) > Number(expected.attempt)
		)
			throw new Error('Shard attempt mismatch');
		seen.add(identity.shard);
		if (identity.report !== `blob-${identity.shard}.json` || !reports.includes(identity.report))
			throw new Error('Shard report identity mismatch');
	}
}
