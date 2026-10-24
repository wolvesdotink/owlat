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
 * The budget is not raised inside a feature pull request. A feature that
 * crosses it moves something off the boot path instead (a dynamic `import()`,
 * a lazy component, a smaller leaf module). An increase happens only in a
 * pull request of its own that shows the base and head commits, entry
 * measurements from both built with the same toolchain, what grew and why it
 * has to load at boot, the alternatives considered, and the headroom left.
 * Lower the budget when a change shrinks the entry for good, so the room it
 * freed cannot be spent silently. `report-bundle-delta.ts` shows every pull
 * request its delta and headroom against the base commit.
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
 * The entry measured 231.9 KiB when this was set, so it leaves about 18 KiB of
 * headroom. The headroom is deliberate: every icon the app names is bundled
 * into this closure (nuxt.config.ts `icon.clientBundle`, so an offline desktop
 * never fetches one), and every new lazy chunk adds a line to the entry's
 * preload map, so features grow it by a few hundred bytes with nothing turning
 * eager. A budget a kilobyte or two above the measured size turns that drift
 * into a failure in whichever unrelated pull request comes next. Keep at least
 * 12 KiB of room when lowering it.
 */
export const GZIP_BUDGET_KB = 250;

if (import.meta.main) checkEntryBudget(process.argv[2]);

function checkEntryBudget(outputArg: string | undefined): void {
	const { publicDir, entry } = readWebBuild('check-bundle-budget', outputArg);

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
				'import() or defineAsyncComponent, or move what boot needs into a smaller leaf module. ' +
				'Do not raise GZIP_BUDGET_KB in a feature pull request: an increase needs a dedicated pull ' +
				'request with base and head measurements (see the comment in scripts/check-bundle-budget.ts).'
		);
		process.exit(1);
	}

	console.info(
		`\nWithin the ${GZIP_BUDGET_KB} KB gzip budget (${kb(budget - gzTotal)} KB to spare).`
	);
}
