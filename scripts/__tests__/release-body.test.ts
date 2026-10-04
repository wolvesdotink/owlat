/**
 * release.yml builds the GitHub Release body with scripts/release-body.ts. The
 * in-app update card renders the same body, so the order matters: the curated
 * CHANGELOG section first, the update instructions after it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildReleaseBody, changelogSection, previousVersion } from '../release-body';

const CHANGELOG = `# Changelog

## [Unreleased]

<!-- Add released versions below this line, newest first. -->

## [0.6.9] - 2026-10-04

A fix release.

### Fixed

- **Mandrill webhooks.** Filtered by subaccount. (#1248)

## [0.6.8] - 2026-10-03

A feature release.
`;

const REPO = 'wolvesdotink/owlat';

describe('changelogSection', () => {
	it('returns the section body without its heading', () => {
		expect(changelogSection(CHANGELOG, '0.6.9')).toBe(
			'A fix release.\n\n### Fixed\n\n- **Mandrill webhooks.** Filtered by subaccount. (#1248)'
		);
	});

	it('returns the last section up to the end of the file', () => {
		expect(changelogSection(CHANGELOG, '0.6.8')).toBe('A feature release.');
	});

	it('does not match a version that only shares a prefix', () => {
		expect(changelogSection(CHANGELOG, '0.6')).toBeNull();
		expect(changelogSection(CHANGELOG, '0.6.10')).toBeNull();
	});
});

describe('buildReleaseBody', () => {
	const body = buildReleaseBody({
		version: '0.6.9',
		changelog: CHANGELOG,
		repo: REPO,
		images: ['web', 'mta'],
	});

	it('puts what changed before how to update', () => {
		expect(body.startsWith('A fix release.')).toBe(true);
		expect(body.indexOf('### Fixed')).toBeLessThan(body.indexOf('## Updating'));
		expect(body).toContain('https://docs.owlat.app/developer/self-hosting-maintenance#updating');
	});

	it('keeps the manual upgrade, verification and image list for the GitHub page', () => {
		expect(body).toContain(
			`curl -fsSL https://github.com/${REPO}/releases/download/v0.6.9/docker-compose-0.6.9.yml -o docker-compose.yml`
		);
		expect(body).toContain('cosign verify ghcr.io/wolvesdotink/web:0.6.9');
		expect(body).toContain('**Images:** `web`, `mta` — all `ghcr.io/wolvesdotink/<name>:0.6.9`');
	});

	it('links the compare view against the previous release', () => {
		expect(previousVersion(CHANGELOG, '0.6.9')).toBe('0.6.8');
		expect(body).toContain(`https://github.com/${REPO}/compare/v0.6.8...v0.6.9`);
	});

	it('fails for a version the changelog does not cover', () => {
		expect(() =>
			buildReleaseBody({ version: '0.7.0', changelog: CHANGELOG, repo: REPO, images: [] })
		).toThrow('CHANGELOG.md has no section for 0.7.0');
	});

	it('lists every image in docker/images.json by default', () => {
		const manifest = JSON.parse(
			readFileSync(join(import.meta.dirname, '../../docker/images.json'), 'utf8')
		) as { name: string }[];
		const real = buildReleaseBody({ version: '0.6.9', changelog: CHANGELOG, repo: REPO });
		const line = real.split('\n').find((l) => l.startsWith('**Images:**'))!;
		expect([...line.split(' — ')[0]!.matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1])).toEqual(
			manifest.map((image) => image.name)
		);
	});
});
