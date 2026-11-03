// The release notes the update sheet shows before updating: CHANGELOG.md in the repository tavern-lite was installed
// from, "## <version>" headings with "- " items under them. No DOM or network here, so it is tested on its own.

/** -1, 0 or 1: whether version `a` (like "0.15.2") is older than, the same as or newer than `b`. */
export function compareVersions(a, b) {
    const parts = v => String(v).trim().replace(/^v/i, '').split(/[.-]/).map(p => Number.parseInt(p, 10) || 0);
    const x = parts(a), y = parts(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1;
    }
    return 0;
}

/**
 * What changed after `current`, up to `latest` when it is known: [{ version, items }], newest first, at most `limit`
 * versions. Headings without a version and lines that are not items are skipped; markdown marks are taken out.
 */
export function changesSince(markdown, current, latest = '', limit = 5) {
    const versions = [];
    for (const line of String(markdown ?? '').split(/\r?\n/)) {
        const heading = /^##\s+\[?v?(\d+(?:\.\d+)+)/i.exec(line);
        if (heading) { versions.push({ version: heading[1], items: [] }); continue; }
        const item = /^\s*[-*]\s+(.+)$/.exec(line);
        const text = item?.[1].replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();
        if (text && versions.length) versions.at(-1).items.push(text);
    }
    return versions
        .filter(v => compareVersions(v.version, current) > 0 && (!latest || compareVersions(v.version, latest) <= 0) && v.items.length)
        .sort((a, b) => compareVersions(b.version, a.version))
        .slice(0, limit);
}
