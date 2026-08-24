import type { Fold, Reactor } from "@nc/process";
import {
  chatsFold,
  resurfacedFold,
  devFold,
  filterResultsFold,
  filtersFold,
  graphFold,
  libraryFold,
  marksFold,
  papersFold,
  taxonomyFold,
} from "@nc/folds";
import {
  affiliationsReactor,
  resurfacerReactor,
  arxivReactor,
  devAgentReactor,
  devMergeReactor,
  labPublicationsReactor,
  libraryArxivBackfillReactor,
  paperFilterReactor,
  paperpileImportReactor,
  taxonomyReactor,
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
  taxonomyFold,
  chatsFold,
  resurfacedFold,
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
  taxonomyReactor,
  resurfacerReactor,
];
