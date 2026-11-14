/**
 * Every environment variable the MTA reads must be documented in
 * apps/mta/.env.example. The read set comes from `envReads.ts`, the same scan
 * the compose forwarding test uses.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPOSITORY_ROOT, mtaEnvReads, mtaSourceFiles, undocumentedReads } from './envReads';

const reads = mtaEnvReads(mtaSourceFiles());
const missing = undocumentedReads(
	reads,
	readFileSync(join(REPOSITORY_ROOT, 'apps/mta/.env.example'), 'utf8')
);
if (missing.length > 0) {
	console.error(
		'check-env-example: env vars read by the MTA but missing from apps/mta/.env.example:'
	);
	for (const name of missing) console.error(`    + ${name} (${reads.get(name)!.join(', ')})`);
	process.exit(1);
}
console.log(`ok:   every env var the MTA reads is documented in .env.example (${reads.size} keys)`);
