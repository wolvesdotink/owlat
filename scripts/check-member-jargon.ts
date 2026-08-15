import { access, readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const workspace = join(import.meta.dirname, '..');
const roots = [
	join(workspace, 'apps/web/app/components/postbox'),
	join(workspace, 'apps/web/app/pages/dashboard/preferences'),
	join(workspace, 'apps/web/app/pages/dashboard/postbox/migrate.vue'),
];
const allowlisted = new Set([
	'apps/web/app/components/postbox/PostboxMailboxConnectForm.vue',
	'apps/web/app/components/postbox/PostboxMailboxMove.vue',
	'apps/web/app/pages/dashboard/preferences/app-passwords.vue',
]);
const jargon = /\b(?:SPF|DKIM|DMARC|IMAP|SMTP)\b|\bMX records?\b/g;

/**
 * THE COPY MOVED; THE GATE FOLLOWS IT.
 *
 * Since the UI was localized, a member-visible template holds key paths, not
 * sentences — the words a member actually reads live in the message catalog.
 * A gate that kept reading only templates would scan surfaces that no longer
 * carry any copy and pass forever, so every literal `t('…')`/`te('…')`/
 * `keypath="…"` reference a surface makes is resolved against the `en` catalog
 * and the resolved MESSAGE is what gets read for jargon. Dynamic keys
 * (t(`x.${y}`)) are invisible to this, exactly as dynamic text always was.
 *
 * The catalog is optional on purpose: the self-test copies this script into a
 * sandbox without one, and a missing catalog must mean "no messages to read",
 * not a crash.
 */
const catalog = new Map<string, string>();
try {
	const parsed = JSON.parse(
		await readFile(join(workspace, 'apps/web/i18n/locales/en.json'), 'utf8')
	) as Record<string, unknown>;
	const walk = (node: Record<string, unknown>, prefix: string) => {
		for (const [key, value] of Object.entries(node)) {
			const path = prefix === '' ? key : `${prefix}.${key}`;
			if (typeof value === 'string') catalog.set(path, value);
			else if (value !== null && typeof value === 'object')
				walk(value as Record<string, unknown>, path);
		}
	};
	walk(parsed, '');
} catch {
	// No catalog in this workspace — the template half still runs.
}

const KEY_REFERENCE = /(?:\bte?\(\s*|keypath=)['"]([A-Za-z][\w-]*(?:\.[\w-]+)+)['"]/g;

/** The jargon a member reads via the catalog: each referenced message, resolved. */
function messageHits(source: string): string[] {
	const hits: string[] = [];
	const seen = new Set<string>();
	for (const match of source.matchAll(KEY_REFERENCE)) {
		const key = match[1];
		if (key === undefined || seen.has(key)) continue;
		seen.add(key);
		const message = catalog.get(key);
		if (message !== undefined && jargon.test(message)) hits.push(`${key}: ${message.trim()}`);
		jargon.lastIndex = 0;
	}
	return hits;
}

async function vueFiles(path: string): Promise<string[]> {
	const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
	if (entries.length === 0) return path.endsWith('.vue') ? [path] : [];
	const nested = await Promise.all(
		entries.map((entry) => {
			const child = join(path, entry.name);
			return entry.isDirectory() ? vueFiles(child) : entry.name.endsWith('.vue') ? [child] : [];
		})
	);
	return nested.flat();
}

async function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false
	);
}

/**
 * EVERY PATH THIS SCRIPT NAMES HAS TO BE REAL.
 *
 * Both halves of the configuration fail SILENTLY when a file moves: a root that
 * no longer exists walks to an empty list (`readdir` is caught and returns
 * `[]`), and an allowlist entry that no longer exists excuses nothing while
 * still reading like sanctioned debt. Either way the gate keeps printing
 * nothing, so a rename is indistinguishable from a clean surface — which is the
 * one failure mode a lint gate must not have. Checking existence is what makes
 * a rename a build failure that names the stale line instead.
 */
const stale = [
	...(await Promise.all(
		roots.map(async (root) =>
			(await exists(root)) ? null : `member-visible root: ${relative(workspace, root)}`
		)
	)),
	...(await Promise.all(
		[...allowlisted].map(async (name) =>
			(await exists(join(workspace, name))) ? null : `allowlist entry: ${name}`
		)
	)),
].filter((entry): entry is string => entry !== null);

if (stale.length > 0) {
	console.error(
		'Stale member-jargon configuration — these paths do not exist. Point the line at where the surface moved, or delete it:'
	);
	console.error(stale.join('\n'));
	process.exit(1);
}

const OPEN = '<template>';

/**
 * The jargon a member actually reads: the root template, comments blanked.
 *
 * GREEDY TO THE LAST `</template>`. A Vue SFC nests `<template v-if>` inside its
 * root template, and a non-greedy match ended the read at the first NESTED close
 * — on PostboxMailboxMove.vue that was line 166 of 390, so the four `MX record`
 * strings a member is looking at were never read, and the ratchet's other
 * direction reported a hard-working exemption as unused. Every branch of a
 * conditional surface is member-visible, so all of them get read.
 */
function jargonHits(source: string): string[] {
	const match = source.match(/<template>([\s\S]*)<\/template>/);
	if (match?.[1] === undefined) return [];
	// Comments are BLANKED, not deleted: a multi-line comment that collapses to
	// nothing renumbers every line under it, and a report has to name a line
	// someone can open.
	const visible = match[1].replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ''));
	// The template rarely starts on line 1 (a `<script setup>` block usually comes
	// first), so hits are numbered from where the template content begins.
	const offset = source.slice(0, (match.index ?? 0) + OPEN.length).split('\n').length - 1;
	const hits: string[] = [];
	visible.split('\n').forEach((line, index) => {
		if (jargon.test(line)) hits.push(`${offset + index + 1}: ${line.trim()}`);
		jargon.lastIndex = 0;
	});
	return hits;
}

