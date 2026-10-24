import { createHash } from 'node:crypto';
import { classifyReleaseTag } from './release-policy';
export interface PublishedRelease {
	tag_name: string;
	draft: boolean;
	prerelease: boolean;
}
export function stableVersion(tag: string): number[] | null {
	const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag);
	if (!match) return null;
	const parts = match.slice(1).map(Number);
	return parts.every(Number.isSafeInteger) ? parts : null;
}
export function aliasReleases<T extends PublishedRelease>(releases: T[]) {
	const sorted = releases
		.filter((r) => !r.draft && !r.prerelease && stableVersion(r.tag_name))
		.sort((a, b) => {
			const av = stableVersion(a.tag_name)!,
				bv = stableVersion(b.tag_name)!;
			return bv[0]! - av[0]! || bv[1]! - av[1]! || bv[2]! - av[2]!;
		});
	const seen = new Set<string>();
	return sorted.flatMap((release, index) => {
		const [major, minor] = stableVersion(release.tag_name)!,
			key = `${major}.${minor}`;
		const aliases = index === 0 ? ['latest'] : [];
		if (!seen.has(key)) {
			seen.add(key);
			aliases.push(key);
		}
		return aliases.length ? [{ release, aliases }] : [];
	});
}
export function composeDigests(
	compose: string,
	checksum: string,
	version: string,
	owner: string,
	names: string[]
) {
	const digest = createHash('sha256').update(compose).digest('hex');
	if (checksum.trim().split(/\s+/)[0] !== digest) throw new Error('Compose checksum mismatch');
	const found = new Map<string, string>();
	for (const match of compose.matchAll(
		/image:\s*["']?(ghcr\.io\/[\w.-]+\/[a-z0-9-]+):([0-9]+\.[0-9]+\.[0-9]+)@(sha256:[a-f0-9]{64})/g
	)) {
		const image = match[1]!,
			name = image.split('/')[2]!;
		if (!image.startsWith(`ghcr.io/${owner}/`)) continue;
		if (match[2] !== version || found.has(name)) throw new Error('Ambiguous compose image version');
		found.set(name, match[3]!);
	}
	for (const name of names)
		if (!found.has(name)) throw new Error(`Missing published digest for ${name}`);
	return names.map((name) => ({ name, digest: found.get(name)! }));
}

/**
 * The highest published stable unified release below `current`, the update
 * flow's starting point. A candidate (`X.Y.Z-rc.N`) or other prerelease starts
 * from the stable release below its base, which is what installs upgrade from.
 */
export function previousRelease<T extends PublishedRelease>(releases: T[], current: string) {
	const parsed = classifyReleaseTag(`v${current}`);
	const version = parsed && stableVersion(`v${parsed.base}`);
	if (!version) throw new Error('Invalid update version');
	return (
		aliasReleases(
			releases.filter((release) => {
				const candidate = stableVersion(release.tag_name);
				if (!candidate) return false;
				for (let i = 0; i < 3; i++) {
					if (candidate[i] !== version[i]) return candidate[i]! < version[i]!;
				}
				return false;
			})
		)[0]?.release.tag_name.slice(1) ?? ''
	);
}
export function publishedDigests(text: string, checksum: string, names: string[]) {
	if (checksum.trim().split(/\s+/)[0] !== createHash('sha256').update(text).digest('hex'))
		throw new Error('Image digest checksum mismatch');
	const found = new Map<string, string>();
	for (const line of text.trim().split('\n')) {
		const match = /^([a-z0-9][a-z0-9-]*) (sha256:[a-f0-9]{64})$/.exec(line);
		if (!match || found.has(match[1]!)) throw new Error('Invalid image digest manifest');
		found.set(match[1]!, match[2]!);
	}
	if (found.size !== names.length || names.some((name) => !found.has(name)))
		throw new Error('Incomplete image digest manifest');
	return names.map((name) => ({ name, digest: found.get(name)! }));
}
