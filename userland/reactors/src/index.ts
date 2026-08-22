export {
  arxivReactor,
  arxivJobPayload,
  entryToEvent,
  fetchArxivByIds,
  resolveArxivByTitle,
  type ArxivJobPayload,
} from "./arxiv.js";
export {
  affiliationsReactor,
  makeAffiliationsReactor,
  fetchPaperText,
  anthropicExtractor,
  type AffiliationExtractor,
  type ExtractionInput,
  type ExtractionResult,
} from "./affiliations.js";
export {
  labPublicationsReactor,
  makeLabPublicationsReactor,
  anthropicLabLister,
  labs,
  labJobPayload,
  type LabConfig,
  type LabLister,
  type LabListing,
} from "./labPublications.js";
export { parseArxivAtom, type ArxivEntry } from "./arxivAtom.js";
export {
  makePaperFilterReactor,
  paperFilterReactor,
  paperFilterJobPayload,
  type PaperFilterJobPayload,
} from "./paperFilter.js";
export {
  anthropicJudge,
  type JudgeFn,
  type JudgeResult,
  type Judgment,
  type PaperForJudging,
} from "./judge.js";
