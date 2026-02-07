export interface JobIdParts {
  yyyyMMdd: string; // YYYYMMDD
  nnn: string; // 3 digits
}

export function formatJobId(parts: JobIdParts): string {
  return `j-${parts.yyyyMMdd}-${parts.nnn}`;
}

export function parseJobId(jobId: string): JobIdParts | null {
  const m = /^j-(\d{8})-(\d{3})$/.exec(jobId);
  if (!m) return null;
  return { yyyyMMdd: m[1], nnn: m[2] };
}

export class JobIdGenerator {
  private currentDate: string | null = null;
  private seq = 0;

  next(now: Date = new Date()): string {
    const yyyyMMdd = formatDate(now);
    if (this.currentDate !== yyyyMMdd) {
      this.currentDate = yyyyMMdd;
      this.seq = 0;
    }
    this.seq += 1;
    return formatJobId({ yyyyMMdd, nnn: String(this.seq).padStart(3, '0') });
  }
}

function formatDate(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

