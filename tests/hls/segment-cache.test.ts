import { describe, it, expect, beforeEach } from 'bun:test';
import { SegmentCache } from '../../src/hls/m3u8-processor';

describe('SegmentCache', () => {
  let cache: SegmentCache;

  beforeEach(() => {
    cache = new SegmentCache();
  });

  describe('size bound', () => {
    it('evicts oldest entry when exceeding the max', () => {
      for (let i = 0; i < 501; i++) {
        cache.markAdSegment(`https://ad${i}.ts`);
      }
      expect(cache.isAdSegment('https://ad0.ts')).toBe(false);
      expect(cache.isAdSegment('https://ad1.ts')).toBe(true);
      expect(cache.isAdSegment('https://ad500.ts')).toBe(true);
      expect(cache.getAdSegmentUrls()).toHaveLength(500);
    });

    it('re-marking an existing url refreshes its position', () => {
      for (let i = 0; i < 500; i++) {
        cache.markAdSegment(`https://ad${i}.ts`);
      }
      cache.markAdSegment('https://ad0.ts');
      cache.markAdSegment('https://newad.ts');

      expect(cache.isAdSegment('https://ad0.ts')).toBe(true);
      expect(cache.isAdSegment('https://ad1.ts')).toBe(false);
      expect(cache.isAdSegment('https://newad.ts')).toBe(true);
    });
  });
});
