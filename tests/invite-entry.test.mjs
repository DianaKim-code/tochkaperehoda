import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');

test('ordinary start screen explains all three roles', () => {
  assert.match(html, /Локальная игра на одном устройстве/);
  assert.match(html, /Ведущая — создать онлайн-комнату/);
  assert.match(html, /Участница — войти по коду/);
});

test('invitation mode hides the mode picker and editable code field', () => {
  assert.match(app, /configureJoinForm\(\{ invite: true, code: queryCode \}\)/);
  assert.match(app, /join_room_title\.textContent = invite \? 'Присоединиться к игре'/);
  assert.match(app, /join_room_code_field\.hidden = invite/);
  assert.match(app, /roomCode\.readOnly = invite/);
  assert.match(app, /playerColor\.closest\('label'\)\.hidden = true/);
});

test('invitation validates the room before revealing colors', () => {
  assert.match(app, /await loadJoinFormInfo\(queryCode, true\)/);
  assert.match(app, /const info = await getJoinInfo\(code\)[\s\S]*playerColor\.innerHTML = colorOptions\(info\.available_colors\)/);
  assert.match(app, /catch \(error\)[\s\S]*join_room_message\.textContent = error\.message/);
});
