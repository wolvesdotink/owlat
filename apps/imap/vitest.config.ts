import { nodePackageConfig } from '../../vitest.shared';

export default nodePackageConfig({
	// Several suites pay a fixed cost a contended runner multiplies: real TCP and
	// TLS servers with openssl-generated certificates, a 75 MiB FETCH paced
	// through a real socket, and folder-pattern inputs sized so that a matcher
	// that backtracks would run for minutes. Their guards count work and bytes,
	// never time.
	timeout: 'parallel-gate',
	coverage: {
		lines: 78,
		thresholds: { branches: 70 },
		// index.ts is the process entry point (TLS, signals, Redis wiring) and
		// logger.ts is a thin pino wrapper; neither is exercised by unit tests.
		// The protocol surface — parser, commands, mime, config — is.
		exclude: ['src/index.ts', 'src/logger.ts'],
	},
});
