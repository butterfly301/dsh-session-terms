/** Match visible occurrences, preferring the longest term at overlapping positions. */
export function findTermOccurrences(text, terms) {
  const candidates = [];
  for (const term of terms) {
    if (!term.name) continue;
    const english = /^[A-Za-z0-9_]+$/.test(term.name);
    let start = text.indexOf(term.name);
    while (start !== -1) {
      const end = start + term.name.length;
      const inWord =
        english &&
        (/[A-Za-z0-9_]/.test(text[start - 1] || '') || /[A-Za-z0-9_]/.test(text[end] || ''));
      if (!inWord) candidates.push({ term, start, end });
      start = text.indexOf(term.name, start + 1);
    }
  }
  candidates.sort(
    (a, b) =>
      b.end - b.start - (a.end - a.start) ||
      a.start - b.start ||
      a.term.id.localeCompare(b.term.id),
  );
  const selected = [];
  for (const candidate of candidates) {
    if (selected.some((hit) => candidate.start < hit.end && hit.start < candidate.end)) continue;
    selected.push(candidate);
  }
  return selected.sort((a, b) => a.start - b.start);
}
