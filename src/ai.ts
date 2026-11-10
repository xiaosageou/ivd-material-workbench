export type RecipeDraftRequest = {
  purpose: string;
  targetOutput: { name: string; quantity: string; unit: string };
  sourceDocuments: Array<{ name: string; text: string; sha256: string }>;
};

export type RecipeDraftSuggestion = {
  name: string;
  sourceType: 'ai_draft';
  sourceReferences: Array<{ name: string; sha256: string }>;
  ingredients: Array<{ name: string; calculationType: string; amountValue: string; amountUnit: string; notes: string }>;
  steps: string[];
  assumptions: string[];
  reviewRequired: true;
};

export interface RecipeDraftProvider {
  readonly providerId: string;
  suggestRecipeDraft(request: RecipeDraftRequest): Promise<RecipeDraftSuggestion>;
}

/**
 * Provider contract only. The current application intentionally has no concrete provider,
 * model client, chat route, or inventory write path connected to this service.
 */
export async function requestRecipeDraft(provider: RecipeDraftProvider, request: RecipeDraftRequest): Promise<RecipeDraftSuggestion> {
  const suggestion = await provider.suggestRecipeDraft(request);
  if (!suggestion || suggestion.sourceType !== 'ai_draft' || suggestion.reviewRequired !== true) {
    throw new Error('AI 配方建议必须标记为待审核草稿');
  }
  if (!Array.isArray(suggestion.ingredients) || !suggestion.ingredients.length || !Array.isArray(suggestion.steps)) {
    throw new Error('AI 配方建议缺少组分或步骤结构');
  }
  return suggestion;
}
