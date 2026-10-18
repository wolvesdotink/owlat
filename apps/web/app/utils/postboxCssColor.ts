/**
 * CSS color parsing and WCAG contrast math for the Postbox dark-mode adapter.
 */

export interface Rgba {
	r: number;
	g: number;
	b: number;
	a: number;
}

/** The CSS named colors, as `name:hex` pairs. */
const NAMED_COLORS: Record<string, string> = Object.fromEntries(
	`
	aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 azure:f0ffff
	beige:f5f5dc bisque:ffe4c4 black:000000 blanchedalmond:ffebcd blue:0000ff
	blueviolet:8a2be2 brown:a52a2a burlywood:deb887 cadetblue:5f9ea0 chartreuse:7fff00
	chocolate:d2691e coral:ff7f50 cornflowerblue:6495ed cornsilk:fff8dc crimson:dc143c
	cyan:00ffff darkblue:00008b darkcyan:008b8b darkgoldenrod:b8860b darkgray:a9a9a9
	darkgreen:006400 darkgrey:a9a9a9 darkkhaki:bdb76b darkmagenta:8b008b
	darkolivegreen:556b2f darkorange:ff8c00 darkorchid:9932cc darkred:8b0000
	darksalmon:e9967a darkseagreen:8fbc8f darkslateblue:483d8b darkslategray:2f4f4f
	darkslategrey:2f4f4f darkturquoise:00ced1 darkviolet:9400d3 deeppink:ff1493
	deepskyblue:00bfff dimgray:696969 dimgrey:696969 dodgerblue:1e90ff firebrick:b22222
	floralwhite:fffaf0 forestgreen:228b22 fuchsia:ff00ff gainsboro:dcdcdc ghostwhite:f8f8ff
	gold:ffd700 goldenrod:daa520 gray:808080 green:008000 greenyellow:adff2f grey:808080
	honeydew:f0fff0 hotpink:ff69b4 indianred:cd5c5c indigo:4b0082 ivory:fffff0 khaki:f0e68c
	lavender:e6e6fa lavenderblush:fff0f5 lawngreen:7cfc00 lemonchiffon:fffacd
	lightblue:add8e6 lightcoral:f08080 lightcyan:e0ffff lightgoldenrodyellow:fafad2
	lightgray:d3d3d3 lightgreen:90ee90 lightgrey:d3d3d3 lightpink:ffb6c1 lightsalmon:ffa07a
	lightseagreen:20b2aa lightskyblue:87cefa lightslategray:778899 lightslategrey:778899
	lightsteelblue:b0c4de lightyellow:ffffe0 lime:00ff00 limegreen:32cd32 linen:faf0e6
	magenta:ff00ff maroon:800000 mediumaquamarine:66cdaa mediumblue:0000cd
	mediumorchid:ba55d3 mediumpurple:9370db mediumseagreen:3cb371 mediumslateblue:7b68ee
	mediumspringgreen:00fa9a mediumturquoise:48d1cc mediumvioletred:c71585
	midnightblue:191970 mintcream:f5fffa mistyrose:ffe4e1 moccasin:ffe4b5 navajowhite:ffdead
	navy:000080 oldlace:fdf5e6 olive:808000 olivedrab:6b8e23 orange:ffa500 orangered:ff4500
	orchid:da70d6 palegoldenrod:eee8aa palegreen:98fb98 paleturquoise:afeeee
	palevioletred:db7093 papayawhip:ffefd5 peachpuff:ffdab9 peru:cd853f pink:ffc0cb
	plum:dda0dd powderblue:b0e0e6 purple:800080 rebeccapurple:663399 red:ff0000
	rosybrown:bc8f8f royalblue:4169e1 saddlebrown:8b4513 salmon:fa8072 sandybrown:f4a460
	seagreen:2e8b57 seashell:fff5ee sienna:a0522d silver:c0c0c0 skyblue:87ceeb
	slateblue:6a5acd slategray:708090 slategrey:708090 snow:fffafa springgreen:00ff7f
	steelblue:4682b4 tan:d2b48c teal:008080 thistle:d8bfd8 tomato:ff6347 turquoise:40e0d0
	violet:ee82ee wheat:f5deb3 white:ffffff whitesmoke:f5f5f5 yellow:ffff00
	yellowgreen:9acd32
`
		.trim()
		.split(/\s+/)
		.map((pair) => {
			const [name, hex] = pair.split(':');
			return [name!, `#${hex}`];
		})
);

