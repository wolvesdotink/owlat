/**
 * The enrolment QR, as SVG path data.
 *
 * Kept out of `accountTwoFactor.ts` because sign-in imports that module for
 * `requiresTwoFactor`, and sign-in is in the boot bundle: the QR encoder's
 * tables belong to the enrolment screen only. We take uqr's boolean matrix and
 * emit ONE `<path>` the template renders as data, so no QR dependency's SVG
 * string ever reaches `v-html`.
 */

import { encode } from 'uqr';

/** A QR ready to render as a single SVG `<path>`, with no markup string. */
export type TotpQrCode = {
	/** Modules per side. The viewBox is `0 0 size size`; one module is one unit. */
	size: number;
	/** The `d` attribute: one sub-path per horizontal run of dark modules. */
	path: string;
};

/**
 * Encode a TOTP URI as QR path data.
 *
 * Horizontal runs are merged into one rectangle each, which is what keeps the
 * path an order of magnitude shorter than a per-module `<rect>` soup and lets
 * the whole code live in the DOM as a single node.
 */
export function totpQrCode(uri: string): TotpQrCode {
	const { size, data } = encode(uri, { ecc: 'M', border: 1 });
	const segments: string[] = [];

	for (let y = 0; y < data.length; y++) {
		const row = data[y]!;
		let runStart = -1;
		for (let x = 0; x <= row.length; x++) {
			const dark = x < row.length && row[x] === true;
			if (dark && runStart === -1) runStart = x;
			if (!dark && runStart !== -1) {
				segments.push(`M${runStart} ${y}h${x - runStart}v1h-${x - runStart}z`);
				runStart = -1;
			}
		}
	}

	return { size, path: segments.join('') };
}
