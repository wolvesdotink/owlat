/** The onboarding preset: greet a new subscriber and point them at what to do first. */
import type { TemplatePreset } from './types';
import { SparklesIcon } from '@coolicons/vue';

export const welcomePreset: TemplatePreset = {
	id: 'welcome',
	name: 'shared.data.marketingTemplatePresets.welcome.name',
	description: 'shared.data.marketingTemplatePresets.welcome.description',
	icon: SparklesIcon,
	subject: 'Welcome to {{company}}!',
	content: [
		{
			id: 'welcome-text-1',
			type: 'text',
			content: {
				html: '<h1 style="text-align: center">Welcome aboard, {{firstName}}! </h1>',
				fontSize: 28,
				textColor: '#111827',
			},
		},
		{
			id: 'welcome-spacer-1',
			type: 'spacer',
			content: { height: 16 },
		},
		{
			id: 'welcome-text-2',
			type: 'text',
			content: {
				html: '<p style="text-align: center">We\'re thrilled to have you join our community. Here\'s what you can expect from us:</p>',
				fontSize: 16,
				textColor: '#4B5563',
			},
		},
		{
			id: 'welcome-spacer-2',
			type: 'spacer',
			content: { height: 24 },
		},
		{
			id: 'welcome-text-3',
			type: 'text',
			content: {
				html: '<p><strong>Exclusive updates</strong> - Be the first to know about new features</p><p><strong>Helpful resources</strong> - Tips and guides to help you succeed</p><p><strong>Special offers</strong> - Subscriber-only deals and promotions</p>',
				fontSize: 16,
				textColor: '#374151',
			},
		},
		{
			id: 'welcome-spacer-3',
			type: 'spacer',
			content: { height: 24 },
		},
		{
			id: 'welcome-button-1',
			type: 'button',
			content: {
				text: 'Get Started',
				url: 'https://',
				backgroundColor: '#c4785a',
				textColor: '#ffffff',
				align: 'center',
				borderRadius: 8,
				paddingX: 32,
				paddingY: 14,
				marginTop: 0,
				marginBottom: 0,
			},
		},
		{
			id: 'welcome-spacer-4',
			type: 'spacer',
			content: { height: 32 },
		},
		{
			id: 'welcome-divider-1',
			type: 'divider',
			content: {
				color: '#E5E7EB',
				thickness: 1,
				width: 100,
				style: 'solid',
			},
		},
		{
			id: 'welcome-spacer-5',
			type: 'spacer',
			content: { height: 24 },
		},
		{
			id: 'welcome-text-4',
			type: 'text',
			content: {
				html: '<p style="text-align: center">Have questions? Just reply to this email - we\'re here to help!</p>',
				fontSize: 14,
				textColor: '#6B7280',
			},
		},
	],
	previewHtml: `<div style="padding: 32px; max-width: 100%;">
      <h1 style="text-align: center; font-size: 24px; color: #111827; margin: 0 0 16px 0;">Welcome aboard!</h1>
      <p style="text-align: center; color: #4B5563; font-size: 14px; margin: 0 0 20px 0;">We're thrilled to have you join our community.</p>
      <p style="color: #374151; font-size: 13px; margin: 0 0 6px 0;"><strong>Exclusive updates</strong></p>
      <p style="color: #374151; font-size: 13px; margin: 0 0 6px 0;"><strong>Helpful resources</strong></p>
      <p style="color: #374151; font-size: 13px; margin: 0 0 20px 0;"><strong>Special offers</strong></p>
      <div style="text-align: center;">
        <span style="display: inline-block; background: #c4785a; color: #ffffff; padding: 10px 24px; border-radius: 6px; font-weight: 500; font-size: 13px;">Get Started</span>
      </div>
    </div>`,
};
