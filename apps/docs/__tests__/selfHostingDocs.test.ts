import { describe, it, expect } from 'vitest';
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
	...walkMarkdown(resolve(repoRoot, 'apps/docs/content')),
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
		const selfHosting = byRel('apps/docs/content/3.developer/30.self-hosting.md');
		expect(selfHosting).toMatch(/CONVEX_SITE_URL/);
		expect(selfHosting).toMatch(/EnvVarNameForbidden|built-in/i);
	});

	it('the README profile table uses the real scan.files flag, not scan.attachments', () => {
		const readme = byRel('README.md');
		expect(readme).not.toMatch(/scan\.attachments/);
		expect(readme).toMatch(/scan\.files/);
	});

	it('the maintenance doc lists MTA_API_URL as a cause of "MTA can\'t send emails"', () => {
		const maintenance = byRel('apps/docs/content/3.developer/34.self-hosting-maintenance.md');
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
