/**
 * The update flow (scripts/e2e-update-flow.sh) seeds Convex data at the
 * previous release and checks it survived the in-app update. The run itself
 * needs Docker and two published releases, so it only happens in the Update
 * flow workflow; these cases pin the parts that decide its verdict:
 *
 *   - the two read-only queries the script sends with `convex run
 *     --inline-query`, evaluated here against an in-memory `ctx.db`;
 *   - the precondition check on the seeded snapshot;
 *   - the comparison that names each invariant that broke. Its regressions
 *     change the underlying rows between the two snapshots, the way an
 *     upgrade would, and take both snapshots with the real query.
 *
 * Every case runs the REAL functions from scripts/e2e-update-flow-data.sh
 * under bash.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const LIB = fileURLToPath(new URL('../e2e-update-flow-data.sh', import.meta.url));
const roots: string[] = [];

afterAll(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** Runs `source <lib>; <command> "$@"` under bash, with optional extra environment. */
function runLib(command: string, args: string[] = [], env: Record<string, string> = {}) {
	return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
		execFile(
			'bash',
			['-c', `source "$0"; ${command} "$@"`, LIB, ...args],
			{ env: { ...process.env, ...env } },
			(error, stdout, stderr) => {
				const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
				resolve({ code, stdout, stderr });
			}
		);
	});
}

async function writeJson(name: string, value: unknown): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'owlat-update-flow-data-'));
	roots.push(root);
	const path = join(root, name);
	await writeFile(path, JSON.stringify(value));
	return path;
}

type Doc = { _id: string } & Record<string, unknown>;
type Tables = Record<string, Doc[]>;

/** A Convex-shaped id: 32 lowercase alphanumerics. */
const id = (name: string) => name.padEnd(32, '0');

/**
 * The subset of a Convex query `ctx` the two queries use. Like the real
 * `db.get`, a string that is not an id throws and an unknown id is null.
 */
function fakeCtx(tables: Tables) {
	return {
		db: {
			query: (table: string) => ({ collect: async () => structuredClone(tables[table] ?? []) }),
			get: async (docId: string) => {
				if (!/^[0-9a-z]{32}$/.test(docId)) throw new Error(`Invalid ID: ${docId}`);
				const doc = Object.values(tables)
					.flat()
					.find((row) => row._id === docId);
				return doc ? structuredClone(doc) : null;
			},
		},
	};
}

/** Evaluates `export default query({ handler })` source the way the CLI's wrapper would. */
async function evaluateQuery(source: string, tables: Tables): Promise<unknown> {
	const module = new Function('query', source.replace('export default ', 'return '));
	const definition = module((definition: unknown) => definition) as {
		handler: (ctx: ReturnType<typeof fakeCtx>) => Promise<unknown>;
	};
	return definition.handler(fakeCtx(tables));
}

const C1 = id('contact1');
const C2 = id('contact2');
const C0 = id('contact0');
const SENT = id('campaignsent');
const DRAFT = id('campaigndraft');
const OWN = id('campaignown');
const T1 = id('templatesent');
const T2 = id('templatedraft');
const BLOCK = id('blockfooter');
const ASSET = id('assetlogo');
const TOPIC = id('topicpromo');
const S1 = id('senddelivered');
const QUEUED = id('sendqueued');
const IDS = { contact: C1, campaign: SENT, draft: DRAFT, queuedSend: QUEUED };

