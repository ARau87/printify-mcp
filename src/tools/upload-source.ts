import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, resolve, sep } from 'node:path';
import { expandHome } from '../config.js';
import type { UploadBody } from '../printify/uploads.js';
import { ToolError } from './define.js';

/** Over this, the upload still happens and the result warns. */
export const WARN_BYTES = 5 * 1024 * 1024;

/**
 * Over this, the upload is refused. Printify documents no maximum; this one protects the process.
 * The bytes become a base64 string and `JSON.stringify` copies that again, so a very large file
 * can exhaust the heap and take the stdio server down with it, leaving the model no error to read.
 */
export const MAX_BYTES = 25 * 1024 * 1024;

/** What this server reads off the user's disk. Printify documents no list of formats. */
export const ALLOWED_EXTENSIONS = ['.png', '.jpg', '.jpeg'] as const;

const SOURCES = ['url', 'file_path', 'base64'] as const;

export interface UploadInput {
  url?: string | undefined;
  file_path?: string | undefined;
  base64?: string | undefined;
  file_name?: string | undefined;
}

export interface ResolvedSource {
  body: UploadBody;
  /** Set when the payload is over `WARN_BYTES`; the tool passes it on to the model. */
  warning: string | undefined;
}

const SOURCE_HINT =
  "url is a publicly reachable image URL, file_path a file on the user's machine, base64 the " +
  'image bytes. Use url for anything large.';
const NAME_HINT = 'file_name is the name the image gets in the library, e.g. "sunset.png".';
const URL_HINT = 'Pass a public http or https URL that returns the image file itself.';
const BASE64_HINT =
  "base64 is the image file's bytes, base64-encoded. For a file on disk use file_path, and for " +
  'an image on the web use url.';
const BIG_HINT =
  'Host the image and pass url instead: Printify downloads it itself, with no limit of this kind.';
const LOCAL_OFF =
  'Uploading a local file is turned off, because this server reads only directories the user has ' +
  'allowed.';
const LOCAL_OFF_HINT =
  'The user sets PRINTIFY_UPLOAD_DIRS to those directories in the "env" block of the printify-mcp ' +
  'entry in their MCP client config, then restarts the client. An image with a public URL can be ' +
  'uploaded with url instead, which needs no such setting.';

/**
 * Turns the tool's arguments into the documented request body. Throws a `ToolError` for anything
 * the model can fix: no source or several, an unusable URL, a bad base64 string, or a local path
 * outside the directories the user allowed.
 */
export async function resolveUploadSource(
  input: UploadInput,
  uploadDirs: readonly string[],
): Promise<ResolvedSource> {
  const { url, file_path: filePath, base64, file_name: fileName } = input;
  const given = SOURCES.filter((name) => input[name] !== undefined);
  if (given.length !== 1) {
    throw new ToolError(
      `Give exactly one of url, file_path or base64; ${describeGiven(given)}.`,
      SOURCE_HINT,
    );
  }
  if (url !== undefined) return resolveUrl(url, fileName);
  if (base64 !== undefined) return resolveBase64(base64, fileName);
  // Exactly one source was given and it was neither of those, so file_path is set.
  return resolveFile(filePath ?? '', fileName, uploadDirs);
}

function describeGiven(given: readonly string[]): string {
  return given.length === 0 ? 'none was given' : `got ${given.join(' and ')}`;
}

function resolveUrl(url: string, fileName: string | undefined): ResolvedSource {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ToolError(`url is not a valid URL: ${url}`, URL_HINT);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ToolError(`url must use http or https, got "${parsed.protocol}"`, URL_HINT);
  }
  const name = safeName(fileName ?? basename(decodePath(parsed.pathname)));
  if (name === '') {
    throw new ToolError(
      `The file name cannot be worked out from ${url}; pass file_name as well.`,
      NAME_HINT,
    );
  }
  // Printify requires file_name in both body variants, so one is always sent.
  return { body: { file_name: name, url }, warning: undefined };
}

// Everything up to the first comma: `data:image/png;base64,`.
const DATA_URL = /^data:[^,]*,/i;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function resolveBase64(contents: string, fileName: string | undefined): ResolvedSource {
  const name = safeName(fileName ?? '');
  if (name === '') {
    throw new ToolError('base64 needs file_name as well: every upload is named.', NAME_HINT);
  }
  const cleaned = contents.trim().replace(DATA_URL, '').replaceAll(/\s+/gu, '');
  if (cleaned === '' || cleaned.length % 4 !== 0 || !BASE64.test(cleaned)) {
    throw new ToolError('base64 is not a valid base64 string.', BASE64_HINT);
  }
  // Measured before decoding, so an oversized payload is never held twice.
  const bytes = decodedBytes(cleaned);
  if (bytes > MAX_BYTES) throw tooLarge(name, bytes);
  return { body: { file_name: name, contents: cleaned }, warning: warningFor(name, bytes) };
}

