/**
 * The provider-identity ratchet's own gate, part two: its exemptions.
 *
 * Every exemption the script grants — adapter folders, tests, migrations,
 * comment prose — is proved by a pair: the same seeded violation passes on one
 * side of the line and fails on the other. The second half holds the line
 * between a comment and a string that merely looks like one.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanupSandboxes, leak, runIn, sandbox } from './providerIdentity.testlib';

afterEach(cleanupSandboxes);

describe('provider-identity ratchet, exemptions', () => {
	const violation = leak("kind === 'ses'");

	it.each([
		['an adapter folder under lib/sendProviders', 'apps/api/convex/lib/sendProviders/ses/index.ts'],
		[
			'an adapter folder under domains/providers',
			'apps/api/convex/domains/providers/mandrill/api.ts',
		],
		['a __tests__ directory', 'apps/api/convex/delivery/__tests__/harness.ts'],
		['a test file', 'apps/api/convex/delivery/seam.test.ts'],
		// The exclusion list has to cover the spellings tests actually use, or the
		// header's promise ("tests are out of scope") is one a Playwright page
		// object cannot cash — and the failure text forbids the only remedy it
		// offers. A spec under e2e/ was already exempt by extension; the page
		// object it drives and the data it seeds are the same scaffolding.
		['a component test named .test.tsx', 'apps/web/app/components/Editor.test.tsx'],
		['a spec named .spec.vue', 'apps/web/app/components/Editor.spec.vue'],
		['a Playwright page object', 'apps/web/e2e/page-objects/DeliveryPage.ts'],
		['a Playwright fixture', 'apps/web/e2e/fixtures/test-data.ts'],
		['a migration', 'apps/api/convex/migrations/0019_relay_kinds.ts'],
		['convex generated code', 'apps/api/convex/_generated/api.ts'],
	])('exempts %s', (_label, path) => {
		const root = sandbox({ files: { [path]: violation } });
		const result = runIn(root);

		expect(result.output).toContain('ok:');
		expect(result.status).toBe(0);
	});

	it.each([
		['a webhook adapter written one file per kind', 'apps/api/convex/webhooks/adapters/ses.ts'],
		[
			'a domain provider written one file per kind',
			'apps/api/convex/domains/providers/mandrill.ts',
		],
	])('exempts %s', (_label, path) => {
		// `webhooks/adapters/` is file-per-kind where `lib/sendProviders/` is
		// folder-per-kind, and an adapter's own `if (kind !== 'ses') return;`
		// self-guard is the sanctioned case — inside its own module an adapter IS
		// that vendor. Keying only on directory segments would fail it, and the
		// failure text forbids the only remedy it would leave.
		const root = sandbox({ files: { [path]: violation } });
		const result = runIn(root);

		expect(result.output).toContain('ok:');
		expect(result.status).toBe(0);
	});

	it('exempts an adapter folder under integrationImports/providers', () => {
		const root = sandbox({
			files: { 'apps/api/convex/integrationImports/providers/mandrill/api.ts': violation },
		});
		const result = runIn(root);

		expect(result.output).toContain('ok:');
		expect(result.status).toBe(0);
	});

	it('does not exempt a file merely named after a kind', () => {
		const root = sandbox({ files: { 'apps/api/convex/delivery/ses.ts': violation } });
		const result = runIn(root);

		expect(result.output).toContain('apps/api/convex/delivery/ses.ts:2');
		expect(result.status).toBe(1);
	});

	it.each([
		[
			'a per-vendor UI bundle',
			'apps/web/app/pages/dashboard/admin/delivery/smtp/CredentialsPanel.ts',
		],
		['a per-vendor route directory', 'apps/web/app/pages/setup/ses/index.vue'],
		['a kind-named directory in the backend', 'apps/api/convex/delivery/ses/helper.ts'],
	])('does not exempt %s: a kind-named directory outside an adapter root', (_label, path) => {
		// The exemption is anchored to lib/sendProviders/, domains/providers/,
		// integrationImports/providers/ and webhooks/adapters/, not to "any path
		// segment that spells a kind". A per-vendor folder of dashboard panels or
		// wizard routes is precisely the next-provider host edit the ecosystem goal
		// has to stop, and it would name itself after the kind on the way in.
		const root = sandbox({ files: { [path]: leak("provider === 'smtp'") } });
		const result = runIn(root);

		expect(result.output).toContain(path);
		expect(result.status).toBe(1);
	});

	it('exempts the same literal quoted in comments, and only in comments', () => {
		const documented = [
			'/**',
			" * This gate used to read `providerType === 'ses'`, which is exactly what",
			' * the capability below replaced.',
			' */',
			'export function decide(kind: string): boolean {',
			"\treturn eligible(kind); // was: kind !== 'mta'",
			'}',
			'',
		].join('\n');
		const root = sandbox({ files: { 'apps/api/convex/delivery/documented.ts': documented } });
		const result = runIn(root);

		expect(result.output).toContain('ok:');
		expect(result.status).toBe(0);

		const withCode = sandbox({
			files: {
				'apps/api/convex/delivery/documented.ts': documented.replace(
					'\treturn eligible(kind);',
					"\tif (kind === 'ses') return false;\n\treturn eligible(kind);"
				),
			},
		});
		const second = runIn(withCode);

		expect(second.output).toContain('apps/api/convex/delivery/documented.ts:6');
		expect(second.status).toBe(1);
	});

	it.each([
		[
			'a trailing block comment on a line of code',
			[
				'export function decide(kind: string): boolean {',
				"\treturn eligible(kind); /* was: kind === 'ses' */",
				'}',
				'',
			],
		],
		[
			'a block comment whose body lines do not start with *',
			[
				'/*',
				"  The old gate compared kind === 'ses' before the capability landed;",
				'  the catalog answers it now.',
				'*/',
				'export function decide(kind: string): boolean {',
				'\treturn eligible(kind);',
				'}',
				'',
			],
		],
		[
			'a block comment opened mid-line and closed on a later one',
			[
				'export function decide(kind: string): boolean {',
				"\treturn eligible(kind); /* this used to read kind === 'ses'",
				"   and then fell through to kind === 'mta' */",
				'}',
				'',
			],
		],
	])('exempts a kind quoted in %s', (_label, lines) => {
		// House style quotes the literal a seam USED to be spelled with; a stripper
		// that only understood `//` tails and lines opening with `*` would punish
		// that prose, and the failure text offers no sanctioned remedy for it.
		const root = sandbox({
			files: { 'apps/api/convex/delivery/documented.ts': (lines as string[]).join('\n') },
		});
		const result = runIn(root);

		expect(result.output).toContain('ok:');
		expect(result.status).toBe(0);
	});

	it('still sees code that follows a closed block comment on the same line', () => {
		// The other half of the pair: stripping must end where the comment ends.
		const root = sandbox({
			files: {
				'apps/api/convex/delivery/inline.ts': [
					'export function decide(kind: string): boolean {',
					"\t/* legacy */ if (kind === 'ses') return false;",
					'\treturn eligible(kind);',
					'}',
					'',
				].join('\n'),
			},
		});
		const result = runIn(root);

		expect(result.output).toContain('apps/api/convex/delivery/inline.ts:2');
		expect(result.status).toBe(1);
	});

	it('exempts the MTA, which speaks a different alphabet with the same spelling', () => {
		const root = sandbox({
			files: { 'apps/mta/src/routes/routingDecision.ts': leak("decision === 'mta'") },
		});
		const result = runIn(root);

		expect(result.output).toContain('ok:');
		expect(result.status).toBe(0);
	});

	it('reaches the UI, the shared packages and the plugin tier, not just the backend', () => {
		// examples/ is a workspace root (examples/plugins/*, examples/conformance)
		// and the home of the tier whose whole promise is that a provider ships
		// without host edits — P3.3's mock plugin ESP lands there. A kind literal in
		// that tier is the loudest possible contradiction, so it is in scope.
		const root = sandbox({
			files: {
				'apps/web/app/components/delivery/NewEditor.vue': [
					'<template>',
					'\t<div v-if="provider === \'resend\'">key</div>',
					'</template>',
					'',
				].join('\n'),
				'packages/shared/src/newRouting.ts': leak("kind !== 'smtp'"),
				'apps/setup-cli/src/commands/newPrompt.ts': leak("provider === 'ses'"),
				'examples/conformance/src/mockEsp.ts': leak("kind === 'mandrill'"),
			},
		});
		const result = runIn(root);

		expect(result.output).toContain('examples/conformance/src/mockEsp.ts');
		expect(result.output).toContain('FAIL: 4 file(s)');
		expect(result.output).toContain('apps/web/app/components/delivery/NewEditor.vue:2');
		expect(result.output).toContain('packages/shared/src/newRouting.ts');
		expect(result.output).toContain('apps/setup-cli/src/commands/newPrompt.ts');
		expect(result.status).toBe(1);
	});

	it.each([
		['one line', ['\t<!-- the credentials block used to be v-if="provider === \'ses\'" -->']],
		[
			'several lines',
			[
				'\t<!--',
				'\t\tthe credentials block used to be v-if="provider === \'ses\'";',
				'\t\tthe descriptors render it now',
				'\t-->',
			],
		],
	])('exempts a kind named inside a template comment spanning %s', (_label, comment) => {
		const root = sandbox({
			files: {
				'apps/web/app/components/delivery/Documented.vue': [
					'<template>',
					...(comment as string[]),
					'\t<CredentialFields :fields="fields" />',
					'</template>',
					'',
				].join('\n'),
			},
		});
		const result = runIn(root);

		expect(result.output).toContain('ok:');
		expect(result.status).toBe(0);
	});
});

