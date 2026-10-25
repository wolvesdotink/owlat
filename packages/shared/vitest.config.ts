import { nodePackageConfig } from '../../vitest.shared';

export default nodePackageConfig({
	// The hostile-input suites (mailSegmentsHostile, postboxTrackers) run their
	// parsers over inputs large enough that quadratic work would show, and the
	// TLS reloader generates real certificates with openssl. That work is fixed
	// per test and grows several-fold on a contended runner; the guards count
	// work, never time.
	timeout: 'parallel-gate',
	coverage: { lines: 80 },
});
