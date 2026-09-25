import { describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolError } from '../../src/tools/define.js';
import {
  MAX_BYTES,
  WARN_BYTES,
  resolveUploadSource,
  type UploadInput,
} from '../../src/tools/upload-source.js';

/** "hello" in base64. */
const HELLO = 'aGVsbG8=';

/** A base64 string whose decoded size is just over `bytes`. */
function base64OfSize(bytes: number): string {
  return 'A'.repeat(4 * Math.ceil((bytes + 1) / 3));
}

/** Runs the resolver and returns the `ToolError` it must throw. */
async function refusal(input: UploadInput, dirs: readonly string[] = []): Promise<ToolError> {
  try {
    await resolveUploadSource(input, dirs);
  } catch (error) {
    if (error instanceof ToolError) return error;
    throw error;
  }
  throw new Error('expected the resolver to refuse');
}

describe('resolveUploadSource: choosing a source', () => {
  it('refuses when no source is given', async () => {
    const error = await refusal({});
    expect(error.message).toBe('Give exactly one of url, file_path or base64; none was given.');
  });

  it('refuses when more than one source is given, naming them', async () => {
    const error = await refusal({ url: 'https://example.com/a.png', base64: HELLO });
    expect(error.message).toContain('got url and base64');
  });
});

describe('resolveUploadSource: url', () => {
  it('sends the url and takes the file name from its last segment', async () => {
    expect(await resolveUploadSource({ url: 'https://example.com/art/sunset.png' }, [])).toEqual({
      body: { file_name: 'sunset.png', url: 'https://example.com/art/sunset.png' },
      warning: undefined,
    });
  });

  it('prefers an explicit file_name', async () => {
    const { body } = await resolveUploadSource(
      { url: 'https://example.com/art/sunset.png', file_name: 'poster.png' },
      [],
    );
    expect(body).toEqual({ file_name: 'poster.png', url: 'https://example.com/art/sunset.png' });
  });

  it('decodes a percent-encoded name', async () => {
    const { body } = await resolveUploadSource({ url: 'https://example.com/sun%20set.png' }, []);
    expect(body).toMatchObject({ file_name: 'sun set.png' });
  });

  it('reduces a file_name with a path in it to its last segment', async () => {
    const { body } = await resolveUploadSource(
      { url: 'https://example.com/a.png', file_name: '../../evil.png' },
      [],
    );
    expect(body).toMatchObject({ file_name: 'evil.png' });
  });

  it('refuses a url that is not http or https', async () => {
    const error = await refusal({ url: 'file:///etc/passwd' });
    expect(error.message).toContain('must use http or https');
  });

  it('refuses a url that is not a URL at all', async () => {
    const error = await refusal({ url: 'not a url' });
    expect(error.message).toContain('is not a valid URL');
  });

  it('refuses a url with no file name, unless file_name is given', async () => {
    const error = await refusal({ url: 'https://example.com/' });
    expect(error.message).toContain('pass file_name');
    const { body } = await resolveUploadSource(
      { url: 'https://example.com/', file_name: 'sunset.png' },
      [],
    );
    expect(body).toMatchObject({ file_name: 'sunset.png' });
  });
});

describe('resolveUploadSource: base64', () => {
  it('sends the contents with the file name', async () => {
    expect(await resolveUploadSource({ base64: HELLO, file_name: 'sunset.png' }, [])).toEqual({
      body: { file_name: 'sunset.png', contents: HELLO },
      warning: undefined,
    });
  });

  it('strips a data: prefix and any whitespace', async () => {
    const { body } = await resolveUploadSource(
      {
        base64: `data:image/png;base64,${HELLO.slice(0, 4)}\n  ${HELLO.slice(4)}`,
        file_name: 'a.png',
      },
      [],
    );
    expect(body).toMatchObject({ contents: HELLO });
  });

  it('refuses without a file_name, which Printify requires', async () => {
    const error = await refusal({ base64: HELLO });
    expect(error.message).toContain('file_name');
  });

  it('refuses a string that is not base64', async () => {
    const error = await refusal({ base64: 'not base64!', file_name: 'a.png' });
    expect(error.message).toContain('not a valid base64 string');
  });

  it('warns over 5 MiB and still uploads', async () => {
    const { body, warning } = await resolveUploadSource(
      { base64: base64OfSize(WARN_BYTES), file_name: 'poster.png' },
      [],
    );
    expect(body).toMatchObject({ file_name: 'poster.png' });
    expect(warning).toContain('poster.png is 5.0 MB');
    expect(warning).toContain('url');
  });

  it('refuses over 25 MiB', async () => {
    const error = await refusal({ base64: base64OfSize(MAX_BYTES), file_name: 'huge.png' });
    expect(error.message).toContain('huge.png is 25.0 MB');
    expect(error.hint).toContain('url');
  });
});

/**
 * A fresh allowed directory. `realpath` matters: on macOS `tmpdir()` is under `/var`, a symlink to
 * `/private/var`, and `PRINTIFY_UPLOAD_DIRS` holds real paths.
 */
async function allowedDir(): Promise<string> {
  return await realpath(await mkdtemp(join(tmpdir(), 'printify-uploads-')));
}

/** Writes `name` into `dir` with `contents`, and returns its path. */
async function file(dir: string, name: string, contents: Buffer | string = 'png'): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, contents);
  return path;
}

