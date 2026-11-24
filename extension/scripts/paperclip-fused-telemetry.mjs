// Test-only instrumentation and controlled input probes for the cross-document boundary.
// No synthetic pointer input or direct application-state writes; the fault probe delays transport.
export async function installFusedInputTelemetry(context, { layout = false } = {}) {
  await context.addInitScript(withLayout => {
    window.__tkInputTimeline = [];
    let overlayOpen = false;
    let closedAt = Number.NEGATIVE_INFINITY;
    let slotView = null;
    const label = element => element instanceof Element ? {
      tag: element.tagName, role: element.getAttribute('role'), slot: element.getAttribute('data-slot'),
      state: element.getAttribute('data-state'), cls: String(element.className).slice(0, 110),
    } : null;
    const hit = point => point ? label(document.elementFromPoint(point.x, point.y)) : null;
    const read = (kind, extra = {}) => {
      const wb = document.querySelector('.tk-workbench');
      const frame = document.querySelector('.tk-view-paperclip');
      const layers = withLayout ? [...document.querySelectorAll('[data-slot="dialog-overlay"], [role="dialog"], [role="alertdialog"]')].map(element => ({
        ...label(element), pointerEvents: getComputedStyle(element).pointerEvents,
        display: getComputedStyle(element).display, visibility: getComputedStyle(element).visibility,
      })) : [];
      window.__tkInputTimeline.push({
        at: performance.timeOrigin + performance.now(), realm: wb ? 'shell' : 'paperclip', kind,
        raised: wb?.getAttribute('data-fused-raised') ?? null, frameZ: withLayout && frame ? getComputedStyle(frame).zIndex : null,
        bodyPointerEvents: withLayout && document.body ? getComputedStyle(document.body).pointerEvents : null,
        hitAtProbe: withLayout ? hit(window.__tkProbePoint) : null, layoutObserved: withLayout, layers, ...extra,
      });
      if (window.__tkInputTimeline.length > 2400) window.__tkInputTimeline.shift();
    };
    for (const name of ['keydown', 'keyup', 'pointerdown', 'pointerup', 'click']) document.addEventListener(name, event => {
      if (name.startsWith('key') && event.key !== 'Escape') return;
      const point = 'clientX' in event ? { x: event.clientX, y: event.clientY } : null;
      read(name, {
        key: event.key, button: event.button, buttons: event.buttons, pointerId: event.pointerId,
        pointerType: event.pointerType, isPrimary: event.isPrimary,
        detail: event.detail, modifiers: { alt: event.altKey, ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey },
        trusted: event.isTrusted, target: label(event.target), point: point && { ...point, hit: withLayout ? hit(point) : null },
      });
    }, true);
    window.addEventListener('message', event => {
      const data = event.data;
      if (data?.source !== 'paperclip-ui') return;
      if (data.type === 'slot') slotView = data.view;
      if (data.type === 'overlay') {
        if (data.open) closedAt = Number.NEGATIVE_INFINITY;
        else if (overlayOpen) closedAt = Date.now();
        overlayOpen = data.open;
        read('overlay-received', { reportedOpen: data.open, observedCloseAgeMs: Date.now() - closedAt });
      } else if (data.type === 'slot-activate') queueMicrotask(() => {
        const frame = document.querySelector('iframe[title="Paperclip"]');
        const rect = frame?.getBoundingClientRect();
        const point = rect ? { x: rect.left + frame.clientLeft + data.x, y: rect.top + frame.clientTop + data.y } : null;
        const target = point ? document.elementFromPoint(point.x, point.y) : null;
        const row = target?.closest('button.tk-row-btn');
        const rows = [...document.querySelectorAll('.tk-list-sidebar button.tk-row-btn')];
        read('slot-activate-received', {
          payload: { view: data.view, x: data.x, y: data.y, sequence: data.sequence }, sourceMatchedFrame: event.source === frame?.contentWindow,
          origin: event.origin, shellView: document.querySelector('.tk-shell')?.getAttribute('data-view'),
          slotView, observedOverlayOpen: overlayOpen, observedCloseAgeMs: Date.now() - closedAt,
          point, elementAtPoint: label(target), candidateRow: row ? {
            index: rows.indexOf(row), title: row.getAttribute('title'), connected: row.isConnected,
            withinSidebar: Boolean(row.closest('.tk-list-sidebar')), selected: row.getAttribute('aria-selected'),
          } : null,
          registrationMap: 'Private React row registration map is not exposed; only the DOM candidate is observed.',
          observationPhase: 'Deferred message observer. Application-handler ordering is not assumed; the native click sequence has completed.',
        });
      });
    });
    const observe = () => new MutationObserver(mutations => {
      for (const mutation of mutations) {
        const element = mutation.target;
        if (!(element instanceof Element)) continue;
        if (mutation.attributeName === 'data-fused-raised' || (mutation.attributeName === 'style' && element === document.body)
          || (mutation.attributeName === 'data-state' && element.matches('[data-slot="dialog-overlay"], [role="dialog"], [role="alertdialog"]'))) {
          read('attribute-changed', { attribute: mutation.attributeName, value: element.getAttribute(mutation.attributeName), target: label(element) });
        }
      }
    }).observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ['data-fused-raised', 'data-state', 'style'] });
    if (document.documentElement) observe(); else document.addEventListener('DOMContentLoaded', observe, { once: true });
  }, layout);
}

