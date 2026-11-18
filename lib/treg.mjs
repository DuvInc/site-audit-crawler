// The only file that talks to treg (https://treg.to), an API catalog whose CLI calls Search Console
// with a Google account you connected once in a browser: no Google Cloud project, no key file.
//   treg connections connect --provider google-search-console
// The calls run on your own Google account; in the author's use they cost nothing (check `treg balance`).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * A Search Console transport backed by the treg CLI: `(path, body?) => Promise<json>`.
 * @param {object} [o]
 * @param {string} [o.bin]        the treg binary
 * @param {string} [o.connection] the treg tool name of the Search Console connection
 * @param {Function} [o.exec]     injected for tests: (file, args) => Promise<{ stdout }>
 */
export function tregTransport({ bin = 'treg', connection = 'google-search-console', exec = (file, args) => run(file, args, { maxBuffer: 256 * 1024 * 1024 }) } = {}) {
  return async (path, body) => {
    const args = ['--json', 'call', connection, path];
    if (body) args.push('--data', JSON.stringify(body));
    let stdout;
    try {
      ({ stdout } = await exec(bin, args));
    } catch (e) {
      if (e.code === 'ENOENT') throw new Error('treg is not installed: see https://treg.to, then "treg connections connect --provider google-search-console".');
      throw new Error(`treg failed: ${(e.stderr || e.stdout || e.message).toString().slice(0, 300)}`);
    }
    const json = JSON.parse(stdout);
    if (json._treg?.http_status !== 200) throw new Error(`Search Console through treg ${json._treg?.http_status}: ${stdout.slice(0, 200)}`);
    return json.result;
  };
}
