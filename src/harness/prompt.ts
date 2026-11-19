import type { SpecContext } from '../core/context.js';

/**
 * Builds the task for the harness. The perimeter rules are stated explicitly,
 * but they are also enforced after the run (see runner.ts), not only trusted here.
 */
export function buildPrompt(ctx: SpecContext, contract: 'direct' | 'files' = 'direct'): string {
  const head = buildBody(ctx);
  if (contract === 'direct') return head;
  return [
    head,
    '## Formato della risposta (obbligatorio)',
    'NON scrivere file sul disco. Rispondi solo con un blocco JSON nel formato:',
    '```json',
    '{"files": {"<nome file diretto>": "<contenuto COMPLETO del file>"}}',
    '```',
    'Includi solo i file da creare o modificare, con il contenuto completo. Nessun percorso, nessun .helpai.md.',
  ].join('\n');
}

function buildBody(ctx: SpecContext): string {
  const parts: string[] = [];
  parts.push(`# Task di allineamento HelpAI (Spec -> Code)`);
  parts.push(`Cartella target: ${ctx.folderRel}`);
  parts.push(`Root del progetto: ${ctx.rootPath}`);
  parts.push('');
  parts.push('## Regole ferree');
  parts.push(`- Crea, modifica o rimuovi file SOLO dentro la cartella "${ctx.folderRel}" (solo file diretti).`);
  parts.push('- Non modificare alcun file .helpai.md.');
  parts.push(`- Non entrare né modificare le sottocartelle di "${ctx.folderRel}": ${ctx.ignoredSubdirs.join(', ') || '(nessuna)'}.`);
  parts.push('- Puoi leggere qualsiasi file del progetto per capire tipi, modelli, servizi e convenzioni di import.');
  parts.push('');

  for (const inh of ctx.inherited) {
    parts.push(`## Specifica ereditata: ${inh.location}`);
    parts.push(inh.content);
    parts.push('');
  }

  parts.push(`## Specifica locale: ${ctx.specRel}`);
  parts.push(ctx.specContent);
  parts.push('');

  parts.push('## File attuali nella cartella target');
  if (ctx.folderFiles.length === 0) parts.push('(nessuno)');
  for (const f of ctx.folderFiles) {
    parts.push(`### ${f.name}`);
    parts.push(f.content === null ? '(file binario, non incluso)' : '```\n' + f.content + '\n```');
    parts.push('');
  }
  return parts.join('\n');
}
