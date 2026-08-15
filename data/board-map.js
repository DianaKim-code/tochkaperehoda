export const CELL_DECK = {
  1:'self', 2:'practice', 3:'self', 4:'resources', 5:'deeper', 6:'self', 7:'newView', 8:'limits', 9:'integration',
  10:'resources', 11:'limits', 12:'practice', 13:'deeper', 14:'newView', 15:'limits',
  16:'self', 17:'deeper', 18:'practice', 19:'resources', 20:'limits', 21:'self', 22:'newView', 23:'deeper', 24:'integration',
  25:'practice', 26:'limits', 27:'resources', 28:'choice', 29:'limits', 30:'resources',
  31:'self', 32:'limits', 33:'deeper', 34:'resources', 35:'newView', 36:'limits', 37:'practice', 38:'choice', 39:'integration',
  40:'limits', 41:'resources', 42:'newView', 43:'resources', 44:'deeper', 45:'choice',
  46:'resources', 47:'self', 48:'resources', 49:'practice', 50:'newView', 51:'resources', 52:'choice', 53:'resources', 54:'integration',
  55:'practice', 56:'resources', 57:'limits', 58:'limits', 59:'limits', 60:'resources',
  61:'self', 62:'newView', 63:'resources', 64:'choice', 65:'practice', 66:'limits', 67:'newView', 68:'choice',
  69:'resources', 70:'deeper', 71:'practice', 72:'choice', 73:'limits', 74:'limits', 75:'integration'
};

export const INTEGRATIONS = [9, 24, 39, 54, 75];
export const INTEGRATION_JUMPS = { 9: 16, 24: 31, 39: 46, 54: 61 };

export function zoneForCell(cell) {
  if (cell <= 15) return 'Где я сейчас';
  if (cell <= 30) return 'Что я завершаю';
  if (cell <= 45) return 'Что меня удерживает';
  if (cell <= 60) return 'На что я могу опереться';
  return 'Мой следующий шаг';
}

