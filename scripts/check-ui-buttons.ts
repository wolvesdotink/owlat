import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const workspace = join(import.meta.dirname, '..');
const root = join(workspace, 'apps', 'web', 'app');

async function vueFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map((entry) => {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) return vueFiles(path);
			return entry.name.endsWith('.vue') ? [path] : [];
		})
	);
	return nested.flat();
}

const violations: string[] = [];
for (const file of await vueFiles(root)) {
	const lines = (await readFile(file, 'utf8')).split('\n');
	lines.forEach((line, index) => {
		if (/class="[^"]*(?:^|\s)btn(?:\s|$)/.test(line)) {
			violations.push(`${relative(workspace, file)}:${index + 1}`);
		}
	});
}

if (violations.length > 0) {
	console.error('Use <UiButton> instead of raw .btn classes:');
	console.error(violations.join('\n'));
	process.exit(1);
}
