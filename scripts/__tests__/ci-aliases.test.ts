import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { aliasReleases, previousRelease, publishedDigests, composeDigests } from '../ci/aliases';
const release = (tag_name: string) => ({ tag_name, draft: false, prerelease: false });
it('reconciles highest published stable unified versions regardless of finish order', () => {
	const releases = [
		'v0.6.9',
		'server-v0.6.99',
		'v0.6.12',
		'v0.6.10',
		'desktop-v0.7.0',
		'v0.7.0-beta',
		'v0.5.1',
	].map(release);
	expect(
		aliasReleases([...releases, { ...release('v9.0.0'), draft: true }]).map((r) => [
			r.release.tag_name,
			r.aliases,
		])
	).toEqual([
		['v0.6.12', ['latest', '0.6']],
		['v0.5.1', ['0.5']],
	]);
	expect(previousRelease(releases, '0.6.11')).toBe('0.6.10');
	expect(previousRelease(releases, '0.5.0')).toBe('');
});
const digest = `sha256:${'a'.repeat(64)}`,
	checksum = (text: string) => createHash('sha256').update(text).digest('hex');
it('binds complete published image lists and compose images to checksums', () => {
	const text = `web ${digest}\nsetup ${digest}\n`;
	expect(publishedDigests(text, checksum(text), ['web', 'setup'])).toHaveLength(2);
	expect(() => publishedDigests(text, 'wrong', ['web', 'setup'])).toThrow();
	expect(() => publishedDigests(text, checksum(text), ['web', 'setup', 'mta'])).toThrow();
	const compose = `services:\n  web:\n    image: ghcr.io/example/web:0.6.12@${digest}\n`;
	expect(composeDigests(compose, checksum(compose), '0.6.12', 'example', ['web'])).toEqual([
		{ name: 'web', digest },
	]);
	expect(() => composeDigests(compose, checksum(compose), '0.6.13', 'example', ['web'])).toThrow();
});
