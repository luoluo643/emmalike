/** Shared persistence facts for named presets and whole world books.
 * Only a full server readback matching the submitted snapshot confirms its contents.
 * notSubmitted is a caller's proven before-invocation fact (or its explicit terminal
 * receipt), never inferred from HTTP status, Promise settlement, OLD readback, or an
 * armed receipt recovered after a crash. A user decision does not alter these facts.
 */
export function classifySaveOutcome({ matchesExpected = false, notSubmitted = false } = {}) {
    if (matchesExpected === true) return 'confirmed';
    return notSubmitted === true ? 'not-submitted' : 'unknown';
}