/** A fresh copy of the seeded tables, for a case to change. */
function tables(): Tables {
	return structuredClone({
		contacts: [
			{ _id: C2, _creationTime: 2, email: 'zoe@example.com', firstName: 'Zoe', seedTag: 'demo' },
			{
				_id: C1,
				_creationTime: 1,
				email: 'ada@example.com',
				firstName: 'Ada',
				lastName: 'Lovelace',
				seedTag: 'demo',
				customFields: { plan: { tier: 'pro', seats: 3 } },
				tags: ['vip', 'beta'],
				// Id-shaped, but no document: must be ignored, not followed.
				externalRef: 'f'.repeat(32),
			},
			{ _id: C0, _creationTime: 0, email: 'aaa@example.com', firstName: 'Own' },
		],
		campaigns: [
			{
				_id: SENT,
				_creationTime: 3,
				name: 'Summer',
				status: 'sent',
				subject: 'Hi',
				seedTag: 'demo',
				emailTemplateId: T1,
				audience: { kind: 'topic', topicId: TOPIC },
				sentAt: 9,
				statsSent: 1,
			},
			{
				_id: DRAFT,
				_creationTime: 4,
				name: 'June',
				status: 'draft',
				subject: 'New',
				seedTag: 'demo',
				emailTemplateId: T2,
				audience: { kind: 'topic', topicId: TOPIC },
				statsSent: 0,
			},
			{
				_id: OWN,
				_creationTime: 5,
				name: 'Mine',
				status: 'draft',
				subject: 'Own',
				emailTemplateId: T2,
			},
		],
		emailTemplates: [
			{ _id: T1, _creationTime: 0, name: 'Sale', html: '<p>Sale</p>' },
			{ _id: T2, _creationTime: 0, name: 'News', html: '<p>June</p>', blocks: [BLOCK] },
		],
		emailBlocks: [{ _id: BLOCK, _creationTime: 0, html: '<footer/>', assetId: ASSET }],
		assets: [{ _id: ASSET, _creationTime: 0, url: 'https://owlat.example/logo.png' }],
		topics: [{ _id: TOPIC, _creationTime: 0, slug: 'promotions' }],
		emailSends: [
			{
				_id: S1,
				_creationTime: 6,
				campaignId: SENT,
				contactId: C1,
				contactEmail: 'ada@example.com',
				status: 'delivered',
				queuedAt: 6,
			},
			{
				_id: QUEUED,
				_creationTime: 7,
				campaignId: SENT,
				contactId: C1,
				contactEmail: 'ada@example.com',
				status: 'queued',
				queuedAt: 7,
			},
		],
	});
}

/** One stored document of `data`, for a case to change in place. */
function row(data: Tables, docId: string): Doc {
	const doc = Object.values(data)
		.flat()
		.find((candidate) => candidate._id === docId);
	if (!doc) throw new Error(`no row ${docId}`);
	return doc;
}

type Snapshot = { docs: Record<string, Doc | null>; rows: Record<string, string[]> };

async function snapshotOf(data: Tables): Promise<Snapshot> {
	const { code, stdout } = await runLib('data_snapshot_query', [JSON.stringify(IDS)]);
	expect(code).toBe(0);
	return (await evaluateQuery(stdout, data)) as Snapshot;
}

describe('data_roles_query', () => {
	it('names the first sample contact by email, the sent and the draft sample campaign, and the queued Sends', async () => {
		const { code, stdout } = await runLib('data_roles_query');
		expect(code).toBe(0);
		expect(await evaluateQuery(stdout, tables())).toEqual({
			contact: { id: C1, email: 'ada@example.com' },
			campaign: SENT,
			draft: DRAFT,
			queuedSends: [QUEUED],
		});
	});

	it('reports a missing role as null instead of picking an operator row', async () => {
		const { stdout } = await runLib('data_roles_query');
		const data = tables();
		data['campaigns'] = data['campaigns']!.filter((campaign) => campaign._id === OWN);
		expect(await evaluateQuery(stdout, data)).toMatchObject({ campaign: null, draft: null });
	});
});

describe('data_snapshot_query', () => {
	it('keeps whole documents: the named rows, the Sends of the sent campaign and what they reference, two hops deep', async () => {
		const snapshot = await snapshotOf(tables());
		expect(Object.keys(snapshot.docs).sort()).toEqual([
			'campaign',
			'campaign/audience.topicId',
			'campaign/emailTemplateId',
			`campaign/send:${S1}`,
			'contact',
			'draft',
			'draft/emailTemplateId',
			'draft/emailTemplateId/blocks.0',
			'queued-send',
		]);
		expect(snapshot.docs['contact']).toEqual(row(tables(), C1));
		expect(snapshot.docs['draft/emailTemplateId/blocks.0']).toEqual(row(tables(), BLOCK));
	});

	it('stops after two hops and lists a document reached twice only once', async () => {
		const { docs } = await snapshotOf(tables());
		// The asset is a third hop (draft → template → block → asset).
		expect(Object.values(docs).some((doc) => doc?._id === ASSET)).toBe(false);
		// Both campaigns name the same topic; it is listed under the first.
		expect(Object.values(docs).filter((doc) => doc?._id === TOPIC)).toHaveLength(1);
	});

	it('lists every row id of the checked tables', async () => {
		const { rows } = await snapshotOf(tables());
		expect(rows).toEqual({
			contacts: [C0, C1, C2].sort(),
			campaigns: [SENT, DRAFT, OWN].sort(),
			emailSends: [S1, QUEUED].sort(),
			emailTemplates: [T1, T2].sort(),
		});
	});

	it('returns null for a named row that is gone', async () => {
		const data = tables();
		data['emailSends'] = data['emailSends']!.filter((send) => send._id !== QUEUED);
		expect((await snapshotOf(data)).docs['queued-send']).toBeNull();
	});

	it('refuses ids that are not Convex ids, so nothing but an id reaches the query source', async () => {
		const { code, stdout } = await runLib('data_snapshot_query', [
			JSON.stringify({ ...IDS, draft: "k2'); throw 1; ('" }),
		]);
		expect(code).not.toBe(0);
		expect(stdout).toBe('');
	});
});

