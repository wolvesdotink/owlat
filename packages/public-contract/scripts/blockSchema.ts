/**
 * Write `schemas/blocks.json` from the block types, or with `--check` fail
 * when the committed file differs from what the types generate. The check
 * never writes, so CI can run it on a read-only tree.
 *
 * Like `openapi.ts`, the output goes through the repository's oxfmt with its
 * config, so a regenerated file is already formatted and the check compares
 * exactly what would be committed.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildBlockContentSchema, serializeBlockContentSchema } from './blockSchemaSource';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const relativeTarget = 'packages/public-contract/schemas/blocks.json';
const target = fileURLToPath(new URL('../schemas/blocks.json', import.meta.url));

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

const generated = formatted(serializeBlockContentSchema(buildBlockContentSchema()));

if (process.argv.includes('--check')) {
	let committed = '';
	try {
		committed = readFileSync(target, 'utf8');
	} catch {
		// A missing file is stale too.
	}
	if (committed !== generated) {
		console.error(
			`${relativeTarget} is out of date with the block types. Run \`bun run --cwd packages/public-contract block-schema\` and commit the result.`
		);
		process.exit(1);
	}
	console.info(`${relativeTarget} matches the block types.`);
} else {
	writeFileSync(target, generated);
	console.info(`Wrote ${relativeTarget}`);
}
