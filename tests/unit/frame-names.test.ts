import { describe, expect, it } from 'vitest';
import {
  TOP_LEVEL_MARK,
  TOP_LEVEL_VIEW_HOSTS,
  buildPaneName,
  inProfileFrame,
  paneHasFlag,
  paneName,
  parsePaneName,
  wantsTopLevelView,
} from '../../src/core/embed/frame.js';
import { EMBED_FRAME_NAME_PREFIX } from '../../src/core/workspace/types.js';

describe('buildPaneName and parsePaneName', () => {
  it('names a plain pane with just the prefix and the id', () => {
    expect(buildPaneName('tab_1')).toBe(`${EMBED_FRAME_NAME_PREFIX}tab_1`);
    expect(parsePaneName(buildPaneName('tab_1'))).toEqual({ id: 'tab_1', flags: '' });
  });

  it('round-trips an id with flags', () => {
    const name = buildPaneName('tab_1', ['n']);
    expect(name).toBe(`${EMBED_FRAME_NAME_PREFIX}!n!tab_1`);
    expect(parsePaneName(name)).toEqual({ id: 'tab_1', flags: 'n' });
  });

  it('writes each flag once', () => {
    expect(buildPaneName('x', ['n', 'n'])).toBe(`${EMBED_FRAME_NAME_PREFIX}!n!x`);
    expect(buildPaneName('x', [])).toBe(`${EMBED_FRAME_NAME_PREFIX}x`);
  });

  it('round-trips ids with punctuation, including a "!" that is not first', () => {
    for (const id of ['a-b_c.d', 'a!b', 'x!n!y', 'tab~1']) {
      expect(parsePaneName(buildPaneName(id))?.id).toBe(id);
      expect(parsePaneName(buildPaneName(id, ['n']))).toEqual({ id, flags: 'n' });
    }
  });

  it.each([
    ['a non-string', 42],
    ['null', null],
    ['undefined', undefined],
    ['an object', { name: 'tk-pane~x' }],
    ['an empty name', ''],
    ['a foreign name', 'my-frame'],
    ['the prefix without a tilde', 'tk-pane'],
    ['a name that only contains the prefix', 'x-tk-pane~tab_1'],
    ['a name with a differently cased prefix', 'TK-PANE~tab_1'],
    ['the prefix alone', EMBED_FRAME_NAME_PREFIX],
    ['an unterminated flag block', `${EMBED_FRAME_NAME_PREFIX}!n`],
    ['an empty id after flags', `${EMBED_FRAME_NAME_PREFIX}!n!`],
    ['upper-case flags', `${EMBED_FRAME_NAME_PREFIX}!N!x`],
    ['digit flags', `${EMBED_FRAME_NAME_PREFIX}!n1!x`],
    ['too many flags', `${EMBED_FRAME_NAME_PREFIX}!abcdefghi!x`],
    ['an id over 400 characters', `${EMBED_FRAME_NAME_PREFIX}${'a'.repeat(401)}`],
  ])('rejects %s', (_label, name) => {
    expect(parsePaneName(name)).toBeNull();
  });

  it('accepts an id of exactly 400 characters', () => {
    expect(parsePaneName(`${EMBED_FRAME_NAME_PREFIX}${'a'.repeat(400)}`)?.id).toHaveLength(400);
  });

  it('reads an empty flag block as no flags', () => {
    expect(parsePaneName(`${EMBED_FRAME_NAME_PREFIX}!!x`)).toEqual({ id: 'x', flags: '' });
  });

  it('does not let an id that starts with "!" turn into flags', () => {
    expect(parsePaneName(buildPaneName('!n!x'))).toEqual({ id: '!n!x', flags: '' });
    expect(parsePaneName(buildPaneName('!n!x', ['n']))).toEqual({ id: '!n!x', flags: 'n' });
  });
});

