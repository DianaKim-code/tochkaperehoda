import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, rollDice, finishCard, setPlayerPosition, changeResource, resourceBalance, undo } from '../js/game-engine.js';
import { BOARD_COORDINATES } from '../data/board-coordinates.js';

const person = [{name:'Анна', color:'emerald'}];

test('есть 76 координат: старт и ячейки 1–75', () => {
  assert.equal(BOARD_COORDINATES.length, 76);
  assert.ok(BOARD_COORDINATES.every(point => point.x >= 0 && point.x <= 100 && point.y >= 0 && point.y <= 100));
});

test('точное попадание на 9 открывает интеграцию и переводит на 16 после подтверждения', () => {
  let state = createGame(person);
  state = setPlayerPosition(state, state.players[0].id, 8);
  state = rollDice(state, 1);
  assert.equal(state.players[0].position, 9);
  assert.equal(state.openCard.integration, true);
  state = finishCard(state);
  assert.equal(state.players[0].position, 16);
});

test('переход мимо 9 не останавливает фишку', () => {
  let state = createGame(person);
  state = setPlayerPosition(state, state.players[0].id, 8);
  state = rollDice(state, 2);
  assert.equal(state.players[0].position, 10);
  assert.equal(state.openCard.deck, 'resources');
});

test('пересечение 75 всегда открывает финальную интеграцию и завершает путь', () => {
  let state = createGame(person);
  state = setPlayerPosition(state, state.players[0].id, 73);
  state = rollDice(state, 6);
  assert.equal(state.players[0].position, 75);
  assert.equal(state.openCard.cell, 75);
  state = finishCard(state);
  assert.equal(state.players[0].finished, true);
  assert.equal(state.status, 'complete');
});

test('карточки одной колоды не повторяются до исчерпания', () => {
  let state = createGame(person);
  const id = state.players[0].id;
  for (let i = 0; i < 24; i += 1) {
    state = setPlayerPosition(state, id, 1);
    state = rollDice(state, 0);
    state = finishCard(state);
  }
  assert.equal(state.usedCards.self.length, 24);
  assert.equal(new Set(state.usedCards.self).size, 24);
  state = setPlayerPosition(state, id, 1);
  state = rollDice(state, 0);
  assert.equal(state.openCard.exhausted, true);
});

test('остаток ресурса не становится отрицательным, undo возвращает состояние', () => {
  let state = createGame(person);
  const id = state.players[0].id;
  state = changeResource(state, id, 'tokens', -1);
  assert.equal(resourceBalance(state.players[0].resources.tokens), 0);
  state = changeResource(state, id, 'tokens', 1);
  assert.equal(resourceBalance(state.players[0].resources.tokens), 1);
  state = undo(state);
  assert.equal(resourceBalance(state.players[0].resources.tokens), 0);
});

