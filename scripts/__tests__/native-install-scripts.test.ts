/**
 * `bun install` must not run a native build for better-sqlite3 (#1450).
 *
 * better-sqlite3 13 ships N-API prebuilds for every platform CI and the docs
 * image use, and sets `"gypfile": false`. bun ignores that flag: once the
 * package is in `trustedDependencies` it runs the implicit `node-gyp rebuild`
 * for its `binding.gyp`, which downloads the Node headers from nodejs.org and
 * then compiles nothing, because binding.gyp finds the prebuild. Every CI job
 * paid for that download, and a cut-off download failed the install. The two
 * nested better-sqlite3 12 copies (optional peers of better-auth and
 * @nuxt/content that bun installs anyway) are never loaded: @nuxt/content
 * reaches SQLite through db0's connector, which resolves the root copy.
 *
 * So better-sqlite3 stays out of the trust list. If a future major stops
 * shipping prebuilds, the prebuild assertions below fail first, and the build
 * has to come back together with a way to provision the headers.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Platforms that install the docs workspace: CI runners and the docs image. */
const PREBUILD_TARGETS = ['linux-x64', 'linuxmusl-x64', 'win32-x64', 'darwin-arm64'];

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function readLock(): { trustedDependencies?: string[]; packages: Record<string, [string]> } {
	const text = readFileSync(join(REPOSITORY_ROOT, 'bun.lock'), 'utf8');
	// bun.lock is JSON with trailing commas.
	return JSON.parse(text.replace(/,(\s*[}\]])/g, '$1'));
}

describe('install lifecycle scripts', () => {
	const rootPackage = readJson<{ trustedDependencies?: string[] }>(
		join(REPOSITORY_ROOT, 'package.json')
	);
	const lock = readLock();

	it('keeps the package.json and bun.lock trust lists in step', () => {
		expect([...(lock.trustedDependencies ?? [])].sort()).toEqual(
			[...(rootPackage.trustedDependencies ?? [])].sort()
		);
	});

	it('does not trust better-sqlite3, so bun never runs node-gyp for it', () => {
		expect(rootPackage.trustedDependencies ?? []).not.toContain('better-sqlite3');
		expect(lock.trustedDependencies ?? []).not.toContain('better-sqlite3');
	});

	it('resolves a root better-sqlite3 that ships prebuilds and opts out of node-gyp', () => {
		const locked = lock.packages['better-sqlite3']?.[0];
		expect(locked).toMatch(/^better-sqlite3@/);

		const manifestPath = join(REPOSITORY_ROOT, 'node_modules/better-sqlite3/package.json');
		const manifest = readJson<{
			version: string;
			gypfile?: boolean;
			scripts?: Record<string, string>;
		}>(manifestPath);
		expect(`better-sqlite3@${manifest.version}`).toBe(locked);
		expect(manifest.gypfile).toBe(false);
		for (const hook of ['preinstall', 'install', 'postinstall']) {
			expect(manifest.scripts?.[hook]).toBeUndefined();
		}
		for (const target of PREBUILD_TARGETS) {
			expect(existsSync(join(dirname(manifestPath), 'prebuilds', `${target}.node`)), target).toBe(
				true
			);
		}
	});

	it("loads the copy db0's connector uses from its prebuild", () => {
		// @nuxt/content's default Node connector is `db0/connectors/better-sqlite3`.
		const db0Entry = createRequire(join(REPOSITORY_ROOT, 'apps/docs/package.json')).resolve('db0');
		const fromDb0 = createRequire(db0Entry);
		const entry = fromDb0.resolve('better-sqlite3');
		const packageDir = dirname(dirname(entry));
		expect(packageDir).toBe(join(REPOSITORY_ROOT, 'node_modules/better-sqlite3'));

		const binding = fromDb0(join(packageDir, 'lib/binding.js')) as {
			getPrebuildPath: () => string | null;
		};
		expect(binding.getPrebuildPath()).toMatch(/[\\/]prebuilds[\\/][\w-]+\.node$/);

		const Database = fromDb0('better-sqlite3') as new (filename: string) => {
			prepare: (sql: string) => { get: () => unknown };
			close: () => void;
		};
		const db = new Database(':memory:');
		try {
			expect(db.prepare('select 1 + 1 as two').get()).toEqual({ two: 2 });
		} finally {
			db.close();
		}
	});
});