/** The byte length a base64 string decodes to, without decoding it. */
function decodedBytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

/** A pathname with %xx decoded, or as it stands when it is not valid percent-encoding. */
function decodePath(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

/** The last segment only, so a name like `../evil.png` cannot travel to Printify. */
function safeName(name: string): string {
  const base = basename(name.trim());
  return base === '.' || base === '..' ? '' : base;
}

function tooLarge(name: string, bytes: number): ToolError {
  return new ToolError(
    `${name} is ${formatSize(bytes)}, over this server's ${formatSize(MAX_BYTES)} limit for ` +
      'uploading file contents.',
    BIG_HINT,
  );
}

function warningFor(name: string, bytes: number): string | undefined {
  if (bytes <= WARN_BYTES) return undefined;
  return (
    `${name} is ${formatSize(bytes)}. Printify recommends uploading files over 5 MB by image URL ` +
    'rather than base64, and plans to stop accepting base64 uploads that large. Pass url instead ' +
    'when the file is reachable on the web.'
  );
}

function formatSize(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Tests whether a path (real or lexical) is inside or equals one of the allowed directories. */
function isInAllowedDirs(checkPath: string, uploadDirs: readonly string[]): boolean {
  return uploadDirs.some((dir) => {
    const prefix = dir.endsWith(sep) ? dir : dir + sep;
    return checkPath === dir || checkPath.startsWith(prefix);
  });
}

/**
 * Reads a local file, but only inside the directories the user allowed. Every check is its own
 * refusal, so the model learns what to change. The path is resolved first and every later check
 * uses the real path, so a symlink can neither escape the allowed directories nor disguise the
 * file's type. When realpath fails, the path is checked lexically first to prevent using nonexistent
 * files to probe whether files exist outside the allowed directories.
 */
async function resolveFile(
  path: string,
  fileName: string | undefined,
  uploadDirs: readonly string[],
): Promise<ResolvedSource> {
  if (uploadDirs.length === 0) throw new ToolError(LOCAL_OFF, LOCAL_OFF_HINT);
  const expanded = expandHome(path);
  if (!isAbsolute(expanded)) {
    throw new ToolError(
      `file_path must be an absolute path, got "${path}".`,
      'Ask the user for the full path, e.g. /Users/name/Designs/sunset.png.',
    );
  }
  let real: string;
  try {
    real = await realpath(expanded);
  } catch (error) {
    // Realpath failed, so lexically check if the path is in an allowed directory.
    // If not, refuse without revealing whether the file exists outside the allowlist.
    const lexical = resolve(expanded);
    if (!isInAllowedDirs(lexical, uploadDirs)) {
      throw new ToolError(
        `${path} is outside the directories the user allowed for uploads: ${uploadDirs.join(', ')}.`,
        'Ask the user to move the file into one of them, or to add its directory to ' +
          'PRINTIFY_UPLOAD_DIRS and restart their MCP client.',
      );
    }
    // Path is lexically inside an allowed directory but cannot be read; report the errno.
    throw unreadable(path, error);
  }
  if (!isInAllowedDirs(real, uploadDirs)) {
    throw new ToolError(
      `${path} is outside the directories the user allowed for uploads: ${uploadDirs.join(', ')}.`,
      'Ask the user to move the file into one of them, or to add its directory to ' +
        'PRINTIFY_UPLOAD_DIRS and restart their MCP client.',
    );
  }
  const extension = extname(real).toLowerCase();
  if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(extension)) {
    throw new ToolError(
      `${path} is not one of the file types this server uploads from disk: ` +
        `${ALLOWED_EXTENSIONS.join(', ')}.`,
      'Convert the image first, or pass a public url, which Printify downloads itself.',
    );
  }
  let stats;
  try {
    stats = await stat(real);
  } catch (error) {
    throw unreadable(path, error);
  }
  if (!stats.isFile()) {
    throw new ToolError(`${path} is not a file.`, 'Pass the path of an image file.');
  }
  if (stats.size === 0) {
    throw new ToolError(`${path} is empty.`, 'Check the file with the user, then try again.');
  }
  const given = safeName(fileName ?? '');
  const name = given === '' ? basename(expanded) : given;
  // stat before readFile: an oversized file is refused without ever being held in memory.
  if (stats.size > MAX_BYTES) throw tooLarge(name, stats.size);
  let contents;
  try {
    contents = await readFile(real, { encoding: 'base64' });
  } catch (error) {
    throw unreadable(path, error);
  }
  return { body: { file_name: name, contents }, warning: warningFor(name, stats.size) };
}

function unreadable(path: string, error: unknown): ToolError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new ToolError(`${path} does not exist.`, 'Check the path with the user.');
  }
  return new ToolError(
    `${path} cannot be read (${code ?? 'unknown error'}).`,
    "Check the file's permissions with the user.",
  );
}
