/**
 * Key discovery: the DNS directory's cache and failure semantics, the static
 * directory, and the §4.2 bootstrap allowlist.
 *
 * The cache assertions are security assertions, not performance ones. An
 * observer name in a submission is attacker-chosen, so what is being pinned
 * down here is that one flood cannot become one lookup per submission against
 * a third party's nameservers, that it cannot grow the cache without bound,
 * and — the one that decides whether honest evidence is lost — that a resolver
 * outage is never cached as "this observer publishes no key".
 */
import { describe, expect, it } from 'vitest';
import { formatOstrKeyRecord, generateEd25519KeyPair } from '@owlat/ostr-core';
import {
	AllowlistKeyDirectory,
	DnsKeyDirectory,
	KeyLookupOverloadError,
	parseBootstrapObservers,
	StaticKeyDirectory,
	type ResolveTxt,
} from '../keys/index.js';

const alice = generateEd25519KeyPair();
const bob = generateEd25519KeyPair();

/** A resolver over a fixed zone, counting the queries it was actually asked. */
function fakeResolver(zone: Record<string, string[][]>): ResolveTxt & { calls: string[] } {
	const calls: string[] = [];
	const resolve = async (name: string): Promise<string[][]> => {
		calls.push(name);
		const answer = zone[name];
		if (answer === undefined) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
		return answer;
	};
	return Object.assign(resolve, { calls });
}

function fails(code: string): ResolveTxt & { calls: string[] } {
	const calls: string[] = [];
	return Object.assign(
		async (name: string): Promise<string[][]> => {
			calls.push(name);
			throw Object.assign(new Error(code), { code });
		},
		{ calls }
	);
}

describe('StaticKeyDirectory', () => {
	it('takes a bare public key or a whole TXT record and answers records', async () => {
		const directory = new StaticKeyDirectory({
			'a.example': [alice.publicKey],
			'b.example': [formatOstrKeyRecord(bob.publicKey)],
		});

		expect(await directory.verifyingKeys('a.example')).toEqual([
			formatOstrKeyRecord(alice.publicKey),
		]);
		expect(await directory.verifyingKeys('b.example')).toEqual([
			formatOstrKeyRecord(bob.publicKey),
		]);
	});

	it('normalizes the domain it is asked about, and knows nothing about anyone else', async () => {
		const directory = new StaticKeyDirectory({ 'A.Example.': [alice.publicKey] });

		expect(await directory.verifyingKeys('a.example')).toHaveLength(1);
		expect(await directory.verifyingKeys('A.EXAMPLE')).toHaveLength(1);
		expect(await directory.verifyingKeys('other.example')).toEqual([]);
		expect(await directory.verifyingKeys('not a domain')).toEqual([]);
	});

	it('refuses a key it could not publish rather than dropping it', () => {
		expect(() => new StaticKeyDirectory({ 'a.example': ['not-a-key'] })).toThrow(/a.example/);
		expect(() => new StaticKeyDirectory({ 'not a domain': [alice.publicKey] })).toThrow(
			/domain name/
		);
	});
});

