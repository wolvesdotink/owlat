import { describe, expect, it } from 'vitest';
import { withMsiVersion } from '../ci/msi-version';
import type { Run } from '../ci/reuse';
import {
	candidatesOf,
	checkPromotion,
	classifyReleaseTag,
	msiVersion,
	nextCandidateTag,
	type CandidateEvidence,
} from '../ci/release-policy';

describe('classifyReleaseTag', () => {
	it('tells stable tags, candidates and other prereleases apart', () => {
		expect(classifyReleaseTag('v0.7.0')).toEqual({
			tag: 'v0.7.0',
			version: '0.7.0',
			base: '0.7.0',
			channel: 'stable',
		});
		expect(classifyReleaseTag('v0.7.0-rc.12')).toEqual({
			tag: 'v0.7.0-rc.12',
			version: '0.7.0-rc.12',
			base: '0.7.0',
			channel: 'rc',
			rc: 12,
		});
		expect(classifyReleaseTag('v0.7.0-beta.1')?.channel).toBe('prerelease');
		expect(classifyReleaseTag('v0.7.0-rc')?.channel).toBe('prerelease');
		expect(classifyReleaseTag('v0.7.0-rc.0')?.channel).toBe('prerelease');
		expect(classifyReleaseTag('v0.7.0-rc.01')?.channel).toBe('prerelease');
	});

	it('rejects target-only lines and malformed tags', () => {
		for (const tag of [
			'server-v0.7.0',
			'desktop-v0.7.0-rc.1',
			'0.7.0',
			'v0.7',
			'v01.2.3',
			'v1.2.3-',
		])
			expect(classifyReleaseTag(tag)).toBeNull();
	});
});

describe('candidate numbering', () => {
	const tags = [
		'v0.7.0-rc.1',
		'v0.7.0-rc.10',
		'v0.7.0-rc.2',
		'v0.6.16',
		'v0.8.0-rc.1',
		'v0.7.0-beta.3',
	];

	it('orders the candidates of one version numerically, newest first', () => {
		expect(candidatesOf('0.7.0', tags).map((tag) => tag.tag)).toEqual([
			'v0.7.0-rc.10',
			'v0.7.0-rc.2',
			'v0.7.0-rc.1',
		]);
	});

	it('numbers the next candidate one past the highest', () => {
		expect(nextCandidateTag('0.7.0', tags)).toBe('v0.7.0-rc.11');
		expect(nextCandidateTag('0.6.17', tags)).toBe('v0.6.17-rc.1');
	});
});

describe('msiVersion', () => {
	it('gives prereleases a numeric fourth field and leaves stable versions to Tauri', () => {
		expect(msiVersion('0.7.0-rc.3')).toBe('0.7.0.3');
		expect(msiVersion('0.7.0-beta')).toBe('0.7.0.0');
		expect(msiVersion('0.7.0')).toBeNull();
	});

	it('refuses versions Windows Installer cannot hold', () => {
		expect(() => msiVersion('0.7.0-rc.65536')).toThrow();
		expect(() => msiVersion('256.0.0-rc.1')).toThrow();
		expect(() => msiVersion('not-a-version')).toThrow();
	});
});

describe('withMsiVersion', () => {
	it('sets the WiX version and keeps every other release setting', () => {
		const config = {
			$schema: 'https://example.com/schema.json',
			bundle: {
				createUpdaterArtifacts: true,
				windows: { wix: { language: 'en-US' }, signCommand: 'x' },
			},
		};
		expect(JSON.parse(withMsiVersion(JSON.stringify(config), '0.7.0.3', 'release.json'))).toEqual({
			$schema: 'https://example.com/schema.json',
			bundle: {
				createUpdaterArtifacts: true,
				windows: { wix: { language: 'en-US', version: '0.7.0.3' }, signCommand: 'x' },
			},
		});
		expect(JSON.parse(withMsiVersion('{}', '0.7.0.3', 'release.json'))).toEqual({
			bundle: { windows: { wix: { version: '0.7.0.3' } } },
		});
	});

	it('refuses a config it would have to overwrite to edit', () => {
		for (const [text, message] of [
			['[]', 'release.json must be an object'],
			['{"bundle":[]}', 'release.json.bundle must be an object'],
			['{"bundle":{"windows":"x"}}', 'release.json.bundle.windows must be an object'],
			['{"bundle":{"windows":{"wix":true}}}', 'release.json.bundle.windows.wix must be an object'],
			['{"bundle":', 'release.json is not valid JSON'],
		])
			expect(() => withMsiVersion(text!, '0.7.0.3', 'release.json')).toThrow(message);
	});
});

