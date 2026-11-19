import { describe, expect, it } from 'vitest';
import { parseProposal, validateProposalNames, ProposalError } from '../src/core/proposal.js';

describe('parseProposal', () => {
  it('legge il blocco json con files', () => {
    const out = 'ok\n```json\n{"files": {"a.ts": "export const a = 1;"}}\n```';
    expect(parseProposal(out)).toEqual({ 'a.ts': 'export const a = 1;' });
  });

  it('accetta JSON senza recinto', () => {
    expect(parseProposal('{"files":{"b.ts":"x"}}')).toEqual({ 'b.ts': 'x' });
  });

  it('rifiuta testo libero senza JSON', () => {
    expect(() => parseProposal('tutto corretto')).toThrow(ProposalError);
  });

  it('rifiuta contenuto non testuale', () => {
    expect(() => parseProposal('{"files":{"a.ts":1}}')).toThrow(ProposalError);
  });
});

describe('validateProposalNames', () => {
  it('blocca percorsi e spec', () => {
    expect(() => validateProposalNames({ 'sub/a.ts': '' })).toThrow(ProposalError);
    expect(() => validateProposalNames({ '../x.ts': '' })).toThrow(ProposalError);
    expect(() => validateProposalNames({ 'x.helpai.md': '' })).toThrow(ProposalError);
  });

  it('accetta file diretti', () => {
    expect(() => validateProposalNames({ 'singer.model.ts': '' })).not.toThrow();
  });
});
