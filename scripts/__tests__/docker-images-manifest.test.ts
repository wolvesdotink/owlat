/**
 * docker/images.json is the one list of published server images.
 *
 * `_server-build.yml` builds, merges and verifies exactly what it lists,
 * `scripts/check-compose-invariants.sh` reads it to check the root compose
 * pins, and the release workflows print it in the release body. Before the
 * manifest, the same list was copied into each of those places by hand and the
 * copies drifted: the compose gate knew 6 of the 12 images and the release body
 * 9. These checks pin the remaining hand-written places to the manifest, off
 * the real files, so a drift fails the PR that introduces it.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const MANIFEST = 'docker/images.json';
const SERVER_BUILD = '.github/workflows/_server-build.yml';
const ROOT_COMPOSE = 'docker-compose.yml';
const VPS_COMPOSE = 'infra/templates/docker-compose.vps.yml';
const RELEASE_WORKFLOWS = ['.github/workflows/release.yml', '.github/workflows/server-release.yml'];

interface ImageEntry {
	name: string;
	dockerfile: string;
	context: string;
	title: string;
	description: string;
	rootCompose: 'ghcr' | 'local' | 'none';
}

function read(relativePath: string): string {
	return readFileSync(join(REPOSITORY_ROOT, relativePath), 'utf8');
}

const images = JSON.parse(read(MANIFEST)) as ImageEntry[];
const names = images.map((image) => image.name);

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every `ghcr.io/wolvesdotink/<name>` image a compose file references. */
function wolvesdotinkImages(compose: string): string[] {
	const found = new Set<string>();
	for (const match of compose.matchAll(/ghcr\.io\/wolvesdotink\/([a-z0-9-]+)/g)) {
		found.add(match[1]!);
	}
	return [...found].sort();
}

describe('docker/images.json', () => {
	it('lists well-formed entries', () => {
		expect(images.length).toBeGreaterThan(0);
		for (const image of images) {
			expect(Object.keys(image).sort(), image.name).toEqual(
				['context', 'description', 'dockerfile', 'name', 'rootCompose', 'title'].sort()
			);
			// Names flow into image refs, cache scopes, artifact names and paths.
			expect(image.name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
			expect(image.title.trim(), image.name).not.toBe('');
			expect(image.description.trim(), image.name).not.toBe('');
			expect(['ghcr', 'local', 'none']).toContain(image.rootCompose);
		}
	});

	it('has unique names', () => {
		expect(new Set(names).size).toBe(names.length);
	});

	it('points every entry at a Dockerfile and a build context that exist', () => {
		for (const image of images) {
			expect(existsSync(join(REPOSITORY_ROOT, image.dockerfile)), image.dockerfile).toBe(true);
			const context = join(REPOSITORY_ROOT, image.context);
			expect(existsSync(context) && statSync(context).isDirectory(), image.context).toBe(true);
		}
	});

	it('leaves OCI labels to the release workflow, not the Dockerfiles', () => {
		for (const image of images) {
			expect(read(image.dockerfile), image.dockerfile).not.toMatch(
				/^\s*LABEL\s+org\.opencontainers/m
			);
		}
	});
});

describe('_server-build.yml reads the manifest', () => {
	const workflow = read(SERVER_BUILD);

	it('emits the manifest from the resolve job', () => {
		expect(workflow).toContain('images: ${{ steps.images.outputs.images }}');
		expect(workflow).toContain('jq -c . docker/images.json');
	});

	it('drives both matrices from it', () => {
		const matrices = workflow.match(
			/^\s+image: \$\{\{ fromJSON\(needs\.resolve\.outputs\.images\) \}\}$/gm
		);
		expect(matrices).toHaveLength(2);
		// The old shape: a name list plus an include table of dockerfiles.
		expect(workflow).not.toMatch(/^\s+name: \[/m);
		expect(workflow).not.toMatch(/^\s+dockerfile:/m);
		expect(workflow).not.toMatch(/matrix\.name\b/);
	});

	it('iterates it in the anonymous-pull gate, passed through env', () => {
		expect(workflow).toContain('IMAGES: ${{ needs.resolve.outputs.images }}');
		expect(workflow).toContain(`jq -r '.[].name' <<<"$IMAGES"`);
	});

	it('holds no hand-written list of image names', () => {
		const lists = workflow.split('\n').filter((line) => {
			const onLine = names.filter((name) =>
				new RegExp(`(?<![\\w/.-])${escapeRegExp(name)}(?![\\w/.-])`).test(line)
			);
			return onLine.length >= 4;
		});
		expect(lists).toEqual([]);
	});

	it('labels each image with its manifest title and description in both metadata steps', () => {
		const title = 'org.opencontainers.image.title=${{ matrix.image.title }}';
		const description = 'org.opencontainers.image.description=${{ matrix.image.description }}';
		expect(workflow.split(title)).toHaveLength(3);
		expect(workflow.split(description)).toHaveLength(3);
	});
});

describe('compose files agree with the manifest', () => {
	const rootCompose = read(ROOT_COMPOSE);

	it.each([ROOT_COMPOSE, VPS_COMPOSE])('%s references only listed images', (file) => {
		const unlisted = wolvesdotinkImages(read(file)).filter((name) => !names.includes(name));
		expect(unlisted).toEqual([]);
	});

	it('pulls every rootCompose "ghcr" image, and only those, from GHCR in the root compose', () => {
		const expected = images
			.filter((image) => image.rootCompose === 'ghcr')
			.map((image) => image.name)
			.sort();
		expect(wolvesdotinkImages(rootCompose)).toEqual(expected);
	});

	it('builds every rootCompose "local" image locally in the root compose', () => {
		for (const image of images.filter((entry) => entry.rootCompose === 'local')) {
			expect(rootCompose, image.name).toMatch(
				new RegExp(`^\\s+image: owlat-${escapeRegExp(image.name)}:`, 'm')
			);
		}
	});

	it('runs no rootCompose "none" image in the root compose', () => {
		for (const image of images.filter((entry) => entry.rootCompose === 'none')) {
			expect(rootCompose, image.name).not.toMatch(
				new RegExp(`image: *(ghcr\\.io/wolvesdotink/|owlat-)${escapeRegExp(image.name)}:`)
			);
		}
	});
});

describe('release bodies list the manifest images', () => {
	it.each(RELEASE_WORKFLOWS)('%s', (file) => {
		const line = read(file)
			.split('\n')
			.find((candidate) => candidate.includes('**Images:**'));
		expect(line, `no **Images:** line in ${file}`).toBeDefined();
		const listed = [...line!.split(' — ')[0]!.matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1]);
		expect(listed).toEqual(names);
	});
});
