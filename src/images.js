// Pictures made on the device before upload: a chosen photo cropped to the shape the app uses, or, when there is no
// photo, the first character of a name on a colour picked from the name (instead of the app's grey silhouette).

const COLORS = ['#b5651d', '#7a8b3c', '#3c7a8b', '#8b3c6b', '#5a5aa8', '#a8705a', '#3c8b5f', '#8b6b3c'];

function toBlob(canvas) {
    return new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('图片没有生成成功')), 'image/png'));
}

function canvas(width, height) {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c;
}

/** The photo `file`, centre-cropped to width × height. */
export async function fitImage(file, width, height) {
    const bitmap = await createImageBitmap(file).catch(() => { throw new Error('这张图片打不开，换一张试试'); });
    const c = canvas(width, height);
    const scale = Math.max(width / bitmap.width, height / bitmap.height);
    const w = bitmap.width * scale, h = bitmap.height * scale;
    c.getContext('2d').drawImage(bitmap, (width - w) / 2, (height - h) / 2, w, h);
    bitmap.close?.();
    return toBlob(c);
}

/** The first character of `name`, white on a colour that stays the same for the same name. */
export function letterImage(name, width = 400, height = 400) {
    const text = Array.from(String(name ?? '').trim())[0] ?? '?';
    let hash = 0;
    for (const ch of String(name)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
    const c = canvas(width, height);
    const g = c.getContext('2d');
    g.fillStyle = COLORS[hash % COLORS.length];
    g.fillRect(0, 0, width, height);
    g.fillStyle = '#fff';
    g.font = `${Math.round(Math.min(width, height) * 0.5)}px sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text.toUpperCase(), width / 2, height / 2 + Math.min(width, height) * 0.03);
    return toBlob(c);
}
