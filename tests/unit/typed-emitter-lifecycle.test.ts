import { assertEquals } from "jsr:@std/assert";
import { TypedEmitter } from "../../src/lifecycle/typed-emitter.ts";

Deno.test("emit('module:exit') calls all registered exit handlers with correct moduleId", () => {
  const emitter = new TypedEmitter();
  const received: string[] = [];

  // Simulate multiple subscribers (e.g. ProcessPool, IpcRouter, ServiceDirectory)
  emitter.on("module:exit", (moduleId) => received.push(`handler-1:${moduleId}`));
  emitter.on("module:exit", (moduleId) => received.push(`handler-2:${moduleId}`));
  emitter.on("module:exit", (moduleId) => received.push(`handler-3:${moduleId}`));

  emitter.emit("module:exit", "my-module");

  assertEquals(received, [
    "handler-1:my-module",
    "handler-2:my-module",
    "handler-3:my-module",
  ]);
});

Deno.test("emit('module:timers:clear') calls all registered timer-clear handlers", () => {
  const emitter = new TypedEmitter();
  const received: string[] = [];

  // Simulate HealthMonitor and other timer-owning subsystems subscribing
  emitter.on("module:timers:clear", (moduleId) => received.push(`timer-clear-1:${moduleId}`));
  emitter.on("module:timers:clear", (moduleId) => received.push(`timer-clear-2:${moduleId}`));

  emitter.emit("module:timers:clear", "timer-module");

  assertEquals(received, [
    "timer-clear-1:timer-module",
    "timer-clear-2:timer-module",
  ]);
});

Deno.test("different events do not cross-fire", () => {
  const emitter = new TypedEmitter();
  const exitCalls: string[] = [];
  const timerCalls: string[] = [];

  emitter.on("module:exit", (id) => exitCalls.push(id));
  emitter.on("module:timers:clear", (id) => timerCalls.push(id));

  emitter.emit("module:exit", "mod-a");
  assertEquals(exitCalls, ["mod-a"]);
  assertEquals(timerCalls, []);

  emitter.emit("module:timers:clear", "mod-b");
  assertEquals(exitCalls, ["mod-a"]);
  assertEquals(timerCalls, ["mod-b"]);
});