/**
 * ALLOWLISTED FILES ARE READ, NOT SKIPPED.
 *
 * The list is strict in BOTH directions, like the provider-identity and
 * file-size baselines: an unlisted surface that says `SPF` fails, and a LISTED
 * surface that has stopped saying it fails too. Skipping the read would only
 * answer the first half. An exemption whose file still exists but whose template
 * has since been rewritten in plain words is invisible to an existence check —
 * it excuses nothing today and quietly pre-approves the regression that puts the
 * jargon back tomorrow, which is the one thing an exemption must never do.
 */
const violations: string[] = [];
const exercised = new Set<string>();
const scanned = new Set<string>();
for (const root of roots) {
	for (const file of await vueFiles(root)) {
		const name = relative(workspace, file);
		// Roots may overlap (a directory and a file inside it); read each file once.
		if (scanned.has(name)) continue;
		scanned.add(name);
		const source = await readFile(file, 'utf8');
		const hits = [...jargonHits(source), ...messageHits(source)];
		if (allowlisted.has(name)) {
			if (hits.length > 0) exercised.add(name);
			continue;
		}
		violations.push(...hits.map((hit) => `${name}:${hit}`));
	}
}

/**
 * `scanned` is what separates the two ways an entry can excuse nothing. A file
 * the walk never reached — a path under no root, or a non-`.vue` file the walk
 * ignores — is not jargon-free, it is unread, and telling someone to plainen a
 * template that was never checked sends them at the wrong edit. Both remedies
 * are the same line deletion, so they are one report with the reason named.
 */
const unused = [...allowlisted]
	.filter((name) => !exercised.has(name))
	.map((name) =>
		scanned.has(name)
			? `${name} (neither its template nor the catalog messages it renders say any of it any more)`
			: `${name} (no member-visible root reaches it)`
	);

if (violations.length > 0) {
	console.error('Protocol jargon leaked into a member-visible L1 surface:');
	console.error(violations.join('\n'));
}

// Reported ALONGSIDE the violations above, not instead of them: both verdicts
// come out of the same completed scan, they are independent edits, and hiding
// one behind the other turns a single fix into two round trips. (A stale PATH is
// different and still exits early — a configuration naming a file that is not
// there means the scan itself cannot be trusted.)
if (unused.length > 0) {
	console.error(
		'Unused member-jargon exemption — these allowlist entries excuse nothing, so they only widen what can regress. Delete the line:'
	);
	console.error(unused.join('\n'));
}

if (violations.length > 0 || unused.length > 0) process.exit(1);
