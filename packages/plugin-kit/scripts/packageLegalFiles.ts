import { copyFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_LEGAL_FILES = ['LICENSE', 'NOTICE'] as const;

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '../..');

export function stagePackageLegalFiles(): void {
	for (const file of PACKAGE_LEGAL_FILES) {
		copyFileSync(join(repositoryRoot, file), join(packageRoot, file));
	}
}

export function cleanPackageLegalFiles(): void {
	for (const file of PACKAGE_LEGAL_FILES) {
		rmSync(join(packageRoot, file), { force: true });
	}
}

if (import.meta.main) {
	const action = process.argv[2];
	if (action === 'stage') stagePackageLegalFiles();
	else if (action === 'clean') cleanPackageLegalFiles();
	else throw new Error('Expected package legal-file action to be "stage" or "clean"');
}
