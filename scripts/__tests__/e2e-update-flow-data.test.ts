/**
 * The update flow (scripts/e2e-update-flow.sh) seeds Convex data at the
 * previous release and checks it survived the in-app update. The run itself
 * needs Docker and two published releases, so it only happens in the Update
 * flow workflow; these cases pin the parts that decide its verdict:
 *
 *   - the two read-only queries the script sends with `convex run
 *     --inline-query`, evaluated here against an in-memory `ctx.db`;
 *   - the precondition check on the seeded snapshot;
 *   - the comparison that names each invariant that broke.
 *
 * Every case runs the REAL functions from scripts/e2e-update-flow-data.sh
 * under bash.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const LIB = fileURLToPath(new URL('../e2e-update-flow-data.sh', import.meta.url));
const roots: string[] = [];

afterAll(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** Runs `source <lib>; <fn> "$@"` under bash. */
function runLib(fn: string, args: string[] = []) {
	return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
		execFile('bash', ['-c', `source "$0"; ${fn} "$@"`, LIB, ...args], (error, stdout, stderr) => {
			const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
			resolve({ code, stdout, stderr });
		});
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

/** The subset of a Convex query `ctx` the two queries use. */
function fakeCtx(tables: Record<string, Doc[]>) {
	return {
		db: {
			query: (table: string) => ({ collect: async () => [...(tables[table] ?? [])] }),
			get: async (id: string) =>
				Object.values(tables)
					.flat()
					.find((doc) => doc._id === id) ?? null,
		},
	};
}

/** Evaluates `export default query({ handler })` source the way the CLI's wrapper would. */
async function evaluateQuery(source: string, tables: Record<string, Doc[]>): Promise<unknown> {
	const module = new Function('query', source.replace('export default ', 'return '));
	const definition = module((definition: unknown) => definition) as {
		handler: (ctx: ReturnType<typeof fakeCtx>) => Promise<unknown>;
	};
	return definition.handler(fakeCtx(tables));
}

const TABLES: Record<string, Doc[]> = {
	contacts: [
		{ _id: 'c2', _creationTime: 2, email: 'zoe@example.com', firstName: 'Zoe', seedTag: 'demo' },
		{ _id: 'c1', _creationTime: 1, email: 'ada@example.com', firstName: 'Ada', seedTag: 'demo' },
		{ _id: 'c0', _creationTime: 0, email: 'aaa@example.com', firstName: 'Own' },
	],
	campaigns: [
		{
			_id: 'k1',
			_creationTime: 3,
			name: 'Summer',
			status: 'sent',
			subject: 'Hi',
			seedTag: 'demo',
			emailTemplateId: 't1',
			sentAt: 9,
			statsSent: 1,
		},
		{
			_id: 'k2',
			_creationTime: 4,
			name: 'June',
			status: 'draft',
			subject: 'New',
			seedTag: 'demo',
			emailTemplateId: 't2',
		},
		{
			_id: 'k0',
			_creationTime: 5,
			name: 'Mine',
			status: 'draft',
			subject: 'Own',
			emailTemplateId: 't2',
		},
	],
	emailTemplates: [
		{ _id: 't1', _creationTime: 0 },
		{ _id: 't2', _creationTime: 0 },
	],
	emailSends: [
		{
			_id: 's1',
			_creationTime: 6,
			campaignId: 'k1',
			contactId: 'c1',
			contactEmail: 'ada@example.com',
			status: 'delivered',
			queuedAt: 6,
		},
		{
			_id: 's2',
			_creationTime: 7,
			campaignId: 'k1',
			contactId: 'c1',
			contactEmail: 'ada@example.com',
			status: 'queued',
			queuedAt: 7,
		},
	],
};

const IDS = { contact: 'c1', campaign: 'k1', draft: 'k2', queuedSend: 's2' };

/** What the snapshot query returns for TABLES and IDS. */
function snapshot() {
	return {
		contact: {
			_id: 'c1',
			_creationTime: 1,
			email: 'ada@example.com',
			firstName: 'Ada',
			lastName: null,
		},
		campaign: {
			_id: 'k1',
			_creationTime: 3,
			name: 'Summer',
			status: 'sent',
			subject: 'Hi',
			emailTemplateId: 't1',
			sentAt: 9,
			statsSent: 1,
			sends: 2,
		},
		draft: {
			_id: 'k2',
			_creationTime: 4,
			name: 'June',
			status: 'draft',
			subject: 'New',
			emailTemplateId: 't2',
			templateExists: true,
		},
		queuedSend: {
			_id: 's2',
			_creationTime: 7,
			status: 'queued',
			campaignId: 'k1',
			contactId: 'c1',
			contactEmail: 'ada@example.com',
			queuedAt: 7,
			providerMessageId: null,
			firstAttemptAt: null,
		},
		rows: {
			contacts: ['c0', 'c1', 'c2'],
			campaigns: ['k0', 'k1', 'k2'],
			emailSends: ['s1', 's2'],
			emailTemplates: ['t1', 't2'],
		},
	};
}

describe('data_roles_query', () => {
	it('names the first sample contact by email, the sent and the draft sample campaign, and the queued Sends', async () => {
		const { code, stdout } = await runLib('data_roles_query');
		expect(code).toBe(0);
		expect(await evaluateQuery(stdout, TABLES)).toEqual({
			contact: { id: 'c1', email: 'ada@example.com' },
			campaign: 'k1',
			draft: 'k2',
			queuedSends: ['s2'],
		});
	});

	it('reports a missing role as null instead of picking an operator row', async () => {
		const { stdout } = await runLib('data_roles_query');
		const tables = { ...TABLES, campaigns: TABLES['campaigns']!.filter((c) => c._id === 'k0') };
		expect(await evaluateQuery(stdout, tables)).toMatchObject({ campaign: null, draft: null });
	});
});

describe('data_snapshot_query', () => {
	it('projects the named rows and lists every row id per table', async () => {
		const { code, stdout } = await runLib('data_snapshot_query', [JSON.stringify(IDS)]);
		expect(code).toBe(0);
		expect(await evaluateQuery(stdout, TABLES)).toEqual(snapshot());
	});

	it('returns null for a row that is gone and false for a draft whose template is gone', async () => {
		const { stdout } = await runLib('data_snapshot_query', [JSON.stringify(IDS)]);
		const tables = {
			...TABLES,
			emailTemplates: TABLES['emailTemplates']!.filter((t) => t._id !== 't2'),
			emailSends: TABLES['emailSends']!.filter((s) => s._id !== 's2'),
		};
		const result = (await evaluateQuery(stdout, tables)) as ReturnType<typeof snapshot>;
		expect(result.queuedSend).toBeNull();
		expect(result.campaign.sends).toBe(1);
		expect(result.draft.templateExists).toBe(false);
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
	it('accepts a snapshot in the state every invariant describes', async () => {
		const { code, stdout } = await runLib('data_snapshot_problems', [
			await writeJson('before.json', snapshot()),
		]);
		expect(code).toBe(0);
		expect(stdout).toBe('');
	});

	it.each([
		['the named contact is missing', (s: ReturnType<typeof snapshot>) => ({ ...s, contact: null })],
		[
			'the sent campaign has status sending',
			(s: ReturnType<typeof snapshot>) => ({
				...s,
				campaign: { ...s.campaign, status: 'sending' },
			}),
		],
		[
			'the draft campaign has no template',
			(s: ReturnType<typeof snapshot>) => ({ ...s, draft: { ...s.draft, templateExists: false } }),
		],
		[
			'the queued Send was attempted',
			(s: ReturnType<typeof snapshot>) => ({
				...s,
				queuedSend: { ...s.queuedSend, firstAttemptAt: 8 },
			}),
		],
		[
			'the queued Send does not reference the named contact and campaign',
			(s: ReturnType<typeof snapshot>) => ({
				...s,
				queuedSend: { ...s.queuedSend, contactId: 'c2' },
			}),
		],
	])('reports "%s"', async (problem, mutate) => {
		const { stdout } = await runLib('data_snapshot_problems', [
			await writeJson('before.json', mutate(snapshot())),
		]);
		expect(stdout.split('\n')).toContain(problem);
	});
});

describe('data_compare_snapshots', () => {
	async function compare(after: unknown) {
		return runLib('data_compare_snapshots', [
			await writeJson('before.json', snapshot()),
			await writeJson('after.json', after),
		]);
	}

	it('passes every named invariant when the rows came through unchanged', async () => {
		const { code, stdout } = await compare(snapshot());
		expect(code).toBe(0);
		expect(stdout.trim().split('\n')).toEqual([
			'ok|contact',
			'ok|campaign',
			'ok|draft',
			'ok|queued-send',
			'ok|rows',
		]);
	});

	it('ignores rows added after the snapshot', async () => {
		const after = snapshot();
		after.rows.contacts.push('c9');
		expect((await compare(after)).code).toBe(0);
	});

	it('names the invariant and the field that changed', async () => {
		const after = snapshot();
		after.draft.status = 'sent';
		const { code, stdout } = await compare(after);
		expect(code).toBe(1);
		expect(stdout).toContain('bad|draft|status: "draft" → "sent"');
		expect(stdout).toContain('ok|contact');
	});

	it('fails the queued Send once anything attempted it', async () => {
		const before = snapshot();
		const after = {
			...before,
			queuedSend: { ...before.queuedSend, status: 'failed', firstAttemptAt: 8 },
		};
		const { code, stdout } = await compare(after);
		expect(code).toBe(1);
		expect(stdout).toContain(
			'bad|queued-send|status: "queued" → "failed"; firstAttemptAt: null → 8'
		);
	});

	it('reports a named row that is gone', async () => {
		const { code, stdout } = await compare({ ...snapshot(), contact: null });
		expect(code).toBe(1);
		expect(stdout).toContain('bad|contact|row c1 is gone');
	});

	it('reports rows of the checked tables that went missing', async () => {
		const after = snapshot();
		after.rows.emailSends = ['s2'];
		after.rows.campaigns = ['k1', 'k2'];
		const { code, stdout } = await compare(after);
		expect(code).toBe(1);
		expect(stdout).toContain('bad|rows|missing campaigns: k0; emailSends: s1');
	});
});
