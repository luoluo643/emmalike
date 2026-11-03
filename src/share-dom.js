/** Preserve just the inline reading semantics around a partial selection, never the message container. */
export function selectedPassage(selected) {
    const box = document.createElement('div');
    if (selected.rangeCount) {
        const range = selected.getRangeAt(0);
        let content = range.cloneContents();
        let parent = range.commonAncestorContainer;
        if (parent.nodeType !== 1) parent = parent.parentElement;
        while (parent && !parent.matches('.tl-message-body, .tl-select-text')) {
            if (/^(Q|EM|I|STRONG|B)$/.test(parent.tagName)) {
                const wrapper = document.createElement(parent.tagName.toLowerCase());
                wrapper.append(content);
                content = wrapper;
            }
            parent = parent.parentElement;
        }
        box.append(content);
    }
    return { text: selected.toString(), html: box.innerHTML };
}

export function checkActive(signal) {
    if (signal?.aborted) throw new DOMException('操作已取消', 'AbortError');
}

/** One deadline covers every font wait, including ready. false means draw with a system font. */
export function waitForPictureFonts(family, text, themed, { signal, timeout = 15000, fonts = globalThis.document?.fonts } = {}) {
    checkActive(signal);
    if (!fonts) return Promise.resolve(false);
    return new Promise((resolve, reject) => {
        let timer;
        const finish = (ok, error) => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', cancel);
            if (error) reject(error);
            else resolve(ok);
        };
        const cancel = () => finish(false, new DOMException('操作已取消', 'AbortError'));
        signal?.addEventListener('abort', cancel, { once: true });
        timer = setTimeout(() => finish(false), timeout);
        const styles = themed ? ['16px', '600 16px', 'italic 16px'] : ['16px', '600 16px'];
        Promise.resolve().then(() => Promise.all(styles.map(style => fonts.load(`${style} ${family}`, text))))
            .then(() => fonts.ready).then(() => finish(true), () => finish(false));
    });
}
