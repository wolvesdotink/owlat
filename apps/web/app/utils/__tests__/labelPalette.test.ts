import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	DEFAULT_LABEL_COLOR,
	LABEL_PRESET_COLORS,
	LABEL_PRESET_HEXES,
} from '../labelPalette';

// The Fluid Functionalism token source of truth. Each preset must map to one of
// these `--color-*` declarations, proving the palette is derived from FF tokens
// rather than the old generic Tailwind swatches (#0a6cdd, #10b981, …).
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
		for (const preset of LABEL_PRESET_COLORS) {
			expect(tokenHex(preset.token), `token --color-${preset.token} in tokens.css`).toBe(
				preset.hex.toLowerCase()
			);
		}
	});

	it('carries no generic Tailwind swatch from the old inline palette', () => {
		const retired = ['#0a6cdd', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#6b7280'];
		for (const hex of retired) {
			expect(LABEL_PRESET_HEXES).not.toContain(hex);
		}
	});

	it('exposes hexes in preset order and defaults to the brand accent', () => {
		expect(LABEL_PRESET_HEXES).toEqual(LABEL_PRESET_COLORS.map((c) => c.hex));
		expect(DEFAULT_LABEL_COLOR).toBe(LABEL_PRESET_HEXES[0]);
		expect(LABEL_PRESET_COLORS[0]!.token).toBe('brand');
	});
});
