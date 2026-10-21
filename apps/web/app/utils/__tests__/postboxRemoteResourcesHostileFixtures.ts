/**
 * Hostile bodies for `applyPostboxImageConsent`, shared by the counted-work
 * tests (postboxRemoteResources.test.ts) and the report-only timing benchmark
 * (postboxRemoteResources.perf.test.ts), so the benchmark times exactly the
 * inputs the tests hold to linear work. Each builds a body from a unit count
 * `n`; `n` is the smaller of the two sizes compared (the other is 4n).
 */
import type { PostboxImageConsent } from '../postboxRemoteResources';

export interface HostileBody {
	name: string;
	n: number;
	consent: PostboxImageConsent;
	build: (n: number) => string;
}

/** A trailing-comma URL whose inner comma run `/,+$/` rescanned from every comma. */
export const SRCSET_COMMAS: HostileBody = {
	name: 'srcset with a long comma run',
	n: 25_000,
	consent: 'blocked',
	build: (n) =>
		`<img srcset="https://cdn.example/a${','.repeat(n)}b, https://cdn.example/p.png 2x">`,
};

/** Deep function nesting, then strings that open and never close. */
export const NESTED_CSS: HostileBody = {
	name: 'deeply nested, unterminated CSS',
	n: 5_000,
	consent: 'blocked',
	build: (n) => `<div style="background:${'f('.repeat(n)}${'url(&quot;'.repeat(n)}">x</div>`,
};

/** Many CSS URLs on one element: per-URL style rescans made 4x the URLs cost about 13x. */
export const MANY_CSS_URLS: HostileBody = {
	name: 'CSS urls on one element',
	n: 8_000,
	consent: 'images',
	build: (n) => {
		const urls = Array.from({ length: n }, (_, i) => `url(https://cdn.example/${i}.png)`);
		return `<div style="width:600px;height:400px;background:${urls.join(',')}">a</div>`;
	},
};

export const HOSTILE_BODIES: readonly HostileBody[] = [SRCSET_COMMAS, NESTED_CSS, MANY_CSS_URLS];
