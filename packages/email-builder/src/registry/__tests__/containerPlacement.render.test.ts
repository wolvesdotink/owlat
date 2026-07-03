import { describe, it, expect } from 'vitest';
import { renderEmailHtml, renderBlockFragment } from '@owlat/email-renderer';
import { getContainerItemTypes } from '../index';
import { createDefaultContent } from '../../utils/blocks';
import { generateId } from '../../utils/id';
import type {
	BlockType,
	EditorBlock,
	ContainerBlockContent,
	SocialBlockContent,
} from '../../types';

/**
 * Regression: the builder marks certain blocks `canBeInContainer: true` and
 * offers them in the container/hero add-block menu, but the renderer gates each
 * block by an accepted-placements list. Container/hero dispatch their children
 * at the `container` placement, so any capability-eligible block whose renderer
 * module did NOT list `container` was rejected -> rendered as the empty string
 * -> silently dropped from the SENT email while still showing in the editor.
 * This is exactly what happened to the `social` block, whose renderer module
 * declared `placements: ['root']`.
 *
 * These guards pin the capability<->placement contract: every block the builder
 * says can live in a container must NOT be dropped by the renderer purely
 * because of where it sits — if the block renders at root, it must also render
 * once nested in a container.
 */

const emptyContainer = (): EditorBlock =>
	({
		id: generateId(),
		type: 'container',
		content: { ...(createDefaultContent('container') as ContainerBlockContent), items: [] },
	}) as EditorBlock;

const containerWith = (child: { id: string; type: string; content: unknown }): EditorBlock =>
	({
		id: generateId(),
		type: 'container',
		content: {
			...(createDefaultContent('container') as ContainerBlockContent),
			items: [child],
		},
	}) as EditorBlock;

/** Delta length attributable to the child once nested in a container. */
const containerContribution = (child: { id: string; type: string; content: unknown }): number =>
	renderEmailHtml([containerWith(child)]).length - renderEmailHtml([emptyContainer()]).length;

describe('canBeInContainer blocks are accepted at the renderer container placement', () => {
	const containerTypes = getContainerItemTypes().filter((t) => t !== 'container');

	it('covers a non-trivial set of block types incl. the social regression', () => {
		expect(containerTypes.length).toBeGreaterThan(0);
		expect(containerTypes).toContain('social');
	});

	// Class-wide invariant: a block the builder allows in a container must not be
	// dropped by placement. If its default content renders at root, it must also
	// contribute markup when nested in a container.
	for (const type of containerTypes) {
		it(`does not drop "${type}" at the container placement`, () => {
			const child = { id: generateId(), type, content: createDefaultContent(type as BlockType) };
			const rootRendersSomething = renderBlockFragment(child as EditorBlock).trim().length > 0;
			if (rootRendersSomething) {
				expect(containerContribution(child)).toBeGreaterThan(0);
			}
		});
	}

	// Concrete regression: a social block with real links used to vanish from the
	// sent email when nested in a container. It must now render its icons.
	it('renders a social block with links when nested in a container', () => {
		const content = createDefaultContent('social') as SocialBlockContent;
		const withLinks: SocialBlockContent = {
			...content,
			links: content.links.map((link) => ({
				...link,
				enabled: true,
				url: `https://example.com/${link.platform}`,
			})),
		};
		const child = { id: generateId(), type: 'social', content: withLinks };

		// Sanity: it renders at root.
		expect(renderBlockFragment(child as EditorBlock)).toContain('example.com');

		// The regression target: it must survive the container placement.
		const html = renderEmailHtml([containerWith(child)]);
		expect(html).toContain('example.com/twitter');
	});
});
