/* Mediabunny 1.65.2, MPL-2.0; unmodified worker function. */
(() => {
    const timeoutHandles = new Map();
    const intervalHandles = new Map();
    self.onmessage = (event) => {
        const message = event.data;
        switch (message.type) {
            case 'set-timeout':
                {
                    const handle = setTimeout(() => {
                        timeoutHandles.delete(message.timerId);
                        self.postMessage({ type: 'fire', timerId: message.timerId });
                    }, message.delay);
                    timeoutHandles.set(message.timerId, handle);
                }
                ;
                break;
            case 'set-interval':
                {
                    const handle = setInterval(() => {
                        self.postMessage({ type: 'fire', timerId: message.timerId });
                    }, message.delay);
                    intervalHandles.set(message.timerId, handle);
                }
                ;
                break;
            case 'clear-timeout':
                {
                    const handle = timeoutHandles.get(message.timerId);
                    if (handle !== undefined) {
                        clearTimeout(handle);
                        timeoutHandles.delete(message.timerId);
                    }
                }
                ;
                break;
            case 'clear-interval':
                {
                    const handle = intervalHandles.get(message.timerId);
                    if (handle !== undefined) {
                        clearInterval(handle);
                        intervalHandles.delete(message.timerId);
                    }
                }
                ;
                break;
        }
    };
})();
