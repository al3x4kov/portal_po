import { isEmbeddingModelId } from '@po/core';
import { BadRequestError } from './errors.js';

/**
 * Reject an embedding model before ANY chat-completion work starts: such
 * models cannot generate text, so an import/chat/generation run with one is
 * guaranteed to fail — better a human 400 up-front than a hub error later.
 */
export function assertChatCapableModel(model: string): void {
  if (isEmbeddingModelId(model)) {
    throw new BadRequestError(
      `Модель „${model}“ — embedding-модель, она не умеет генерировать текст. ` +
        'Выберите чат-модель (например, DeepSeek-V4-Flash или Qwen3.5).',
    );
  }
}
