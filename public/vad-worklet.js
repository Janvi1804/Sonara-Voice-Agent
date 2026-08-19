/**
 * SONARA VAD AudioWorklet Processor
 * Runs on the audio thread — collects PCM frames and posts them to main thread.
 */
class VadProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._buffer = [];
        this._frameSize = 512;
    }

    process(inputs) {
        const input = inputs[0];
        if (!input || !input[0]) return true;

        const channel = input[0];
        for (let i = 0; i < channel.length; i++) {
            this._buffer.push(channel[i]);
        }

        while (this._buffer.length >= this._frameSize) {
            const frame = new Float32Array(this._buffer.splice(0, this._frameSize));
            this.port.postMessage({ type: 'frame', data: frame }, [frame.buffer]);
        }
        return true;
    }
}

registerProcessor('vad-processor', VadProcessor);