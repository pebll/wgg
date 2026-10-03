/**
 * Password input for `wgg hash-password`: piped (scripting) or typed at a hidden prompt. Nothing here logs or echoes
 * the password.
 */

/**
 * Reads a whole stream; strips one trailing newline (`echo pw | wgg hash-password`), nothing else.
 * @param {AsyncIterable<Buffer|string>} stream
 */
export async function readPasswordFromStream(stream) {
  let text = '';
  for await (const chunk of stream) text += chunk.toString('utf8');
  return text.replace(/\r?\n$/, '');
}

/**
 * Asks for a line on a terminal without echoing it (raw mode, backspace works, Ctrl+C cancels).
 * @param {string} question
 * @param {{input: import('stream').Readable & {setRawMode?: Function}, output: {write: Function}}} io
 * @returns {Promise<string>}
 */
export function promptHidden(question, { input, output }) {
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (fn, arg) => {
      input.removeListener('data', onData);
      input.setRawMode?.(false);
      input.pause?.();
      output.write('\n');
      fn(arg);
    };
    const onData = (chunk) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish(resolve, value);
        if (ch === '\u0003') return finish(reject, new Error('Cancelled.'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
      return undefined;
    };
    output.write(question);
    input.setRawMode?.(true);
    input.resume?.();
    input.on('data', onData);
  });
}

/**
 * The password for `wgg hash-password`: stdin when it is not a terminal, otherwise a hidden prompt (asked twice).
 * @param {{stdin?: NodeJS.ReadStream, stderr?: NodeJS.WriteStream}} [io]
 */
export async function readPasswordInteractive({ stdin = process.stdin, stderr = process.stderr } = {}) {
  if (!stdin.isTTY) return readPasswordFromStream(stdin);
  const first = await promptHidden('Password: ', { input: stdin, output: stderr });
  const second = await promptHidden('Repeat password: ', { input: stdin, output: stderr });
  if (first !== second) throw new Error('The two passwords differ.');
  return first;
}
