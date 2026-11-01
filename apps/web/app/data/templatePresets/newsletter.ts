/** The recurring digest preset: a top story, a link list and a sign-off. */
import type { TemplatePreset } from './types';
import { NotebookIcon } from '@coolicons/vue';

export const newsletterPreset: TemplatePreset = {
	id: 'newsletter',
	name: 'shared.data.marketingTemplatePresets.newsletter.name',
	description: 'shared.data.marketingTemplatePresets.newsletter.description',
	icon: NotebookIcon,
	subject: 'Your Weekly Update',
	content: [
		{
			id: 'newsletter-text-1',
			type: 'text',
			content: {
				html: '<h1 style="text-align: center">Weekly Newsletter</h1>',
				fontSize: 28,
				textColor: '#111827',
			},
		},
		{
			id: 'newsletter-text-2',
			type: 'text',
			content: {
				html: '<p style="text-align: center; color: #6B7280">Your weekly dose of updates and insights</p>',
				fontSize: 14,
				textColor: '#6B7280',
			},
		},
		{
			id: 'newsletter-spacer-1',
			type: 'spacer',
			content: { height: 24 },
		},
		{
			id: 'newsletter-divider-1',
			type: 'divider',
			content: {
				color: '#E5E7EB',
				thickness: 1,
				width: 100,
				style: 'solid',
			},
		},
		{
			id: 'newsletter-spacer-2',
			type: 'spacer',
			content: { height: 24 },
		},
		{
			id: 'newsletter-text-3',
			type: 'text',
			content: {
				html: '<h2>Top Story</h2>',
				fontSize: 20,
				textColor: '#111827',
			},
		},
		{
			id: 'newsletter-text-4',
			type: 'text',
			content: {
				html: '<p>Your main story content goes here. Share the most important news or update of the week.</p>',
				fontSize: 16,
				textColor: '#374151',
			},
		},
		{
			id: 'newsletter-button-1',
			type: 'button',
			content: {
				text: 'Read More',
				url: 'https://',
				backgroundColor: '#c4785a',
				textColor: '#ffffff',
				align: 'left',
				borderRadius: 6,
				paddingX: 20,
				paddingY: 10,
				marginTop: 12,
				marginBottom: 0,
			},
		},
		{
			id: 'newsletter-spacer-3',
			type: 'spacer',
			content: { height: 32 },
		},
		{
			id: 'newsletter-text-5',
			type: 'text',
			content: {
				html: '<h2>Quick Links</h2>',
				fontSize: 20,
				textColor: '#111827',
			},
		},
		{
			id: 'newsletter-text-6',
			type: 'text',
			content: {
				html: '<p>- <a href="#">Link to article or resource 1</a></p><p>- <a href="#">Link to article or resource 2</a></p><p>- <a href="#">Link to article or resource 3</a></p>',
				fontSize: 16,
				textColor: '#374151',
			},
		},
		{
			id: 'newsletter-spacer-4',
			type: 'spacer',
			content: { height: 32 },
		},
		{
			id: 'newsletter-divider-2',
			type: 'divider',
			content: {
				color: '#E5E7EB',
				thickness: 1,
				width: 100,
				style: 'solid',
			},
		},
		{
			id: 'newsletter-spacer-5',
			type: 'spacer',
			content: { height: 24 },
		},
		{
			id: 'newsletter-text-7',
			type: 'text',
			content: {
				html: '<p style="text-align: center">Thanks for reading! See you next week.</p>',
				fontSize: 14,
				textColor: '#6B7280',
			},
		},
	],
	previewHtml: `<div style="padding: 24px; max-width: 100%;">
      <h1 style="text-align: center; font-size: 22px; color: #111827; margin: 0 0 4px 0;">Weekly Newsletter</h1>
      <p style="text-align: center; color: #6B7280; font-size: 12px; margin: 0 0 16px 0;">Your weekly dose of updates</p>
      <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 16px 0;">
      <h2 style="font-size: 16px; color: #111827; margin: 0 0 8px 0;">Top Story</h2>
      <p style="color: #374151; font-size: 13px; margin: 0 0 12px 0;">Your main story content goes here...</p>
      <span style="display: inline-block; background: #c4785a; color: #ffffff; padding: 6px 14px; border-radius: 4px; font-size: 12px;">Read More</span>
      <h2 style="font-size: 16px; color: #111827; margin: 24px 0 8px 0;">Quick Links</h2>
      <p style="color: #374151; font-size: 13px; margin: 0;">- Link 1 - Link 2 - Link 3</p>
    </div>`,
};
