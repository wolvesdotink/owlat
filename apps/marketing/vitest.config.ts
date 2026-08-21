import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
	test: {
		include: ['**/__tests__/**/*.test.ts'],
		exclude: ['node_modules/**', '.nuxt/**', '.output/**'],
		environment: 'node',
	},
	resolve: {
		alias: [
			// `~~` (Nuxt rootDir) must precede `~` — string aliases match in order,
			// and `~` would otherwise swallow the `~~/i18n/...` imports.
			{ find: '~~', replacement: resolve(rootDir, '.') },
			{ find: '~', replacement: resolve(rootDir, 'app') },
		],
	},
});
