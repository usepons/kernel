import { assertEquals } from 'jsr:@std/assert';
import { TypedEmitter } from '../../src/lifecycle/typed-emitter.ts';

Deno.test('TypedEmitter: emit fires registered handler with correct arg', () => {
  const emitter = new TypedEmitter();
  const received: string[] = [];
  emitter.on('module:exit', (id) => received.push(id));
  emitter.emit('module:exit', 'mod-a');
  assertEquals(received, ['mod-a']);
});

Deno.test('TypedEmitter: multiple handlers on same event all fire', () => {
  const emitter = new TypedEmitter();
  let count = 0;
  emitter.on('module:exit', () => count++);
  emitter.on('module:exit', () => count++);
  emitter.on('module:exit', () => count++);
  emitter.emit('module:exit', 'x');
  assertEquals(count, 3);
});

Deno.test('TypedEmitter: handlers fire in registration order', () => {
  const emitter = new TypedEmitter();
  const order: number[] = [];
  emitter.on('module:exit', () => order.push(1));
  emitter.on('module:exit', () => order.push(2));
  emitter.on('module:exit', () => order.push(3));
  emitter.emit('module:exit', 'y');
  assertEquals(order, [1, 2, 3]);
});

Deno.test('TypedEmitter: emit with no handlers does not throw', () => {
  const emitter = new TypedEmitter();
  // should not throw
  emitter.emit('module:exit', 'no-handlers');
});

Deno.test('TypedEmitter: timers:clear event fires with correct moduleId', () => {
  const emitter = new TypedEmitter();
  const cleared: string[] = [];
  emitter.on('module:timers:clear', (id) => cleared.push(id));
  emitter.emit('module:timers:clear', 'mod-b');
  assertEquals(cleared, ['mod-b']);
});

Deno.test('TypedEmitter: different events do not cross-fire', () => {
  const emitter = new TypedEmitter();
  const exits: string[] = [];
  const clears: string[] = [];
  emitter.on('module:exit', (id) => exits.push(id));
  emitter.on('module:timers:clear', (id) => clears.push(id));
  emitter.emit('module:exit', 'exit-mod');
  assertEquals(exits, ['exit-mod']);
  assertEquals(clears, []);
});

Deno.test('TypedEmitter: handler receives correct arg on each emit', () => {
  const emitter = new TypedEmitter();
  const received: string[] = [];
  emitter.on('module:exit', (id) => received.push(id));
  emitter.emit('module:exit', 'first');
  emitter.emit('module:exit', 'second');
  assertEquals(received, ['first', 'second']);
});
