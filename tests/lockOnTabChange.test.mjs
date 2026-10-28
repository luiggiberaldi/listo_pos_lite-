import test from 'node:test';
import assert from 'node:assert/strict';

import {
    LOCK_ON_TAB_CHANGE_KEY,
    parseLockOnTabChange,
    getLockOnTabChange,
    setLockOnTabChange,
} from '../src/utils/lockOnTabChange.js';

function memoryStorage() {
    const data = new Map();
    return {
        getItem: (k) => (data.has(k) ? data.get(k) : null),
        setItem: (k, v) => data.set(k, String(v)),
    };
}

test('parseLockOnTabChange: activado por defecto, solo "false" lo apaga', () => {
    assert.equal(parseLockOnTabChange(null), true);
    assert.equal(parseLockOnTabChange(undefined), true);
    assert.equal(parseLockOnTabChange('true'), true);
    assert.equal(parseLockOnTabChange('false'), false);
});

test('getLockOnTabChange/setLockOnTabChange: guarda y lee la llave local', () => {
    const storage = memoryStorage();
    assert.equal(getLockOnTabChange(storage), true);
    setLockOnTabChange(false, storage);
    assert.equal(storage.getItem(LOCK_ON_TAB_CHANGE_KEY), 'false');
    assert.equal(getLockOnTabChange(storage), false);
    setLockOnTabChange(true, storage);
    assert.equal(getLockOnTabChange(storage), true);
});

test('getLockOnTabChange: si el almacenamiento falla, mantiene el bloqueo', () => {
    const broken = { getItem: () => { throw new Error('bloqueado'); } };
    assert.equal(getLockOnTabChange(broken), true);
});
