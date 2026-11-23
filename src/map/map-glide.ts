/**
 * The glide after a flick on a touch screen. Touch panning is done in script rather than by the browser, because on
 * iOS a tap that lands while a native scroll is still gliding is swallowed: it only stops the scroll, and the page
 * never hears of it. A scripted glide never does that, so a tap during one both stops it and counts.
 */

export interface PanSample {
  t: number;
  x: number;
  y: number;
}

/** Only the last part of a drag counts towards the flick. */
export const VELOCITY_WINDOW_MS = 100;
/** A finger held still for this long before lifting doesn't flick. */
export const STILL_BEFORE_RELEASE_MS = 60;
/** Slower releases (px/ms) don't glide. */
export const MIN_GLIDE_SPEED = 0.25;
/** Faster flicks are capped, so one flick can't throw the map from one side of London to the other. */
export const MAX_GLIDE_SPEED = 2.5;
/** Speed decays as e^(−t/τ): a glide covers speed × τ in all and has mostly stopped after about 2τ. */
export const GLIDE_TIME_CONSTANT_MS = 225;
/** Below this speed (px/ms) the glide ends. */
export const STOP_SPEED = 0.02;

export interface Velocity {
  x: number;
  y: number;
}

/** Keeps only the samples the velocity needs. */
export function addPanSample(samples: PanSample[], sample: PanSample): PanSample[] {
  return [...samples.filter((earlier) => sample.t - earlier.t <= VELOCITY_WINDOW_MS), sample];
}

/**
 * The finger's velocity (px/ms, in screen direction) as it lifted at `now`, or null if it shouldn't glide: too slow,
 * held still before lifting, or too few samples.
 */
export function releaseVelocity(samples: readonly PanSample[], now: number): Velocity | null {
  const last = samples.at(-1);
  if (!last || now - last.t > STILL_BEFORE_RELEASE_MS) return null;
  const first = samples.find((sample) => last.t - sample.t <= VELOCITY_WINDOW_MS);
  if (!first || last.t - first.t < 1) return null;
  const elapsed = last.t - first.t;
  let x = (last.x - first.x) / elapsed;
  let y = (last.y - first.y) / elapsed;
  const speed = Math.hypot(x, y);
  if (speed < MIN_GLIDE_SPEED) return null;
  if (speed > MAX_GLIDE_SPEED) {
    x *= MAX_GLIDE_SPEED / speed;
    y *= MAX_GLIDE_SPEED / speed;
  }
  return { x, y };
}

/** Advances a glide by `dt` ms: how far it moves (px) and its new velocity, which is null once it has stopped. */
export function glideStep(velocity: Velocity, dt: number): { dx: number; dy: number; velocity: Velocity | null } {
  const decay = Math.exp(-dt / GLIDE_TIME_CONSTANT_MS);
  // The exact distance under exponential decay over dt, so the glide is the same at any frame rate.
  const distance = GLIDE_TIME_CONSTANT_MS * (1 - decay);
  const next = { x: velocity.x * decay, y: velocity.y * decay };
  return {
    dx: velocity.x * distance,
    dy: velocity.y * distance,
    velocity: Math.hypot(next.x, next.y) < STOP_SPEED ? null : next
  };
}
