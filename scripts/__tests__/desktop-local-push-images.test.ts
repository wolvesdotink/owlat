/**
 * The desktop wizard's local-push mode builds the stack on the developer's
 * machine and streams the images to a server too small to build them. Its image
 * list was once written by hand and fell behind docker-compose.yml: the MTA's
 * DNS resolver, ClamAV, IMAP, mail-sync and the code-task auxiliaries were
 * never built, so the server tried to pull `:dev` tags no registry has
 * (issue #956).
 *
 * The wizard now builds exactly COMPOSE_BUILD_SERVICES
 * (packages/shared/src/composeBuildServices.ts). These checks pin that table to
 * the real Compose file and to docker/images.json, so a buildable service added
 * to either fails here until the table lists it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { COMPOSE_BUILD_SERVICES } from '@owlat/shared/composeBuildServices';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (file: string) => readFileSync(join(REPOSITORY_ROOT, file), 'utf8');

interface ComposeService {
	build?: unknown;
	image?: string;
	profiles?: string[];
}

const compose = parse(read('docker-compose.yml')) as { services: Record<string, ComposeService> };
const TAG = ':${OWLAT_VERSION:-dev}';

/** Every service docker-compose.yml can build, in the table's shape. */
const buildable = Object.entries(compose.services)
	.filter(([, service]) => service.build !== undefined)
	.map(([name, service]) => ({
		service: name,
		image: service.image ?? '',
		profiles: [...(service.profiles ?? [])].sort(),
	}));

const manifest = JSON.parse(read('docker/images.json')) as Array<{
	name: string;
	rootCompose: 'ghcr' | 'local' | 'none';
}>;

const byService = (a: { service: string }, b: { service: string }) =>
	a.service.localeCompare(b.service);

describe('COMPOSE_BUILD_SERVICES (the local-push build list)', () => {
	it('lists exactly the services docker-compose.yml builds, with their images and profiles', () => {
		expect(buildable.length).toBeGreaterThan(0);
		for (const service of buildable) {
			// Every first-party image carries the shared version tag, which the
			// local install pins to `dev`.
			expect(service.image, service.service).toMatch(/:\$\{OWLAT_VERSION:-dev\}$/);
		}
		const fromCompose = buildable
			.map((s) => ({ ...s, image: s.image.slice(0, -TAG.length) }))
			.sort(byService);
		const listed = COMPOSE_BUILD_SERVICES.map((s) => ({
			service: s.service,
			image: s.image,
			profiles: [...s.profiles].sort(),
		})).sort(byService);
		expect(listed).toEqual(fromCompose);
	});

	it('covers every image docker/images.json publishes for the stack', () => {
		const images = COMPOSE_BUILD_SERVICES.map((s) => s.image);
		for (const image of manifest.filter((entry) => entry.rootCompose !== 'none')) {
			const expected =
				image.rootCompose === 'local'
					? `owlat-${image.name}`
					: `ghcr.io/wolvesdotink/${image.name}`;
			expect(images, image.name).toContain(expected);
		}
		// The one image no Compose service runs is the setup image, which the
		// wizard builds and pushes on its own (LOCAL_SETUP_IMAGE).
		expect(manifest.filter((entry) => entry.rootCompose === 'none').map((e) => e.name)).toEqual([
			'setup',
		]);
	});
});
