import type { Fold, Reactor } from "@nc/process";
import {
  filterResultsFold,
  filtersFold,
  graphFold,
  libraryFold,
  papersFold,
} from "@nc/folds";
import {
  affiliationsReactor,
  arxivReactor,
  labPublicationsReactor,
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
];
export const reactors: readonly Reactor[] = [
  arxivReactor,
  paperFilterReactor,
  affiliationsReactor,
  labPublicationsReactor,
  paperpileImportReactor,
];
