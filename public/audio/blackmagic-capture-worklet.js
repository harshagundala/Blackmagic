class BlackmagicCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const inputGroup = inputs[0];
    const input = inputGroup && inputGroup[0];
    if (!input || input.length === 0) {
      return true;
    }

    const copy = new Float32Array(input.length);
    copy.set(input);
    this.port.postMessage(
      {
        type: "samples",
        samples: copy.buffer,
        startSampleIndex: currentFrame,
        sampleRate,
      },
      [copy.buffer],
    );

    return true;
  }
}

registerProcessor("blackmagic-capture", BlackmagicCaptureProcessor);
