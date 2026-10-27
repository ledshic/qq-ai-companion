import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
export const newToken = () => randomBytes(32).toString('base64url');
export interface OwnerCredential {
  ownerId: string;
  deviceId: string;
  token: string;
}
// Only the local operator can bootstrap ownership; HTTP never creates an owner.
export function ownerCredential(path: string): OwnerCredential {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(
        fd,
        JSON.stringify({
          ownerId: randomUUID(),
          deviceId: randomUUID(),
          token: newToken(),
        }) + '\n',
      );
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (!lstatSync(path).isFile())
    throw Error('Owner credential must be a regular file');
  fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw Error(
        'Owner credential must be owned by current user and mode 0600',
      );
    const value = JSON.parse(readFileSync(fd, 'utf8')) as OwnerCredential;
    if (
      !value ||
      !/^[\da-f-]{36}$/.test(value.ownerId) ||
      !/^[\da-f-]{36}$/.test(value.deviceId) ||
      !/^[\w-]{43}$/.test(value.token)
    )
      throw Error('Invalid owner credential');
    return value;
  } finally {
    closeSync(fd);
  }
}
