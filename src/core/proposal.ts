/**
 * Parses the harness answer in "files" mode: the harness must reply with a JSON
 * object `{"files": {"<name>": "<full content>"}}`, optionally inside a ```json fence.
 * Anything else is rejected: no guessing.
 */
export class ProposalError extends Error {}

export interface ProposedFiles {
  [name: string]: string;
}

export function parseProposal(output: string): ProposedFiles {
  const fenced = [...output.matchAll(/```json\s*([\s\S]*?)```/g)]
    .map((m) => m[1])
    .filter((s): s is string => typeof s === 'string');
  const candidates = fenced.length > 0 ? fenced : [output];

  for (const text of candidates.reverse()) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      continue;
    }
    const files = (parsed as { files?: unknown })?.files;
    if (files && typeof files === 'object' && !Array.isArray(files)) {
      const out: ProposedFiles = {};
      for (const [name, content] of Object.entries(files as Record<string, unknown>)) {
        if (typeof content !== 'string') throw new ProposalError(`contenuto non testuale per ${name}`);
        out[name] = content;
      }
      return out;
    }
  }
  throw new ProposalError('risposta dell\'harness senza blocco JSON {"files": {...}}: nessuna modifica applicata');
}

/** Rejects names that are not direct files of the target folder (no paths, no spec files). */
export function validateProposalNames(files: ProposedFiles): void {
  for (const name of Object.keys(files)) {
    if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
      throw new ProposalError(`nome file non valido: ${name}`);
    }
    if (name.endsWith('.helpai.md')) throw new ProposalError(`le spec non sono modificabili: ${name}`);
  }
}
