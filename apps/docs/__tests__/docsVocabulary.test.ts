import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { backtickSpans, docPages, REPO_ROOT, repoVocabulary } from './repoVocabulary';

/**
 * ONE question, asked of every documentation page: does the repository still
 * declare the names the prose puts in backticks?
 *
 * This replaces sixteen per-page suites (~5,400 lines) that each pinned one
 * page's sentences by regex. Those pinned the WORDING — a heading reworded for
 * clarity failed a suite that had memorised it — while leaving every page
 * nobody had written a suite for completely unchecked. Two citations of deleted
 * constants (`LEGAL_EDGES`, `ISP_PROFILES`) and five paths under a directory
 * renamed months ago (`convex/organizations/` → `convex/workspaces/`) all
 * survived that regime; the first run of this file found them.
 *
 * Three shapes are checkable without knowing anything about the page:
 *
 *  - a SCREAMING_SNAKE token is a constant or an environment variable;
 *  - a PascalCase token is a type, class or Vue component;
 *  - a token with a slash and a file extension is a path.
 *
 * camelCase is deliberately NOT checked: by shape it is indistinguishable from
 * an email-template variable (`customerName`), a framework API the repository
 * does not declare (`defineSchema`, `toLocaleString`) or a field name in a
 * sample payload, and an exemption list long enough to cover those would fire
 * on legitimate new prose more often than on drift.
 */

/** `content/en/5.vision` and its translations describe what does not exist yet. */
const isRoadmap = (path: string) => path.includes('/5.vision/');

/**
 * Names the docs cite that the repository has no reason to declare.
 *
 * Two kinds, and nothing else belongs here: a name owned by somebody else
 * (a cloud API, a runtime built-in, a library's error class), and a name the
 * prose mentions in order to say the repository does NOT have it. A name that
 * is simply missing is drift — fix the page, do not add a line here.
 */
const EXTERNAL_NAMES: Readonly<Record<string, string>> = {
	AbortSignal: 'web platform',
	AmazonSESFullAccess: 'AWS managed IAM policy',
	CONVEX_DEPLOYMENT: 'set by the Convex CLI, not by Owlat',
	ConvexHttpClient: "the Convex client library's class",
	DeleteIdentity: 'Amazon SES API action',
	FromCity: 'Twilio webhook form field',
	FromCountry: 'Twilio webhook form field',
	FromState: 'Twilio webhook form field',
	EnvVarNameForbidden: 'Convex CLI error code',
	GetIdentityDkimAttributes: 'Amazon SES API action',
	GetIdentityVerificationAttributes: 'Amazon SES API action',
	MailFromDomainNotVerified: 'Amazon SES error code',
	MediaUrl0: 'Twilio webhook form field',
	MessageRejected: 'Amazon SES error code',
	MessageSid: 'Twilio webhook form field',
	SendEmailCommand: 'AWS SDK class',
	SendRawEmailCommand: 'AWS SDK class',
	SetIdentityMailFromDomain: 'Amazon SES API action',
	StandardMetric: 'Google Postmaster Tools API type',
	UserIdentity: 'Convex auth type',
	VerifyDomainDkim: 'Amazon SES API action',
	VerifyDomainIdentity: 'Amazon SES API action',
	// Named in order to say the repository does not have it.
	ANALYTICS_PROVIDER: 'named as a seam that was removed',
	NOTIFICATION_PROVIDER: 'named as a seam that was removed',
	VECTOR_STORE: 'named as a seam that was removed',
	UPPER_SNAKE: 'the shape of a plugin env-var name, not a name',
};

/**
 * Paths that name something other than a file in this repository: output a
 * scaffold writes into someone else's plugin, a directory a runtime creates,
 * and one page's statement that a file no longer exists.
 */
const EXTERNAL_PATHS: Readonly<Record<string, string>> = {
	'./': 'the current directory, in a CLI example',
	'appendonlydir/': "Redis's own AOF directory, created at runtime",
	'dist/': 'the build output of a plugin package',
	'lib/contentScanner.ts': 'named to say the re-export wrapper was removed',
	'sendersupport.olc.protection.outlook.com/snds/': 'a Microsoft URL, not a path',
	'src/convex/domainIdentity.ts': 'scaffold output, written into the plugin author’s package',
	'src/convex/transport.ts': 'scaffold output, written into the plugin author’s package',
	'src/convex/webhook.ts': 'scaffold output, written into the plugin author’s package',
	'src/envNames.ts': 'scaffold output, written into the plugin author’s package',
	'src/__tests__/domainIdentity.test.ts':
		'scaffold output, written into the plugin author’s package',
	'src/__tests__/transport.test.ts': 'scaffold output, written into the plugin author’s package',
	'src/__tests__/webhook.test.ts': 'scaffold output, written into the plugin author’s package',
};

