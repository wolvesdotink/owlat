/**
 * Self-test for the `scripts/check-token-redaction.sh` read-side ratchet (piece
 * P5, finding L1): a public read that returns a token-bearing table (contacts /
 * shareLinks / apiKeys / webhooks) without a redaction helper or a
 * `// token-safe:` justification must fail the gate; a redacted, justified, or
 * baselined read must pass. It guards the guard — a future edit that neuters the
 * grep is caught by CI.
 *
 * The script takes an optional scan-root and baseline-path so the fixtures below
 * run against a throwaway tree with an empty baseline; production runs keep the
 * frozen baseline. The final case asserts the real convex/ tree still passes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts');
const scriptPath = join(scriptsDir, 'check-token-redaction.sh');

/** Run the ratchet over `root` against `baseline`. Returns the exit code. */
function runRatchet(root: string, baseline: string): number {
	try {
		execFileSync('bash', [scriptPath, root, baseline], { encoding: 'utf8', stdio: 'pipe' });
		return 0;
	} catch (err) {
		const status = (err as { status?: number }).status;
		return typeof status === 'number' ? status : 1;
	}
}

let workDir: string;
let emptyBaseline: string;

beforeAll(() => {
	workDir = mkdtempSync(join(tmpdir(), 'token-redaction-ratchet-'));
	emptyBaseline = join(workDir, 'empty-baseline.txt');
	writeFileSync(emptyBaseline, '');
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

/** Write a single fixture file into a fresh dir and return that dir. */
function fixture(name: string, contents: string): string {
	const root = join(workDir, name);
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, 'read.ts'), contents);
	return root;
}

describe('check-token-redaction.sh ratchet', () => {
	it('fails a new authedQuery that returns raw contacts rows', () => {
		const root = fixture(
			'bad-contacts',
			[
				'export const listRaw = authedQuery({',
				'	args: {},',
				'	handler: async (ctx) => {',
				"		return await ctx.db.query('contacts').collect();",
				'	},',
				'});',
				'',
			].join('\n')
		);
		expect(runRatchet(root, emptyBaseline)).toBe(1);
	});

	it('fails a new publicQuery that returns raw shareLinks rows', () => {
		const root = fixture(
			'bad-sharelinks',
			[
				'export const listRaw = publicQuery({',
				'	args: {},',
				'	handler: async (ctx) => {',
				"		return await ctx.db.query('shareLinks').collect();",
				'	},',
				'});',
				'',
			].join('\n')
		);
		expect(runRatchet(root, emptyBaseline)).toBe(1);
	});

	it('passes a read that runs contacts through the redaction helper', () => {
		const root = fixture(
			'redacted',
			[
				'export const listSafe = authedQuery({',
				'	args: {},',
				'	handler: async (ctx) => {',
				"		const rows = await ctx.db.query('contacts').collect();",
				'		return rows.map(redactContactCapabilityFields);',
				'	},',
				'});',
				'',
			].join('\n')
		);
		expect(runRatchet(root, emptyBaseline)).toBe(0);
	});

	it('passes a read that strips the webhook secret', () => {
		const root = fixture(
			'stripped',
			[
				'export const listSafe = authedQuery({',
				'	args: {},',
				'	handler: async (ctx) => {',
				"		const rows = await ctx.db.query('webhooks').collect();",
				'		return rows.map(stripWebhookSecret);',
				'	},',
				'});',
				'',
			].join('\n')
		);
		expect(runRatchet(root, emptyBaseline)).toBe(0);
	});

	it('passes a read carrying an inline // token-safe: justification', () => {
		const root = fixture(
			'justified-inline',
			[
				'export const listIds = authedQuery({',
				'	args: {},',
				'	handler: async (ctx) => {',
				"		const rows = await ctx.db.query('apiKeys').collect();",
				'		// token-safe: returns only ids, never the keyHash',
				'		return rows.map((r) => r._id);',
				'	},',
				'});',
				'',
			].join('\n')
		);
		expect(runRatchet(root, emptyBaseline)).toBe(0);
	});

	it('passes a read whose // token-safe: note sits above the export', () => {
		const root = fixture(
			'justified-above',
			[
				'// token-safe: admin-gated count, returns no rows',
				'export const countKeys = authedQuery({',
				'	args: {},',
				'	handler: async (ctx) => {',
				"		const rows = await ctx.db.query('apiKeys').collect();",
				'		return rows.length;',
				'	},',
				'});',
				'',
			].join('\n')
		);
		expect(runRatchet(root, emptyBaseline)).toBe(0);
	});

	it('does not leak a // token-safe: note onto an unrelated later definition', () => {
		const root = fixture(
			'no-leak',
			[
				'// token-safe: this one is fine',
				'export const safe = authedQuery({',
				'	args: {},',
				'	handler: async (ctx) => {',
				"		return (await ctx.db.query('contacts').collect()).length;",
				'	},',
				'});',
				'',
				'export const leaky = authedQuery({',
				'	args: {},',
				'	handler: async (ctx) => {',
				"		return await ctx.db.query('contacts').collect();",
				'	},',
				'});',
				'',
			].join('\n')
		);
		expect(runRatchet(root, emptyBaseline)).toBe(1);
	});

	it('ignores internalQuery / mutation builders (server-only, not client-facing)', () => {
		const root = fixture(
			'internal',
			[
				'export const listRaw = internalQuery({',
				'	args: {},',
				'	handler: async (ctx) => {',
				"		return await ctx.db.query('contacts').collect();",
				'	},',
				'});',
				'',
			].join('\n')
		);
		expect(runRatchet(root, emptyBaseline)).toBe(0);
	});

	it('fails on a stale baseline entry so the ratchet only moves down', () => {
		const staleBaseline = join(workDir, 'stale-baseline.txt');
		writeFileSync(staleBaseline, 'convex/gone.ts:removedRead\n');
		const root = fixture('clean-tree', 'export const noop = 1;\n');
		expect(runRatchet(root, staleBaseline)).toBe(1);
	});

	it('passes the real convex tree against the frozen baseline', () => {
		expect(runRatchet('convex', 'scripts/token-redaction-baseline.txt')).toBe(0);
	});
});
