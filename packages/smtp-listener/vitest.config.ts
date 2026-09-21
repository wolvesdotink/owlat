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
			// `smtpTestClient.ts` is the suites' own driver (see its header: it lives
			// in src/ only so apps/mta can import ONE copy). Measuring the harness
			// against the listener's coverage floor would report the harness, not
			// the listener.
			exclude: ['src/**/__tests__/**', 'src/index.ts', 'src/types.ts', 'src/smtpTestClient.ts'],
			thresholds: {
				lines: 90,
				branches: 80,
			},
		},
	},
	resolve: {
		alias: {
			'@': resolve(__dirname, 'src'),
		},
	},
});
