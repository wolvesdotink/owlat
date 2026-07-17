import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
	test: {
		include: ['__tests__/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
		environment: 'node',
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json-summary', 'html'],
			reportsDirectory: './coverage',
			include: ['src/**/*.ts'],
			exclude: ['src/**/__tests__/**', '__tests__/**', 'src/index.ts'],
			thresholds: {
				// R2 ratchet (U6 doctrine): the compose side is raised to the parse
				// side's >=90 line gate now that its differential + the golden corpus
				// exercise it, and the package-wide floor U0 had to drop to 20 during
				// the restructure is restored to 90. Never lower these — measured line
				// coverage is ~99% package-wide, every compose file >=94%.
				'src/parse/**': {
					lines: 90,
				},
				'src/compose/**': {
					lines: 90,
				},
				lines: 90,
			},
		},
	},
	resolve: {
		alias: {
			'@': resolve(__dirname, 'src'),
		},
	},
});
