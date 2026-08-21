/**
 * A radix-2 FFT, here for exactly one reason: the mix's reverb is a 1.9-second impulse
 * response, and convolving a six-second render against it directly is ninety thousand
 * multiply-adds per sample. Frequency domain turns that into three transforms.
 *
 * In-place, iterative, and deliberately the smallest thing that does the job -- nothing
 * in this file is measured, it only has to be correct.
 */
function transform(real: Float64Array, imaginary: Float64Array, inverse: boolean): void {
  const size = real.length;
  for (let index = 1, bit = 0; index < size; index += 1) {
    let mask = size >> 1;
    for (; bit & mask; mask >>= 1) bit ^= mask;
    bit ^= mask;
    if (index < bit) {
      [real[index], real[bit]] = [real[bit], real[index]];
      [imaginary[index], imaginary[bit]] = [imaginary[bit], imaginary[index]];
    }
  }
  for (let length = 2; length <= size; length <<= 1) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / length;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let start = 0; start < size; start += length) {
      let spinReal = 1;
      let spinImaginary = 0;
      for (let offset = 0; offset < length / 2; offset += 1) {
        const a = start + offset;
        const b = a + length / 2;
        const productReal = real[b] * spinReal - imaginary[b] * spinImaginary;
        const productImaginary = real[b] * spinImaginary + imaginary[b] * spinReal;
        real[b] = real[a] - productReal;
        imaginary[b] = imaginary[a] - productImaginary;
        real[a] += productReal;
        imaginary[a] += productImaginary;
        const nextReal = spinReal * stepReal - spinImaginary * stepImaginary;
        spinImaginary = spinReal * stepImaginary + spinImaginary * stepReal;
        spinReal = nextReal;
      }
    }
  }
  if (!inverse) return;
  for (let index = 0; index < size; index += 1) {
    real[index] /= size;
    imaginary[index] /= size;
  }
}

/** Linear convolution of `signal` with `kernel`, length `signal + kernel - 1`. */
export function convolve(signal: Float32Array, kernel: Float32Array): Float32Array {
  const length = signal.length + kernel.length - 1;
  let size = 1;
  while (size < length) size <<= 1;
  const signalReal = new Float64Array(size);
  const signalImaginary = new Float64Array(size);
  const kernelReal = new Float64Array(size);
  const kernelImaginary = new Float64Array(size);
  signalReal.set(signal);
  kernelReal.set(kernel);
  transform(signalReal, signalImaginary, false);
  transform(kernelReal, kernelImaginary, false);
  for (let index = 0; index < size; index += 1) {
    const real = signalReal[index] * kernelReal[index] - signalImaginary[index] * kernelImaginary[index];
    signalImaginary[index] = signalReal[index] * kernelImaginary[index] + signalImaginary[index] * kernelReal[index];
    signalReal[index] = real;
  }
  transform(signalReal, signalImaginary, true);
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) output[index] = signalReal[index];
  return output;
}
