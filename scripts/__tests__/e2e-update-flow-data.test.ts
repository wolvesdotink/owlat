/**
 * The update flow (scripts/e2e-update-flow.sh) seeds Convex data at the
 * previous release and checks it survived the in-app update. The run itself
 * needs Docker and two published releases, so it only happens in the Update
 * flow workflow; these cases pin the parts that decide its verdict:
 *
 *   - the read-only queries the script sends with `convex run --inline-query`
 *     (roles, baseline, reload), evaluated here against an in-memory `ctx.db`;
 *   - the precondition check on the seeded baseline;
 *   - the comparison that names each invariant that broke. Its regressions
 *     change the underlying rows between the baseline and the reload, the way
 *     an upgrade would, and take both with the real queries.
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
 * The subset of a Convex query `ctx` the queries use. Like the real `db.get`,
 * a string that is not an id throws and an unknown id is null.
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
const ROLES = { contact: C1, campaign: SENT, draft: DRAFT, queuedSend: QUEUED };

/** A fresh copy of the seeded tables, for a case to change. */
function tables(): Tables {
	return structuredClone({
		contacts: [
			// Alan received the sample Send but is not the named contact.
			{ _id: C2, _creationTime: 2, email: 'alan@example.com', firstName: 'Alan', seedTag: 'demo' },
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
				statsSent: 0,
				statsUpdatedAt: 50,
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
				contactId: C2,
				contactEmail: 'alan@example.com',
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

type Baseline = {
	roles: typeof ROLES;
	sends: string[];
	manifest: Record<string, { invariant: string; label: string; strict: boolean }>;
	docs: Record<string, Doc | null>;
	rows: Record<string, string[]>;
};
type Reload = { docs: Record<string, Doc | null>; rows: Record<string, string[]> };

async function baselineOf(data: Tables): Promise<Baseline> {
	const { code, stdout } = await runLib('data_baseline_query', [JSON.stringify(ROLES)]);
	expect(code).toBe(0);
	return (await evaluateQuery(stdout, data)) as Baseline;
}

async function reloadOf(data: Tables, baseline: Baseline): Promise<Reload> {
	const { code, stdout } = await runLib('data_reload_query', [
		JSON.stringify(Object.keys(baseline.docs)),
	]);
	expect(code).toBe(0);
	return (await evaluateQuery(stdout, data)) as Reload;
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

describe('data_baseline_query', () => {
	it('keys whole documents by id: the roots and everything within two hops of any of them, Sends included', async () => {
		const baseline = await baselineOf(tables());
		const labels = Object.fromEntries(
			Object.entries(baseline.manifest).map(([docId, entry]) => [docId, entry.label])
		);
		expect(labels).toEqual({
			[C1]: 'contact',
			[SENT]: 'campaign',
			[S1]: `campaign/send:${S1}`,
			[DRAFT]: 'draft',
			[QUEUED]: 'queued-send',
			[T1]: 'campaign/emailTemplateId',
			[TOPIC]: 'campaign/audience.topicId',
			[C2]: `campaign/send:${S1}/contactId`,
			[T2]: 'draft/emailTemplateId',
			[BLOCK]: 'draft/emailTemplateId/blocks.0',
		});
		expect(baseline.manifest[C2]!.invariant).toBe('campaign');
		expect(Object.keys(baseline.docs).sort()).toEqual(Object.keys(baseline.manifest).sort());
		expect(baseline.docs[C1]).toEqual(row(tables(), C1));
		expect(baseline.sends).toEqual([S1]);
	});

	it('marks only the queued Send strict', async () => {
		const { manifest } = await baselineOf(tables());
		expect(Object.keys(manifest).filter((docId) => manifest[docId]!.strict)).toEqual([QUEUED]);
	});

	it('stops after two hops and ignores an id-shaped string that is no document', async () => {
		const { docs } = await baselineOf(tables());
		// The asset is a third hop (draft → template → block → asset).
		expect(ASSET in docs).toBe(false);
		expect('f'.repeat(32) in docs).toBe(false);
	});

	it('lists every row id of the checked tables', async () => {
		const { rows } = await baselineOf(tables());
		expect(rows).toEqual({
			contacts: [C0, C1, C2].sort(),
			campaigns: [SENT, DRAFT, OWN].sort(),
			emailSends: [S1, QUEUED].sort(),
			emailTemplates: [T1, T2].sort(),
		});
	});

	it('refuses ids that are not Convex ids, so nothing but an id reaches the query source', async () => {
		const { code, stdout } = await runLib('data_baseline_query', [
			JSON.stringify({ ...ROLES, draft: "k2'); throw 1; ('" }),
		]);
		expect(code).not.toBe(0);
		expect(stdout).toBe('');
	});
});

describe('data_reload_query', () => {
	it('loads exactly the given ids, a missing one as null', async () => {
		const data = tables();
		data['emailSends'] = data['emailSends']!.filter((send) => send._id !== QUEUED);
		const { code, stdout } = await runLib('data_reload_query', [JSON.stringify([C1, QUEUED])]);
		expect(code).toBe(0);
		const reload = (await evaluateQuery(stdout, data)) as Reload;
		expect(reload.docs).toEqual({ [C1]: row(tables(), C1), [QUEUED]: null });
	});

	it('refuses anything but a list of Convex ids', async () => {
		for (const ids of ['[]', '["ok", "x\'); throw 1; (\'"]', '{"a": "b"}']) {
			const { code, stdout } = await runLib('data_reload_query', [ids]);
			expect(code).not.toBe(0);
			expect(stdout).toBe('');
		}
	});
});

describe('data_snapshot_problems', () => {
	async function problems(data: Tables) {
		return runLib('data_snapshot_problems', [
			await writeJson('baseline.json', await baselineOf(data)),
		]);
	}

	it('accepts a baseline in the state every invariant describes', async () => {
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
	 * Takes the baseline of the seeded tables, applies `change` to them the way
	 * an upgrade would, reloads the baseline's ids and compares, for an update
	 * to 0.6.15. `allowlist` replaces DATA_REWRITE_ALLOWLIST after the library
	 * set its default.
	 */
	async function upgrade(change: (data: Tables) => void, allowlist?: unknown[]) {
		const data = tables();
		const baseline = await baselineOf(data);
		change(data);
		const reload = await reloadOf(data, baseline);
		const files = [
			await writeJson('baseline.json', baseline),
			await writeJson('after.json', reload),
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

	it('lets a reference to an already captured document be added without moving it', async () => {
		const { code, lines } = await upgrade((data) => {
			row(data, C1)['favoriteTemplateId'] = T2;
			row(data, T2)['ownerContactId'] = C1;
		});
		expect(code).toBe(0);
		expect(lines).toContain('ok|draft');
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

	it('fails the campaign when the recipient of one of its Sends loses their name', async () => {
		const { code, lines } = await upgrade((data) => void delete row(data, C2)['firstName']);
		expect(code).toBe(1);
		expect(lines).toContain(
			`bad|campaign|campaign/send:${S1}/contactId:firstName removed (was "Alan")`
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

	it.each<[string, (send: Doc) => void, string]>([
		[
			'a first attempt time, status still queued',
			(send) => void (send['firstAttemptAt'] = 8),
			'queued-send:firstAttemptAt added 8',
		],
		[
			'a provider message id, status still queued',
			(send) => void (send['providerMessageId'] = 'mta-1'),
			'queued-send:providerMessageId added "mta-1"',
		],
		[
			'a new status',
			(send) => void (send['status'] = 'failed'),
			'queued-send:status "queued" → "failed"',
		],
	])('fails the queued Send once it gains %s', async (_case, change, message) => {
		const { code, lines } = await upgrade((data) => change(row(data, QUEUED)));
		expect(code).toBe(1);
		expect(lines).toContain(`bad|queued-send|${message}`);
	});

	it('fails the campaign when one of its Sends changes', async () => {
		const { code, lines } = await upgrade((data) => void (row(data, S1)['status'] = 'bounced'));
		expect(code).toBe(1);
		expect(lines).toContain(`bad|campaign|campaign/send:${S1}:status "delivered" → "bounced"`);
	});

	it.each<[string, (campaign: Doc) => void, string]>([
		[
			'removed',
			(campaign) => void delete campaign['statsSent'],
			'campaign:statsSent removed (was 0)',
		],
		['wrong', (campaign) => void (campaign['statsSent'] = 7), 'campaign:statsSent 0 → 7'],
	])('compares the stats counters strictly: statsSent %s fails', async (_case, change, message) => {
		const { code, lines } = await upgrade((data) => change(row(data, SENT)));
		expect(code).toBe(1);
		expect(lines).toContain(`bad|campaign|${message}`);
	});

	it('reports a named row that is gone, and the row ids it took with it', async () => {
		const { code, lines } = await upgrade(
			(data) => void (data['contacts'] = data['contacts']!.filter((contact) => contact._id !== C1))
		);
		expect(code).toBe(1);
		expect(lines).toContain(`bad|contact|contact is gone (was ${C1})`);
		expect(lines).toContain(`bad|rows|missing contacts: ${C1}`);
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

describe('data_rollup_stats', () => {
	it("runs the function the backend's campaign stats cron runs", async () => {
		const crons = await readFile(
			fileURLToPath(new URL('../../apps/api/convex/crons.ts', import.meta.url)),
			'utf8'
		);
		expect(crons).toContain('internal.campaigns.statShards.rollupSentCampaignStats');
		const lib = await readFile(LIB, 'utf8');
		expect(lib).toContain('convex run campaigns/statShards:rollupSentCampaignStats');
	});
});
