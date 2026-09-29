import { nodePackageConfig } from '../../vitest.shared';

// Every Tauri module is mocked and the whole suite runs in well under a second,
// so it keeps vitest's default time budget.
export default nodePackageConfig({
	// Measured 55.17% on 2026-09-28; two points of headroom
	// (scripts/quality-ratchets.md).
	coverage: { lines: 53 },
});
