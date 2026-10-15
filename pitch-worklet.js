// Phase-vocoder pitch shifter (analysis/synthesis after S. Bernsee's
// smbPitchShift) with Laroche-Dolson identity phase locking and transient phase
// resets: STFT, true per-bin frequency from phase advance, spectral peaks
// moved to their shifted bins with their neighbouring bins carried along at
// fixed phase offsets, inverse STFT with overlap-add.
// Output latency is FFT_SIZE - FFT_SIZE / OVERLAP samples.
const FFT_SIZE = 4096;
const OVERLAP = 4;
const HALF = FFT_SIZE / 2;
const STEP = FFT_SIZE / OVERLAP;
const LATENCY = FFT_SIZE - STEP;
const TWO_PI = 2 * Math.PI;
// Hann applied at analysis and synthesis: overlap-added w^2 sums to OVERLAP * 3/8.
const HANN_SQUARE_MEAN = 0.375;
const MIN_PEAK_MAGNITUDE = 1e-6;
// Summed positive magnitude increase relative to the previous frame's total
// that counts as an onset; tune down for softer attacks, up if sustained
// notes get phase-reset too often.
const TRANSIENT_THRESHOLD = 1.0;

const WINDOW = new Float64Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i++) WINDOW[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / FFT_SIZE);

const BIT_REVERSE = new Uint32Array(FFT_SIZE);
for (let i = 0, bits = Math.log2(FFT_SIZE); i < FFT_SIZE; i++) {
  let r = 0;
  for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
  BIT_REVERSE[i] = r;
}
const COS_TABLE = new Float64Array(HALF);
const SIN_TABLE = new Float64Array(HALF);
for (let i = 0; i < HALF; i++) {
  COS_TABLE[i] = Math.cos((TWO_PI * i) / FFT_SIZE);
  SIN_TABLE[i] = Math.sin((TWO_PI * i) / FFT_SIZE);
}

