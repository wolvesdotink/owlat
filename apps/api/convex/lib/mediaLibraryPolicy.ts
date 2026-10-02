/**
 * What the media library admits and how its search text is built: shared by
 * the library's own upload (`mediaAssets.ts`) and the brand kit's website
 * import (`workspaces/brandKit.ts`), which adds a fetched logo to the library.
 */
import { DEFAULT_FILE_POLICY, mergePolicy } from '@owlat/email-scanner';

// The media library re-allows SVG on top of the scanner default (which
// excludes it as script-capable): uploads here come from authenticated org
// members, and assets are consumed as <img src> in emails/builder previews —
// a context in which browsers never execute SVG scripts. Recipients are not
// handed SVG as an openable attachment through this path.
export const MEDIA_LIBRARY_POLICY = mergePolicy({
	allowedTypes: [...DEFAULT_FILE_POLICY.allowedTypes, 'image/svg+xml'],
	allowedExtensions: [...DEFAULT_FILE_POLICY.allowedExtensions, '.svg'],
});

/**
 * Build searchable text from filename, alt, and tags.
 */
export function buildSearchableText(filename: string, alt?: string, tags?: string[]): string {
	const parts: string[] = [];
	// Split filename on common separators
	parts.push(...filename.replace(/\.[^.]+$/, '').split(/[-_.\s]+/));
	if (alt) parts.push(alt);
	if (tags) parts.push(...tags);
	return parts.filter(Boolean).join(' ').toLowerCase();
}
