import { describe, it, expect } from 'vitest';
import {
	composeArtifactUrls,
	GITHUB_REPO_SLUG,
	isValidTargetVersion,
	RELEASE_DOWNLOAD_BASE,
} from '../releaseArtifacts';

/**
 * Release URLs and what counts as a version. `isValidTargetVersion` is the guard
 * that keeps a caller-supplied version out of a download URL, so its rejection
 * cases are the interesting half.
 */

const VERSION = '1.2.3';

describe('GITHUB_REPO_SLUG', () => {
	it('is the owner/repo the release URLs are built from', () => {
		expect(GITHUB_REPO_SLUG).toBe('wolvesdotink/owlat');
		expect(RELEASE_DOWNLOAD_BASE).toBe(`https://github.com/${GITHUB_REPO_SLUG}/releases/download`);
	});
});

describe('isValidTargetVersion', () => {
	it('accepts plain and pre-release semver', () => {
		expect(isValidTargetVersion('1.2.3')).toBe(true);
		expect(isValidTargetVersion('0.2.1')).toBe(true);
		expect(isValidTargetVersion('1.2.3-rc.1')).toBe(true);
		expect(isValidTargetVersion('10.20.30-beta.2')).toBe(true);
	});

	it('rejects non-semver and injection attempts', () => {
		expect(isValidTargetVersion('')).toBe(false);
		expect(isValidTargetVersion('latest')).toBe(false);
		expect(isValidTargetVersion('1.2')).toBe(false);
		expect(isValidTargetVersion('1.2.3/../evil')).toBe(false);
		expect(isValidTargetVersion('1.2.3 rm -rf')).toBe(false);
		expect(isValidTargetVersion('v1.2.3')).toBe(false);
	});
});

describe('composeArtifactUrls', () => {
	it('builds the pinned compose + sha256 URLs from the canonical release base', () => {
		const { composeUrl, sha256Url } = composeArtifactUrls(VERSION);
		expect(composeUrl).toBe(`${RELEASE_DOWNLOAD_BASE}/v${VERSION}/docker-compose-${VERSION}.yml`);
		expect(sha256Url).toBe(`${composeUrl}.sha256`);
	});
});
