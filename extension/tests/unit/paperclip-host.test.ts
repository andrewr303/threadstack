import { describe, expect, it } from 'vitest';
import { parsePaperclipHostMessage, paperclipPath, paperclipPageAddress } from '../../src/core/paperclip/host.js';

describe('Paperclip frame host', () => {
  it('accepts only same-frame same-origin versioned messages', () => {
    const frame = {};
    const event = { source: frame, origin: 'http://127.0.0.1:3100', data: { source: 'paperclip-ui', v: 1, type: 'ready' } };
    expect(parsePaperclipHostMessage(event, frame, event.origin)).toEqual({ type: 'ready', mode: 'switching' });
    expect(parsePaperclipHostMessage({ ...event, source: {} }, frame, event.origin)).toBeNull();
    expect(parsePaperclipHostMessage({ ...event, origin: 'https://evil.example' }, frame, event.origin)).toBeNull();
    expect(parsePaperclipHostMessage({ ...event, data: { ...event.data, v: 2 } }, frame, event.origin)).toBeNull();
  });

  it('rejects unsafe or overlong routes and keeps titles bounded', () => {
    for (const path of ['//evil.example', '/\\evil.example', '/a\nb', 'https://evil.example', `/${'a'.repeat(2000)}`]) {
      expect(paperclipPath(path)).toBeNull();
    }
    expect(paperclipPath('/ACME/issues/ACME-12?q=a#last')).toBe('/ACME/issues/ACME-12?q=a#last');
    const frame = {};
    expect(parsePaperclipHostMessage({ source: frame, origin: 'http://localhost:3100', data: { source: 'paperclip-ui', v: 1, type: 'route', path: '/ACME', title: 'a'.repeat(500) } }, frame, 'http://localhost:3100')).toEqual({ type: 'route', path: '/ACME', title: 'a'.repeat(300) });
  });

  it('allows only known extension views and safe external links', () => {
    const source = {};
    const parse = (data: object) => parsePaperclipHostMessage({ source, origin: 'http://localhost:3100', data: { source: 'paperclip-ui', v: 1, ...data } }, source, 'http://localhost:3100');
    expect(parse({ type: 'open-view', view: 'threads' })).toEqual({ type: 'open-view', view: 'threads' });
    expect(parse({ type: 'open-view', view: 'settings' })).toBeNull();
    expect(parse({ type: 'open-link', url: 'javascript:alert(1)' })).toBeNull();
    expect(parse({ type: 'open-link', url: 'https://u:p@example.com' })).toBeNull();
    expect(parse({ type: 'open-link', url: 'https://claude.ai/code/session_abc' })).toEqual({ type: 'open-link', url: 'https://claude.ai/code/session_abc' });
  });

  it('bounds the narrow post-overlay Threads activation message to the frame viewport', () => {
    const source = {};
    const parse = (body: object) => parsePaperclipHostMessage({ source, origin: 'http://localhost:3100', data: { source: 'paperclip-ui', v: 1, type: 'slot-activate', view: 'threads', x: 250, y: 100, sequence: 1, ...body } }, source, 'http://localhost:3100', { width: 1024, height: 768 });
    expect(parse({})).toEqual({ type: 'slot-activate', view: 'threads', x: 250, y: 100, sequence: 1 });
    for (const body of [{ view: 'browse' }, { x: -1 }, { x: 1024 }, { y: 768 }, { y: Infinity }, { x: '250' }, { sequence: 0 }, { sequence: -1 }, { sequence: 1.5 }, { sequence: '1' }, { sequence: Number.MAX_SAFE_INTEGER + 1 }, { sequence: undefined }]) expect(parse(body)).toBeNull();
  });

  it('reads the announced mode from ready and treats anything else as switching', () => {
    const source = {};
    const parse = (data: object) => parsePaperclipHostMessage({ source, origin: 'http://localhost:3100', data: { source: 'paperclip-ui', v: 1, ...data } }, source, 'http://localhost:3100');
    expect(parse({ type: 'ready', mode: 'fused' })).toEqual({ type: 'ready', mode: 'fused' });
    expect(parse({ type: 'ready', mode: 'switching' })).toEqual({ type: 'ready', mode: 'switching' });
    expect(parse({ type: 'ready', mode: 'layered-everything' })).toEqual({ type: 'ready', mode: 'switching' });
  });

  describe('slot (REQ-6 FR-2)', () => {
    const source = {};
    const bounds = { width: 1440, height: 900 };
    const parse = (data: object) => parsePaperclipHostMessage({ source, origin: 'http://localhost:3100', data: { source: 'paperclip-ui', v: 1, type: 'slot', ...data } }, source, 'http://localhost:3100', bounds);
    const rect = { x: 240, y: 48, width: 1200, height: 852 };

    it('maps the session board to the dashboard view and keeps the reported scheme', () => {
      expect(parse({ view: 'session-board', rect, scheme: 'dark' })).toEqual({ type: 'slot', view: 'dashboard', rect, scheme: 'dark' });
      expect(parse({ view: 'browse', rect })).toEqual({ type: 'slot', view: 'browse', rect, scheme: 'light' });
      expect(parse({ view: null, rect: null, scheme: 'dark' })).toEqual({ type: 'slot', view: null, rect: null, scheme: 'dark' });
    });

    it('ignores rectangles outside the window, with a negative or empty size, or not finite (AC-11)', () => {
      for (const bad of [
        { ...rect, width: -10 },
        { ...rect, height: 0 },
        { ...rect, x: 300 },
        { ...rect, y: -5 },
        { ...rect, height: 900 },
        { ...rect, width: Number.NaN },
        { ...rect, x: '240' },
        null,
      ]) expect(parse({ view: 'threads', rect: bad })).toBeNull();
      expect(parse({ view: 'settings', rect })).toBeNull();
    });

    it('allows one CSS pixel of rounding at the window edge', () => {
      expect(parse({ view: 'threads', rect: { ...rect, width: 1200.8 } })?.type).toBe('slot');
      expect(parse({ view: 'threads', rect: { ...rect, x: -0.5, width: 1200 } })?.type).toBe('slot');
      expect(parse({ view: 'threads', rect: { ...rect, width: 1201.5 } })).toBeNull();
    });
  });

  it('accepts overlay reports with at most eight valid notice regions', () => {
    const source = {};
    const parse = (data: object) => parsePaperclipHostMessage({ source, origin: 'http://localhost:3100', data: { source: 'paperclip-ui', v: 1, type: 'overlay', ...data } }, source, 'http://localhost:3100');
    const region = (i: number) => ({ x: 12, y: 800 - i * 60, width: 380, height: 52 });
    const parsed = parse({ open: false, regions: [region(0), { x: 0, y: 0, width: -1, height: 4 }, 'x', ...Array.from({ length: 10 }, (_, i) => region(i + 1))] });
    expect(parsed).toMatchObject({ type: 'overlay', open: false });
    expect((parsed as { regions: unknown[] }).regions).toHaveLength(8);
    expect((parsed as { regions: unknown[] }).regions[1]).toEqual(region(1));
    expect(parse({ open: true })).toEqual({ type: 'overlay', open: true, regions: [] });
    expect(parse({ open: 'yes', regions: [] })).toBeNull();
  });

  it('replaces shell route parameters without creating a second history entry', () => {
    const url = paperclipPageAddress('chrome-extension://abcdefghijklmnopabcdefghijklmnop/manager.html?surface=page&q=hello', '/ACME/issues/ACME-12');
    expect(new URL(url).searchParams.get('pc')).toBe('/ACME/issues/ACME-12');
    expect(new URL(url).searchParams.get('view')).toBe('paperclip');
    expect(new URL(url).searchParams.get('q')).toBe('hello');
  });
});
