import { describe, it, expect } from 'vitest';

import { isYmd, clampPerPage, pageNum, cutoffFrom, rowToReading, readingToRow } from '../src/lib';

describe('isYmd', () => {
  it('accepts real Y-m-d dates and rejects the rest', () => {
    expect(isYmd('2026-07-19')).toBe(true);
    expect(isYmd('not-a-date')).toBe(false);
    expect(isYmd('2026-13-01')).toBe(false); // no month 13
    expect(isYmd('2026-7-9')).toBe(false); // not zero-padded
  });
});

describe('pagination params', () => {
  it('clamps per_page to 1..100 with a default of 15', () => {
    expect(clampPerPage(null)).toBe(15);
    expect(clampPerPage('2')).toBe(2);
    expect(clampPerPage('9999')).toBe(100);
    expect(clampPerPage('0')).toBe(1);
    expect(clampPerPage('abc')).toBe(15);
  });
  it('defaults page to 1', () => {
    expect(pageNum(null)).toBe(1);
    expect(pageNum('3')).toBe(3);
    expect(pageNum('-2')).toBe(1);
  });
});

describe('cutoffFrom', () => {
  it('subtracts days in UTC and returns an ISO-Z string', () => {
    expect(cutoffFrom('2026-07-19', 7)).toBe('2026-07-12T00:00:00Z');
    expect(cutoffFrom('2026-07-01', 1)).toBe('2026-06-30T00:00:00Z');
  });
});

describe('row <-> reading', () => {
  it('parses JSON arrays on read', () => {
    const r = rowToReading({ date_raw: '2026-07-19T00:00:00Z', title: 'T', lecturas: '[{"title":"Evangelio"}]', questions: '["q1"]' });
    expect(r.lecturas).toEqual([{ title: 'Evangelio' }]);
    expect(r.questions).toEqual(['q1']);
  });
  it('serializes arrays and applies defaults on write', () => {
    const row = readingToRow({ date_raw: '2026-07-19T00:00:00Z', lecturas: [{ title: 'A' }] });
    expect(row.lecturas).toBe('[{"title":"A"}]');
    expect(row.questions).toBe('[]');
    expect(row.source_version).toBe(2);
    expect(row.title).toBe('');
  });
});
