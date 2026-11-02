/**
 * The per-sender zoom as stored on this device: the steps the reader moves
 * through, what survives a bad stored value, and the bound on how many senders
 * are kept.
 */
import { describe, expect, it } from 'vitest';
import {
	nextSenderZoom,
	parseSenderZooms,
	SENDER_ZOOM_STEPS,
	senderZoomAtLimit,
	withSenderZoom,
} from '../senderZoom';

describe('nextSenderZoom', () => {
	it('steps up and down through the offered steps and stops at the ends', () => {
		expect(nextSenderZoom(100, 'zoomIn')).toBe(110);
		expect(nextSenderZoom(110, 'zoomIn')).toBe(125);
		expect(nextSenderZoom(100, 'zoomOut')).toBe(90);
		expect(nextSenderZoom(200, 'zoomIn')).toBe(200);
		expect(nextSenderZoom(80, 'zoomOut')).toBe(80);
		expect(nextSenderZoom(175, 'zoomReset')).toBe(100);
	});

	it('knows when a step would not move', () => {
		expect(senderZoomAtLimit(SENDER_ZOOM_STEPS.at(-1)!, 'zoomIn')).toBe(true);
		expect(senderZoomAtLimit(SENDER_ZOOM_STEPS[0]!, 'zoomOut')).toBe(true);
		expect(senderZoomAtLimit(100, 'zoomReset')).toBe(true);
		expect(senderZoomAtLimit(125, 'zoomReset')).toBe(false);
	});
});

describe('parseSenderZooms', () => {
	it('keeps valid entries and drops the rest one by one', () => {
		expect(
			parseSenderZooms(
				JSON.stringify({
					'news@example.com': 150,
					'odd@example.com': 133,
					'plain@example.com': 100,
					'text@example.com': '150',
				})
			)
		).toEqual({ 'news@example.com': 150 });
	});

	it('keeps nothing from malformed storage', () => {
		for (const raw of [null, '{not json', '[]', 'null', '42']) {
			expect(parseSenderZooms(raw)).toEqual({});
		}
	});
});

describe('withSenderZoom', () => {
	it('sets, moves the changed sender to the newest, and removes it at 100%', () => {
		const zooms = withSenderZoom(
			{ 'a@example.com': 110, 'b@example.com': 125 },
			'a@example.com',
			150
		);
		expect(Object.entries(zooms)).toEqual([
			['b@example.com', 125],
			['a@example.com', 150],
		]);
		expect(withSenderZoom(zooms, 'b@example.com', 100)).toEqual({ 'a@example.com': 150 });
	});

	it('forgets the senders zoomed longest ago past the limit', () => {
		let zooms = {};
		for (const sender of ['a', 'b', 'c', 'd']) {
			zooms = withSenderZoom(zooms, `${sender}@example.com`, 125, 3);
		}
		expect(Object.keys(zooms)).toEqual(['b@example.com', 'c@example.com', 'd@example.com']);
	});
});
