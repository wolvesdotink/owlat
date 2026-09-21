/**
 * Generator for the shared-production-export ratchet: lists every public
 * runtime export of @owlat/shared that has no production consumer, one
 * `export:<file>:<name>` per line on stdout. The regular Knip pass includes
 * tests, so a test can make a public helper look live; this source walk
 * deliberately excludes tests, comments, type-only imports and package
 * re-export barrels.
 *
 * scripts/check-shared-production-exports.sh feeds this into scripts/ratchet.sh,
 * which owns the comparison against
 * scripts/shared-production-export-baseline.txt.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const repoRoot = join(import.meta.dirname, '..');
const sharedRoot = join(repoRoot, 'packages', 'shared', 'src');
const skippedDirectories = new Set([
	'.git',
	'.nuxt',
	'.output',
	'__tests__',
	'_generated',
	'build',
	'coverage',
	'dist',
	'node_modules',
]);

function sourceFiles(directory: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const full = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (skippedDirectories.has(entry.name) || entry.name.startsWith('.')) continue;
			found.push(...sourceFiles(full));
			continue;
		}
		if (!/\.(?:m?[jt]s|tsx|vue)$/.test(entry.name)) continue;
		if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) continue;
		found.push(full);
	}
	return found;
}

function stripNonRuntimeReferences(source: string): string {
	return source
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/\/\/.*$/gm, '')
		.replace(/\bimport\s+type\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?/g, '')
		.replace(/\bexport\s*\{[\s\S]*?\}\s*from\s*['"][^'"]+['"];?/g, '');
}

const productionSources = sourceFiles(repoRoot).map((file) => ({
	file,
	source: stripNonRuntimeReferences(readFileSync(file, 'utf8')),
}));

const declaration =
	/\bexport\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function|class|enum)\s+([A-Za-z_$][\w$]*)/g;

const unreached: string[] = [];
for (const file of sourceFiles(sharedRoot)) {
	const source = stripNonRuntimeReferences(readFileSync(file, 'utf8'));
	for (const match of source.matchAll(declaration)) {
		const name = match[1];
		if (name === undefined) continue;
		const reference = new RegExp(`\\b${name}\\b`);
		const reached = productionSources.some(
			(candidate) => candidate.file !== file && reference.test(candidate.source)
		);
		if (!reached) {
			unreached.push(`export:${relative(repoRoot, file).split('\\\\').join('/')}:${name}`);
		}
	}
}

for (const entry of [...new Set(unreached)].sort()) console.log(entry);
