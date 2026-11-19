import { describe, it, expect } from 'vitest';
import { buildGraph, dependencyOrder } from '../src/core/analyze.js';
import type { SpecNode } from '../src/core/types.js';

function node(p: string, links: string[]): [string, SpecNode] {
  return [p, { specPath: p, folderPath: '/', inRoot: true, links }];
}

describe('dependencyOrder', () => {
  it('restituisce le basi prima delle foglie (topologico)', () => {
    const nodes = new Map([
      node('/r/base.helpai.md', []),
      node('/r/mid.helpai.md', ['/r/base.helpai.md']),
      node('/r/leaf.helpai.md', ['/r/mid.helpai.md', '/r/base.helpai.md']),
    ]);
    const g = buildGraph('/r', nodes);
    expect(dependencyOrder(g, '/r/leaf.helpai.md')).toEqual(['/r/base.helpai.md', '/r/mid.helpai.md']);
  });
});
