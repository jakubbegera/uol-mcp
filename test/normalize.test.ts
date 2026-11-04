import { describe, expect, it } from 'vitest';
import { currentRevision } from '../src/domain/company.js';
import { outstanding, paymentOfReceivable } from '../src/domain/receivables.js';
import { safeFileName } from '../src/domain/files.js';
import {
  amount,
  daysBetween,
  hrefId,
  invoiceStatus,
  pageInfo,
  pragueDate,
  receivableKind,
  stripNoise,
  vatPeriod,
} from '../src/uol/normalize.js';

describe('normalize', () => {
  it.each([
    ['1210.0', 1210],
    [' -6612.65 ', -6612.65],
    [42, 42],
    ['', null],
    [null, null],
    ['abc', null],
  ])('amount(%j) = %j', (raw, expected) => {
    expect(amount(raw)).toBe(expected);
  });

  it('decodes invoice status — "valid" is a draft on invoices', () => {
    expect(['valid', 'confirmed', 'invalid', 'x'].map(invoiceStatus)).toEqual(['draft', 'issued', 'cancelled', 'unknown']);
  });

  it('decodes receivable kinds', () => {
    expect(['N', 'Z', 'D', '?'].map(receivableKind)).toEqual(['standard', 'proforma', 'corrective', 'unknown']);
  });

  it('decodes the undocumented VAT payer code', () => {
    expect(['M', 'K', null].map(vatPeriod)).toEqual(['monthly', 'quarterly', 'not_vat_payer']);
  });

  it('takes the id from an href reference', () => {
    expect(hrefId({ _meta: { href: 'https://t.uol.cz/api/v1/contacts/skoda_auto_as' } })).toBe('skoda_auto_as');
    expect(hrefId({ _meta: null })).toBeNull();
  });

  it('reads pagination links', () => {
    // arrange
    const body = {
      _meta: {
        pagination: {
          last: 'https://t.uol.cz/api/v1/sales_invoices?page=52&per_page=5',
          next: 'https://t.uol.cz/api/v1/sales_invoices?page=2&per_page=5',
        },
      },
    };

    // act
    const info = pageInfo(body, 1, 5);

    // assert
    expect(info).toEqual({ page: 1, per_page: 5, has_more: true, total_pages: 52 });
  });

  it('computes Prague dates and day differences', () => {
    expect(pragueDate(new Date('2026-11-04T23:30:00Z'))).toBe('2026-11-05');
    expect(daysBetween('2026-10-31', '2026-11-04')).toBe(4);
  });

  it('strips audit noise from codebook records', () => {
    expect(stripNoise({ _meta: {}, creator: {}, name: 'CZK', created_at: 'x' })).toEqual({ name: 'CZK' });
  });
});

describe('currentRevision', () => {
  it('picks the active revision with the latest valid_from', () => {
    // arrange
    const revisions = [
      { name: 'old', status: 'valid', valid_from: '2009-01-01', valid_to: '2019-12-31', vat_payer_code: null },
      { name: 'current', status: 'valid', valid_from: '2020-01-01', valid_to: null, vat_payer_code: 'M' },
      { name: 'draft', status: 'invalid', valid_from: '2026-01-01', valid_to: null },
    ];

    // act
    const current = currentRevision(revisions);

    // assert
    expect(current?.name).toBe('current');
  });

  it('falls back to the first row', () => {
    expect(currentRevision([{ name: 'only', status: 'other' }])?.name).toBe('only');
  });
});

describe('receivables', () => {
  it.each([
    [{ total_amount: '330.0', paid_amount: '120.0' }, 'partially_paid', 210],
    [{ total_amount: '121.0', paid_amount: '0.0' }, 'unpaid', 121],
    [{ total_amount: '368.0', paid_amount: '368.0' }, 'paid', 0],
    [{ total_amount: '-7865.0', paid_amount: '0.0' }, 'unpaid', -7865],
  ])('%j → %s', (row, state, due) => {
    expect(paymentOfReceivable(row)).toEqual({ state, outstanding: due });
    expect(outstanding(row)).toBe(due);
  });
});

describe('safeFileName', () => {
  it('replaces characters that are unsafe on any OS and keeps accents', () => {
    expect(safeFileName('a:b/c?.pdf', 'x.pdf')).toBe('a_b_c_.pdf');
    expect(safeFileName('Faktura_vystavená.pdf', 'x.pdf')).toBe('Faktura_vystavená.pdf');
    expect(safeFileName('..', 'x.pdf')).toBe('x.pdf');
    expect(safeFileName(undefined, 'x.pdf')).toBe('x.pdf');
  });
});
