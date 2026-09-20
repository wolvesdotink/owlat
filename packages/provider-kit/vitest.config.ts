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
			// One 32-statement file: a single uncovered branch moves the number
			// by ~3 points, so the floor sits well under the measured 93.75/93.54
			// rather than one edge case away from failing.
			thresholds: {
				lines: 85,
				branches: 80,
			},
		},
	},
});
