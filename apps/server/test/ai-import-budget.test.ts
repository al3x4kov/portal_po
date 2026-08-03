import { describe, expect, it } from 'vitest';
import { BudgetTracker } from '../src/services/aiImport/budget.js';

/*
 * todo_20 · T-208: бюджет прогона (B6, E2) — учёт usage против
 * `preset.runBudgetTokens`, мягкая остановка BUDGET-01 решается стадией.
 */

describe('T-208 · BudgetTracker', () => {
  it('без лимита (null) никогда не превышается', () => {
    const budget = new BudgetTracker(null);
    budget.add({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
    expect(budget.exceeded()).toBe(false);
    expect(budget.view()).toEqual({ promptTokens: 1_000_000, completionTokens: 1_000_000 });
  });

  it('копит usage из ответов (в т.ч. частичных/отсутствующих)', () => {
    const budget = new BudgetTracker(10_000);
    budget.add({ prompt_tokens: 100, completion_tokens: 50 });
    budget.add(undefined); // бэкенд без usage — не падает
    budget.add({ prompt_tokens: 30 }); // без completion
    expect(budget.view()).toEqual({ promptTokens: 130, completionTokens: 50 });
    expect(budget.totalTokens()).toBe(180);
    expect(budget.exceeded()).toBe(false);
  });

  it('превышение лимита фиксируется', () => {
    const budget = new BudgetTracker(100);
    budget.add({ prompt_tokens: 80, completion_tokens: 30 });
    expect(budget.exceeded()).toBe(true);
  });

  it('лимит 0 — любой расход превышает (жёсткая экономия)', () => {
    const budget = new BudgetTracker(0);
    expect(budget.exceeded()).toBe(false); // ещё ничего не потрачено
    budget.add({ prompt_tokens: 1 });
    expect(budget.exceeded()).toBe(true);
  });

  it('состояние сериализуемо для чекпоинта', () => {
    const budget = new BudgetTracker(500);
    budget.add({ prompt_tokens: 10, completion_tokens: 5 });
    const restored = BudgetTracker.fromJSON(JSON.parse(JSON.stringify(budget.toJSON())));
    expect(restored.view()).toEqual(budget.view());
    expect(restored.exceeded()).toBe(budget.exceeded());
  });
});
