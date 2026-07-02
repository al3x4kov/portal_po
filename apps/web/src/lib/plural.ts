/** Russian pluralization: pick one/few/many form for a count. */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

/** "N зависимость / зависимости / зависимостей". */
export function dependenciesLabel(n: number): string {
  return `${n} ${plural(n, 'зависимость', 'зависимости', 'зависимостей')}`;
}

/** "N совпадение / совпадения / совпадений". */
export function matchesLabel(n: number): string {
  return `${n} ${plural(n, 'совпадение', 'совпадения', 'совпадений')}`;
}
