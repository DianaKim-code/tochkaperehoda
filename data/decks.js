export const DECKS = {
  self: { title: 'Вопрос к себе', folder: 'self', prefix: 'ВКС' },
  deeper: { title: 'Посмотри глубже', folder: 'deeper', prefix: 'ПГ' },
  practice: { title: 'Практика', folder: 'practice', prefix: 'ПР' },
  resources: { title: 'Мои ресурсы', folder: 'resources', prefix: 'МР' },
  limits: { title: 'Что меня ограничивает', folder: 'limits', prefix: 'ОГР' },
  newView: { title: 'Новый взгляд', folder: 'new-view', prefix: 'НВ' },
  choice: { title: 'Выбор', folder: 'choice', prefix: 'ВЫБ' },
  integration: { title: 'Интеграция', folder: 'integration', prefix: 'ИНТ' }
};

export const MAIN_DECK_KEYS = ['self', 'deeper', 'practice', 'resources', 'limits', 'newView', 'choice'];

export function cardImage(deck, number) {
  return `./assets/cards/${DECKS[deck].folder}/${String(number).padStart(2, '0')}.png`;
}

export const INTEGRATION_NUMBER = { 9: 1, 24: 2, 39: 3, 54: 4, 75: 5 };

