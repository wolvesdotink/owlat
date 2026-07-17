import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
	test: {
		include: ['__tests__/**/*.test.ts'],
		environment: 'node',
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json-summary', 'html'],
			reportsDirectory: './coverage',
			include: ['src/**/*.ts'],
			exclude: ['src/**/__tests__/**', '__tests__/**'],
			thresholds: {
				// R2 ratchet: smtp-client meets the same >=90 line bar as the other
				// three new mail packages (U6). The long-tail quirk integration suite
				// (`__tests__/quirks.integration.test.ts`) exercises the reply framer,
				// STARTTLS refusal and mid-transaction failure paths that carry it
				// over the line. Never lower this.
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
