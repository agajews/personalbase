import type { Fold, Reactor } from "@nc/process";
import { filterResultsFold, filtersFold, papersFold } from "@nc/folds";
import { arxivReactor, paperFilterReactor } from "@nc/reactors";

// Explicit wiring of every fold and reactor — greppable, no magic discovery.
export const folds: readonly Fold[] = [papersFold, filtersFold, filterResultsFold];
export const reactors: readonly Reactor[] = [arxivReactor, paperFilterReactor];
