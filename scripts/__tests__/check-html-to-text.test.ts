/**
 * Conformance for the HTML-to-text ratchet (`scripts/check-html-to-text.sh`).
 *
 * The cases run the REAL script's `--generate` half against throwaway trees and
 * pin what it reports: a hand-rolled `.replace(/<[^>]+>/g` or
 * `.replace(/<[^>]*>/g` tag strip under apps/api/convex, packages/shared/src,
 * packages/mail-message/src or packages/email-renderer/src, outside the shared
 * helper, tests and generated code. Prose that names a spelling is not code and is not reported.
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

const GATE = 'scripts/check-html-to-text.sh';
const SCOPES = [
	'apps/api/convex',
	'packages/shared/src',
	'packages/mail-message/src',
	'packages/email-renderer/src',
];

const roots: string[] = [];

afterAll(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
	roots.length = 0;
});

/** `file:spelling` entries the gate reports for a throwaway tree holding `files`. */
async function violations(files: Record<string, string>): Promise<string[]> {
	const root = await mkdtemp(join(tmpdir(), 'owlat-html-to-text-gate-'));
	roots.push(root);

	for (const scope of SCOPES) await mkdir(join(root, scope), { recursive: true });
	for (const [path, contents] of Object.entries(files)) {
		const target = join(root, path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, contents, 'utf8');
	}
	await mkdir(join(root, 'scripts'), { recursive: true });
	await copyFile(join(REPOSITORY_ROOT, GATE), join(root, GATE));

	const { stdout } = await run('bash', [GATE, '--generate'], { cwd: root });
	return stdout.split('\n').filter((line) => line.length > 0);
}

describe('HTML-to-text ratchet', () => {
	it('reports each hand-rolled tag strip by file, in every scope', async () => {
		expect(
			await violations({
				'apps/api/convex/mail/preview.ts': "const t = html.replace(/<[^>]+>/g, ' ');\n",
				'packages/shared/src/visible.ts': "return s.replace(/<[^>]*>/g, '').trim();\n",
				'packages/mail-message/src/compose/fallback.ts': "html.replace(/<[^>]+>/gi, ' ')\n",
				'packages/email-renderer/src/helpers/text.ts': "html.replace(/<[^>]+>/g, '')\n",
			})
		).toEqual([
			'apps/api/convex/mail/preview.ts:.replace(/<[^>]+>/g',
			'packages/email-renderer/src/helpers/text.ts:.replace(/<[^>]+>/g',
			'packages/mail-message/src/compose/fallback.ts:.replace(/<[^>]+>/g',
			'packages/shared/src/visible.ts:.replace(/<[^>]*>/g',
		]);
	});

	it('reports a chained strip on its own line', async () => {
		expect(
			await violations({
				'apps/api/convex/knowledge/text.ts': [
					'return html',
					"\t.replace(/<style[^>]*>[\\s\\S]*?<\\/style>/gi, '')",
					"\t.replace(/<[^>]+>/g, ' ')",
					'',
				].join('\n'),
			})
		).toEqual(['apps/api/convex/knowledge/text.ts:.replace(/<[^>]+>/g']);
	});

	it('exempts the shared helper, tests and generated code', async () => {
		const spelled = "const t = html.replace(/<[^>]+>/g, ' ');\n";
		expect(
			await violations({
				'packages/mail-message/src/text/htmlToPlainText.ts': spelled,
				'apps/api/convex/mail/__tests__/preview.test.ts': spelled,
				'packages/shared/src/visible.test.ts': spelled,
				'apps/api/convex/_generated/api.ts': spelled,
			})
		).toEqual([]);
	});

	it('ignores prose that names a spelling, and code outside the scopes', async () => {
		expect(
			await violations({
				'apps/api/convex/mail/preview.ts': [
					'// never .replace(/<[^>]+>/g, " ") by hand',
					' * nor .replace(/<[^>]*>/g, "")',
					"import { htmlToPlainText } from '@owlat/shared/html';",
					'',
				].join('\n'),
				'packages/email-builder/src/text.ts': "html.replace(/<[^>]+>/g, ' ');\n",
			})
		).toEqual([]);
	});
});
