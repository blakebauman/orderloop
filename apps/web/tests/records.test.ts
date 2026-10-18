import { describe, expect, it } from 'vitest';
import { recordTone, stepOf } from '../app/lib/records';

describe('stepOf', () => {
  it('reads the step key from a connector row id', () => {
    expect(stepOf('pay_ord_mv12ab_authorize_1', 'ord_mv12ab')).toBe('authorize#1');
    expect(stepOf('chg_ord_mv12ab_ap_charge_3', 'ord_mv12ab')).toBe('ap_charge#3');
    expect(stepOf('res_ord_mv12ab_reserve_1_0_WID-100', 'ord_mv12ab')).toBe('reserve#1');
    expect(stepOf('hnd_ord_mv12ab_handover_2', 'ord_mv12ab')).toBe('handover#2');
    // Captures put the step before the order id.
    expect(stepOf('cap_capture_1_ord_mv12ab', 'ord_mv12ab')).toBe('capture#1');
  });

  it('gives up on ids that are not keyed by step', () => {
    expect(stepOf('msg_x1y2', 'ord_mv12ab')).toBeNull();
    expect(stepOf('so_ord_mv12ab_sel_kettle', 'ord_mv12ab')).toBe('sel_kettle');
  });
});

describe('recordTone', () => {
  it('colours outcomes the way the rest of the app does', () => {
    expect(recordTone('captured')).toBe('ok');
    expect(recordTone('declined')).toBe('bad');
    expect(recordTone('voided')).toBe('undo');
    expect(recordTone('held')).toBe('wait');
    expect(recordTone('something_new')).toBe('idle');
    expect(recordTone(null)).toBe('idle');
  });
});
