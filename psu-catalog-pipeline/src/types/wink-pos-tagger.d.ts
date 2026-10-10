/** Minimal declarations for wink-pos-tagger, which ships none.
 *
 * Only the surface we use. Written out rather than `declare module "..."` with
 * an implicit `any`, so a change in the library's shape fails the typecheck
 * instead of flowing through untyped into the keyword extractor. */
declare module "wink-pos-tagger" {
  export interface Token {
    value: string;
    /** Penn Treebank tag: NN, NNS, JJ, VB, VBG, RB, ... */
    pos: string;
    tag?: string;
    lemma?: string;
    normal?: string;
  }
  export interface Tagger {
    tagSentence(sentence: string): Token[];
    tagRawSentence(sentence: string): Token[];
    defineConfig(config: Record<string, unknown>): void;
    updateLexicon(lexicon: Record<string, string[]>): void;
  }
  export default function posTagger(): Tagger;
}
