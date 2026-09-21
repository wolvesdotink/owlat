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
			// index.ts is the process entry point (TLS, signals, Redis wiring) and
			// logger.ts is a thin pino wrapper; neither is exercised by unit tests.
			// The protocol surface — parser, commands, mime, config — is.
			exclude: ['src/**/__tests__/**', 'src/index.ts', 'src/logger.ts'],
			thresholds: {
				lines: 78,
				branches: 70,
			},
		},
	},
});
