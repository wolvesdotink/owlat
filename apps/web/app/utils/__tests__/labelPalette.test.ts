// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LABEL_PRESET_COLORS } from '../labelPalette';

// The Fluid Functionalism token source of truth. Each preset must map to one of
// these `--color-*` declarations, proving the palette is derived from FF tokens
// rather than a hand-copied swatch.
const tokensCss = readFileSync(
	fileURLToPath(new URL('../../../../../packages/ui/assets/css/tokens.css', import.meta.url)),
	'utf8'
);

function tokenHex(token: string): string | null {
	const match = tokensCss.match(new RegExp(`--color-${token}:\\s*(#[0-9a-fA-F]{3,8})`));
	return match ? match[1]!.toLowerCase() : null;
}

describe('LABEL_PRESET_COLORS', () => {
	it('derives every preset hex from its named FF token', () => {
		expect(LABEL_PRESET_COLORS.length).toBeGreaterThan(0);
		for (const preset of LABEL_PRESET_COLORS) {
			expect(tokenHex(preset.token), `token --color-${preset.token} in tokens.css`).toBe(
				preset.hex.toLowerCase()
			);
		}
	});
});
