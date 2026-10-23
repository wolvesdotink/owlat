/**
 * Conformance for the message-classifier ratchet
 * (`apps/api/scripts/check-error-classifiers.sh`).
 *
 * The cases run the REAL script against throwaway `apps/api` trees: the
 * `--generate` half pins what it reports (a classifier reading message text,
 * under `convex/`, outside tests, generated code and comments), and the full
 * run pins the ratchet: a listed site passes, a new one fails, a listed one
 * that went away fails as stale.
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

const GATE = 'apps/api/scripts/check-error-classifiers.sh';
const BASELINE = 'apps/api/scripts/error-classifier-baseline.txt';

const roots: string[] = [];

afterAll(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
	roots.length = 0;
});

/** A throwaway repository holding the gate, the ratchet, `files` and a baseline. */
async function tree(files: Record<string, string>, baseline = ''): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'owlat-error-classifier-gate-'));
	roots.push(root);
	await mkdir(join(root, 'apps/api/convex'), { recursive: true });
	await mkdir(join(root, 'apps/api/scripts'), { recursive: true });
	await mkdir(join(root, 'scripts'), { recursive: true });
	for (const [path, contents] of Object.entries(files)) {
		const target = join(root, 'apps/api', path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, contents, 'utf8');
	}
	await copyFile(join(REPOSITORY_ROOT, GATE), join(root, GATE));
	await copyFile(join(REPOSITORY_ROOT, 'scripts/ratchet.sh'), join(root, 'scripts/ratchet.sh'));
	await writeFile(join(root, BASELINE), baseline, 'utf8');
	return root;
}

/** `file:spelling` entries the generator reports for a tree holding `files`. */
async function violations(files: Record<string, string>): Promise<string[]> {
	const root = await tree(files);
	const { stdout } = await run('bash', [GATE, '--generate'], { cwd: root });
	return stdout.split('\n').filter((line) => line.length > 0);
}

async function gate(
	files: Record<string, string>,
	baseline: string
): Promise<{ code: number; output: string }> {
	const root = await tree(files, baseline);
	try {
		const { stdout, stderr } = await run('bash', [GATE], { cwd: root });
		return { code: 0, output: `${stdout}${stderr}` };
	} catch (error) {
		const failure = error as { code?: number; stdout?: string; stderr?: string };
		return { code: failure.code ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
	}
}

describe('convex error-classifier ratchet', () => {
	it('reports every message-text classifier, one line per occurrence', async () => {
		expect(
			await violations({
				'convex/contacts/api.ts': [
					"const message = error instanceof Error ? error.message : '';",
					"if (message.includes('already exists')) return 409;",
					'',
				].join('\n'),
				'convex/delivery/payload.ts': [
					"if (error.message.startsWith('Unhandled')) return 'A';",
					"if (errorMessage.endsWith('!') || errorText.match(/x/)) return 'B';",
					"if (/limit/i.test(error.message)) return 'C';",
					"if (lowerMsg.search('quota') >= 0) return 'D';",
					'',
				].join('\n'),
			})
		).toEqual([
			'convex/contacts/api.ts:message.includes',
			'convex/delivery/payload.ts:.test(error.message)',
			'convex/delivery/payload.ts:errorMessage.endsWith',
			'convex/delivery/payload.ts:errorText.match',
			'convex/delivery/payload.ts:lowerMsg.search',
			'convex/delivery/payload.ts:message.startsWith',
		]);
	});

	it('does not read typed classification, other text, comments, tests or generated code', async () => {
		const classifier = "if (message.includes('already exists')) return 409;\n";
		expect(
			await violations({
				'convex/contacts/api.ts': [
					"if (internalFailureOf(error)?.kind === 'mta.dkim_ownership_conflict') return 1;",
					"if (extractOperationError(error)?.category === 'already_exists') return 2;",
					"if (code.startsWith('ROUTING_DECISION_')) return 3;",
					"if (subject.includes('invoice')) return 4;",
					"// Never write message.includes('already exists') here.",
					" * nor message.startsWith('x') in a doc comment.",
					'',
				].join('\n'),
				'convex/contacts/__tests__/api.test.ts': classifier,
				'convex/contacts/api.test.ts': classifier,
				'convex/_generated/api.ts': classifier,
			})
		).toEqual([]);
	});

	it('passes a listed site and fails a new one', async () => {
		const files = {
			'convex/lib/platform.ts': 'export const isLimit = (m: string) => /limit/.test(message);\n',
		};
		const listed = await gate(files, '# platform wording\nconvex/lib/platform.ts:.test(message)\n');
		expect(listed.code).toBe(0);
		expect(listed.output).toContain('ok:');

		const added = await gate(
			{ ...files, 'convex/contacts/api.ts': "if (message.includes('exists')) return 409;\n" },
			'convex/lib/platform.ts:.test(message)\n'
		);
		expect(added.code).toBe(1);
		expect(added.output).toContain('convex/contacts/api.ts:message.includes');
		expect(added.output).toContain('InternalFailure');
	});

	it('fails a listed site that went away as stale', async () => {
		const result = await gate({}, 'convex/lib/platform.ts:.test(message)\n');
		expect(result.code).toBe(1);
		expect(result.output).toContain('stale');
		expect(result.output).toContain('convex/lib/platform.ts:.test(message)');
	});
});