describe('data_snapshot_problems', () => {
	async function problems(data: Tables) {
		return runLib('data_snapshot_problems', [
			await writeJson('before.json', await snapshotOf(data)),
		]);
	}

	it('accepts a snapshot in the state every invariant describes', async () => {
		const { code, stdout } = await problems(tables());
		expect(code).toBe(0);
		expect(stdout).toBe('');
	});

	it.each<[string, (data: Tables) => void]>([
		[
			'the named contact is missing',
			(d) => void (d['contacts'] = d['contacts']!.filter((c) => c._id !== C1)),
		],
		['the sent campaign has status sending', (d) => void (row(d, SENT)['status'] = 'sending')],
		[
			'the sent campaign has no sample Sends',
			(d) => void (d['emailSends'] = d['emailSends']!.filter((s) => s._id !== S1)),
		],
		[
			'the draft campaign has no template',
			(d) => void (d['emailTemplates'] = d['emailTemplates']!.filter((t) => t._id !== T2)),
		],
		['the queued Send was attempted', (d) => void (row(d, QUEUED)['firstAttemptAt'] = 8)],
		[
			'the queued Send does not reference the named contact and campaign',
			(d) => void (row(d, QUEUED)['contactId'] = C2),
		],
	])('reports "%s"', async (problem, mutate) => {
		const data = tables();
		mutate(data);
		const { stdout } = await problems(data);
		expect(stdout.split('\n')).toContain(problem);
	});
});

