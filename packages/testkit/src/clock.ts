import type { Clock } from "@rehearsal/core";

export class FakeClock implements Clock {
  #ms: number;

  constructor(start = "2026-10-01T12:00:00.000Z") {
    this.#ms = Date.parse(start);
  }

  now(): Date {
    return new Date(this.#ms);
  }

  advance(ms: number): void {
    this.#ms += ms;
  }
}