describe('provider-identity ratchet, a string is not a comment', () => {
	// The stripper's job is to hide PROSE. Every case below is the opposite
	// mistake — hiding code because a string happened to contain a comment
	// opener — and each is paired with the prose case it must not break, because
	// this is the direction where a ratchet fails OPEN and says `ok:`.

	it('sees a comparison on a line that also carries a URL', () => {
		// `//` inside a string is not a comment. Provider doc links sit in exactly
		// the per-vendor panels the allowlist carries as debt, so this is both a
		// natural accident and a one-character deliberate bypass.
		const root = sandbox({
			files: {
				'apps/web/app/components/delivery/Docs.vue': [
					'<template>',
					'\t<a href="https://docs.aws.amazon.com/ses" v-if="provider === \'ses\'">docs</a>',
					'</template>',
					'',
				].join('\n'),
			},
		});
		const result = runIn(root);

		expect(result.output).toContain('apps/web/app/components/delivery/Docs.vue:2');
		expect(result.status).toBe(1);
	});

	it('still hides a comment that follows a URL on the same line', () => {
		// The pair: teaching the stripper about strings must not stop a real `//`
		// tail from being a comment.
		const root = sandbox({
			files: {
				'apps/api/convex/delivery/documented.ts': [
					'export function decide(kind: string): boolean {',
					"\treturn eligible(kind); // https://docs.aws.amazon.com/ses — was kind === 'ses'",
					'}',
					'',
				].join('\n'),
			},
		});
		const result = runIn(root);

		expect(result.output).toContain('ok:');
		expect(result.status).toBe(0);
	});

	it('does not let a glob string open a block comment that swallows the rest of the file', () => {
		// `'*/*'` used to start a block comment that never closed, so EVERY line
		// below it went unread — silently, for the whole file. Twenty-one tracked
		// files ended a run in that state, including nuxt.config.ts (a route glob)
		// and the media picker below.
		const root = sandbox({
			files: {
				'apps/web/app/components/MediaPicker.vue': [
					'<script setup lang="ts">',
					"const resolvedAccept = props.allowAllFiles ? '*/*' : props.accept;",
					'',
					'function label(kind: string): string {',
					"\treturn kind === 'ses' ? 'Amazon SES' : 'other';",
					'}',
					'</script>',
					'',
				].join('\n'),
			},
		});
		const result = runIn(root);

		expect(result.output).toContain('apps/web/app/components/MediaPicker.vue:5');
		expect(result.status).toBe(1);
	});

	it('passes the same glob with no comparison under it', () => {
		const root = sandbox({
			files: {
				'apps/web/app/components/MediaPicker.vue': [
					'<script setup lang="ts">',
					"const resolvedAccept = props.allowAllFiles ? '*/*' : props.accept;",
					'</script>',
					'',
				].join('\n'),
			},
		});
		const result = runIn(root);

		expect(result.output).toContain('ok:');
		expect(result.status).toBe(0);
	});

	it('follows a template literal across lines and keeps reading after it closes', () => {
		// A template literal is the one string that spans lines, so its state is
		// carried across them. Carrying it means the `//` in the URL inside it is
		// not a comment, and closing it means the branch underneath is still code.
		const root = sandbox({
			files: {
				'apps/web/app/composables/useHelp.ts': [
					'export const help = `',
					'\tRead https://docs.aws.amazon.com/ses/latest/ first.',
					'`;',
					'export function decide(kind: string): boolean {',
					"\treturn kind === 'ses';",
					'}',
					'',
				].join('\n'),
			},
		});
		const result = runIn(root);

		expect(result.output).toContain('apps/web/app/composables/useHelp.ts:5');
		expect(result.status).toBe(1);
	});

	it('does not let an apostrophe in template prose hide the next line', () => {
		// A single quote in a Vue text node opens nothing: quoted strings cannot
		// span lines, so the stripper forgets them at the newline rather than
		// reading the rest of the file as one long string.
		const root = sandbox({
			files: {
				'apps/web/app/components/delivery/Prose.vue': [
					'<template>',
					"\t<p>You'll need credentials before sending.</p>",
					'\t<div v-if="provider === \'resend\'">key</div>',
					'</template>',
					'',
				].join('\n'),
			},
		});
		const result = runIn(root);

		expect(result.output).toContain('apps/web/app/components/delivery/Prose.vue:3');
		expect(result.status).toBe(1);
	});

	it('fails loudly when it reaches the end of a file still inside a comment', () => {
		// The backstop for the whole family: no compiling source file ends inside
		// a block comment, so if the stripper thinks one did, the stripper is
		// wrong — and everything after its mistake was read as prose. Better a red
		// gate naming the file than a green one that read half of it.
		const root = sandbox({
			files: {
				'apps/api/convex/delivery/malformed.ts': [
					"/* the old gate compared kind === 'ses'",
					'export function decide(kind: string): boolean {',
					'\treturn eligible(kind);',
					'}',
					'',
				].join('\n'),
			},
		});
		const result = runIn(root);

		expect(result.output).toContain('still');
		expect(result.output).toContain('apps/api/convex/delivery/malformed.ts');
		expect(result.output).toContain('block comment at end of file');
		expect(result.status).toBe(1);
	});
});