describe('paneName and paneHasFlag', () => {
  it('read the id and options from the window name', () => {
    const win = { name: buildPaneName('tab_9', ['n']) };
    expect(paneName(win)).toBe('tab_9');
    expect(paneHasFlag('n', win)).toBe(true);
  });

  it('say nothing for a window the workspace did not name', () => {
    for (const name of ['', 'ad-frame', 'tk-pane~', 'tk-pane~!n']) {
      expect(paneName({ name })).toBeNull();
      expect(paneHasFlag('n', { name })).toBe(false);
    }
  });

  it('report no flag for a plain pane', () => {
    expect(paneHasFlag('n', { name: buildPaneName('tab_9') })).toBe(false);
  });

  it('cannot get the flag from the id', () => {
    expect(paneHasFlag('n', { name: `${EMBED_FRAME_NAME_PREFIX}n` })).toBe(false);
    expect(paneHasFlag('n', { name: `${EMBED_FRAME_NAME_PREFIX}tab!n!x` })).toBe(false);
  });

  it('cannot get a flag from a foreign name that contains a pane name', () => {
    expect(paneHasFlag('n', { name: `evil${buildPaneName('x', ['n'])}` })).toBe(false);
    expect(paneName({ name: `evil${buildPaneName('x')}` })).toBeNull();
  });

  it('survive a window whose name throws or is not a string', () => {
    const throwing = {
      get name(): string {
        throw new Error('cross-origin');
      },
    };
    expect(paneName(throwing)).toBeNull();
    expect(paneHasFlag('n', throwing)).toBe(false);
    expect(paneName({ name: 5 as unknown as string })).toBeNull();
  });
});

describe('inProfileFrame', () => {
  it('is true only for a window that says credentialless === true', () => {
    expect(inProfileFrame({ credentialless: true })).toBe(true);
    expect(inProfileFrame({ credentialless: false })).toBe(false);
    expect(inProfileFrame({})).toBe(false);
  });

  it('is not fooled by truthy lookalikes', () => {
    for (const credentialless of ['true', 1, {}, [], 'credentialless']) expect(inProfileFrame({ credentialless })).toBe(false);
  });

  it('is not decided by the frame name, so a lookalike name cannot make a profile frame', () => {
    for (const name of [buildPaneName('x', ['n']), `${EMBED_FRAME_NAME_PREFIX}!profile!x`, 'credentialless', 'data-tk-profile']) {
      expect(inProfileFrame({ name })).toBe(false);
    }
  });

  it('is false when reading the property throws, and for non-windows', () => {
    const hostile = {
      get credentialless(): never {
        throw new Error('no');
      },
    };
    expect(inProfileFrame(hostile)).toBe(false);
    expect(inProfileFrame(null)).toBe(false);
    expect(inProfileFrame(undefined)).toBe(false);
  });

  it('is false for an ordinary document window', () => {
    expect(inProfileFrame()).toBe(false);
  });
});

describe('wantsTopLevelView', () => {
  it('is true for the listed hosts and their subdomains, whatever the case', () => {
    expect(TOP_LEVEL_VIEW_HOSTS).toContain('claude.ai');
    expect(wantsTopLevelView('claude.ai')).toBe(true);
    expect(wantsTopLevelView('www.claude.ai')).toBe(true);
    expect(wantsTopLevelView('API.Claude.AI')).toBe(true);
    expect(wantsTopLevelView('CLAUDE.AI')).toBe(true);
  });

  it('is false for lookalikes and other sites', () => {
    for (const host of ['notclaude.ai', 'claude.ai.evil.com', 'evilclaude.ai', 'claude.com', 'chatgpt.com', 'localhost', '']) {
      expect(wantsTopLevelView(host)).toBe(false);
    }
  });
});

describe('TOP_LEVEL_MARK', () => {
  it('is a data attribute distinct from the profile mark', () => {
    expect(TOP_LEVEL_MARK).toBe('data-tk-top-level');
  });
});
