/**
 * Hostile bodies for `stripRemoteImages`, shared by the counted-work tests
 * (postboxTrackers.test.ts) and the report-only timing benchmark
 * (postboxTrackers.perf.test.ts), so the benchmark times exactly the inputs the
 * tests hold to linear work. Each builds a body from a unit count `n`; `n` is
 * the smaller of the two sizes compared (the other is 4n).
 */

export interface HostileShape {
	name: string;
	n: number;
	build: (n: number) => string;
}

/** No `>` anywhere after the first tag: `<img\b[^>]*>` retried every start to the end. */
export const UNTERMINATED_IMG_FLOOD: HostileShape = {
	name: 'unterminated <img flood',
	n: 12_500,
	build: (n) => `<img src="https://evil.example/p.gif">${'<img src=x '.repeat(n)}`,
};

/**
 * The open quote swallows the rest of the input, so none of the later `<img`
 * starts is a tag to the browser; rescanning quote-aware from each would be
 * quadratic.
 */
export const UNTERMINATED_QUOTE: HostileShape = {
	name: 'unterminated quote over <img tags',
	n: 12_500,
	build: (n) =>
		`<img src="https://evil.example/p.gif"><p>x</p><img alt="open ${'<img src=https://evil.example/q.gif>'.repeat(n)}`,
};

/** Comments and raw-text elements the tokenizer steps over, repeated. */
export const SKIPPED_CONTEXT_FLOODS: readonly HostileShape[] = [
	'<!-- <img alt=" -->',
	'<style><img alt="</style>',
	'<!--x--x-',
	'<title>',
].map((unit) => ({
	name: `flood of ${unit}`,
	n: 12_500,
	build: (n: number) => `${unit.repeat(n)}<img src="https://cdn.example/a">`,
}));

export const HOSTILE_SHAPES: readonly HostileShape[] = [
	UNTERMINATED_IMG_FLOOD,
	UNTERMINATED_QUOTE,
	...SKIPPED_CONTEXT_FLOODS,
];