describe('DnsKeyDirectory', () => {
	const zone = {
		'_ostr.a.example': [[formatOstrKeyRecord(alice.publicKey)]],
	};

	it('resolves _ostr.<domain> and keeps only records that parse', async () => {
		const resolve = fakeResolver({
			'_ostr.a.example': [
				['v=spf1 -all'],
				['v=1; k=rsa; p=' + alice.publicKey],
				[formatOstrKeyRecord(alice.publicKey)],
				[formatOstrKeyRecord(bob.publicKey)],
			],
		});
		const directory = new DnsKeyDirectory({ resolveTxt: resolve });

		expect(await directory.verifyingKeys('a.example')).toEqual([
			formatOstrKeyRecord(alice.publicKey),
			formatOstrKeyRecord(bob.publicKey),
		]);
		expect(resolve.calls).toEqual(['_ostr.a.example']);
	});

	it('joins the character-strings of one record, as a resolver splits them', async () => {
		const record = formatOstrKeyRecord(alice.publicKey);
		const resolve = fakeResolver({
			'_ostr.a.example': [[record.slice(0, 12), record.slice(12)]],
		});
		const directory = new DnsKeyDirectory({ resolveTxt: resolve });

		expect(await directory.verifyingKeys('a.example')).toEqual([record]);
	});

	it('answers from cache until the TTL runs out', async () => {
		const resolve = fakeResolver(zone);
		let clock = 1000;
		const directory = new DnsKeyDirectory({
			resolveTxt: resolve,
			now: () => clock,
			ttlMs: 5000,
		});

		await directory.verifyingKeys('a.example');
		await directory.verifyingKeys('a.example');
		clock += 4999;
		await directory.verifyingKeys('a.example');
		expect(resolve.calls).toHaveLength(1);

		clock += 2;
		await directory.verifyingKeys('a.example');
		expect(resolve.calls).toHaveLength(2);
	});

	it('caches "nothing published" briefly, so a new publication is picked up', async () => {
		const resolve = fakeResolver(zone);
		let clock = 0;
		const directory = new DnsKeyDirectory({
			resolveTxt: resolve,
			now: () => clock,
			ttlMs: 300_000,
			negativeTtlMs: 1000,
		});

		expect(await directory.verifyingKeys('nobody.example')).toEqual([]);
		clock += 500;
		expect(await directory.verifyingKeys('nobody.example')).toEqual([]);
		expect(resolve.calls).toHaveLength(1);

		clock += 501;
		expect(await directory.verifyingKeys('nobody.example')).toEqual([]);
		expect(resolve.calls).toHaveLength(2);
	});

	it('propagates a resolver outage instead of caching it as a missing key', async () => {
		const resolve = fails('ESERVFAIL');
		const directory = new DnsKeyDirectory({ resolveTxt: resolve });

		await expect(directory.verifyingKeys('a.example')).rejects.toThrow('ESERVFAIL');
		await expect(directory.verifyingKeys('a.example')).rejects.toThrow('ESERVFAIL');
		expect(resolve.calls).toHaveLength(2);
	});

	it('collapses concurrent lookups of one name into a single query', async () => {
		const resolve = fakeResolver(zone);
		const directory = new DnsKeyDirectory({ resolveTxt: resolve });

		const answers = await Promise.all([
			directory.verifyingKeys('a.example'),
			directory.verifyingKeys('a.example'),
			directory.verifyingKeys('a.example'),
		]);

		expect(answers[0]).toHaveLength(1);
		expect(answers[1]).toEqual(answers[0]);
		expect(resolve.calls).toHaveLength(1);
	});

	it('bounds the cache, so a flood of one-shot observer names cannot grow it', async () => {
		const resolve = fakeResolver(zone);
		const directory = new DnsKeyDirectory({ resolveTxt: resolve, maxEntries: 2 });

		await directory.verifyingKeys('a.example');
		await directory.verifyingKeys('flood-1.example');
		await directory.verifyingKeys('flood-2.example');
		// `a.example` was the oldest entry and has been evicted; asking again
		// costs one query, which is the whole price of the bound.
		await directory.verifyingKeys('a.example');

		expect(resolve.calls).toEqual([
			'_ostr.a.example',
			'_ostr.flood-1.example',
			'_ostr.flood-2.example',
			'_ostr.a.example',
		]);
	});

	it('bounds concurrent lookups, so N unseen names cannot become N queries', async () => {
		// The cache bounds REPETITION of one name. Nothing in it bounds
		// `<random>.victim.example` × N, which is a fresh miss every time and
		// costs an attacker one throwaway keypair per submission — so the cap on
		// simultaneous queries is what stops this node being a DNS amplifier.
		const release: Array<() => void> = [];
		const calls: string[] = [];
		const resolve: ResolveTxt = async (name) => {
			calls.push(name);
			await new Promise<void>((done) => release.push(done));
			return [];
		};
		const directory = new DnsKeyDirectory({ resolveTxt: resolve, maxConcurrentLookups: 2 });

		const first = directory.verifyingKeys('flood-1.example');
		const second = directory.verifyingKeys('flood-2.example');
		await expect(directory.verifyingKeys('flood-3.example')).rejects.toThrow(
			KeyLookupOverloadError
		);
		expect(calls).toEqual(['_ostr.flood-1.example', '_ostr.flood-2.example']);

		// Joining a query already in flight is never refused: it costs nothing.
		const joined = directory.verifyingKeys('flood-1.example');
		for (const done of release) done();
		expect(await Promise.all([first, second, joined])).toEqual([[], [], []]);
		expect(calls).toHaveLength(2);

		// And the cap is a queue depth, not a quota: once they drain, the next
		// unseen name is resolved normally.
		const after = directory.verifyingKeys('flood-3.example');
		release.pop()?.();
		expect(await after).toEqual([]);
		expect(calls).toEqual([
			'_ostr.flood-1.example',
			'_ostr.flood-2.example',
			'_ostr.flood-3.example',
		]);
	});

	it('keeps the record the domain published, not a re-rendering of its key', async () => {
		// Re-rendering from the parsed public key would discard every other tag
		// in the record, so the first `v=1` tag that carries meaning — a validity
		// window, a strictness flag — would be dropped and this node would verify
		// against a more permissive record than DNS states.
		const published = `v=1; k=ed25519; p=${alice.publicKey}; t=s`;
		const resolve = fakeResolver({
			'_ostr.a.example': [[published], [formatOstrKeyRecord(alice.publicKey)]],
		});
		const directory = new DnsKeyDirectory({ resolveTxt: resolve });

		// One key, one entry: two spellings still collapse, keeping the first.
		expect(await directory.verifyingKeys('a.example')).toEqual([published]);
	});

	it('never turns a malformed observer name into a query', async () => {
		const resolve = fakeResolver(zone);
		const directory = new DnsKeyDirectory({ resolveTxt: resolve });

		expect(await directory.verifyingKeys('not a domain')).toEqual([]);
		expect(await directory.verifyingKeys('')).toEqual([]);
		expect(resolve.calls).toEqual([]);
	});
});