// In-place radix-2 FFT; `sign` is -1 forward, +1 inverse. Neither direction
// is normalised (the synthesis stage compensates).
function fft(re, im, sign) {
  for (let i = 0; i < FFT_SIZE; i++) {
    const j = BIT_REVERSE[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= FFT_SIZE; size <<= 1) {
    const half = size >> 1;
    const stride = FFT_SIZE / size;
    for (let start = 0; start < FFT_SIZE; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = COS_TABLE[k * stride];
        const wi = sign * SIN_TABLE[k * stride];
        const a = start + k;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

class ChannelState {
  constructor() {
    this.inFifo = new Float64Array(FFT_SIZE);
    this.outFifo = new Float64Array(FFT_SIZE);
    this.outAccum = new Float64Array(2 * FFT_SIZE);
    this.re = new Float64Array(FFT_SIZE);
    this.im = new Float64Array(FFT_SIZE);
    this.lastPhase = new Float64Array(HALF + 1);
    this.sumPhase = new Float64Array(HALF + 1);
    this.anaMagn = new Float64Array(HALF + 1);
    this.anaFreq = new Float64Array(HALF + 1);
    this.anaPhase = new Float64Array(HALF + 1);
    this.prevMagn = new Float64Array(HALF + 1);
    this.synRe = new Float64Array(HALF + 1);
    this.synIm = new Float64Array(HALF + 1);
    this.peaks = new Int32Array(HALF + 1);
    this.transientCooldown = 0;
    this.rover = LATENCY;
  }

  detectTransient() {
    const { anaMagn, prevMagn } = this;
    let flux = 0;
    let previousTotal = 0;
    for (let k = 1; k <= HALF; k++) {
      const rise = anaMagn[k] - prevMagn[k];
      if (rise > 0) flux += rise;
      previousTotal += prevMagn[k];
    }
    prevMagn.set(anaMagn);
    if (this.transientCooldown > 0) {
      this.transientCooldown--;
      return false;
    }
    if (previousTotal > MIN_PEAK_MAGNITUDE && flux / previousTotal > TRANSIENT_THRESHOLD) {
      this.transientCooldown = OVERLAP;
      return true;
    }
    return false;
  }

  processFrame(ratio, sampleRate) {
    const { re, im, lastPhase, sumPhase, anaMagn, anaFreq, anaPhase, synRe, synIm, peaks } = this;
    const freqPerBin = sampleRate / FFT_SIZE;
    const expected = (TWO_PI * STEP) / FFT_SIZE;

    for (let k = 0; k < FFT_SIZE; k++) {
      re[k] = this.inFifo[k] * WINDOW[k];
      im[k] = 0;
    }
    fft(re, im, -1);

    for (let k = 0; k <= HALF; k++) {
      anaMagn[k] = 2 * Math.hypot(re[k], im[k]);
      const phase = Math.atan2(im[k], re[k]);
      anaPhase[k] = phase;
      let delta = phase - lastPhase[k] - k * expected;
      lastPhase[k] = phase;
      let qpd = Math.round(delta / Math.PI);
      qpd += qpd >= 0 ? qpd & 1 : -(qpd & 1);
      delta -= Math.PI * qpd;
      anaFreq[k] = k * freqPerBin + ((OVERLAP * delta) / TWO_PI) * freqPerBin;
    }

    const transient = this.detectTransient();

    let peakCount = 0;
    for (let k = 2; k < HALF - 1; k++) {
      const m = anaMagn[k];
      if (
        m > MIN_PEAK_MAGNITUDE &&
        m > anaMagn[k - 1] && m > anaMagn[k - 2] &&
        m >= anaMagn[k + 1] && m >= anaMagn[k + 2]
      ) {
        peaks[peakCount++] = k;
      }
    }

    synRe.fill(0);
    synIm.fill(0);
    for (let i = 0; i < peakCount; i++) {
      const p = peaks[i];
      const regionStart = i === 0 ? 0 : ((peaks[i - 1] + p) >> 1) + 1;
      const regionEnd = i === peakCount - 1 ? HALF : (p + peaks[i + 1]) >> 1;
      const shiftedBin = (anaFreq[p] * ratio) / freqPerBin;
      const target = Math.round(shiftedBin);
      if (target < 0 || target > HALF) continue;

      const peakPhase = transient ? anaPhase[p] : sumPhase[target] + shiftedBin * expected;
      for (let k = regionStart; k <= regionEnd; k++) {
        const t = target + k - p;
        if (t < 0 || t > HALF) continue;
        const phase = peakPhase + anaPhase[k] - anaPhase[p];
        synRe[t] += anaMagn[k] * Math.cos(phase);
        synIm[t] += anaMagn[k] * Math.sin(phase);
      }
    }

    for (let k = 0; k <= HALF; k++) {
      re[k] = synRe[k];
      im[k] = synIm[k];
      if (synRe[k] !== 0 || synIm[k] !== 0) sumPhase[k] = Math.atan2(synIm[k], synRe[k]);
    }
    for (let k = HALF + 1; k < FFT_SIZE; k++) {
      re[k] = 0;
      im[k] = 0;
    }
    fft(re, im, 1);

    const scale = 2 / (HALF * OVERLAP * OVERLAP * HANN_SQUARE_MEAN);
    for (let k = 0; k < FFT_SIZE; k++) this.outAccum[k] += WINDOW[k] * re[k] * scale;
    for (let k = 0; k < STEP; k++) this.outFifo[k] = this.outAccum[k];
    this.outAccum.copyWithin(0, STEP, STEP + FFT_SIZE);
    this.outAccum.fill(0, FFT_SIZE, FFT_SIZE + STEP);
    this.inFifo.copyWithin(0, STEP, STEP + LATENCY);
  }

  process(input, output, ratio, sampleRate) {
    for (let i = 0; i < input.length; i++) {
      this.inFifo[this.rover] = input[i];
      output[i] = this.outFifo[this.rover - LATENCY];
      this.rover++;
      if (this.rover >= FFT_SIZE) {
        this.rover = LATENCY;
        this.processFrame(ratio, sampleRate);
      }
    }
  }
}

class PitchShifter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'ratio', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' }];
  }

  constructor() {
    super();
    this.channels = [];
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input.length) return true;

    const ratio = parameters.ratio[0];
    while (this.channels.length < output.length) this.channels.push(new ChannelState());
    for (let c = 0; c < output.length; c++) {
      this.channels[c].process(input[Math.min(c, input.length - 1)], output[c], ratio, sampleRate);
    }
    return true;
  }
}

registerProcessor('pitch-shifter', PitchShifter);
