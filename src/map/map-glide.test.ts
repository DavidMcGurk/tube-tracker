import { describe, expect, it } from 'vitest';
import {
  addPanSample,
  GLIDE_TIME_CONSTANT_MS,
  glideStep,
  MAX_GLIDE_SPEED,
  releaseVelocity,
  STILL_BEFORE_RELEASE_MS,
  type PanSample,
  type Velocity
} from './map-glide';

/** A drag at a steady speed (px/ms) for `duration` ms, sampled every 16 ms. */
function drag(speedX: number, speedY: number, duration: number): PanSample[] {
  let samples: PanSample[] = [];
  for (let t = 0; t <= duration; t += 16) samples = addPanSample(samples, { t, x: speedX * t, y: speedY * t });
  return samples;
}

function runGlide(start: Velocity, frameMs: number) {
  let velocity: Velocity | null = start;
  let x = 0;
  let y = 0;
  let time = 0;
  while (velocity) {
    const step = glideStep(velocity, frameMs);
    x += step.dx;
    y += step.dy;
    velocity = step.velocity;
    time += frameMs;
  }
  return { x, y, time };
}

describe('releaseVelocity', () => {
  it('measures a flick from the last 100 ms of the drag', () => {
    const samples = drag(1.5, -0.5, 300);
    const velocity = releaseVelocity(samples, samples.at(-1)!.t + 5)!;
    expect(velocity.x).toBeCloseTo(1.5);
    expect(velocity.y).toBeCloseTo(-0.5);
    expect(samples.every((sample) => samples.at(-1)!.t - sample.t <= 100)).toBe(true);
  });

  it('doesn’t glide after a slow drag, a finger held still before lifting, or a tap', () => {
    const slow = drag(0.1, 0.1, 300);
    expect(releaseVelocity(slow, slow.at(-1)!.t)).toBeNull();
    const fast = drag(2, 0, 300);
    expect(releaseVelocity(fast, fast.at(-1)!.t + STILL_BEFORE_RELEASE_MS + 1)).toBeNull();
    expect(releaseVelocity([{ t: 0, x: 0, y: 0 }], 0)).toBeNull();
    expect(releaseVelocity([], 0)).toBeNull();
  });

  it('caps the speed of a very fast flick, keeping its direction', () => {
    const samples = drag(30, 40, 200);
    const velocity = releaseVelocity(samples, samples.at(-1)!.t)!;
    expect(Math.hypot(velocity.x, velocity.y)).toBeCloseTo(MAX_GLIDE_SPEED);
    expect(velocity.y / velocity.x).toBeCloseTo(40 / 30);
  });
});

describe('glideStep', () => {
  it('slows smoothly and stops, covering speed × τ', () => {
    const { x, y, time } = runGlide({ x: 2, y: 0 }, 16);
    expect(y).toBe(0);
    // Stopping at a small speed leaves a little of the ideal distance unused.
    expect(x).toBeGreaterThan(2 * GLIDE_TIME_CONSTANT_MS * 0.98);
    expect(x).toBeLessThanOrEqual(2 * GLIDE_TIME_CONSTANT_MS);
    expect(time).toBeLessThan(2000);
  });

  it('goes the same distance at any frame rate', () => {
    const at60 = runGlide({ x: 1, y: 1 }, 1000 / 60);
    const at120 = runGlide({ x: 1, y: 1 }, 1000 / 120);
    const at30 = runGlide({ x: 1, y: 1 }, 1000 / 30);
    expect(at120.x).toBeCloseTo(at60.x, 0);
    expect(at30.x).toBeCloseTo(at60.x, 0);
  });
});
