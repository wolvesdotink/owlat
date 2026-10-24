/**
 * Kill-the-process tests for sending (MTA) and sync (mail-sync).
 *
 *   bun scripts/kill-tests/run.ts [--no-build] [--keep] [--only=mta|mail-sync]
 *
 * Builds the current tree's MTA and mail-sync images, starts them in a
 * throwaway Compose project (compose.yml) against a scripted world, SIGKILLs
 * each one in the middle of its work, starts it again and checks the outcome
 * (oracle.ts). Exits non-zero with the reasons, and the services' logs, when a
 * scenario fails. Needs Docker with Compose v2 and openssl.
 *
 *   --no-build  reuse images already built by an earlier run
 *   --keep      leave the stack running afterwards for inspection
 */

import { runBackfillScenario } from './backfillScenario';
import { runMtaScenario } from './mtaScenario';
import { KillStack } from './stack';

const SCENARIOS = {
	'mail-sync': { services: ['mail-sync', 'world', 'imap'], run: runBackfillScenario },
	mta: { services: ['mta', 'world'], run: runMtaScenario },
} as const;
type ScenarioName = keyof typeof SCENARIOS;

function parseArgs(argv: readonly string[]) {
	const only = argv.find((arg) => arg.startsWith('--only='))?.slice('--only='.length);
	if (only !== undefined && !(only in SCENARIOS)) {
		throw new Error(`--only must be one of ${Object.keys(SCENARIOS).join(', ')}`);
	}
	return {
		build: !argv.includes('--no-build'),
		keep: argv.includes('--keep'),
		scenarios: (only ? [only] : Object.keys(SCENARIOS)) as ScenarioName[],
	};
}

async function main(): Promise<number> {
	const options = parseArgs(process.argv.slice(2));
	const stack = new KillStack();
	const log = (line: string) => console.info(`[kill-tests] ${line}`);
	let failed = false;
	try {
		log(`project ${stack.project}`);
		if (options.build) stack.compose(['build', 'mta', 'mail-sync'], { inherit: true });
		stack.compose(['up', '-d', '--no-build', '--wait', 'redis', 'world', 'imap', 'mta']);
		for (const name of options.scenarios) {
			log(`scenario ${name}`);
			let failures: string[];
			try {
				failures = await SCENARIOS[name].run(stack, log);
			} catch (error) {
				failures = [error instanceof Error ? error.message : String(error)];
			}
			if (failures.length === 0) {
				log(`scenario ${name}: passed`);
				continue;
			}
			failed = true;
			console.error(`[kill-tests] scenario ${name}: FAILED`);
			for (const failure of failures) console.error(`  - ${failure}`);
			console.error(stack.logs(SCENARIOS[name].services));
		}
	} finally {
		if (options.keep) log(`left running: docker compose -p ${stack.project} ...`);
		else stack.down();
	}
	return failed ? 1 : 0;
}

process.exit(await main());
