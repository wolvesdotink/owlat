import { describe, expect, it } from 'vitest';
import { changelogSection } from '../release-body';
import { bucketSubjects, bucketSummary, hasSection, writeSection } from '../release-changelog';

const CHANGELOG = `# Changelog

## [Unreleased]

<!-- Add released versions below this line, newest first. -->

## [0.6.16] - 2026-10-21

A patch.

### Fixed

- **web**: an old fix
`;

describe('bucketSubjects', () => {
	it('sorts conventional subjects into buckets and drops the rest', () => {
		const buckets = bucketSubjects([
			'feat(web): a feature',
			'fix: a fix',
			'fix: a fix',
			'chore(release): v0.6.16',
			'test(api): a test',
			'Merge pull request #1',
			'perf(api)!: faster',
		]);
		expect(buckets.Added).toEqual(['- **web**: a feature']);
		expect(buckets.Fixed).toEqual(['- a fix']);
		expect(buckets.Changed).toEqual(['- **api**: faster']);
		expect(bucketSummary(buckets)).toBe('1 added, 1 changed, 1 fixed');
	});
});

describe('writeSection', () => {
	it("writes the first candidate's section above the previous release and folds [Unreleased] in", () => {
		const curated = CHANGELOG.replace('## [Unreleased]\n', '## [Unreleased]\n\nThe lead.\n');
		const written = writeSection(
			curated,
			'0.7.0',
			'2026-10-24',
			bucketSubjects(['feat: one', 'fix: two'])
		);
		expect(changelogSection(written, '0.7.0')).toBe(
			'The lead.\n\n### Added\n\n- one\n\n### Fixed\n\n- two'
		);
		expect(written).toContain('## [Unreleased]\n\n<!-- Add released versions');
		expect(written).toContain('## [0.7.0] - 2026-10-24');
		expect(written.indexOf('## [0.7.0]')).toBeLessThan(written.indexOf('## [0.6.16]'));
		expect(changelogSection(written, '0.6.16')).toBe(changelogSection(CHANGELOG, '0.6.16'));
	});

	it("extends a later candidate's curated section in place instead of writing a second one", () => {
		const first = writeSection(CHANGELOG, '0.7.0', '2026-10-24', bucketSubjects(['fix: two']));
		const curatedByHand = first.replace('- two', '- **Two.** Curated by hand.');
		const withUnreleased = curatedByHand.replace(
			'## [Unreleased]\n',
			'## [Unreleased]\n\nMore lead.\n'
		);
		const second = writeSection(
			withUnreleased,
			'0.7.0',
			'2026-10-26',
			bucketSubjects(['fix: three', 'feat: four'])
		);
		expect(second.match(/^## \[0\.7\.0\]/gm)).toHaveLength(1);
		expect(second).toContain('## [0.7.0] - 2026-10-26');
		expect(changelogSection(second, '0.7.0')).toBe(
			'More lead.\n\n### Fixed\n\n- **Two.** Curated by hand.\n- three\n\n### Added\n\n- four'
		);
		expect(changelogSection(second, '0.6.16')).toBe(changelogSection(CHANGELOG, '0.6.16'));
		expect(hasSection(second, '0.7.0')).toBe(true);
	});

	it('extends the last section of the file too', () => {
		const only =
			'## [Unreleased]\n\n<!-- Add released versions below this line, newest first. -->\n\n## [0.7.0] - 2026-10-24\n\n### Fixed\n\n- two\n';
		const second = writeSection(only, '0.7.0', '2026-10-25', bucketSubjects(['fix: three']));
		expect(second.endsWith('### Fixed\n\n- two\n- three\n')).toBe(true);
	});

	it('changes nothing for a later candidate with nothing new on the same day', () => {
		const first = writeSection(CHANGELOG, '0.7.0', '2026-10-24', bucketSubjects(['fix: two']));
		expect(
			writeSection(first, '0.7.0', '2026-10-24', bucketSubjects(['chore: x', 'fix: two']))
		).toBe(first);
	});

	it('fails without the release marker', () => {
		expect(() => writeSection('# Changelog\n', '0.7.0', '2026-10-24', bucketSubjects([]))).toThrow(
			'marker'
		);
	});
});
