import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { SERVICE_WORKER_URL } from '~/utils/offlineShell';

/**
 * Wiring guard for the offline app shell (plan idea 49).
 *
 * The service worker is the one part of this app that a unit test cannot prove
 * by running it: whether it SHIPS at all is decided by nuxt.config, whether the
 * browser will run it is decided by the CSP, and whether the desktop bundle
 * stays clean is decided by an `OWLAT_DESKTOP` branch — three build-time facts,
 * each of which fails silently (a 404 for /sw.js, a blocked registration, a
 * dead file inside the Tauri app) and none of which any other test would catch.
 * So they are pinned here, the way the SPA splash and the web manifest are.
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '..', '..');

const nuxtConfig = readFileSync(resolve(webRoot, 'nuxt.config.ts'), 'utf8');
const workerPath = resolve(webRoot, 'service-worker', 'sw.js');
const worker = readFileSync(workerPath, 'utf8');
const plugin = readFileSync(resolve(webRoot, 'app', 'plugins', 'service-worker.client.ts'), 'utf8');

describe('offline app shell wiring', () => {
	it('serves the worker from the app root, where its scope can cover every route', () => {
		expect(existsSync(workerPath)).toBe(true);
		// A worker at /sw.js controls '/' — deeper, and it could only ever answer
		// navigations under its own directory.
		expect(SERVICE_WORKER_URL).toBe('/sw.js');
		expect(plugin).toContain('SERVICE_WORKER_URL');
	});

	it('is shipped through nitro.publicAssets, and NOT out of public/', () => {
		// Living outside public/ is what makes the desktop exclusion a one-liner:
		// public/ is copied unconditionally, an extra publicAssets dir is not.
		expect(existsSync(resolve(webRoot, 'public', 'sw.js'))).toBe(false);
		expect(nuxtConfig).toContain("fileURLToPath(new URL('./service-worker', import.meta.url))");
		expect(nuxtConfig).toMatch(/publicAssets:\s*\n?\s*process\.env\['OWLAT_DESKTOP'\] === 'true'/);
	});

	it('keeps the worker out of the desktop static bundle', () => {
		// `generate:desktop` output is embedded in the Tauri app, which serves from
		// a custom scheme where a service worker has no business existing.
		// The client plugin refuses to register there.
		expect(plugin).toContain('isDesktopBuild');
	});

	it('allows the worker in the CSP instead of relying on a fallback', () => {
		expect(nuxtConfig).toContain("'worker-src': [\"'self'\"]");
	});

	it('exposes the kill switch as public runtime config', () => {
		expect(nuxtConfig).toContain(
			"offlineShell: process.env['NUXT_PUBLIC_OFFLINE_SHELL'] !== 'false'"
		);
		// Documented where an operator would look for it.
		const envExample = readFileSync(resolve(webRoot, '..', '..', '.env.example'), 'utf8');
		expect(envExample).toContain('NUXT_PUBLIC_OFFLINE_SHELL');
	});

	it('is a classic script: no imports, nothing a bundler has to touch', () => {
		// It is served verbatim, so an `import` would fail at registration time
		// (module workers are not what `register()` is called with here).
		expect(worker).not.toMatch(/^\s*import\s/m);
		expect(worker).not.toMatch(/^\s*export\s/m);
	});

	it('caches nothing that could hold mail or a session', () => {
		// The routing table itself is unit-tested in offlineShellWorker.test.ts.
		expect(worker).not.toMatch(/indexedDB|localStorage|document\.cookie/);
	});
});
