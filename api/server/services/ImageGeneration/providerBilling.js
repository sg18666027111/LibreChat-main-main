/** Provider-native amounts are retained separately from the ledger's CNY pricing. */
function getImageProviderBillingMetadata(provider, result) {
  if (provider !== 'apimart') {
    return {};
  }
  const providerCost =
    result?.cost ?? result?.json?.data?.cost ?? result?.billingMetadata?.providerCost;
  const providerCreditsCost =
    result?.json?.data?.credits_cost ?? result?.billingMetadata?.providerCreditsCost;
  return {
    ...(Number.isFinite(providerCost) && providerCost >= 0 ? { providerCost } : {}),
    ...(Number.isFinite(providerCreditsCost) && providerCreditsCost >= 0
      ? { providerCreditsCost }
      : {}),
  };
}

module.exports = { getImageProviderBillingMetadata };
