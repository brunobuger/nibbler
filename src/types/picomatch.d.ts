declare module 'picomatch' {
  export interface PicomatchOptions {
    dot?: boolean;
    [key: string]: unknown;
  }

  export type PicomatchMatcher = (input: string) => boolean;

  export default function picomatch(
    patterns: string | readonly string[],
    options?: PicomatchOptions
  ): PicomatchMatcher;
}

