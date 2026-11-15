// Run state of a coding-agent page, read from visible controls (core/embed/agent-state.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentStateOf, readAgentPage } from '../../src/core/embed/agent-state.js';

const originalRects = Element.prototype.getClientRects;

beforeAll(() => {
  // jsdom lays nothing out; treat everything outside [hidden] as on screen.
  Element.prototype.getClientRects = function (this: Element) {
    return (this.closest('[hidden]') ? [] : [{}]) as unknown as DOMRectList;
  };
});
afterAll(() => {
  Element.prototype.getClientRects = originalRects;
});

function page(body: string, title = 'Session - Claude Code'): Document {
  const doc = document.implementation.createHTMLDocument(title);
  doc.body.innerHTML = body;
  return doc;
}

const stateOf = (body: string, title?: string) => agentStateOf(readAgentPage(page(body, title)));

describe('agentStateOf(readAgentPage(doc))', () => {
  it('running: a visible stop control, or a working task status', () => {
    expect(stateOf('<main><button aria-label="Stop">■</button></main>')).toBe('running');
    expect(stateOf('<main><button>Stop generating</button></main>')).toBe('running');
    expect(stateOf('<div data-testid="task-status">Running</div>')).toBe('running');
    expect(stateOf('<div data-session-status="waiting for tool"></div>')).toBe('running');
  });

  it('waiting_permission: a dialog asking to allow or approve', () => {
    expect(stateOf('<div role="dialog"><p>Claude wants to edit package.json</p><button>Allow</button><button>Deny</button></div><button aria-label="Stop">■</button>')).toBe(
      'waiting_permission'
    );
  });

  it('waiting_answer: a dialog asking for typed input that is not a sign-in', () => {
    expect(stateOf('<div role="dialog"><p>Which database should I use?</p><textarea></textarea><button>Send</button></div>')).toBe('waiting_answer');
  });

  it('turn_complete, failed and idle from a finished task status', () => {
    expect(stateOf('<div data-testid="task-status" data-state="completed">Done</div>')).toBe('turn_complete');
    expect(stateOf('<div data-session-status="failed"></div>')).toBe('failed');
    expect(stateOf('<div data-testid="task-status">Cancelled</div>')).toBe('idle');
    expect(stateOf('<div data-session-status="paused"></div>')).toBe('idle');
    expect(stateOf('<div data-session-status="auth_expired"></div>')).toBe('signed_out');
    expect(stateOf('<div data-session-status="process_exit"></div><button>Stop</button>')).toBe('unknown');
  });

  it('signed_out: a visible sign-in form or sign-in button wins over everything else', () => {
    expect(stateOf('<form><input type="email"><input type="password"></form><button>Stop</button>')).toBe('signed_out');
    expect(stateOf('<button>Continue with Google</button>')).toBe('signed_out');
    expect(stateOf('<button> Log in </button>')).toBe('signed_out');
  });

  it('unknown: an unrelated page, a browser check, or controls that are not on screen', () => {
    expect(stateOf('<main><h1>Pricing</h1><button>Start free trial</button><a href="/docs">Docs</a></main>')).toBe('unknown');
    expect(stateOf('<main></main>', 'Just a moment...')).toBe('unknown');
    expect(readAgentPage(page('<main></main>', 'Just a moment...')).challenge).toBe(true);
    expect(stateOf('<div hidden><button>Stop</button><div role="dialog">Allow?</div><input type="email"></div>')).toBe('unknown');
    expect(stateOf('<button>Stop the world</button><div data-testid="task-status">Thinking about it</div>')).toBe('unknown');
  });

  it('keeps no text from the page: only flags', () => {
    const read = readAgentPage(
      page('<div role="dialog"><p>Approve deploy with token sk-secret?</p><input value="hunter2"><button>Approve</button></div>')
    );
    expect(read).toEqual({
      terminal: null,
      waitingTool: false,
      login: false,
      challenge: false,
      stop: false,
      permission: true,
      question: true,
    });
    expect(JSON.stringify(read)).not.toMatch(/secret|hunter2|deploy/);
  });
});