const NUMBER = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(%|deg)?$/;

function parseNumber(raw: string): { n: number; unit: string } | null {
	const m = raw.match(NUMBER);
	return m ? { n: Number(m[1]), unit: m[2] ?? '' } : null;
}

const clamp = (n: number, max: number) => Math.min(max, Math.max(0, n));

/**
 * Parses the arguments of rgb()/rgba()/hsl()/hsla(), comma- or
 * space-separated, with an optional `/ alpha`, numbers or percentages.
 */
function parseColorFunction(isHsl: boolean, args: string): Rgba | null {
	const parts = args
		.trim()
		.split(/\s*[,/]\s*|\s+/)
		.filter(Boolean)
		.map(parseNumber);
	if ((parts.length !== 3 && parts.length !== 4) || parts.some((p) => p === null)) return null;
	const [x, y, z, alphaPart] = parts as Array<{ n: number; unit: string }>;
	const a = alphaPart ? clamp(alphaPart.unit === '%' ? alphaPart.n / 100 : alphaPart.n, 1) : 1;
	if (!isHsl) {
		const channel = (p: { n: number; unit: string }) =>
			Math.round(clamp(p.unit === '%' ? p.n * 2.55 : p.n, 255));
		if ([x!, y!, z!].some((p) => p.unit === 'deg')) return null;
		return { r: channel(x!), g: channel(y!), b: channel(z!), a };
	}
	if (y!.unit !== '%' || z!.unit !== '%') return null;
	const h = (((x!.n % 360) + 360) % 360) / 360;
	const sat = clamp(y!.n, 100) / 100;
	const light = clamp(z!.n, 100) / 100;
	const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
	const p = 2 * light - q;
	const hue = (t: number) => {
		const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
		if (u < 1 / 6) return p + (q - p) * 6 * u;
		if (u < 1 / 2) return q;
		if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
		return p;
	};
	return {
		r: Math.round(hue(h + 1 / 3) * 255),
		g: Math.round(hue(h) * 255),
		b: Math.round(hue(h - 1 / 3) * 255),
		a,
	};
}

/**
 * Parses a CSS color value (hex, rgb()/rgba(), hsl()/hsla(), common named
 * colors).
 * Returns null for anything unparseable (gradients, var(), currentColor…) —
 * callers must treat null as "do not touch".
 */
export function parseCssColor(raw: string): Rgba | null {
	const value = raw.trim().toLowerCase();
	if (value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
	const named = NAMED_COLORS[value];
	const v = named ?? value;

	const hexMatch = v.match(/^#([0-9a-f]{3,8})$/);
	if (hexMatch?.[1]) {
		const hex = hexMatch[1];
		if (hex.length === 3 || hex.length === 4) {
			const r = parseInt(hex[0]! + hex[0]!, 16);
			const g = parseInt(hex[1]! + hex[1]!, 16);
			const b = parseInt(hex[2]! + hex[2]!, 16);
			const a = hex.length === 4 ? parseInt(hex[3]! + hex[3]!, 16) / 255 : 1;
			return { r, g, b, a };
		}
		if (hex.length === 6 || hex.length === 8) {
			const r = parseInt(hex.slice(0, 2), 16);
			const g = parseInt(hex.slice(2, 4), 16);
			const b = parseInt(hex.slice(4, 6), 16);
			const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
			return { r, g, b, a };
		}
		return null;
	}

	const fnMatch = v.match(/^(rgba?|hsla?)\(([^()]*)\)$/);
	if (fnMatch) return parseColorFunction(fnMatch[1]!.startsWith('hsl'), fnMatch[2]!);

	return null;
}

/** WCAG relative luminance (0 = black, 1 = white). */
export function relativeLuminance({ r, g, b }: Rgba): number {
	const channel = (c: number) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
	};
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two colors (1..21). */
export function contrastRatio(a: Rgba, b: Rgba): number {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
	return (hi + 0.05) / (lo + 0.05);
}

export const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };

/** `top` painted over an opaque `bottom`. */
export function composite(top: Rgba, bottom: Rgba): Rgba {
	const mix = (t: number, b: number) => Math.round(t * top.a + b * (1 - top.a));
	return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 };
}

export function toCss({ r, g, b }: Rgba): string {
	const hex = (n: number) => n.toString(16).padStart(2, '0');
	return `#${hex(r)}${hex(g)}${hex(b)}`;
}
