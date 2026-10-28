import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCAL_OWNER_KEY, stashKey, switchLocalAccount } from '../src/config/accountLocalSwap.js';

const memoryStorage = (init = {}) => {
  const data = new Map(Object.entries(init));
  return {
    getItem: k => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: k => data.delete(k),
    data,
  };
};
const keys = ['business_name', 'tasa_cop', 'abasto-auth-storage'];

test('B8: equipo de antes: la primera cuenta adopta los valores actuales', () => {
  const s = memoryStorage({ business_name: 'Bodega A' });
  assert.equal(switchLocalAccount('A', { storage: s, keys }), false);
  assert.equal(s.getItem('business_name'), 'Bodega A');
  assert.equal(s.getItem(LOCAL_OWNER_KEY), 'A');
});

test('B8: la cuenta B no ve la configuración de la cuenta A', () => {
  const s = memoryStorage({ [LOCAL_OWNER_KEY]: 'A', business_name: 'Bodega A', tasa_cop: '4000', 'abasto-auth-storage': '{"pinA":1}' });
  assert.equal(switchLocalAccount('B', { storage: s, keys }), true);
  assert.equal(s.getItem('business_name'), null);
  assert.equal(s.getItem('abasto-auth-storage'), null, 'los PIN de A no pasan a B');
  assert.equal(s.getItem(stashKey('A', 'business_name')), 'Bodega A');
  assert.equal(s.getItem(LOCAL_OWNER_KEY), 'B');
});

test('B8: volver a la cuenta A recupera lo suyo y guarda lo de B', () => {
  const s = memoryStorage({ [LOCAL_OWNER_KEY]: 'A', business_name: 'Bodega A', tasa_cop: '4000' });
  switchLocalAccount('B', { storage: s, keys });
  s.setItem('business_name', 'Abasto B');
  switchLocalAccount('A', { storage: s, keys });
  assert.equal(s.getItem('business_name'), 'Bodega A');
  assert.equal(s.getItem('tasa_cop'), '4000');
  assert.equal(s.getItem(stashKey('B', 'business_name')), 'Abasto B');
  assert.equal(s.getItem(stashKey('A', 'business_name')), null, 'la copia aparte se limpia al restaurar');
  switchLocalAccount('B', { storage: s, keys });
  assert.equal(s.getItem('business_name'), 'Abasto B');
  assert.equal(s.getItem('tasa_cop'), null);
});

test('B8: misma cuenta o cierre de sesión no tocan nada', () => {
  const s = memoryStorage({ [LOCAL_OWNER_KEY]: 'A', business_name: 'Bodega A' });
  assert.equal(switchLocalAccount('A', { storage: s, keys }), false);
  assert.equal(switchLocalAccount(null, { storage: s, keys }), false);
  assert.equal(s.getItem('business_name'), 'Bodega A');
});
