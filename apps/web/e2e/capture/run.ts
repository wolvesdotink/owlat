/**
 * `bun run capture`: before/after screenshots of the real app, for a PR that
 * changes the UI.
 *
 *   bun run capture <label> --surface <name>[,<name>...] [--path /route ...]
 *       [--out <dir>] [--theme light|dark] [--viewport 1440x900] [--full-page]
 *       [--url http://localhost:3000] [--force]
 *   bun run capture --list
 *
 * Runs against this checkout's `bun run dev:stack` (started and seeded first),
 * signs in as the seeded owner through the login form, and writes
 * `<label>-<shot>.png` into a directory outside the checkout (default
 * ~/.cache/owlat-captures/<checkout>). The first run in a directory records the
 * theme, viewport and app clock in capture.json; later runs reuse them, so a
 * "before" and an "after" differ only by the change. Nothing is written unless
 * every shot was captured. docs/operations/development.md is the runbook.
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
import { captureCredentials, shootAll } from './browser';
import { CaptureUsageError, parseCaptureArgs, resolveAppUrl, resolveOutputDir } from './options';
import { runCapture } from './pipeline';
import { CaptureFailure, SURFACE_NAMES, SURFACES } from './surfaces';

const root = realpathSync(fileURLToPath(new URL('../../../../', import.meta.url)));

const USAGE = `Usage: bun run capture <label> --surface <name>[,<name>...] [--path /route ...]
    [--out <dir>] [--theme light|dark] [--viewport WIDTHxHEIGHT] [--full-page]
    [--url http://localhost:<port>] [--force]
  bun run capture --list`;

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
		console.info(`${USAGE}\n\nSurfaces:\n${describeSurfaces()}`);
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
			shootAll(appUrl, captureCredentials(process.env), shots, manifest, (line) =>
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
			`clock ${manifest.clock} (${join(outDir, 'capture.json')}).`
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
