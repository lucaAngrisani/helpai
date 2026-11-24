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

  if (ctx.referenced.length > 0) {
    parts.push('## File di riferimento (SOLO LETTURA)');
    parts.push('Questi file sono collegati dalla spec. Usali per capire contratti, tipi e logica condivisa.');
    parts.push('NON modificarli: il loro contenuto è solo contesto, la modifica va fatta nella cartella target.');
    parts.push('');
    for (const r of ctx.referenced) {
      parts.push(`### ${r.rel}`);
      parts.push('```\n' + r.content + '\n```');
      parts.push('');
    }
  }
  return parts.join('\n');
}

/**
 * Reverse task (code -> spec): the harness reads the code of the target folder
 * and rewrites ONLY its spec. Output uses the same "files" contract, with the
 * spec file as the single entry.
 */
export function buildReversePrompt(ctx: SpecContext): string {
  const specName = ctx.specRel.split('/').pop() ?? ctx.specRel;
  return [
    '# Task di allineamento HelpAI (Code -> Spec)',
    `Cartella target: ${ctx.folderRel}`,
    `Spec da riscrivere: ${ctx.specRel}`,
    '',
    '## Regole ferree',
    `- Descrivi il codice REALE della cartella "${ctx.folderRel}" (solo file diretti) nella spec.`,
    '- Non modificare o creare alcun file diverso dalla spec.',
    '- Non elencare né descrivere file che non esistono.',
    '- Mantieni i link verso le altre spec già presenti nella spec attuale, se ancora validi.',
    '',
    '## Spec attuale (da aggiornare)',
    ctx.specContent,
    '',
    '## File della cartella target',
    ...ctx.folderFiles.map((f) =>
      `### ${f.name}\n` + (f.content === null ? '(binario, non incluso)' : '```\n' + f.content + '\n```'),
    ),
    '',
    '## Formato della risposta (obbligatorio)',
    'NON scrivere file sul disco. Rispondi solo con un blocco JSON:',
    '```json',
    `{"files": {"${specName}": "<contenuto COMPLETO della nuova spec>"}}`,
    '```',
  ].join('\n');
}

