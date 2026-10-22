/**
 * Minimal dotenv reading and writing for the dev stack's own files. Only the
 * `KEY=value` lines this module is asked to set are rewritten; comments,
 * blank lines and other keys stay as they were.
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

function unquote(value: string): string {
	if (value.length >= 2) {
		const first = value[0];
		if ((first === '"' || first === "'") && value.endsWith(first)) return value.slice(1, -1);
	}
	return value;
}

export function parseEnv(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of text.split('\n')) {
		const match = LINE.exec(line);
		if (match) out[match[1]!] = unquote(match[2]!);
	}
	return out;
}

export function readEnvFile(path: string): Record<string, string> {
	return existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
}

function serialize(key: string, value: string): string {
	if (/[\s#"'\\]/.test(value)) {
		throw new Error(`Refusing to write ${key}: its value needs quoting.`);
	}
	return `${key}=${value}`;
}

/** Returns `text` with every key in `entries` set, in place or appended. */
export function upsertEnv(text: string, entries: Record<string, string>): string {
	const pending = new Map(Object.entries(entries));
	const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
	const next = lines.map((line) => {
		const key = LINE.exec(line)?.[1];
		if (key === undefined || !pending.has(key)) return line;
		const value = pending.get(key)!;
		pending.delete(key);
		return serialize(key, value);
	});
	for (const [key, value] of pending) next.push(serialize(key, value));
	return `${next.join('\n')}\n`;
}

/** Sets `entries` in the env file at `path` and keeps it owner-only. */
export function writeEnvFile(path: string, entries: Record<string, string>): void {
	const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
	writeFileSync(path, upsertEnv(current, entries), { mode: 0o600 });
	chmodSync(path, 0o600);
}

/**
 * The admin key from `generate_admin_key.sh` output: its last long token,
 * keeping a `name|hex` prefix intact. Same rule the setup CLI and the release
 * e2e use, so a change in the script's banner does not break any of them.
 */
export function parseAdminKey(output: string): string | null {
	const tokens = output.match(/[A-Za-z0-9_|+/=-]{20,}/g);
	return tokens?.at(-1) ?? null;
}
