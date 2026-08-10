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
	'apps/web/app/components/postbox/PostboxSecurityBadge.vue',
	'apps/web/app/pages/dashboard/preferences/app-passwords.vue',
]);
const jargon = /\b(?:SPF|DKIM|DMARC|IMAP|SMTP)\b|\bMX records?\b/g;

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

const violations: string[] = [];
for (const root of roots) {
	for (const file of await vueFiles(root)) {
		const name = relative(workspace, file);
		if (allowlisted.has(name)) continue;
		const source = await readFile(file, 'utf8');
		const template = source.match(/<template>([\s\S]*?)<\/template>/)?.[1] ?? '';
		const visible = template.replace(/<!--[\s\S]*?-->/g, '');
		visible.split('\n').forEach((line, index) => {
			if (jargon.test(line)) violations.push(`${name}:${index + 1}: ${line.trim()}`);
			jargon.lastIndex = 0;
		});
	}
}

if (violations.length > 0) {
	console.error('Protocol jargon leaked into a member-visible L1 surface:');
	console.error(violations.join('\n'));
	process.exit(1);
}
