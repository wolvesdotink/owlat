import { nodePackageConfig } from '../../vitest.shared';

export default nodePackageConfig({
	coverage: {
		lines: 78,
		thresholds: { branches: 70 },
		// index.ts is the process entry point (TLS, signals, Redis wiring) and
		// logger.ts is a thin pino wrapper; neither is exercised by unit tests.
		// The protocol surface — parser, commands, mime, config — is.
		exclude: ['src/index.ts', 'src/logger.ts'],
	},
});
