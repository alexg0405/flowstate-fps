import { describe, expect, it } from 'vitest';
import { chainEarnsFlourish, comboScoring, runScoring } from '../src/content/config';

describe('when a chain earns the all-out flourish', () => {
  it('says nothing below the threshold', () => {
    for (let links = 0; links < comboScoring.flourishFromLink; links += 1) {
      expect(chainEarnsFlourish(links)).toBe(false);
    }
  });

  it('fires on the threshold and then only every few links after it', () => {
    const first = comboScoring.flourishFromLink;
    const step = comboScoring.flourishEveryLinks;
    expect(chainEarnsFlourish(first)).toBe(true);
    expect(chainEarnsFlourish(first + step)).toBe(true);
    for (let offset = 1; offset < step; offset += 1) expect(chainEarnsFlourish(first + offset)).toBe(false);
  });

  it('stays rare across the longest chain the scoring allows', () => {
    // A full-frame effect fires at a player who is mid-air, so how often it can
    // possibly happen is the number that matters, not how it looks once.
    let fired = 0;
    for (let links = 0; links <= comboScoring.maxLinks; links += 1) if (chainEarnsFlourish(links)) fired += 1;
    expect(fired).toBeLessThanOrEqual(4);
  });

  it('is reachable inside a run that earns the top rank', () => {
    // An S wants a peak of eight links; a flourish nobody ever sees is dead code.
    const topRank = runScoring.ranks[0];
    expect(chainEarnsFlourish(comboScoring.flourishFromLink)).toBe(true);
    expect(comboScoring.flourishFromLink).toBeLessThanOrEqual(topRank.minPeakCombo);
  });
});
