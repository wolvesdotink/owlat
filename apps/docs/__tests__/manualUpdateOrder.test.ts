import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './repoVocabulary';

/**
 * Every hand-run update recipe deploys the Convex functions before it recreates
 * the containers, the order `apps/updater/src/update.ts` follows. The other way
 * round, the new web, MTA and IMAP containers run against the previous
 * release's functions until the deploy finishes, which the compatibility rules
 * in `apps/api/convex/CONVENTIONS.md` do not cover.
 *
 * Only the order of the two commands is pinned, not the wording around them.
 * The manual rollback recipe is the deliberate exception (it recreates first,
 * see the maintenance page) and is not part of any section checked here.
 */

const read = (path: string) => readFileSync(resolve(REPO_ROOT, path), 'utf8');

const DEPLOY = 'docker compose --profile deploy run --rm convex-deploy';
const RECREATE = /docker compose up -d\s*$/m;

/** From the line matching `start` up to the first later line matching `end`. */
function section(text: string, start: RegExp, end: RegExp): string {
	const from = text.search(start);
	expect(from, `no section starting with ${start}`).toBeGreaterThanOrEqual(0);
	const bodyAt = text.indexOf('\n', from) + 1;
	const stop = text.slice(bodyAt).search(end);
	return stop < 0 ? text.slice(from) : text.slice(from, bodyAt + stop);
}

const RECIPES: Array<{ name: string; text: () => string }> = [
	...['en', 'de'].map((locale) => ({
		name: `${locale} maintenance page, Option C`,
		text: () =>
			section(
				read(`apps/docs/content/${locale}/3.developer/34.self-hosting-maintenance.md`),
				/^### Option C\b/m,
				/^##/m
			),
	})),
	{
		name: 'release notes',
		text: () => section(read('.github/workflows/release.yml'), /Manual upgrade/, /```\s*$/m),
	},
	{
		name: 'release compose header',
		text: () => section(read('scripts/gen-release-compose.sh'), /apply it manually/, /^EOF$/m),
	},
];

describe('manual update recipes', () => {
	it.each(RECIPES)('$name deploys the functions before recreating containers', ({ text }) => {
		const recipe = text();
		const deployAt = recipe.indexOf(DEPLOY);
		const recreateAt = recipe.search(RECREATE);
		expect(deployAt, 'no convex-deploy step').toBeGreaterThanOrEqual(0);
		expect(recreateAt, 'no `docker compose up -d` step').toBeGreaterThanOrEqual(0);
		expect(deployAt).toBeLessThan(recreateAt);
	});
});
