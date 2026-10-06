// The audio thread's half of push-to-talk: it hands each 128-sample block to
// the page and does nothing else, so the resampling stays testable there.
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}
declare const registerProcessor: (name: string, processor: typeof AudioWorkletProcessor) => void

class Tap extends AudioWorkletProcessor {
  process(inputs: Float32Array[][]): boolean {
    const mono = inputs[0]?.[0]
    if (mono) this.port.postMessage(mono.slice())
    return true
  }
}

registerProcessor('yantra-tap', Tap)
