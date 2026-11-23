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
/**
 * The glide slows in proportion to its speed (time constant τ) and also by a steady braking (BRAKE_SPEED / τ per ms).
 * Fast, it feels like a free glide; slow, the braking takes over and brings it to a clean stop. Without the braking it
 * would creep the last few pixels for a quarter of a second, one whole pixel at a time, which looks like shaking.
 */
export const GLIDE_TIME_CONSTANT_MS = 225;
/** The speed (px/ms) below which braking, rather than the glide's own slowing, mostly brings it to a stop. */
export const BRAKE_SPEED = 0.35;

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

/**
 * Advances a glide by `dt` ms: how far it moves (px) and its new velocity, which is null once it has stopped.
 * The speed s follows ds/dt = −(s + BRAKE_SPEED) / τ, worked out exactly over dt so the glide is the same at any frame
 * rate: s(t) = (s₀ + b)·e^(−t/τ) − b, reaching 0 at t = τ·ln((s₀ + b) / b).
 */
export function glideStep(velocity: Velocity, dt: number): { dx: number; dy: number; velocity: Velocity | null } {
  const tau = GLIDE_TIME_CONSTANT_MS;
  const speed = Math.hypot(velocity.x, velocity.y);
  if (speed <= 0) return { dx: 0, dy: 0, velocity: null };
  const lifted = speed + BRAKE_SPEED;
  const stopsIn = tau * Math.log(lifted / BRAKE_SPEED);
  const t = Math.min(dt, stopsIn);
  // ∫ s dt from 0 to t.
  const distance = lifted * tau * (1 - Math.exp(-t / tau)) - BRAKE_SPEED * t;
  const nextSpeed = dt >= stopsIn ? 0 : lifted * Math.exp(-dt / tau) - BRAKE_SPEED;
  const scale = distance / speed;
  return {
    dx: velocity.x * scale,
    dy: velocity.y * scale,
    velocity: nextSpeed > 0 ? { x: (velocity.x * nextSpeed) / speed, y: (velocity.y * nextSpeed) / speed } : null
  };
}

/** How far (px) and how long (ms) a glide at this speed goes before it stops. */
export function glideReach(speed: number) {
  const lifted = speed + BRAKE_SPEED;
  const time = GLIDE_TIME_CONSTANT_MS * Math.log(lifted / BRAKE_SPEED);
  return { distance: GLIDE_TIME_CONSTANT_MS * speed - BRAKE_SPEED * time, time };
}
