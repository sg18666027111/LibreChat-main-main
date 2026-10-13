const { randomUUID } = require('node:crypto');
const {
  admitModelRun,
  recordUsageForRequest,
  finishUsageRun,
} = require('~/server/services/UsageDelivery/request');
const { isEnabled, sanitizeTitle } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { CacheKeys } = require('librechat-data-provider');
const getLogStores = require('~/cache/getLogStores');
const initializeClient = require('./initalize');
const { saveConvo } = require('~/models');

/**
 * Generates a conversation title using OpenAI SDK
 * @param {Object} params
 * @param {OpenAI} params.openai - The OpenAI SDK client instance
 * @param {string} params.text - User's message text
 * @param {string} params.responseText - Assistant's response text
 * @returns {Promise<string>}
 */
const generateTitle = async ({ req, openai, text, responseText, conversationId }) => {
  const titlePrompt = `Please generate a concise title (max 40 characters) for a conversation that starts with:
User: ${text}
Assistant: ${responseText}

Title:`;

  const messageId = randomUUID();
  const key = `${messageId}:title`;
  const identity = { provider: 'openai', model: 'gpt-3.5-turbo', businessType: 'chat' };
  const begin = await admitModelRun({
    req,
    key,
    models: [identity],
    maxCalls: 1,
    source: 'assistant',
  });
  try {
    await begin?.(identity);
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'user',
          content: titlePrompt,
        },
      ],
      temperature: 0.7,
      max_tokens: 20,
    });

    if (completion.usage) {
      try {
        await recordUsageForRequest(req, {
          ...identity,
          usageEventId: `assistant_title:${conversationId}:${messageId}`,
          userId: req.user.id,
          conversationId,
          messageId,
          status: 'succeeded',
          inputTokens: completion.usage.prompt_tokens,
          outputTokens: completion.usage.completion_tokens,
          metadata: { context: 'title' },
        });
      } catch {
        logger.warn('[addTitle] Usage capture requires review');
      }
    }
    const title = completion.choices[0]?.message?.content?.trim() || 'New conversation';
    return sanitizeTitle(title);
  } finally {
    await finishUsageRun(req, key);
  }
};

/**
 * Adds a title to a conversation asynchronously
 * @param {ServerRequest} req
 * @param {Object} params
 * @param {string} params.text - User's message text
 * @param {string} params.responseText - Assistant's response text
 * @param {string} params.conversationId - Conversation ID
 */
const addTitle = async (req, { text, responseText, conversationId }) => {
  const { TITLE_CONVO = 'true' } = process.env ?? {};
  if (!isEnabled(TITLE_CONVO)) {
    return;
  }

  // Skip title generation for temporary conversations
  if (req?.body?.isTemporary) {
    return;
  }

  const titleCache = getLogStores(CacheKeys.GEN_TITLE);
  const key = `${req.user.id}-${conversationId}`;

  try {
    const { openai } = await initializeClient({ req });
    const title = await generateTitle({ req, openai, text, responseText, conversationId });
    await titleCache.set(key, title, 120000);

    const reqCtx = {
      userId: req?.user?.id,
      isTemporary: req?.body?.isTemporary,
      interfaceConfig: req?.config?.interfaceConfig,
    };
    await saveConvo(
      reqCtx,
      {
        conversationId,
        title,
      },
      { context: 'api/server/services/Endpoints/assistants/addTitle.js', noUpsert: true },
    );
  } catch (error) {
    logger.error('[addTitle] Error generating title:', error);
    const fallbackTitle = text.length > 40 ? text.substring(0, 37) + '...' : text;
    await titleCache.set(key, fallbackTitle, 120000);
    await saveConvo(
      {
        userId: req?.user?.id,
        isTemporary: req?.body?.isTemporary,
        interfaceConfig: req?.config?.interfaceConfig,
      },
      {
        conversationId,
        title: fallbackTitle,
      },
      { context: 'api/server/services/Endpoints/assistants/addTitle.js', noUpsert: true },
    );
  }
};

module.exports = addTitle;
