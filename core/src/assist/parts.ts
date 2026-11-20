// A parts answer (step 12): the models of a research result, each with its count.

/** The models of a parts answer, each as many times as its count, upper case: the list the typed-parts answer takes. */
export const expandParts = (parts: readonly { model: string; qty: number }[]): string[] =>
  parts.flatMap((p) => Array.from({ length: p.qty }, () => p.model.trim().toUpperCase()));
