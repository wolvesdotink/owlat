import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
	test: {
		include: ['src/**/__tests__/**/*.test.ts'],
		environment: 'node',
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json-summary', 'html'],
			reportsDirectory: './coverage',
			include: ['src/**/*.ts'],
			exclude: ['src/**/__tests__/**', 'src/index.ts'],
			thresholds: {
				lines: 90,
				// Branch coverage is enforced (plan doctrine) — the DKIM verify core,
				// canon, and key-record parsing all carry security-relevant branches
				// (l= cap, x= expiry, key/alg mismatch, hash restriction, PERMFAIL
				// paths) that must each be exercised, not just line-covered.
				branches: 85,
			},
		},
	},
	resolve: {
		alias: {
			'@': resolve(__dirname, 'src'),
		},
	},
});
