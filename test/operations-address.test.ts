import { describe, expect, it } from 'vitest';
import { orderProvince } from '../src/operations';

describe('order province extraction', () => {
  it('reads the L1 province returned by TikTok Shop Order Detail', () => {
    expect(orderProvince({
      recipient_address: {
        district_info: [
          { address_level: 'L0', address_level_name: 'Country', address_name: 'Việt Nam' },
          { address_level: 'L1', address_level_name: 'Tỉnh/Thành phố', address_name: 'Phú Thọ' },
          { address_level: 'L2', address_level_name: 'Quận/Huyện', address_name: 'Thanh Sơn' }
        ]
      }
    })).toBe('Phú Thọ');
  });

  it('supports alternate province fields from hydrated order details', () => {
    expect(orderProvince({ recipient_address: { region_name: 'Phú Thọ' } })).toBe('Phú Thọ');
    expect(orderProvince({
      recipient_address: {
        district_info_list: [
          { address_level_name: 'Province', region_name: 'Phú Thọ' }
        ]
      }
    })).toBe('Phú Thọ');
  });

  it('reads a masked Vietnamese full address when district info is omitted', () => {
    expect(orderProvince({
      recipient_address: { full_address: '************, Vĩnh Long, Việt Nam' }
    })).toBe('Vĩnh Long');
  });

  it('supports object-shaped district data and alternate address containers', () => {
    expect(orderProvince({
      shipping_address: {
        district_info: {
          country: { address_level: 'L0', address_name: 'Việt Nam' },
          province: { address_level: 'L1', address_name: 'Vĩnh Long' }
        }
      }
    })).toBe('Vĩnh Long');
  });

  it('does not stop at an empty recipient address when a sibling address is populated', () => {
    expect(orderProvince({
      recipient_address: {},
      shipping_address: { full_address: '********, Vĩnh Long, Việt Nam' }
    })).toBe('Vĩnh Long');
  });

  it('reads a province field on the order when address is redacted', () => {
    expect(orderProvince({ recipient_address: {}, province_name: 'Vĩnh Long' })).toBe('Vĩnh Long');
  });
});
