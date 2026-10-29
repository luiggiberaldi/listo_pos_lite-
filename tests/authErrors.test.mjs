import test from 'node:test';
import assert from 'node:assert/strict';
import { translateAuthError, readAuthLinkError } from '../src/utils/authErrors.js';

test('auth: errores comunes de Supabase salen en español', () => {
  assert.equal(translateAuthError({ message: 'Invalid login credentials' }), 'Correo o contraseña incorrectos.');
  assert.match(translateAuthError({ code: 'email_not_confirmed', message: 'Email not confirmed' }), /confirmas tu correo/);
  assert.match(translateAuthError({ message: 'User already registered' }), /ya tiene una cuenta/);
  assert.match(translateAuthError({ message: 'For security purposes, you can only request this after 42 seconds.' }), /Espera unos minutos/);
  assert.match(translateAuthError(new TypeError('Failed to fetch')), /Sin conexión/);
});

test('auth: un error desconocido conserva el texto original', () => {
  assert.equal(translateAuthError({ message: 'Boom' }), 'Ocurrió un error. Inténtalo de nuevo. (Boom)');
  assert.equal(translateAuthError(null), 'Ocurrió un error. Inténtalo de nuevo.');
});

test('auth: detecta enlace de correo vencido en la URL', () => {
  const err = readAuthLinkError({ hash: '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired', search: '' });
  assert.equal(err.code, 'otp_expired');
  assert.match(err.message, /venció o ya se usó/);
  assert.equal(readAuthLinkError({ hash: '#access_token=x&type=recovery', search: '' }), null);
  assert.equal(readAuthLinkError({ hash: '', search: '' }), null);
});
