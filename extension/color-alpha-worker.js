/* Mediabunny 1.65.2, MPL-2.0; unmodified worker function. */
(() => {
    // These buffers are reused across frames as long as the size matches, since consecutive frames usually share
    // dimensions
    let cpuAlphaBuffer = null;
    let cpuColorBuffer = null;
    // Serialize execution internally so concurrent requests don't race on the shared cpu*Buffer state.
    let chain = Promise.resolve();
    self.addEventListener('message', (event) => {
        const { id, color, alpha } = event.data;
        chain = chain.then(async () => {
            try {
                const frame = await merge(color, alpha);
                self.postMessage({ id, frame }, { transfer: [frame] });
            }
            catch (error) {
                self.postMessage({ id, error: error.message });
            }
            finally {
                // We took ownership of the inputs via transfer; close them now that the merge (or its error) is done.
                color.close();
                alpha.close();
            }
        });
    });
    const merge = async (color, alpha) => {
        const format = color.format;
        const alphaFormat = alpha.format;
        if (!format || !alphaFormat) {
            throw new Error('CPU color/alpha merging requires a known VideoFrame format.');
        }
        // The alpha frame must have the same bit depth as the color frame
        const colorIs10 = format.includes('P10');
        const colorIs12 = format.includes('P12');
        const alphaIs10 = alphaFormat.includes('P10');
        const alphaIs12 = alphaFormat.includes('P12');
        if (alphaIs10 !== colorIs10 || alphaIs12 !== colorIs12) {
            throw new Error(`CPU color/alpha merging requires the alpha frame to have the same bit depth as the color frame`
                + ` (color: '${format}', alpha: '${alphaFormat}').`);
        }
        if (format === 'RGBX' || format === 'RGBA' || format === 'BGRX' || format === 'BGRA') {
            return await mergeInterleavedRgba(color, alpha, format);
        }
        else if (format === 'I420' || format === 'I420P10' || format === 'I420P12'
            || format === 'I422' || format === 'I422P10' || format === 'I422P12'
            || format === 'I444' || format === 'I444P10' || format === 'I444P12') {
            return await mergePlanarYuv(color, alpha, format);
        }
        else if (format === 'NV12') {
            return await mergeNv12(color, alpha);
        }
        throw new Error(`CPU color/alpha merging does not support format '${format}'.`);
    };
    const mergeInterleavedRgba = async (color, alpha, format) => {
        const width = color.visibleRect?.width ?? color.codedWidth;
        const height = color.visibleRect?.height ?? color.codedHeight;
        const pixelCount = width * height;
        const output = new Uint8Array(pixelCount * 4);
        // Color goes straight into the output buffer via copyTo, no intermediate copy needed
        await color.copyTo(output);
        // And now add the alpha data
        const alphaY = await readAlpha(alpha, width, height, 1);
        for (let i = 0, j = 3; i < pixelCount; i++, j += 4) {
            output[j] = alphaY[i];
        }
        const outputFormat = (format === 'RGBX' || format === 'RGBA') ? 'RGBA' : 'BGRA';
        const init = {
            format: outputFormat,
            codedWidth: width,
            codedHeight: height,
            timestamp: color.timestamp,
            duration: color.duration ?? undefined,
            transfer: [output.buffer],
        };
        return new VideoFrame(output, init);
    };
    const mergePlanarYuv = async (color, alpha, format) => {
        const width = color.visibleRect?.width ?? color.codedWidth;
        const height = color.visibleRect?.height ?? color.codedHeight;
        const is10 = format.includes('P10');
        const is12 = format.includes('P12');
        const bytesPerSample = (is10 || is12) ? 2 : 1;
        let chromaW;
        let chromaH;
        if (format.startsWith('I420')) {
            chromaW = Math.ceil(width / 2);
            chromaH = Math.ceil(height / 2);
        }
        else if (format.startsWith('I422')) {
            chromaW = Math.ceil(width / 2);
            chromaH = height;
        }
        else {
            chromaW = width;
            chromaH = height;
        }
        const ySamples = width * height;
        const uvSamples = chromaW * chromaH;
        const yBytes = ySamples * bytesPerSample;
        const uvBytes = uvSamples * bytesPerSample;
        const aBytes = ySamples * bytesPerSample;
        const outputBytes = yBytes + 2 * uvBytes + aBytes;
        const output = new Uint8Array(outputBytes);
        // Write color planes directly into the output buffer via copyTo, no intermediate copy
        await color.copyTo(output);
        const alphaY = await readAlpha(alpha, width, height, bytesPerSample);
        const aOffset = yBytes + 2 * uvBytes;
        output.set(alphaY, aOffset);
        const outputFormat = (format.slice(0, 4) + 'A' + format.slice(4));
        const init = {
            format: outputFormat,
            codedWidth: width,
            codedHeight: height,
            timestamp: color.timestamp,
            duration: color.duration ?? undefined,
            transfer: [output.buffer],
        };
        return new VideoFrame(output, init);
    };
    const mergeNv12 = async (color, alpha) => {
        const width = color.visibleRect?.width ?? color.codedWidth;
        const height = color.visibleRect?.height ?? color.codedHeight;
        const ySize = width * height;
        const chromaW = Math.ceil(width / 2);
        const chromaH = Math.ceil(height / 2);
        const uvSize = chromaW * chromaH;
        const sourceSize = color.allocationSize();
        if (!cpuColorBuffer || cpuColorBuffer.byteLength !== sourceSize) {
            cpuColorBuffer = new Uint8Array(sourceSize);
        }
        await color.copyTo(cpuColorBuffer);
        const output = new Uint8Array(ySize + 2 * uvSize + ySize);
        // Y plane copies straight over
        output.set(cpuColorBuffer.subarray(0, ySize), 0);
        // Deinterleave the UV plane into separate U and V planes
        const uOffset = ySize;
        const vOffset = ySize + uvSize;
        const uvStart = ySize;
        for (let i = 0; i < uvSize; i++) {
            output[uOffset + i] = cpuColorBuffer[uvStart + i * 2];
            output[vOffset + i] = cpuColorBuffer[uvStart + i * 2 + 1];
        }
        const alphaY = await readAlpha(alpha, width, height, 1);
        output.set(alphaY, ySize + 2 * uvSize);
        const init = {
            format: 'I420A',
            codedWidth: width,
            codedHeight: height,
            timestamp: color.timestamp,
            duration: color.duration ?? undefined,
            transfer: [output.buffer],
        };
        return new VideoFrame(output, init);
    };
    const readAlpha = async (alpha, width, height, bytesPerSample) => {
        const size = alpha.allocationSize();
        if (!cpuAlphaBuffer || cpuAlphaBuffer.byteLength !== size) {
            cpuAlphaBuffer = new Uint8Array(size);
        }
        await alpha.copyTo(cpuAlphaBuffer);
        const format = alpha.format;
        if (format === 'RGBA' || format === 'BGRA' || format === 'RGBX' || format === 'BGRX') {
            // Pack alpha data tightly. Assume alpha is stored in RGB, so sample just from R for simplicity.
            const rOffset = (format === 'RGBA' || format === 'RGBX') ? 0 : 2;
            const pixelCount = width * height;
            for (let i = 0; i < pixelCount; i++) {
                cpuAlphaBuffer[i] = cpuAlphaBuffer[i * 4 + rOffset];
            }
            return cpuAlphaBuffer.subarray(0, pixelCount);
        }
        else {
            // For Y-plane-first formats (I*** and NV12), the leading width*height samples are the Y plane
            const yPlane = cpuAlphaBuffer.subarray(0, width * height * bytesPerSample);
            if (alpha.colorSpace.fullRange === false) {
                // Some decoders hand us limited-range alpha, so stretch it back out to full range
                const bitDepth = format.includes('P12') ? 12 : format.includes('P10') ? 10 : 8;
                const low = 16 << (bitDepth - 8);
                const high = 235 << (bitDepth - 8);
                const max = (1 << bitDepth) - 1;
                const samples = bytesPerSample === 2
                    ? new Uint16Array(yPlane.buffer, 0, width * height)
                    : yPlane;
                for (let i = 0; i < samples.length; i++) {
                    const value = Math.round((samples[i] - low) * max / (high - low));
                    samples[i] = Math.min(Math.max(value, 0), max);
                }
            }
            return yPlane;
        }
    };
})();
