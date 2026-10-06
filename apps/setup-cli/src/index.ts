#!/usr/bin/env bun
/* eslint-disable no-console */
/**
 * Owlat Setup CLI — entry point.
 *
 * Subcommands:
 *   setup    Run the first-run wizard (interactive TUI or launches the web UI).
 *   config   Alias of `setup` for re-opening the wizard on an existing install.
 *   feature  Toggle a single feature flag (e.g., `owlat-setup feature ai on`).
 *   env      Set a single env var (e.g., `owlat-setup env LLM_API_KEY sk-...`),
 *            or `owlat-setup env --show` to list the vars the current flags need.
 *   doctor   Diagnose a broken install (port checks, .env sanity, container health).
 *   push-env Push the Convex function-runtime keys from .env to the deployment
 *            (the second half of `owlat apply`).
 *   unset-env
 *            Clear Convex function-runtime keys from the deployment and .env
 *            (push-env never deletes one).
 */

import { runSetup } from './commands/setup';
import { runFeature } from './commands/feature';
import { runPack } from './commands/pack';
import { runEnv } from './commands/env';
import { runPushEnv } from './commands/pushEnv';
import { runUnsetEnv } from './commands/unsetEnv';
import { runDoctor } from './commands/doctor';
import { runQuickstart } from './commands/quickstart';
import { runBootstrapOrg } from './commands/bootstrap-org';
import { runSeed } from './commands/seed';
import { runSampleData } from './commands/sampleData';
import { runReset } from './commands/reset';
import { cliOptionsFromArgv } from './lib/argv';

const VERSION = '0.6.10'; // x-release-version (kept in sync by scripts/release.ts)

function help(): void {
	console.log(`Owlat Setup CLI v${VERSION}

Usage:
  owlat-setup <command> [options]

Commands:
  quickstart         End-to-end: setup wizard + docker up + bootstrap + seed.
  setup              First-run config wizard (writes .env + compose override).
  config             Re-open the wizard for an existing install.
  bootstrap-org      Create the first admin user + singleton org.
  sample-data <install|remove|status>
                     Opt-in demo content for a real install, and its exact
                     removal. Works without OWLAT_DEV_MODE.
  seed [--reset]     Dev-only full demo seed (needs OWLAT_DEV_MODE; also
                     creates the dummy teammate sign-ins).
  reset              Wipe instance back to blank (for testing signup flow).
  feature <key> <on|off>
                     Toggle a single feature flag.
  pack <key> <on|off>
                     Toggle every flag in a feature pack
                     (emailClient | marketing | ai).
  env <KEY> <VALUE>  Set a single environment variable.
  env --show         List the env vars the current flag state needs (secrets masked).
  push-env           Push the Convex function-runtime keys from .env to the
                     deployment (run by \`owlat apply\`; needs the Docker socket).
  unset-env <KEY> [KEY...]
                     Clear Convex function-runtime keys from the deployment and
                     .env (push-env never deletes one; needs the Docker socket).
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

An option that takes a value also accepts the --option=value form.
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

	const opts = cliOptionsFromArgv(rest);

	try {
		switch (command) {
			case 'quickstart':
				return await runQuickstart(opts);
			case 'setup':
			case 'config':
				return await runSetup(opts);
			case 'bootstrap-org':
				return await runBootstrapOrg(opts);
			case 'seed':
				return await runSeed(opts);
			case 'sample-data':
				return await runSampleData(opts);
			case 'reset':
				return await runReset(opts);
			case 'feature':
				return await runFeature(opts);
			case 'pack':
				return await runPack(opts);
			case 'env':
				return await runEnv(opts);
			case 'push-env':
				return await runPushEnv(opts);
			case 'unset-env':
				return await runUnsetEnv(opts);
			case 'doctor':
				return await runDoctor(opts);
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

main().then((code) => process.exit(code));