describe('data_compare_snapshots', () => {
	/**
	 * Snapshots the seeded tables, applies `change` to them the way an upgrade
	 * would, snapshots again and compares, for an update to 0.6.15. `allowlist`
	 * replaces DATA_REWRITE_ALLOWLIST after the library set its default.
	 */
	async function upgrade(change: (data: Tables) => void, allowlist?: unknown[]) {
		const data = tables();
		const before = await snapshotOf(data);
		change(data);
		const after = await snapshotOf(data);
		const files = [
			await writeJson('before.json', before),
			await writeJson('after.json', after),
			'0.6.15',
		];
		const { code, stdout } = allowlist
			? await runLib('DATA_REWRITE_ALLOWLIST="$ALLOW"; data_compare_snapshots', files, {
					ALLOW: JSON.stringify(allowlist),
				})
			: await runLib('data_compare_snapshots', files);
		return { code, lines: stdout.trim().split('\n') };
	}

	it('passes every named invariant when the rows came through unchanged', async () => {
		const { code, lines } = await upgrade(() => {});
		expect(code).toBe(0);
		expect(lines).toEqual(['ok|contact', 'ok|campaign', 'ok|draft', 'ok|queued-send', 'ok|rows']);
	});

	it('lets a migration add a field and a row', async () => {
		const { code } = await upgrade((data) => {
			row(data, C1)['engagementScore'] = 0;
			row(data, T2)['plainText'] = 'June';
			data['contacts']!.push({ _id: id('contact9'), _creationTime: 9, email: 'new@example.com' });
		});
		expect(code).toBe(0);
	});

	it("fails the draft when its template's content is cleared", async () => {
		const { code, lines } = await upgrade((data) => void (row(data, T2)['html'] = ''));
		expect(code).toBe(1);
		expect(lines).toContain('bad|draft|draft/emailTemplateId:html "<p>June</p>" → ""');
		expect(lines).toContain('ok|campaign');
	});

	it('fails the contact when it is soft-deleted, though a new field is otherwise allowed', async () => {
		const { code, lines } = await upgrade((data) => {
			row(data, C1)['deletedAt'] = 10;
			row(data, C1)['deletedBy'] = 'system';
		});
		expect(code).toBe(1);
		expect(lines).toContain(
			'bad|contact|contact:deletedAt added 10 (soft-deleted); contact:deletedBy added "system" (soft-deleted)'
		);
	});

	it('names the path of a changed nested field', async () => {
		const { code, lines } = await upgrade(
			(data) =>
				void ((row(data, C1)['customFields'] as { plan: { tier: string } }).plan.tier = 'free')
		);
		expect(code).toBe(1);
		expect(lines).toContain('bad|contact|contact:customFields.plan.tier "pro" → "free"');
	});

	it('fails a dropped field, and an array that lost an element', async () => {
		const { code, lines } = await upgrade((data) => {
			delete row(data, C1)['lastName'];
			row(data, C1)['tags'] = ['vip'];
		});
		expect(code).toBe(1);
		expect(lines).toContain(
			'bad|contact|contact:lastName removed (was "Lovelace"); contact:tags ["vip","beta"] → ["vip"]'
		);
	});

	it('fails a referenced document two hops away', async () => {
		const { code, lines } = await upgrade((data) => void (row(data, BLOCK)['html'] = ''));
		expect(code).toBe(1);
		expect(lines).toContain('bad|draft|draft/emailTemplateId/blocks.0:html "<footer/>" → ""');
	});

	it('fails the queued Send once anything attempted it', async () => {
		const { code, lines } = await upgrade((data) => {
			row(data, QUEUED)['status'] = 'failed';
			row(data, QUEUED)['firstAttemptAt'] = 8;
		});
		expect(code).toBe(1);
		expect(lines).toContain('bad|queued-send|queued-send:status "queued" → "failed"');
	});

	it('fails the campaign when one of its Sends changes', async () => {
		const { code, lines } = await upgrade((data) => void (row(data, S1)['status'] = 'bounced'));
		expect(code).toBe(1);
		expect(lines).toContain(`bad|campaign|campaign/send:${S1}:status "delivered" → "bounced"`);
	});

	it('reports a named row that is gone, and the row ids it took with it', async () => {
		const { code, lines } = await upgrade(
			(data) => void (data['contacts'] = data['contacts']!.filter((contact) => contact._id !== C1))
		);
		expect(code).toBe(1);
		expect(lines).toContain(`bad|contact|contact is gone (was ${C1})`);
		expect(lines).toContain(`bad|rows|missing contacts: ${C1}`);
	});

	it("ignores the sent campaign's stats cache, which the stats rollup recomputes on its own timer", async () => {
		const { code, lines } = await upgrade((data) => {
			Object.assign(row(data, SENT), { statsSent: 0, statsUpdatedAt: 99 });
		});
		expect(code).toBe(0);
		expect(lines).toContain('ok|campaign');
	});

	it('still compares the same stats field on a document the rollup does not own', async () => {
		const { code, lines } = await upgrade((data) => void (row(data, DRAFT)['statsSent'] = 5));
		expect(code).toBe(1);
		expect(lines).toContain('bad|draft|draft:statsSent 0 → 5');
	});

	it('skips a field the allowlist names for the release being updated to, and only for that release', async () => {
		const clear = (data: Tables) => void (row(data, T2)['html'] = '');
		const entry = {
			doc: 'draft/emailTemplateId',
			field: 'html',
			migration: 'migrations/0070_example.ts',
		};
		expect((await upgrade(clear, [{ ...entry, to: '0.6.15' }])).code).toBe(0);
		expect((await upgrade(clear, [{ ...entry, to: '0.6.16' }])).code).toBe(1);
	});
});

describe('DATA_DERIVED_FIELDS', () => {
	it('lists exactly the fields the campaign stats rollup writes', async () => {
		const source = await readFile(
			fileURLToPath(new URL('../../apps/api/convex/lib/validators/campaigns.ts', import.meta.url)),
			'utf8'
		);
		const block = /CAMPAIGN_SHARDED_STAT_FIELDS = \[([^\]]*)\]/.exec(source)?.[1] ?? '';
		const sharded = [...block.matchAll(/'([A-Za-z]+)'/g)].map((match) => match[1]);
		expect(sharded.length).toBeGreaterThan(0);
		const { stdout } = await runLib('printf "%s" "$DATA_DERIVED_FIELDS"');
		const derived = JSON.parse(stdout) as { doc: string; field: string }[];
		expect(new Set(derived.map((entry) => entry.doc))).toEqual(new Set(['campaign']));
		expect(derived.map((entry) => entry.field).sort()).toEqual(
			['statsUpdatedAt', ...sharded].sort()
		);
	});
});
