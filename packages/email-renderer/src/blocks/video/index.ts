/**
 * Block module: video.
 *
 * Video thumbnail + play-button overlay linking to the video URL. The play
 * button uses `position:absolute`, which Gmail strips — the `preflight` hook
 * surfaces this; the clickable thumbnail is the fallback.
 */

import { fullSupport, type VideoBlockContent } from '@owlat/shared';
import type { BlockModule, Placement } from '../_module';
import { toPixelWidth } from '../../helpers/dimensions';
import { escapeAttr, sanitizeUrl } from '../../sanitize';
import { transformUrl } from '../../helpers/linkTransform';
import { checkShape, isString, isNumber, isOneOf } from '../../helpers/validation';

const VIDEO_ALIGNS = ['left', 'center', 'right'] as const;

export const renderVideoContent = (content: VideoBlockContent, baseWidth: number): string => {
	if (!content.thumbnailUrl || !content.videoUrl) return '';

	const widthPx = toPixelWidth(content.width, baseWidth);
	const playSize = content.playButtonSize ?? 64;
	const playColor = content.playButtonColor ?? 'rgba(255,255,255,0.9)';
	const borderRadius = content.borderRadius ? `border-radius:${content.borderRadius}px;` : '';

	const alignMap: Record<string, string> = { center: 'center', right: 'right', left: 'left' };
	const tableAlign = alignMap[content.align] || 'center';

	const playSvg = encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="${playColor}"/><polygon points="26,18 26,46 48,32" fill="#333"/></svg>`);

	const safeThumbnailUrl = escapeAttr(sanitizeUrl(content.thumbnailUrl));
	const safeAlt = escapeAttr(content.alt || 'Video thumbnail');
	const imgTag = `<img src="${safeThumbnailUrl}" alt="${safeAlt}" width="${widthPx}" border="0" style="display:block;width:${widthPx}px;max-width:100%;height:auto;${borderRadius}border:0;outline:none" />`;

	const overlay = `<div style="position:relative;display:inline-block;${borderRadius}">
${imgTag}
<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:${playSize}px;height:${playSize}px">
<img src="data:image/svg+xml,${playSvg}" alt="Play" width="${playSize}" height="${playSize}" style="display:block;border:0" />
</div>
</div>`;

	const safeVideoUrl = escapeAttr(sanitizeUrl(content.videoUrl));
	return `<table cellpadding="0" cellspacing="0" border="0" role="presentation" align="${tableAlign}"><tr><td><a href="${safeVideoUrl}" target="_blank" style="text-decoration:none">${overlay}</a></td></tr></table>`;
};

export const videoModule: BlockModule<'video'> = {
	type: 'video',
	placements: ['root'] as readonly Placement[],

	isEmpty(content) {
		return !content.thumbnailUrl || !content.videoUrl;
	},

	preflight({ ctx }) {
		ctx.warnings.push('Video block uses position:absolute for play button overlay — stripped by Gmail. Thumbnail remains clickable as fallback.');
	},

	html({ block, content, ctx }) {
		const transformed = ctx.linkTransform
			? { ...content, videoUrl: transformUrl(content.videoUrl, 'video', block.id, ctx) }
			: content;
		return renderVideoContent(transformed, ctx.baseWidth);
	},

	amp({ content }) {
		// AMP4Email forbids raw <img> and position:absolute overlays, so the
		// video degrades to a clickable <amp-img> thumbnail linking to the
		// video URL. The play-button overlay is dropped.
		if (!content.thumbnailUrl || !content.videoUrl) return '';
		const src = escapeAttr(sanitizeUrl(content.thumbnailUrl));
		const alt = escapeAttr(content.alt || 'Video thumbnail');
		const href = escapeAttr(sanitizeUrl(content.videoUrl));
		const img = `<amp-img src="${src}" alt="${alt}" width="600" height="338" layout="responsive"></amp-img>`;
		return `<a href="${href}">${img}</a>`;
	},

	plaintext({ content }) {
		return `[Video: ${content.alt || 'Watch video'}] ${content.videoUrl}`;
	},

	createDefault() {
		return {
			thumbnailUrl: '',
			videoUrl: '',
			alt: 'Video',
			width: 100,
			align: 'center',
			playButtonColor: 'rgba(255,255,255,0.9)',
			playButtonSize: 64,
		};
	},

	compatibility: {
		features: [
			{
				feature: 'Play button overlay',
				description: 'SVG play button positioned over thumbnail',
				support: {
					...fullSupport,
					gmail: 'partial',
					gmailApp: 'partial',
					outlookDesktop: 'none',
					outlook365: 'none',
				},
				fallback:
					'Uses position:absolute — stripped by Gmail. Thumbnail remains clickable.',
				owlatHandled: false,
				canIEmailSlug: 'css-position',
			},
			{
				feature: 'SVG data URI',
				description: 'Inline SVG as data URI for play icon',
				support: { ...fullSupport, outlookDesktop: 'partial' },
				fallback: 'Some clients may not render inline SVG',
				owlatHandled: false,
				canIEmailSlug: 'html-svg',
			},
			{
				feature: 'Link to video',
				description: 'Clickable thumbnail linking to video URL',
				support: fullSupport,
				fallback: 'N/A — supported everywhere',
				owlatHandled: false,
			},
		],
		properties: [
			{
				property: 'playButtonColor',
				description: 'SVG play button color (rendered as data URI)',
				support: { ...fullSupport, outlookDesktop: 'partial', outlook365: 'partial' },
				severity: 'info',
				recommendation:
					'SVG data URIs may not render in Outlook — play button hidden, thumbnail clickable as fallback',
				owlatHandled: false,
				degradationImpact: 'visual',
			},
			{
				property: 'borderRadius',
				description: 'Rounded corners on video thumbnail',
				support: { ...fullSupport, outlookDesktop: 'none', outlook365: 'none' },
				severity: 'info',
				recommendation: 'Square corners in Outlook — acceptable for video thumbnails',
				owlatHandled: false,
				degradationImpact: 'visual',
			},
		],
	},

	validate({ block, content, ctx }) {
		// Shape
		checkShape(content as unknown as Record<string, unknown>, [
			{ field: 'thumbnailUrl', check: isString, code: 'VIDEO_THUMBNAIL_TYPE', message: 'thumbnailUrl must be a string' },
			{ field: 'videoUrl', check: isString, code: 'VIDEO_URL_TYPE', message: 'videoUrl must be a string' },
			{ field: 'alt', check: isString, code: 'VIDEO_ALT_TYPE', message: 'alt must be a string' },
			{ field: 'width', check: isNumber, code: 'VIDEO_WIDTH_TYPE', message: 'width must be a number' },
			{ field: 'align', check: (v) => isOneOf(v, VIDEO_ALIGNS), code: 'VIDEO_ALIGN_INVALID', message: 'align must be left, center, or right' },
		], block.id, 'video', ctx.issues);

		// Semantic
		if (!content.thumbnailUrl || content.thumbnailUrl.trim() === '') {
			ctx.issues.push({ blockId: block.id, blockType: 'video', severity: 'error', code: 'VIDEO_NO_THUMBNAIL', message: 'Video block has no thumbnail URL' });
		}
		if (!content.videoUrl || content.videoUrl.trim() === '') {
			ctx.issues.push({ blockId: block.id, blockType: 'video', severity: 'error', code: 'VIDEO_NO_URL', message: 'Video block has no video URL' });
		}
	},
};
