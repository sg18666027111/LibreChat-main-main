/** Own accounting at the paid completion boundary; tool reads only consume this shared promise. */
async function startVisionCompletion({
  req,
  model,
  conversationId,
  messageId,
  create,
  record,
  finish,
  onFailure = () => {},
}) {
  try {
    const completion = await create();
    if (completion?.usage) {
      try {
        await record({
          req,
          user: req.user.id,
          model,
          conversationId,
          messageId,
          usageEventId: `vision_analysis:${conversationId}:${messageId}`,
          provider: 'openai',
          businessType: 'vision_analysis',
          ...completion.usage,
        });
      } catch {
        onFailure();
      }
    } else onFailure();
    return completion;
  } finally {
    await finish(req, `${messageId}:vision`);
  }
}
module.exports = { startVisionCompletion };
