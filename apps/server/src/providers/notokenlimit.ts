import { NOTOKENLIMIT } from './errors.js';
import { OpenAICompatibleProvider, type OpenAICompatibleOptions } from './openaiCompatible.js';

export { ToolCallAccumulator } from './openaiCompatible.js';

export type NoTokenLimitOptions = Omit<
  OpenAICompatibleOptions,
  'id' | 'source' | 'prefix' | 'promptOverheadTokens' | 'maxTokensField' | 'modelFilter'
>;

/** NoTokenLimit: an OpenAI-compatible gateway; its model ids are used as they are. */
export class NoTokenLimitProvider extends OpenAICompatibleProvider {
  constructor(opts: NoTokenLimitOptions) {
    super({
      ...opts,
      id: 'notokenlimit',
      source: NOTOKENLIMIT,
      prefix: '',
      // Measured 2026-10-29: a ~60-token request was billed as ~1,180 prompt tokens.
      promptOverheadTokens: 1_500,
    });
  }
}