describe('resolveUploadSource: file_path', () => {
  it('reads a file inside an allowed directory as base64', async () => {
    const dir = await allowedDir();
    const path = await file(dir, 'sunset.png', 'hello');
    expect(await resolveUploadSource({ file_path: path }, [dir])).toEqual({
      body: { file_name: 'sunset.png', contents: HELLO },
      warning: undefined,
    });
  });

  it('reads a file in a subdirectory of an allowed directory', async () => {
    const dir = await allowedDir();
    await mkdir(join(dir, 'art'));
    const path = await file(join(dir, 'art'), 'sunset.png', 'hello');
    const { body } = await resolveUploadSource({ file_path: path }, [dir]);
    expect(body).toMatchObject({ file_name: 'sunset.png' });
  });

  it('prefers an explicit file_name over the path', async () => {
    const dir = await allowedDir();
    const path = await file(dir, 'sunset.png', 'hello');
    const { body } = await resolveUploadSource({ file_path: path, file_name: 'poster.png' }, [dir]);
    expect(body).toMatchObject({ file_name: 'poster.png' });
  });

  it('refuses every local path when no directory is allowed', async () => {
    const dir = await allowedDir();
    const path = await file(dir, 'sunset.png');
    const error = await refusal({ file_path: path }, []);
    expect(error.message).toBe(
      'Uploading a local file is turned off, because this server reads only directories the user ' +
        'has allowed.',
    );
    expect(error.hint).toContain('PRINTIFY_UPLOAD_DIRS');
  });

  it('refuses a path outside every allowed directory, naming them', async () => {
    const [allowed, other] = [await allowedDir(), await allowedDir()];
    const path = await file(other, 'secret.png');
    const error = await refusal({ file_path: path }, [allowed]);
    expect(error.message).toContain('outside the directories the user allowed');
    expect(error.message).toContain(allowed);
  });

  it('refuses a symlink that points outside the allowed directory', async () => {
    const [allowed, other] = [await allowedDir(), await allowedDir()];
    const secret = await file(other, 'secret.png');
    const link = join(allowed, 'innocent.png');
    await symlink(secret, link);
    const error = await refusal({ file_path: link }, [allowed]);
    expect(error.message).toContain('outside the directories the user allowed');
  });

  it('checks the extension after resolving the link, not the name given', async () => {
    const dir = await allowedDir();
    const secret = await file(dir, 'notes.txt');
    const link = join(dir, 'art.png');
    await symlink(secret, link);
    const error = await refusal({ file_path: link }, [dir]);
    expect(error.message).toContain('not one of the file types');
  });

  it('does not treat a directory with the same prefix as inside', async () => {
    const dir = await allowedDir();
    const sibling = `${dir}-private`;
    await mkdir(sibling);
    const path = await file(sibling, 'secret.png');
    const error = await refusal({ file_path: path }, [dir]);
    expect(error.message).toContain('outside the directories the user allowed');
  });

  it('accepts an uppercase extension and refuses an unlisted one', async () => {
    const dir = await allowedDir();
    const png = await file(dir, 'SUNSET.PNG', 'hello');
    const { body } = await resolveUploadSource({ file_path: png }, [dir]);
    expect(body).toMatchObject({ file_name: 'SUNSET.PNG' });
    const gif = await file(dir, 'sunset.gif');
    const error = await refusal({ file_path: gif }, [dir]);
    expect(error.message).toContain('.png, .jpg, .jpeg');
  });

  it('refuses a relative path', async () => {
    const dir = await allowedDir();
    const error = await refusal({ file_path: 'sunset.png' }, [dir]);
    expect(error.message).toContain('must be an absolute path');
  });

  it('expands a leading ~ before deciding', async () => {
    const home = await realpath(homedir());
    // Nothing is written to the home directory: reaching "does not exist" already proves the
    // expansion, because an unexpanded "~/…" would have been refused as relative.
    const error = await refusal({ file_path: '~/printify-mcp-missing-fixture.png' }, [home]);
    expect(error.message).toContain('does not exist');
  });

  it('refuses a missing file, a directory and an empty file', async () => {
    const dir = await allowedDir();
    expect((await refusal({ file_path: join(dir, 'gone.png') }, [dir])).message).toContain(
      'does not exist',
    );
    await mkdir(join(dir, 'folder.png'));
    expect((await refusal({ file_path: join(dir, 'folder.png') }, [dir])).message).toContain(
      'is not a file',
    );
    const empty = await file(dir, 'empty.png', '');
    expect((await refusal({ file_path: empty }, [dir])).message).toContain('is empty');
  });

  it('warns over 5 MiB and refuses over 25 MiB', async () => {
    const dir = await allowedDir();
    const big = await file(dir, 'poster.png', Buffer.alloc(WARN_BYTES + 1));
    const { warning } = await resolveUploadSource({ file_path: big }, [dir]);
    expect(warning).toContain('poster.png is 5.0 MB');
    const huge = await file(dir, 'huge.png', Buffer.alloc(MAX_BYTES + 1));
    expect((await refusal({ file_path: huge }, [dir])).message).toContain('huge.png is 25.0 MB');
  });

  it.skipIf(process.getuid?.() === 0)('refuses an unreadable file with its errno', async () => {
    const dir = await allowedDir();
    const path = await file(dir, 'unreadable.png', 'hello');
    await chmod(path, 0o000);
    const error = await refusal({ file_path: path }, [dir]);
    expect(error.message).toContain('cannot be read (EACCES)');
  });

  it('refuses a nonexistent path outside the allowed directory', async () => {
    const [allowed, other] = [await allowedDir(), await allowedDir()];
    const path = join(other, 'missing.png');
    const error = await refusal({ file_path: path }, [allowed]);
    expect(error.message).toContain('outside the directories the user allowed');
  });
});
