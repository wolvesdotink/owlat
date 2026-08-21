import { describe, it, expect } from 'vitest';
import { selectRuntimeEnvVars } from '@owlat/shared/convexRuntimeEnv';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';

/**
 * Docs-lint for the self-hosting reconcile (audit item docs-reconcile).
 *
 * Keeps the self-hosting docs honest against the fixed code on two axes that
 * silently regressed before:
 *
 *  1. CONVEX_SITE_URL is a Convex BUILT-IN. `convex env set CONVEX_SITE_URL …`
 *     is rejected by the CLI (EnvVarNameForbidden), so no doc may instruct it.
 *  2. The public home is the `wolvesdotink` org (`github.com/wolvesdotink/owlat`,
 *     `ghcr.io/wolvesdotink/*`) — matching install.sh / scripts/owlat. The stale
 *     `owlat/owlat` repo slug and `ghcr.io/owlat` registry must not creep back.
 *
 * The scan covers README.md plus every Markdown page under the docs site.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

function walkMarkdown(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = resolve(dir, entry.name);
		if (entry.isDirectory()) out.push(...walkMarkdown(full));
		else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
	}
	return out;
}

const docFiles = [
	resolve(repoRoot, 'README.md'),
	// The English tree only: these are phrase-level assertions, and a translated
	// mirror would fail them for its wording rather than for a wrong claim.
	...walkMarkdown(resolve(repoRoot, 'apps/docs/content/en')),
];

const docs = docFiles.map((path) => ({
	rel: relative(repoRoot, path),
	text: readFileSync(path, 'utf8'),
}));

describe('self-hosting docs: CONVEX_SITE_URL is never set via convex env set', () => {
	it('found docs to scan', () => {
		expect(docs.length).toBeGreaterThan(10);
	});

	for (const doc of docs) {
		it(`${doc.rel} does not instruct 'convex env set CONVEX_SITE_URL'`, () => {
			// CONVEX_SITE_URL is a Convex built-in; the CLI rejects setting it
			// (EnvVarNameForbidden). Explaining the var is fine, but the literal
			// command string must never appear.
			expect(doc.text.toLowerCase()).not.toContain('convex env set convex_site_url');
		});
	}
});

describe('self-hosting docs: image/repo references point at the wolvesdotink org', () => {
	for (const doc of docs) {
		it(`${doc.rel} has no stale owlat/owlat or ghcr.io/owlat references`, () => {
			expect(doc.text).not.toMatch(/owlat\/owlat/);
			expect(doc.text).not.toMatch(/ghcr\.io\/owlat/);
		});
	}
});

describe('self-hosting docs: the fixes are documented (positive guards)', () => {
	const byRel = (rel: string) => {
		const found = docs.find((d) => d.rel === rel);
		if (!found) throw new Error(`expected doc not found: ${rel}`);
		return found.text;
	};

	it('the primary manual flow explains CONVEX_SITE_URL is a built-in', () => {
		const selfHosting = byRel('apps/docs/content/en/3.developer/30.self-hosting.md');
		expect(selfHosting).toMatch(/CONVEX_SITE_URL/);
		expect(selfHosting).toMatch(/EnvVarNameForbidden|built-in/i);
	});

	it('the README profile table uses the real scan.files flag, not scan.attachments', () => {
		const readme = byRel('README.md');
		expect(readme).not.toMatch(/scan\.attachments/);
		expect(readme).toMatch(/scan\.files/);
	});

	it('the maintenance doc lists MTA_API_URL as a cause of "MTA can\'t send emails"', () => {
		const maintenance = byRel('apps/docs/content/en/3.developer/34.self-hosting-maintenance.md');
		const section = maintenance.slice(maintenance.indexOf("### MTA can't send emails"));
		expect(section).toMatch(/MTA_API_URL/);
	});
});

/**
 * Guard the OSS self-host *templates* against leftovers from the extracted
 * hosted-cloud control plane (audit item p3-docs-templates).
 *
 * The Nest control plane (Stripe billing, Hetzner provisioning, tier
 * management) lives in a separate private repo. None of it ships here, so the
 * copy-me templates must not seed `OWLAT_HOSTED_MODE`, mention a `--profile
 * hosted`, or reference the `nest` service. (The docs MAY still *explain* that
 * `OWLAT_HOSTED_MODE` is OSS-inert — that's why this scan is scoped to the
 * templates only.)
 */
describe('self-host templates: no extracted control-plane (Nest) leftovers', () => {
	const templates = ['.env.selfhost.example', 'Caddyfile.example'].map((rel) => ({
		rel,
		text: readFileSync(resolve(repoRoot, rel), 'utf8'),
	}));

	for (const tpl of templates) {
		it(`${tpl.rel} does not seed OWLAT_HOSTED_MODE`, () => {
			expect(tpl.text).not.toContain('OWLAT_HOSTED_MODE');
		});

		it(`${tpl.rel} has no '--profile hosted' reference`, () => {
			expect(tpl.text.toLowerCase()).not.toContain('profile hosted');
		});

		it(`${tpl.rel} has no 'nest' control-plane service reference`, () => {
			expect(tpl.text).not.toMatch(/nest/i);
		});
	}
});

/**
 * The two .env templates have DIFFERENT audiences — .env.example is for
 * contributors running `bun run dev`, .env.selfhost.example for operators
 * running docker compose — and an operator knob documented only in the
 * contributor template is a knob operators never learn exists. The
 * deliverability knobs are the ones that drifted: each is unset-by-default and
 * silently costs measurement quality rather than erroring, so nothing else in
 * the product would ever tell an operator about them.
 *
 * The list is cross-checked against the EnvKey union so a rename in code fails
 * here instead of leaving two templates describing a variable nothing reads.
 */
