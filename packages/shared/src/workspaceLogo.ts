/**
 * The workspace logo: what an admin may upload and how the stored bytes are
 * checked.
 *
 * Shared so the upload control's `accept` list and size message, the Convex
 * mutation's gate and the byte check behind it cannot drift apart: a file the
 * picker offers that the server rejects is a logo nobody can set.
 *
 * The logo is shown on public pages (sign-in, unsubscribe, preferences,
 * invitations), so it stays small. 512 KB is several times what a logo needs
 * and keeps a careless photo upload off every recipient's phone.
 */

export const WORKSPACE_LOGO_MIME_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml'] as const;

export type WorkspaceLogoMimeType = (typeof WORKSPACE_LOGO_MIME_TYPES)[number];

export const MAX_WORKSPACE_LOGO_BYTES = 512 * 1024;

/**
 * Which logo slot a file goes in. `dark` is optional: it is drawn on dark
 * backgrounds, and without it the light logo is shown there instead.
 */
export const WORKSPACE_LOGO_VARIANTS = ['light', 'dark'] as const;

export type WorkspaceLogoVariant = (typeof WORKSPACE_LOGO_VARIANTS)[number];

export function isWorkspaceLogoMimeType(value: string): value is WorkspaceLogoMimeType {
	return (WORKSPACE_LOGO_MIME_TYPES as readonly string[]).includes(value);
}

/**
 * Why a file cannot be a workspace logo, or `null` when it can.
 *
 * Checks only what the browser can see before uploading (declared type and
 * size); the server repeats both and then checks the bytes themselves with
 * {@link workspaceLogoBytesProblem}.
 */
export function workspaceLogoFileProblem(file: {
	type: string;
	size: number;
}): 'type' | 'size' | 'empty' | null {
	if (!isWorkspaceLogoMimeType(file.type)) return 'type';
	if (file.size <= 0) return 'empty';
	if (file.size > MAX_WORKSPACE_LOGO_BYTES) return 'size';
	return null;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
	return signature.every((byte, i) => bytes[i] === byte);
}

/**
 * Markup an SVG logo must not carry. The logo is served from file storage
 * under its own content type, so opening its URL directly renders it as a
 * document, where scripts and event handlers would run. An `<img>` never runs
 * them, but the URL is public.
 */
const UNSAFE_SVG_PATTERNS: readonly RegExp[] = [
	/<script[\s>/]/i,
	/<foreignObject[\s>/]/i,
	/\son[a-z]+\s*=/i,
	/javascript:/i,
	/<!ENTITY/i,
];

/**
 * Why stored bytes do not match the declared logo type, or `null` when they
 * do. The declared type comes from the browser, so the server checks the file
 * signature before the logo is trusted on public pages.
 */
export function workspaceLogoBytesProblem(
	mimeType: string,
	bytes: Uint8Array
): 'signature' | 'unsafe-svg' | null {
	switch (mimeType) {
		case 'image/png':
			return startsWith(bytes, PNG_SIGNATURE) ? null : 'signature';
		case 'image/jpeg':
			return startsWith(bytes, JPEG_SIGNATURE) ? null : 'signature';
		case 'image/svg+xml': {
			const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
			// The decoder drops a byte-order mark. An XML declaration, comments or
			// a doctype may come first; the document still has to be an <svg> one.
			const head = text.trimStart();
			if (!head.startsWith('<') || !/<svg[\s>]/i.test(text)) return 'signature';
			return UNSAFE_SVG_PATTERNS.some((pattern) => pattern.test(text)) ? 'unsafe-svg' : null;
		}
		default:
			return 'signature';
	}
}
