// @vitest-environment happy-dom
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { usePostboxChunkWarmup, type ChunkLoader } from '../usePostboxChunkWarmup';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

function vueFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) return entry === '__tests__' ? [] : vueFiles(path);
		return path.endsWith('.vue') ? [path] : [];
	});
}

/** Nuxt's auto-import name for `~/components/<dirs>/<File>.vue` (prefix de-duplicated). */
function nuxtComponentName(componentPath: string): string {
	const segments = componentPath.replace(/\.vue$/, '').split('/');
	const file = segments.pop()!;
	const prefix = segments
		.map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
		.join('');
	return file.startsWith(prefix) ? file : `${prefix}${file}`;
}

/** A synchronous scheduler so the warm-up body runs immediately. */
const runNow = (cb: () => void) => cb();
/** Loaders are dispatched in a microtask (fail-soft isolation); drain them. */
const flush = async () => {
	await Promise.resolve();
	await Promise.resolve();
};

describe('usePostboxChunkWarmup', () => {
	it('invokes every loader once when warmed', async () => {
		const a: ChunkLoader = vi.fn(() => Promise.resolve());
		const b: ChunkLoader = vi.fn(() => Promise.resolve());
		const { warm } = usePostboxChunkWarmup({ loaders: [a, b], schedule: runNow });

		warm();
		await flush();

		expect(a).toHaveBeenCalledTimes(1);
		expect(b).toHaveBeenCalledTimes(1);
	});

	it('is idempotent — repeated warms do not re-load chunks', async () => {
		const loader: ChunkLoader = vi.fn(() => Promise.resolve());
		const { warm } = usePostboxChunkWarmup({ loaders: [loader], schedule: runNow });

		warm();
		warm();
		warm();
		await flush();

		expect(loader).toHaveBeenCalledTimes(1);
	});

	it('defers work to the scheduler rather than running loaders eagerly', async () => {
		const loader: ChunkLoader = vi.fn(() => Promise.resolve());
		const scheduled: Array<() => void> = [];
		const schedule = (cb: () => void) => {
			scheduled.push(cb);
		};
		const { warm } = usePostboxChunkWarmup({ loaders: [loader], schedule });

		warm();
		// Scheduled but not yet run.
		expect(loader).not.toHaveBeenCalled();
		expect(scheduled).toHaveLength(1);

		scheduled[0]!();
		await flush();
		expect(loader).toHaveBeenCalledTimes(1);
	});

	it('is fail-soft: a throwing loader does not break the others', async () => {
		const bad: ChunkLoader = vi.fn(() => {
			throw new Error('chunk 404');
		});
		const good: ChunkLoader = vi.fn(() => Promise.resolve());
		const { warm } = usePostboxChunkWarmup({ loaders: [bad, good], schedule: runNow });

		expect(() => warm()).not.toThrow();
		await flush();
		expect(good).toHaveBeenCalledTimes(1);
	});

	it('swallows a rejected loader promise', async () => {
		const rejecting: ChunkLoader = vi.fn(() => Promise.reject(new Error('network')));
		const { warm } = usePostboxChunkWarmup({ loaders: [rejecting], schedule: runNow });

		warm();
		await flush();
		expect(rejecting).toHaveBeenCalledTimes(1);
	});

	// A warmed module the app imports statically is already in the chunk that
	// imports it, so the "warm-up" would fetch nothing. Every default loader must
	// point at a component some template mounts through its lazy `<Lazy…>` name.
	it('warms only modules the app mounts behind a lazy boundary', () => {
		const source = readFileSync(
			join(appRoot, 'composables/postbox/usePostboxChunkWarmup.ts'),
			'utf8'
		);
		const warmed = [...source.matchAll(/import\('~\/components\/([^']+\.vue)'\)/g)].map(
			(match) => match[1]!
		);
		expect(warmed.length).toBeGreaterThan(0);

		const templates = vueFiles(appRoot).map((file) => readFileSync(file, 'utf8'));
		for (const componentPath of warmed) {
			const lazyTag = `<Lazy${nuxtComponentName(componentPath)}`;
			expect(
				templates.some((template) => template.includes(lazyTag)),
				`${componentPath} is warmed but nothing mounts ${lazyTag}`
			).toBe(true);
		}
	});
});
