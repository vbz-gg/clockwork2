/**
 * Playing what a simulation asks for.
 *
 * Effects come out of `effects()` after a tick rather than from a call inside
 * it. That is what stops a sound firing twice because one frame ran two steps,
 * and it is why a headless replay has nothing to stub: there is no audio call
 * anywhere in the simulation to stub out.
 *
 * Sounds are generated rather than loaded. A generated buffer costs no
 * download, no asset budget, and no licence declaration.
 */

import type { Effect } from "@clockwork2/kernel"

export type SoundRecipe = (
  sampleRate: number,
  write: (index: number, value: number) => void,
  samples: number,
) => void

export interface AudioSinkOptions {
  /** Recipes by effect name, each filling one mono buffer. */
  readonly sounds: Readonly<
    Record<string, { seconds: number; recipe: SoundRecipe }>
  >
  readonly volume?: number
}

/**
 * A sink for `{ type: "sound", data: "<name>" }` effects.
 *
 * It is created lazily on the first effect, because a browser will not give a
 * page an audio context until the player has touched something.
 */
export class AudioSink {
  private context: AudioContext | null = null
  private buffers = new Map<string, AudioBuffer>()
  private failed = false

  constructor(private readonly options: AudioSinkOptions) {}

  /** Hand this straight to the host's onEffects. */
  readonly handle = (effects: readonly Effect[]): void => {
    for (const effect of effects) {
      if (effect.type !== "sound" || typeof effect.data !== "string") continue
      this.play(effect.data)
    }
  }

  private ensure(): AudioContext | null {
    if (this.failed) return null
    if (this.context !== null) return this.context
    try {
      this.context = new AudioContext()
      for (const [name, { seconds, recipe }] of Object.entries(
        this.options.sounds,
      )) {
        const samples = Math.floor(this.context.sampleRate * seconds)
        const buffer = this.context.createBuffer(
          1,
          samples,
          this.context.sampleRate,
        )
        const channel = buffer.getChannelData(0)
        recipe(
          this.context.sampleRate,
          (index, value) => {
            channel[index] = value
          },
          samples,
        )
        this.buffers.set(name, buffer)
      }
      return this.context
    } catch {
      // No audio is a missing flourish, never a broken game.
      this.failed = true
      return null
    }
  }

  play(name: string): void {
    const context = this.ensure()
    const buffer = this.buffers.get(name)
    if (context === null || buffer === undefined) return
    try {
      const source = context.createBufferSource()
      source.buffer = buffer
      const gain = context.createGain()
      gain.gain.value = this.options.volume ?? 0.3
      source.connect(gain).connect(context.destination)
      source.start()
    } catch {
      // Same again: a sound that will not play is not a reason to stop.
    }
  }

  /** Browsers hold the context suspended until a gesture inside the frame. */
  async unlock(): Promise<void> {
    const context = this.ensure()
    if (context === null) return
    if (context.state === "suspended") {
      try {
        await context.resume()
      } catch {
        // Nothing to do; the next gesture may work.
      }
    }
  }

  close(): void {
    void this.context?.close()
    this.context = null
    this.buffers.clear()
  }
}
