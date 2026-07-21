/**
 * The sandbox entrypoint for the Deliverability Lab seed-test job. The worker's
 * job registry (`BUILTIN_JOB_COMMANDS`) spawns `node <this-file> <payload>`: the
 * untrusted payload is passed as a DISCRETE argv element (never interpolated into
 * a shell string), analyzed by the pure `runSeedTest`, and the result is written
 * to stdout for the worker to capture. A malformed payload exits non-zero with a
 * short reason on stderr so the host records the job as `failed`, never as a
 * silent success.
 *
 * This shim is intentionally tiny and side-effect-light so importing it costs
 * nothing; it only runs its main when executed directly as the process entry.
 */

import { pathToFileURL } from 'node:url';
import { runSeedTest, SeedTestInputError } from './seedTest.js';

export function main(argv: readonly string[]): number {
	const payload = argv[2];
	if (payload === undefined) {
		process.stderr.write('seed-test: missing payload argument\n');
		return 1;
	}
	try {
		process.stdout.write(runSeedTest(payload));
		return 0;
	} catch (error) {
		const message = error instanceof SeedTestInputError ? error.message : 'seed-test failed';
		process.stderr.write(`seed-test: ${message}\n`);
		return 1;
	}
}

// Run only when this module is the process entry (not when imported by a test).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exit(main(process.argv));
}