/** Install before application listeners; arming later affects exactly one owned close report. */
export async function installSplitPointerInterceptor(context, origin) {
  await context.addInitScript(expectedOrigin => {
    window.__tkSplitArmed = false;
    window.__tkSplitHeld = null;
    window.__tkSplitQueue = [];
    const intercept = event => {
      const iframe = document.querySelector('iframe[title="Paperclip"]'), data = event.data;
      if (event.source !== iframe?.contentWindow || event.origin !== expectedOrigin || data?.source !== 'paperclip-ui' || data.v !== 1) return;
      if (window.__tkSplitHeld) {
        event.stopImmediatePropagation();
        window.__tkSplitQueue.push({ data, source: event.source, origin: event.origin });
        window.__tkSplitReceipt.queuedPacketTypes.push(data.type);
        return;
      }
      if (!window.__tkSplitArmed || data.type !== 'overlay' || data.open !== false || !Array.isArray(data.regions)) return;
      event.stopImmediatePropagation();
      window.__tkSplitArmed = false;
      window.__tkSplitHeld = { data, source: event.source, origin: event.origin };
      window.__tkSplitQueue = [window.__tkSplitHeld];
      window.__tkSplitReceipt.heldAt = Date.now();
      window.__tkSplitReceipt.queuedPacketTypes = [data.type];
      window.__tkSplitReceipt.capturedMessage = { source: data.source, v: data.v, type: data.type, open: data.open, regions: data.regions };
    };
    window.__tkSplitIntercept = intercept;
    window.addEventListener('message', intercept, true);
  }, origin);
}

