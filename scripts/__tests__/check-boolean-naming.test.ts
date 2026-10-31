/**
 * Conformance for the boolean-naming gate
 * (`apps/api/scripts/check-boolean-naming.sh`).
 *
 * Each case runs the REAL script and the REAL `scripts/ratchet.sh` it execs
 * against a throwaway `apps/api` tree: boolean schema fields need an `is*` or
 * `has*` prefix; fields named by an external wire vocabulary sit in the
 * not-debt wire list, which the generator drops before the debt ratchet and
 * which fails on a line that no longer matches a field.
 */

import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const run = promisify(execFile);

const RATCHET = 'scripts/ratchet.sh';
const GATE = 'apps/api/scripts/check-boolean-naming.sh';
const BASELINE = 'scripts/boolean-naming-baseline.txt';
const WIRE_LIST = 'scripts/boolean-naming-wire-fields.txt';

const roots: string[] = [];

afterAll(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
	roots.length = 0;
});

/** A throwaway repository holding the real gate, the real runner and `files` under `apps/api/`. */
async function tree(files: Record<string, string>): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'owlat-boolean-naming-'));
	roots.push(root);
	await mkdir(join(root, 'apps/api/convex/schema'), { recursive: true });
	for (const [path, contents] of Object.entries(files)) {
		const target = join(root, 'apps/api', path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, contents, 'utf8');
	}
	await mkdir(join(root, 'apps/api/scripts'), { recursive: true });
	await copyFile(join(REPOSITORY_ROOT, GATE), join(root, GATE));
	await mkdir(join(root, 'scripts'), { recursive: true });
	await copyFile(join(REPOSITORY_ROOT, RATCHET), join(root, RATCHET));
	return root;
}

async function gate(root: string, ...args: string[]): Promise<{ code: number; output: string }> {
	try {
		const { stdout, stderr } = await run('bash', [GATE, ...args], { cwd: root });
		return { code: 0, output: `${stdout}${stderr}` };
	} catch (error) {
		const failure = error as { code?: number; stdout?: string; stderr?: string };
		return { code: failure.code ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
	}
}

const SCHEMA = [
	'export const tables = {',
	'\tmessages: defineTable({',
	'\t\tisRead: v.boolean(),',
	'\t\thasAttachments: v.optional(v.boolean()),',
	'\t\tflagSeen: v.boolean(),',
	'\t\tpinned: v.boolean(),',
	'\t\thash: v.optional(v.boolean()),',
	'\t\tlabels: v.record(v.string(), v.boolean()),',
	'\t}),',
	'};',
	'',
].join('\n');

const WIRE = ['# IMAP flags', 'mail.ts:flagSeen', ''].join('\n');

describe('boolean-naming gate', () => {
	it('accepts is* and has* prefixes and drops wire-listed fields', async () => {
		const root = await tree({ 'convex/schema/mail.ts': SCHEMA, [WIRE_LIST]: WIRE });
		const { code, output } = await gate(root, '--generate');
		expect(code).toBe(0);
		// `hash` is not a `has<Capital>` prefix; the nested record value is not a field.
		expect(output.split('\n').filter(Boolean)).toEqual(['mail.ts:hash', 'mail.ts:pinned']);
	});

	it('passes when the debt baseline matches, and fails on a new mis-named field', async () => {
		const root = await tree({
			'convex/schema/mail.ts': SCHEMA,
			[WIRE_LIST]: WIRE,
			[BASELINE]: '# debt\nmail.ts:hash\nmail.ts:pinned\n',
		});
		expect(await gate(root)).toMatchObject({ code: 0 });

		await writeFile(
			join(root, 'apps/api/convex/schema/other.ts'),
			'export const t = {\n\tenabled: v.boolean(),\n};\n'
		);
		const result = await gate(root);
		expect(result.code).toBe(1);
		expect(result.output).toContain('other.ts:enabled');
	});

	it('fails on a wire-list line that no longer matches a mis-named field', async () => {
		const renamed = SCHEMA.replace('flagSeen', 'isSeen');
		const root = await tree({
			'convex/schema/mail.ts': renamed,
			[WIRE_LIST]: WIRE,
			[BASELINE]: 'mail.ts:hash\nmail.ts:pinned\n',
		});
		const result = await gate(root);
		expect(result.code).toBe(1);
		expect(result.output).toContain(`stale entr(y/ies) in ${WIRE_LIST}`);
		expect(result.output).toContain('mail.ts:flagSeen');
	});

	it('fails when a wire-listed field is also in the debt baseline', async () => {
		const root = await tree({
			'convex/schema/mail.ts': SCHEMA,
			[WIRE_LIST]: WIRE,
			[BASELINE]: 'mail.ts:flagSeen\nmail.ts:hash\nmail.ts:pinned\n',
		});
		const result = await gate(root);
		expect(result.code).toBe(1);
		expect(result.output).toContain('stale entr(y/ies) in scripts/boolean-naming-baseline.txt');
	});

	it('fails loudly when the wire list is missing', async () => {
		const root = await tree({
			'convex/schema/mail.ts': SCHEMA,
			[BASELINE]: 'mail.ts:hash\nmail.ts:pinned\n',
		});
		const result = await gate(root);
		expect(result.code).toBe(1);
		expect(result.output).toContain(`${WIRE_LIST} missing`);
	});
});
