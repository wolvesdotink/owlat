import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// The tests sit beside their subject here rather than under __tests__,
		// so the include pattern is wider than the sibling kits'.
		include: ['src/**/*.test.ts'],
		environment: 'node',
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json-summary', 'html'],
			reportsDirectory: './coverage',
			include: ['src/**/*.ts'],
			exclude: ['src/**/*.test.ts', 'src/index.ts'],
			thresholds: {
				lines: 90,
				branches: 85,
			},
		},
	},
});
