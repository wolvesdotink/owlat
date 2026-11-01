/**
 * The desktop smoke harness's fixture upstream and release naming
 * (scripts/desktop-smoke/fixtureServer.ts, release.ts). The upstream is
 * driven with the same `ConvexHttpClient` the web server's update route uses,
 * so a protocol drift fails here rather than in the packaged run.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { afterEach, describe, expect, it } from 'vitest';
import {
	MANIFEST_QUERY,
	startFixtureServer,
	type FixtureServer,
} from '../desktop-smoke/fixtureServer';
import {
	appImageName,
	fixtureManifest,
	nextVersion,
	packageVersion,
	releaseAssetPath,
	repositoryPath,
} from '../desktop-smoke/release';

const root = resolve(import.meta.dirname, '../..');
const cargoToml = readFileSync(join(root, 'apps/desktop/src-tauri/Cargo.toml'), 'utf8');

const servers: FixtureServer[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await server.close();
});

async function fixture(): Promise<FixtureServer> {
	const server = await startFixtureServer();
	servers.push(server);
	return server;
}

const manifestForClient = makeFunctionReference<
	'query',
	{ target: string; arch: string; currentVersion: string },
	{ manifest: string; version: string } | null
>(MANIFEST_QUERY);

describe('fixture upstream', () => {
	it('answers the update route query the way Convex does, and records it', async () => {
		const server = await fixture();
		const client = new ConvexHttpClient(server.origin);
		const args = { target: 'linux', arch: 'x86_64', currentVersion: '0.6.16' };

		expect(await client.query(manifestForClient, args)).toBeNull();

		server.setManifest({ text: '{"version":"0.6.17"}', version: '0.6.17' });
		expect(await client.query(manifestForClient, args)).toEqual({
			manifest: '{"version":"0.6.17"}',
			version: '0.6.17',
		});
		expect(server.queries).toEqual([args, args]);
	});

	it('names a query the Convex backend actually exports', () => {
		const [module, name] = MANIFEST_QUERY.split(':');
		const source = readFileSync(join(root, 'apps/api/convex', `${module}.ts`), 'utf8');
		expect(source).toMatch(new RegExp(`export const ${name} = publicQuery\\(`));
	});

	it('refuses any other query', async () => {
		const server = await fixture();
		const client = new ConvexHttpClient(server.origin);
		const other = makeFunctionReference<'query'>('desktop/updates:somethingElse');
		await expect(client.query(other, {})).rejects.toThrow(/fixture serves only/);
	});

	it('serves release assets byte for byte and 404s the rest', async () => {
		const server = await fixture();
		const bytes = new Uint8Array([1, 2, 3, 250]);
		server.setAsset('/o/r/releases/download/v1.0.1/App.AppImage', bytes);

		const hit = await fetch(`${server.origin}/o/r/releases/download/v1.0.1/App.AppImage`);
		expect(hit.status).toBe(200);
		expect(hit.headers.get('content-length')).toBe('4');
		expect(new Uint8Array(await hit.arrayBuffer())).toEqual(bytes);

		const miss = await fetch(`${server.origin}/o/r/releases/download/v1.0.0/App.AppImage`);
		expect(miss.status).toBe(404);
		expect(server.downloads).toEqual(['/o/r/releases/download/v1.0.1/App.AppImage']);
	});
});

describe('release naming', () => {
	it('reads the version and repository the Rust updater vets bundle URLs against', () => {
		const desktopPackage = JSON.parse(
			readFileSync(join(root, 'apps/desktop/package.json'), 'utf8')
		) as { version: string };
		expect(packageVersion(cargoToml)).toBe(desktopPackage.version);
		expect(repositoryPath(cargoToml)).toBe('/wolvesdotink/owlat');
	});

	it('takes the dependency versions for what they are, not the package version', () => {
		const toml =
			'[package]\nname = "x"\nversion = "1.2.3"\n\n[dependencies]\nserde = { version = "1" }\n';
		expect(packageVersion(toml)).toBe('1.2.3');
		expect(() => packageVersion('[package]\nname = "x"\n')).toThrow(/no \[package\] version/);
	});

	it('follows a release with the next patch, a pre-release with its core', () => {
		expect(nextVersion('0.6.16')).toBe('0.6.17');
		expect(nextVersion('0.7.0-rc.1')).toBe('0.7.1');
		expect(() => nextVersion('v1')).toThrow(/not a semver version/);
	});

	it('lays assets out as GitHub release downloads under a v<version> tag', () => {
		const name = appImageName('Owlat', '0.6.17');
		expect(name).toBe('Owlat_0.6.17_amd64.AppImage');
		expect(releaseAssetPath('/wolvesdotink/owlat', '0.6.17', name)).toBe(
			'/wolvesdotink/owlat/releases/download/v0.6.17/Owlat_0.6.17_amd64.AppImage'
		);
	});

	it('builds a static manifest with both Linux keys the updater looks up', () => {
		const manifest = JSON.parse(
			fixtureManifest({ version: '0.6.17', url: 'http://127.0.0.1:1/a', signature: 'sig' })
		) as { version: string; platforms: Record<string, unknown> };
		expect(manifest.version).toBe('0.6.17');
		expect(manifest.platforms).toEqual({
			'linux-x86_64': { url: 'http://127.0.0.1:1/a', signature: 'sig' },
			'linux-x86_64-appimage': { url: 'http://127.0.0.1:1/a', signature: 'sig' },
		});
	});
});