describe('self-host template: deliverability operator knobs', () => {
	const contributorEnv = readFileSync(resolve(repoRoot, '.env.example'), 'utf8');
	const selfhostEnv = readFileSync(resolve(repoRoot, '.env.selfhost.example'), 'utf8');
	const envKeySource = readFileSync(resolve(repoRoot, 'apps/api/convex/lib/env.ts'), 'utf8');

	const knobs = [
		'MTA_RETURN_PATH_RELAY_SPF',
		'MTA_BIMI_LOGO_URL',
		'MTA_BIMI_VMC_URL',
		'MTA_BIMI_SELECTOR',
		'SEND_TRANSPORT_INSTANCES',
		'SNDS_DATA_FEED_URLS',
	];

	// Whole-word match so MTA_BIMI_SELECTOR can't be satisfied by a longer name.
	const documents = (text: string, key: string) =>
		new RegExp(`(^|[^A-Za-z0-9_])${key}([^A-Za-z0-9_]|$)`).test(text);

	for (const key of knobs) {
		it(`${key} is a real EnvKey and both templates document it`, () => {
			expect(envKeySource).toContain(`| '${key}'`);
			expect(documents(contributorEnv, key)).toBe(true);
			expect(documents(selfhostEnv, key)).toBe(true);
		});
	}

	it('tells operators the VERP signing key is projected, never hand-copied', () => {
		// MTA_BOUNCE_VERP_KEY / MTA_RETURN_PATH_DOMAIN are the two knobs an
		// operator must NOT set: setup derives them from BOUNCE_VERP_KEY /
		// RETURN_PATH_DOMAIN, and a hand-copied signing key that differs by one
		// character mints tokens the MTA will never verify — which reads
		// downstream as "the relay arm produced no bounces", not as an error.
		expect(documents(selfhostEnv, 'MTA_BOUNCE_VERP_KEY')).toBe(true);
		expect(documents(selfhostEnv, 'MTA_RETURN_PATH_DOMAIN')).toBe(true);
		expect(selfhostEnv).not.toMatch(/^MTA_BOUNCE_VERP_KEY=/m);
		expect(selfhostEnv).not.toMatch(/^MTA_RETURN_PATH_DOMAIN=/m);
	});

	for (const key of knobs) {
		it(`${key} ships commented out, so copying the template enables nothing`, () => {
			expect(selfhostEnv).toMatch(new RegExp(`^# ${key}=`, 'm'));
			expect(selfhostEnv).not.toMatch(new RegExp(`^${key}=`, 'm'));
		});
	}

	/**
	 * The template's blocks are separated by `── … ──` rules; a phrase found
	 * anywhere in the file would let one block lose its reassurance while another
	 * block's copy keeps the assertion green.
	 */
	const blockContaining = (key: string) => {
		const index = selfhostEnv.indexOf(key);
		if (index === -1) throw new Error(`${key} is not in .env.selfhost.example`);
		const rules = [...selfhostEnv.matchAll(/^# ──.*$/gm)];
		const start = rules.filter((m) => m.index < index).at(-1)?.index ?? 0;
		const end = rules.find((m) => m.index > index)?.index ?? selfhostEnv.length;
		return selfhostEnv.slice(start, end);
	};

	it.each([
		['MTA_RETURN_PATH_RELAY_SPF', /[Uu]nset changes nothing and blocks nothing/],
		['MTA_BIMI_LOGO_URL', /never blocks a send/],
		['SNDS_DATA_FEED_URLS', /supported configuration/],
	])(
		'%s says in its own block that leaving it unset costs measurement, not sends',
		(key, phrase) => {
			// The one thing an operator template must not imply is that an unset
			// optional knob is a broken install.
			expect(blockContaining(key)).toMatch(phrase);
		}
	);

	it('warns that a named instance\'s "__" credentials are not pushed by setup', () => {
		// SEND_TRANSPORT_INSTANCES rides the push; the suffixed credentials it
		// names cannot (the suffix is operator-invented, so nothing enumerates
		// them). An operator who set both here would get a declared transport that
		// fails closed on its first send with nothing to read about why.
		const block = blockContaining('SEND_TRANSPORT_INSTANCES');
		expect(block).toMatch(/convex env set SMTP_RELAY_HOST__BACKUP/);
		expect(block).toMatch(/DO NOT GO IN THIS FILE/);
		expect(block).not.toMatch(/^# SMTP_RELAY_\w+__BACKUP=/m);
	});

	it('pushes the instance declaration and none of its suffixed credentials', () => {
		// The behaviour the warning describes. If a later piece teaches
		// selectRuntimeEnvVars to project the suffixed keys, this fails and the
		// template text above must be retired with it.
		const pushed = new Map(
			selectRuntimeEnvVars({
				SEND_TRANSPORT_INSTANCES: 'smtp#backup',
				SMTP_RELAY_HOST__BACKUP: 'smtp.postmarkapp.com',
				SMTP_RELAY_USERNAME__BACKUP: 'apikey',
				SMTP_RELAY_PASSWORD__BACKUP: 'secret',
			})
		);
		expect(pushed.get('SEND_TRANSPORT_INSTANCES')).toBe('smtp#backup');
		expect([...pushed.keys()].filter((key) => key.includes('__BACKUP'))).toEqual([]);
	});
});
