/**
 * Write `openapi.json` from the contract, or with `--check` fail when the
 * committed file differs from what the contract generates. The check never
 * writes, so CI can run it on a read-only tree.
 *
 * The output goes through the repository's oxfmt with its config, the same
 * formatter the format gate runs, so a regenerated file is already formatted
 * and the check compares exactly what would be committed.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildOpenApiDocument, serializeOpenApiDocument } from '../src/openapi';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const relativeTarget = 'packages/public-contract/openapi.json';
const target = fileURLToPath(new URL('../openapi.json', import.meta.url));

function formatted(text: string): string {
	const result = spawnSync(
		`${root}node_modules/.bin/oxfmt`,
		['--config', 'oxfmtrc.json', `--stdin-filepath=${relativeTarget}`],
		{ cwd: root, input: text, encoding: 'utf8' }
	);
	if (result.status !== 0 || !result.stdout) {
		throw new Error(`oxfmt failed: ${result.stderr || result.error?.message || 'no output'}`);
	}
	return result.stdout;
}

const generated = formatted(serializeOpenApiDocument(buildOpenApiDocument()));

if (process.argv.includes('--check')) {
	let committed = '';
	try {
		committed = readFileSync(target, 'utf8');
	} catch {
		// A missing file is stale too.
	}
	if (committed !== generated) {
		console.error(
			`${relativeTarget} is out of date with the contract. Run \`bun run --cwd packages/public-contract openapi\` and commit the result.`
		);
		process.exit(1);
	}
	console.info(`${relativeTarget} matches the contract.`);
} else {
	writeFileSync(target, generated);
	console.info(`Wrote ${relativeTarget}`);
}