/** The docs' running example plugin, `@acme/…`, which ships no code. */
const SAMPLE_PLUGIN_PREFIX = 'PLUGIN_ACME_';

const CONSTANT_LIKE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const TYPE_LIKE = /^[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+$/;
const PATH_LIKE = /^[\w.@/-]+(?:\.(?:ts|tsx|vue|md|json|jsonc|sh|yml|yaml|css|java)|\/)$/;

interface Citation {
	readonly name: string;
	readonly page: string;
}

/**
 * Every path a file in this repository can be addressed by. House style writes
 * a path relative to whichever root the sentence is standing in — `smtp/dkim.ts`
 * inside a page about the MTA, `apps/mta/src/smtp/dkim.ts` in a cross-cutting
 * one — so every suffix of every tracked path is an address, and a citation
 * resolves if it is one of them.
 */
function trackedPathSuffixes(): ReadonlySet<string> {
	const tracked = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
		.split('\n')
		.filter(Boolean);
	const withDirectories = new Set<string>(tracked);
	for (const file of tracked) {
		const parts = file.split('/');
		for (let i = 1; i < parts.length; i += 1)
			withDirectories.add(`${parts.slice(0, i).join('/')}/`);
	}
	const suffixes = new Set<string>();
	for (const entry of withDirectories) {
		const isDirectory = entry.endsWith('/');
		const parts = entry.replace(/\/$/, '').split('/');
		for (let i = 0; i < parts.length; i += 1) {
			const suffix = parts.slice(i).join('/');
			suffixes.add(isDirectory ? `${suffix}/` : suffix);
		}
	}
	return suffixes;
}

/** Every citation of a given shape across every non-roadmap page. */
function citations(shape: RegExp): Citation[] {
	const found: Citation[] = [];
	const seen = new Set<string>();
	for (const page of docPages()) {
		if (isRoadmap(page.path)) continue;
		for (const span of backtickSpans(page.prose)) {
			// `foo()` in prose is the function `foo`.
			const name = span.replace(/\(\)$/, '');
			if (!shape.test(name) || seen.has(name)) continue;
			seen.add(name);
			found.push({ name, page: page.path });
		}
	}
	return found;
}

function report(unresolved: Citation[]): string[] {
	return unresolved.map(({ name, page }) => `${name} (${page})`);
}

describe('every name the docs put in backticks still exists', () => {
	const vocabulary = repoVocabulary();

	it('reads a real vocabulary and a real corpus', () => {
		// Non-triviality: an empty vocabulary or an empty page list would agree
		// with every broken citation in the docs.
		expect(vocabulary.size).toBeGreaterThan(10_000);
		expect(docPages().length).toBeGreaterThan(200);
	});

	it('names every constant and environment variable it cites', () => {
		const cited = citations(CONSTANT_LIKE);
		expect(cited.length, 'no constants parsed out of the docs').toBeGreaterThan(100);
		const unresolved = cited.filter(
			({ name }) =>
				!vocabulary.has(name) && !(name in EXTERNAL_NAMES) && !name.startsWith(SAMPLE_PLUGIN_PREFIX)
		);
		expect(report(unresolved), 'the docs cite constants the repository no longer declares').toEqual(
			[]
		);
	});

	it('names every type, class and component it cites', () => {
		const cited = citations(TYPE_LIKE);
		expect(cited.length, 'no type names parsed out of the docs').toBeGreaterThan(50);
		const unresolved = cited.filter(
			({ name }) => !vocabulary.has(name) && !(name in EXTERNAL_NAMES)
		);
		expect(report(unresolved), 'the docs cite types the repository no longer declares').toEqual([]);
	});

	it('resolves every file path it cites', () => {
		const suffixes = trackedPathSuffixes();
		const cited = citations(PATH_LIKE).filter(
			({ name }) => name.includes('/') && !name.startsWith('/') && !name.startsWith('http')
		);
		expect(cited.length, 'no paths parsed out of the docs').toBeGreaterThan(200);
		const unresolved = cited.filter(({ name }) => !suffixes.has(name) && !(name in EXTERNAL_PATHS));
		expect(report(unresolved), 'the docs cite paths that are not in the repository').toEqual([]);
	});

	it('keeps the exemption lists honest', () => {
		// An exemption that no page uses any more only widens what can rot.
		const spans = new Set(
			docPages()
				.filter((page) => !isRoadmap(page.path))
				.flatMap((page) => backtickSpans(page.prose).map((span) => span.replace(/\(\)$/, '')))
		);
		const stale = [...Object.keys(EXTERNAL_NAMES), ...Object.keys(EXTERNAL_PATHS)].filter(
			(name) => !spans.has(name)
		);
		expect(stale, 'no page cites these any more — delete the exemption').toEqual([]);
	});
});
