/**
 * `bun run capture`: before/after screenshots of the real app, for a PR that
 * changes the UI.
 *
 *   bun run capture <label> --surface <name>[,<name>...] [--path /route [steps] ...]
 *       [--out <dir>] [--theme light|dark] [--viewport 1440x900] [--full-page]
 *       [--locale en|de] [--as owner|admin|member | --signed-out]
 *       [--url http://localhost:3000] [--force]
 *   bun run capture --list
 *
 * Runs against this checkout's `bun run dev:stack` (started and seeded first),
 * signs in as a seeded account through the login form (or not at all), and
 * writes `<label>-<shot>.png` into a directory outside the checkout (default
 * ~/.cache/owlat-captures/<checkout>). The first run in a directory records the
 * theme, viewport, language, account and app clock in capture.json, plus the
 * steps of each `--path` shot; later runs reuse them, so a "before" and an
 * "after" differ only by the change. Nothing is written unless every shot was
 * captured. docs/operations/development.md is the runbook.
 */

import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shootAll } from './browser';
import {
	captureCredentials,
	CaptureUsageError,
	parseCaptureArgs,
	resolveAppUrl,
	resolveOutputDir,
} from './options';
import { runCapture } from './pipeline';
import { CaptureFailure, SURFACE_NAMES, SURFACES } from './surfaces';

const root = realpathSync(fileURLToPath(new URL('../../../../', import.meta.url)));

const USAGE = `Usage: bun run capture <label> --surface <name>[,<name>...] [--path /route [steps] ...]
    [--out <dir>] [--theme light|dark] [--viewport WIDTHxHEIGHT] [--full-page]
    [--locale en|de] [--as owner|admin|member | --signed-out]
    [--url http://localhost:<port>] [--force]
  bun run capture --list`;

const HELP = `Shots:
  --surface <name>      a named surface (below); English and signed in only
  --path /route         any app route, captured as path-<route>

Steps, applied in order to the --path before them, before the shot:
  --name <name>         call the shot path-<name> (two shots of one route)
  --click <selector>    click an element
  --fill <selector>=<value>
                        type a value into a field
  --press <key>         press a key (Escape, Enter, Control+K)
  --wait-for <selector> wait until an element is visible
  A selector is a Playwright selector: role=button[name="New campaign"] finds a
  control by role and its whole accessible name, name=/campaign/i by part of
  it, and "#card >> role=button[name=Save]" looks inside an element; CSS
  works too. It must match exactly one element.

Pair settings, recorded by the first run in the directory and reused after:
  --theme light|dark    default light
  --viewport WxH        default 1440x900
  --full-page           the whole page, not the viewport
  --locale en|de        the app's language, default en
  --as owner|admin|member
                        the seeded account to sign in as, default owner
  --signed-out          do not sign in (the login page, a signup link)

Other:
  --out <dir>           outside the checkout; default ~/.cache/owlat-captures/<checkout>
  --url <url>           a local app other than this checkout's dev:stack
  --force               replace this label's existing PNGs
  --list                list the surfaces`;

function describeSurfaces(): string {
	const width = Math.max(...SURFACE_NAMES.map((name) => name.length));
	return SURFACES.map((surface) => {
		const changes = surface.changes ? ` Changes: ${surface.changes}.` : '';
		return `  ${surface.name.padEnd(width)}  ${surface.description}${changes}`;
	}).join('\n');
}

async function reachable(url: string): Promise<boolean> {
	try {
		await fetch(url, { signal: AbortSignal.timeout(10_000) });
		return true;
	} catch {
		return false;
	}
}

async function main(argv: string[]): Promise<number> {
	const request = parseCaptureArgs(argv);
	if (request.help) {
		console.info(`${USAGE}\n\n${HELP}\n\nSurfaces:\n${describeSurfaces()}`);
		return 0;
	}
	if (request.list) {
		console.info(describeSurfaces());
		return 0;
	}
	const linkedWorktree =
		lstatSync(join(root, '.git'), { throwIfNoEntry: false })?.isFile() ?? false;
	const appUrl = resolveAppUrl(request.url, root, linkedWorktree, process.env);
	const outDir = resolveOutputDir(request.out, root, process.cwd(), process.env);
	if (!(await reachable(appUrl))) {
		throw new CaptureFailure(
			`Nothing answers at ${appUrl}. Start the stack first (\`bun run dev:stack\`), with the ` +
				'same OWLAT_PORT_OFFSET, or pass --url.'
		);
	}
	const result = await runCapture(
		request,
		outDir,
		SURFACE_NAMES,
		(shots, manifest) =>
			shootAll(appUrl, captureCredentials(process.env, manifest.account), shots, manifest, (line) =>
				console.info(line)
			),
		{
			exists: existsSync,
			readText: (file) => readFileSync(file, 'utf8'),
			writeAll: (dir, files) => {
				mkdirSync(dir, { recursive: true });
				for (const { file, data } of files) writeFileSync(file, data);
			},
			now: () => new Date(),
		}
	);
	const { manifest } = result;
	console.info(
		`\n${result.manifestCreated ? 'Recorded' : 'Reused'} the pair's settings: ${manifest.theme}, ` +
			`${manifest.viewport.width}x${manifest.viewport.height}${manifest.fullPage ? ' full page' : ''}, ` +
			`${manifest.locale}, ${manifest.account}, clock ${manifest.clock} ` +
			`(${join(outDir, 'capture.json')}).`
	);
	for (const file of result.files) console.info(`  ${file}`);
	return 0;
}

try {
	process.exitCode = await main(process.argv.slice(2));
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`\n✗ ${message}`);
	if (error instanceof CaptureUsageError) console.error(`\n${USAGE}`);
	process.exitCode = error instanceof CaptureUsageError ? 2 : 1;
}
