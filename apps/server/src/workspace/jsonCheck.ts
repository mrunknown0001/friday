/**
 * Locate the first JSON syntax error. JSON.parse messages vary between engine versions and do
 * not always include a position, so this small recursive-descent checker reports line/column.
 */
export function findJsonError(
  text: string,
): { line: number; column: number; message: string } | null {
  let i = 0;
  const fail = (message: string): never => {
    throw Object.assign(new Error(message), { offset: i });
  };
  const ws = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i]!)) i++;
  };
  const literal = (word: string) => {
    if (text.startsWith(word, i)) i += word.length;
    else fail(`Unexpected ${text[i] === undefined ? 'end of input' : `"${text[i]}"`}`);
  };
  const string = () => {
    i++; // opening quote
    while (i < text.length) {
      const c = text[i]!;
      if (c === '"') return void i++;
      if (c === '\\') {
        const n = text[i + 1];
        if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) i += 6;
        else if (n !== undefined && '"\\/bfnrt'.includes(n)) i += 2;
        else fail('Invalid escape in string');
      } else if (c < ' ') fail('Control character in string');
      else i++;
    }
    fail('Unterminated string');
  };
  const number = () => {
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
    if (!m) fail('Invalid number');
    i += m![0].length;
  };
  const value = (): void => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      ws();
      if (text[i] === '}') return void i++;
      for (;;) {
        ws();
        if (text[i] !== '"') fail('Expected a property name in double quotes');
        string();
        ws();
        if (text[i] !== ':') fail('Expected ":" after property name');
        i++;
        value();
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') return void i++;
        fail('Expected "," or "}"');
      }
    }
    if (c === '[') {
      i++;
      ws();
      if (text[i] === ']') return void i++;
      for (;;) {
        value();
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') return void i++;
        fail('Expected "," or "]"');
      }
    }
    if (c === '"') return string();
    if (c === 't') return literal('true');
    if (c === 'f') return literal('false');
    if (c === 'n') return literal('null');
    if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) return number();
    fail(c === undefined ? 'Unexpected end of input' : `Unexpected "${c}"`);
  };
  try {
    value();
    ws();
    if (i < text.length) fail('Unexpected content after the JSON value');
    return null;
  } catch (err) {
    const offset = (err as { offset: number }).offset;
    const before = text.slice(0, offset).split('\n');
    return {
      line: before.length,
      column: before.at(-1)!.length + 1,
      message: (err as Error).message,
    };
  }
}
