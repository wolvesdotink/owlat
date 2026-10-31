/**
 * Self-test for the `scripts/check-token-redaction.sh` read-side ratchet (piece
 * P5, finding L1): a public read that returns a token-bearing table (contacts /
 * shareLinks / apiKeys / webhooks) without a redaction helper or a
 * `// token-safe:` justification must fail the gate; a redacted or justified
 * read must pass. It guards the guard — a future edit that neuters the grep is
 * caught by CI.
 *
 * The gate has no baseline. The script takes an optional scan root so the
 * fixtures below run against a throwaway tree; the final case asserts the real
 * convex/ tree passes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts');
const scriptPath = join(scriptsDir, 'check-token-redaction.sh');

/** Run the gate over `root`. Returns the exit code and what it printed. */
function runGate(root: string): { code: number; output: string } {
	try {
		const output = execFileSync('bash', [scriptPath, root], { encoding: 'utf8', stdio: 'pipe' });
		return { code: 0, output };
	} catch (err) {
		const failure = err as { status?: number; stdout?: string };
		return {
			code: typeof failure.status === 'number' ? failure.status : 1,
			output: failure.stdout ?? '',
		};
	}
}

function runRatchet(root: string): number {
	return runGate(root).code;
}

let workDir: string;

beforeAll(() => {
	workDir = mkdtempSync(join(tmpdir(), 'token-redaction-ratchet-'));
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
		expect(runRatchet(root)).toBe(1);
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
		expect(runRatchet(root)).toBe(1);
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
		expect(runRatchet(root)).toBe(0);
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
		expect(runRatchet(root)).toBe(0);
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
		expect(runRatchet(root)).toBe(0);
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
		expect(runRatchet(root)).toBe(0);
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
		expect(runRatchet(root)).toBe(1);
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
		expect(runRatchet(root)).toBe(0);
	});

	it('names the offending read and admits none', () => {
		const root = fixture(
			'named',
			[
				'export const listKeys = adminQuery({',
				'	args: {},',
				'	handler: async (ctx) => {',
				"		return await ctx.db.query('apiKeys').collect();",
				'	},',
				'});',
				'',
			].join('\n')
		);
		const result = runGate(root);
		expect(result.code).toBe(1);
		expect(result.output).toContain(`${root}/read.ts:listKeys`);
	});

	it('passes a clean tree', () => {
		expect(runRatchet(fixture('clean-tree', 'export const noop = 1;\n'))).toBe(0);
	});

	// Every case above greps a throwaway fixture tree; this one greps the whole
	// real convex/ tree and takes seconds rather than milliseconds. The scan is
	// CPU-bound and has no upper bound it can be made to respect; on a release
	// gate that runs every workspace's suites on one 4-core runner it needs the
	// suite's parallel-gate budget (vitest.config.ts), not a 10s one.
	it('passes the real convex tree', () => {
		expect(runRatchet('convex')).toBe(0);
	});
});
