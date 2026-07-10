import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
	isValidTargetVersion,
	composeArtifactUrls,
	parseSha256Manifest,
	verifyComposeTemplate,
	RELEASE_DOWNLOAD_BASE,
} from '../composeVerify';

const VERSION = '1.2.3';
const TEMPLATE = `services:\n  web:\n    image: ghcr.io/wolvesdotink/web:${VERSION}\n`;
const DIGEST = createHash('sha256').update(TEMPLATE).digest('hex');

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

describe('parseSha256Manifest', () => {
	it('extracts the digest from a `sha256sum`-style manifest', () => {
		expect(parseSha256Manifest(`${DIGEST}  docker-compose-${VERSION}.yml`)).toBe(DIGEST);
	});

	it('accepts a bare, upper-cased hex digest and lower-cases it', () => {
		expect(parseSha256Manifest(`${DIGEST.toUpperCase()}\n`)).toBe(DIGEST);
	});

	it('throws on a malformed manifest', () => {
		expect(() => parseSha256Manifest('')).toThrow(/Invalid SHA256 manifest/);
		expect(() => parseSha256Manifest('not-a-digest')).toThrow(/Invalid SHA256 manifest/);
		// 63 hex chars — one short of a valid digest.
		expect(() => parseSha256Manifest('a'.repeat(63))).toThrow(/Invalid SHA256 manifest/);
	});
});

describe('verifyComposeTemplate', () => {
	it('passes when the hash matches and the image is pinned', () => {
		expect(() =>
			verifyComposeTemplate({
				composeTemplate: TEMPLATE,
				expectedSha256: DIGEST,
				targetVersion: VERSION,
			})
		).not.toThrow();
	});

	it('passes when the expected digest is provided upper-cased', () => {
		expect(() =>
			verifyComposeTemplate({
				composeTemplate: TEMPLATE,
				expectedSha256: DIGEST.toUpperCase(),
				targetVersion: VERSION,
			})
		).not.toThrow();
	});

	it('rejects a tampered template (hash mismatch)', () => {
		const tampered = TEMPLATE + '\n  evil:\n    image: ghcr.io/attacker/rootkit:latest\n';
		expect(() =>
			verifyComposeTemplate({
				composeTemplate: tampered,
				expectedSha256: DIGEST,
				targetVersion: VERSION,
			})
		).toThrow(/hash mismatch/);
	});

	it('rejects a template that does not reference the expected web image', () => {
		// A validly-hashed template that pins the wrong image version.
		const wrongImage = 'services:\n  web:\n    image: ghcr.io/wolvesdotink/web:9.9.9\n';
		const wrongImageDigest = createHash('sha256').update(wrongImage).digest('hex');
		expect(() =>
			verifyComposeTemplate({
				composeTemplate: wrongImage,
				expectedSha256: wrongImageDigest,
				targetVersion: VERSION,
			})
		).toThrow(/does not reference v1\.2\.3/);
	});
});
