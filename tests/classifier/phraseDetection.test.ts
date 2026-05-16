import { describe, it, expect } from '@jest/globals';
import { hasReplicationPhrase, findReplicationPhrase } from '../../src/classifier/phraseDetection.js';

describe('phraseDetection', () => {
  it('returns true for "replication of"', () => {
    expect(hasReplicationPhrase('A replication of Smith (2010).')).toBe(true);
  });
  it('returns true for "we replicated"', () => {
    expect(hasReplicationPhrase('In Study 1, we replicated Jones et al. (2015).')).toBe(true);
  });
  it('returns true for "failed to replicate"', () => {
    expect(hasReplicationPhrase('We failed to replicate the original finding.')).toBe(true);
  });
  it('returns false for text with no replication keyword', () => {
    expect(hasReplicationPhrase('We studied attitudes among undergraduates.')).toBe(false);
  });
  it('findReplicationPhrase returns the matched phrase', () => {
    const m = findReplicationPhrase('This is a direct replication of Carney et al. (2010).');
    expect(m).toBe('replication of');
  });
  it('does not match unrelated "replica" contexts', () => {
    expect(hasReplicationPhrase('We built a replica of the experimental apparatus.')).toBe(false);
  });
  it('does not treat method/model/data/cell replication as a scholarly replication claim', () => {
    expect(hasReplicationPhrase('We replicated the simulation model in Python.')).toBe(false);
    expect(hasReplicationPhrase('DNA replication timing differed across cell lines.')).toBe(false);
    expect(hasReplicationPhrase('The replication of the dataset used a cleaner pipeline.')).toBe(false);
  });
});