/** Deliberately delay one owned-frame close report to force down/up onto different documents. */
export async function runSplitPointerProbe({ page, frame, origin, until, check, ctx, twoPresses = false }) {
  const selected = () => page.evaluate(() => [...document.querySelectorAll('.tk-shell .tk-row-btn')].findIndex(row => row.getAttribute('aria-selected') === 'true'));
  const reset = page.locator('.tk-shell .tk-row-btn').nth(1);
  await reset.click();
  await until(selected, value => value === 1, 5000, 'probe starts with row1 selected');
  await until(() => reset.evaluate(row => row === document.activeElement), Boolean, 5000, 'probe reset row has keyboard focus');
  await page.keyboard.press('Meta+k');
  const input = frame.locator('[cmdk-input]');
  await input.waitFor({ state: 'visible' });
  await frame.locator('[role="dialog"]').evaluate(async element => { await Promise.all(element.getAnimations({ subtree: true }).filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished.catch(() => {}))); });
  const inputBox = await input.boundingBox();
  await until(() => page.evaluate(point => document.querySelector('.tk-workbench')?.getAttribute('data-fused-raised') === 'true' && document.elementFromPoint(point.x, point.y)?.tagName === 'IFRAME', { x: inputBox.x + inputBox.width / 2, y: inputBox.y + inputBox.height / 2 }), Boolean, 5000, 'probe palette is raised and owns input');
  const box = await page.locator('.tk-shell .tk-row-btn').nth(0).boundingBox();
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.evaluate(() => {
    window.__tkInputTimeline = [];
    window.__tkSplitHeld = null;
    if (!window.__tkSplitIntercept) throw new Error('Pre-App split interceptor is not installed.');
    window.__tkSplitReceipt = { armedAt: Date.now(), installedBeforeApp: true, boundary: 'Hold one real overlayfalse packet and subsequent childprotocol packets until release, preserving the natural message FIFO order.' };
    window.__tkSplitArmed = true;
  });
  await frame.evaluate(() => { window.__tkInputTimeline = []; });
  let down = false;
  const replay = async () => page.evaluate(() => {
    window.removeEventListener('message', window.__tkSplitIntercept, true);
    const held = window.__tkSplitHeld;
    if (!held) return null;
    const packets = window.__tkSplitQueue;
    window.__tkSplitHeld = null;
    window.__tkSplitQueue = [];
    const delivered = packets.map(packet => {
      const event = new MessageEvent('message', { data: packet.data, origin: packet.origin, source: packet.source });
      window.dispatchEvent(event);
      return { type: packet.data.type, sequence: packet.data.sequence, originalOrigin: packet.origin, capturedSourcePreserved: event.source === packet.source, syntheticTransport: !event.isTrusted, focusedSessionIndex: [...document.querySelectorAll('.tk-shell .tk-row-btn')].findIndex(row => row === document.activeElement) };
    });
    const receipt = { replayedAt: Date.now(), packetTypes: delivered.map(packet => packet.type), delivered, orderPreserved: true };
    window.__tkSplitReceipt.replay = receipt;
    return receipt;
  });
  try {
    await page.keyboard.press('Escape');
    await until(() => page.evaluate(() => Boolean(window.__tkSplitHeld)), Boolean, 3000, 'one valid childclose report intercepted');
    const empty = await until(() => frame.evaluate(value => {
      const target = document.elementFromPoint(value.x, value.y);
      return { emptySlot: Boolean(target?.closest('.threadstack-slot')), openDialog: Boolean(document.querySelector('[role="dialog"][data-state="open"]')) };
    }, point), value => value.emptySlot && !value.openDialog, 3000, 'child palette semantically closed over the empty slot');
    ctx.detail.injection = await page.evaluate(() => window.__tkSplitReceipt);
    ctx.detail.childBeforeDown = empty;
    ctx.detail.point = point;
    ctx.detail.parentBeforeDown = await page.evaluate(() => ({ raised: document.querySelector('.tk-workbench')?.getAttribute('data-fused-raised') }));
    check(ctx.detail.parentBeforeDown.raised === 'true', 'Held close report actually leaves the parent frame raised before down', ctx.detail);
    check(Date.now() - ctx.detail.injection.heldAt < 200, 'Probe down remains inside the250ms close window', ctx.detail.injection);
    await page.mouse.move(point.x, point.y);
    await page.mouse.down(); down = true;
    if (twoPresses) {
      await page.mouse.up(); down = false;
      const second = await page.locator('.tk-shell .tk-row-btn').nth(1).boundingBox();
      ctx.detail.secondPoint = { x: second.x + second.width / 2, y: second.y + second.height / 2 };
      check(Date.now() - ctx.detail.injection.heldAt < 200, 'Both native presses remain inside the same250ms close window', ctx.detail.injection);
      await page.mouse.click(ctx.detail.secondPoint.x, ctx.detail.secondPoint.y);
      await until(() => page.evaluate(() => (window.__tkSplitQueue ?? []).filter(packet => packet.data.type === 'slot-activate').length), count => count === 2, 2000, 'two distinct real childpress packets queued in FIFO order');
    }
    ctx.detail.replay = await replay();
    await until(() => page.evaluate(value => document.querySelector('.tk-workbench')?.getAttribute('data-fused-raised') !== 'true' && Boolean(document.elementFromPoint(value.x, value.y)?.closest('button.tk-row-btn')), point), Boolean, 5000, 'actual frame lowered and parentrow owns the point');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (down) { await page.mouse.up(); down = false; }
    const expected = twoPresses ? 1 : 0;
    ctx.detail.selectedIndex = await until(selected, value => value === expected, 1500, 'expected row selected across the held surface boundary').catch(() => selected());
    const shell = await page.evaluate(() => window.__tkInputTimeline ?? []);
    const child = await frame.evaluate(() => window.__tkInputTimeline ?? []);
    ctx.detail.timeline = [...shell, ...child].sort((a, b) => a.at - b.at);
    const childDown = child.find(event => event.kind === 'pointerdown');
    const shellUp = shell.find(event => event.kind === 'pointerup');
    ctx.detail.splitAchieved = Boolean(childDown?.target?.cls?.includes('threadstack-slot') && shellUp);
    await ctx.shot('-native-split');
    if (twoPresses) {
      const presses = child.filter(event => event.kind === 'pointerdown' && event.target?.cls?.includes('threadstack-slot'));
      const activations = ctx.detail.replay.delivered.filter(packet => packet.type === 'slot-activate');
      ctx.detail.twoPresses = { nativeChildPresses: presses.length, activations, closeWindowRenewedByProbe: false };
      check(presses.length === 2 && activations.length === 2 && Number.isSafeInteger(activations[0].sequence) && activations[1].sequence > activations[0].sequence, 'Two trusted old-surface presses yield distinct ordered gesture sequences', ctx.detail.twoPresses);
      check(activations[0].focusedSessionIndex === 0 && activations[1].focusedSessionIndex === 1 && ctx.detail.selectedIndex === 1, 'Each distinct primarypress selects its existing row once within the same close window', ctx.detail.twoPresses);
      return 'Controlled FIFO transport delay: two native primarypresses on the old childsurface produced distinct ordered sequences. Replaying close then both original packets focused row0 then row1, with row1 selected. No close window was renewed by the probe.';
    }
    check(ctx.detail.splitAchieved, 'Fault probe achieved native down inchildslot and up inparent', ctx.detail);
    check(ctx.detail.selectedIndex === 0, 'Row0 selects across the forced old/new hit-test surface boundary', ctx.detail);
    return 'Fault-injected transport boundary: a real closed-palette report was held, native down reached the childslot, the captured report was replayed, and native up reached the parent. This does not establish the cause of the earlier Edge30 miss.';
  } finally {
    if (down) await page.mouse.up();
    await replay();
    await page.evaluate(() => { window.removeEventListener('message', window.__tkSplitIntercept, true); delete window.__tkSplitIntercept; delete window.__tkSplitHeld; delete window.__tkSplitQueue; });
  }
}

