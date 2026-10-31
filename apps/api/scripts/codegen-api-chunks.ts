/**
 * Splits `fullApi` in `convex/_generated/api.d.ts` into per-directory chunks
 * (see apiDeclarationChunks.ts for why).
 *
 *   bun scripts/codegen-api-chunks.ts            rewrite the declaration in place
 *   bun scripts/codegen-api-chunks.ts --check    exit 1 when it is not chunked
 *
 * `bun run codegen` runs it after `convex codegen --typecheck disable` (the
 * unsplit map cannot be typechecked) and typechecks the result; after
 * hand-adding a module entry run `bun run codegen:chunks`.
 * `scripts/check-codegen.sh` runs `--check`.
 * An optional path argument replaces the default declaration file.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chunkApiDeclaration } from './apiDeclarationChunks';

const args = process.argv.slice(2);
const isCheck = args.includes('--check');
const file = resolve(
	args.find((arg) => !arg.startsWith('--')) ??
		resolve(import.meta.dirname, '..', 'convex', '_generated', 'api.d.ts')
);

const source = readFileSync(file, 'utf8');
let chunked: string;
try {
	chunked = chunkApiDeclaration(source);
} catch (error) {
	console.error(`FAIL: ${(error as Error).message}`);
	process.exit(1);
}

if (isCheck) {
	if (chunked !== source) {
		console.error(
			'FAIL: _generated/api.d.ts declares fullApi without the per-directory ApiFromModules chunks.'
		);
		console.error('      Run `bun run --cwd apps/api codegen:chunks` and commit the result.');
		process.exit(1);
	}
	console.log('ok:   _generated/api.d.ts declares fullApi in per-directory chunks');
} else if (chunked !== source) {
	writeFileSync(file, chunked);
	console.log(`chunked fullApi in ${file}`);
}
