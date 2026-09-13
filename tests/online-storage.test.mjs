import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRoomCode, shouldRestoreRoomSession, sanitizeSharedState, attachPrivateMaps } from '../js/online-storage.js';

test('normalizes invitation codes', () => {
  assert.equal(normalizeRoomCode('482701'), 'TP-482701');
  assert.equal(normalizeRoomCode('tp 482701'), 'TP-482701');
  assert.equal(normalizeRoomCode('tp-482701'), 'TP-482701');
  assert.equal(normalizeRoomCode('4827'), '4827');
});

test('removes private maps from current state and undo history', () => {
  const source = { players: [{ id: 'p1', transitionMap: { request: 'private' } }], history: [{ players: [{ id: 'p1', transitionMap: { request: 'older private' } }] }] };
  const shared = sanitizeSharedState(source);
  assert.equal('transitionMap' in shared.players[0], false);
  assert.equal('transitionMap' in shared.history[0].players[0], false);
  assert.equal(source.players[0].transitionMap.request, 'private');
});

test('attaches only maps supplied by the permitted query', () => {
  const state = { players: [{ id: 'mine' }, { id: 'other' }] };
  const result = attachPrivateMaps(state, new Map([['mine', { request: 'visible', integrations: [] }]]));
  assert.equal(result.players[0].transitionMap.request, 'visible');
  assert.equal(result.players[1].transitionMap.request, '');
});

test('normalizes an empty database map for the transition-map form', () => {
  const result = attachPrivateMaps({ players: [{ id: 'p1' }] }, new Map([['p1', {}]]));
  assert.equal(result.players[0].transitionMap.request, '');
  assert.deepEqual(result.players[0].transitionMap.integrations, ['', '', '', '', '']);
});

test('restores saved membership before treating any room query as a new invitation', () => {
  const session = { roomId: 'room-1', code: 'TP-808096', role: 'participant' };
  assert.equal(shouldRestoreRoomSession('TP-808096', session), true);
  assert.equal(shouldRestoreRoomSession('', session), true);
  assert.equal(shouldRestoreRoomSession('TP-999999', session), true);
});
