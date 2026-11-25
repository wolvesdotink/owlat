import { copyFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_LEGAL_FILES = ['LICENSE', 'NOTICE'] as const;

const pluginKitRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(pluginKitRoot, '../..');

/**
 * Copy the repository's LICENSE and NOTICE into a package before it is packed.
 * Run from a `prepack` hook, the package is the working directory, so
 * `@owlat/provider-kit` shares this script with `@owlat/plugin-kit`.
 */
export function stagePackageLegalFiles(packageRoot: string = pluginKitRoot): void {
	for (const file of PACKAGE_LEGAL_FILES) {
		copyFileSync(join(repositoryRoot, file), join(packageRoot, file));
	}
}

export function cleanPackageLegalFiles(packageRoot: string = pluginKitRoot): void {
	for (const file of PACKAGE_LEGAL_FILES) {
		rmSync(join(packageRoot, file), { force: true });
	}
}

if (import.meta.main) {
	// Staging and cleaning in the repository root would delete its own LICENSE
	// and NOTICE, which are the copies every package stages from.
	if (resolve(process.cwd()) === repositoryRoot) {
		throw new Error('Run packageLegalFiles.ts from a package directory, not the repository root');
	}
	const action = process.argv[2];
	if (action === 'stage') stagePackageLegalFiles(process.cwd());
	else if (action === 'clean') cleanPackageLegalFiles(process.cwd());
	else throw new Error('Expected package legal-file action to be "stage" or "clean"');
}
