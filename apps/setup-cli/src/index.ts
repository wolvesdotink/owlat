#!/usr/bin/env bun
/* eslint-disable no-console */
/**
 * Owlat Setup CLI — entry point.
 *
 * Subcommands:
 *   setup    Run the first-run wizard (interactive TUI or launches the web UI).
 *   config   Re-open the wizard for an existing install (skips already-set fields).
 *   feature  Toggle a single feature flag (e.g., `owlat-setup feature ai on`).
 *   env      Set a single env var (e.g., `owlat-setup env LLM_API_KEY sk-...`),
 *            or `owlat-setup env --show` to list the vars the current flags need.
 *   doctor   Diagnose a broken install (port checks, .env sanity, container health).
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runSetup } from './commands/setup';
import { runConfig } from './commands/config';
import { runFeature } from './commands/feature';
import { runPack } from './commands/pack';
import { runEnv } from './commands/env';
import { runDoctor } from './commands/doctor';
import { runQuickstart } from './commands/quickstart';
import { runBootstrapOrg } from './commands/bootstrap-org';
import { runSeed } from './commands/seed';
import { runReset } from './commands/reset';

const VERSION = '0.3.3'; // x-release-version (kept in sync by scripts/release.ts)

function help(): void {
	console.log(`Owlat Setup CLI v${VERSION}

Usage:
  owlat-setup <command> [options]

Commands:
  quickstart         End-to-end: setup wizard + docker up + bootstrap + seed.
  setup              First-run config wizard (writes .env + compose override).
  config             Re-open the wizard for an existing install.
  bootstrap-org      Create the first admin user + singleton org.
  seed [--reset]     Populate the running instance with realistic demo data.
  reset              Wipe instance back to blank (for testing signup flow).
  feature <key> <on|off>
                     Toggle a single feature flag.
  pack <key> <on|off>
                     Toggle every flag in a feature pack
                     (emailClient | marketing | ai).
  env <KEY> <VALUE>  Set a single environment variable.
  env --show         List the env vars the current flag state needs (secrets masked).
  doctor             Diagnose a broken install.

Options:
  --web              Force web wizard (browser-based).
  --terminal         Force terminal wizard (TUI).
  --config <path>    Pre-seed answers from a config file (non-interactive).
  --assume-yes, -y   Accept all defaults (CI/scripted install).
  --build-local      Build the stack images from this source tree instead of
                     pulling published tags (quickstart; or OWLAT_BUILD_LOCAL=1).
  --local-images     Use pre-loaded dev-tagged images as-is — no pull, no build
                     (quickstart; or OWLAT_LOCAL_IMAGES=1).
  --owlat-dir <dir>  Owlat install directory (default: monorepo root).
  --mode <m>         Quickstart mode: populated | blank | custom.
  --email <e>        Admin email (bootstrap / quickstart).
  --password <p>     Admin password (bootstrap / quickstart).
  --restart          Ignore saved quickstart checkpoints and run every stage.
  --help, -h         Show this help.
  --version          Show version.
`);
}

async function main(): Promise<number> {
	const args = process.argv.slice(2);

	if (args.includes('--help') || args.includes('-h')) {
		help();
		return 0;
	}
	if (args.includes('--version')) {
		console.log(VERSION);
		return 0;
	}

	const [command, ...rest] = args.length === 0 ? ['setup'] : args;

	const flagSet = new Set(rest.filter((a) => a.startsWith('--')));
	// `positional` strips `--*` flags — preserves behavior for the pre-existing
	// `feature/pack/env` commands whose argument shape is `<key> <value>`.
	// `args` carries the full argv tail so new commands (`quickstart`,
	// `bootstrap-org`, `seed`, `reset`) can locate flags like `--email`,
	// `--mode`, `--reset` by scanning the raw list.
	const positional = rest.filter((a) => !a.startsWith('--'));
	const opts = {
		web: flagSet.has('--web'),
		terminal: flagSet.has('--terminal'),
		assumeYes: flagSet.has('--assume-yes') || flagSet.has('-y'),
		// Local-source installs (the desktop dev flow forwards these through
		// scripts/owlat): compose builds images from this tree (buildLocal) or
		// uses pre-pushed dev images as-is (localImages).
		buildLocal: flagSet.has('--build-local') || process.env['OWLAT_BUILD_LOCAL'] === '1',
		localImages: flagSet.has('--local-images') || process.env['OWLAT_LOCAL_IMAGES'] === '1',
		// Release version resolved by install.sh (the `curl | bash` PULL path), so
		// quickstart can pin `OWLAT_VERSION=<semver>` into .env and compose pulls
		// the signed release images. Passed as a flag (not an env var) so it never
		// leaks into the containerized compose interpolation and overrides .env.
		owlatVersion: extractValue(rest, '--owlat-version'),
		owlatDir: extractValue(rest, '--owlat-dir') ?? process.env['OWLAT_DIR'] ?? defaultOwlatDir(),
		configFile: extractValue(rest, '--config'),
		args: rest,
	};

	try {
		switch (command) {
			case 'quickstart':
				return await runQuickstart({ ...opts, positional });
			case 'setup':
				return await runSetup({ ...opts, positional });
			case 'config':
				return await runConfig({ ...opts, positional });
			case 'bootstrap-org':
				return await runBootstrapOrg({ ...opts, positional });
			case 'seed':
				return await runSeed({ ...opts, positional });
			case 'reset':
				return await runReset({ ...opts, positional });
			case 'feature':
				return await runFeature({ ...opts, positional });
			case 'pack':
				return await runPack({ ...opts, positional });
			case 'env':
				return await runEnv({ ...opts, positional });
			case 'doctor':
				return await runDoctor({ ...opts, positional });
			default:
				console.error(`Unknown command: ${command}`);
				help();
				return 1;
		}
	} catch (e) {
		console.error(`\nFatal: ${(e as Error).message}`);
		if (process.env['OWLAT_DEBUG']) console.error((e as Error).stack);
		return 1;
	}
}

function extractValue(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	if (idx === -1) return undefined;
	return args[idx + 1];
}

/**
 * Default owlat directory: walk up from the current working directory looking
 * for a `turbo.json` (monorepo root). Falls back to `/opt/owlat` for the
 * legacy VPS install layout.
 */
function defaultOwlatDir(): string {
	let dir = process.cwd();
	for (let i = 0; i < 12; i++) {
		if (existsSync(join(dir, 'turbo.json'))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return '/opt/owlat';
}

main().then((code) => process.exit(code));
