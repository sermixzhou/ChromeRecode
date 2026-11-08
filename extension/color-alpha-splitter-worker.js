/* Mediabunny 1.65.2, MPL-2.0; unmodified worker function. */
(() => {
    // Reused across frames as long as the size matches, since consecutive frames usually share dimensions.
    let cpuSourceBuffer = null;
    // Serialize execution internally so concurrent requests don't race on the shared cpuSourceBuffer.
    let chain = Promise.resolve();
    self.addEventListener('message', (event) => {
        const { id, sourceFrame } = event.data;
        chain = chain.then(async () => {
            try {
                const { colorFrame, alphaFrame } = await split(sourceFrame);
                self.postMessage({ id, colorFrame, alphaFrame }, { transfer: [colorFrame, alphaFrame] });
            }
            catch (error) {
                self.postMessage({ id, error: error.message });
            }
            finally {
                sourceFrame.close();
            }
        });
    });
    const split = async (sourceFrame) => {
        const format = sourceFrame.format;
        if (!format) {
            throw new Error('CPU color/alpha splitting requires a known VideoFrame format.');
        }
        const sourceSize = sourceFrame.allocationSize();
        if (!cpuSourceBuffer || cpuSourceBuffer.byteLength !== sourceSize) {
            cpuSourceBuffer = new Uint8Array(sourceSize);
        }
        await sourceFrame.copyTo(cpuSourceBuffer);
        if (format === 'RGBA' || format === 'BGRA') {
            return splitInterleavedRgba(cpuSourceBuffer, format, sourceFrame);
        }
        else if (format === 'I420A' || format === 'I420AP10' || format === 'I420AP12'
            || format === 'I422A' || format === 'I422AP10' || format === 'I422AP12'
            || format === 'I444A' || format === 'I444AP10' || format === 'I444AP12') {
            return splitPlanarYuvA(cpuSourceBuffer, format, sourceFrame);
        }
        throw new Error(`CPU color/alpha splitting does not support format '${format}'.`);
    };
    const splitInterleavedRgba = (source, format, sourceFrame) => {
        const width = sourceFrame.visibleRect?.width ?? sourceFrame.codedWidth;
        const height = sourceFrame.visibleRect?.height ?? sourceFrame.codedHeight;
        const pixelCount = width * height;
        const chromaW = Math.ceil(width / 2);
        const chromaH = Math.ceil(height / 2);
        const alphaSize = pixelCount + chromaW * chromaH * 2;
        // Encode alpha as I420: Y = source A bytes, UV = 128
        const alphaBuffer = new Uint8Array(alphaSize);
        for (let i = 0, j = 3; i < pixelCount; i++, j += 4) {
            alphaBuffer[i] = source[j];
        }
        alphaBuffer.fill(128, pixelCount);
        // Hand the source buffer straight to VideoFrame as RGBX/BGRX so the A bytes are ignored
        const colorFrame = new VideoFrame(source, {
            format: format === 'RGBA' ? 'RGBX' : 'BGRX',
            codedWidth: width,
            codedHeight: height,
            timestamp: sourceFrame.timestamp,
            duration: sourceFrame.duration ?? undefined,
            // No transfer!
        });
        const alphaInit = {
            format: 'I420',
            codedWidth: width,
            codedHeight: height,
            timestamp: sourceFrame.timestamp,
            duration: sourceFrame.duration ?? undefined,
            colorSpace: {
                fullRange: true,
                matrix: 'bt709',
                primaries: 'bt709',
                transfer: 'bt709',
            },
            transfer: [alphaBuffer.buffer],
        };
        const alphaFrame = new VideoFrame(alphaBuffer, alphaInit);
        return { colorFrame, alphaFrame };
    };
    const splitPlanarYuvA = (source, format, sourceFrame) => {
        const width = sourceFrame.visibleRect?.width ?? sourceFrame.codedWidth;
        const height = sourceFrame.visibleRect?.height ?? sourceFrame.codedHeight;
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
        const colorBytes = yBytes + uvBytes * 2;
        const colorFormat = format.replace('A', '');
        const alphaChromaW = Math.ceil(width / 2);
        const alphaChromaH = Math.ceil(height / 2);
        const alphaUvSamples = alphaChromaW * alphaChromaH;
        const alphaUvBytes = alphaUvSamples * bytesPerSample;
        const alphaSize = aBytes + 2 * alphaUvBytes;
        const alphaBuffer = new Uint8Array(alphaSize);
        const aPlaneStart = colorBytes;
        alphaBuffer.set(source.subarray(aPlaneStart, aPlaneStart + aBytes), 0);
        // Fill UV planes with the neutral chroma value
        const uvOffset = aBytes;
        const neutralChroma = is10 ? 512 : (is12 ? 2048 : 128);
        if (bytesPerSample === 1) {
            alphaBuffer.fill(neutralChroma, uvOffset);
        }
        else {
            const uvView = new Uint16Array(alphaBuffer.buffer, uvOffset, 2 * alphaUvSamples);
            uvView.fill(neutralChroma);
        }
        const alphaFormat = (is10 ? 'I420P10' : (is12 ? 'I420P12' : 'I420'));
        // Color frame is simply a prefix of the combined bytes
        const colorFrame = new VideoFrame(source.subarray(0, colorBytes), {
            format: colorFormat,
            codedWidth: width,
            codedHeight: height,
            timestamp: sourceFrame.timestamp,
            duration: sourceFrame.duration ?? undefined,
        });
        const alphaInit = {
            format: alphaFormat,
            codedWidth: width,
            codedHeight: height,
            timestamp: sourceFrame.timestamp,
            duration: sourceFrame.duration ?? undefined,
            colorSpace: {
                fullRange: true,
                matrix: 'bt709',
                primaries: 'bt709',
                transfer: 'bt709',
            },
            transfer: [alphaBuffer.buffer],
        };
        const alphaFrame = new VideoFrame(alphaBuffer, alphaInit);
        return { colorFrame, alphaFrame };
    };
})();
