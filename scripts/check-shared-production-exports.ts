/**
 * Ratchet public runtime exports from @owlat/shared that have no production
 * consumer. The regular Knip pass includes tests, so a test can make a public
 * helper look live. This source walk deliberately excludes tests, comments,
 * type-only imports and package re-export barrels.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const repoRoot = join(import.meta.dirname, '..');
const sharedRoot = join(repoRoot, 'packages', 'shared', 'src');
const baselinePath = join(repoRoot, 'scripts', 'shared-production-export-baseline.txt');

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

const current = [...new Set(unreached)].sort();
if (process.argv.includes('--print-current')) {
	console.log(current.join('\n'));
	process.exit(0);
}

if (!existsSync(baselinePath)) {
	console.error('FAIL: scripts/shared-production-export-baseline.txt is missing.');
	process.exit(1);
}

const baseline = readFileSync(baselinePath, 'utf8')
	.split(/\r?\n/)
	.map((line) => line.trim())
	.filter((line) => line.length > 0 && !line.startsWith('#'))
	.sort();
const baselineSet = new Set(baseline);
const currentSet = new Set(current);
const added = current.filter((entry) => !baselineSet.has(entry));
const stale = baseline.filter((entry) => !currentSet.has(entry));

if (added.length > 0) {
	console.error('FAIL: new @owlat/shared exports have no production caller:\n');
	console.error(added.join('\n'));
	console.error('\nWire them into production, keep them private, or remove them.');
}
if (stale.length > 0) {
	console.error('FAIL: shared production-export baseline entries are now stale:\n');
	console.error(stale.join('\n'));
	console.error('\nDelete these lines so the inventory only moves down.');
}
if (added.length > 0 || stale.length > 0) process.exit(1);

console.log(`ok:   no new test-only shared exports (${baseline.length} baseline entries remain)`);
