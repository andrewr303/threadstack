import { describe, expect, it } from 'vitest';
import { SessionObservationLedger } from '../../src/core/paperclip/observations.js';
import { shouldReportAgentObservation } from '../../src/core/embed/agent-state.js';

describe('live session observations', () => {
  function harness() {
    let time = 100_000;
    const ledger = new SessionObservationLedger({ now: () => time });
    const observe = (state: 'running' | 'turn_complete' | 'waiting_answer' | 'unknown', frameId = 1, threadKey = 'thread') => ledger.observe({ tabId: 1, frameId, threadKey, state });
    return { ledger, observe, advance: (ms: number) => { time += ms; } };
  }
  it('never treats a persisted historical timestamp or first observation as a change', () => {
    const h = harness(); expect(h.ledger.isObserved('thread')).toBe(false);
    h.observe('turn_complete'); expect(h.ledger.snapshot('thread')).toEqual({ state: 'turn_complete', at: 100_000 });
    h.advance(5000); expect(h.ledger.flushSettledChanges()).toEqual([]);
  });
  it('requires a changed state to remain settled for five seconds', () => {
    const h = harness(); h.observe('running'); h.advance(100); h.observe('turn_complete');
    h.advance(4999); expect(h.ledger.flushSettledChanges()).toEqual([]);
    h.advance(1); expect(h.ledger.flushSettledChanges()).toEqual([{ threadKey: 'thread', from: 'running', to: 'turn_complete', at: new Date(100_100).toISOString(), observed: true }]);
    expect(h.ledger.flushSettledChanges()).toEqual([]);
  });
  it('merges flapping states and does not let unchanged heartbeats restart the settle clock', () => {
    const h = harness(); h.observe('running'); h.advance(100); h.observe('turn_complete');
    h.advance(3000); h.observe('running'); h.advance(3000); expect(h.ledger.flushSettledChanges()).toEqual([]);
    h.observe('waiting_answer'); h.advance(3000); h.observe('waiting_answer'); h.advance(2000);
    expect(h.ledger.flushSettledChanges()).toHaveLength(1);
  });
  // Re-baselined 2026-11-14 (REQ-10 F2): this test previously asserted NO event after a stale gap, which
  // contradicts REQ-10 FR-5 edge ("loaded again and shows Finished … one event is sent as for any change").
  it('expires observations when a frame stops reporting, then reports a changed state once the session is seen again (REQ-10 F2, FR-5 edge)', () => {
    const h = harness(); h.observe('running'); h.advance(30_001);
    expect(h.ledger.isObserved('thread')).toBe(false); expect(h.ledger.snapshot('thread')).toBeNull();
    h.observe('turn_complete'); h.advance(4999); expect(h.ledger.flushSettledChanges()).toEqual([]);
    h.advance(1); expect(h.ledger.flushSettledChanges()).toEqual([{ threadKey: 'thread', from: 'running', to: 'turn_complete', at: new Date(130_001).toISOString(), observed: true }]);
    expect(h.ledger.flushSettledChanges()).toEqual([]);
  });
  it('emits nothing when a session is seen again in the state it was last known in', () => {
    const h = harness(); h.observe('running'); h.ledger.forgetTab(1); h.advance(3_600_000);
    h.observe('running'); h.advance(5000); expect(h.ledger.flushSettledChanges()).toEqual([]);
  });
  it('drops pending changes on closed frames, closed tabs and unknown observations', () => {
    const h = harness(); h.observe('running'); h.advance(100); h.observe('turn_complete'); h.ledger.forgetFrame(1, 1);
    h.advance(5000); expect(h.ledger.flushSettledChanges()).toEqual([]); expect(h.ledger.isObserved('thread')).toBe(false);
    h.observe('running'); h.ledger.forgetTab(1); expect(h.ledger.isObserved('thread')).toBe(false);
    h.observe('running'); h.observe('unknown'); expect(h.ledger.isObserved('thread')).toBe(false);
  });
  it('keeps another fresh frame but moves a navigating frame away from its earlier thread', () => {
    const h = harness(); h.observe('running', 1); h.observe('running', 2); h.ledger.forgetFrame(1, 1);
    expect(h.ledger.isObserved('thread')).toBe(true);
    h.observe('turn_complete', 2, 'another'); expect(h.ledger.isObserved('thread')).toBe(false);
    expect(h.ledger.isObserved('another')).toBe(true);
  });
});

describe('content observation heartbeat', () => {
  it('reports a known stable state every ten seconds and reports actual changes immediately', () => {
    const previous = { state: 'running' as const, url: 'https://claude.ai/code/session-a', at: 1000 };
    expect(shouldReportAgentObservation(previous, { state: 'running', url: previous.url }, 10_999)).toBe(false);
    expect(shouldReportAgentObservation(previous, { state: 'running', url: previous.url }, 11_000)).toBe(true);
    expect(shouldReportAgentObservation(previous, { state: 'turn_complete', url: previous.url }, 1001)).toBe(true);
  });
  it('does not turn unknown or hidden controls into a fresh known observation', () => {
    const previous = { state: 'unknown' as const, url: 'https://claude.ai/code/session-a', at: 1000 };
    expect(shouldReportAgentObservation(previous, { state: 'unknown', url: previous.url }, 100_000)).toBe(false);
    expect(shouldReportAgentObservation({ ...previous, state: 'running' }, { state: 'unknown', url: previous.url }, 1001)).toBe(true);
  });
});
