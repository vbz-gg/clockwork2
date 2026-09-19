/**
 * The demo's three sounds, generated rather than loaded.
 *
 * They live here, in the presentation, and that boundary is the point. A
 * recipe may call `Math.exp` and `Math.sin` freely: nothing it produces can
 * reach the simulation, so an engine that rounds an envelope differently
 * changes how the explosion sounds and not who won. The same call inside
 * `tick()` would be refused by the scan and would throw at the trap.
 *
 * Clockwork 1's explosion used `Math.random()` for its noise, from inside the
 * same module the game imported.
 */

import type { AudioSinkOptions } from "@clockwork2/host-bridge"

/** A cheap deterministic noise source, so the sound is the same every time. */
function noise(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0
    return state / 2147483648 - 1
  }
}

export const SOUNDS: AudioSinkOptions["sounds"] = {
  eat: {
    seconds: 0.12,
    recipe: (sampleRate, write, samples) => {
      // 400 Hz up to 800 Hz, decaying fast.
      for (let i = 0; i < samples; i++) {
        const t = i / sampleRate
        const progress = i / samples
        const frequency = 400 + 400 * progress
        write(i, Math.sin(2 * Math.PI * frequency * t) * Math.exp(-8 * t) * 0.6)
      }
    },
  },
  thud: {
    seconds: 0.2,
    recipe: (sampleRate, write, samples) => {
      // 150 Hz down to 50 Hz: a dull stop.
      for (let i = 0; i < samples; i++) {
        const t = i / sampleRate
        const progress = i / samples
        const frequency = 150 - 100 * progress
        write(
          i,
          Math.sin(2 * Math.PI * frequency * t) * Math.exp(-12 * t) * 0.8,
        )
      }
    },
  },
  explosion: {
    seconds: 0.9,
    recipe: (sampleRate, write, samples) => {
      const random = noise(0x5eed)
      for (let i = 0; i < samples; i++) {
        const t = i / sampleRate
        const envelope = Math.exp(-3.5 * t)
        const rumble = Math.sin(2 * Math.PI * 60 * t) * 0.5
        write(i, (random() * 0.7 + rumble) * envelope * 0.7)
      }
    },
  },
}
