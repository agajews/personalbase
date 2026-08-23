import type { Fold, Reactor } from "@nc/process";
import {
  devFold,
  filterResultsFold,
  filtersFold,
  graphFold,
  libraryFold,
  marksFold,
  papersFold,
} from "@nc/folds";
import {
  affiliationsReactor,
  arxivReactor,
  devAgentReactor,
  devMergeReactor,
  labPublicationsReactor,
  libraryArxivBackfillReactor,
  paperFilterReactor,
  paperpileImportReactor,
} from "@nc/reactors";

// Explicit wiring of every fold and reactor — greppable, no magic discovery.
export const folds: readonly Fold[] = [
  papersFold,
  filtersFold,
  filterResultsFold,
  graphFold,
  libraryFold,
  marksFold,
  devFold,
];
export const reactors: readonly Reactor[] = [
  arxivReactor,
  paperFilterReactor,
  affiliationsReactor,
  labPublicationsReactor,
  paperpileImportReactor,
  libraryArxivBackfillReactor,
  devAgentReactor,
  devMergeReactor,
];
