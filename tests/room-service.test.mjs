import test from 'node:test';
import assert from 'node:assert/strict';
import { describeRoomError } from '../js/room-service.js';

test('turns removed membership response into a friendly message', () => {
  assert.equal(
    describeRoomError({ code: 'PGRST116', message: 'Cannot coerce the result to a single JSON object' }),
    'Доступ к комнате завершён. Возможно, ведущая удалила вас или комната больше недоступна.'
  );
});

test('keeps domain errors understandable', () => {
  assert.equal(describeRoomError({ message: 'ROOM_CLOSED' }), 'Комната закрыта.');
});
