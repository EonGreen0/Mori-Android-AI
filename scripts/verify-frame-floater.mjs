import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/frame-floater.js', import.meta.url), 'utf8');
const handlers = new Map();
const calls = [];
let resolveOrigin;
let resolveMove;
const handle = {
  addEventListener: (name, handler) => handlers.set(name, handler),
  setPointerCapture() {},
  releasePointerCapture(pointerId) { handlers.get('lostpointercapture')?.({ pointerId }); },
};
const invoke = (command, args) => {
  calls.push({ command, args });
  if (args.position === null) return new Promise(resolve => { resolveOrigin = resolve; });
  return new Promise(resolve => { resolveMove = resolve; });
};
let toggles = 0;
vm.runInNewContext(source.replace(/^import .*;\r?\n/m, ''), {
  initFavoritesPanel: () => ({ toggle: () => { toggles += 1; } }),
  document: { getElementById: () => null, querySelector: () => handle },
  window: { __TAURI__: { core: { invoke } } },
  console,
  setTimeout,
});
const pointer = (x, y, button = 0) => ({
  button, pointerId: 1, screenX: x, screenY: y, preventDefault() {},
});
const tick = () => new Promise(resolve => setImmediate(resolve));

handlers.get('pointerdown')(pointer(100, 200, 2));
assert.equal(calls.length, 0, 'right-click must not move the floater');

// Native initialization can finish after the user has already released the mouse.
handlers.get('pointerdown')(pointer(100, 200));
handlers.get('pointermove')(pointer(110, 210));
handlers.get('pointerup')(pointer(120, 215));
resolveOrigin({ x: 10, y: 20, scaleFactor: 1.5 });
await tick();
assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1).args.position)), { x: 40, y: 43 });
resolveMove({});
await tick();

// A slow native move must not lose newer movement or the final mouse-up position.
handlers.get('pointerdown')(pointer(200, 300));
resolveOrigin({ x: 40, y: 43, scaleFactor: 1.5 });
await tick();
handlers.get('pointermove')(pointer(210, 310));
handlers.get('pointermove')(pointer(230, 320));
handlers.get('pointerup')(pointer(240, 330));
resolveMove({});
await tick();
assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1).args.position)), { x: 100, y: 88 });
resolveMove({});
await tick();

// Cancellation must discard late origin responses, while another pointer's
// cancellation must not interfere with the active pointer.
handlers.get('pointerdown')(pointer(300, 400));
const cancelledOrigin = resolveOrigin;
handlers.get('pointermove')(pointer(320, 420));
handlers.get('pointercancel')({ pointerId: 1 });
const firstQuery = calls.length;
handlers.get('pointerdown')(pointer(300, 400));
assert.equal(calls.length, firstQuery + 1);
cancelledOrigin({ x: 100, y: 88, scaleFactor: 1.5 });
await tick();
assert.equal(calls.length, firstQuery + 1, 'cancelled gesture must not submit a late move');
handlers.get('lostpointercapture')({ pointerId: 2 });
handlers.get('pointerdown')(pointer(300, 400));
assert.equal(calls.length, firstQuery + 1, 'another pointer must not cancel the active drag');
handlers.get('lostpointercapture')({ pointerId: 1 });
handlers.get('pointerdown')(pointer(300, 400));
assert.equal(calls.length, firstQuery + 2, 'lost capture must allow the next gesture');
assert.ok(calls.every(call => call.command === 'tauri_move_frame_floater'));
handlers.get('pointercancel')({ pointerId: 1 });
handlers.get('pointerdown')(pointer(100, 100));
const clickOrigin = resolveOrigin;
handlers.get('pointermove')(pointer(102, 101));
handlers.get('pointerup')(pointer(102, 101));
await tick();
assert.equal(toggles, 1, 'a click with small jitter opens favorites once');
const afterClick = calls.length;
clickOrigin({ x: 100, y: 100, scaleFactor: 1 });
await tick();
assert.equal(calls.length, afterClick, 'a completed click never causes a late move');
handlers.get('click')({ detail: 1 });
assert.equal(toggles, 1, 'pointer click must not double-toggle');
handlers.get('click')({ detail: 0 });
await tick();
assert.equal(toggles, 2, 'keyboard button activation opens favorites');
handlers.get('pointerdown')(pointer(200, 200));
resolveOrigin({ x: 100, y: 100, scaleFactor: 1 });
await tick();
handlers.get('pointermove')(pointer(210, 210));
handlers.get('pointerup')(pointer(215, 215));
handlers.get('click')({ detail: 0 });
await tick();
assert.equal(toggles, 2, 'expansion waits for the last native move');
resolveMove({}); await tick();
resolveMove({}); await tick();
assert.equal(toggles, 3, 'expansion continues after the final drag position is saved');
handlers.get('pointerdown')(pointer(300, 400));
resolveOrigin({ x: 115, y: 115, scaleFactor: 1 }); await tick();
handlers.get('pointermove')(pointer(310, 410));
handlers.get('pointercancel')({ pointerId: 1 });
handlers.get('click')({ detail: 0 }); await tick();
assert.equal(toggles, 3, 'expansion also waits for a cancelled in-flight move');
resolveMove({}); await tick();
assert.equal(toggles, 4, 'cancelled drag settles before expansion');
console.log('PASS: floater drag timing, DPI/cancellation and click/keyboard expansion');