describe('parseBootstrapObservers', () => {
	it('reads bare domains and pinned domain=key pairs, in any separator', () => {
		const parsed = parseBootstrapObservers(` a.example, b.example=${alice.publicKey}\n c.example `);

		expect(parsed).toEqual([
			{ domain: 'a.example', records: [] },
			{ domain: 'b.example', records: [formatOstrKeyRecord(alice.publicKey)] },
			{ domain: 'c.example', records: [] },
		]);
	});

	it('merges repeats of one domain, which is how a seed observer rotates', () => {
		const parsed = parseBootstrapObservers(
			`a.example=${alice.publicKey},a.example=${bob.publicKey},a.example=${alice.publicKey}`
		);

		expect(parsed).toEqual([
			{
				domain: 'a.example',
				records: [formatOstrKeyRecord(alice.publicKey), formatOstrKeyRecord(bob.publicKey)],
			},
		]);
	});

	it('refuses an entry it cannot use rather than silently un-listing an observer', () => {
		expect(() => parseBootstrapObservers('a.example,,not a domain')).toThrow(/domain name/);
		expect(() => parseBootstrapObservers('a.example=zzz')).toThrow(/a.example/);
		expect(() => parseBootstrapObservers('   ')).toThrow(/names no observer/);
	});
});

describe('AllowlistKeyDirectory', () => {
	const fallback = new StaticKeyDirectory({
		'listed.example': [alice.publicKey],
		'stranger.example': [bob.publicKey],
	});

	it('answers for listed observers only, however well an outsider publishes', async () => {
		const directory = new AllowlistKeyDirectory(
			[{ domain: 'listed.example', records: [] }],
			fallback
		);

		expect(await directory.verifyingKeys('listed.example')).toEqual([
			formatOstrKeyRecord(alice.publicKey),
		]);
		expect(await directory.verifyingKeys('stranger.example')).toEqual([]);
		expect(directory.observers()).toEqual(['listed.example']);
	});

	it('pins a key inline without ever consulting DNS for that observer', async () => {
		const resolve = fails('ESERVFAIL');
		const directory = new AllowlistKeyDirectory(
			[{ domain: 'listed.example', records: [formatOstrKeyRecord(bob.publicKey)] }],
			new DnsKeyDirectory({ resolveTxt: resolve })
		);

		expect(await directory.verifyingKeys('listed.example')).toEqual([
			formatOstrKeyRecord(bob.publicKey),
		]);
		expect(resolve.calls).toEqual([]);
	});

	it('refuses an empty allowlist, which would accept nobody while looking healthy', () => {
		expect(() => new AllowlistKeyDirectory([], fallback)).toThrow(/at least one observer/);
	});
});
