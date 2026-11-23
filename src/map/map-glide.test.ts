import { describe, expect, it } from 'vitest';
import {
  addPanSample,
  GLIDE_TIME_CONSTANT_MS,
  glideReach,
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
  it('slows smoothly and stops cleanly, covering exactly its reach', () => {
    const reach = glideReach(2);
    const { x, y, time } = runGlide({ x: 2, y: 0 }, 16);
    expect(y).toBe(0);
    expect(x).toBeCloseTo(reach.distance, 6);
    // Less than speed × τ, which a glide with no braking would cover (in about twice the time).
    expect(x).toBeLessThan(2 * GLIDE_TIME_CONSTANT_MS);
    expect(time).toBeGreaterThanOrEqual(reach.time);
    expect(time).toBeLessThan(reach.time + 16);
    expect(time).toBeLessThan(700);
  });

  it('spends little time creeping along at under a pixel a frame, which looks like shaking', () => {
    // A typical flick, at 60 frames a second: count the frames that move it less than a pixel.
    let velocity: Velocity | null = { x: 1.5, y: 0 };
    let creeping = 0;
    while (velocity) {
      const step = glideStep(velocity, 1000 / 60);
      if (Math.abs(step.dx) < 1) creeping += 1;
      velocity = step.velocity;
    }
    expect(creeping).toBeLessThanOrEqual(5);
  });

  it('goes the same distance at any frame rate', () => {
    const at60 = runGlide({ x: 1, y: 1 }, 1000 / 60);
    const at120 = runGlide({ x: 1, y: 1 }, 1000 / 120);
    const at30 = runGlide({ x: 1, y: 1 }, 1000 / 30);
    expect(at120.x).toBeCloseTo(at60.x, 0);
    expect(at30.x).toBeCloseTo(at60.x, 0);
  });
});
