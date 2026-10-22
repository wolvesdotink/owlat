/**
 * Entry-bundle budget for the built web app.
 *
 * Every page, the sign-in page included, downloads and parses the entry chunk
 * and everything it imports statically before Vue can mount. That closure is
 * what the 2026-09-29 performance audit measured (438 KB gzip at v0.6.4, about
 * 190 KB of it the email builder that only the editors use), and nothing kept
 * it from growing back: one eager import in a plugin or the dashboard layout
 * pulls a whole feature into it and no test notices.
 *
 * This reads a finished `nuxt build` the same way the audit did: the entry file
 * name comes from the Nitro renderer, the walk follows STATIC imports only
 * (`import()` is a lazy chunk and stays out), and every file is gzipped at level
 * 9. The run fails when the closure's gzip total is over GZIP_BUDGET_KB.
 *
 * Lower the budget when a change shrinks the entry for good, so the room it
 * freed cannot be spent silently. Raising it needs a reason in the commit.
 *
 * Pages and lazily loaded features are not budgeted; `report-bundle-closures.ts`
 * reports their closures with the same rules (scripts/bundle-closure.ts).
 *
 * Usage: bun scripts/check-bundle-budget.ts [path/to/.output]
 *   (defaults to apps/web/.output; CI copies the output out of the web image)
 */
import { kb, measure, readWebBuild, staticClosure } from './bundle-closure';

/**
 * Gzip budget for the entry closure, in KiB (1024 bytes).
 *
 * First set from this script's own reading, 230.7 KB, after the boot-path items
 * of the performance plan (1.7, 2.7, A8-A10) landed, plus about 5% headroom
 * (242). Raised on 2026-10-03 the same way, from 241.8 KB plus about 5%: the
 * entry had grown to within 0.2 KB of the old budget as features landed, so
 * the next eager addition would have failed.
 *
 * Raised to 256 on 2026-10-22 from 254.1 KB: every icon the app names is
 * bundled into this closure on purpose (nuxt.config.ts `icon.clientBundle`, so
 * an offline desktop never fetches one), and each new lazy chunk adds an entry
 * to the entry's preload map, so features that add icons or pages grow it by a
 * few hundred bytes with nothing turning eager. 2 KB of headroom covers that
 * drift while a feature imported eagerly (several KB at least) still fails.
 */
const GZIP_BUDGET_KB = 256;

const { publicDir, entry } = readWebBuild('check-bundle-budget', process.argv[2]);

const rows = staticClosure(publicDir, entry)
	.map((file) => measure(publicDir, file))
	.sort((a, b) => b.gz - a.gz);

const rawTotal = rows.reduce((sum, row) => sum + row.raw, 0);
const gzTotal = rows.reduce((sum, row) => sum + row.gz, 0);
const budget = GZIP_BUDGET_KB * 1024;

console.info(
	`Entry ${entry}: ${rows.length} file${rows.length === 1 ? '' : 's'}, ${kb(rawTotal)} KB raw, ${kb(gzTotal)} KB gzip`
);
console.info('Largest files (gzip):');
for (const row of rows.slice(0, 10)) {
	console.info(`  ${kb(row.gz).padStart(7)} KB  ${row.file}`);
}

if (gzTotal > budget) {
	console.error(
		`\nThe entry closure is ${kb(gzTotal)} KB gzip, over the ${GZIP_BUDGET_KB} KB budget ` +
			`by ${kb(gzTotal - budget)} KB.\n` +
			'Something the boot path imports statically grew or became eager. Load it with a dynamic ' +
			'import() or defineAsyncComponent, or raise GZIP_BUDGET_KB in scripts/check-bundle-budget.ts ' +
			'with a reason in the commit.'
	);
	process.exit(1);
}

console.info(
	`\nWithin the ${GZIP_BUDGET_KB} KB gzip budget (${kb(budget - gzTotal)} KB to spare).`
);
