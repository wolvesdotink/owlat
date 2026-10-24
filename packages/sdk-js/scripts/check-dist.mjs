/**
 * Fail the build when the published bundle reaches a module a consumer would
 * not have. The SDK has no runtime dependencies, and its wire types come from
 * the private @owlat/public-contract workspace package, which the declaration
 * build inlines; a type import that stopped being inlined, or a value import
 * of the contract (which would pull in its schema library), would ship a
 * bundle that cannot be installed. Only relative paths and `node:` builtins
 * may appear as module specifiers.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SPECIFIER =
	/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+|\bexport\s+\*\s+from\s*)['"]([^'"]+)['"]/gm;

/**
 * Module specifiers in `text` that are neither relative nor `node:` builtins.
 * Comments are dropped first: the JSDoc examples name the package itself.
 */
export function externalSpecifiers(text) {
	const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
	const found = new Set();
	for (const match of code.matchAll(SPECIFIER)) {
		const specifier = match[1];
		if (specifier.startsWith('.') || specifier.startsWith('node:')) continue;
		found.add(specifier);
	}
	return [...found].sort();
}

const DIST_FILES = ['index.js', 'index.cjs', 'index.d.ts', 'index.d.cts'];

function main() {
	const dist = new URL('../dist/', import.meta.url);
	const problems = [];
	for (const name of DIST_FILES) {
		const text = readFileSync(new URL(name, dist), 'utf8');
		for (const specifier of externalSpecifiers(text))
			problems.push(`dist/${name} imports ${specifier}`);
	}
	if (problems.length) {
		console.error(
			`The SDK bundle reaches modules its consumers do not have:\n  ${problems.join('\n  ')}`
		);
		process.exit(1);
	}
	console.info(`dist/ reaches no module outside itself (${DIST_FILES.length} files checked).`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
