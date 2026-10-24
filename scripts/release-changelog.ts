/**
 * The CHANGELOG.md half of `release:cut`: conventional-commit subjects into
 * Keep a Changelog buckets, and a version's section written or extended.
 *
 * The first candidate of a version writes its section. A later candidate of
 * the same version extends that section (it may have been curated by hand
 * since) with what landed after the previous candidate, so the section on the
 * newest candidate's commit is the stable release's notes.
 */

const RELEASE_MARKER = '<!-- Add released versions below this line, newest first. -->';

const BUCKETS = ['Added', 'Changed', 'Fixed', 'Removed', 'Security', 'Documentation'] as const;
type Bucket = (typeof BUCKETS)[number];
type Buckets = Record<Bucket, string[]>;

const TYPE_TO_BUCKET: Record<string, Bucket> = {
	feat: 'Added',
	fix: 'Fixed',
	perf: 'Changed',
	refactor: 'Changed',
	style: 'Changed',
	revert: 'Removed',
	docs: 'Documentation',
	security: 'Security',
};

/** Bucket commit subjects; chore / test / ci / build stay out of the changelog. */
export function bucketSubjects(subjects: readonly string[]): Buckets {
	const buckets = Object.fromEntries(BUCKETS.map((bucket) => [bucket, []])) as unknown as Buckets;
	const seen = new Set<string>();
	for (const subject of subjects) {
		const match = subject.match(/^(\w+)(?:\(([^)]*)\))?!?:\s*(.+)$/);
		if (!match) continue;
		const bucket = TYPE_TO_BUCKET[match[1] ?? ''];
		if (!bucket) continue;
		const scope = match[2];
		const entry = `- ${scope ? `**${scope}**: ` : ''}${match[3]}`;
		if (seen.has(entry)) continue;
		seen.add(entry);
		buckets[bucket].push(entry);
	}
	return buckets;
}

export function bucketSummary(buckets: Buckets): string {
	return BUCKETS.filter((bucket) => buckets[bucket].length > 0)
		.map((bucket) => `${buckets[bucket].length} ${bucket.toLowerCase()}`)
		.join(', ');
}

const UNRELEASED_RE = /## \[Unreleased\]\n([\s\S]*?)(?=\n## |\n<!-- Add released versions)/;

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The `## [version]` heading line and body span, or null when absent. */
function sectionSpan(changelog: string, version: string) {
	const heading = new RegExp(`^## \\[${escapeRegExp(version)}\\][^\\n]*$`, 'm').exec(changelog);
	if (!heading) return null;
	const bodyStart = heading.index + heading[0].length;
	const next = changelog.slice(bodyStart).search(/^## /m);
	return {
		start: heading.index,
		bodyStart,
		end: next === -1 ? changelog.length : bodyStart + next,
	};
}

/** Append each bucket's new entries under its `### Bucket` heading, adding missing headings. */
function extendBody(body: string, curated: string, buckets: Buckets): string {
	let result = body.trim();
	if (curated) {
		const firstBucket = result.search(/^### /m);
		result =
			firstBucket === -1
				? `${result}\n\n${curated}`.trim()
				: `${result.slice(0, firstBucket).trimEnd()}\n\n${curated}\n\n${result.slice(firstBucket)}`.trim();
	}
	for (const bucket of BUCKETS) {
		const fresh = buckets[bucket].filter((entry) => !result.includes(entry));
		if (fresh.length === 0) continue;
		const heading = new RegExp(`^### ${bucket}$`, 'm').exec(result);
		if (!heading) {
			result = `${result}\n\n### ${bucket}\n\n${fresh.join('\n')}`.trim();
			continue;
		}
		const afterHeading = heading.index + heading[0].length;
		const next = result.slice(afterHeading).search(/^### /m);
		const end = next === -1 ? result.length : afterHeading + next;
		result =
			`${result.slice(0, end).trimEnd()}\n${fresh.join('\n')}\n${next === -1 ? '' : `\n${result.slice(end)}`}`.trim();
	}
	return result;
}

/**
 * CHANGELOG.md with `version`'s section written (first candidate) or extended
 * (later candidates), the hand-curated [Unreleased] text folded into it and
 * [Unreleased] emptied. `date` is the section's date (YYYY-MM-DD).
 */
export function writeSection(
	changelog: string,
	version: string,
	date: string,
	buckets: Buckets
): string {
	if (!changelog.includes(RELEASE_MARKER))
		throw new Error(`CHANGELOG.md is missing the "${RELEASE_MARKER}" marker`);
	const curated = changelog.match(UNRELEASED_RE)?.[1]?.trim() ?? '';
	const emptied = changelog.replace(UNRELEASED_RE, '## [Unreleased]\n');
	const heading = `## [${version}] - ${date}`;
	const span = sectionSpan(emptied, version);
	if (!span) {
		const body = extendBody('', curated, buckets);
		return emptied.replace(
			RELEASE_MARKER,
			`${RELEASE_MARKER}\n\n${heading}${body ? `\n\n${body}` : ''}`
		);
	}
	const body = extendBody(emptied.slice(span.bodyStart, span.end), curated, buckets);
	const rest = emptied.slice(span.end);
	return `${emptied.slice(0, span.start)}${heading}${body ? `\n\n${body}` : ''}${rest ? `\n\n${rest}` : '\n'}`;
}