describe('checkPromotion', () => {
	const commit = 'a'.repeat(40);
	const run = (overrides: Partial<Run> = {}): Run => ({
		id: 7,
		run_attempt: 1,
		head_sha: commit,
		head_branch: 'v0.7.0-rc.2',
		event: 'push',
		path: '.github/workflows/release.yml',
		status: 'completed',
		conclusion: 'success',
		created_at: '2026-10-20T10:00:00Z',
		html_url: 'https://github.com/example/repo/actions/runs/7',
		...overrides,
	});
	const candidate = (overrides: Partial<CandidateEvidence> = {}): CandidateEvidence => ({
		tag: 'v0.7.0-rc.2',
		commit,
		release: { draft: false, prerelease: true },
		runs: [run()],
		...overrides,
	});
	const older = candidate({ tag: 'v0.7.0-rc.1', commit: 'b'.repeat(40), runs: [] });

	it('promotes the newest candidate whose release run succeeded on the same commit', () => {
		const result = checkPromotion('v0.7.0', commit, [older, candidate()]);
		expect(result).toMatchObject({ ok: true, candidate: 'v0.7.0-rc.2' });
	});

	it('refuses a stable tag on any other commit', () => {
		expect(checkPromotion('v0.7.0', 'c'.repeat(40), [older, candidate()])).toMatchObject({
			ok: false,
			reason: expect.stringContaining("must point at v0.7.0-rc.2's commit"),
		});
	});

	it('refuses an older candidate once a newer one exists', () => {
		expect(checkPromotion('v0.7.0', older.commit, [older, candidate()]).ok).toBe(false);
	});

	it('refuses a version without candidates and a tag that is not stable', () => {
		expect(checkPromotion('v0.7.0', commit, [])).toMatchObject({
			ok: false,
			reason: expect.stringContaining('has no release candidate'),
		});
		expect(checkPromotion('v0.7.0', commit, [candidate({ tag: 'v0.8.0-rc.1' })]).ok).toBe(false);
		expect(checkPromotion('v0.7.0-rc.2', commit, [candidate()]).ok).toBe(false);
	});

	it('refuses a candidate that is unpublished, a draft or not a prerelease', () => {
		for (const release of [
			null,
			{ draft: true, prerelease: true },
			{ draft: false, prerelease: false },
		])
			expect(checkPromotion('v0.7.0', commit, [candidate({ release })]).ok).toBe(false);
	});

	it('refuses missing, running, failed and mismatched release runs', () => {
		const cases: Run[][] = [
			[],
			[run({ status: 'in_progress', conclusion: null })],
			[run({ conclusion: 'failure' })],
			[run({ conclusion: 'cancelled' })],
			[run({ head_sha: 'd'.repeat(40) })],
			[run({ head_branch: 'v0.7.0-rc.1' })],
			[run({ event: 'workflow_dispatch' })],
			[run({ path: '.github/workflows/server-release.yml' })],
		];
		for (const runs of cases)
			expect(checkPromotion('v0.7.0', commit, [candidate({ runs })]).ok).toBe(false);
	});

	it('decides on the newest run of the candidate, not an older success', () => {
		const runs = [
			run({ id: 7, created_at: '2026-10-20T10:00:00Z' }),
			run({ id: 9, created_at: '2026-10-21T10:00:00Z', conclusion: 'failure' }),
		];
		expect(checkPromotion('v0.7.0', commit, [candidate({ runs })]).ok).toBe(false);
		const rerun = [runs[1]!, { ...runs[0]!, id: 11, created_at: '2026-10-22T10:00:00Z' }];
		expect(checkPromotion('v0.7.0', commit, [candidate({ runs: rerun })]).ok).toBe(true);
	});
});
