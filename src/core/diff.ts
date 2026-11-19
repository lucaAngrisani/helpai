/** Line-based diff (LCS). Output lines are prefixed with ' ', '+' or '-'. */
export function lineDiff(a: string, b: string): string {
  const x = a.split('\n');
  const y = b.split('\n');
  const n = x.length;
  const m = y.length;
  if (n * m > 4_000_000) return `(file troppo grande per il diff: ${n}x${m} righe)`;

  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        x[i] === y[j] ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
    }
  }

  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push(` ${x[i]}`);
      i++;
      j++;
    } else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) {
      out.push(`-${x[i]}`);
      i++;
    } else {
      out.push(`+${y[j]}`);
      j++;
    }
  }
  while (i < n) out.push(`-${x[i++]}`);
  while (j < m) out.push(`+${y[j++]}`);
  return out.join('\n');
}

export interface SnapshotComparison {
  name: string;
  status: 'added' | 'removed' | 'modified' | 'same';
  diff: string;
}

/** Compares two history snapshots file by file. `a` is the older one, `b` the newer. */
export function compareFiles(a: Record<string, string>, b: Record<string, string>): SnapshotComparison[] {
  const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return names.map((name) => {
    const before = a[name];
    const after = b[name];
    if (before === undefined) return { name, status: 'added', diff: lineDiff('', after ?? '') };
    if (after === undefined) return { name, status: 'removed', diff: lineDiff(before, '') };
    if (before === after) return { name, status: 'same', diff: '' };
    return { name, status: 'modified', diff: lineDiff(before, after) };
  });
}
