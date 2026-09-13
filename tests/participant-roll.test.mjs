import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, rollDice, finishCard } from '../js/game-engine.js';
import { participantRollUiState } from '../js/online-storage.js';
import { readFile } from 'node:fs/promises';

const appSource = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const uiSource = await readFile(new URL('../js/ui.js', import.meta.url), 'utf8');
const realtimeSource = await readFile(new URL('../js/realtime-service.js', import.meta.url), 'utf8');

const game = () => createGame([
  { id: 'player-a', name: 'Анна', color: 'emerald' },
  { id: 'player-b', name: 'Белла', color: 'blue' }
]);

test('only the current participant receives an active roll button', () => {
  const state = game();
  assert.deepEqual(participantRollUiState(state, 'player-a'), {
    disabled: false, label: 'Бросить кубик', reason: 'Нажмите, чтобы бросить кубик.'
  });
  assert.equal(participantRollUiState(state, 'player-b').disabled, true);
  assert.equal(participantRollUiState(state, 'player-b').label, 'Сейчас ход: Анна');
});

test('pending request and open card prevent a repeated roll', () => {
  let state = game();
  assert.equal(participantRollUiState(state, 'player-a', 7).label, 'Ожидаем ведущую…');
  state = rollDice(state, 4);
  assert.equal(participantRollUiState(state, 'player-a').label, 'Карточка открыта');
  assert.equal(rollDice(state, 6), state);
});

test('host confirmation advances the queue after a participant roll', () => {
  let state = rollDice(game(), 3);
  assert.equal(state.players[0].position, 3);
  assert.equal(state.dice, 3);
  state = finishCard(state);
  assert.equal(state.currentPlayerIndex, 1);
  assert.equal(state.turnNumber, 2);
  assert.equal(participantRollUiState(state, 'player-b').disabled, false);
});

test('offline participant cannot request a roll from the interface', () => {
  const result = participantRollUiState(game(), 'player-a', null, 'Нет соединения');
  assert.equal(result.disabled, true);
  assert.equal(result.label, 'Нет соединения');
});

test('participant roll is requested once while host keeps card controls', () => {
  assert.match(appSource, /el\.roll_button\.disabled = true;[\s\S]*el\.roll_button\.textContent = 'Игра ещё не началась'/);
  assert.match(appSource, /pendingRollVersion != null[\s\S]*requestParticipantRoll\(roomContext\.roomId, roomContext\.version\)/);
  assert.match(uiSource, /\[el\.next_player_button, el\.undo_button, el\.confirm_card_button, el\.skip_card_button, el\.reshuffle_button\][\s\S]*button\.hidden = true/);
  assert.match(appSource, /confirm_card_button\.addEventListener\('click', \(\) => commit\(finishCard/);
  assert.match(appSource, /skip_card_button\.addEventListener\('click', \(\) => commit\(finishCard/);
});

test('roll requests are synchronized through a dedicated Realtime table', () => {
  assert.match(realtimeSource, /watch\('participant_roll_requests'.*onRollRequest/);
  assert.match(appSource, /onRollRequest: \(\) => \{ if \(isHost\(\)\) processRollRequests\(\); \}/);
  assert.match(appSource, /setInterval\(\(\) => \{[\s\S]*roomContext\?\.status === 'playing'[\s\S]*processRollRequests\(\)[\s\S]*\}, 2000\)/);
  assert.match(appSource, /commit\(rollDice\(gameState, request\.roll_value\)\)/);
});
