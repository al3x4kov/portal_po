import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FsRequirementRepo } from '../repositories/FsRequirementRepo.js';
import { normalizeRequirementName } from '../services/aiImport/dedupe.js';

/**
 * todo_20 · T-216 (A5, решение PO №5): сравнение результата AI-прогона с
 * эталонным реестром требований по НОРМАЛИЗОВАННЫМ именам.
 *
 * Канонический эталон (например, docsourcecontrol — 810 ФТ) живёт ВНЕ репо и
 * передаётся параметром: файл-список имён (JSON-массив строк / объектов с
 * полем `name`, либо просто по имени в строке). Отчёт — полнота (recall,
 * доля эталона, найденная прогоном) и точность (precision, доля результата,
 * подтверждённая эталоном) + конкретные списки расхождений.
 *
 * CLI: `node apps/server/dist/tools/compareEtalon.js <projectsRoot> <projectId> <etalonPath>`
 */

export interface EtalonComparison {
  etalonTotal: number;
  extractedTotal: number;
  matched: number;
  /** recall: matched / etalonTotal (1 при пустом эталоне). */
  completeness: number;
  /** precision: matched / extractedTotal (1 при пустом результате). */
  precision: number;
  /** Эталонные имена, не найденные в результате. */
  missing: string[];
  /** Имена результата, отсутствующие в эталоне. */
  extra: string[];
}

/** Pure comparison over normalized names (layout/case/punctuation-insensitive). */
export function compareWithEtalon(
  extractedNames: readonly string[],
  etalonNames: readonly string[],
): EtalonComparison {
  const extractedByKey = new Map<string, string>();
  for (const name of extractedNames) {
    const key = normalizeRequirementName(name);
    if (key.length > 0 && !extractedByKey.has(key)) extractedByKey.set(key, name);
  }
  const etalonByKey = new Map<string, string>();
  for (const name of etalonNames) {
    const key = normalizeRequirementName(name);
    if (key.length > 0 && !etalonByKey.has(key)) etalonByKey.set(key, name);
  }

  const missing: string[] = [];
  let matched = 0;
  for (const [key, name] of etalonByKey) {
    if (extractedByKey.has(key)) matched += 1;
    else missing.push(name);
  }
  const extra = [...extractedByKey.entries()]
    .filter(([key]) => !etalonByKey.has(key))
    .map(([, name]) => name);

  const etalonTotal = etalonByKey.size;
  const extractedTotal = extractedByKey.size;
  return {
    etalonTotal,
    extractedTotal,
    matched,
    completeness: etalonTotal === 0 ? 1 : matched / etalonTotal,
    precision: extractedTotal === 0 ? 1 : matched / extractedTotal,
    missing,
    extra,
  };
}

/** Parse an etalon file: JSON array of strings/objects-with-name, or one name per line. */
export function parseEtalonList(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const value: unknown = JSON.parse(trimmed);
      if (Array.isArray(value)) {
        return value
          .map((item) =>
            typeof item === 'string'
              ? item
              : typeof (item as { name?: unknown })?.name === 'string'
                ? (item as { name: string }).name
                : '',
          )
          .filter((name) => name.length > 0);
      }
    } catch {
      /* not JSON — fall through to line mode */
    }
  }
  return trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/** Load the requirement names of a project on disk. */
export async function projectRequirementNames(
  projectsRoot: string,
  projectId: string,
): Promise<string[]> {
  const repo = new FsRequirementRepo(projectsRoot, projectId);
  const { requirements } = await repo.loadAll();
  return requirements.map((r) => r.name);
}

async function main(): Promise<void> {
  const [projectsRoot, projectId, etalonPath] = process.argv.slice(2);
  if (!projectsRoot || !projectId || !etalonPath) {
    console.error(
      'Usage: node compareEtalon.js <projectsRoot> <projectId> <etalonPath>\n' +
        'Эталон: JSON-массив имён (или объектов с полем name) либо текст «одно имя на строку».',
    );
    process.exitCode = 2;
    return;
  }
  const names = await projectRequirementNames(path.resolve(projectsRoot), projectId);
  const etalon = parseEtalonList(await fs.readFile(path.resolve(etalonPath), 'utf8'));
  const report = compareWithEtalon(names, etalon);
  console.log(JSON.stringify(report, null, 2));
  console.error(
    `Полнота: ${(report.completeness * 100).toFixed(1)}% (${report.matched}/${report.etalonTotal}); ` +
      `точность: ${(report.precision * 100).toFixed(1)}% (${report.matched}/${report.extractedTotal}).`,
  );
}

// CLI entry (skipped when imported as a module by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error('compareEtalon failed:', err);
    process.exitCode = 1;
  });
}
