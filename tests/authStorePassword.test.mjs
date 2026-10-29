import test from 'node:test';
import assert from 'node:assert/strict';

const memoryStorage = (init = {}) => {
  const data = new Map(Object.entries(init));
  return {
    getItem: k => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: k => data.delete(k),
  };
};

test('auth: la contraseña guardada por versiones viejas se borra del equipo', async () => {
  globalThis.localStorage = memoryStorage();
  const { stripStoredPassword } = await import('../src/utils/authStorageCleanup.js');
  const s = memoryStorage({
    'abasto-auth-storage': JSON.stringify({ state: { adminEmail: 'a@b.com', adminPassword: 'secreta', usuarios: [] }, version: 2 }),
  });
  assert.equal(stripStoredPassword(s), true);
  const saved = JSON.parse(s.getItem('abasto-auth-storage'));
  assert.equal(saved.state.adminEmail, 'a@b.com', 'el correo se conserva');
  assert.equal('adminPassword' in saved.state, false);
  assert.equal(stripStoredPassword(s), false, 'segunda vez no hay nada que borrar');
});
