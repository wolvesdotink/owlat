#!/usr/bin/env bun
/**
 * Launch smoke test and updater end-to-end run for the packaged Linux app.
 *
 *   bun scripts/desktop-smoke.ts build    --out <dir>
 *       Build the web server, the desktop SPA and two signed fixture AppImages,
 *       N and N+1 (scripts/desktop-smoke/build.ts).
 *   bun scripts/desktop-smoke.ts launch   --fixtures <dir>
 *       N on a fresh profile boots, mounts the welcome page and reports no
 *       renderer error or fatal output.
 *   bun scripts/desktop-smoke.ts update   --fixtures <dir>
 *       Against the built web server's update route: N updates to N+1 and
 *       relaunches into it; a 204 leaves N running; a tampered bundle and a
 *       signature over other bytes are refused and N stays installed.
 *   bun scripts/desktop-smoke.ts liveness <AppImage> [--alive-ms <ms>] [--scratch <dir>]
 *       Any AppImage, release builds included: still running at the deadline
 *       with no fatal output. Its profile goes in --scratch (default: a new
 *       temp directory).
 *
 * The app needs a display and a session bus (the single-instance plugin claims
 * a D-Bus name), so run the launching commands as
 * `xvfb-run -a dbus-run-session -- bun scripts/desktop-smoke.ts ...`. CI:
 * .github/workflows/desktop-ci.yml (package job) and _desktop-build.yml.
 */

import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildFixtures, readFixtures } from './desktop-smoke/build';
import { liveness, smoke, updates, type Outcome } from './desktop-smoke/scenarios';

const root = resolve(import.meta.dirname, '..');
const DEFAULT_ALIVE_MS = 20_000;

function option(args: readonly string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
}

function required(args: readonly string[], name: string): string {
	const value = option(args, name);
	if (!value) usage(`missing ${name}`);
	return value;
}

function usage(problem: string): never {
	console.error(`desktop-smoke: ${problem}\nusage: see the header of scripts/desktop-smoke.ts`);
	process.exit(2);
}

function report(outcomes: readonly Outcome[]): number {
	console.info('');
	for (const { name, problems } of outcomes) {
		console.info(`${problems.length === 0 ? 'PASS' : 'FAIL'}  ${name}`);
		for (const problem of problems) console.info(`      - ${problem}`);
	}
	return outcomes.every((outcome) => outcome.problems.length === 0) ? 0 : 1;
}

/** Scratch space for the runs' profiles and writable AppImage copies. */
function runDir(fixturesDir: string): string {
	const dir = join(fixturesDir, 'runs');
	mkdirSync(dir, { recursive: true });
	return dir;
}

async function main(argv: readonly string[]): Promise<number> {
	const [command, ...args] = argv;
	switch (command) {
		case 'build': {
			const fixtures = buildFixtures(root, required(args, '--out'));
			console.info(`\nbuilt fixtures ${fixtures.from} -> ${fixtures.to}`);
			return 0;
		}
		case 'launch': {
			const dir = resolve(required(args, '--fixtures'));
			return report([await smoke(readFixtures(dir), runDir(dir))]);
		}
		case 'update': {
			const dir = resolve(required(args, '--fixtures'));
			return report(await updates(readFixtures(dir), runDir(dir)));
		}
		case 'liveness': {
			const appImage = args[0];
			if (!appImage || appImage.startsWith('--')) usage('liveness needs an AppImage path');
			const aliveMs = Number(option(args, '--alive-ms') ?? DEFAULT_ALIVE_MS);
			if (!Number.isFinite(aliveMs) || aliveMs <= 0) usage('--alive-ms must be a positive number');
			const scratch =
				option(args, '--scratch') ?? mkdtempSync(join(tmpdir(), 'owlat-desktop-smoke-'));
			mkdirSync(scratch, { recursive: true });
			return report([await liveness(resolve(appImage), scratch, aliveMs)]);
		}
		default:
			usage(`unknown command ${command ?? '(none)'}`);
	}
}

process.exitCode = await main(process.argv.slice(2));
