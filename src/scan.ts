export const normalize = (text: string) => text.normalize('NFKC');

// The same form as the repositories' own denylist files: one regular expression per line, case ignored, "#" starts
// a comment. Line numbers stay as in the file, so a report can name a term without printing it. A pattern that does
// not compile throws, because a check that silently skips a line would let the term through.
export function readTerms(text: string): (RegExp | null)[] {
  return text.split(/\r?\n/).map((line, index) => {
    const source = line.trim().normalize('NFKC');
    if (!source || source.startsWith('#')) return null;
    // Node 22 lacks (?-i:...), which the denylists use to keep a short pattern such as an exact prefix case-sensitive.
    const exact = /^\(\?-i:(.*)\)$/.exec(source);
    try { return exact ? new RegExp(exact[1]) : new RegExp(source, 'i'); }
    catch { throw new Error(`Invalid pattern on line ${index + 1} of the terms file`); }
  });
}

const hits = (values: string[], terms: (RegExp | null)[]) =>
  terms.flatMap((term, index) => term && values.some(value => term.test(value)) ? [index + 1] : []);

export function scanText(text: string, terms: (RegExp | null)[]): number[] {
  return hits([normalize(text)], terms);
}

// A string in a model request. An attached image is checked by its bytes, because base64 hides the text inside it.
export function scanValue(value: string, terms: (RegExp | null)[]): number[] {
  const data = /^data:[^,]*;base64,/.exec(value);
  const inText = scanText(value, terms);
  if (!data) return inText;
  return [...new Set([...inText, ...scanBytes(Buffer.from(value.slice(data[0].length), 'base64'), terms)])];
}

export function scanBytes(bytes: Uint8Array, terms: (RegExp | null)[]): number[] {
  const values: string[] = [];
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    values.push(normalize(decoded));
    if (!decoded.includes('\0')) return hits(values, terms);
  } catch {
    // Binary data is also searched with single-byte and UTF-16 decoding below.
  }
  const buffer = Buffer.from(bytes);
  // Lossy UTF-8 finds non-ASCII terms in binary files such as DLL metadata and git tree objects.
  values.push(normalize(buffer.toString('utf8')), buffer.toString('latin1'), buffer.toString('utf16le'));
  return hits(values, terms);
}