/** Outside-dismiss is a separate negative control; it must not select a row under an open modal. */
export async function verifyOutsidePaletteDismiss({ page, frame, until, check, ctx }) {
  const selected = () => page.evaluate(() => [...document.querySelectorAll('.tk-shell .tk-row-btn')].findIndex(row => row.getAttribute('aria-selected') === 'true'));
  const row = page.locator('.tk-shell .tk-row-btn').nth(1);
  await row.click();
  await until(selected, value => value === 1, 5000, 'outside-dismiss reset row1 selected');
  await until(() => row.evaluate(element => element === document.activeElement), Boolean, 5000, 'outside-dismiss reset row has focus');
  await page.keyboard.press('Meta+k');
  const input = frame.locator('[cmdk-input]');
  await input.waitFor({ state: 'visible' });
  const dialog = frame.locator('[role="dialog"]');
  await dialog.evaluate(async element => { await Promise.all(element.getAnimations({ subtree: true }).filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished.catch(() => {}))); });
  const bounds = await dialog.boundingBox(), inputBox = await input.boundingBox();
  await until(() => page.evaluate(point => document.querySelector('.tk-workbench')?.getAttribute('data-fused-raised') === 'true' && document.elementFromPoint(point.x, point.y)?.tagName === 'IFRAME', { x: inputBox.x + inputBox.width / 2, y: inputBox.y + inputBox.height / 2 }), Boolean, 5000, 'outside-dismiss palette really raised');
  const target = await page.evaluate(rect => {
    const list = document.querySelector('.tk-row-list').getBoundingClientRect();
    return [...document.querySelectorAll('.tk-shell .tk-row-btn')].map((element, index) => ({ box: element.getBoundingClientRect(), index })).flatMap(({ box, index }) => index === 1 ? [] : [{ index, x: box.left + 8, y: box.top + box.height / 2 }]).find(point => point.x >= list.left && point.x < list.right && point.y >= list.top && point.y < list.bottom && !(point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height));
  }, bounds);
  check(Boolean(target), 'A known unselected row point is outside the real open palette', { bounds, target });
  await page.mouse.click(target.x, target.y);
  await input.waitFor({ state: 'hidden' });
  const samples = await page.evaluate(() => new Promise(resolve => {
    const samples = [], end = performance.now() + 350;
    const sample = () => {
      samples.push([...document.querySelectorAll('.tk-shell .tk-row-btn')].findIndex(element => element.getAttribute('aria-selected') === 'true'));
      if (performance.now() < end) requestAnimationFrame(sample); else resolve(samples);
    };
    sample();
  }));
  ctx.detail.outsideDismiss = { target, selectedBefore: 1, selectedSamples: samples, observationWindowMs: 350 };
  check(samples.length > 0 && samples.every(index => index === 1), 'An outside click dismisses the open palette without selecting the underlying row', ctx.detail.outsideDismiss);
  await ctx.shot('-outside-dismiss');
}
