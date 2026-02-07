export interface DiffResult {
  files: DiffFile[];
  summary: { additions: number; deletions: number; filesChanged: number };
  raw: string;
}

export interface DiffFile {
  path: string;
  changeType: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  oldPath?: string;
}

export interface DiffParseInput {
  rawDiff: string;
  nameStatus: string;
  numStat: string;
}

/**
 * Parse git diff outputs into a structured representation.
 *
 * Inputs should come from:
 * - rawDiff:   `git diff <from>..<to?>`
 * - nameStatus:`git diff --name-status <from>..<to?>`
 * - numStat:   `git diff --numstat <from>..<to?>`
 */
export function parseDiff({ rawDiff, nameStatus, numStat }: DiffParseInput): DiffResult {
  const additionsDeletions = parseNumStat(numStat);
  const changeTypes = parseNameStatus(nameStatus);

  const files = Array.from(
    new Set([...Object.keys(additionsDeletions), ...Object.keys(changeTypes)].sort())
  ).map((path) => {
    const counts = additionsDeletions[path] ?? { additions: 0, deletions: 0 };
    const ct = changeTypes[path] ?? { changeType: 'modified' as const };
    return {
      path,
      additions: counts.additions,
      deletions: counts.deletions,
      changeType: ct.changeType,
      oldPath: ct.oldPath
    } satisfies DiffFile;
  });

  const summary = files.reduce(
    (acc, f) => {
      acc.additions += f.additions;
      acc.deletions += f.deletions;
      acc.filesChanged += 1;
      return acc;
    },
    { additions: 0, deletions: 0, filesChanged: 0 }
  );

  return { files, summary, raw: rawDiff };
}

function parseNumStat(numStat: string): Record<string, { additions: number; deletions: number }> {
  const out: Record<string, { additions: number; deletions: number }> = {};
  for (const line of numStat.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [addsRaw, delsRaw, pathRaw] = parts;

    // Binary diffs show '-' for counts; treat as 0 for v1.
    const additions = addsRaw === '-' ? 0 : safeInt(addsRaw);
    const deletions = delsRaw === '-' ? 0 : safeInt(delsRaw);
    const path = pathRaw.trim();
    if (!path) continue;
    out[path] = { additions, deletions };
  }
  return out;
}

function parseNameStatus(
  nameStatus: string
): Record<string, { changeType: DiffFile['changeType']; oldPath?: string }> {
  const out: Record<string, { changeType: DiffFile['changeType']; oldPath?: string }> = {};
  for (const line of nameStatus.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t').map((p) => p.trim());
    if (parts.length < 2) continue;

    // Examples:
    // A\tpath
    // M\tpath
    // D\tpath
    // R100\told\tnew
    const status = parts[0];
    if (status.startsWith('R') && parts.length >= 3) {
      const oldPath = parts[1];
      const newPath = parts[2];
      out[newPath] = { changeType: 'renamed', oldPath };
      continue;
    }

    const path = parts[1];
    if (!path) continue;
    switch (status) {
      case 'A':
        out[path] = { changeType: 'added' };
        break;
      case 'D':
        out[path] = { changeType: 'deleted' };
        break;
      case 'M':
      default:
        out[path] = { changeType: 'modified' };
        break;
    }
  }
  return out;
}

function safeInt(s: string): number {
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
}

