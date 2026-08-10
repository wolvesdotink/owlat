import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspace = join(import.meta.dirname, '../../../..');
const convexRoot = join(workspace, 'apps/api/convex');
const pagesRoot = join(workspace, 'apps/web/app/pages');

async function filesUnder(directory: string, extension: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map((entry) => {
			const path = join(directory, entry.name);
			if (entry.isDirectory() && entry.name !== '_generated' && entry.name !== 'node_modules') {
				return filesUnder(path, extension);
			}
			return entry.isFile() && entry.name.endsWith(extension) ? [path] : [];
		})
	);
	return nested.flat();
}

describe('admin UI/server gating parity', () => {
	it('every Administration page carries the admin deep-link guard', async () => {
		const adminRoot = join(pagesRoot, 'dashboard/admin');
		const missing: string[] = [];
		for (const file of await filesUnder(adminRoot, '.vue')) {
			const source = await readFile(file, 'utf8');
			if (!/middleware:\s*\[[^\]]*['"](?:admin|platform-admin)['"]/.test(source)) {
				missing.push(relative(pagesRoot, file));
			}
		}
		expect(missing).toEqual([]);
	});

	it('pages calling admin/owner Convex functions declare an explicit UI gate', async () => {
		const privilegedReferences: string[] = [];
		for (const file of await filesUnder(convexRoot, '.ts')) {
			const source = await readFile(file, 'utf8');
			const module = relative(convexRoot, file).replace(/\\/g, '/').replace(/\.ts$/, '');
			if (module.includes('/__tests__/')) continue;
			for (const match of source.matchAll(
				/export const (\w+)\s*=\s*(?:adminQuery|adminMutation|ownerMutation)\s*\(/g
			)) {
				privilegedReferences.push(`api.${module.replaceAll('/', '.')}.${match[1]}`);
			}
		}

		const missing: string[] = [];
		for (const file of await filesUnder(pagesRoot, '.vue')) {
			const source = await readFile(file, 'utf8');
			const used = privilegedReferences.filter((reference) => source.includes(reference));
			if (used.length === 0) continue;
			const gated =
				/usePermissions\s*\(/.test(source) ||
				/middleware:\s*\[[^\]]*['"](?:admin|platform-admin)['"]/.test(source) ||
				/middleware:\s*['"]platform-admin['"]/.test(source);
			if (!gated) missing.push(`${relative(pagesRoot, file)}: ${used.join(', ')}`);
		}
		expect(missing).toEqual([]);
	});
});
