import { statfs } from 'node:fs/promises';

/** Espace libre (Go) du système de fichiers qui contient `dir`, ou null s'il n'est pas mesurable. */
export async function freeDiskGb(dir: string): Promise<number | null> {
  try {
    const fs = await statfs(dir);
    return (fs.bavail * fs.bsize) / 1024 ** 3;
  } catch {
    return null;
  }
}
