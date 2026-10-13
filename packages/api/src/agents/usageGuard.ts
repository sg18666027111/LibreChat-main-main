import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { BaseLanguageModelParams } from '@langchain/core/language_models/base';
export type UsageModelIdentity = {
  provider: string;
  model: string;
  businessType: 'chat' | 'other';
};
export type BeforeUsageModelCall = (identity: UsageModelIdentity) => Promise<void>;
class UsageAdmissionHandler extends BaseCallbackHandler {
  name = 'usage_admission';
  constructor(
    private readonly before: BeforeUsageModelCall,
    private readonly identity: UsageModelIdentity,
  ) {
    super({ raiseError: true, _awaitHandler: true });
  }

  async handleChatModelStart() {
    await this.before(this.identity);
  }

  async handleLLMStart() {
    await this.before(this.identity);
  }
}
type GuardableOptions = BaseLanguageModelParams & {
  model?: string;
  modelName?: string;
  fallbacks?: { provider: string; clientOptions?: GuardableOptions }[];
};
/** Model-local handlers survive child invocation callbacks:[]; raiseError forces awaiting. */
export function addUsageModelGuard<T extends GuardableOptions>(
  options: T,
  identity: UsageModelIdentity,
  before?: BeforeUsageModelCall,
): T {
  if (!before) return options;
  const existing = options.callbacks;
  const guard = new UsageAdmissionHandler(before, identity);
  const callbacks = Array.isArray(existing) ? [...existing, guard] : existing?.copy();
  if (callbacks && !Array.isArray(callbacks)) callbacks.addHandler(guard, true);
  return {
    ...options,
    callbacks: callbacks || [guard],
    ...(options.fallbacks
      ? {
          fallbacks: options.fallbacks.map((fallback) => ({
            ...fallback,
            clientOptions: addUsageModelGuard(
              fallback.clientOptions || {},
              {
                provider: fallback.provider,
                model:
                  fallback.clientOptions?.model ||
                  fallback.clientOptions?.modelName ||
                  identity.model,
                businessType: identity.businessType,
              },
              before,
            ),
          })),
        }
      : {}),
  };
}
