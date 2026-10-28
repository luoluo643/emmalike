// Separate from reading preferences: old clients may replace the reading object.
export const DISPLAY_VERSION = 1;
export const UI_FONT_SIZE = { min: 14, max: 26, default: 17 };
export function fontSize(value, fallback = UI_FONT_SIZE.default) {
    const n = Number(value);
    return value !== null && value !== '' && Number.isFinite(n)
        ? Math.max(UI_FONT_SIZE.min, Math.min(UI_FONT_SIZE.max, Math.round(n))) : fallback;
}
export function cleanDisplay(value) {
    if (value?.schemaVersion !== DISPLAY_VERSION || !Number.isFinite(Number(value.fontSize))) return null;
    return { schemaVersion: DISPLAY_VERSION, fontSize: fontSize(value.fontSize), updated: Math.max(0, Number(value.updated) || 0), source: value.source === 'migrated' ? 'migrated' : 'explicit' };
}
// A real display preference wins over a legacy reading-only update, independently of theme timestamps.
export function reconcileDisplay(local, remote, legacyReading) {
    const a = cleanDisplay(local), b = cleanDisplay(remote);
    if (a && b) {
        if (a.source !== b.source) return a.source === 'explicit' ? a : b;
        return b.updated > a.updated ? b : a;
    }
    return a || b || { schemaVersion: DISPLAY_VERSION, fontSize: fontSize(legacyReading?.fontSize), updated: 0, source: 'migrated' };
}
