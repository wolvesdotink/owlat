import { readdir, readFile } from 'node:fs/promises';
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
