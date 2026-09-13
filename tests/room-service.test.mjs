import test from 'node:test';
import assert from 'node:assert/strict';
import { describeRoomError } from '../js/room-service.js';
import { readFile } from 'node:fs/promises';

const serviceSource = await readFile(new URL('../js/room-service.js', import.meta.url), 'utf8');

test('turns removed membership response into a friendly message', () => {
  assert.equal(
    describeRoomError({ code: 'PGRST116', message: 'Cannot coerce the result to a single JSON object' }),
    'Доступ к комнате завершён. Возможно, ведущая удалила вас или комната больше недоступна.'
  );
});

test('keeps domain errors understandable', () => {
  assert.equal(describeRoomError({ message: 'ROOM_CLOSED' }), 'Комната закрыта.');
  assert.equal(describeRoomError({ message: 'NOT_CURRENT_PLAYER' }), 'Сейчас ход другой участницы.');
});

test('participant cannot provide a dice value to the roll RPC', () => {
  assert.match(serviceSource, /requestParticipantRoll = \(roomId, version\) => rpc\('request_participant_roll', \{ p_room_id: roomId, p_expected_version: version \}\)/);
  assert.doesNotMatch(serviceSource, /requestParticipantRoll = \([^)]*(dice|roll|value)/i);
});
