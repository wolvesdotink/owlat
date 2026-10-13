import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { github, githubPages, repository } from './github';
import { aliasReleases, composeDigests, publishedDigests, type PublishedRelease } from './aliases';
const repo = repository(),
	owner = repo.split('/')[0]!.toLowerCase();
// Caller holds the single repository promotion lock. Every invocation selects
// current published state, so replacing a pending invocation cannot roll back
// aliases or lose a release. Only unified stable releases claim these aliases.
const releases = githubPages<PublishedRelease & { assets: { name: string }[] }>(
	`repos/${repo}/releases?per_page=100`
);
for (const { release, aliases } of aliasReleases(
	releases.filter((release) =>
		release.assets.some((asset) => asset.name === `image-digests-${release.tag_name.slice(1)}.txt`)
	)
)) {
	const version = release.tag_name.slice(1),
		directory = mkdtempSync(join(tmpdir(), 'owlat-aliases-'));
	try {
		const manifest = github<{ content: string }>(
			`repos/${repo}/contents/docker/images.json?ref=${release.tag_name}`
		);
		const images = JSON.parse(Buffer.from(manifest.content, 'base64').toString()) as {
			name: string;
		}[];
		const names = images.map((image) => image.name);
		if (
			!names.length ||
			names.some((name) => !/^[a-z0-9][a-z0-9-]*$/.test(name)) ||
			new Set(names).size !== names.length
		)
			throw new Error('Invalid published image manifest');
		for (const pattern of [`docker-compose-${version}.yml*`, `image-digests-${version}.txt*`])
			execFileSync(
				'gh',
				[
					'release',
					'download',
					release.tag_name,
					'--repo',
					repo,
					'--pattern',
					pattern,
					'--dir',
					directory,
				],
				{ stdio: 'pipe' }
			);
		const digests = publishedDigests(
			readFileSync(join(directory, `image-digests-${version}.txt`), 'utf8'),
			readFileSync(join(directory, `image-digests-${version}.txt.sha256`), 'utf8'),
			names
		);
		const composed = composeDigests(
			readFileSync(join(directory, `docker-compose-${version}.yml`), 'utf8'),
			readFileSync(join(directory, `docker-compose-${version}.yml.sha256`), 'utf8'),
			version,
			owner,
			images
				.filter((image) => (image as { rootCompose?: string }).rootCompose === 'ghcr')
				.map((image) => image.name)
		);
		for (const image of composed)
			if (digests.find((item) => item.name === image.name)?.digest !== image.digest)
				throw new Error('Compose and published digest manifest disagree');
		for (const { name, digest } of digests)
			for (const alias of aliases) {
				const image = `ghcr.io/${owner}/${name}`;
				// A missing/private manifest is a failure, not permission to promote it.
				const versionDigest = execFileSync(
					'docker',
					[
						'buildx',
						'imagetools',
						'inspect',
						`${image}:${version}`,
						'--format',
						'{{.Manifest.Digest}}',
					],
					{ encoding: 'utf8' }
				).trim();
				if (versionDigest !== digest) throw new Error(`Published version digest changed: ${name}`);
				execFileSync(
					'docker',
					['buildx', 'imagetools', 'create', '--tag', `${image}:${alias}`, `${image}@${digest}`],
					{ stdio: 'inherit' }
				);
				const aliasDigest = execFileSync(
					'docker',
					[
						'buildx',
						'imagetools',
						'inspect',
						`${image}:${alias}`,
						'--format',
						'{{.Manifest.Digest}}',
					],
					{ encoding: 'utf8' }
				).trim();
				if (aliasDigest !== digest)
					throw new Error(`Promoted alias digest mismatch: ${name}:${alias}`);
			}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
