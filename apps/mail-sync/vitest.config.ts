import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['src/**/__tests__/**/*.test.ts'],
		environment: 'node',
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json-summary', 'html'],
			reportsDirectory: './coverage',
			include: ['src/**/*.ts'],
			// index.ts / server.ts boot the worker + HTTP server; connection.ts and
			// accountManager.ts are IMAP I/O. The pure mapping/parsing logic
			// (config, folders, ingest) is what the unit tests cover.
			exclude: ['src/**/__tests__/**', 'src/index.ts', 'src/server.ts'],
			thresholds: {
				lines: 20,
			},
		},
	},
});
