import picomatch from 'picomatch';

export const PROTECTED_PATH_PATTERNS = [
  '.nibbler/**',
  '.cursor/rules/00-nibbler-protocol.mdc'
] as const;

export function isProtectedPath(path: string): boolean {
  // Always treat paths as repo-relative POSIX-ish strings (git uses / separators).
  const isMatch = picomatch(PROTECTED_PATH_PATTERNS, { dot: true });
  return isMatch(path);
}

